import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc08-cooperation-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('RC08_EXTERNAL_NETWORK_FORBIDDEN');};
const fixtures=[],children=[],checks=[],workerFacts=[],snapshots=[];let requests=0;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables=['threaded_consultations','threaded_consultation_targets','threaded_consultation_settlements',
  'threaded_collaboration_callbacks','threaded_messages','threaded_deliveries','threaded_wakes','threaded_outbox',
  'threaded_outbox_receipts','threaded_tool_receipts','threaded_wake_queue','threaded_backend_requests'];
const rows=(f,table)=>f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function snapshot(f,label){const value={label,injectedRequests:requests,clock:f.clock(),
  tables:Object.fromEntries(tables.map(table=>{const data=rows(f,table);return[table,{count:data.length,sha256:hash(data)}];})),
  groups:rows(f,'threaded_consultations'),targets:rows(f,'threaded_consultation_targets'),
  settlements:rows(f,'threaded_consultation_settlements').map(r=>({...r,record:JSON.parse(r.record)})),
  callbacks:rows(f,'threaded_collaboration_callbacks').map(r=>({...r,record:JSON.parse(r.record)}))};snapshots.push(value);return value;}
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
async function fixture(name){let f,clock=Date.now();f=await openBackendRuntimeFixture(root,name,{agentIds:['api-member','other-member','fourth-member'],now:()=>clock,
  applicationTools:THREADED_APPLICATION_TOOL_NAMES,fetch:async()=>{requests++;return response(await(f.handler?.(f.activeClaim)??'normal final'));}});
  f.clock=()=>clock;f.advance=ms=>clock+=ms;fixtures.push(f);return f;}
