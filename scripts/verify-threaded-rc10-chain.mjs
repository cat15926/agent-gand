import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fork} from 'node:child_process';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc10-chain-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const originalFetch=globalThis.fetch;let externalRequests=0;
globalThis.fetch=async()=>{externalRequests++;throw new Error('RC10_EXTERNAL_NETWORK_FORBIDDEN');};
const A='member-a',B='member-b',C='member-c',D='member-d',members=[A,B,C,D];
const fixtures=[],checks=[],workers=[],snapshots=[],toolCalls=[];let injectedRequests=0,prReads=0;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
const tables=['threaded_messages','threaded_wakes','threaded_wake_queue','threaded_invocations','threaded_consultations','threaded_consultation_targets','threaded_consultation_settlements',
  'threaded_collaboration_callbacks','threaded_actions','threaded_action_generations','threaded_action_candidates','threaded_review_workflows','threaded_review_reports',
  'threaded_review_revision_claims','threaded_budget_roots','threaded_budget_versions','threaded_budget_requests','threaded_tool_receipts','threaded_outbox'];
const rows=(f,table)=>f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
function snapshot(f,label){const result={label,clock:f.clock(),injectedRequests,
  tables:Object.fromEntries(tables.map(table=>{const values=rows(f,table);return[table,{count:values.length,sha256:hash(values)}];})),
  causalRoots:[...new Set(rows(f,'threaded_messages').map(r=>r.causal_root_id))],
  callbacks:rows(f,'threaded_collaboration_callbacks').map(({id,kind,source_id,state,message_id,reason})=>({id,kind,source_id,state,message_id,reason})),
  settlements:rows(f,'threaded_consultation_settlements').map(r=>JSON.parse(r.record)),
  actions:rows(f,'threaded_actions'),reviews:rows(f,'threaded_review_workflows').map(r=>JSON.parse(r.record)),
  budget:rows(f,'threaded_budget_roots').map(r=>({root:f.runtime.budget.getRoot(r.id),usage:f.runtime.budget.getUsage(r.id)}))};snapshots.push(result);return result;}
