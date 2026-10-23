/** Real official facts + local scripted production protocol; never writes to GitHub. */
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRc04ReadonlyGithub} from './fixtures/threadedRc04ReadonlyGithub.mjs';
import {openRc04Process} from './fixtures/threadedRc04Process.mjs';

const argv=process.argv.slice(2).filter(arg=>arg!=='--');
const allowed=new Set(['--authorized-git-credential']);
for(const arg of argv)if(!allowed.has(arg)&&!/^--(?:observe-seconds|poll-seconds|targets)=\d+$/.test(arg))throw new Error('RC04_ARGUMENT_INVALID');
if(!argv.includes('--authorized-git-credential'))throw new Error('RC04_EXPLICIT_CREDENTIAL_AUTHORIZATION_REQUIRED');
const flag=(name,fallback,min,max)=>{const values=argv.filter(v=>v.startsWith(`--${name}=`));assert.ok(values.length<=1,'RC04_ARGUMENT_INVALID');
  const value=values.length?Number(values[0].split('=')[1]):fallback;assert.ok(Number.isInteger(value)&&value>=min&&value<=max,'RC04_ARGUMENT_INVALID');return value;};
const seconds=flag('observe-seconds',600,1,600),pollSeconds=flag('poll-seconds',30,5,60),targets=flag('targets',3,1,3);
const startedAt=new Date().toISOString(),repository='zts212653/clowder-ai';
const output=path.resolve(process.env.THREADED_RC04_LIVE_OUTPUT??`docs/reports/evidence/threaded-rc04/live-${startedAt.replaceAll(/[^0-9TZ]/g,'')}.json`);
const safeCode=error=>/^RC04_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'RC04_LIVE_ACCEPTANCE_FAILED';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let root,transport;const runs=[];
let result={schemaVersion:1,task:'RC04',ok:false,status:'initializing',startedAt,repository,windowSeconds:seconds,pollSeconds,
  scope:'Official current GitHub facts and actual isolated production runtime with scripted local review producers; no substantive code-review claim or remote approval',
  requiredSequence:['H0 approved and baseline','natural H1 tracking wake and old approval invalidation','H1 local changes request','natural H2 per-finding revision and independent local re-review'],
  selected:[],polls:[],restarts:[],realModelCalls:0,realModelTokens:0,realExternalWrites:0,dailyProductionOpened:false,dailyDatabaseAccessed:false};
