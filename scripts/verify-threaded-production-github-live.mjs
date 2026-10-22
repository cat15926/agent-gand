/** RC02 provider transport acceptance: explicitly authorized credentials in memory, official GETs only. */
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const repository='zts212653/clowder-ai',number=1618,subject={kind:'github_pr',repository,number};
const scope={ownerId:'readonly-acceptance-owner',threadId:'readonly-acceptance-thread',agentId:'readonly-agent'};
const credentialName='THREADED_GITHUB_TOKEN_RC02';
const output=path.resolve('docs/reports/evidence/threaded-rc02-github-readonly.json');
const safeErrors=new WeakMap();
const fail=code=>{const error=new Error(code);safeErrors.set(error,code);throw error;};
const check=(condition,code)=>{if(!condition)fail(code);};
if(!process.argv.includes('--authorized-git-credential')){
  console.error(JSON.stringify({ok:false,code:'RC02_EXPLICIT_CREDENTIAL_AUTHORIZATION_REQUIRED'}));
  process.exit(1);
}

let token=null,credentialResponse=null,root=null,provider=null,rebuilt=null,allowed=true,mode='execute',revokeOnPrReturn=false;
const requests=[],checks=[],observations=[];
let result={ok:false,startedAt:new Date().toISOString(),repository,number,
  scope:'RC02 registered provider and actual official GitHub REST GET only; no production runtime, business DB, models or manufactured event',
  realModelCalls:0,realModelTokens:0,realExternalWrites:0,productionOpened:false};
