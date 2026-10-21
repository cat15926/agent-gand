import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t11-sop-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {applyThreadedSopSchema}=await import('../apps/server/src/db/threadedSopSchema.ts');
const {createThreadedSop,THREADED_SOP_TOOLS,snapshotThreadedSops}=await import('../apps/server/src/threaded/sop.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const fixtures=[],checks=[],faults=[];let injectedRequests=0;
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No external/model requests permitted');};
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
async function fixture(name){let f;const clock=Date.now();
  f=await openBackendRuntimeFixture(root,name,{now:()=>clock,applicationTools:THREADED_APPLICATION_TOOL_NAMES,
    fetch:async()=>{injectedRequests++;try{return response(await(f.handler?.(f.activeClaim)??'done'));}catch(error){f.handlerError=error;throw error;}}});
  f.clock=()=>clock;for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  fixtures.push(f);return f;
}
async function run(f,receipt,handler,expectedStatus='completed'){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
  const claim=f.runtime.queue.claimNext('t11-sop');assert.ok(claim,'claim expected');
  const before={handler:f.handler,activeClaim:f.activeClaim};f.activeClaim=claim;f.handler=handler;
  try{const result=await f.runtime.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(result.status,expectedStatus,JSON.stringify(result));return claim;}
  finally{f.handler=before.handler;f.activeClaim=before.activeClaim;}
}
const tool=async(f,claim,name,input,key=randomUUID())=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
const update=(sopKey,expectedVersion,extra={})=>({idempotencyKey:randomUUID(),sopKey,expectedVersion,...extra});
const count=(f,t)=>f.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
function sop(f){return f.runtime.collaboration.sop??createThreadedSop(f.db,{authority:f.runtime.authority,messages:f.runtime.messages,
  cooperation:f.runtime.collaboration.cooperation,now:f.clock});}
async function workers(f,operations){
  const all=operations.map(()=>{const child=fork(new URL('./fixtures/threadedSopWorker.mjs',import.meta.url),[f.file,String(f.clock())],{
    execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',v=>stderr+=v);
    const ready=new Promise((resolve,reject)=>{child.on('message',v=>{if(v.type==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const result=new Promise((resolve,reject)=>{child.on('message',v=>{if(v.type==='committed'){child.kill('SIGKILL');resolve(v.answer);}else if(v.type==='result')v.error?reject(new Error(JSON.stringify(v.error))):resolve(v.answer);});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const exited=new Promise(resolve=>child.once('exit',resolve));return {child,ready,result,exited};});
  await Promise.all(all.map(w=>w.ready));all.forEach((w,i)=>w.child.send({key:randomUUID(),...operations[i]}));
  const answers=await Promise.all(all.map(w=>w.result));await Promise.all(all.map(w=>w.exited));return answers;
}
try{
  assert.ok(THREADED_SOP_TOOLS.every(t=>THREADED_APPLICATION_TOOL_NAMES.includes(t.name)),'SOP must be installed in the real allowlisted application tool chain');
  {
    const f=await fixture('sop-descriptive');let first,binding;
    assert.throws(()=>applyThreadedSopSchema(f.db),/THREADED_MIGRATION_REQUIRES_TRANSACTION/);
    await run(f,f.user('Create descriptive board'),async claim=>{
      binding=claim.binding;const before={actions:count(f,'threaded_actions'),claims:count(f,'execution_resource_claims')};
      const args=update('release',0,{title:'Release checklist',stage:'done',baton:'other-member',checks:[{id:'tests',label:'I ran all tests',state:'attested'}]});
      first=ok(await tool(f,claim,'update_sop',args));assert.equal(first.version,1);assert.equal(first.checks[0].state,'attested');
      assert.equal(first.baton,'other-member');assert.equal(first.stage,'done');assert.equal(first.checks[0].verifiedFact,undefined);
      assert.deepEqual(ok(await tool(f,claim,'update_sop',args)),first);
      assert.equal((await tool(f,claim,'update_sop',{...args,title:'idempotency changed'})).code,'THREADED_TOOL_IDEMPOTENCY_CONFLICT');
      assert.equal((await tool(f,claim,'update_sop',update('release',0,{stage:'overwritten'}))).code,'THREADED_SOP_VERSION_CONFLICT');
      assert.equal((await tool(f,claim,'update_sop',update('release',1,{checks:[{id:'fake',label:'verified',state:'verified'}]}))).code,'THREADED_SOP_SELF_VERIFICATION_FORBIDDEN');
      assert.equal((await tool(f,claim,'verify_sop_check',{...update('release',1),checkId:'tests',evidenceId:'model-says-done'})).code,'THREADED_SOP_VERIFICATION_REQUIREMENT_REQUIRED');
      assert.equal((await tool(f,claim,'update_sop',update('release',1,{baton:'not-a-member'}))).code,'THREADED_SOP_BATON_MEMBER_REQUIRED');
      assert.deepEqual({actions:count(f,'threaded_actions'),claims:count(f,'execution_resource_claims')},before);
      assert.throws(()=>sop(f).executeWithin(claim.binding,'update_sop',update('release',1,{stage:'outside transaction'})),/THREADED_SOP_TRANSACTION_REQUIRED/);
      const second=ok(await tool(f,claim,'update_sop',update('release',1,{stage:'review'})));assert.equal(second.version,2);
      assert.equal(ok(await tool(f,claim,'read_sop',{sopKey:'release',version:1})).stage,'done');
      assert.equal(ok(await tool(f,claim,'read_sop',{sopKey:'release'})).stage,'review');
      assert.throws(()=>f.db.prepare("UPDATE threaded_sop_versions SET record='{}' WHERE sop_id=?").run(first.id),/THREADED_SOP_HISTORY_IMMUTABLE/);
      assert.throws(()=>f.db.prepare('DELETE FROM threaded_sop_versions WHERE sop_id=?').run(first.id),/THREADED_SOP_HISTORY_RETAINED/);
      assert.throws(()=>f.db.prepare('UPDATE threaded_sops SET version=version+2 WHERE id=?').run(first.id),/THREADED_SOP_CAS/);
      return 'Board state is descriptive';});
    f.reopen();assert.equal(sop(f).snapshot(f.thread.ownerId,f.thread.id)[0].version,2);
    await assert.rejects(()=>tool(f,{binding:{...binding,agentId:'other-member'}},'read_sop',{sopKey:'release'}),/THREADED_BINDING_UNAUTHORIZED/);
    checks.push('SOP02: real application allowlist and authenticated Binding; stage/baton and self-attested check grant no Action or resource ownership; machine state input/fake evidence denied, history immutable and factory rebuild durable');
  }
  {
    const f=await fixture('sop-two-members-cas');
    await run(f,f.user('Two members update one board',['api-member','other-member']),async first=>{
      ok(await tool(f,first,'update_sop',update('race',0,{stage:'initial'})));
      await run(f,undefined,async second=>{
        assert.notEqual(first.binding.agentId,second.binding.agentId);
        const result=await workers(f,[first,second].map((claim,i)=>({binding:claim.binding,name:'update_sop',input:update('race',1,{stage:`winner-${i}`})})));
        assert.equal(result.filter(r=>r.ok).length,1);assert.equal(result.find(r=>!r.ok).code,'THREADED_SOP_VERSION_CONFLICT');
        assert.equal(count(f,'threaded_sop_versions'),2);assert.equal(sop(f).snapshot(f.thread.ownerId,f.thread.id)[0].version,2);
        return 'one winner';});return 'one shared board';});
    checks.push('SOP01/DB01: two actual IPC workers and separate SQLite connections use two simultaneously running authenticated members at one barrier; expectedVersion CAS has one winner and one explicit conflict');
  }
  {
    const f=await fixture('sop-atomic');
    await run(f,f.user('Atomic SOP update'),async claim=>{
      ok(await tool(f,claim,'update_sop',update('rollback',0,{stage:'initial'})));
      const args=update('rollback',1,{stage:'next'}),tables=['threaded_sops','threaded_sop_versions','threaded_tool_receipts','threaded_tool_context_exposures'];
      const snapshot=()=>tables.map(t=>[t,f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
      for(const table of ['threaded_sop_versions','threaded_tool_receipts','threaded_tool_context_exposures']){
        const before=snapshot();f.db.exec(`CREATE TRIGGER fault_t11_sop BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fault_t11_sop'); END;`);
        await assert.rejects(()=>tool(f,claim,'update_sop',args),/fault_t11_sop/);assert.deepEqual(snapshot(),before);f.db.exec('DROP TRIGGER fault_t11_sop');faults.push({table,rolledBack:true});
      }
      assert.equal(ok(await tool(f,claim,'update_sop',args)).version,2);return 'all-or-nothing board and exposure';});
    checks.push('DB01/SOP01: injected history, receipt and exposure failures roll back board pointer, immutable history, tool idempotency and privacy exposure in the same outer transaction');
  }
  {
    const f=await fixture('sop-private-sources');let secret,first;
    await run(f,f.user('PRIVATE_SOP_SOURCE',['api-member'],{visibility:'private',audience:['api-member']}),async claim=>{
      secret=f.runtime.collaboration.cooperation.source(claim.binding).id;
      first=ok(await tool(f,claim,'update_sop',update('private',0,{title:'PRIVATE_SOP_TITLE',checks:[{id:'x',label:'PRIVATE_LABEL',state:'attested'}]})));
      assert.equal(first.visibility,'private');assert.deepEqual(first.audience,['api-member']);assert.ok(first.sourceRefs.includes(secret));
      const receipt=JSON.parse(f.db.prepare("SELECT record FROM threaded_tool_receipts WHERE binding_id=? AND name='update_sop'").get(claim.binding.id).record);
      assert.ok(receipt.privacySourceIds.includes(secret));assert.ok(f.db.prepare('SELECT 1 FROM threaded_tool_context_exposures WHERE binding_id=? AND message_id=?').get(claim.binding.id,secret));
      return 'private board';});
    await run(f,f.user('Cannot borrow another member private board',['other-member']),async claim=>{
      for(const input of [{sopKey:'private'},{sopKey:'private',version:1}])assert.equal((await tool(f,claim,'read_sop',input)).code,'THREADED_SOP_SOURCE_FORBIDDEN');
      assert.equal((await tool(f,claim,'update_sop',update('private',1,{stage:'leak'}))).code,'THREADED_SOP_SOURCE_FORBIDDEN');
      assert.equal((await tool(f,claim,'update_sop',update('forged-source',0,{sourceRefs:[secret]}))).code,'THREADED_COLLABORATION_SOURCE_FORBIDDEN');
      assert.equal(count(f,'threaded_sops'),1);return 'ACL checked on current and historical reads';});
    await run(f,f.user('Public input cannot widen old private history'),async claim=>{
      const other=createThreadedStore(f.db).createThread({title:'Revocable provenance',members:[{agentId:'api-member',handle:'api-member',roleVersion:1,permissionVersion:1}]});
      f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(other.id);
      const remote=f.runtime.messages.acceptUserMessage({ownerId:other.ownerId,threadId:other.id,clientRequestId:randomUUID(),body:'PRIVATE_CROSS_THREAD_SOP_SOURCE',targets:[],visibility:'private',audience:['api-member']});
      const next=ok(await tool(f,claim,'update_sop',update('private',1,{stage:'review',sourceRefs:[remote.message.id]})));
      assert.equal(next.visibility,'private');assert.deepEqual(next.audience,['api-member']);assert.ok(next.sourceRefs.includes(secret));
      f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(other.id);
      assert.equal((await tool(f,claim,'read_sop',{sopKey:'private',version:2})).code,'THREADED_SOP_SOURCE_FORBIDDEN');
      assert.equal((await tool(f,claim,'read_sop',{sopKey:'private'})).code,'THREADED_SOP_SOURCE_FORBIDDEN');
      assert.equal(ok(await tool(f,claim,'read_sop',{sopKey:'private',version:1})).version,1);
      return 'history rechecks narrowed source ACL';},'failed');
    checks.push('MEM02/K09: private SOP provenance and source exposures persist; other member cannot read/change exact current/history or forge a source; cumulative source closure cannot widen, and history rereads recheck revoked ACL');
  }
  {
    const f=await fixture('sop-task-domain-verifier');let task,unrelated,action,evidence;
    await run(f,f.user('Create real platform task and verification board'),async claim=>{
      task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'SOP platform domain fact',acceptanceCriteria:['Published result']}));
      unrelated=ok(await tool(f,claim,'create_task',{idempotencyKey:'unrelated',title:'Unrelated SOP platform task',acceptanceCriteria:['Different result']}));
      ok(await tool(f,claim,'update_sop',update('domain',0,{checks:[
        {id:'done',label:'Model label is not itself the verified predicate',state:'unknown',verificationRequirement:{kind:'task_done',taskId:task.taskId}},
        {id:'unrelated',label:'Different task must not inherit first task proof',state:'unknown',verificationRequirement:{kind:'task_done',taskId:unrelated.taskId}},
      ]})));
      assert.equal((await tool(f,claim,'update_sop',update('domain',1,{checks:[{id:'fake',label:'Unregistered proof',state:'attested',verificationRequirement:{kind:'model_tested',taskId:task.taskId}}]}))).code,'THREADED_SOP_VERIFIER_UNREGISTERED');
      assert.equal((await tool(f,claim,'verify_sop_check',{...update('domain',1),checkId:'done',evidenceId:'model-says-done'})).code,'THREADED_SOP_TYPED_EVIDENCE_REQUIRED');
      action=ok(await tool(f,claim,'transfer_action',{idempotencyKey:'assign',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));
      return 'Domain task assigned';});
    await run(f,undefined,async claim=>{
      const result=ok(await tool(f,claim,'post_message',{idempotencyKey:'result',body:'Actual acceptance result published',targets:[]}));
      const done=ok(await tool(f,claim,'complete_task',{idempotencyKey:'done',actionId:action.actionId,expectedGeneration:1,expectedTaskVersion:2,result:'Published result',acceptanceMessageIds:[result.message.id]}));
      evidence=done.evidenceId;assert.equal(f.db.prepare('SELECT state FROM threaded_actions WHERE id=?').get(action.actionId).state,'active');
      assert.equal((await tool(f,claim,'verify_sop_check',{...update('domain',1),checkId:'unrelated',evidenceId:evidence})).code,'THREADED_SOP_EVIDENCE_REQUIREMENT_MISMATCH');
      const state=ok(await tool(f,claim,'verify_sop_check',{...update('domain',1),checkId:'done',evidenceId:evidence}));
      assert.equal(state.version,2);assert.equal(state.checks[0].state,'verified');assert.equal(state.checks[0].verifiedFact.kind,'task_done');
      assert.equal(state.checks[0].verifiedFact.taskId,task.taskId);assert.equal(state.checks[0].verifiedFact.taskVersion,3);
      assert.equal(state.checks[0].verifiedFact.criteriaHash,f.db.prepare('SELECT criteria_hash FROM threaded_task_ownership WHERE task_id=?').get(task.taskId).criteria_hash);
      assert.equal(f.db.prepare('SELECT state FROM threaded_actions WHERE id=?').get(action.actionId).state,'active');
      assert.ok(state.sourceRefs.includes(result.message.id));
      const attested=ok(await tool(f,claim,'update_sop',update('domain',2,{checks:[{id:'done',label:'I changed the claim',state:'attested',verificationRequirement:{kind:'task_done',taskId:task.taskId}}]})));
      assert.equal(attested.checks[0].state,'attested');assert.equal(attested.checks[0].verifiedFact,undefined);
      const verified=ok(await tool(f,claim,'verify_sop_check',{...update('domain',3),checkId:'done',evidenceId:evidence}));assert.equal(verified.checks[0].state,'verified');
      assert.equal(ok(await tool(f,claim,'complete_action',{idempotencyKey:'complete',actionId:action.actionId,expectedGeneration:1,evidenceId:evidence})).state,'completed');
      return 'Exact typed fact verified independently of Action completion';});
    f.reopen();assert.equal(sop(f).snapshot(f.thread.ownerId,f.thread.id)[0].checks[0].state,'verified');
    const readonly=new f.db.constructor(f.file,{readonly:true,fileMustExist:true});
    try{
      const before=f.db.prepare('SELECT total_changes() n').get().n;
      const projected=snapshotThreadedSops(readonly,{messages:f.runtime.messages},f.thread.ownerId,f.thread.id);
      assert.equal(projected[0].checks[0].state,'verified');assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
      assert.equal(readonly.prepare('SELECT total_changes() n').get().n,0);
    }finally{readonly.close();}
    await run(f,f.user('Recheck cached verification after domain actor authority change'),async claim=>{
      const input={sopKey:'domain'};
      assert.equal(ok(await tool(f,claim,'read_sop',input,'sop-cached-read')).checks[0].state,'verified');
      f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='other-member'").run(f.thread.id);
      const stale=ok(await tool(f,claim,'read_sop',input,'sop-cached-read'));assert.equal(stale.checks[0].state,'unknown');assert.equal(stale.checks[0].verifiedFact.evidenceId,evidence);
      return 'Cached receipts cannot preserve current verification after actor authority changed';});
    const stale=sop(f).snapshot(f.thread.ownerId,f.thread.id)[0];assert.equal(stale.checks[0].state,'unknown');
    const history=JSON.parse(f.db.prepare('SELECT record FROM threaded_sop_versions WHERE version=4').get().record);assert.equal(history.checks[0].state,'verified');
    checks.push('SOP02/A02: built-in verifier resolves actual platform tasks and immutable task_transition evidence with exact current task version, Action generation, frozen criteria, assignee identity and acceptance source ACL; verification grants no Action completion; changed claims reset attestation and changed actor authority projects unknown while retaining history');
  }
  {
    const f=await fixture('sop-kill-after-commit');let request,binding;
    await run(f,f.user('Commit survives producer death'),async claim=>{
      binding=claim.binding;request=update('crash',0,{stage:'committed'});
      const [answer]=await workers(f,[{binding,name:'update_sop',input:request,key:'durable-sop-crash',crashAfterCommit:true}]);assert.equal(ok(answer).version,1);
      assert.equal(ok(await tool(f,claim,'update_sop',request,'durable-sop-crash')).version,1);assert.equal(count(f,'threaded_sop_versions'),1);
      return 'No duplicate on replay';});
    f.reopen();assert.equal(sop(f).snapshot(f.thread.ownerId,f.thread.id)[0].version,1);assert.equal(count(f,'threaded_sop_versions'),1);
    checks.push('DB01/SOP01: actual producer process SIGKILL immediately after durable tool commit; same-request replay and SQLite/runtime rebuild retain exactly one board version');
  }
  const report={generatedAt:new Date().toISOString(),schema:'threaded-sop-t11-v1',scope:'isolated real SQLite/runtime application tools with injected model protocol; no real model or remote domain requests',
    groups:checks.length,checks,faults,injectedProtocolRequests:injectedRequests,realModelRequests:0,newTokens:0,productionEntry:'closed'};
  if(process.env.THREADED_SOP_REPORT)await writeFile(process.env.THREADED_SOP_REPORT,`${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({ok:true,...report},null,2));
}finally{globalThis.fetch=originalFetch;for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
