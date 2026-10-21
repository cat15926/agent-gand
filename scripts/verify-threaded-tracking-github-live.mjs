/** Only explicitly authorized, in-memory Git credentials and official GitHub GETs. Never mutate remote PRs to manufacture an event. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const repository='zts212653/clowder-ai',selfTest=process.argv.includes('--self-test');
if(!selfTest&&!process.argv.includes('--authorized-git-credential'))throw new Error('Explicit authorization for in-memory Git credential use is required');
const secondsFlag=process.argv.find(v=>v.startsWith('--observe-seconds='));
const observeSeconds=secondsFlag?Number(secondsFlag.split('=')[1]):600;
if(!Number.isInteger(observeSeconds)||observeSeconds<1||observeSeconds>600)throw new Error('Observation window must be 1 through 600 seconds');
const output=path.resolve(process.env.THREADED_GITHUB_LIVE_OUTPUT??'docs/reports/evidence/threaded-t12-github-live/result.json');
const {githubPrTrackingSource}=await import('../apps/server/src/threaded/tracking.ts');

async function verifyProvider(){
  let fact={head:{sha:'a'.repeat(40)},state:'open',merged:false,merge_commit_sha:null,updated_at:'2026-10-21T00:00:00Z'},reads=0;
  const source=githubPrTrackingSource({authorize:(_scope,repo)=>repo===repository?'provider-fixture':null,fetch:async p=>{
    reads++;assert.equal(p,`/repos/${repository}/pulls/1`);return fact;}}),scope={ownerId:'fixture',threadId:'fixture',agentId:'fixture'},subject=`${repository}#1`;
  const baseline=await source.observe(scope,subject);assert.equal(baseline.length,1);assert.equal(baseline[0].event.headChanged,false);
  assert.deepEqual(await source.observe(scope,subject,{...baseline[0].event,__authorization:'fixture'}),[]);
  fact={...fact,updated_at:'2026-10-21T00:01:00Z'};assert.deepEqual(await source.observe(scope,subject,baseline[0].event),[]);
  fact={...fact,head:{sha:'b'.repeat(40)},updated_at:'2026-10-21T00:02:00Z'};
  const changed=await source.observe(scope,subject,baseline[0].event);assert.equal(changed.length,1);assert.equal(changed[0].event.headChanged,true);
  assert.deepEqual(await source.observe(scope,subject,{...changed[0].event,__authorization:'fixture'}),[]);
  fact={...fact,state:'closed',updated_at:'2026-10-21T00:03:00Z'};const stateOnly=await source.observe(scope,subject,changed[0].event);
  assert.equal(stateOnly.length,1);assert.equal(stateOnly[0].event.headChanged,false);
  return {ok:true,checks:6,injectedProviderReads:reads,realNetworkRequests:0,coverage:['baseline headChanged=false','unchanged baseline no event','updated_at-only no event','new HEAD headChanged=true','unchanged after HEAD event no duplicate','state-only change is not a HEAD change']};
}
const provider=await verifyProvider();
if(selfTest){console.log(JSON.stringify({ok:true,scope:'Injected provider facts only; no credentials or network',provider},null,2));process.exit(0);}
let token=null,root,f,injectedModelCalls=0,result;
const requests=[],lastFacts=new Map();
function allowed(apiPath){const url=new URL(apiPath,'https://api.github.com');
  if(url.origin!=='https://api.github.com'||url.username||url.password||url.hash||
    !(url.pathname==='/user'||url.pathname===`/repos/${repository}/pulls`||new RegExp(`^/repos/${repository}/pulls/[1-9][0-9]*$`).test(url.pathname)))throw new Error('READ_ONLY_ALLOWLIST_REQUIRED');return url;}
async function get(apiPath){const url=allowed(apiPath);const response=await fetch(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(20_000),headers:{
  Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'agent-gand-t12-live-readonly-acceptance','Cache-Control':'no-store'}});
  requests.push({path:url.pathname+url.search,method:'GET',status:response.status,at:new Date().toISOString()});
  if(!response.ok)throw new Error(`GitHub read failed: ${response.status}`);const fact=await response.json();
  if(new RegExp(`^/repos/${repository}/pulls/[1-9][0-9]*$`).test(url.pathname))lastFacts.set(`${repository}#${fact.number}`,{headSha:fact.head.sha,updatedAt:fact.updated_at,observedAt:new Date().toISOString()});
  return fact;}
async function save(){await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
  try{const credential=execFileSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',timeout:20_000,stdio:['pipe','pipe','ignore']});
    token=credential.split('\n').find(v=>v.startsWith('password='))?.slice(9)??null;}catch{throw new Error('Authorized GitHub credential unavailable');}
  if(!token)throw new Error('Authorized GitHub credential unavailable');
  const identity=await get('/user'),pulls=await get(`/repos/${repository}/pulls?state=open&sort=updated&direction=desc&per_page=3`);
  assert.ok(Array.isArray(pulls)&&pulls.length,'An open public PR is required for a natural HEAD observation');
  const selected=pulls.slice(0,3).map(pr=>({number:pr.number,subject:`${repository}#${pr.number}`,url:pr.html_url,listedUpdatedAt:pr.updated_at}));
  root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t12-live-github-')));
  Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
  const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
  const tracking=githubPrTrackingSource({authorize:(scope,repo)=>repo===repository?`t12-live-github:${identity.id}:${scope.agentId}`:null,fetch:get});
  f=await openBackendRuntimeFixture(root,'natural-head-wait',{applicationTools:THREADED_APPLICATION_TOOL_NAMES,trackingSources:{github_pr:tracking},fetch:async()=>{
    injectedModelCalls++;try{return new Response(JSON.stringify({id:randomUUID(),type:'message',content:[{type:'text',text:await f.handler(f.activeClaim)}],stop_reason:'end_turn',usage:{input_tokens:8,output_tokens:2}}),{headers:{'content-type':'application/json'}});}
    catch(error){f.handlerError=error;throw error;}}});
  for(const configuration of f.configurations.values()){configuration.kind='api';configuration.backendVersion='threaded-http-v1';}
  const accepted=f.user('Isolated T12 official GitHub GET live HEAD wait; no external changes and no model network requests.');
  for(const wake of accepted.wakes)f.runtime.queue.enqueueWake(wake.id);
  const claim=f.runtime.queue.claimNext('t12-live-github');assert.ok(claim);f.activeClaim=claim;
  f.handler=async()=>{for(const item of selected){const answer=JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,'track_event',{
      idempotencyKey:`live:${item.number}`,jobKey:`live:${item.number}`,source:'github_pr',subject:item.subject,match:{type:'github_pr',headChanged:true}},`tool:${item.number}`,THREADED_APPLICATION_TOOL_NAMES));
    assert.equal(answer.ok,true,JSON.stringify(answer));item.waitId=answer.result.waitId;
    // The first wait must not arm a five-second poller while the remaining baselines are being read.
    f.runtime.collaboration.close();
    const row=f.db.prepare('SELECT * FROM threaded_waits WHERE id=?').get(item.waitId),record=JSON.parse(row.record);
    const baseline=f.db.prepare('SELECT record FROM threaded_tracking_events WHERE seq=?').get(record.baseline);
    const event=JSON.parse(baseline.record);assert.equal(event.headChanged,false);
    item.baseline={eventSeq:record.baseline,headSha:event.headSha,...lastFacts.get(item.subject)};
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?").get(item.waitId).n,0);
  }return 'Baselines persisted; natural current HEAD updates are awaited without occupying the execution slot.';};
  const executed=await f.runtime.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(executed.status,'completed',JSON.stringify(executed));
  f.runtime.collaboration.close();assert.equal(f.runtime.collaboration.diagnostics().closed,true);
  const started=Date.now();result={ok:true,status:'observing',startedAt:new Date(started).toISOString(),repository,windowSeconds:observeSeconds,pollSeconds:30,
    scope:'Official GitHub REST GET and real runtime track_event/SQLite with injected model response; natural public PR changes only',provider,selected,polls:[],requests,
    realModelCalls:0,realModelTokens:0,injectedModelCalls,realExternalWrites:0,productionOpened:false};await save();
  let observed=false;
  while(Date.now()-started<observeSeconds*1000){await pause(Math.min(30_000,observeSeconds*1000-(Date.now()-started)));
    const refresh=await f.runtime.collaboration.tracking.refresh();f.runtime.collaboration.cooperation.recover();
    const poll={at:new Date().toISOString(),refresh,waits:[]};
    for(const item of selected){const wait=f.db.prepare('SELECT state,outcome FROM threaded_waits WHERE id=?').get(item.waitId);
      const callbacks=f.db.prepare('SELECT id,state,message_id,record FROM threaded_collaboration_callbacks WHERE source_id=?').all(item.waitId);
      const detail={subject:item.subject,state:wait.state,callbackCount:callbacks.length,latest:lastFacts.get(item.subject)};poll.waits.push(detail);
      if(wait.state==='settled'){
        const outcome=JSON.parse(wait.outcome);assert.equal(outcome.type,'tracking_event');assert.equal(outcome.event.type,'github_pr');assert.equal(outcome.event.headChanged,true);
        assert.notEqual(outcome.event.headSha,item.baseline.headSha);assert.equal(callbacks.length,1);assert.equal(callbacks[0].state,'delivered');
        item.observed={at:poll.at,baselineHead:item.baseline.headSha,newHead:outcome.event.headSha,eventSeq:outcome.eventSeq,callbackId:callbacks[0].id,messageId:callbacks[0].message_id};observed=true;
      }else assert.equal(callbacks.length,0);
    }
    result.polls.push(poll);await save();if(observed)break;
  }
  const before={models:injectedModelCalls,callbacks:f.db.prepare('SELECT id,message_id FROM threaded_collaboration_callbacks ORDER BY id').all(),
    events:f.db.prepare('SELECT seq FROM threaded_tracking_events ORDER BY seq').all(),terminals:f.db.prepare('SELECT COUNT(*) n FROM threaded_invocation_terminals').get().n};
  f.reopen();f.runtime.collaboration.close();f.runtime.collaboration.recover();f.runtime.collaboration.recover();
  assert.equal(injectedModelCalls,before.models);assert.deepEqual(f.db.prepare('SELECT id,message_id FROM threaded_collaboration_callbacks ORDER BY id').all(),before.callbacks);
  assert.deepEqual(f.db.prepare('SELECT seq FROM threaded_tracking_events ORDER BY seq').all(),before.events);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_invocation_terminals').get().n,before.terminals);
  for(const item of selected)if(item.observed)assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?').get(item.waitId).n,1);
  result.status=observed?'passed':'not_observed';result.completedAt=new Date().toISOString();result.elapsedSeconds=Math.round((Date.now()-started)/1000);
  result.rebuild={runtimeAndSQLite:true,modelReplays:0,duplicateCallbacks:0,eventsUnchanged:true};
  result.observedHeadChanges=selected.filter(item=>item.observed).length;result.requests=requests;result.injectedModelCalls=injectedModelCalls;
  result.limits=['No PR, comment, review, branch or commit was modified.','A no-change observation window is not a passed live HEAD event test.','Runtime/SQLite rebuild recovery is covered here; a full main-service restart uses the separate service recovery fixture.'];
  await save();console.log(JSON.stringify({ok:true,status:result.status,observedHeadChanges:result.observedHeadChanges,elapsedSeconds:result.elapsedSeconds,requests:requests.length,
    rebuild:result.rebuild,realModelCalls:0,realModelTokens:0,realExternalWrites:0,output},null,2));
}catch(error){if(result){result.status='error';result.ok=false;result.error=error?.code??error?.message??'LIVE_TRACKING_FAILED';result.requests=requests;await save();}throw error;}
finally{token=null;f?.close();if(root)await rm(root,{recursive:true,force:true});}
