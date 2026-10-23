/** Actual cooperation/SQLite/ACL integration with server-installed source policies and scripted model transport. */
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc04-sharing-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {githubPrTrackingSource}=await import('../apps/server/src/threaded/tracking.ts');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('RC04_SHARING_NO_REAL_NETWORK');};
const fixtures=[],checks=[],proofs=[];let scriptedCalls=0;
const output=path.resolve(process.env.THREADED_RC04_SHARING_OUTPUT??'docs/reports/evidence/threaded-rc04/sharing.json');
const repository='zts212653/clowder-ai',subject=`${repository}#123`,caller='api-member',reviewer='reviewer',later='later-member';
const response=body=>Response.json({id:randomUUID(),type:'message',content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:12,output_tokens:4}});
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const counts=f=>({messages:count(f,'threaded_messages'),wakes:count(f,'threaded_wakes')});
const waitRecord=(f,id)=>JSON.parse(f.db.prepare('SELECT record FROM threaded_waits WHERE id=?').get(id).record);
const callback=(f,id)=>f.db.prepare('SELECT id,state,message_id,reason,record FROM threaded_collaboration_callbacks WHERE source_id=?').get(id);
const readable=(f,agentId,id)=>f.runtime.messages.getMessage({ownerId:f.thread.ownerId,threadId:f.thread.id,viewer:{kind:'agent',agentId}},id);
async function fixture(name,{sharing=false,granted=[caller,reviewer,later]}={}){
  let f,head='a'.repeat(40),genericSignal=0;
  const grants=new Map(granted.map(agent=>[agent,`current:${agent}:v1`]));
  const authority=scope=>scope.ownerId===f?.thread.ownerId&&scope.threadId===f?.thread.id?grants.get(scope.agentId)??null:null;
  const github=githubPrTrackingSource({authorize:(scope,repo)=>repo===repository?authority(scope):null,
    fetch:async endpoint=>{assert.equal(endpoint,`/repos/${repository}/pulls/123`);return {head:{sha:head},state:'open',merged:false,merge_commit_sha:null,updated_at:'2026-10-22T12:00:00Z'};}});
  if(sharing)github.deliveryAuthorization=(scope,target)=>target===subject&&authority(scope)
    ?Object.fromEntries([...grants].map(([agent,auth])=>[agent,auth])):null;
  const generic={authorization:scope=>authority(scope),async observe(_scope,_subject,previous){
    const event={type:'generic_fixture',signal:genericSignal};return previous?.signal===genericSignal?[]:[{key:`signal-${genericSignal}`,event}];}};
  f=await openBackendRuntimeFixture(root,name,{agentIds:[caller,reviewer,later],applicationTools:THREADED_APPLICATION_TOOL_NAMES,
    trackingSources:{github_pr:github,generic_fixture:generic},fetch:async()=>{scriptedCalls++;
      try{return response(await f.handler(f.activeClaim));}catch(error){f.handlerError=error;throw error;}}});
  fixtures.push(f);for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  Object.assign(f,{grants,github,generic,head:value=>{head=value;},signal:()=>{genericSignal++;}});return f;
}
async function register(f,{source='github_pr',target=subject,match={type:'github_pr',headChanged:true},privateAudience}={}){
  const receipt=f.user('RC04 sharing authority integration fixture',[caller],privateAudience?{visibility:'private',audience:privateAudience}:{});
  for(const wake of receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
  const claim=f.runtime.queue.claimNext('rc04-sharing');assert.ok(claim);assert.equal(claim.binding.agentId,caller);
  f.activeClaim=claim;let waitId;
  f.handler=async()=>{const answer=JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,'track_event',{
    idempotencyKey:randomUUID(),jobKey:randomUUID(),source,subject:target,match},randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
    assert.equal(answer.ok,true,JSON.stringify(answer));waitId=answer.result.waitId;return 'Durable tracking wait registered under its exact input privacy and authority';};
  const executed=await f.runtime.executeClaim(claim);f.runtime.collaboration.close();if(f.handlerError)throw f.handlerError;
  assert.equal(executed.status,'completed',JSON.stringify(executed));assert.ok(waitId);assert.equal(callback(f,waitId),undefined);
  return {waitId,sourceMessageId:receipt.message.id,record:waitRecord(f,waitId)};
}
async function refresh(f,id){await f.runtime.collaboration.tracking.refresh();f.runtime.collaboration.close();f.runtime.collaboration.cooperation.recover();return callback(f,id);}
function deliveredProof(f,id,expectedAudience){
  const row=callback(f,id);assert.equal(row.state,'delivered');assert.ok(row.message_id);const message=readable(f,caller,row.message_id);
  assert.equal(message.visibility,'private');assert.deepEqual([...message.audience].sort(),[...expectedAudience].sort());assert.deepEqual(message.targets,[caller]);
  for(const agent of [caller,reviewer,later])assert.equal(!!readable(f,agent,row.message_id),expectedAudience.includes(agent));
  const identity={callbackId:row.id,messageId:row.message_id,audience:message.audience};f.runtime.collaboration.cooperation.recover();
  assert.equal(callback(f,id).id,identity.callbackId);assert.equal(callback(f,id).message_id,identity.messageId);return identity;
}
try{
  {
    const f=await fixture('generic-default');const wait=await register(f,{source:'generic_fixture',target:'generic-subject',match:{type:'generic_fixture',signal:1}});
    assert.equal(wait.record.trackingDeliveryAuthorities,undefined);f.signal();await refresh(f,wait.waitId);
    proofs.push({case:'generic-default',waitId:wait.waitId,...deliveredProof(f,wait.waitId,[caller])});
    checks.push('RC04-S01: generic tracking source without a server sharing policy stays caller-only private in actual cooperation SQLite callback and message ACL');
  }
  {
    const f=await fixture('thread-default');const wait=await register(f,{source:'thread_messages',target:f.thread.id,match:{type:'message',origin:'user'}});
    assert.equal(wait.record.trackingDeliveryAuthorities,undefined);f.user('A genuinely later local Thread user event',[]);await refresh(f,wait.waitId);
    proofs.push({case:'thread-message-default',waitId:wait.waitId,...deliveredProof(f,wait.waitId,[caller])});
    checks.push('RC04-S02: built-in thread_messages tracking remains caller-only private and does not inherit GitHub domain sharing');
  }
  {
    const f=await fixture('private-intersection',{sharing:true});const wait=await register(f,{privateAudience:[caller,reviewer]});
    assert.deepEqual(Object.keys(wait.record.trackingDeliveryAuthorities).sort(),[caller,reviewer].sort());assert.equal(wait.record.scope.visibility,'private');
    assert.equal(readable(f,later,wait.sourceMessageId),null);f.head('b'.repeat(40));await refresh(f,wait.waitId);
    proofs.push({case:'private-original-intersection',waitId:wait.waitId,originalSourceId:wait.sourceMessageId,...deliveredProof(f,wait.waitId,[caller,reviewer])});
    checks.push('RC04-S03: trusted GitHub sharing intersects the private original source audience and excludes another currently authorized registered member');
  }
  for(const mutation of ['recipient-authority','recipient-identity']){
    const f=await fixture(`paused-${mutation}`,{sharing:true,granted:[caller,reviewer]});const wait=await register(f);
    assert.deepEqual(Object.keys(wait.record.trackingDeliveryAuthorities).sort(),[caller,reviewer].sort());
    assert.equal(typeof wait.record.trackingDeliveryIdentities[reviewer],'string');f.db.prepare("UPDATE threaded_threads SET state='paused' WHERE id=?").run(f.thread.id);
    const before=counts(f);f.head('b'.repeat(40));const paused=await refresh(f,wait.waitId);
    assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(wait.waitId).state,'settled');assert.equal(paused.state,'waiting');assert.equal(paused.message_id,null);
    assert.deepEqual(counts(f),before);
    if(mutation==='recipient-authority')f.grants.set(reviewer,'current:reviewer:v2');
    else f.db.prepare('UPDATE threaded_members SET version=version+1 WHERE thread_id=? AND agent_id=?').run(f.thread.id,reviewer);
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(f.thread.id);f.runtime.collaboration.cooperation.recover();
    const rejected=callback(f,wait.waitId);assert.equal(rejected.state,'rejected');assert.equal(rejected.reason,'THREADED_TRACKING_DELIVERY_AUTHORITY_CHANGED');assert.equal(rejected.message_id,null);
    assert.deepEqual(counts(f),before);f.runtime.collaboration.cooperation.recover();assert.deepEqual(counts(f),before);
    proofs.push({case:mutation,waitId:wait.waitId,callbackId:rejected.id,state:rejected.state,reason:rejected.reason,newMessages:0,newWakes:0});
    checks.push(mutation==='recipient-authority'
      ?'RC04-S04: a settled paused callback rejects changed captured recipient authority on resume and creates zero messages or wakes'
      :'RC04-S05: a settled paused callback separately rejects changed recipient member identity even when the custom source authority string is unchanged');
  }
  {
    const f=await fixture('later-grant',{sharing:true,granted:[caller,reviewer]});const wait=await register(f);
    assert.deepEqual(Object.keys(wait.record.trackingDeliveryAuthorities).sort(),[caller,reviewer].sort());f.grants.set(later,'current:later-member:v1');
    f.head('b'.repeat(40));await refresh(f,wait.waitId);
    proofs.push({case:'new-recipient-not-retroactive',waitId:wait.waitId,...deliveredProof(f,wait.waitId,[caller,reviewer])});
    checks.push('RC04-S06: a new recipient grant after wait registration cannot join its frozen audience or read the delivered callback');
  }
  {
    const f=await fixture('legacy-default');const wait=await register(f);assert.equal(wait.record.trackingDeliveryAuthorities,undefined);
    f.github.deliveryAuthorization=()=>Object.fromEntries(f.grants);f.head('b'.repeat(40));await refresh(f,wait.waitId);
    proofs.push({case:'no-policy-record-not-upgraded',waitId:wait.waitId,...deliveredProof(f,wait.waitId,[caller])});
    checks.push('RC04-S07: installing a sharing policy after a wait was registered cannot broaden an old record that captured no sharing authority');
  }
  const result={ok:true,scope:'Actual runtime cooperation SQLite callbacks messages and source ACL using a server custom GitHub sharing policy with scripted model replies; production registration deliveryAuthorization is separately covered by six dedicated groups',
    completedAt:new Date().toISOString(),groups:checks.length,checks,proofs,scriptedModelCalls:scriptedCalls,realCredentialReads:0,realNetworkRequests:0,realModelCalls:0,realExternalWrites:0,
    limits:['Source PR facts and sharing grants in this test are injected server fixtures; this does not establish real GitHub new HEAD observation or production engineering review acceptance.']};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:true,groups:checks.length,scriptedModelCalls:scriptedCalls,realNetworkRequests:0,output},null,2));
}catch(error){console.error(JSON.stringify({ok:false,code:'RC04_SHARING_INTEGRATION_VERIFICATION_FAILED',completedGroups:checks.length,
  diagnostic:process.env.THREADED_RC04_SHARING_DEBUG==='1'?String(error?.stack??error):undefined}));process.exitCode=1;}
finally{globalThis.fetch=originalFetch;for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
