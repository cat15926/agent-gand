import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t11-reviews-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {createThreadedView}=await import('../apps/server/src/threaded/view.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const fixtures=[],checks=[],faults=[];let injectedHttpCalls=0,prReads=0;
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
async function fixture(name){let f;let clock=Date.now();const pr={head:'a'.repeat(40),unavailable:false,denied:[],authVersions:{},authorLogin:'api-member'};
  const source={authorize(scope,repository){return repository==='test/repo'&&!pr.denied.includes(scope.agentId)?{fingerprint:`pr-role:${pr.authVersions[scope.agentId]??1}:${scope.agentId}`,
    githubLogin:scope.agentId,mayAssign:scope.agentId==='api-member'}:null;},async current(_scope,s){prReads++;if(pr.unavailable)throw new Error('injected PR unavailable');
    return {repository:s.repository,number:s.number,headSha:pr.head,authorLogin:pr.authorLogin,updatedAt:'2026-10-21'};}};
  f=await openBackendRuntimeFixture(root,name,{now:()=>clock,applicationTools:THREADED_APPLICATION_TOOL_NAMES,actions:{pr:source},fetch:async()=>{
    injectedHttpCalls++;try{return response(await(f.handler?.(f.activeClaim)??'done'));}catch(error){f.handlerError=error;throw error;}}});
  for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}f.pr=pr;f.clock=()=>clock;f.advance=ms=>clock+=ms;fixtures.push(f);return f;
}
async function run(f,receipt,handler){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
  const claim=f.runtime.queue.claimNext('t11-review');assert.ok(claim,'claim expected');f.activeClaim=claim;f.handler=handler;f.handlerError=undefined;
  const result=await f.runtime.executeClaim(claim);f.handler=undefined;if(f.handlerError)throw f.handlerError;
  assert.equal(result.status,'completed',JSON.stringify(result));return claim;
}
async function runFor(f,agent,handler,receipt){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
  for(let i=0;i<8;i++){let handled=false;const claim=await run(f,undefined,async claim=>{if(claim.binding.agentId===agent){handled=true;return handler(claim);}return 'Unrelated durable notification processed';});
    if(handled)return claim;}assert.fail(`No queued work for ${agent}`);
}
const tool=async(f,claim,name,input,key=randomUUID())=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
const rejectCode=(value,code)=>{assert.equal(value.ok,false,JSON.stringify(value));assert.equal(value.code,code,JSON.stringify(value));};
const prTransfer=(extra={})=>({idempotencyKey:randomUUID(),subject:{kind:'github_pr',repository:'test/repo',number:16},predicate:'review_delivered',family:'review',successorSlot:'review',targets:['other-member'],...extra});
const reviewInput=(ctx,extra={})=>({idempotencyKey:randomUUID(),actionId:ctx.actionId,expectedGeneration:ctx.generation,expectedVersion:ctx.workflowVersion,
  authorAgentId:ctx.authorAgentId,acceptedSourceMessageId:ctx.acceptedSourceMessageId,acceptedRevision:ctx.acceptedRevision,reviewedHeadSha:ctx.headSha,
  verdict:'changes_requested',findings:['Cover the missing edge case'],resolvedFindingIds:[],body:'Independent review requests a regression test.',...extra});