async function run(f,receipt,handler){if(receipt)for(const wake of receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
  const claim=f.runtime.queue.claimNext('rc08-cooperation');assert.ok(claim,'expected next claim');f.activeClaim=claim;f.handler=handler;
  try{return{claim,result:await f.runtime.executeClaim(claim)};}finally{f.handler=undefined;}}
const tool=async(f,claim,name,input)=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
const consultation=(targets=['other-member','fourth-member'])=>({idempotencyKey:'consult',targets,question:'Give independent exact original answers; preserve disagreement.',callbackTo:'api-member',timeoutMinutes:3,overrideReason:'RC08 isolated reliability acceptance'});
async function register(f,targets,extra={}){let group;const input=consultation(targets);const result=await run(f,f.user('RC08 consultation source',['api-member'],extra),async claim=>{group=ok(await tool(f,claim,'multi_mention',input));return 'registered; not waiting';});return{group,result,input};}
function worker(f,input){
  const child=fork(new URL('./fixtures/threadedRc08CooperationWorker.mjs',import.meta.url),[],{execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],
    env:{...process.env,RC08_COOPERATION_ROOT:root},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
  const fact={pid:child.pid,operation:input.operation,clock:input.clock??f.clock(),messages:[]};workerFacts.push(fact);
  let stderr='',readyResolve,readyReject;child.stderr.on('data',data=>stderr+=data);
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  child.on('message',message=>{fact.messages.push(message);if(message.type==='ready')readyResolve();});
  const done=new Promise((resolve,reject)=>{child.once('error',error=>{readyReject(error);reject(error);});child.once('exit',(code,signal)=>{fact.exit={code,signal};if(code===0||signal==='SIGKILL'||code===1&&input.expectedError&&fact.messages.some(m=>m.type==='error'&&m.error===input.expectedError))resolve(fact);else{const error=new Error(fact.messages.find(m=>m.type==='error')?.message??stderr??`worker exit ${code}`);readyReject(error);reject(error);}});});
  child.send({file:f.file,clock:f.clock(),...input});return{child,ready,done,go:()=>child.send({go:true})};
}
async function executeWorker(f,input){const task=worker(f,input);await task.ready;task.go();return task.done;}
function settled(f,group,expectedBodies,expectedKind){
  const settlement=rows(f,'threaded_consultation_settlements');assert.equal(settlement.length,1);const record=JSON.parse(settlement[0].record);assert.equal(record.groupId,group.groupId);
  if(expectedKind)assert.equal(record.kind,expectedKind);
  const targets=f.db.prepare('SELECT * FROM threaded_consultation_targets WHERE group_id=? ORDER BY agent_id').all(group.groupId);
  assert.deepEqual(record.responses.map(r=>r.agentId).sort(),targets.map(t=>t.agent_id));
  for(const target of targets){const entry=record.responses.find(r=>r.agentId===target.agent_id);assert.equal(entry.status,target.status);assert.equal(entry.responseMessageId,target.response_message_id);
    assert.equal(entry.body,target.response_message_id?f.db.prepare('SELECT body FROM threaded_messages WHERE id=?').get(target.response_message_id).body:null);}
  for(const body of expectedBodies)assert.ok(record.responses.some(response=>response.body===body),`original answer missing: ${body}`);
  assert.equal(new Set(record.responses.map(r=>r.agentId)).size,record.responses.length);
  assert.equal(rows(f,'threaded_collaboration_callbacks').length,1);
  const callback=rows(f,'threaded_collaboration_callbacks')[0];assert.equal(callback.source_id,group.groupId);
  if(callback.message_id){const notifications=f.db.prepare("SELECT * FROM threaded_outbox WHERE source_id=? AND event_type='message.created'").all(callback.message_id);assert.equal(notifications.length,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_wakes WHERE source_message_id=?').get(callback.message_id).n,1);}
  return{record,callback};
}
let failure;
try{
  {
    const f=await fixture('lost-tool-receipt');let group;const before=requests;
    await run(f,f.user('Persist then lose the exact tool reply'),async claim=>{
      const input=consultation();group=ok(await tool(f,claim,'multi_mention',input));
      const beforeTables=snapshot(f,'M03 committed tool result discarded by receiver');
      const replay=await executeWorker(f,{operation:'tool',binding:claim.binding,name:'multi_mention',input,requestKey:'transport-retry'});
      assert.deepEqual(replay.messages.find(m=>m.type==='result').result,{ok:true,result:group});
      const conflict=await executeWorker(f,{operation:'tool',binding:claim.binding,name:'multi_mention',input:{...input,question:'changed payload'},requestKey:'conflicting-retry'});
      assert.equal(conflict.messages.find(m=>m.type==='result').result.code,'THREADED_TOOL_IDEMPOTENCY_CONFLICT');
      const after=snapshot(f,'M03 fresh PID retry and conflict');assert.deepEqual(after.tables,beforeTables.tables);
      return 'one registered consultation';
    });
    assert.equal(requests-before,1);assert.equal(rows(f,'threaded_consultations').length,1);assert.equal(rows(f,'threaded_consultation_targets').length,2);
    checks.push({id:'tool_receipt_cross_pid',passed:true,groupId:group.groupId,scope:'production broker, injected API; IPC retry uses same binding/key; no real network loss',newInjectedRequests:1});
  }
  {
    const f=await fixture('terminal-timeout-race');const {group}=await register(f);await run(f,undefined,async()=> 'FIRST_MEMBER_DISAGREES_WITH_PLAN');
    f.db.exec("CREATE TRIGGER rc08_terminal_crash BEFORE INSERT ON threaded_invocation_terminals BEGIN SELECT RAISE(ABORT,'rc08_terminal_crash'); END;");
    await assert.rejects(()=>run(f,undefined,async()=> 'LAST_MEMBER_RETAINS_DISTINCT_ANSWER'),/rc08_terminal_crash/);f.db.exec('DROP TRIGGER rc08_terminal_crash');
    const binding=f.activeClaim.binding,proof=JSON.parse(f.db.prepare('SELECT proof FROM execution_resource_quiescence WHERE claim_id=?').get(binding.claimId).proof);
    const before=requests;const original=snapshot(f,'E03 last exact stopped outcome before three writer barrier');f.close();
    const terminal=worker(f,{operation:'terminal',clock:group.deadline-1,binding,outcome:{kind:'completed',content:'LAST_MEMBER_RETAINS_DISTINCT_ANSWER',budgetState:'unknown',quiescence:proof}});
    const timeoutA=worker(f,{operation:'recover',clock:group.deadline}),timeoutB=worker(f,{operation:'recover',clock:group.deadline+1});
    await Promise.all([terminal.ready,timeoutA.ready,timeoutB.ready]);terminal.go();timeoutA.go();timeoutB.go();await Promise.all([terminal.done,timeoutA.done,timeoutB.done]);
    f.advance(180001);f.reopen();const {record}=settled(f,group,['FIRST_MEMBER_DISAGREES_WITH_PLAN']);assert.ok(['complete','partial'].includes(record.kind));
    if(record.kind==='complete')assert.ok(record.responses.some(r=>r.body==='LAST_MEMBER_RETAINS_DISTINCT_ANSWER'));
    else assert.equal(record.responses.filter(r=>r.status==='timeout').length,1);
    const immutable=hash(rows(f,'threaded_consultation_settlements'));f.runtime.collaboration.cooperation.recover();assert.equal(hash(rows(f,'threaded_consultation_settlements')),immutable);assert.equal(requests,before);
    assert.equal(rows(f,'threaded_consultations')[0].deadline,original.groups[0].deadline);snapshot(f,'E03 unique settlement after three writer race');
    checks.push({id:'three_pid_terminal_deadline_race',passed:true,winner:record.kind,workerPids:[terminal.child.pid,timeoutA.child.pid,timeoutB.child.pid],providerReplay:0});
  }
  {
    const f=await fixture('terminal-outbox-atomic-fault');const {group}=await register(f,['other-member']);
    f.db.exec("CREATE TRIGGER rc08_callback_outbox_fault BEFORE INSERT ON threaded_outbox WHEN NEW.event_type='message.created' AND EXISTS(SELECT 1 FROM threaded_messages m WHERE m.id=NEW.source_id AND m.origin='system') BEGIN SELECT RAISE(ABORT,'rc08_callback_outbox_fault'); END;");
    await assert.rejects(()=>run(f,undefined,async()=> 'EXACT_ORIGINAL_AFTER_OUTBOX_ROLLBACK'),/rc08_callback_outbox_fault/);
    const binding=f.activeClaim.binding,quiescence=JSON.parse(f.db.prepare('SELECT proof FROM execution_resource_quiescence WHERE claim_id=?').get(binding.claimId).proof);
    const outcome={kind:'completed',content:'EXACT_ORIGINAL_AFTER_OUTBOX_ROLLBACK',budgetState:'unknown',quiescence};const before=requests;
    const original=snapshot(f,'E06 exact response known, callback outbox fault rolled terminal transaction back');
    assert.equal(rows(f,'threaded_consultation_settlements').length,0);assert.equal(rows(f,'threaded_collaboration_callbacks').length,0);
    const failed=await executeWorker(f,{operation:'terminal',binding,outcome,expectedError:'SQLITE_CONSTRAINT_TRIGGER'});
    assert.ok(failed.messages.some(m=>m.type==='error'&&m.message==='rc08_callback_outbox_fault'));
    assert.deepEqual(snapshot(f,'E06 fresh PID hits same outbox fault without partial commit').tables,original.tables);
    f.db.exec('DROP TRIGGER rc08_callback_outbox_fault');const repaired=await executeWorker(f,{operation:'terminal',binding,outcome});
    settled(f,group,['EXACT_ORIGINAL_AFTER_OUTBOX_ROLLBACK'],'complete');assert.equal(requests,before);
    snapshot(f,'E06 original trusted outcome replay commits in another PID without model replay');
    checks.push({id:'outbox_fault_exact_outcome_cross_pid',passed:true,faultPid:failed.pid,repairedPid:repaired.pid,providerReplay:0});
  }
  {
    const f=await fixture('settlement-crash');const {group}=await register(f);await run(f,undefined,async()=> 'DURABLE_PARTIAL_ORIGINAL');const before=requests;
    snapshot(f,'E01/E02 partial target accepted before parent closes');f.close();
    const crashed=await executeWorker(f,{operation:'recover-crash',clock:group.deadline+1});assert.equal(crashed.exit.signal,'SIGKILL');
    f.advance(180001);f.reopen();const {record,callback}=settled(f,group,['DURABLE_PARTIAL_ORIGINAL'],'partial');assert.equal(record.responses.filter(r=>r.status==='timeout').length,1);
    const event=f.db.prepare("SELECT * FROM threaded_outbox WHERE source_id=? AND event_type='message.created'").get(callback.message_id);assert.equal(event.status,'pending');
    const original=hash(rows(f,'threaded_consultation_settlements'));const recovered=await executeWorker(f,{operation:'recover',clock:f.clock()});
    assert.equal(hash(rows(f,'threaded_consultation_settlements')),original);assert.equal(requests,before);snapshot(f,'E04 settlement committed and SIGKILL before any notification');
    checks.push({id:'settlement_commit_sigkill',passed:true,crashedPid:crashed.pid,recoveredPid:recovered.pid,eventId:event.id,providerReplay:0});
  }
  {
    const f=await fixture('outbox-ack-crash');const {group}=await register(f,['other-member']);await run(f,undefined,async()=> 'ACK_LOSS_ORIGINAL');const before=requests;
    const {callback}=settled(f,group,['ACK_LOSS_ORIGINAL'],'complete');const event=f.db.prepare("SELECT * FROM threaded_outbox WHERE source_id=? AND event_type='message.created'").get(callback.message_id);
    const crashed=await executeWorker(f,{operation:'notify-crash',eventId:event.id});assert.equal(crashed.exit.signal,'SIGKILL');
    assert.equal(crashed.messages.filter(m=>m.type==='notice-before-ack').length,1);assert.equal(f.db.prepare('SELECT status FROM threaded_outbox WHERE id=?').get(event.id).status,'claimed');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_outbox_receipts WHERE outbox_id=?').get(event.id).n,0);
    snapshot(f,'E04 notification IPC delivered; actual SIGKILL prevents ACK');
    f.advance(60001);const retry=await executeWorker(f,{operation:'notify',eventId:event.id});const notice=retry.messages.find(m=>m.type==='result').result.observations;assert.equal(notice.length,1);assert.equal(notice[0].eventId,event.id);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_outbox_receipts WHERE outbox_id=?').get(event.id).n,1);
    assert.equal(f.db.prepare('SELECT attempts FROM threaded_outbox WHERE id=?').get(event.id).attempts,2);
    const scanA=await executeWorker(f,{operation:'scan'}),scanB=await executeWorker(f,{operation:'scan'});
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_wake_queue q JOIN threaded_wakes w ON w.id=q.wake_id WHERE w.source_message_id=?').get(callback.message_id).n,1);
    settled(f,group,['ACK_LOSS_ORIGINAL'],'complete');assert.equal(requests,before);snapshot(f,'E04 repeated IPC hint, one ACK, one callback queue');
    checks.push({id:'notification_send_sigkill_before_ack',passed:true,eventId:event.id,crashedPid:crashed.pid,retryPid:retry.pid,scanPids:[scanA.pid,scanB.pid],physicalNotifications:2,logicalCallback:1,providerReplay:0});
  }
  {
    const f=await fixture('paused-source-acl');const foreign=createThreadedStore(f.db).createThread({title:'RC08 original source ACL',members:['api-member','other-member','fourth-member'].map(agentId=>({agentId,handle:agentId,roleVersion:1,permissionVersion:1}))});
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(foreign.id);
    const source=f.runtime.messages.acceptUserMessage({ownerId:foreign.ownerId,threadId:foreign.id,clientRequestId:'original-source',body:'CROSS_THREAD_SOURCE',targets:[]});
    const {group}=await register(f,['other-member'],{sourceRefs:[source.message.id]});
    const identity=f.runtime.collaboration.cooperation.identity({ownerId:f.thread.ownerId,threadId:f.thread.id,agentId:'api-member'});
    f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action:'pause',requestId:'pause-before-settlement'});
    await run(f,undefined,async()=> 'PRESERVED_ORIGINAL_BEFORE_SOURCE_REVOKED');let {callback}=settled(f,group,['PRESERVED_ORIGINAL_BEFORE_SOURCE_REVOKED'],'complete');assert.equal(callback.state,'waiting');
    const before=requests,settlementHash=hash(rows(f,'threaded_consultation_settlements'));
    f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(foreign.id);
    assert.equal(f.runtime.collaboration.cooperation.identity({ownerId:f.thread.ownerId,threadId:f.thread.id,agentId:'api-member'}),identity);
    await executeWorker(f,{operation:'recover'});callback=rows(f,'threaded_collaboration_callbacks')[0];assert.equal(callback.state,'rejected');assert.match(callback.reason,/SOURCE_FORBIDDEN|AUTHORITY_CHANGED/);assert.equal(callback.message_id,null);
    f.db.prepare("UPDATE threaded_members SET status='joined',version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(foreign.id);
    f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action:'resume',requestId:'resume-after-source-return'});
    await executeWorker(f,{operation:'recover'});assert.equal(rows(f,'threaded_collaboration_callbacks')[0].state,'rejected');assert.equal(hash(rows(f,'threaded_consultation_settlements')),settlementHash);assert.equal(requests,before);
    snapshot(f,'E05 source ACL revoked while paused; source restoration cannot resurrect frozen rejection');
    checks.push({id:'paused_cross_thread_acl_revocation',passed:true,callerIdentityUnchanged:true,sourceRestored:true,terminalCallbackState:'rejected',providerReplay:0});
  }
  {
    const f=await fixture('cascade-through-post');const {group}=await register(f,['other-member']);let forwarded;
    await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'other-member');const deny=await tool(f,claim,'multi_mention',{...consultation(['fourth-member']),callbackTo:'other-member'});assert.equal(deny.code,'THREADED_CONSULTATION_CASCADE_DENIED');
      forwarded=ok(await tool(f,claim,'post_message',{idempotencyKey:'forward-original-question',body:'FORWARDED_CONSULTATION_CONTEXT',targets:['fourth-member']}));return 'ORIGINAL_RESPONDER_ANSWER';
    });
    await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'fourth-member');const deny=await executeWorker(f,{operation:'tool',binding:claim.binding,name:'multi_mention',input:{...consultation(['api-member']),callbackTo:'fourth-member'},requestKey:'indirect-cascade'});
      assert.equal(deny.messages.find(m=>m.type==='result').result.code,'THREADED_CONSULTATION_CASCADE_DENIED');return 'FORWARDER_FINAL_WITHOUT_CASCADE';
    });
    assert.equal(rows(f,'threaded_consultations').length,1);assert.equal(rows(f,'threaded_consultation_targets').length,1);settled(f,group,['ORIGINAL_RESPONDER_ANSWER'],'complete');
    snapshot(f,'MM03 direct target and source-linked forwarded target deny downstream consultation');
    checks.push({id:'anti_cascade_across_forwarded_source',passed:true,forwardedMessageId:forwarded.message.id,consultations:1,downstreamConsultations:0});
  }
  {
    const variants=[];
    for(const fault of [false,true]){
    const f=await fixture(`callback-resume-auto-${fault}`);const {group}=await register(f,['other-member']);
    f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action:'pause',requestId:'rc08-pause-autorepair'});
    await run(f,undefined,async()=> 'ORIGINAL_ANSWER_AWAITING_AUTOMATIC_RESUME');
    const {callback}=settled(f,group,['ORIGINAL_ANSWER_AWAITING_AUTOMATIC_RESUME'],'complete');assert.equal(callback.state,'waiting');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_consultations WHERE state='collecting'").get().n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_waits WHERE state='awaiting'").get().n,0);
    const before=requests;f.close();const resumed=await executeWorker(f,{operation:fault?'resume-auto-fault':'resume-auto',groupId:group.groupId,ownerId:f.thread.ownerId,threadId:f.thread.id,agentId:'api-member'});
    const result=resumed.messages.find(m=>m.type==='result').result;assert.equal(result.before,'waiting');assert.equal(result.explicitRecoveryCalls,0);assert.equal(result.state,'delivered');
    assert.equal(result.repairFailureObserved,fault);assert.equal(result.finalDiagnostics.lastError,null);
    f.reopen();settled(f,group,['ORIGINAL_ANSWER_AWAITING_AUTOMATIC_RESUME'],'complete');assert.equal(requests,before);
    snapshot(f,'E05 new PID resume alone automatically dispatches waiting callback with no live deadline');
    variants.push({fault,resumedPid:resumed.pid,repairFailureObserved:result.repairFailureObserved,explicitRecoveryCalls:0,providerReplay:0});
    }
    checks.push({id:'callback_resume_without_explicit_recover',passed:true,variants});
  }
  assert.ok(workerFacts.every(fact=>fact.messages.every(message=>message.networkCalls===0)));for(const f of fixtures)if(f.db.open)assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
}catch(error){failure={message:error.message,stack:error.stack};}
finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  for(const f of fixtures)f.close();globalThis.fetch=originalFetch;
  const report={schemaVersion:1,stage:'RC08',date:'2026-10-27',status:failure?'failed':'passed',checks,checkCount:checks.length,
    scope:{productionEntry:'createThreadedBackendRuntime/cooperation/tools/outbox; isolated SQLite + actual fork/SIGKILL',mainIndex:false,realSupplier:false,realCredentials:false,dailyData:false,controlledClock:true},
    injectedRequests:requests,externalRequests:0,workerCount:workerFacts.length,uniqueWorkerPids:[...new Set(workerFacts.map(f=>f.pid))],workerFacts,snapshots,...(failure?{failure}:{})};
  const output=process.env.THREADED_RC08_COOPERATION_OUTPUT??path.resolve('docs/reports/evidence/threaded-rc08/cooperation.json');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  await rm(root,{recursive:true,force:true});console.log(JSON.stringify({status:report.status,checks:checks.length,injectedRequests:requests,workerCount:workerFacts.length,report:output,...(failure?{failure:failure.message}:{})}));
}
if(failure)process.exitCode=1;
