import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-threaded-t08-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {parseThreadedMentions}=await import('../apps/server/src/threaded/routing.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No external network permitted');};
const fixtures=[],checks=[];let externalCalls=0;
const snapshots=[],faults=[];
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ledgerTables=['threaded_consultations','threaded_consultation_targets','threaded_consultation_settlements','threaded_collaboration_callbacks',
  'threaded_messages','threaded_message_sequences','threaded_message_control_boundaries','threaded_deliveries','threaded_wakes','threaded_outbox',
  'threaded_tool_receipts','threaded_message_routes','threaded_callback_lineage','threaded_route_completions','threaded_relay_events'];
function snapshot(f,label){const tables=Object.fromEntries(ledgerTables.map(table=>{const rows=f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();return[table,{rows:rows.length,sha256:sha(rows)}];}));
  const value={label,clock:f.clock(),injectedRequests:externalCalls,tables,
    groups:f.db.prepare('SELECT id,deadline,state,version FROM threaded_consultations ORDER BY id').all(),
    targets:f.db.prepare('SELECT group_id,agent_id,response_message_id,status FROM threaded_consultation_targets ORDER BY group_id,agent_id').all(),
    callbacks:f.db.prepare('SELECT id,source_id,state,message_id,reason FROM threaded_collaboration_callbacks ORDER BY id').all()};snapshots.push(value);return tables;}
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
const count=(f,t)=>f.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
async function fixture(name,extra={}){let f;let clock=Date.now();
  f=await openBackendRuntimeFixture(root,name,{agentIds:['api-member','sdk-member','other-member','fourth-member'],
    now:()=>clock,applicationTools:THREADED_APPLICATION_TOOL_NAMES,...extra,fetch:async(_url,init)=>{externalCalls++;f.wire=JSON.parse(init.body);return response(await(f.handler?.(f.activeClaim)??'normal final'));}});
  f.clock=()=>clock;f.advance=ms=>{clock+=ms;};
  for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  f.runtime.collaboration.routing.configure(f.thread.ownerId,f.thread.id,{preferred:[],defaultAgent:'api-member',groups:{team:['other-member','sdk-member']}},0);
  fixtures.push(f);return f;
}
async function run(f,receipt,handler){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
  const claim=f.runtime.queue.claimNext('t08-fixture');assert.ok(claim,'claim expected');f.activeClaim=claim;f.handler=handler;
  const result=await f.runtime.executeClaim(claim);f.handler=undefined;return{claim,result};}