async function fixture(name){let f,clock=Date.now();const pr={head:'a'.repeat(40),authVersions:{},denied:[]};
  const source={authorize(scope,repository){return repository==='rc10/fixture'&&!pr.denied.includes(scope.agentId)?{
    fingerprint:`rc10-pr:${scope.agentId}:${pr.authVersions[scope.agentId]??1}`,githubLogin:scope.agentId,mayAssign:scope.agentId===B}:null;},
    async current(_scope,subject){prReads++;return{repository:subject.repository,number:subject.number,headSha:pr.head,authorLogin:B,updatedAt:'2026-10-27'};}};
  f=await openBackendRuntimeFixture(root,name,{agentIds:members,applicationTools:THREADED_APPLICATION_TOOL_NAMES,now:()=>clock,actions:{pr:source},fetch:async()=>{
    injectedRequests++;if(f.failCurrent)return new Response(JSON.stringify({error:{type:'invalid_request_error',message:'RC10 isolated target failure'}}),{status:400,headers:{'content-type':'application/json'}});
    try{return response(await(f.handler?.(f.activeClaim)??'UNRELATED_DURABLE_NOTIFICATION'));}catch(error){f.handlerError=error;throw error;}}});
  f.pr=pr;f.clock=()=>clock;f.advance=ms=>clock+=ms;fixtures.push(f);return f;
}
const tool=async(f,claim,name,input,key=randomUUID())=>{const value=JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));
  toolCalls.push({name,input,result:value,agentId:claim.binding.agentId,threadId:claim.binding.threadId,invocationId:claim.binding.invocationId,rootId:claim.queue.causalRootId});return value;};
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
async function run(f,receipt,handler,{failed=false}={}){if(receipt)for(const wake of receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
  f.runtime.queue.scanPending();const claim=f.runtime.queue.claimNext('rc10-chain');assert.ok(claim,'expected queued claim');f.activeClaim=claim;f.handler=handler;f.handlerError=null;f.failCurrent=failed;
  try{const result=await f.runtime.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(result.status,failed?'failed':'completed',JSON.stringify(result));return claim;}
  finally{f.handler=undefined;f.failCurrent=false;}}
async function runFor(f,agentId,threadId,handler){for(let i=0;i<12;i++){let found=false;const claim=await run(f,undefined,async claim=>{
    if(claim.binding.agentId===agentId&&claim.binding.threadId===threadId){found=true;return handler(claim);}return 'ACKNOWLEDGED_DURABLE_NOTIFICATION_WITHOUT_NEW_WORK';});if(found)return claim;}assert.fail(`No claim for ${agentId}/${threadId}`);}
const transfer=(extra={})=>({idempotencyKey:randomUUID(),subject:{kind:'github_pr',repository:'rc10/fixture',number:10},predicate:'review_delivered',family:'review',successorSlot:'review',targets:[A],...extra});
const reviewInput=(context,extra={})=>({idempotencyKey:randomUUID(),actionId:context.actionId,expectedGeneration:context.generation,expectedVersion:context.workflowVersion,
  authorAgentId:context.authorAgentId,acceptedSourceMessageId:context.acceptedSourceMessageId,acceptedRevision:context.acceptedRevision,reviewedHeadSha:context.headSha,
  verdict:'changes_requested',findings:['The timeout result must remain explicit in the summary.'],resolvedFindingIds:[],body:'Independent review requests exact failed/timeout status and original C answer.',...extra});
async function recoverInProcess(f,crashAfterCommit=false){const child=fork(new URL('./fixtures/threadedRc10ChainWorker.mjs',import.meta.url),[],{
  execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],env:{...process.env,RC10_CHAIN_ROOT:root},stdio:['ignore','ignore','pipe','ipc']});
  const fact={pid:child.pid,crashAfterCommit,messages:[]};workers.push(fact);let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const done=new Promise((resolve,reject)=>{child.on('message',message=>{fact.messages.push(message);if(message.type==='ready')child.send({go:true});});child.once('error',reject);
    child.once('exit',(code,signal)=>{fact.exit={code,signal};if(code===0||crashAfterCommit&&signal==='SIGKILL')resolve(fact);else reject(new Error(stderr||JSON.stringify(fact)));});});
  child.send({file:f.file,clock:f.clock(),crashAfterCommit});await done;assert.ok(fact.messages.some(m=>m.type==='result'));assert.ok(fact.messages.every(m=>m.networkCalls===0));return fact;
}
function uniqueCallbacks(f){for(const callback of rows(f,'threaded_collaboration_callbacks')){
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind=? AND source_id=?').get(callback.kind,callback.source_id).n,1);
  if(callback.message_id){assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_outbox WHERE source_id=? AND event_type='message.created'").get(callback.message_id).n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_wakes WHERE source_message_id=?').get(callback.message_id).n,1);}
}}
let failure;
try{
  const f=await fixture('composite-two-thread-chain');const store=createThreadedStore(f.db);
  const work=store.createThread({title:'RC10 explicit work thread',members:members.map(agentId=>({agentId,handle:agentId,roleVersion:1,permissionVersion:1}))});
  f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(work.id);
  let sourceRoot,relay,cross,group,action,firstReview,firstContext,revision,finalReview,returned,finalGate,oldWait;
  const origin=f.user('RC10 original request: public relay, independent consultation, local review and return.',[A]);sourceRoot=origin.message.id;
  const initialRoot=f.runtime.budget.ensureRootForMessage(sourceRoot);f.runtime.reviseRoot({ownerId:f.thread.ownerId,rootId:sourceRoot,expectedVersion:initialRoot.version,
    requestId:'rc10-fixture-allowance',reason:'Explicit isolated multi-stage acceptance allowance; no daily policy change',patch:{activityAllowanceMs:10000,maxInvocations:30,maxA2ADepth:20}});
  await run(f,origin,async claim=>{relay=ok(await tool(f,claim,'post_message',{idempotencyKey:'a-public-to-b',body:'B, gather independent evidence and return the reviewed conclusion.',targets:[B],visibility:'public'}));return 'A_PUBLIC_RELAY_FINAL';});
  await runFor(f,B,f.thread.id,async claim=>{cross=ok(await tool(f,claim,'cross_post_message',{idempotencyKey:'b-to-work-thread',threadId:work.id,body:'Continue the same responsibility in the explicit work Thread.',targets:[B]}));return 'B_CROSS_THREAD_FINAL';});
  await runFor(f,B,work.id,async claim=>{group=ok(await tool(f,claim,'multi_mention',{idempotencyKey:'b-consult-c-d',targets:[C,D],question:'State your independent original conclusion.',callbackTo:B,timeoutMinutes:3,overrideReason:'RC10 isolated composite chain'}));return 'B_REGISTERED_NONBLOCKING_CONSULTATION';});
  assert.equal(relay.message.visibility,'public');assert.equal(cross.message.threadId,work.id);assert.equal(cross.message.causalRootId,sourceRoot);
  checks.push({id:'RC10-CHAIN01',passed:true,scope:'Production factory/broker with injected API; public A to B then explicit cross-Thread B self handoff',sourceRoot,originalThreadId:f.thread.id,workThreadId:work.id,relayMessageId:relay.message.id,crossMessageId:cross.message.id});
  f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:work.id,agentId:D},action:'pause',requestId:'pause-d-before-request'});
  f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:work.id,agentId:B},action:'pause',requestId:'pause-b-before-callback'});
  await runFor(f,C,work.id,async claim=>{const denial=await tool(f,claim,'multi_mention',{idempotencyKey:'c-must-not-cascade',targets:[A],question:'Unnecessary downstream work',callbackTo:C,overrideReason:'test'});
    assert.equal(denial.code,'THREADED_CONSULTATION_CASCADE_DENIED');return 'C_ORIGINAL_DISAGREEMENT: preserve the unresolved D result.';});
  assert.equal(rows(f,'threaded_consultation_settlements').length,0);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_invocations WHERE status='running'").get().n,0);
  const beforeRestart=injectedRequests;f.advance(180001);f.close();const crashed=await recoverInProcess(f,true);f.reopen();
  let settlement=JSON.parse(rows(f,'threaded_consultation_settlements')[0].record),callback=rows(f,'threaded_collaboration_callbacks')[0];
  assert.equal(settlement.kind,'partial');assert.equal(settlement.responses.find(r=>r.agentId===C).body,'C_ORIGINAL_DISAGREEMENT: preserve the unresolved D result.');
  assert.equal(settlement.responses.find(r=>r.agentId===D).status,'timeout');assert.equal(callback.state,'waiting');assert.equal(injectedRequests,beforeRestart);
  const settlementHash=hash(rows(f,'threaded_consultation_settlements'));const restarted=await recoverInProcess(f);assert.equal(hash(rows(f,'threaded_consultation_settlements')),settlementHash);
  f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:work.id,agentId:B},action:'resume',requestId:'resume-b-after-process-recovery'});
  await new Promise(resolve=>setTimeout(resolve,10));callback=rows(f,'threaded_collaboration_callbacks')[0];assert.equal(callback.state,'delivered');
  f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:work.id,agentId:D},action:'resume',requestId:'resume-d-after-expiry'});
  f.runtime.queue.scanPending();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_invocations WHERE agent_id=?').get(D).n,0);uniqueCallbacks(f);snapshot(f,'Recovered original partial settlement, one callback, expired target never invoked');
  checks.push({id:'RC10-CHAIN02',passed:true,scope:'Controlled deadline of paused unsent D; actual recovery worker SIGKILL after commit and a second PID; no in-flight provider timeout',crashedPid:crashed.pid,recoveredPid:restarted.pid,settlementHash,originalAnswer: settlement.responses.find(r=>r.agentId===C).body,callbackId:callback.id,providerReplay:0});
  await runFor(f,B,work.id,async claim=>{action=ok(await tool(f,claim,'transfer_action',transfer({idempotencyKey:'one-canonical-review'})));const duplicate=ok(await tool(f,claim,'transfer_action',transfer({idempotencyKey:'same-subject-safe-wait'})));
    assert.equal(duplicate.actionId,action.actionId);assert.equal(duplicate.admitted,false);return 'B_ASSIGNED_INDEPENDENT_REVIEW';});
  await runFor(f,A,work.id,async claim=>{firstContext=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));firstReview=ok(await tool(f,claim,'submit_review',reviewInput(firstContext,{idempotencyKey:'first-changes-request'})));
    oldWait=ok(await tool(f,claim,'hold_ball',{idempotencyKey:'first-generation-wait',jobKey:'review-status-refresh',seconds:5,
      waitSourceRef:{kind:'thread_message',value:f.runtime.collaboration.cooperation.source(claim.binding).id,expectedSignal:'review_revision_published',slaUntilMs:f.clock()+60000}}));
    const done=ok(await tool(f,claim,'complete_action',{idempotencyKey:'first-responsibility-complete',actionId:action.actionId,expectedGeneration:1,evidenceId:firstReview.evidenceId}));assert.equal(done.state,'completed');
    const gate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:1}));assert.equal(gate.status,'blocked');assert.equal(gate.approvalGateSatisfied,false);return 'A_INDEPENDENT_CHANGES_REQUESTED';});
  snapshot(f,'Review delivery completes responsibility while approval remains blocked');
  checks.push({id:'RC10-CHAIN03',passed:true,actionId:action.actionId,canonicalActions:rows(f,'threaded_actions').length,reviewEvidenceId:firstReview.evidenceId,approvalGateSatisfied:false,source:'Injected exact PR facts and permissions, not GitHub activity'});
  f.pr.head='b'.repeat(40);
  await runFor(f,B,work.id,async claim=>{assert.equal(f.runtime.collaboration.actions.capture(claim.binding),null);
    const input={idempotencyKey:'new-head-revision',actionId:action.actionId,expectedGeneration:1,expectedVersion:1,targets:[A],responses:firstReview.findingIds.map(findingId=>({findingId,body:'Summary retains exact original C answer and D timeout.',disposition:'addressed'}))};
    const before=Object.fromEntries(['threaded_actions','threaded_action_generations','threaded_review_revision_claims','threaded_messages','threaded_tool_receipts'].map(t=>[t,hash(rows(f,t))]));
    f.db.exec("CREATE TRIGGER rc10_revision_outbox_fault BEFORE INSERT ON threaded_outbox BEGIN SELECT RAISE(ABORT,'rc10_revision_outbox_fault'); END;");
    await assert.rejects(()=>tool(f,claim,'start_review_revision',input),/rc10_revision_outbox_fault/);f.db.exec('DROP TRIGGER rc10_revision_outbox_fault');
    assert.deepEqual(Object.fromEntries(Object.keys(before).map(t=>[t,hash(rows(f,t))])),before);
    revision=ok(await tool(f,claim,'start_review_revision',input));assert.equal(revision.generation,2);assert.equal(revision.verification,'attested');assert.equal(revision.approvalGateSatisfied,false);
    assert.equal(ok(await tool(f,claim,'start_review_revision',input)).claimId,revision.claimId);return 'B_ATTESTS_REVISION_NOT_VERIFICATION';});
  f.advance(5001);f.runtime.collaboration.cooperation.recover();
  const oldCallback=f.db.prepare('SELECT * FROM threaded_collaboration_callbacks WHERE kind=? AND source_id=?').get('wait',oldWait.waitId);
  assert.equal(oldCallback.state,'rejected');assert.equal(oldCallback.reason,'THREADED_ACTION_STALE_GENERATION');assert.equal(oldCallback.message_id,null);
  const callbackCounts=hash(rows(f,'threaded_collaboration_callbacks'));f.runtime.collaboration.cooperation.recover();f.runtime.collaboration.cooperation.recover();assert.equal(hash(rows(f,'threaded_collaboration_callbacks')),callbackCounts);
  await runFor(f,A,work.id,async claim=>{const context=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(context.generation,2);
    const stale=await tool(f,claim,'submit_review',reviewInput(firstContext,{idempotencyKey:'old-context-late-result'}));assert.equal(stale.ok,false);assert.match(stale.code,/VERSION_CONFLICT|STALE_GENERATION/);
    const before=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:2}));assert.equal(before.approvalGateSatisfied,false);assert.ok(before.reasons.includes('FINDINGS_NOT_INDEPENDENTLY_VERIFIED'));
    finalReview=ok(await tool(f,claim,'submit_review',reviewInput(context,{idempotencyKey:'fresh-independent-approval',verdict:'approved',findings:[],resolvedFindingIds:firstReview.findingIds,body:'Independent local fixture review verified exact original evidence and timeout disclosure.'})));
    const stillBlocked=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3}));assert.ok(stillBlocked.reasons.includes('REVIEW_RESPONSIBILITY_NOT_COMPLETED'));
    ok(await tool(f,claim,'complete_action',{idempotencyKey:'second-responsibility-complete',actionId:action.actionId,expectedGeneration:2,evidenceId:finalReview.evidenceId}));
    finalGate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3}));assert.equal(finalGate.status,'approved');assert.equal(finalGate.externalApprovalGranted,false);
    f.pr.authVersions[A]=2;const revoked=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3}));assert.equal(revoked.status,'unverifiable');assert.ok(revoked.reasons.includes('REVIEWER_AUTHORITY_CHANGED'));
    delete f.pr.authVersions[A];finalGate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3}));assert.equal(finalGate.status,'approved');return 'A_VERIFIED_FRESH_REVISION';});
  assert.equal(rows(f,'threaded_actions').length,1);assert.equal(rows(f,'threaded_action_generations').length,2);assert.equal(rows(f,'threaded_review_revision_claims').length,1);assert.equal(rows(f,'threaded_review_reports').length,2);uniqueCallbacks(f);snapshot(f,'Same canonical Action, rollback then exact retry, old context denied, local fresh gate and changed permission checked');
  checks.push({id:'RC10-CHAIN04',passed:true,actionId:action.actionId,generation:2,revisionClaimId:revision.claimId,oldContextRejected:true,oldCallback:{id:oldCallback.id,state:oldCallback.state,reason:oldCallback.reason,messageId:oldCallback.message_id},outboxFaultRolledBack:true,independentGate:finalGate.status,changedPermissionGate:'unverifiable',externalApprovalGranted:false});
  await runFor(f,B,work.id,async claim=>{returned=ok(await tool(f,claim,'cross_post_message',{idempotencyKey:'b-return-original-thread',threadId:f.thread.id,
    body:'RETURNED_ORIGINAL_THREAD: C_ORIGINAL_DISAGREEMENT: preserve the unresolved D result. D=timeout. Local review resolved the finding; no external approval.',targets:[A]}));return 'B_RETURNED_REVIEWED_RESULT';});
  assert.equal(returned.message.causalRootId,sourceRoot);assert.equal(returned.message.threadId,f.thread.id);
  const budgetBefore=f.runtime.budget.getUsage(sourceRoot),rootBefore=f.runtime.budget.getRoot(sourceRoot),ledgerBefore=hash(rows(f,'threaded_budget_requests')),requestCount=injectedRequests;
  f.runtime.reviseRoot({ownerId:f.thread.ownerId,rootId:sourceRoot,expectedVersion:rootBefore.version,requestId:'rc10-reach-root-invocation-limit',reason:'Explicit acceptance of cumulative same-root invocation cap',patch:{maxInvocations:budgetBefore.invocations}});
  f.runtime.queue.scanPending();assert.equal(f.runtime.queue.claimNext('rc10-budget-check'),null);assert.equal(injectedRequests,requestCount);assert.equal(hash(rows(f,'threaded_budget_requests')),ledgerBefore);
  const returnedQueue=f.db.prepare('SELECT q.* FROM threaded_wake_queue q JOIN threaded_wakes w ON w.id=q.wake_id WHERE w.source_message_id=?').get(returned.message.id);
  assert.equal(returnedQueue.state,'blocked');assert.match(returnedQueue.reason,/BUDGET/);
  const pausedRoot=f.runtime.budget.getRoot(sourceRoot);f.runtime.reviseRoot({ownerId:f.thread.ownerId,rootId:sourceRoot,expectedVersion:pausedRoot.version,requestId:'rc10-owner-budget-raise',reason:'Owner raises this same root after preserving all consumed evidence',patch:{maxInvocations:30}});
  assert.equal(hash(rows(f,'threaded_budget_requests')),ledgerBefore);
  await runFor(f,A,f.thread.id,async claim=>{const duplicate=await tool(f,claim,'transfer_action',transfer({idempotencyKey:'cross-thread-canonical-duplicate'}));assert.equal(duplicate.code,'THREADED_ACTION_CANONICAL_CONFLICT');return 'A_ORIGINAL_THREAD_ACCEPTED_REVIEWED_RETURN';});
  assert.equal(rows(f,'threaded_budget_roots').length,1);assert.ok(rows(f,'threaded_invocations').every(r=>r.causal_root_id===sourceRoot));assert.ok(rows(f,'threaded_messages').every(r=>r.causal_root_id===sourceRoot));
  assert.ok(rows(f,'threaded_action_generations').every(r=>JSON.parse(r.record).rootId===sourceRoot));assert.ok(f.runtime.budget.getUsage(sourceRoot).invocations>budgetBefore.invocations);
  snapshot(f,'Returned original Thread; same cumulative budget blocked before request then Owner CAS resumes without reset');
  checks.push({id:'RC10-CHAIN05',passed:true,sourceRoot,returnedMessageId:returned.message.id,uniqueBudgetRoots:1,budgetBefore,blockedReason:returnedQueue.reason,providerCallsWhileBlocked:0,requestLedgerUnchangedAcrossPolicyRevisions:true,crossThreadCanonicalDuplicateRejected:true});
  // A separate terminal-failure branch complements the full timeout/review chain.
  const failureFixture=await fixture('consultation-failed-target');let failureGroup;
  await run(failureFixture,failureFixture.user('Independent terminal failure branch',[B]),async claim=>{failureGroup=ok(await tool(failureFixture,claim,'multi_mention',{idempotencyKey:'failure-branch',targets:[C,D],question:'Answer independently',callbackTo:B,timeoutMinutes:3,overrideReason:'RC10 isolated failure branch'}));return 'REGISTERED_FAILURE_BRANCH';});
  await runFor(failureFixture,C,failureFixture.thread.id,async()=> 'C_ORIGINAL_FAILURE_BRANCH_ANSWER');
  const failedClaim=await run(failureFixture,undefined,undefined,{failed:true});assert.equal(failedClaim.binding.agentId,D);
  const failedSettlement=JSON.parse(rows(failureFixture,'threaded_consultation_settlements')[0].record);assert.equal(failedSettlement.kind,'partial');assert.equal(failedSettlement.responses.find(r=>r.agentId===D).status,'failed');
  assert.equal(failedSettlement.responses.find(r=>r.agentId===C).body,'C_ORIGINAL_FAILURE_BRANCH_ANSWER');uniqueCallbacks(failureFixture);snapshot(failureFixture,'Complementary injected HTTP400 failure retains original peer reply');
  checks.push({id:'RC10-CHAIN06',passed:true,scope:'Separate sibling fixture, not part of the completed two-Thread chain',groupId:failureGroup.groupId,failedTarget:D,successfulOriginalBody:failedSettlement.responses.find(r=>r.agentId===C).body});
  const aclFixture=await fixture('old-paused-callback-authority');let aclGroup;
  await run(aclFixture,aclFixture.user('Old callback authority must remain frozen',[B]),async claim=>{aclGroup=ok(await tool(aclFixture,claim,'multi_mention',{idempotencyKey:'acl-group',targets:[C],question:'Independent answer',callbackTo:B,timeoutMinutes:3,overrideReason:'RC10 callback authority fixture'}));return 'REGISTERED_AUTHORITY_BRANCH';});
  aclFixture.runtime.lifecycle.requestControl({ownerId:aclFixture.thread.ownerId,scope:{kind:'member',threadId:aclFixture.thread.id,agentId:B},action:'pause',requestId:'pause-b-old-callback'});
  await runFor(aclFixture,C,aclFixture.thread.id,async()=> 'C_ORIGINAL_AUTHORITY_BRANCH_ANSWER');assert.equal(rows(aclFixture,'threaded_collaboration_callbacks')[0].state,'waiting');
  const preservedSettlement=hash(rows(aclFixture,'threaded_consultation_settlements')),beforeAcl=injectedRequests;
  aclFixture.db.prepare('UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id=?').run(aclFixture.thread.id,B);
  aclFixture.runtime.collaboration.cooperation.recover();const rejected=rows(aclFixture,'threaded_collaboration_callbacks')[0];assert.equal(rejected.state,'rejected');assert.equal(rejected.message_id,null);
  aclFixture.db.prepare('UPDATE threaded_members SET permission_version=permission_version-1,version=version+1 WHERE thread_id=? AND agent_id=?').run(aclFixture.thread.id,B);
  aclFixture.runtime.lifecycle.requestControl({ownerId:aclFixture.thread.ownerId,scope:{kind:'member',threadId:aclFixture.thread.id,agentId:B},action:'resume',requestId:'resume-after-restored-permission'});
  aclFixture.runtime.collaboration.cooperation.recover();assert.equal(rows(aclFixture,'threaded_collaboration_callbacks')[0].state,'rejected');assert.equal(hash(rows(aclFixture,'threaded_consultation_settlements')),preservedSettlement);assert.equal(injectedRequests,beforeAcl);
  snapshot(aclFixture,'Old callback rejected on changed identity and never resurrected by permission restoration');
  checks.push({id:'RC10-CHAIN07',passed:true,scope:'Separate sibling fixture; isolated permission version mutation, not a product ACL edit',callbackId:rejected.id,reason:rejected.reason,restoredPermissionDoesNotResurrect:true,providerCallsAfterRevocation:0});
  for(const fixture of fixtures)assert.deepEqual(fixture.db.pragma('foreign_key_check'),[]);assert.equal(externalRequests,0);
}catch(error){failure={message:error.message,stack:error.stack};}
finally{
  for(const fixture of fixtures)fixture.close();globalThis.fetch=originalFetch;
  const report={schemaVersion:1,stage:'RC10',date:'2026-10-27',status:failure?'failed':'passed',checks,checkCount:checks.length,
    scope:{productionEntry:'createThreadedBackendRuntime, real broker/SQLite/queue/budget/actions/reviews/cooperation; API HTTP responses and PR facts injected',actualIndex:false,realSupplier:false,realGitHub:false,dailyData:false,
      actualProcesses:'separate recovery PIDs and SIGKILL after commit; API execution remains parent factory',controlledClock:'paused, unsent target deadline; not native/in-flight provider timeout',reviewEngineeringVerdict:'scripted local workflow fixture, not a real code review or external approval'},
    injectedRequests,externalRequests,prReads,workerCount:workers.length,workers,toolCalls,snapshots,...(failure?{failure}:{})};
  const output=process.env.THREADED_RC10_CHAIN_OUTPUT??path.resolve('docs/reports/evidence/threaded-rc10/chain.json');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  await rm(root,{recursive:true,force:true});console.log(JSON.stringify({status:report.status,checks:checks.length,injectedRequests,workerCount:workers.length,report:output,...(failure?{failure:failure.message}:{})}));
}
if(failure)process.exitCode=1;
