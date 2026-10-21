/** Explicit opt-in only. Uses the human-authorized Git credential in memory, exclusively for official GitHub GETs. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';
if(!process.argv.includes('--authorized-git-credential'))throw new Error('Explicit authorization for in-memory Git credential use is required');
let token=null;
try{const result=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',timeout:20_000,stdio:['pipe','pipe','ignore']});
  token=result.split('\n').find(v=>v.startsWith('password='))?.slice(9)??null;
}catch{throw new Error('Authorized GitHub credential unavailable');}
if(!token)throw new Error('Authorized GitHub credential unavailable');
const requests=[];
async function get(apiPath){if(!apiPath.startsWith('/repos/zts212653/clowder-ai/')&&apiPath!=='/user')throw new Error('READ_ONLY_ALLOWLIST_REQUIRED');
  const response=await fetch(`https://api.github.com${apiPath}`,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Authorization:`Bearer ${token}`,
    Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'agent-gand-t10-readonly-acceptance','Cache-Control':'no-store'}});
  requests.push({path:apiPath,method:'GET',status:response.status});if(!response.ok)throw new Error(`GitHub read failed: ${response.status}`);return response.json();
}
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t10-real-github-')));let f;
try{
  const identity=await get('/user'),repository='zts212653/clowder-ai';
  const pulls=(await get(`/repos/${repository}/pulls?state=all&per_page=20`)).filter(p=>p.user.login.toLowerCase()!==identity.login.toLowerCase());
  assert.ok(pulls.length,'An independent-author public PR is required');let selected,historicalReview=null;
  // Bounded search for an actual published approval of an older HEAD, with no remote writes.
  for(const p of pulls.slice(0,10)){
    const reviews=await get(`/repos/${repository}/pulls/${p.number}/reviews?per_page=100`);
    const old=reviews.find(r=>r.state==='APPROVED'&&r.commit_id&&r.commit_id!==p.head.sha);
    if(old){selected=p;historicalReview={id:old.id,commitId:old.commit_id,reviewer:old.user.login,state:old.state,url:old.html_url};break;}
  }
  selected??=pulls[0];
  const subject={kind:'github_pr',repository,number:selected.number};
  let commits=historicalReview?[]:await get(`/repos/${repository}/pulls/${selected.number}/commits?per_page=100`);
  if(!historicalReview&&!commits.some(v=>v.sha!==selected.head.sha))for(const candidate of pulls.slice(1,10)){
    const history=await get(`/repos/${repository}/pulls/${candidate.number}/commits?per_page=100`);
    if(history.some(v=>v.sha!==candidate.head.sha)){selected=candidate;commits=history;break;}
  }
  const olderHead=historicalReview?.commitId??commits.find(v=>v.sha!==selected.head.sha)?.sha??null;
  subject.number=selected.number;
  const files=await get(`/repos/${repository}/pulls/${selected.number}/files?per_page=100`);
  Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
  const {githubActionSource}=await import('../apps/server/src/threaded/githubActions.ts');
  const {githubPrTrackingSource}=await import('../apps/server/src/threaded/tracking.ts');
  const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
  const authorize=scope=>({fingerprint:`github-real-t10:${identity.id}:${scope.agentId}`,githubLogin:identity.login,mayAssign:scope.agentId==='api-member'});
  const pr=githubActionSource({token:()=>token,authorize:(scope,repo)=>repo===repository?authorize(scope):null,fetch:async(url,init)=>{
    assert.equal(new URL(url).origin,'https://api.github.com');assert.equal(init.method,'GET');
    const response=await fetch(url,init);requests.push({path:new URL(url).pathname,method:'GET',status:response.status});return response;}});
  const tracking=githubPrTrackingSource({authorize:(scope,repo)=>repo===repository?authorize(scope).fingerprint:null,fetch:get});
  f=await openBackendRuntimeFixture(root,'pr-domain',{applicationTools:THREADED_APPLICATION_TOOL_NAMES,actions:{pr},trackingSources:{github_pr:tracking},fetch:async()=>{
    try{const body=await f.handler(f.activeClaim);return new Response(JSON.stringify({id:randomUUID(),type:'message',content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});}
    catch(error){f.error=error;throw error;}}});
  for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  async function run(receipt,handler){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);const claim=f.runtime.queue.claimNext('t10-real-domain');assert.ok(claim);f.activeClaim=claim;f.handler=handler;
    const result=await f.runtime.executeClaim(claim);if(f.error)throw f.error;assert.equal(result.status,'completed');return claim;}
  async function tool(claim,name,input){return JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));}
  const ok=v=>{assert.equal(v.ok,true,JSON.stringify(v));return v.result;};
  let action,readFact,review,completion,wait;
  await run(f.user('Isolated real GitHub domain acceptance; local delivery only.'),async claim=>{
    readFact=await pr.current(claim.binding,subject);assert.notEqual(readFact.authorLogin,identity.login.toLowerCase());
    action=ok(await tool(claim,'transfer_action',{idempotencyKey:'real-review',subject,predicate:'review_delivered',family:'review',successorSlot:'review',targets:['other-member']}));
    wait=ok(await tool(claim,'track_event',{idempotencyKey:'real-baseline',jobKey:'real-pr-head',source:'github_pr',subject:`${repository}#${subject.number}`,match:{headSha:readFact.headSha}}));
    return 'Real HEAD assignment and live baseline recorded';});
  await run(undefined,async claim=>{
    const fence={actionId:action.actionId,expectedGeneration:1};
    if(olderHead){const stale=await tool(claim,'publish_action_review',{idempotencyKey:'historical-approved',...fence,reviewedHeadSha:olderHead,verdict:'approved',findings:[],body:'Historical approved version must not satisfy the current HEAD.'});assert.equal(stale.code,'THREADED_REVIEW_STALE_HEAD');}
    review=ok(await tool(claim,'publish_action_review',{idempotencyKey:'local-review',...fence,reviewedHeadSha:readFact.headSha,verdict:'changes_requested',
      findings:['完整工程评审与代码测试尚未执行；本地报告仅验收领域集成，不授予合并批准。'],
      body:`T10 隔离领域验收报告。读取 ${repository}#${subject.number} 当前 HEAD ${readFact.headSha}；远端列出 ${files.length} 个变更文件。此报告验证身份、版本和交付合同，未执行完整工程评审，结论为 changes_requested。无 GitHub 写操作。`}));
    completion=ok(await tool(claim,'complete_action',{idempotencyKey:'real-completion',...fence,evidenceId:review.evidenceId}));
    assert.equal(completion.state,'completed');assert.equal(completion.approvalGateSatisfied,false);return 'Local review delivered; approval gate remains unsatisfied';});
  f.reopen();await f.runtime.collaboration.actions.refreshFreshness();await f.runtime.collaboration.tracking.refresh();
  const state=f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(wait.waitId).state;
  assert.equal(state,'awaiting','A live existing matching HEAD is baseline, not a new event');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='wait'").get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_action_candidates').get().n,1);
  const report={ok:true,date:new Date().toISOString(),scope:'Actual GitHub official REST GET + authenticated local published Thread delivery and real domain resolver in isolated SQLite; model transport injected',
    subject,prUrl:selected.html_url,headSha:readFact.headSha,author:readFact.authorLogin,reviewerLogin:identity.login,
    historicalApprovedReview:historicalReview,olderHeadRejected:olderHead!==null,
    review:{verdict:'changes_requested',acceptedSource:'thread',published:true},actionState:completion.state,approvalGateSatisfied:false,
    tracking:{liveBaseline:true,unchangedHeadWakeCount:0,newLiveHeadObserved:false},
    requests,realModelCalls:0,realExternalWrites:0,tokens:0,
    limits:['No PR was modified. A new remote HEAD occurring during the wait was not observed; dynamic new-event wake and HEAD-change races remain covered by injected transport tests.',
      'This is domain integration acceptance, not a complete engineering code review or production release acceptance.']};
  const out=path.resolve('docs/reports/evidence/threaded-t10-actions');await mkdir(out,{recursive:true});await writeFile(path.join(out,'github-real.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:true,subject,headSha:readFact.headSha,olderHeadRejected:!!olderHead,historicalApprovedReview:historicalReview?.id??null,requests:requests.length,actionState:completion.state,newLiveHeadObserved:false,realExternalWrites:0,tokens:0},null,2));
}finally{token=null;f?.close();await rm(root,{recursive:true,force:true});}