const state=(f,id)=>JSON.parse(f.db.prepare('SELECT record FROM threaded_review_workflows WHERE action_id=?').get(id).record);
const ownerView=(f,blocked=[])=>createThreadedView(f.db,{store:createThreadedStore(f.db),messages:{getMessage(scope,id){return blocked.includes(id)?null:f.runtime.messages.getMessage(scope,id);}}}).snapshot(f.thread.ownerId,f.thread.id);
const domainSnapshot=f=>['threaded_actions','threaded_action_generations','threaded_action_holders','threaded_action_evidence','threaded_review_workflows',
  'threaded_review_versions','threaded_review_reports','threaded_review_revision_claims','threaded_messages','threaded_wakes','threaded_outbox','threaded_tool_receipts']
  .map(t=>[t,f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
async function assign(f,extra={}){let action;const author=await runFor(f,'api-member',async claim=>{action=ok(await tool(f,claim,'transfer_action',prTransfer()));return 'Independent review assigned';},f.user('Review the current PR HEAD',['api-member'],extra));return {action,author};}
async function finish(f,claim,action,evidenceId,generation=1){const result=ok(await tool(f,claim,'complete_action',{idempotencyKey:randomUUID(),actionId:action.actionId,expectedGeneration:generation,evidenceId}));assert.equal(result.state,'completed');return result;}
function legacyAdmissionFixture(f,action){
  // Explicit isolated fixture for the generation frozen at v32 -> v33 migration; real migration is covered separately.
  f.db.prepare('INSERT INTO threaded_review_legacy_admissions(action_id,generation) VALUES(?,1)').run(action.actionId);
  assert.throws(()=>f.db.prepare('UPDATE threaded_review_legacy_admissions SET generation=2 WHERE action_id=?').run(action.actionId),/THREADED_REVIEW_FACT_IMMUTABLE/);
  assert.throws(()=>f.db.prepare('DELETE FROM threaded_review_legacy_admissions WHERE action_id=?').run(action.actionId),/THREADED_REVIEW_FACT_RETAINED/);
}
async function race(f,binding,operations){const workers=operations.map(()=>{const child=fork(new URL('./fixtures/threadedReviewWorker.mjs',import.meta.url),[f.file,String(f.clock()),JSON.stringify(f.pr)],{
    execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',d=>stderr+=d);
    const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const result=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='result')m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.answer);});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const exited=new Promise(resolve=>child.once('exit',resolve));return {child,ready,result,exited};});
  await Promise.all(workers.map(w=>w.ready));workers.forEach((w,i)=>w.child.send({binding,key:randomUUID(),...operations[i]}));
  const results=await Promise.all(workers.map(w=>w.result));await Promise.all(workers.map(w=>w.exited));return results;
}
try{
  {
    const f=await fixture('review-revision-gate'),{action,author}=await assign(f);let first,firstCtx,firstVersion;
    await runFor(f,'other-member',async claim=>{firstCtx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(firstCtx.workflowVersion,0);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_legacy_admissions').get().n,0);
      rejectCode(await tool(f,claim,'publish_action_review',{idempotencyKey:'new-action-legacy-tool',actionId:action.actionId,expectedGeneration:1,reviewedHeadSha:f.pr.head,verdict:'approved',findings:[],body:'New actions cannot bypass the full review contract'}),'THREADED_REVIEW_FULL_CONTRACT_REQUIRED');
      const guardBefore=domainSnapshot(f);assert.throws(()=>f.runtime.collaboration.reviews.executeWithin(claim.binding,'submit_review',reviewInput(firstCtx)),error=>error.code==='THREADED_REVIEW_TRANSACTION_REQUIRED');assert.deepEqual(domainSnapshot(f),guardBefore);
      for(const extra of [{acceptedRevision:firstCtx.acceptedRevision+1},{acceptedSourceMessageId:'invented-source'},{authorAgentId:'sdk-member'},{authorAgentId:'other-member'}]){
        const answer=await tool(f,claim,'submit_review',reviewInput(firstCtx,extra));rejectCode(answer,Object.hasOwn(extra,'authorAgentId')?'THREADED_REVIEW_AUTHOR_ROUTE_INVALID':'THREADED_REVIEW_ACCEPTED_SOURCE_MISMATCH');}
      rejectCode(await tool(f,claim,'submit_review',reviewInput(firstCtx,{reviewedHeadSha:'b'.repeat(40)})),'THREADED_REVIEW_STALE_HEAD');
      first=ok(await tool(f,claim,'submit_review',reviewInput(firstCtx,{idempotencyKey:'first-review'})));assert.equal(first.actionCompleted,false);assert.equal(first.approvalGateSatisfied,false);
      const legacy=await tool(f,claim,'publish_action_review',{idempotencyKey:'legacy-review-bypass',actionId:action.actionId,expectedGeneration:1,reviewedHeadSha:f.pr.head,verdict:'approved',findings:[],body:'Cannot bypass the current review workflow'});
      assert.equal(legacy.ok,false,JSON.stringify(legacy));assert.match(legacy.code,/REVIEW/);
      assert.equal(f.db.prepare('SELECT state FROM threaded_actions').get().state,'active');firstVersion=state(f,action.actionId);
      assert.equal(firstVersion.findings[0].state,'open');assert.equal(firstVersion.state,'changes_requested');
      const message=f.runtime.messages.getMessage({ownerId:f.thread.ownerId,threadId:f.thread.id,viewer:{kind:'agent',agentId:'api-member'}},first.messageId);
      assert.deepEqual(message.targets,['api-member']);assert.equal(message.origin,'agent_post');assert.equal(message.causalRootId,author.queue.causalRootId);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_message_fences WHERE message_id=?').get(first.messageId).n,0);
      await finish(f,claim,action,first.evidenceId);
      const gate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:1}));assert.equal(gate.status,'blocked');assert.equal(gate.approvalGateSatisfied,false);
      return 'Published changes request completes responsibility without approval';});
    checks.push('A05/F10: exact accepted-source revision and HEAD, authenticated independent reviewer and one different author A2A route are mandatory; a new Action cannot call the legacy report tool even before a workflow exists, service writes require a transaction, and changes_requested remains separate from typed responsibility completion and approval');
    f.reopen();f.pr.head='b'.repeat(40);let revision;
    const authorRevision=await runFor(f,'api-member',async claim=>{assert.equal(f.runtime.collaboration.actions.capture(claim.binding),null,'Review A2A does not grant business standing');
      const input={idempotencyKey:'revision',actionId:action.actionId,expectedGeneration:1,expectedVersion:1,targets:['other-member'],
        responses:first.findingIds.map(findingId=>({findingId,body:'Added a regression test in the new revision.',disposition:'addressed'}))};
      assert.throws(()=>f.runtime.collaboration.actions.reviewRevisionWithin(claim.binding,prTransfer({operation:'revision',expectedGeneration:1})),error=>error.code==='THREADED_REVIEW_REVISION_INTERNAL_REQUIRED');
      const bypass=await tool(f,claim,'transfer_action',prTransfer({idempotencyKey:'bypass-revision',operation:'revision',expectedGeneration:1}));
      assert.equal(bypass.ok,false,JSON.stringify(bypass));assert.match(bypass.code,/REVIEW/);assert.equal(f.db.prepare('SELECT generation FROM threaded_actions').get().generation,1);
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'missing',responses:[]}),'THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'duplicate',responses:[input.responses[0],input.responses[0]]}),'THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'foreign',responses:[{...input.responses[0],findingId:'other-round:1'}]}),'THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'stale-version',expectedVersion:0}),'THREADED_REVIEW_VERSION_CONFLICT');
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'self-review',targets:['api-member']}),'THREADED_REVIEW_INDEPENDENT_REVIEWER_REQUIRED');
      for(const table of ['threaded_messages','threaded_action_generations','threaded_review_versions','threaded_review_revision_claims','threaded_tool_receipts']){
        const before=domainSnapshot(f);f.db.exec(`CREATE TRIGGER fault_t11_review BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fault_t11_review'); END;`);
        try{await assert.rejects(()=>tool(f,claim,'start_review_revision',input),/fault_t11_review/);assert.deepEqual(domainSnapshot(f),before);}finally{f.db.exec('DROP TRIGGER fault_t11_review');}faults.push({operation:'revision',table,rolledBack:true});}
      revision=ok(await tool(f,claim,'start_review_revision',input));assert.equal(revision.generation,2);assert.equal(revision.verification,'attested');assert.equal(revision.approvalGateSatisfied,false);
      const w=state(f,action.actionId);assert.equal(w.findings[0].state,'attested');assert.equal(w.findings[0].resolutionEvidenceId,null);
      const historical=ok(await tool(f,claim,'read_review_workflow',{actionId:action.actionId,version:1}));assert.equal(historical.findings[0].state,'open');assert.equal(historical.headSha,'a'.repeat(40));
      const projection=ownerView(f).business.reviews[0];assert.equal(projection.version,2);assert.equal(projection.findings[0].state,'attested');assert.equal(projection.lastGate.status,'stale');assert.equal(projection.lastGate.currentApproval,false);
      assert.equal(w.rootId,author.queue.causalRootId);return 'Author only attests a new revision';});
    assert.equal(authorRevision.queue.causalRootId,author.queue.causalRootId);
    checks.push('A06/A07/B01: rebuilt SQLite/runtime preserves immutable old findings; direct Action revision cannot bypass the workflow, fresh revision requires every open finding exactly once, rejects self-review/stale CAS, attests without verifying, and retains the original root; five injected transaction failures roll back generation/report/dispatch/receipt together');
    let finalReview,gateKey='fresh-gate';
    const reviewer=await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(ctx.generation,2);assert.equal(ctx.workflowVersion,2);
      assert.equal(ctx.headSha,'b'.repeat(40));assert.deepEqual(ctx.findings.map(x=>x.id),first.findingIds);
      const attestedGate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:2}));assert.equal(attestedGate.approvalGateSatisfied,false);assert.ok(attestedGate.reasons.includes('FINDINGS_NOT_INDEPENDENTLY_VERIFIED'));
      rejectCode(await tool(f,claim,'submit_review',reviewInput(ctx,{verdict:'approved',findings:[],resolvedFindingIds:['foreign-finding']})),'THREADED_REVIEW_FINDING_REFERENCE_INVALID');
      const input=reviewInput(ctx,{idempotencyKey:'approved-review',verdict:'approved',findings:[],resolvedFindingIds:first.findingIds,body:'New HEAD independently verified; the regression test resolves the finding.'});
      for(const table of ['threaded_review_reports','threaded_review_versions','threaded_outbox','threaded_tool_receipts']){
        const before=domainSnapshot(f);f.db.exec(`CREATE TRIGGER fault_t11_review BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'fault_t11_review'); END;`);
        try{await assert.rejects(()=>tool(f,claim,'submit_review',input),/fault_t11_review/);assert.deepEqual(domainSnapshot(f),before);}finally{f.db.exec('DROP TRIGGER fault_t11_review');}faults.push({operation:'review',table,rolledBack:true});}
      finalReview=ok(await tool(f,claim,'submit_review',input));assert.equal(finalReview.version,3);assert.equal(ok(await tool(f,claim,'submit_review',input)).evidenceId,finalReview.evidenceId);
      assert.equal(state(f,action.actionId).findings[0].state,'verified');
      const before=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3}));assert.equal(before.status,'blocked');assert.ok(before.reasons.includes('REVIEW_RESPONSIBILITY_NOT_COMPLETED'));
      await finish(f,claim,action,finalReview.evidenceId,2);
      const gate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3},gateKey));assert.equal(gate.status,'approved');assert.equal(gate.approvalGateSatisfied,true);assert.equal(gate.externalApprovalGranted,false);
      const beforeRead={reads:prReads,changes:f.db.prepare('SELECT total_changes() n').get().n},view=ownerView(f),projection=view.business.reviews[0];
      assert.equal(projection.version,3);assert.equal(projection.generation,2);assert.equal(projection.headSha,f.pr.head);assert.equal(projection.findings[0].state,'verified');
      assert.deepEqual(projection.reports,[{reviewerId:'other-member',verdict:'approved',messageId:finalReview.messageId,headSha:f.pr.head}]);
      assert.equal(projection.lastGate.status,'approved');assert.equal(projection.lastGate.currentApproval,false);assert.ok(projection.sources.some(s=>s.id===finalReview.messageId));
      assert.deepEqual({reads:prReads,changes:f.db.prepare('SELECT total_changes() n').get().n},beforeRead,'Owner projection is read-only and performs no PR IO');
      const internalKeys=new Set(['authorization','identity','rootId','bindingId','authorityEpoch','authority_epoch','leaseToken','fence','actionFence']);
      const assertPublic=value=>{if(value&&typeof value==='object')for(const [key,v] of Object.entries(value)){assert.ok(!internalKeys.has(key),`Unexpected internal field ${key}`);assertPublic(v);}};assertPublic(projection);
      assert.equal(JSON.stringify(projection).includes('pr-role:'),false);assert.equal(ownerView(f,[first.messageId]).business.reviews.length,0,'Revoked historical report source removes derived workflow and gate');
      f.pr.head='c'.repeat(40);const stale=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3},gateKey));assert.equal(stale.status,'stale');assert.equal(stale.approvalGateSatisfied,false);assert.notEqual(stale.checkId,gate.checkId);
      f.pr.head='b'.repeat(40);f.pr.authVersions['other-member']=2;const changed=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3},gateKey));assert.equal(changed.status,'unverifiable');assert.ok(changed.reasons.includes('REVIEWER_AUTHORITY_CHANGED'));delete f.pr.authVersions['other-member'];
      f.pr.denied=['other-member'];const denied=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3},gateKey));assert.equal(denied.status,'unverifiable');assert.equal(denied.approvalGateSatisfied,false);
      f.pr.denied=[];f.pr.unavailable=true;const unknown=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3},gateKey));assert.equal(unknown.status,'unverifiable');f.pr.unavailable=false;
      assert.equal(ownerView(f).business.reviews[0].lastGate.status,'unverifiable');
      return 'Current live facts are required for every gate check';});
    assert.equal(reviewer.queue.causalRootId,author.queue.causalRootId);assert.equal(f.db.prepare('SELECT COUNT(DISTINCT root_id) n FROM threaded_actions').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_versions').get().n,3);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_reports').get().n,2);
    assert.throws(()=>f.db.prepare("UPDATE threaded_review_versions SET record='{}'").run(),/THREADED_REVIEW_FACT_IMMUTABLE/);
    assert.throws(()=>f.db.prepare('DELETE FROM threaded_review_reports').run(),/THREADED_REVIEW_FACT_RETAINED/);
    checks.push('A04/A06/F10: independent current-HEAD re-review verifies exact original finding IDs, typed completion is required before the local gate can approve, and repeated identical read keys re-read live HEAD/reviewer authority/unavailability rather than replaying a prior approved gate');
    checks.push('UI01/K09: read-only Owner snapshots show exact review versions/findings/reports/source IDs, mark old-generation gates stale and every historical gate currentApproval=false, perform no remote IO or writes, omit execution/authority fingerprints, and filter derived review/gate when a historical source is revoked');
  }
  {
    const f=await fixture('review-private-history'),{action}=await assign(f,{visibility:'private',audience:['api-member','other-member']});let report;
    await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));report=ok(await tool(f,claim,'submit_review',reviewInput(ctx,{body:'PRIVATE_REVIEW_FINDING_T11',findings:['PRIVATE_REVIEW_FINDING_T11']})));
      const receipt=JSON.parse(f.db.prepare("SELECT record FROM threaded_tool_receipts WHERE binding_id=? AND name='submit_review'").get(claim.binding.id).record);assert.ok(receipt.privacySourceIds.includes(report.messageId));
      assert.ok(f.db.prepare('SELECT 1 FROM threaded_tool_context_exposures WHERE binding_id=? AND message_id=?').get(claim.binding.id,report.messageId));await finish(f,claim,action,report.evidenceId);return 'Private review delivery';});
    await runFor(f,'sdk-member',async claim=>{for(const name of ['review_context','read_review_workflow','check_review_gate']){
      const value=await tool(f,claim,name,{actionId:action.actionId,...(name==='read_review_workflow'?{version:1}:name==='check_review_gate'?{expectedVersion:1}:{})});
      assert.equal(value.ok,false,JSON.stringify(value));assert.match(value.code,/SOURCE_FORBIDDEN/);assert.ok(!JSON.stringify(value).includes('PRIVATE_REVIEW_FINDING_T11'));}return 'No unauthorized historical report expansion';},f.user('Try another private collection',['sdk-member']));
    checks.push('K09/MEM02 boundary: review workflow history, exact context and live gate all enforce private accepted/report source ACL; authorized reads register Session exposure, another member cannot expand copied findings or a historical version');
  }
  {
    const f=await fixture('review-two-process-cas'),{action}=await assign(f);
    await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId})),input=reviewInput(ctx);
      const results=await race(f,claim.binding,[{name:'submit_review',input:{...input,idempotencyKey:'race-one'}},{name:'submit_review',input:{...input,idempotencyKey:'race-two'}}]);
      assert.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));rejectCode(results.find(r=>!r.ok),'THREADED_REVIEW_VERSION_CONFLICT');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_reports').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_versions').get().n,1);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_messages WHERE body='Independent review requests a regression test.'").get().n,1);return 'One review transition wins';});
    checks.push('DB01/SOP-style CAS: two real IPC workers and separate SQLite connections race the same review version; exactly one immutable report/version/message and author wake commit');
  }
  {
    const f=await fixture('legacy-review-adoption'),{action,author}=await assign(f,{visibility:'private',audience:['api-member','other-member']});legacyAdmissionFixture(f,action);let legacyIds,legacyMessages,originalEvidence;
    await runFor(f,'other-member',async claim=>{
      const reports=[];for(const [key,verdict,findings] of [['legacy-changes','changes_requested',['Legacy edge case lacks coverage','Legacy private finding']],['legacy-approved','approved',['A second immutable report finding']]]){
        reports.push(ok(await tool(f,claim,'publish_action_review',{idempotencyKey:key,actionId:action.actionId,expectedGeneration:1,reviewedHeadSha:f.pr.head,verdict,findings,body:`PRIVATE_LEGACY_T11:${key}`})));}
      legacyMessages=reports.map(r=>r.messageId);legacyIds=[`${reports[0].evidenceId}:0`,`${reports[0].evidenceId}:1`,`${reports[1].evidenceId}:0`];
      originalEvidence=f.db.prepare("SELECT id,record FROM threaded_action_evidence WHERE action_id=? AND kind='published_review' ORDER BY rowid").all(action.actionId);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_workflows').get().n,0);
      await finish(f,claim,action,reports[1].evidenceId);
      const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(ctx.workflowVersion,0);assert.deepEqual(ctx.findings.map(x=>x.id),legacyIds);assert.ok(ctx.findings.every(x=>x.state==='open'));
      const virtual=ok(await tool(f,claim,'read_review_workflow',{actionId:action.actionId}));assert.deepEqual(virtual.reports,{});assert.equal(virtual.approvalGateSatisfied,false);
      const gate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:0}));assert.equal(gate.status,'blocked');assert.ok(gate.reasons.includes('REQUIRED_REVIEW_NOT_APPROVED'));
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_workflows').get().n,0,'Reading legacy delivery never adopts or approves it');return 'Legacy immutable delivery remains unapproved';});
    f.reopen();f.pr.head='b'.repeat(40);
    const resumed=await runFor(f,'api-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.deepEqual(ctx.findings.map(x=>x.id),legacyIds);
      const bypass=await tool(f,claim,'transfer_action',prTransfer({operation:'revision',expectedGeneration:1}));rejectCode(bypass,'THREADED_REVIEW_REVISION_RESPONSES_REQUIRED');
      const input={idempotencyKey:'adopt-legacy',actionId:action.actionId,expectedGeneration:1,expectedVersion:0,targets:['other-member'],
        responses:legacyIds.map(findingId=>({findingId,body:'Addressed in the fresh revision, awaiting independent verification.',disposition:'addressed'}))};
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'legacy-missing',responses:input.responses.slice(0,2)}),'THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      for(const version of [1,2]){const before=domainSnapshot(f);f.db.exec(`CREATE TRIGGER fault_t11_legacy BEFORE INSERT ON threaded_review_versions WHEN NEW.version=${version} BEGIN SELECT RAISE(ABORT,'fault_t11_legacy'); END;`);
        try{await assert.rejects(()=>tool(f,claim,'start_review_revision',input),/fault_t11_legacy/);assert.deepEqual(domainSnapshot(f),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_workflows').get().n,0);}
        finally{f.db.exec('DROP TRIGGER fault_t11_legacy');}faults.push({operation:'legacy_adoption',table:'threaded_review_versions',version,rolledBack:true});}
      const adopted=ok(await tool(f,claim,'start_review_revision',input));assert.equal(adopted.version,2);assert.equal(adopted.generation,2);assert.equal(adopted.verification,'attested');
      const history=ok(await tool(f,claim,'read_review_workflow',{actionId:action.actionId,version:1}));assert.deepEqual(history.findings.map(f=>f.id),legacyIds);assert.ok(history.findings.every(f=>f.state==='open'));assert.deepEqual(history.reports,{});assert.equal(history.headSha,'a'.repeat(40));
      const current=state(f,action.actionId);assert.equal(current.headSha,'b'.repeat(40));assert.ok(current.findings.every(f=>f.state==='attested'));assert.deepEqual(current.reports,{});
      const filtered=ownerView(f,[legacyMessages[0]]);assert.equal(filtered.business.reviews.length,0,'Adopted legacy report ACL filters derived history and gate');
      assert.deepEqual(f.db.prepare("SELECT id,record FROM threaded_action_evidence WHERE action_id=? AND kind='published_review' ORDER BY rowid").all(action.actionId),originalEvidence);
      return 'Legacy history and fresh round adopted atomically';});assert.equal(resumed.queue.causalRootId,author.queue.causalRootId);
    await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(ctx.workflowVersion,2);assert.deepEqual(ctx.findings.map(f=>f.id),legacyIds);
      const report=ok(await tool(f,claim,'submit_review',reviewInput(ctx,{verdict:'approved',findings:[],resolvedFindingIds:legacyIds,body:'Independently verified every adopted finding against the fresh HEAD.'})));
      await finish(f,claim,action,report.evidenceId,2);const gate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3}));assert.equal(gate.status,'approved');
      const old=ok(await tool(f,claim,'read_review_workflow',{actionId:action.actionId,version:1}));assert.ok(old.findings.every(f=>f.state==='open'));assert.deepEqual(old.reports,{});return 'Fresh independent review establishes the first legitimate new gate';});
    const narrow=await fixture('legacy-private-report-source');narrow.user('PRIVATE_LEGACY_CONTEXT_T11',[],{visibility:'private',audience:['other-member']});const narrowAction=(await assign(narrow)).action;legacyAdmissionFixture(narrow,narrowAction);let privateMessageId;
    await runFor(narrow,'other-member',async claim=>{const report=ok(await tool(narrow,claim,'publish_action_review',{idempotencyKey:'narrow-legacy',actionId:narrowAction.actionId,expectedGeneration:1,
      reviewedHeadSha:narrow.pr.head,verdict:'changes_requested',findings:['PRIVATE_LEGACY_REPORT_FINDING_T11'],body:'PRIVATE_LEGACY_REPORT_FINDING_T11'}));privateMessageId=report.messageId;
      const message=narrow.runtime.messages.getMessage({ownerId:narrow.thread.ownerId,threadId:narrow.thread.id,viewer:{kind:'agent',agentId:'other-member'}},privateMessageId);
      assert.equal(message.visibility,'private');assert.deepEqual(message.audience,['other-member']);await finish(narrow,claim,narrowAction,report.evidenceId);return 'Old report can be narrower than its original public Action';});
    narrow.pr.head='b'.repeat(40);await runFor(narrow,'api-member',async claim=>{assert.equal(narrow.runtime.messages.getMessage({ownerId:narrow.thread.ownerId,threadId:narrow.thread.id,viewer:{kind:'agent',agentId:'api-member'}},privateMessageId),null);
      assert.equal(ok(await tool(narrow,claim,'read_action',{actionId:narrowAction.actionId})).state,'completed','Public Action is still readable');
      for(const name of ['review_context','read_review_workflow','check_review_gate']){const answer=await tool(narrow,claim,name,{actionId:narrowAction.actionId,...(name==='check_review_gate'?{expectedVersion:0}:{})});
        assert.equal(answer.ok,false,JSON.stringify(answer));assert.match(answer.code,/SOURCE_FORBIDDEN/);assert.ok(!JSON.stringify(answer).includes('PRIVATE_LEGACY_REPORT_FINDING_T11'));}
      assert.equal(narrow.db.prepare('SELECT COUNT(*) n FROM threaded_review_workflows').get().n,0);return 'A public Action cannot expose a narrower private legacy report during adoption';});
    checks.push('v32 compatibility: actual legacy tools publish multiple immutable reports and complete their old Action without implicitly approving; all legacy finding IDs and private sources survive virtual reads and atomic history/fresh-round adoption, direct revision/missing replies reject, either version-1 or version-2 write failure rolls back all adoption, and only fresh independent resolved-ID review plus typed completion can approve');
  }
  {
    const f=await fixture('parallel-failure-fresh-replacement');let action,findingIds,original;
    original=await runFor(f,'api-member',async claim=>{action=ok(await tool(f,claim,'transfer_action',prTransfer({targets:['other-member','sdk-member'],parallelIntent:'Independent security and correctness review'})));return 'Parallel review assigned';},f.user('Review the current HEAD independently'));
    await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId})),r=ok(await tool(f,claim,'submit_review',reviewInput(ctx)));
      findingIds=r.findingIds;const done=ok(await tool(f,claim,'complete_action',{idempotencyKey:'one-delivered',actionId:action.actionId,expectedGeneration:1,evidenceId:r.evidenceId}));assert.equal(done.state,'active');return 'One parallel review delivered findings';});
    await runFor(f,'sdk-member',async claim=>{ok(await tool(f,claim,'action_outcome',{idempotencyKey:'reviewer-failed',actionId:action.actionId,expectedGeneration:1,outcome:'failed',reason:'Cannot finish this review'}));return 'Other parallel reviewer failed';});
    assert.equal(f.db.prepare('SELECT state FROM threaded_actions').get().state,'replaceable');f.pr.head='b'.repeat(40);
    const author=await runFor(f,'api-member',async claim=>{const before=domainSnapshot(f),bypass=await tool(f,claim,'transfer_action',prTransfer({operation:'replace',expectedGeneration:1}));
      assert.equal(bypass.ok,false,JSON.stringify(bypass));assert.match(bypass.code,/REVIEW/);assert.deepEqual(domainSnapshot(f),before);
      const input={idempotencyKey:'failed-review-revision',actionId:action.actionId,expectedGeneration:1,expectedVersion:1,targets:['other-member'],
        responses:findingIds.map(findingId=>({findingId,body:'Addressed in the new HEAD; please verify independently.',disposition:'addressed'}))};
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'missing-failed-responses',responses:[]}),'THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      const revision=ok(await tool(f,claim,'start_review_revision',input));assert.equal(revision.generation,2);assert.equal(revision.version,2);assert.equal(revision.verification,'attested');
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_review_revision_claims').get().n,1);assert.ok(state(f,action.actionId).findings.every(f=>f.state==='attested'));return 'Fresh replacement requires all finding responses';});
    assert.equal(author.queue.causalRootId,original.queue.causalRootId);
    await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(ctx.headSha,f.pr.head);assert.equal(ctx.authorAgentId,'api-member');assert.deepEqual(ctx.findings.map(f=>f.id),findingIds);
      const r=ok(await tool(f,claim,'submit_review',reviewInput(ctx,{verdict:'approved',findings:[],resolvedFindingIds:findingIds})));await finish(f,claim,action,r.evidenceId,2);
      assert.equal(ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3})).status,'approved');return 'Independent fresh review follows the authorized replacement';});
    checks.push('Return/replace regression: after one parallel reviewer delivers findings and the other fails, ordinary replace cannot change HEAD without author responses; the same-root trusted revision handles replaceable state, requires every finding response, retains IDs/author route, and fresh independent review plus typed completion is still required for approval');
  }
  {
    const f=await fixture('legacy-findings-survive-return'),{action,author}=await assign(f);legacyAdmissionFixture(f,action);let findingId;
    await runFor(f,'other-member',async claim=>{const r=ok(await tool(f,claim,'publish_action_review',{idempotencyKey:'legacy-before-return',actionId:action.actionId,expectedGeneration:1,reviewedHeadSha:f.pr.head,
      verdict:'changes_requested',findings:['Legacy finding must survive returning responsibility'],body:'Durable legacy review before return'}));findingId=`${r.evidenceId}:0`;
      const returned=ok(await tool(f,claim,'transfer_action',prTransfer({operation:'return',expectedGeneration:1,targets:['api-member']})));assert.equal(returned.generation,2);return 'Return with an immutable finding in an older generation';});
    f.pr.head='b'.repeat(40);
    const returned=await runFor(f,'api-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(ctx.generation,2);assert.equal(ctx.workflowVersion,0);assert.equal(ctx.authorAgentId,'api-member');
      assert.deepEqual(ctx.findings.map(f=>f.id),[findingId]);assert.equal(ctx.findings[0].openedHeadSha,'a'.repeat(40));assert.equal(ctx.findings[0].state,'open');
      const bypass=await tool(f,claim,'transfer_action',prTransfer({operation:'replace',expectedGeneration:2}));assert.equal(bypass.ok,false,JSON.stringify(bypass));assert.match(bypass.code,/REVIEW/);
      const input={idempotencyKey:'returned-fresh-review',actionId:action.actionId,expectedGeneration:2,expectedVersion:0,targets:['other-member'],responses:[{findingId,body:'Addressed in the new HEAD, not independently verified yet.',disposition:'addressed'}]};
      rejectCode(await tool(f,claim,'start_review_revision',{...input,idempotencyKey:'returned-missing',responses:[]}),'THREADED_REVIEW_ALL_FINDINGS_RESPONSE_REQUIRED');
      const revision=ok(await tool(f,claim,'start_review_revision',input));assert.equal(revision.generation,3);assert.equal(revision.version,2);assert.equal(revision.verification,'attested');
      const old=ok(await tool(f,claim,'read_review_workflow',{actionId:action.actionId,version:1}));assert.deepEqual(old.findings.map(f=>f.id),[findingId]);assert.equal(old.findings[0].openedHeadSha,'a'.repeat(40));assert.equal(old.findings[0].state,'open');
      assert.deepEqual(old.reports,{});assert.equal(state(f,action.actionId).findings[0].state,'attested');return 'Returned-holder proof authorizes a response-bound fresh handoff';});
    assert.equal(returned.queue.causalRootId,author.queue.causalRootId);
    await runFor(f,'other-member',async claim=>{const ctx=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));assert.equal(ctx.authorAgentId,'api-member');assert.deepEqual(ctx.findings.map(f=>f.id),[findingId]);
      const r=ok(await tool(f,claim,'submit_review',reviewInput(ctx,{verdict:'approved',findings:[],resolvedFindingIds:[findingId]})));await finish(f,claim,action,r.evidenceId,3);
      assert.equal(ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:3})).status,'approved');return 'Historical legacy finding receives independent verification in the new generation';});
    checks.push('Legacy return regression: returning a pre-workflow Action preserves findings from earlier generations with original IDs/HEAD/source ACL and fixed author route; fresh reassignment rejects the generic replace shortcut and requires returned-holder proof plus all responses before a new independent review can approve');
  }
  const report={ok:true,groups:checks.length,checks,faults,injectedHttpCalls,prReads,realModelCalls:0,externalNetworkCalls:0,
    legacyAdmissionScope:'explicit frozen-generation admission markers in isolated fixtures; actual v32-to-v33 migration capture is verified by verify-threaded-migration.mjs',
    scope:'real isolated SQLite/runtime/Bindings and process concurrency; GitHub HEAD/authority transport and model responses explicitly injected; local gate only, no GitHub approval or merge'};
  const evidence=path.resolve('docs/reports/evidence/threaded-t11-reviews');await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'isolated.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