const realFetch=globalThis.fetch;
function officialUrl(input){
  let url;try{url=new URL(String(input));}catch{fail('RC02_OFFICIAL_GET_ALLOWLIST_REQUIRED');}
  if(url.origin!=='https://api.github.com'||url.username||url.password||url.search||url.hash
    ||!['/user',`/repos/${repository}/pulls/${number}`].includes(url.pathname))fail('RC02_OFFICIAL_GET_ALLOWLIST_REQUIRED');
  return url;
}
async function transport(input,init){
  const url=officialUrl(input);
  check(init?.method==='GET'&&init.redirect==='error','RC02_OFFICIAL_GET_ALLOWLIST_REQUIRED');
  let response;
  try{response=await realFetch(url,init);}catch{fail('RC02_GITHUB_TRANSPORT_UNAVAILABLE');}
  requests.push({path:url.pathname,method:'GET',status:response.status});
  if(revokeOnPrReturn&&url.pathname!== '/user'){revokeOnPrReturn=false;allowed=false;}
  return response;
}
async function discoverLogin(){
  const response=await transport('https://api.github.com/user',{method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{
    Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',
    'User-Agent':'agent-gand-rc02-readonly-acceptance','Cache-Control':'no-cache, no-store'}});
  if(!response.ok)fail('RC02_GITHUB_IDENTITY_UNAVAILABLE');
  let value;try{value=await response.json();}catch{fail('RC02_GITHUB_IDENTITY_UNAVAILABLE');}
  check(typeof value?.login==='string'&&/^[A-Za-z0-9-]{1,39}$/.test(value.login),'RC02_GITHUB_IDENTITY_INVALID');
  return value.login.toLowerCase();
}
async function mustReject(operation,code){
  let rejected=false;try{await operation();}catch{rejected=true;}
  check(rejected,code);
}
function compareObservation(label,previous,events){
  check(Array.isArray(events)&&events.length<=1,'RC02_TRACKING_EVENT_SHAPE_INVALID');
  if(!events.length){observations.push({label,status:'unchanged',headSha:previous.headSha});return previous;}
  const event=events[0]?.event;
  check(event?.type==='github_pr'&&/^[a-f0-9]{40}$/i.test(event.headSha),'RC02_TRACKING_EVENT_SHAPE_INVALID');
  check(event.headChanged===(event.headSha!==previous.headSha),'RC02_TRACKING_HEAD_CHANGE_INVALID');
  observations.push({label,status:event.headChanged?'natural_head_change':'natural_state_change',previousHeadSha:previous.headSha,event});
  return event;
}
async function save(){await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');}
try{
  // The helper output and token never enter process.env, a file, a command argument, a log or evidence.
  try{credentialResponse=execFileSync('git',['credential','fill'],{
    input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',timeout:20_000,stdio:['pipe','pipe','ignore']});
    token=credentialResponse.split('\n').find(line=>line.startsWith('password='))?.slice(9)??null;
  }catch{fail('RC02_AUTHORIZED_GITHUB_CREDENTIAL_UNAVAILABLE');}
  credentialResponse=null;
  check(typeof token==='string'&&token.length>0,'RC02_AUTHORIZED_GITHUB_CREDENTIAL_UNAVAILABLE');
  const login=await discoverLogin();
  root=await mkdtemp(path.join(tmpdir(),'agent-gand-rc02-github-readonly-'));
  const file=path.join(root,'registration.json');
  await writeFile(file,JSON.stringify({schemaVersion:1,version:1,ownerId:scope.ownerId,
    credential:{source:'environment',name:credentialName,version:1},
    repositories:[{repository,pullNumbers:[number],threadIds:[scope.threadId],
      actors:[{agentId:scope.agentId,githubLogin:login,mayAssign:true}]}]}),{mode:0o600});
  const {loadThreadedProductionGithub}=await import('../apps/server/src/threaded/productionGithub.ts');
  const make=(readToken=name=>name===credentialName?token:null)=>loadThreadedProductionGithub({file,ownerId:scope.ownerId,mode:()=>mode,
    authorizeMember:candidate=>allowed&&candidate.ownerId===scope.ownerId&&candidate.threadId===scope.threadId&&candidate.agentId===scope.agentId
      ?'rc02-readonly-current-member-v1':null,
    readToken,fetch:transport,assertOutsideTransaction(){}});
  provider=make();check(!!provider,'RC02_PROVIDER_REGISTRATION_MISSING');
  const fact=await provider.pr.current(scope,subject);
  check(fact.repository===repository&&fact.number===number&&/^[a-f0-9]{40}$/i.test(fact.headSha),'RC02_LIVE_PR_FACT_INVALID');
  checks.push('Registered provider accepted exact allowlisted official PR facts after official /user principal verification.');
  const trackingSubject=`${repository}#${number}`;
  const baseline=await provider.tracking.observe(scope,trackingSubject);
  check(Array.isArray(baseline)&&baseline.length===1&&baseline[0]?.event?.headChanged===false,'RC02_LIVE_BASELINE_INVALID');
  let last=baseline[0].event;
  observations.push({label:'baseline',status:'baseline_only',event:last});
  last=compareObservation('same-provider-repeat',last,await provider.tracking.observe(scope,trackingSubject,last));
  checks.push('A live baseline is distinct from a new HEAD event; unchanged live facts produce no event.');
  rebuilt=make();check(!!rebuilt,'RC02_PROVIDER_REBUILD_MISSING');
  last=compareObservation('rebuilt-provider-repeat',last,await rebuilt.tracking.observe(scope,trackingSubject,last));
  checks.push('Rebuilding the provider with the previous baseline does not manufacture an event from unchanged facts.');
  let before=requests.length;allowed=false;
  check(rebuilt.pr.authorize(scope,repository)===null&&rebuilt.tracking.authorization(scope,trackingSubject)===null,'RC02_REVOKED_SCOPE_AUTHORIZED');
  await mustReject(()=>rebuilt.pr.current(scope,subject),'RC02_REVOKED_SCOPE_FACT_ACCEPTED');
  await mustReject(()=>rebuilt.tracking.observe(scope,trackingSubject,last),'RC02_REVOKED_SCOPE_EVENT_ACCEPTED');
  check(requests.length===before,'RC02_REVOKED_SCOPE_SENT_NETWORK');
  checks.push('Current scope revocation prevents facts/tracking authorization and sends zero new requests.');
  allowed=true;revokeOnPrReturn=true;before=requests.length;
  await mustReject(()=>rebuilt.pr.current(scope,subject),'RC02_IO_REVOKED_FACT_ACCEPTED');
  check(!allowed&&requests.length>before,'RC02_IO_REVOCATION_WINDOW_NOT_EXERCISED');
  checks.push('Authorization revoked after an actual PR GET returns prevents accepting its bytes.');
  allowed=true;before=requests.length;
  const missing=make(()=>null);check(!!missing,'RC02_MISSING_TOKEN_PROVIDER_SHAPE_INVALID');
  await mustReject(()=>missing.pr.current(scope,subject),'RC02_MISSING_TOKEN_FACT_ACCEPTED');
  check(requests.length===before,'RC02_MISSING_TOKEN_SENT_NETWORK');
  checks.push('A new provider with no credential rejects facts before network.');
  mode='observe';before=requests.length;
  await mustReject(()=>provider.pr.current(scope,subject),'RC02_OBSERVE_FACT_ACCEPTED');
  await mustReject(()=>provider.tracking.observe(scope,trackingSubject,last),'RC02_OBSERVE_EVENT_ACCEPTED');
  check(requests.length===before,'RC02_OBSERVE_SENT_NETWORK');
  checks.push('Observe mode rejects provider facts and tracking without network.');
  const naturalHeadChanges=observations.filter(item=>item.status==='natural_head_change').length;
  result={...result,ok:true,status:'passed',completedAt:new Date().toISOString(),principalLogin:login,prUrl:`https://github.com/${repository}/pull/${number}`,
    fact,checks,observations,naturalHeadChanges,rc04LiveHeadAcceptance:'not_performed',requests,
    limits:['This verifies the registered provider transport, not a full production factory/runtime or real-model collaboration.',
      'No PR, comment, review, branch or commit was modified. No business DB or token ledger was opened.',
      'The previous baseline is passed in memory across provider reconstruction; this is not SQLite or service recovery evidence.',
      'Natural changes, if any, are recorded as observations and do not establish the RC04 wake/revision/re-review acceptance chain.']};
  await save();
  console.log(JSON.stringify({ok:true,status:'passed',groups:checks.length,requests:requests.length,naturalHeadChanges,
    realModelCalls:0,realExternalWrites:0,output},null,2));
}catch(error){
  result={...result,ok:false,status:'failed',completedAt:new Date().toISOString(),code:error&&typeof error==='object'?safeErrors.get(error)??'RC02_GITHUB_READONLY_ACCEPTANCE_FAILED':'RC02_GITHUB_READONLY_ACCEPTANCE_FAILED',
    checks,observations,requests};
  try{await save();}catch{/* Report only a fixed error code below; never log raw provider/helper errors. */}
  console.error(JSON.stringify({ok:false,code:result.code,output}));process.exitCode=1;
}finally{
  token=null;credentialResponse=null;provider=null;rebuilt=null;
  if(root)try{await rm(root,{recursive:true,force:true});}catch{console.error(JSON.stringify({ok:false,code:'RC02_TEMP_METADATA_CLEANUP_FAILED'}));process.exitCode=1;}
}