const tool=async(f,claim,name,input,key=randomUUID())=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
function worker(f,clock,mode){
  const child=fork(new URL('./fixtures/threadedCooperationWorker.mjs',import.meta.url),[f.file,String(clock),mode],{
    execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const ready=new Promise((resolve,reject)=>{child.on('message',message=>{if(message.type==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code!==32&&code!==null)reject(new Error(stderr||`worker exited ${code}`));});});
  const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{if(code===32||signal==='SIGKILL')resolve({code,signal});else reject(new Error(stderr||`worker exited ${code}`));});});
  return {child,ready,exit};
}
try{
  {
    const roster=[{id:'a',handle:'alpha'},{id:'b',handle:'alpha-long'},{id:'c',handle:'beta'}];
    assert.deepEqual(parseThreadedMentions('inline @alpha-long and @beta',roster),['b','c']);
    assert.deepEqual(parseThreadedMentions('```\n@alpha\n```\n`@beta` "@alpha" https://x/@beta foo@alpha',roster),[]);
    assert.deepEqual(parseThreadedMentions('正文 @beta\n@ alpha - long, @beta\n@alpha',roster,'a'),['b','c']);
    assert.deepEqual(parseThreadedMentions('@alpha-longer',roster),[]);
    const f=await fixture('user-routing');
    const input={ownerId:f.thread.ownerId,threadId:f.thread.id,clientRequestId:'route-user',body:'@team #ideate discuss'};
    const preview=f.runtime.collaboration.routing.preview(input),accepted=f.runtime.collaboration.routing.acceptUserMessage(input);
    assert.deepEqual(accepted.route,preview);assert.equal(preview.strategy,'parallel');assert.equal(accepted.receipt.wakes.length,2);
    assert.deepEqual(f.runtime.collaboration.routing.acceptUserMessage(input),accepted);
    assert.throws(()=>f.runtime.collaboration.routing.acceptUserMessage({...input,body:'changed'}),/IDEMPOTENCY/);
    assert.throws(()=>f.runtime.collaboration.routing.preview({...input,targets:['api-member']}),/TARGET_CONFLICT/);
    assert.equal(f.runtime.collaboration.routing.preview({...input,body:'no explicit mention'}).reason,'default');
    f.runtime.collaboration.routing.configure(f.thread.ownerId,f.thread.id,{preferred:['sdk-member','other-member'],defaultAgent:'api-member',duty:'fourth-member',groups:{team:['other-member','sdk-member']}},1);
    assert.equal(f.runtime.collaboration.routing.preview({...input,body:'next'}).reason,'duty');
    assert.equal(f.runtime.collaboration.routing.preview({...input,body:'#ideate next'}).strategy,'parallel');
    assert.equal(f.runtime.collaboration.routing.preview({...input,body:'@team'}).strategy,'parallel');
    assert.equal(f.runtime.collaboration.routing.preview({...input,body:'@team #critique'}).intent,'ideate');
    assert.equal(f.runtime.collaboration.routing.preview({...input,body:'@team #ideate #execute'}).strategy,'serial');
    assert.deepEqual(f.runtime.collaboration.routing.preview({...input,body:'@fourth-member @team #execute'}).targets,['fourth-member','other-member','sdk-member']);
    assert.throws(()=>f.runtime.collaboration.routing.configure(f.thread.ownerId,f.thread.id,{preferred:[],defaultAgent:'api-member',groups:{all:['sdk-member']}},2),/GROUP_INVALID/);
    checks.push('R01/R02: longest handles, code/quote/URL exclusion, user inline vs Agent line-start, groups/intents, preview/admission identity and durable user-request conflict');
  }
  {
    const f=await fixture('serial-and-parallel');
    const input={ownerId:f.thread.ownerId,threadId:f.thread.id,clientRequestId:'serial',body:'@api-member @other-member #execute'};
    const accepted=f.runtime.collaboration.routing.acceptUserMessage(input);assert.equal(accepted.receipt.wakes.length,1);
    const first=await run(f,accepted.receipt,async()=> 'SERIAL_FIRST_RESULT');assert.equal(first.result.status,'completed');
    const second=await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'other-member');
      const payload=f.runtime.context.getPayload(claim.binding,f.db.prepare('SELECT id FROM threaded_context_manifests WHERE binding_id=?').get(claim.binding.id).id);
      assert.ok(payload.serialized.includes('SERIAL_FIRST_RESULT'));return 'serial second';});
    assert.equal(second.claim.queue.causalRootId,first.claim.queue.causalRootId);
    assert.equal(f.db.prepare('SELECT a2a_depth FROM threaded_budget_invocations WHERE invocation_id=?').get(second.claim.binding.invocationId).a2a_depth,0);
    const parallel=f.runtime.collaboration.routing.acceptUserMessage({...input,clientRequestId:'parallel',body:'@api-member @other-member #critique'});
    await run(f,parallel.receipt,async()=>{assert.ok(f.wire.system.includes('批判性分析'));return '@fourth-member\nPARALLEL_PRIVATE_THOUGHT';});
    const before=count(f,'threaded_wakes');
    await run(f,undefined,async claim=>{const m=f.db.prepare('SELECT payload FROM threaded_context_manifests WHERE binding_id=?').get(claim.binding.id);
      assert.ok(!m.payload.includes('PARALLEL_PRIVATE_THOUGHT'));return '@fourth-member';});
    assert.equal(count(f,'threaded_wakes'),before);
    checks.push('R02/R03/CTX05: serial targets become durable ordered continuations under one root; ideate freezes independent inputs and suppresses text A2A');
  }
  {
    const f=await fixture('post-final-tools');
    let post;
    const first=await run(f,f.user('independent post and final'),async claim=>{
      post=ok(await tool(f,claim,'post_message',{idempotencyKey:'post-once',body:'@other-member same request',targets:['other-member']}));
      assert.deepEqual(ok(await tool(f,claim,'post_message',{idempotencyKey:'post-once',body:'@other-member same request',targets:['other-member']})),post);
      assert.equal((await tool(f,claim,'post_message',{idempotencyKey:'post-once',body:'changed'})).ok,false);
      assert.equal((await tool(f,claim,'post_message',{idempotencyKey:'conflict',body:'@other-member',targets:['sdk-member']})).code,'THREADED_ROUTING_TARGET_CONFLICT');
      return '@other-member same request';});
    assert.equal(first.result.status,'completed');assert.equal(count(f,'threaded_wakes'),3);
    const rootId=first.claim.queue.causalRootId;await run(f);await run(f);
    assert.equal(f.runtime.budget.getUsage(rootId).invocations,3);
    await assert.rejects(()=>tool(f,first.claim,'post_message',{idempotencyKey:'late',body:'late'}),/RESOURCE_CLAIM_RELEASED|AUTHORITY/);
    checks.push('M01/M03/B01: explicit post and identical final create distinct wake/message identities; exact tool retries return durable receipts, conflicts and late effects reject, root budget is shared');
  }
  {
    const f=await fixture('private-read-boundaries');
    const privateMessage=f.user('PRIVATE_A',[],{visibility:'private',audience:['api-member']});
    const other=f.user('PRIVATE_OTHER',[],{visibility:'private',audience:['other-member']});
    const receipt=f.user('current trigger');
    const future=f.user('FUTURE_BEYOND_CUTOFF',[]);
    await run(f,receipt,async claim=>{
      assert.equal(ok(await tool(f,claim,'read_message',{messageId:privateMessage.message.id})).body,'PRIVATE_A');
      assert.equal((await tool(f,claim,'read_message',{messageId:other.message.id})).ok,false);
      assert.equal((await tool(f,claim,'read_message',{messageId:future.message.id})).ok,false);
      const search=ok(await tool(f,claim,'search_messages',{query:'PRIVATE'}));assert.equal(search.length,1);
      assert.equal((await tool(f,claim,'post_message',{idempotencyKey:'private-to-other',body:'do not declassify',targets:['other-member']})).ok,false);
      assert.equal((await tool(f,claim,'cross_post_message',{idempotencyKey:'cross-empty',threadId:'foreign',body:'private',targets:[]})).ok,false);
      ok(await tool(f,claim,'mark_seen',{idempotencyKey:'seen',messageIds:[privateMessage.message.id]}));
      ok(await tool(f,claim,'acknowledge_mentions',{idempotencyKey:'ack',messageIds:[receipt.message.id]}));
      return 'PRIVATE_RESULT';});
    const final=f.db.prepare("SELECT record FROM threaded_messages WHERE origin='agent_response' ORDER BY seq DESC LIMIT 1").get();
    const m=JSON.parse(final.record);assert.equal(m.visibility,'private');assert.ok(m.audience.includes('api-member'));
    checks.push('CTX02/M02: exact reads, search and seen/mention tools enforce ACL and frozen cutoff; private model/read history narrows final and tool messages instead of widening audience');
  }
  {
    const f=await fixture('cross-thread-source-and-attachment');
    const target=createThreadedStore(f.db).createThread({title:'authorized target',members:['api-member','other-member'].map(agentId=>({agentId,handle:agentId,roleVersion:1,permissionVersion:1}))});
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(target.id);
    const source=f.user('explicit source',[],{attachments:[{name:'bytes.txt',mediaType:'text/plain',contentBase64:Buffer.from('abcdef').toString('base64')}]});
    let cross;
    const first=await run(f,f.user('post explicit source to authorized thread'),async claim=>{
      const bytes=ok(await tool(f,claim,'read_attachment',{attachmentId:source.message.attachments[0].id,offset:2,length:3}));
      assert.equal(Buffer.from(bytes.contentBase64,'base64').toString(),'cde');assert.equal(bytes.attachment.contentHash,source.message.attachments[0].contentHash);
      assert.equal((await tool(f,claim,'read_attachment',{attachmentId:source.message.attachments[0].id,offset:5,length:2})).ok,false);
      cross=ok(await tool(f,claim,'cross_post_message',{idempotencyKey:'cross-good',threadId:target.id,body:'explicit transfer',targets:['other-member'],sourceRefs:[source.message.id]}));
      return 'posted';});
    await run(f,cross,async claim=>{
      assert.equal(claim.binding.threadId,target.id);
      const refs=ok(await tool(f,claim,'message_sources',{messageId:cross.message.id}));
      assert.ok(refs.some(r=>r.id===source.message.id&&r.bodyExpanded===false));return 'received authorized provenance';});
    assert.equal(f.db.prepare('SELECT COUNT(DISTINCT causal_root_id) n FROM threaded_invocations').get().n,1);
    assert.equal(cross.message.causalRootId,first.claim.queue.causalRootId);
    checks.push('M02/CTX02: authorized cross_post crosses a real Thread boundary under the same causal root; attachment range returns exact bytes/full hash and cross-Thread provenance stays reference-only');
  }
  {
    const f=await fixture('ping-pong');
    let current=await run(f,f.user('start loop'),async()=> '@other-member short');
    await run(f,undefined,async()=> '@api-member short');
    await run(f,undefined,async()=>{assert.ok(f.wire.system.includes('协作提示'));return '@other-member short';});
    const blocked=await run(f,undefined,async()=> '@api-member short');
    assert.equal(blocked.result.status,'completed');assert.equal(f.runtime.queue.claimNext('loop-blocked'),null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_relay_events WHERE warning=1').get().n,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_relay_events WHERE blocked=1').get().n,1);
    await run(f,f.user('new user resets'),async()=> '@other-member next');
    await run(f,undefined,async()=> '@api-member next');
    await run(f,undefined,async claim=>{ok(await tool(f,claim,'search_messages',{query:'resets'}));return '@other-member substantive reset';});
    assert.equal(f.db.prepare('SELECT streak FROM threaded_relay_events ORDER BY rowid DESC LIMIT 1').get().streak,1);
    checks.push('R04: same-pair short replies warn at 2/3 and block at 4; new user input and substantive tool work reset the durable streak without resetting the root budget');
  }
  {
    const f=await fixture('consult-partial-restart');let group;
    await run(f,f.user('ask three'),async claim=>{
      assert.equal((await tool(f,claim,'multi_mention',{idempotencyKey:'missing-evidence',targets:['other-member'],question:'question',callbackTo:'api-member'})).code,'THREADED_CONSULTATION_SEARCH_REQUIRED');
      group=ok(await tool(f,claim,'multi_mention',{idempotencyKey:'group',targets:['sdk-member','other-member','fourth-member'],question:'keep differing answers',callbackTo:'api-member',timeoutMinutes:3,overrideReason:'No search is needed for this new question'}));
      assert.equal(count(f,'threaded_consultation_targets'),3);return 'caller completed without waiting';});
    await run(f,undefined,async claim=>{
      const cascade=await tool(f,claim,'multi_mention',{idempotencyKey:'cascade',targets:['api-member'],question:'cascade',callbackTo:claim.binding.agentId,overrideReason:'not allowed'});
      assert.equal(cascade.code,'THREADED_CONSULTATION_CASCADE_DENIED');return 'answer first dissent';});
    const before=externalCalls;f.reopen();f.runtime.recover();assert.equal(externalCalls,before);
    assert.equal(f.db.prepare('SELECT deadline FROM threaded_consultations WHERE id=?').get(group.groupId).deadline,group.deadline);
    const late=f.runtime.queue.claimNext('late-already-running');assert.ok(late);f.activeClaim=late;
    let releaseLate,startedLate;const lateGate=new Promise(resolve=>releaseLate=resolve),started=new Promise(resolve=>startedLate=resolve);
    f.handler=async()=>{startedLate();await lateGate;return 'late reply must not resurrect';};
    const lateRun=f.runtime.executeClaim(late);await started;
    f.advance(180_001);f.runtime.collaboration.cooperation.recover();
    const settlement=JSON.parse(f.db.prepare('SELECT record FROM threaded_consultation_settlements WHERE group_id=?').get(group.groupId).record);
    assert.equal(settlement.kind,'partial');assert.equal(settlement.responses.filter(r=>r.status==='timeout').length,2);
    assert.ok(settlement.responses.find(r=>r.body==='answer first dissent'));
    const callbacks=count(f,'threaded_collaboration_callbacks');f.runtime.collaboration.cooperation.recover();assert.equal(count(f,'threaded_collaboration_callbacks'),callbacks);
    releaseLate();await lateRun;f.handler=undefined;
    assert.equal(count(f,'threaded_consultation_settlements'),1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_consultation_targets WHERE status=\'responded\'').get().n,1);
    checks.push('MM01/MM03/MM04/E01/E02: persisted 3-target consultation survives factory/SQLite rebuild with original deadline and first response; offline deadline settles partial once with exact dissent and no synthesis call; cascade and late resurrection reject');
  }
  {
    const f=await fixture('consult-callback-permissions');let group;
    await run(f,f.user('private callback control'),async claim=>{group=ok(await tool(f,claim,'multi_mention',{idempotencyKey:'group',targets:['other-member'],question:'reply later',callbackTo:'api-member',timeoutMinutes:3,overrideReason:'new request'}));return 'waiting in durable state';});
    f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action:'pause',requestId:'pause-caller'});
    await run(f,undefined,async()=> 'target answer');
    assert.equal(f.db.prepare('SELECT state FROM threaded_collaboration_callbacks WHERE source_id=?').get(group.groupId).state,'waiting');
    f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
    f.runtime.collaboration.cooperation.recover();
    assert.equal(f.db.prepare('SELECT state FROM threaded_collaboration_callbacks WHERE source_id=?').get(group.groupId).state,'rejected');
    assert.equal(count(f,'threaded_consultation_settlements'),1);
    checks.push('E05: caller pause preserves settlement with an explicit waiting callback; later permission drift rejects callback without widening authority or discarding original responses');
  }
  {
    for(const stopped of [false,true]){
      const f=await fixture(`callback-control-${stopped}`);let group;
      await run(f,f.user('control callback'),async claim=>{group=ok(await tool(f,claim,'multi_mention',{idempotencyKey:'group',targets:['other-member'],question:'answer',callbackTo:'api-member',overrideReason:'new question'}));return 'registered';});
      const control=action=>f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action,requestId:randomUUID()});
      control('pause');if(stopped)control('stop');
      await run(f,undefined,async()=> 'answer preserved');
      control('resume');f.runtime.collaboration.cooperation.recover();
      assert.equal(f.db.prepare('SELECT state FROM threaded_collaboration_callbacks WHERE source_id=?').get(group.groupId).state,stopped?'cancelled':'delivered');
      assert.equal(count(f,'threaded_consultation_settlements'),1);
    }
    checks.push('E05 controls: unchanged pause/resume delivers the one frozen callback; any intervening stop permanently cancels it even after resume, preserving settlement history');
  }
  {
    const f=await fixture('hold-wait');let first;
    const result=await run(f,f.user('register holds'),async claim=>{
      const input={idempotencyKey:'hold-one',jobKey:'job-one',seconds:5,waitSourceRef:'timer:check-later'};
      first=ok(await tool(f,claim,'hold_ball',input));assert.deepEqual(ok(await tool(f,claim,'hold_ball',input)),first);
      f.db.exec("CREATE TRIGGER fixture_wait_fault BEFORE INSERT ON threaded_waits BEGIN SELECT RAISE(ABORT,'fixture_wait_fault'); END;");
      await assert.rejects(()=>tool(f,claim,'hold_ball',{...input,idempotencyKey:'replace-fault',jobKey:'replace-fault',replaceWaitId:first.waitId,expectedVersion:1}),/fixture_wait_fault/);
      f.db.exec('DROP TRIGGER fixture_wait_fault');assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(first.waitId).state,'awaiting');assert.equal(count(f,'threaded_hold_quota'),1);
      const second=ok(await tool(f,claim,'hold_ball',{...input,idempotencyKey:'hold-two',jobKey:'job-two',replaceWaitId:first.waitId,expectedVersion:1}));
      ok(await tool(f,claim,'hold_ball',{...input,idempotencyKey:'hold-three',jobKey:'job-three'}));
      assert.equal((await tool(f,claim,'hold_ball',{...input,idempotencyKey:'hold-four',jobKey:'job-four'})).status,429);
      assert.equal(count(f,'threaded_hold_quota'),3);return 'normal final after registration';});
    assert.equal(f.resources.getClaim(result.claim.binding.claimId).state,'released');
    const rootId=result.claim.queue.causalRootId,activity=f.runtime.budget.getUsage(rootId).activityMs;
    f.advance(5001);f.reopen();f.runtime.collaboration.cooperation.recover();
    assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(first.waitId).state,'superseded');
    assert.equal(count(f,'threaded_collaboration_callbacks'),2);
    for(const row of f.db.prepare('SELECT outcome FROM threaded_waits WHERE state=\'settled\'').all())assert.equal(JSON.parse(row.outcome).businessConditionVerified,false);
    assert.equal(f.runtime.budget.getUsage(rootId).activityMs,activity);
    for(const row of f.db.prepare("SELECT causal_root_id FROM threaded_messages WHERE origin='system'").all())assert.equal(row.causal_root_id,rootId);
    checks.push('W01/W03/B01: holds return before the normal final, release the execution claim, use sliding quota and same-job idempotency; replacement retires only the wake; restored timer outcomes inherit root and do not charge idle time or prove business completion');
  }
  {
    const f=await fixture('tracking-baseline');let wait;
    await run(f,f.user('watch future user inputs'),async claim=>{
      wait=ok(await tool(f,claim,'track_event',{idempotencyKey:'watch',jobKey:'watch-job',source:'thread_messages',subject:f.thread.id,match:{type:'message',origin:'user'}}));
      assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(wait.waitId).state,'awaiting');return 'watch registered';});
    await f.runtime.collaboration.tracking.refresh();assert.equal(count(f,'threaded_collaboration_callbacks'),0);
    const next=f.user('NEW_TRACKING_EVENT',[]);await f.runtime.collaboration.tracking.refresh();
    const row=f.db.prepare('SELECT outcome FROM threaded_waits WHERE id=?').get(wait.waitId);assert.equal(JSON.parse(row.outcome).event.messageId,next.message.id);
    const callback=JSON.parse(f.db.prepare("SELECT record FROM threaded_messages WHERE origin='system'").get().record);assert.equal(callback.visibility,'private');
    await f.runtime.collaboration.tracking.refresh();assert.equal(count(f,'threaded_collaboration_callbacks'),1);
    checks.push('W05: a registered live source freezes its durable baseline, excludes existing matching history, and emits one private source-referenced callback only for a new matching event');
  }
  {
    const f=await fixture('decision-origin');let decision;
    await run(f,f.user('ask user'),async claim=>{
      assert.equal((await tool(f,claim,'request_user_input',{})).status,410);
      decision=ok(await tool(f,claim,'conversation_decision',{idempotencyKey:'decision',jobKey:'question',question:'Which option?',once:true,block:'interactive'}));return 'question registered, current Invocation finished';});
    assert.throws(()=>f.runtime.collaboration.cooperation.answerDecision({ownerId:f.thread.ownerId,threadId:f.thread.id,waitId:decision.waitId,expectedVersion:2,clientRequestId:'wrong-revision',body:'option'}),/VERSION_CONFLICT/);
    const answer=f.runtime.collaboration.cooperation.answerDecision({ownerId:f.thread.ownerId,threadId:f.thread.id,waitId:decision.waitId,expectedVersion:1,clientRequestId:'answer',body:'option A'});
    await run(f,answer,async claim=>{
      assert.equal((await tool(f,claim,'settle_decision',{idempotencyKey:'wrong-origin',waitId:decision.waitId,operationId:'wrong',expectedVersion:1,responseMessageId:'not-the-trigger'})).code,'THREADED_DECISION_RESPONSE_ORIGIN_INVALID');
      const input={idempotencyKey:'settle',waitId:decision.waitId,operationId:'settle',expectedVersion:1,responseMessageId:answer.message.id};
      f.db.exec("CREATE TRIGGER fixture_decision_fault BEFORE INSERT ON threaded_wait_operations BEGIN SELECT RAISE(ABORT,'fixture_decision_fault'); END;");
      await assert.rejects(()=>tool(f,claim,'settle_decision',input),/fixture_decision_fault/);f.db.exec('DROP TRIGGER fixture_decision_fault');
      assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(decision.waitId).state,'awaiting');
      ok(await tool(f,claim,'settle_decision',input));ok(await tool(f,claim,'settle_decision',input));return 'human answer used without business approval';});
    const outcome=JSON.parse(f.db.prepare('SELECT outcome FROM threaded_waits WHERE id=?').get(decision.waitId).outcome);assert.equal(outcome.businessApproval,false);
    assert.throws(()=>f.runtime.collaboration.cooperation.answerDecision({ownerId:f.thread.ownerId,threadId:f.thread.id,waitId:decision.waitId,expectedVersion:1,clientRequestId:'stale-answer',body:'old'}),/VERSION_CONFLICT/);
    checks.push('W02/W06: retired request_user_input returns 410; ordinary once Decision registration is nonblocking, exact revision and authenticated origin-trigger settlement are required, retries are stable and no business approval is inferred');
  }
  {
    const f=await fixture('group-atomic-faults');
    await run(f,f.user('atomic group'),async claim=>{
      for(const table of ['threaded_consultations','threaded_messages','threaded_message_control_boundaries','threaded_deliveries','threaded_wakes','threaded_outbox','threaded_consultation_targets','threaded_message_routes','threaded_tool_receipts']){
        const before=count(f,'threaded_consultations'),messages=count(f,'threaded_messages');
        const beforeFacts=snapshot(f,`E06 before group insert ${table}`);
        f.db.exec(`CREATE TRIGGER fixture_group_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fixture_group_fault'); END;`);
        await assert.rejects(()=>tool(f,claim,'multi_mention',{idempotencyKey:`fault-${table}`,targets:['other-member'],question:'no partial',callbackTo:'api-member',overrideReason:'fault injection'}),/fixture_group_fault/);
        f.db.exec('DROP TRIGGER fixture_group_fault');assert.equal(count(f,'threaded_consultations'),before);assert.equal(count(f,'threaded_messages'),messages);
        const afterFacts=snapshot(f,`E06 after group insert ${table}`);assert.deepEqual(afterFacts,beforeFacts);faults.push({table,operation:'INSERT',phase:'group',rolledBack:true});
      }
      f.db.pragma('query_only=ON');
      await assert.rejects(()=>tool(f,claim,'multi_mention',{idempotencyKey:'readonly',targets:['other-member'],question:'no false success',callbackTo:'api-member',overrideReason:'readonly fixture'}),/readonly|read-only/i);
      f.db.pragma('query_only=OFF');assert.equal(count(f,'threaded_consultations'),0);
      ok(await tool(f,claim,'multi_mention',{idempotencyKey:'good-after-faults',targets:['other-member'],question:'retry',callbackTo:'api-member',overrideReason:'new request'}));return 'done';});
    f.db.exec("CREATE TRIGGER fixture_settlement_fault BEFORE INSERT ON threaded_consultation_settlements BEGIN SELECT RAISE(ABORT,'fixture_settlement_fault'); END;");
    await assert.rejects(()=>run(f,undefined,async()=> 'durable target answer'),/fixture_settlement_fault/);
    const claim=f.activeClaim;assert.equal(count(f,'threaded_consultation_settlements'),0);
    assert.equal(f.db.prepare('SELECT response_message_id FROM threaded_consultation_targets').get().response_message_id,null);
    f.db.exec('DROP TRIGGER fixture_settlement_fault');
    const proof=JSON.parse(f.db.prepare('SELECT proof FROM execution_resource_quiescence WHERE claim_id=?').get(claim.binding.claimId).proof),before=externalCalls;
    const known={kind:'completed',content:'durable target answer',budgetState:'unknown',quiescence:proof};
    for(const [table,operation,condition]of [
      ['threaded_consultation_targets','UPDATE',''],['threaded_consultations','UPDATE',''],
      ['threaded_collaboration_callbacks','INSERT',''],['threaded_messages','INSERT',"WHEN NEW.origin='system'"],
      ['threaded_callback_lineage','INSERT',''],['threaded_deliveries','INSERT',''],['threaded_wakes','INSERT',''],
      ['threaded_outbox','INSERT',"WHEN NEW.event_type='message.created' AND EXISTS(SELECT 1 FROM threaded_messages m WHERE m.id=NEW.source_id AND m.origin='system')"],
      ['threaded_collaboration_callbacks','UPDATE',''],['threaded_route_completions','INSERT',''],['threaded_relay_events','INSERT','']]){
      const beforeFacts=snapshot(f,`E06 before terminal ${operation} ${table}`);
      f.db.exec(`CREATE TRIGGER fixture_atomic_fault BEFORE ${operation} ON ${table} ${condition} BEGIN SELECT RAISE(ABORT,'fixture_atomic_fault'); END;`);
      assert.throws(()=>f.runtime.lifecycle.recordOutcome(claim.binding,known),/fixture_atomic_fault/);f.db.exec('DROP TRIGGER fixture_atomic_fault');
      assert.equal(count(f,'threaded_consultation_settlements'),0);assert.equal(count(f,'threaded_collaboration_callbacks'),0);
      assert.equal(f.db.prepare('SELECT response_message_id FROM threaded_consultation_targets').get().response_message_id,null);
      const afterFacts=snapshot(f,`E06 after terminal ${operation} ${table}`);assert.deepEqual(afterFacts,beforeFacts);faults.push({table,operation,phase:'terminal',rolledBack:true});
    }
    f.runtime.lifecycle.recordOutcome(claim.binding,known);
    assert.equal(externalCalls,before);assert.equal(count(f,'threaded_consultation_settlements'),1);assert.equal(count(f,'threaded_collaboration_callbacks'),1);
    snapshot(f,'E06 known terminal retry committed without model replay');
    checks.push('E06/DB01/DB02: group/target/message/Delivery/Wake/Outbox/tool-receipt insertion faults roll back together; settlement failure rolls back last response and terminal, then exact proven outcome retries with no second model request');
  }
  {
    const f=await fixture('process-recovery-outbox');let group;
    await run(f,f.user('durable partial crash'),async claim=>{group=ok(await tool(f,claim,'multi_mention',{idempotencyKey:'group',targets:['other-member','fourth-member'],question:'retain partial across process death',callbackTo:'api-member',timeoutMinutes:3,overrideReason:'crash fixture'}));return 'registered';});
    await run(f,undefined,async()=> 'first process answer');
    snapshot(f,'E01 partial group before actual SIGKILL');
    const before=externalCalls;f.close();const first=worker(f,f.clock(),'recover');await first.ready;first.child.kill('SIGKILL');await first.exit;
    const resumed=worker(f,group.deadline+1,'recover');await resumed.ready;resumed.child.send({go:true});assert.equal((await resumed.exit).code,32);
    f.advance(180_001);f.reopen();f.runtime.collaboration.cooperation.recover();assert.equal(externalCalls,before);
    assert.equal(count(f,'threaded_consultation_settlements'),1);assert.equal(count(f,'threaded_collaboration_callbacks'),1);
    snapshot(f,'E01/E02/E04 fresh worker crossed original deadline and exited32 before dispatch');
    const callback=f.db.prepare('SELECT message_id FROM threaded_collaboration_callbacks').get().message_id;
    const event=f.db.prepare("SELECT id FROM threaded_outbox WHERE event_type='message.created' AND source_id=?").get(callback);assert.ok(event);
    let delivered=0,retried=false;const outbox=f.runtime.messaging.outbox;
    for(let i=0;i<100&&!retried;i++){
      const result=outbox.dispatchOne('crash-receiver','t08-notification-consumer',hint=>{if(hint.eventId===event.id){delivered++;throw new Error('receiver crashed after send before ACK');}});
      if(result.status==='retry')retried=true;if(result.status==='empty')break;
    }
    assert.equal(delivered,1);assert.equal(retried,true);
    snapshot(f,'E04 notification sent once before consumer ACK failure');
    f.advance(60_000);
    for(let i=0;i<100;i++){const result=outbox.dispatchOne('recovered-receiver','t08-notification-consumer',hint=>{if(hint.eventId===event.id)delivered++;});if(result.status==='empty')break;}
    assert.equal(delivered,2);assert.equal(count(f,'threaded_consultation_settlements'),1);
    f.runtime.queue.scanPending();f.runtime.queue.scanPending();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_wake_queue q JOIN threaded_wakes w ON w.id=q.wake_id WHERE w.source_message_id=?').get(callback).n,1);
    snapshot(f,'E04 repeated notification but unique settlement/callback/queue; no model replay');
    checks.push('E01/E02/E04: real recovery worker SIGKILL on a partial group, fresh worker crosses original deadline and exits32 after settlement before dispatch; receiver send-before-ACK retry repeats a hint but preserves one settlement/callback/queue identity and performs no model replay');
  }
  {
    const f=await fixture('last-response-deadline-race');let group;
    await run(f,f.user('race deadline'),async claim=>{group=ok(await tool(f,claim,'multi_mention',{idempotencyKey:'race',targets:['other-member','fourth-member'],question:'race',callbackTo:'api-member',timeoutMinutes:3,overrideReason:'race fixture'}));return 'ready';});
    await run(f,undefined,async()=> 'first answer');
    f.db.exec("CREATE TRIGGER fixture_preterminal_crash BEFORE INSERT ON threaded_invocation_terminals BEGIN SELECT RAISE(ABORT,'fixture_preterminal_crash'); END;");
    await assert.rejects(()=>run(f,undefined,async()=> 'competing last response'),/fixture_preterminal_crash/);
    f.db.exec('DROP TRIGGER fixture_preterminal_crash');const before=externalCalls;snapshot(f,'E03 before IPC barrier race');f.close();
    const timeout=worker(f,group.deadline,'recover'),answer=worker(f,group.deadline-1,'terminal');
    await Promise.all([timeout.ready,answer.ready]);timeout.child.send({go:true});answer.child.send({go:true});
    await Promise.all([timeout.exit,answer.exit]);f.advance(180_001);f.reopen();f.runtime.collaboration.cooperation.recover();
    assert.equal(count(f,'threaded_consultation_settlements'),1);assert.equal(count(f,'threaded_collaboration_callbacks'),1);assert.equal(externalCalls,before);
    const settled=f.db.prepare('SELECT kind,record FROM threaded_consultation_settlements').get();assert.ok(['complete','partial'].includes(settled.kind));
    const original=settled.record;f.runtime.collaboration.cooperation.recover();assert.equal(f.db.prepare('SELECT record FROM threaded_consultation_settlements').get().record,original);
    snapshot(f,'E03 after last-response/deadline barrier and repeated recovery');
    checks.push('MM02/E03: two real SQLite IPC writers released at one barrier race last verified response against deadline; one immutable settlement/callback wins, repeated recovery and late terminal cannot revive it or replay the model');
  }
  {
    const f=await fixture('hold-does-not-reset-loop');
    await run(f,f.user('begin'),async()=> '@other-member short');
    await run(f,undefined,async claim=>{ok(await tool(f,claim,'hold_ball',{idempotencyKey:'hold',jobKey:'hold',seconds:5,waitSourceRef:'timer:wait'}));return 'hold registered';});
    f.advance(5001);f.runtime.collaboration.cooperation.recover();
    await run(f,undefined,async()=> '@api-member resumed short');
    assert.equal(f.db.prepare('SELECT streak FROM threaded_relay_events ORDER BY rowid DESC LIMIT 1').get().streak,2);
    checks.push('K15/R04/W01: a timer callback carries the original same-pair streak, so holding/restarting does not reset language-inertia protection or count as a fresh A2A hop');
  }
  {
    const {githubPrTrackingSource}=await import('../apps/server/src/threaded/tracking.ts');
    let pr={head:{sha:'old-head'},state:'open',merged:false,merge_commit_sha:null,updated_at:'initial'};
    const source=githubPrTrackingSource({authorize:scope=>`fixture-repo:${scope.agentId}`,fetch:async route=>{assert.equal(route,'/repos/fixture/repository/pulls/16');return pr;}});
    const f=await fixture('github-tracking',{trackingSources:{github_pr:source}});let wait;
    await run(f,f.user('watch a new PR head'),async claim=>{wait=ok(await tool(f,claim,'track_event',{
      idempotencyKey:'pr-watch',jobKey:'pr-watch',source:'github_pr',subject:'fixture/repository#16',match:{headSha:'new-head'}}));return 'watch registered';});
    pr={...pr,updated_at:'cosmetic-only'};await f.runtime.collaboration.tracking.refresh();assert.equal(count(f,'threaded_collaboration_callbacks'),0);
    pr={...pr,head:{sha:'new-head'},updated_at:'new-head-time'};await f.runtime.collaboration.tracking.refresh();
    const outcome=JSON.parse(f.db.prepare('SELECT outcome FROM threaded_waits WHERE id=?').get(wait.waitId).outcome);
    assert.equal(outcome.event.headSha,'new-head');assert.ok(!JSON.stringify(outcome).includes('__authorization'));
    assert.equal(count(f,'threaded_collaboration_callbacks'),1);
    checks.push('W05 producer protocol: server-allowlisted GitHub path uses a live baseline; unchanged state with cosmetic updated_at does not trigger, a new head triggers exactly once; transport remains injected, no real GitHub business claim');
  }
  for(const f of fixtures)assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  const report={ok:true,groups:checks.length,checks,realModelCalls:0,externalNetworkCalls:0,
    injectedHttpCalls:externalCalls,scope:'T08 isolated SQLite, canonical runtime/context/backend/tool ports and injected transport; no daily DB or real models'};
  const reportIndex=process.argv.indexOf('--report');if(reportIndex>=0)await writeFile(process.argv[reportIndex+1],JSON.stringify({...report,generatedAt:new Date().toISOString(),faults,snapshots},null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
