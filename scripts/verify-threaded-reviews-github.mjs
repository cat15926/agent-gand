/** Explicit human-authorized credential use, only in memory and only for official GitHub REST GETs. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

if(!process.argv.includes('--authorized-git-credential'))throw new Error('Explicit authorization for in-memory Git credential use is required');
const repository='zts212653/clowder-ai';let token=null,f,root;
const requests=[];
function allowed(apiPath) {
  const url=new URL(apiPath,'https://api.github.com');
  if(url.origin!=='https://api.github.com'||url.username||url.password||url.hash||
    !(url.pathname==='/user'||url.pathname===`/repos/${repository}/pulls`||new RegExp(`^/repos/${repository}/pulls/[0-9]+(?:/(?:reviews|commits|files))?$`).test(url.pathname)))
    throw new Error('READ_ONLY_ALLOWLIST_REQUIRED');
  return url;
}
async function get(apiPath) {
  const url=allowed(apiPath),response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Authorization:`Bearer ${token}`,
    Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'agent-gand-t11-readonly-acceptance','Cache-Control':'no-store'}});
  requests.push({path:url.pathname+url.search,method:'GET',status:response.status});
  if(!response.ok)throw new Error(`GitHub read failed: ${response.status}`);return response.json();
}
try {
  // Never print stderr/stdout or save the credential-helper response to a file.
  try {const result=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',timeout:20_000,stdio:['pipe','pipe','ignore']});
    token=result.split('\n').find(v=>v.startsWith('password='))?.slice(9)??null;
  } catch {throw new Error('Authorized GitHub credential unavailable');}
  if(!token)throw new Error('Authorized GitHub credential unavailable');
  const identity=await get('/user'),pulls=(await get(`/repos/${repository}/pulls?state=all&per_page=20`))
    .filter(p=>p.user.login.toLowerCase()!==identity.login.toLowerCase());
  assert.ok(pulls.length,'An independent-author public PR is required');
  let selected,historicalReview=null,olderHead=null;
  for(const p of pulls.slice(0,10)) {
    const reviews=await get(`/repos/${repository}/pulls/${p.number}/reviews?per_page=100`),old=reviews.find(r=>r.state==='APPROVED'&&r.commit_id&&r.commit_id!==p.head.sha);
    if(old){selected=p;olderHead=old.commit_id;historicalReview={id:old.id,commitId:old.commit_id,reviewer:old.user.login,state:old.state,url:old.html_url};break;}
  }
  if(!selected)for(const p of pulls.slice(0,10)) {
    const commits=await get(`/repos/${repository}/pulls/${p.number}/commits?per_page=100`),old=commits.find(c=>c.sha!==p.head.sha);
    if(old){selected=p;olderHead=old.sha;break;}
  }
  assert.ok(selected&&olderHead,'An actual older PR HEAD/commit is required for stale-version acceptance');
  const subject={kind:'github_pr',repository,number:selected.number},files=await get(`/repos/${repository}/pulls/${selected.number}/files?per_page=100`);
  root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t11-real-github-')));
  Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
  const {githubActionSource}=await import('../apps/server/src/threaded/githubActions.ts');
  const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
  const authorize=scope=>({fingerprint:`github-real-t11:${identity.id}:${scope.agentId}`,githubLogin:identity.login,mayAssign:scope.agentId==='api-member'});
  const pr=githubActionSource({token:()=>token,authorize:(scope,repo)=>repo===repository?authorize(scope):null,fetch:async(url,init)=>{
    const parsed=allowed(url);assert.equal(init.method,'GET');
    const response=await fetch(parsed,init);requests.push({path:parsed.pathname+parsed.search,method:'GET',status:response.status});return response;}});
  let injectedModelCalls=0;
  f=await openBackendRuntimeFixture(root,'pr-review-workflow',{applicationTools:THREADED_APPLICATION_TOOL_NAMES,actions:{pr},fetch:async()=>{
    injectedModelCalls++;try {const body=await f.handler(f.activeClaim);return new Response(JSON.stringify({id:randomUUID(),type:'message',content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});}
    catch(error){f.handlerError=error;throw error;}}});
  for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  async function run(receipt,handler) {if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
    const claim=f.runtime.queue.claimNext('t11-real-review-domain');assert.ok(claim);f.activeClaim=claim;f.handler=handler;f.handlerError=undefined;
    const result=await f.runtime.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));return claim;}
  async function runFor(agent,handler,receipt) {if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
    for(let n=0;n<8;n++){let handled=false;const claim=await run(undefined,async claim=>{if(claim.binding.agentId===agent){handled=true;return handler(claim);}return 'Unrelated durable notification processed';});if(handled)return claim;}
    assert.fail(`No queued work for ${agent}`);}
  async function tool(claim,name,input,key=randomUUID()){return JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,key,THREADED_APPLICATION_TOOL_NAMES));}
  const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
  const reviewInput=(context,extra={})=>({idempotencyKey:randomUUID(),actionId:context.actionId,expectedGeneration:context.generation,expectedVersion:context.workflowVersion,
    authorAgentId:context.authorAgentId,acceptedSourceMessageId:context.acceptedSourceMessageId,acceptedRevision:context.acceptedRevision,reviewedHeadSha:context.headSha,
    verdict:'changes_requested',findings:['完整工程评审与代码测试尚未执行；本报告仅验收来源、版本、交付和批准门禁合同。'],resolvedFindingIds:[],
    body:`T11 隔离领域验收：读取 ${repository}#${subject.number} 的官方 GitHub 当前 HEAD、历史提交及 ${files.length} 个变更文件条目。完整代码评审尚未执行，因此请求修改；本地报告不授予合并批准，不写入 GitHub。`,...extra});
  let action,context,report,completion,gate,authorRequest,reviewerClaim,authorDelivery;
  authorRequest=await runFor('api-member',async claim=>{
    const fact=await pr.current(claim.binding,subject);assert.notEqual(fact.authorLogin,identity.login.toLowerCase());
    action=ok(await tool(claim,'transfer_action',{idempotencyKey:'t11-real-review',subject,predicate:'review_delivered',family:'review',successorSlot:'review',targets:['other-member']}));
    return 'Independent review assigned against actual live GitHub HEAD';
  },f.user('Isolated T11 real GitHub read-only review workflow acceptance; only local Thread delivery.'));
  reviewerClaim=await runFor('other-member',async claim=>{
    context=ok(await tool(claim,'review_context',{actionId:action.actionId}));assert.equal(context.workflowVersion,0);assert.equal(context.authorAgentId,'api-member');
    assert.notEqual(olderHead,context.headSha);
    const stale=await tool(claim,'submit_review',reviewInput(context,{idempotencyKey:'actual-old-head',reviewedHeadSha:olderHead,verdict:'approved',findings:[],body:'Actual older HEAD approval must never satisfy current revision.'}));
    assert.equal(stale.code,'THREADED_REVIEW_STALE_HEAD');
    const mismatched=await tool(claim,'submit_review',reviewInput(context,{idempotencyKey:'wrong-revision',acceptedRevision:context.acceptedRevision+1}));assert.equal(mismatched.code,'THREADED_REVIEW_ACCEPTED_SOURCE_MISMATCH');
    report=ok(await tool(claim,'submit_review',reviewInput(context,{idempotencyKey:'t11-local-report'})));assert.equal(report.actionCompleted,false);assert.equal(report.approvalGateSatisfied,false);
    const published=f.runtime.messages.getMessage({ownerId:f.thread.ownerId,threadId:f.thread.id,viewer:{kind:'agent',agentId:'api-member'}},report.messageId);
    assert.equal(published.origin,'agent_post');assert.deepEqual(published.targets,['api-member']);assert.equal(published.causalRootId,authorRequest.queue.causalRootId);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_message_fences WHERE message_id=?').get(report.messageId).n,0);
    completion=ok(await tool(claim,'complete_action',{idempotencyKey:'t11-delivered',actionId:action.actionId,expectedGeneration:context.generation,evidenceId:report.evidenceId}));
    assert.equal(completion.state,'completed');assert.equal(completion.approvalGateSatisfied,false);
    gate=ok(await tool(claim,'check_review_gate',{actionId:action.actionId,expectedVersion:report.version}));assert.equal(gate.status,'blocked');assert.equal(gate.approvalGateSatisfied,false);
    return 'Local changes request delivered; responsibility completed independently of approval';});
  assert.equal(reviewerClaim.queue.causalRootId,authorRequest.queue.causalRootId);
  f.reopen();
  authorDelivery=await runFor('api-member',async claim=>{
    const wake=f.runtime.collaboration.cooperation.source(claim.binding);assert.equal(wake.id,report.messageId);assert.equal(wake.origin,'agent_post');
    assert.equal(f.runtime.collaboration.actions.capture(claim.binding),null,'Ordinary review report cannot grant Action ownership');
    gate=ok(await tool(claim,'check_review_gate',{actionId:action.actionId,expectedVersion:report.version}));assert.equal(gate.status,'blocked');assert.equal(gate.approvalGateSatisfied,false);
    const workflow=ok(await tool(claim,'read_review_workflow',{actionId:action.actionId,version:report.version}));
    assert.equal(workflow.state,'changes_requested');assert.ok(workflow.findings.length);assert.ok(workflow.findings.every(v=>v.state==='open'));
    return 'Author receives an ordinary report wake; real HEAD gate remains blocked';});
  assert.equal(authorDelivery.queue.causalRootId,authorRequest.queue.causalRootId);
  const evidence={ok:true,date:new Date().toISOString(),scope:'Actual official GitHub REST GET, authorized Git credential in memory, exact accepted request/revision, authenticated local A2A report and real workflow/domain resolver in isolated SQLite; model transport injected',
    subject,prUrl:selected.html_url,headSha:context.headSha,olderHead,historicalApprovedReview:historicalReview,olderHeadRejected:true,acceptedRevisionMismatchRejected:true,
    authorLogin:selected.user.login,reviewerLogin:identity.login,localAuthorRoute:'api-member',localReviewer:'other-member',
    review:{verdict:'changes_requested',acceptedSource:'thread',acceptedRevision:context.acceptedRevision,published:true,ordinaryA2ARoute:true,findingStates:['open']},
    actionState:completion.state,gate:{status:gate.status,approvalGateSatisfied:false,externalApprovalGranted:false,reasons:gate.reasons},
    authorWake:{ordinary:true,grantsActionStanding:false,sameCausalRoot:true,afterRuntimeAndSQLiteRebuild:true},
    requests,injectedModelCalls,realModelCalls:0,realExternalWrites:0,tokens:0,
    limits:['This is domain workflow integration acceptance, not an engineering review approval or production release acceptance.',
      'The actual PR author is an external GitHub account; the exact author route in this isolated platform Thread is the authenticated requester/predecessor.',
      'No remote PR, comment, review, branch or commit was modified. A new live HEAD arriving during a wait was not observed; real dynamic new-event and revision/re-review still require separate acceptance.']};
  const output=path.resolve('docs/reports/evidence/threaded-t11-reviews');await mkdir(output,{recursive:true});await writeFile(path.join(output,'github-real.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({ok:true,subject,headSha:context.headSha,olderHeadRejected:true,acceptedRevisionMismatchRejected:true,requests:requests.length,
    actionState:completion.state,gate:gate.status,authorOrdinaryWake:true,realExternalWrites:0,tokens:0},null,2));
} finally {token=null;f?.close();if(root)await rm(root,{recursive:true,force:true});}
