import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t10-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'legacy.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {createThreadedView}=await import('../apps/server/src/threaded/view.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const fixtures=[],checks=[],faults=[];let injectedHttpCalls=0;
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
async function fixture(name,extra={}){let f;let clock=Date.now();f=await openBackendRuntimeFixture(root,name,{now:()=>clock,applicationTools:THREADED_APPLICATION_TOOL_NAMES,...extra,
  fetch:async()=>{injectedHttpCalls++;try{return response(await(f.handler?.(f.activeClaim)??'done'));}catch(error){f.handlerError=error;throw error;}}});
  f.clock=()=>clock;f.advance=ms=>clock+=ms;for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  fixtures.push(f);return f;
}
async function run(f,receipt,handler){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
  const claim=f.runtime.queue.claimNext('t10');assert.ok(claim,'claim expected');f.activeClaim=claim;f.handler=handler;
  const result=await f.runtime.executeClaim(claim);f.handler=undefined;if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));return claim;
}
async function runFor(f,agent,handler){
  for(let n=0;n<8;n++){let handled=false;const claim=await run(f,undefined,async claim=>{
    if(claim.binding.agentId===agent){handled=true;return handler(claim);}return 'Unrelated durable notification processed';});if(handled)return claim;}
  assert.fail(`No queued work for ${agent}`);
}
const tool=async(f,claim,name,input,key=randomUUID())=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
/** New Actions exercise the complete T11 request/revision/author-route contract, including negative HEAD checks. */
async function submitReview(f,claim,input){
  const context=ok(await tool(f,claim,'review_context',{actionId:input.actionId}));
  return tool(f,claim,'submit_review',{expectedVersion:context.workflowVersion,authorAgentId:context.authorAgentId,
    acceptedSourceMessageId:context.acceptedSourceMessageId,acceptedRevision:context.acceptedRevision,resolvedFindingIds:[],...input});
}
const transfer=(taskId,targets=['other-member'],extra={})=>({idempotencyKey:randomUUID(),subject:{kind:'task',taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets,...extra});
const prTransfer=(extra={})=>({idempotencyKey:randomUUID(),subject:{kind:'github_pr',repository:'test/repo',number:16},predicate:'review_delivered',family:'review',successorSlot:'review',targets:['other-member'],...extra});
let head='a'.repeat(40),unavailable=false,authVersion=1,prReads=0;
const prSource={authorize:(scope,repository)=>repository==='test/repo'?{fingerprint:`pr-role:${authVersion}:${scope.agentId}`,githubLogin:scope.agentId,mayAssign:scope.agentId==='api-member'}:null,
  current:async(_scope,s)=>{prReads++;if(unavailable)throw new Error('unavailable');return {repository:s.repository,number:s.number,headSha:head,authorLogin:'external-author',updatedAt:'2026-10-21'};}};
async function race(f,binding,operations){
  const workers=operations.map(()=>{const child=fork(new URL('./fixtures/threadedActionWorker.mjs',import.meta.url),[f.file,String(f.clock())],{
    execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);
    const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const result=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='committed'){child.kill('SIGKILL');resolve(m.answer);}if(m.type==='result')m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.answer);});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const exited=new Promise(resolve=>child.once('exit',resolve));return {child,ready,result,exited};});
  await Promise.all(workers.map(w=>w.ready));workers.forEach((w,i)=>w.child.send({binding,key:randomUUID(),...operations[i]}));
  const results=await Promise.all(workers.map(w=>w.result));await Promise.all(workers.map(w=>w.exited));return results;
}
// The same policy revision is frozen per actor; the predecessor standing need not equal a reviewer's mapping.
try{
  {
    const f=await fixture('platform-task'),other=await fixture('unrelated');let task,action,original;
    original=await run(f,f.user('Create and transfer a real platform task'),async claim=>{
      task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'T10 platform task',acceptanceCriteria:['Publish acceptance result']}));
      assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId).status,'pending');
      assert.throws(()=>f.db.prepare("UPDATE tasks SET acceptance_criteria='[]' WHERE id=?").run(task.taskId),/THREADED_TASK_FACADE_REQUIRED/);
      assert.equal((await tool(f,claim,'transfer_action',transfer(task.taskId,undefined,{predicate:'model_done'}))).code,'THREADED_ACTION_PREDICATE_UNSUPPORTED');
      const legacy=await promisify(execFile)(process.execPath,['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname,
        new URL('./fixtures/threadedTaskLegacyWorker.mjs',import.meta.url).pathname,f.file,task.taskId]);assert.equal(JSON.parse(legacy.stdout).ok,true);
      action=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));
      const duplicate=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));assert.equal(duplicate.admitted,false);assert.equal(duplicate.outcome,'safe_wait');assert.equal(duplicate.actionId,action.actionId);
      assert.equal((await tool(f,claim,'transfer_action',transfer(task.taskId,['other-member','sdk-member'],{expectedGeneration:1}))).code,'THREADED_ACTION_PARALLEL_INTENT_REQUIRED');
      assert.throws(()=>f.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(task.taskId),/THREADED_TASK_FACADE_REQUIRED/);
      return 'Invocation done does not complete its Action';});
    assert.equal(f.db.prepare('SELECT state FROM threaded_actions WHERE id=?').get(action.actionId).state,'active');
    f.reopen();
    const holder=await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'other-member');
      assert.equal(f.runtime.collaboration.cooperation.source(claim.binding).origin,'agent_post');
      assert.equal(f.db.prepare('SELECT a2a_depth FROM threaded_budget_invocations WHERE invocation_id=?').get(claim.binding.invocationId).a2a_depth,1);
      const fence={actionId:action.actionId,expectedGeneration:1};
      assert.equal((await tool(f,claim,'complete_action',{idempotencyKey:'fake',...fence,evidenceId:'model-says-done'})).code,'THREADED_ACTION_TYPED_EVIDENCE_REQUIRED');
      assert.equal((await tool(f,claim,'complete_task',{idempotencyKey:'stale',...fence,expectedTaskVersion:1,result:'done',acceptanceMessageIds:[]})).code,'THREADED_TASK_STATE_VERSION_CONFLICT');
      const message=ok(await tool(f,claim,'post_message',{idempotencyKey:'acceptance',body:'The frozen acceptance result is published.',targets:[]}));
      const done=ok(await tool(f,claim,'complete_task',{idempotencyKey:'task-done',...fence,expectedTaskVersion:2,result:'Acceptance result published',acceptanceMessageIds:[message.message.id]}));
      assert.equal(done.actionCompleted,false);assert.equal(f.db.prepare('SELECT state FROM threaded_actions WHERE id=?').get(action.actionId).state,'active');
      assert.equal((await tool(f,claim,'action_outcome',{idempotencyKey:'late-failure',...fence,outcome:'failed',reason:'cannot overwrite domain completion'})).code,'THREADED_ACTION_DOMAIN_COMPLETION_PENDING');
      const args={idempotencyKey:'action-done',...fence,evidenceId:done.evidenceId};
      const snapshot=()=>['threaded_actions','threaded_action_holders','threaded_action_candidates','threaded_action_evidence','threaded_collaboration_callbacks','threaded_messages','threaded_wakes','threaded_outbox','threaded_tool_receipts']
        .map(t=>[t,f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
      for(const table of ['threaded_action_candidates','threaded_collaboration_callbacks','threaded_messages','threaded_outbox','threaded_tool_receipts']){
        const before=snapshot();f.db.exec(`CREATE TRIGGER fault_t10 BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fault_t10'); END;`);
        await assert.rejects(()=>tool(f,claim,'complete_action',args),/fault_t10/);assert.deepEqual(snapshot(),before);f.db.exec('DROP TRIGGER fault_t10');faults.push({table,rolledBack:true});
      }
      assert.equal(ok(await tool(f,claim,'complete_action',args)).state,'completed');assert.equal(ok(await tool(f,claim,'complete_action',args)).state,'completed');
      return 'Domain result committed';});
    assert.equal(holder.queue.causalRootId,original.queue.causalRootId);
    assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId).status,'completed');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_candidates').get().n,1);
    const view=createThreadedView(f.db,{store:createThreadedStore(f.db),messages:f.runtime.messages}).snapshot(f.thread.ownerId,f.thread.id);
    assert.equal(view.business.actions[0].state,'completed');assert.equal(view.business.actions[0].approvalGateSatisfied,false);
    assert.equal(createThreadedView(other.db,{store:createThreadedStore(other.db),messages:other.runtime.messages}).snapshot(other.thread.ownerId,other.thread.id).business.actions.length,0);
    checks.push('A01/A02: canonical platform tasks, frozen criteria and version, trusted assignee transition, independent typed completion candidate; ordinary final/text/fake evidence cannot complete; idempotency survives SQLite factory rebuild and UI is domain-backed');
  }
  {
    const f=await fixture('two-process-canonical');let task;
    await run(f,f.user('competing canonical claims'),async claim=>{
      task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Canonical claim race',acceptanceCriteria:['result']}));
      const results=await race(f,claim.binding,[0,1].map(()=>({name:'transfer_action',input:transfer(task.taskId,['other-member'],{expectedGeneration:1})})));
      assert.ok(results.every(r=>r.ok));assert.equal(results.filter(r=>r.result.admitted).length,1);assert.equal(results.find(r=>!r.result.admitted).result.outcome,'safe_wait');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_actions').get().n,1);return 'one canonical successor';});
    checks.push('A01/DB01: two actual IPC workers with separate SQLite connections race at one barrier; exactly one canonical single successor is admitted with one generation and durable dispatch');
  }
  {
    const f=await fixture('private-task-provenance');
    await run(f,f.user('Private task stays private',['api-member'],{visibility:'private',audience:['api-member']}),async claim=>{
      const task=ok(await tool(f,claim,'create_task',{idempotencyKey:'private-task',title:'PRIVATE_TASK_T10',acceptanceCriteria:['Private acceptance result']}));
      const source=f.runtime.collaboration.cooperation.source(claim.binding);
      const receipt=JSON.parse(f.db.prepare("SELECT record FROM threaded_tool_receipts WHERE binding_id=? AND name='create_task'").get(claim.binding.id).record);
      assert.ok(receipt.privacySourceIds.includes(source.id));
      assert.ok(f.db.prepare('SELECT 1 FROM threaded_tool_context_exposures WHERE binding_id=? AND message_id=?').get(claim.binding.id,source.id));
      const answer=await tool(f,claim,'transfer_action',transfer(task.taskId));assert.equal(answer.code,'THREADED_ACTION_TARGET_SOURCE_FORBIDDEN');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_actions').get().n,0);assert.equal(f.db.prepare('SELECT status FROM tasks WHERE id=?').get(task.taskId).status,'pending');
      return 'Task creation provenance cannot be widened by a later handoff';});
    checks.push('K09: platform task creation provenance is durable; a private task cannot be assigned outside its authorized source audience, and rejected admission rolls back generation/task assignment/message work together');
  }
  {
    const f=await fixture('task-producer-crash');let task,action;
    await run(f,f.user('recover platform domain truth'),async claim=>{task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Producer crash',acceptanceCriteria:['published result']}));
      action=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));return 'transfer';});
    await run(f,undefined,async claim=>{
      const message=ok(await tool(f,claim,'post_message',{idempotencyKey:'acceptance',body:'Durable acceptance result before producer crash.',targets:[]}));
      const [done]=await race(f,claim.binding,[{name:'complete_task',input:{idempotencyKey:'crash-task',actionId:action.actionId,expectedGeneration:1,
        expectedTaskVersion:2,result:'Durably complete before callback',acceptanceMessageIds:[message.message.id]},crashAfterCommit:true}]);
      assert.equal(done.ok,true);assert.equal(f.db.prepare('SELECT state FROM threaded_actions').get().state,'active');return 'Producer process killed before completion candidate';});
    f.reopen();f.runtime.collaboration.recover();f.runtime.collaboration.recover();
    assert.equal(f.db.prepare('SELECT state FROM threaded_actions').get().state,'completed');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_candidates').get().n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='action_completed'").get().n,1);
    checks.push('A07: real producer subprocess SIGKILL after canonical task transition commit and before candidate/ACK; rebuilt runtime and SQLite resolver recover exactly one candidate, Action completion and callback without a model replay');
  }
  {
    head='a'.repeat(40);const f=await fixture('parallel-responsibility',{actions:{pr:prSource}});let action;
    await run(f,f.user('parallel review responsibilities'),async claim=>{
      assert.equal((await tool(f,claim,'transfer_action',prTransfer({targets:['other-member','sdk-member']}))).code,'THREADED_ACTION_PARALLEL_INTENT_REQUIRED');
      action=ok(await tool(f,claim,'transfer_action',prTransfer({targets:['other-member','sdk-member'],parallelIntent:'Independent security and correctness review'})));return 'parallel admitted';});
    await run(f,undefined,async claim=>{
      const answer=ok(await tool(f,claim,'transfer_action',prTransfer({operation:'return',expectedGeneration:1,targets:['api-member'],parallelIntent:'Independent security and correctness review'})));
      assert.equal(answer.returned,false);assert.equal(answer.generation,1);assert.equal(f.db.prepare('SELECT state FROM threaded_actions').get().state,'active');return 'one parallel holder rejected ownership';});
    await run(f,undefined,async claim=>{
      const review=ok(await submitReview(f,claim,{idempotencyKey:'review',actionId:action.actionId,expectedGeneration:1,reviewedHeadSha:head,verdict:'approved',findings:[],body:'Independent other holder delivery.'}));
      const done=ok(await tool(f,claim,'complete_action',{idempotencyKey:'done',actionId:action.actionId,expectedGeneration:1,evidenceId:review.evidenceId}));
      assert.equal(done.state,'replaceable');return 'other parallel holder retained its responsibility';});
    // All holders are terminal but one rejected ownership: never leave an active lease with no eligible holder.
    f.runtime.collaboration.recover();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_generations').get().n,1);
    checks.push('Parallel review: explicit intent is mandatory, one rejection cannot transfer other holders to a predecessor, and one successful review does not complete a failed parallel responsibility');
  }
  {
    head='a'.repeat(40);const f=await fixture('two-process-complete-return',{actions:{pr:prSource}});let action;
    await run(f,f.user('completion versus return'),async claim=>{action=ok(await tool(f,claim,'transfer_action',prTransfer()));return 'assigned';});
    await run(f,undefined,async claim=>{
      const review=ok(await submitReview(f,claim,{idempotencyKey:'review',actionId:action.actionId,expectedGeneration:1,reviewedHeadSha:head,verdict:'approved',findings:[],body:'Current independent holder published the complete accepted-source review.'}));
      const results=await race(f,claim.binding,[{name:'complete_action',input:{idempotencyKey:'complete-race',actionId:action.actionId,expectedGeneration:1,evidenceId:review.evidenceId}},
        {name:'transfer_action',input:prTransfer({operation:'return',expectedGeneration:1,targets:['api-member']})}]);
      assert.equal(results.filter(r=>r.ok).length,1);
      const state=f.db.prepare('SELECT generation,state FROM threaded_actions').get();assert.ok((state.generation===1&&state.state==='completed')||(state.generation===2&&state.state==='active'));
      const rejected=results.find(r=>!r.ok);assert.ok(['THREADED_ACTION_STALE_GENERATION','THREADED_ACTION_ALREADY_COMPLETED','THREADED_ACTION_REPLACEMENT_PROOF_REQUIRED'].includes(rejected.code));
      return 'CAS race settled once';});
    checks.push('A03: actual two-process completion versus exact-predecessor return commits one winner after a full independent review; stale generation cannot complete or return a successor and immutable history remains. Proven returned/failed-holder replacement is separately checked below; the original author cannot self-review a returned responsibility');
  }
  {
    const f=await fixture('replacement-and-return');let task,action;
    await run(f,f.user('replace and return'),async claim=>{task=ok(await tool(f,claim,'create_task',{idempotencyKey:'create',title:'race',acceptanceCriteria:['evidence']}));
      action=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));
      assert.equal((await tool(f,claim,'transfer_action',transfer(task.taskId,['sdk-member'],{operation:'replace',expectedGeneration:1}))).code,'THREADED_ACTION_REPLACEMENT_PROOF_REQUIRED');
      return 'active responsibility cannot be stolen';});
    await run(f,undefined,async claim=>{assert.equal(claim.binding.agentId,'other-member');
      ok(await tool(f,claim,'action_outcome',{idempotencyKey:'failed',actionId:action.actionId,expectedGeneration:1,outcome:'failed',reason:'cannot execute'}));return 'failed holder';});
    await run(f,undefined,async claim=>{assert.equal(claim.binding.agentId,'api-member');
      const replacement=ok(await tool(f,claim,'transfer_action',transfer(task.taskId,['sdk-member'],{operation:'replace',expectedGeneration:1})));
      assert.equal(replacement.generation,2);return 'proven failed holder replaced';});
    await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'sdk-member');assert.equal(f.runtime.collaboration.actions.capture(claim.binding).generation,2);
      assert.equal((await tool(f,claim,'complete_action',{idempotencyKey:'late',actionId:action.actionId,expectedGeneration:1,evidenceId:'late'})).code,'THREADED_ACTION_STALE_GENERATION');
      const returned=ok(await tool(f,claim,'transfer_action',transfer(task.taskId,['api-member'],{operation:'return',expectedGeneration:2,parallelIntent:'retain original return intent'})));
      assert.equal(returned.generation,3);assert.deepEqual(returned.holders,['api-member']);
      assert.equal((await tool(f,claim,'hold_ball',{idempotencyKey:'late-wait',jobKey:'late',seconds:5,waitSourceRef:'late'})).code,'THREADED_ACTION_STALE_GENERATION');
      return 'responsibility returned';});
    const back=await run(f,undefined,async claim=>{assert.equal(claim.binding.agentId,'api-member');return 'Returned responsibility remains active';});
    assert.equal(f.runtime.collaboration.actions.capture(back.binding).generation,3);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_generations').get().n,3);

    assert.equal(f.db.prepare('SELECT COUNT(DISTINCT root_id) n FROM threaded_actions').get().n,1);
    checks.push('A03/B01: replacement CAS requires a proven failed/returned holder, stale effects reject, exact predecessor return creates one holder even with retained parallel intent; generation history and original root survive');
  }
  {
    const f=await fixture('a2a-without-standing');let action;
    await run(f,f.user('ordinary A2A remains independent'),async claim=>{const task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'A2A authority',acceptanceCriteria:['result']}));
      action=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));return 'assigned';});
    await run(f,undefined,async claim=>{
      ok(await tool(f,claim,'conversation_decision',{idempotencyKey:'clarify',jobKey:'clarify',question:'Clarify the acceptance criterion?',once:true,block:'interactive'}));
      ok(await tool(f,claim,'post_message',{idempotencyKey:'help',body:'Can you clarify the acceptance criterion?',targets:['api-member']}));return 'asking for help does not transfer my responsibility';});
    await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'api-member');assert.equal(f.runtime.collaboration.actions.capture(claim.binding),null);
      assert.equal(ok(await tool(f,claim,'read_action',{actionId:action.actionId})).state,'active');
      assert.equal((await tool(f,claim,'complete_action',{idempotencyKey:'no-standing',actionId:action.actionId,expectedGeneration:1,evidenceId:'done'})).code,'THREADED_ACTION_STALE_GENERATION');
      return 'Ordinary peer assistance grants no business standing';});
    checks.push('K01/K04: ordinary addressed A2A from an Action holder can wake a peer under the same root, but it grants no Action standing and cannot complete or silently transfer responsibility');
  }
  {
    head='a'.repeat(40);const f=await fixture('review-domain',{actions:{pr:prSource}});let action;
    await run(f,f.user('independent review'),async claim=>{action=ok(await tool(f,claim,'transfer_action',prTransfer()));return 'review assigned';});
    await run(f,undefined,async claim=>{
      const args={actionId:action.actionId,expectedGeneration:1};
      assert.equal((await tool(f,claim,'run_command',{idempotencyKey:'unregistered',...args,command:'arbitrary-shell',args:{job:'safe'}})).code,'THREADED_COMMAND_NOT_AUTHORIZED');
      assert.equal((await tool(f,claim,'multi_mention',{idempotencyKey:'forbidden',targets:['api-member'],question:'review',callbackTo:'other-member',overrideReason:'action review',action:{family:'review'}})).ok,false);
      assert.equal((await tool(f,claim,'publish_action_review',{idempotencyKey:'legacy-first-bypass',...args,reviewedHeadSha:head,verdict:'approved',findings:[],body:'A newly admitted Action cannot bypass the complete review contract.'})).code,'THREADED_REVIEW_FULL_CONTRACT_REQUIRED');
      const review=ok(await submitReview(f,claim,{idempotencyKey:'review',...args,reviewedHeadSha:head,verdict:'changes_requested',findings:['Missing test'],body:'Please add the missing test.'}));
      assert.equal(review.approvalGateSatisfied,false);
      const done=ok(await tool(f,claim,'complete_action',{idempotencyKey:'review-done',...args,evidenceId:review.evidenceId}));assert.equal(done.state,'completed');assert.equal(done.approvalGateSatisfied,false);return 'review delivered';});
    head='b'.repeat(40);await f.runtime.collaboration.actions.refreshFreshness();
    assert.equal(f.runtime.collaboration.actions.snapshot(f.thread.ownerId,f.thread.id)[0].freshnessStatus,'stale');
    await run(f,undefined,async claim=>{assert.equal(claim.binding.agentId,'api-member');
      assert.equal((await tool(f,claim,'transfer_action',prTransfer({operation:'revision',expectedGeneration:1}))).code,'THREADED_REVIEW_REVISION_RESPONSES_REQUIRED');
      const context=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));
      const revision=ok(await tool(f,claim,'start_review_revision',{idempotencyKey:'t11-legacy-revision',actionId:action.actionId,expectedGeneration:1,expectedVersion:context.workflowVersion,targets:['other-member'],
        responses:context.findings.map(finding=>({findingId:finding.id,body:'Missing test addressed for the new HEAD.',disposition:'addressed'}))}));
      assert.equal(revision.generation,2);return 'new HEAD needs new independent review';});
    await runFor(f,'other-member',async claim=>{const args={actionId:action.actionId,expectedGeneration:2};
      assert.equal((await submitReview(f,claim,{idempotencyKey:'old-head',...args,reviewedHeadSha:'a'.repeat(40),verdict:'approved',findings:[],body:'old report'})).code,'THREADED_REVIEW_STALE_HEAD');
      const context=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));
      const review=ok(await tool(f,claim,'submit_review',{idempotencyKey:'new-review',...args,expectedVersion:context.workflowVersion,authorAgentId:context.authorAgentId,acceptedSourceMessageId:context.acceptedSourceMessageId,acceptedRevision:context.acceptedRevision,
        reviewedHeadSha:head,verdict:'approved',findings:[],resolvedFindingIds:context.findings.map(f=>f.id),body:'New HEAD independently reviewed.'}));
      head='c'.repeat(40);
      assert.equal((await tool(f,claim,'complete_action',{idempotencyKey:'head-race',...args,evidenceId:review.evidenceId})).code,'THREADED_REVIEW_STALE_HEAD');return 'HEAD changed during completion';});
    unavailable=true;await f.runtime.collaboration.actions.refreshFreshness();unavailable=false;
    assert.equal(f.runtime.collaboration.actions.snapshot(f.thread.ownerId,f.thread.id)[0].freshnessStatus,'unverifiable');
    checks.push('A04/A05/A06: authenticated independent local published review yields typed evidence; changes_requested completes only review responsibility, new HEAD invalidates old approved evidence, revision needs fresh review and unreachable source is explicitly unverifiable (injected transport)');
  }
  {
    head='a'.repeat(40);const source={...prSource,authorize(scope,repo){const a=prSource.authorize(scope,repo);return a?{...a,githubLogin:scope.agentId==='api-member'?'external-author':a.githubLogin}:null;}};
    const f=await fixture('author-receives-return',{actions:{pr:source}});let action;
    await run(f,f.user('author asks an independent reviewer'),async claim=>{action=ok(await tool(f,claim,'transfer_action',prTransfer()));return 'assigned';});
    await run(f,undefined,async claim=>{
      head='b'.repeat(40);const returned=ok(await tool(f,claim,'transfer_action',prTransfer({operation:'return',expectedGeneration:1,targets:['api-member'],parallelIntent:'retained single return metadata'})));
      assert.equal(returned.generation,2);return 'author receives exactly the frozen old responsibility';});
    await run(f,undefined,async claim=>{
      const view=ok(await tool(f,claim,'read_action',{actionId:action.actionId}));assert.equal(view.freshness,`head:${'a'.repeat(40)}`);
      assert.equal((await submitReview(f,claim,{idempotencyKey:'self-review',actionId:action.actionId,expectedGeneration:2,reviewedHeadSha:head,verdict:'approved',findings:[],body:'author assertion'})).code,'THREADED_REVIEW_STALE_HEAD');
      const newGeneration=ok(await tool(f,claim,'transfer_action',prTransfer({operation:'replace',expectedGeneration:2})));
      assert.equal(newGeneration.generation,3);return 'new current HEAD goes to a fresh independent reviewer';});
    checks.push('Return semantics: author/predecessor may receive rejected responsibility without gaining independent-review approval; return preserves the original frozen HEAD, and exact returned-holder proof is required to reassign a fresh HEAD');
  }
  {
    let starts=0,cancels=0,observation={state:'running',evidenceRef:'running:1'};
    const port={authorization:()=> 'registered-command-v1',validate:args=>assert.deepEqual(args,{job:'safe'}),start:async()=>{starts++;return observation;},observe:async()=>observation,cancel:async()=>{cancels++;return {state:'unknown',evidenceRef:'cancel-unconfirmed'};}};
    const f=await fixture('command-generation',{actions:{commands:{registered:port}}});let task,action,command;
    await run(f,f.user('command wait'),async claim=>{task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'command task',acceptanceCriteria:['result']}));action=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));return 'transfer';});
    await run(f,undefined,async claim=>{
      const args={actionId:action.actionId,expectedGeneration:1};
      command=ok(await tool(f,claim,'run_command',{idempotencyKey:'cmd',...args,command:'registered',args:{job:'safe'}}));
      ok(await tool(f,claim,'run_command',{idempotencyKey:'cmd',...args,command:'registered',args:{job:'safe'}}));assert.equal(starts,1);
      ok(await tool(f,claim,'wait_command',{idempotencyKey:'wait',...args,commandId:command.commandId}));
      const cancel=ok(await tool(f,claim,'cancel_command',{idempotencyKey:'cancel',...args,commandId:command.commandId}));assert.equal(cancel.state,'unknown');
      ok(await tool(f,claim,'hold_ball',{idempotencyKey:'timer',jobKey:'timer',seconds:5,waitSourceRef:'not completion'}));
      ok(await tool(f,claim,'transfer_action',transfer(task.taskId,['api-member'],{operation:'return',expectedGeneration:1})));
      assert.equal((await tool(f,claim,'cancel_command',{idempotencyKey:'late-cancel',...args,commandId:command.commandId})).code,'THREADED_ACTION_STALE_GENERATION');
      return 'returned, external command unresolved';});
    f.reopen();
    const unknownView=createThreadedView(f.db,{store:createThreadedStore(f.db),messages:f.runtime.messages}).snapshot(f.thread.ownerId,f.thread.id);
    assert.equal(unknownView.business.actions[0].commands[0].state,'unknown');assert.equal(unknownView.business.actions[0].commands[0].generation,1);
    observation={state:'completed',evidenceRef:'registered-result:1',result:'old generation result'};
    await f.runtime.collaboration.commands.recover();f.advance(6000);f.runtime.collaboration.recover();
    assert.equal(starts,1);assert.equal(cancels,1);assert.equal(f.db.prepare('SELECT state FROM threaded_commands WHERE id=?').get(command.commandId).state,'completed');
    assert.equal(f.db.prepare('SELECT state FROM threaded_command_waits WHERE command_id=?').get(command.commandId).state,'stale');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='command'").get().n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='wait' AND state='rejected' AND reason='THREADED_ACTION_STALE_GENERATION'").get().n,1);
    assert.equal(f.db.prepare('SELECT state FROM threaded_actions WHERE id=?').get(action.actionId).state,'active');
    const projection=createThreadedView(f.db,{store:createThreadedStore(f.db),messages:f.runtime.messages}).snapshot(f.thread.ownerId,f.thread.id);
    assert.ok(projection.business.actions[0].commands.every(c=>!Object.hasOwn(c,'args')&&!Object.hasOwn(c,'result')));
    checks.push('W04/W01: registered command starts once, cancellation unknown stays attached to the old generation, factory rebuild observes without replay; old terminal is audited but cannot wake a new holder or satisfy Action, old timer callback also rejects');
  }
  {
    const f=await fixture('command-idempotency-race');let action;
    f.db.exec('CREATE TABLE fixture_command_starts(id TEXT PRIMARY KEY)');
    await run(f,f.user('command retry race'),async claim=>{const task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Command retry',acceptanceCriteria:['result']}));
      action=ok(await tool(f,claim,'transfer_action',transfer(task.taskId)));return 'assigned';});
    await run(f,undefined,async claim=>{
      const input={idempotencyKey:'same-command',actionId:action.actionId,expectedGeneration:1,command:'registered',args:{job:'safe'}};
      const results=await race(f,claim.binding,[{name:'run_command',input},{name:'run_command',input}]);
      assert.ok(results.every(v=>v.ok));assert.equal(results[0].result.commandId,results[1].result.commandId);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM fixture_command_starts').get().n,1);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_commands').get().n,1);return 'one external command intent';});
    checks.push('K04/W04: two real SQLite worker processes retry one command key at a barrier; both receive the same command ID and the registered external start port executes exactly once');
  }
  const report={ok:true,groups:checks.length,checks,faults,injectedHttpCalls,prReads,realModelCalls:0,externalNetworkCalls:0,
    scope:'real platform task tables/facade and SQLite/runtime; PR and command transport explicitly injected; not real GitHub acceptance'};
  const evidence=path.resolve(process.env.THREADED_ACTIONS_OUTPUT??'docs/reports/evidence/threaded-t10-actions');await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'isolated.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