async function save(){
  if(transport){result.requests=[...transport.requests];result.observations=[...transport.observations];result.transport=transport.stats();}
  const serialized=JSON.stringify(result,null,2)+'\n',token=transport?.readToken('THREADED_GITHUB_TOKEN_RC04');
  if(token&&serialized.includes(token))throw Object.assign(new Error('RC04_SECRET_BOUNDARY_FAILED'),{code:'RC04_SECRET_BOUNDARY_FAILED'});
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,serialized,{mode:0o600});
}
function summarize(){
  const passed=result.selected.filter(r=>!r.failure&&r.snapshot?.stage==='passed');
  const partial=result.selected.filter(r=>!r.failure&&r.snapshot?.stage==='await_second_head');
  const available=result.selected.filter(r=>!r.failure&&r.snapshot?.stage);
  return {passed,partial,available};
}
try{
  transport=await createRc04ReadonlyGithub({authorizedGitCredential:true,repository});
  const discovery=await transport.discover({limit:targets});result.principalLogin=discovery.principalLogin;
  root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc04-live-')));
  for(const selected of discovery.selected){
    const row={...selected,status:'initializing'};result.selected.push(row);
    try{
      const harness=await openRc04Process(root,{name:`pr-${selected.number}`,repository,number:selected.number,
        principalLogin:discovery.principalLogin,readToken:name=>transport.readToken(name),githubFetch:transport.fetch});
      runs.push({row,harness});row.snapshot=await harness.initialize();row.status=row.snapshot.stage;
    }catch(error){row.status='failed';row.failure=safeCode(error);}
    await save();
  }
  const observingAt=Date.now();result.observationStartedAt=new Date(observingAt).toISOString();result.status='observing';
  console.log(JSON.stringify({status:'observing',selected:result.selected.map(r=>({number:r.number,status:r.status})),windowSeconds:seconds,output}));
  await save();
  while(Date.now()-observingAt<seconds*1000&&!summarize().passed.length&&summarize().available.length){
    await pause(Math.min(pollSeconds*1000,Math.max(1,seconds*1000-(Date.now()-observingAt))));
    const poll={at:new Date().toISOString(),targets:[]};
    for(const {row,harness} of runs){
      if(row.failure||row.snapshot?.stage==='passed')continue;
      try{
        const observation=await harness.poll();poll.targets.push({number:row.number,...observation});
        if(observation.observed)row.snapshot=await harness.advanceObserved();else row.snapshot=await harness.snapshot();
        row.status=row.snapshot.stage;
      }catch(error){row.status='failed';row.failure=safeCode(error);try{row.snapshot=await harness.snapshot();}catch{/* Keep last trusted snapshot. */}}
    }
    result.polls.push(poll);await save();
    console.log(JSON.stringify({status:'observing',elapsedSeconds:Math.round((Date.now()-observingAt)/1000),targets:result.selected.map(r=>({number:r.number,stage:r.snapshot?.stage,failure:r.failure??null}))}));
  }
  for(const {row,harness} of runs){
    if(row.failure)continue;
    try{
      const before=await harness.snapshot(),requests=transport.requests.length;
      const after=await harness.rebuild();
      assert.equal(transport.requests.length,requests,'RC04_RECOVERY_SENT_GITHUB_REQUEST');
      assert.equal(after.stage,before.stage,'RC04_RECOVERY_CHANGED_STAGE');
      row.snapshot=await harness.snapshot();
      result.restarts.push({number:row.number,passed:true,githubRequests:0,beforeStage:before.stage,afterStage:after.stage,
        evidence:after.processEvidence??row.snapshot.processEvidence??null});
    }catch(error){row.status='failed';row.failure=safeCode(error);result.restarts.push({number:row.number,passed:false,code:row.failure});}
  }
  const {passed,partial,available}=summarize();
  result.status=passed.length?'passed':partial.length?'observed_partial':available.length?'not_observed':'failed';
  result.ok=result.status!=='failed';result.completedAt=new Date().toISOString();result.elapsedSeconds=Math.round((Date.now()-observingAt)/1000);
  result.completedChains=passed.map(r=>r.number);result.partiallyObservedChains=partial.map(r=>r.number);
  result.limits=['A real two-HEAD continuous chain is mandatory; stable reads and historical HEAD inequalities are not new events.',
    'The authenticated local author is the acceptance requester, not the real external PR author; scripted revision/review statements are protocol fixtures.',
    'Local review gate approval never grants GitHub approval and no remote comment, review, commit, branch or PR is created.',
    'The observation window is bounded; not_observed or observed_partial leaves RC04 live acceptance incomplete.',
    'Each acceptance process is isolated; this is not the deployed index process or real-model supplier-fault acceptance.'];
  await save();console.log(JSON.stringify({ok:result.ok,status:result.status,completedChains:result.completedChains,partiallyObservedChains:result.partiallyObservedChains,
    requests:transport.requests.length,elapsedSeconds:result.elapsedSeconds,realModelCalls:0,realExternalWrites:0,output},null,2));
  if(result.status==='failed')process.exitCode=1;
}catch(error){
  result.ok=false;result.status='failed';result.code=safeCode(error);result.completedAt=new Date().toISOString();
  try{await save();}catch{/* No raw exception or credential output. */}
  console.error(JSON.stringify({ok:false,status:'failed',code:result.code,output}));process.exitCode=1;
}finally{
  for(const {harness} of runs)try{await harness.close();}catch{process.exitCode=1;}
  transport?.close();if(root)await rm(root,{recursive:true,force:true});
}
