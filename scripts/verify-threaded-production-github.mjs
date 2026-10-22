/** RC02: production GitHub registration with temporary SQLite and injected official GETs only. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc02-github-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-global.sqlite'),
  AGENTS_DIR:path.join(root,'agents'),HOST:'127.0.0.1',PORT:'3010',THREADED_COLLABORATION_MODE:'closed'});
delete process.env.THREADED_RELEASE_MEMBERS_FILE;
delete process.env.THREADED_GITHUB_REGISTRATION_FILE;
const originalFetch=globalThis.fetch;let forbiddenNetwork=0,modelRequests=0,githubReads=0,tokenReads=0;
globalThis.fetch=async()=>{forbiddenNetwork++;throw new Error('Real network is forbidden in RC02 isolated acceptance');};
const {applyOrchestrationSchemaMigrations,assertOrchestrationSchemaCompatible}=await import('../apps/server/src/db/orchestrationMigrations.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const {createExecutionResourceCoordinator}=await import('../apps/server/src/execution/resources/coordinator.ts');
const {assertResourceSessionCurrent}=await import('../apps/server/src/execution/resources/sessions.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../apps/server/src/threaded/backends/evidence.ts');
const {createThreadedAuthority}=await import('../apps/server/src/threaded/authority.ts');
const {createThreadedMessaging}=await import('../apps/server/src/threaded/messaging.ts');
const {loadThreadedProductionSettings}=await import('../apps/server/src/threaded/productionSettings.ts');
const {loadThreadedProductionGithub}=await import('../apps/server/src/threaded/productionGithub.ts');
const {createThreadedProduction}=await import('../apps/server/src/threaded/production.ts');
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
const {cleanEnvironment}=await import('../apps/server/src/accounts/environment.ts');
// Imports are isolated from the daily service; every tested production operation enforces real authority.
delete process.env.AGENT_GAND_ISOLATED_WORKER;
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
const checks=[],fixtures=[],repository='test/repo',number=16,subject={kind:'github_pr',repository,number};let secretBoundary;
const fakeToken='fixture-only-token-never-a-real-credential';
const fact=(head='a'.repeat(40))=>({number,base:{repo:{full_name:repository}},head:{sha:head},user:{login:'outside-author'},
  state:'open',merged:false,merge_commit_sha:null,updated_at:'2026-10-22T00:00:00Z'});
const response=text=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:5}}),{headers:{'content-type':'application/json'}});
const rejected=async operation=>assert.rejects(Promise.resolve().then(operation),error=>!!(error?.code||error instanceof Error));
const scope={ownerId:'owner',threadId:'thread',agentId:'agent'};
const pack=(s=scope)=>({schemaVersion:1,version:1,ownerId:s.ownerId,credential:{source:'environment',name:'THREADED_GITHUB_TOKEN_TEST',version:1},
  repositories:[{repository,pullNumbers:[number],threadIds:[s.threadId],actors:[{agentId:s.agentId,githubLogin:'fixture-principal',mayAssign:true}]}]});
function assertGet(url,init){
  assert.ok([`https://api.github.com/repos/${repository}/pulls/${number}`,'https://api.github.com/user'].includes(String(url)));assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
  assert.equal(init.cache,'no-store');
  assert.match(init.headers['Cache-Control'],/no-cache|no-store/);assert.equal(init.headers.Accept,'application/vnd.github+json');
  assert.equal(init.headers['X-GitHub-Api-Version'],'2022-11-28');assert.equal(init.headers.Authorization,`Bearer ${fakeToken}`);
}
async function direct(name,{config=pack(),mode='execute',token=fakeToken,authorize=true,fetch,principal='fixture-principal'}={}){
  const file=path.join(root,`direct-${name}.json`);if(config!==null)await writeFile(file,JSON.stringify(config));
  let currentMode=mode,currentToken=token,currentAuthority=authorize,network=0,credentials=0,inTransaction=false;
  const options={file:config===null?undefined:file,ownerId:scope.ownerId,mode:()=>currentMode,
    authorizeMember:s=>currentAuthority&&s.ownerId===scope.ownerId&&s.threadId===scope.threadId&&s.agentId===scope.agentId?'fixed-member-authority':null,
    readToken:name=>{assert.equal(name,'THREADED_GITHUB_TOKEN_TEST');tokenReads++;credentials++;return currentToken;},
    assertOutsideTransaction(){assert.equal(inTransaction,false,'GitHub I/O must not occur in a SQLite transaction');},
    fetch:async(url,init)=>{network++;githubReads++;assertGet(url,init);return new URL(url).pathname==='/user'
      ?new Response(JSON.stringify({id:123,login:principal}),{headers:{'content-type':'application/json'}})
      :fetch?.(url,init)??new Response(JSON.stringify(fact()),{headers:{'content-type':'application/json'}});}};
  const provider=loadThreadedProductionGithub(options);
  return {file,options,provider,get network(){return network;},get credentials(){return credentials;},
    mode:v=>{currentMode=v;},token:v=>{currentToken=v;},authorize:v=>{currentAuthority=v;},transaction:v=>{inTransaction=v;}};
}
async function fixture(name,{github=true,mode='execute'}={}){
  const file=path.join(root,`${name}.sqlite`);let db=new Database(file,{timeout:10000});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');
  db.exec(schema);db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
  const stamp=new Date().toISOString(),accountId=`${name}-account`,agentIds=[`${name}-author`,`${name}-reviewer`],model='anthropic:fixture-model';
  db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
    .run(accountId,'RC02 isolated account','anthropic','api_key','managed',stamp,stamp);
  db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(accountId,JSON.stringify({baseUrl:'https://fixture.invalid',protocols:['anthropic-messages'],models:[model],defaultModel:model,timeoutMs:2000}),stamp);
  db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(accountId,'fixture-key-id','fixture-ciphertext','fixture-nonce','fixture-tag','fake',stamp);
  const members=agentIds.map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model,roleVersion:1,permissionVersion:1,accountId,
    accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
  for(const agentId of agentIds)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(agentId,agentId,
    JSON.stringify({id:agentId,name:agentId,model,systemPrompt:'RC02 isolated domain acceptance.',tools:THREADED_APPLICATION_TOOL_NAMES,permissionMode:'readonly',accountRef:accountId,requiresAccount:true}),'rc02-isolated',stamp,stamp);
  const releaseFile=path.join(root,`${name}-release.json`),githubFile=path.join(root,`${name}-github.json`);
  await writeFile(releaseFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:THREADED_APPLICATION_TOOL_NAMES,maxOutputTokens:128,maxInputTokens:65536,maxRequests:4,
    prices:Object.fromEntries(agentIds.map(id=>[id,{inputPerMillion:1,outputPerMillion:1}]))}));
  let currentMode='execute',currentToken=fakeToken,currentFact=fact(),production,messaging,resources,settings,activeClaim,handler=async()=> 'RC02 fixture completed';
  const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();let thread;
  function attach(withGithub){
    settings=loadThreadedProductionSettings(db,{file:releaseFile,workspaceRoot:path.join(root,name,'workspace'),privateRoot:path.join(root,name,'private'),platform:'darwin',readCredential:()=> 'fixture-only-model-key'});
    resources=createExecutionResourceCoordinator(db,{ownerNonce:`rc02:${randomUUID()}`,validateRequest:r=>assertResourceSessionCurrent(db,r),
      verifyEvidence:(_r,claim,evidence)=>{const saved=resources.getClaim(claim.claimId);return !!saved&&verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
    messaging=createThreadedMessaging(db,{authority:createThreadedAuthority(db,resources),repairIntervalMs:0});
    production=createThreadedProduction(db,{resources,messaging,settings,mode:()=>currentMode,
      ...(withGithub?{github:{file:githubFile,readToken:key=>{assert.equal(key,'THREADED_GITHUB_TOKEN_TEST');tokenReads++;return currentToken;},fetch:async(url,init)=>{
        githubReads++;assert.equal(db.inTransaction,false);assertGet(url,init);return new Response(JSON.stringify(new URL(url).pathname==='/user'?{id:123,login:'fixture-principal'}:currentFact),{headers:{'content-type':'application/json'}});}}}:{}),
      fetch:async(url)=>{assert.equal(new URL(url).origin,'https://fixture.invalid');assert.equal(db.inTransaction,false);modelRequests++;
        try{return response(await handler(activeClaim));}catch(error){f.handlerError=error;throw error;}}});
    // Explicit refresh is used below; do not allow background pollers to hide duplicated events.
    production.collaboration.close();
  }
  attach(false);production.release.change({ownerId,expectedVersion:0,requestId:'open-fixture',admissionOpen:true,dispatchOpen:true,reason:'RC02 temporary acceptance only'});
  thread=production.createThread({ownerId,title:`RC02 ${name}`,clientRequestId:'new-fixture-thread'});
  await production.shutdown(200);messaging.close();
  const configuration={schemaVersion:1,version:1,ownerId,credential:{source:'environment',name:'THREADED_GITHUB_TOKEN_TEST',version:1},
    repositories:[{repository,pullNumbers:[number],threadIds:[thread.id],actors:agentIds.map((agentId,i)=>({agentId,githubLogin:'fixture-principal',mayAssign:i===0}))}]};
  await writeFile(githubFile,JSON.stringify(configuration));currentMode=mode;attach(github);
  const f={file,releaseFile,githubFile,configuration,ownerId,thread,agentIds,accountId,get db(){return db;},get production(){return production;},
    mode:v=>{currentMode=v;},token:v=>{currentToken=v;},head:v=>{currentFact=fact(v);},
    async rebuild(nextMode=currentMode){await production.shutdown(200);messaging.close();db.close();db=new Database(file,{fileMustExist:true});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');assertOrchestrationSchemaCompatible(db);currentMode=nextMode;attach(github);},
    user(body,agentId=agentIds[0]){return production.collaboration.routing.acceptUserMessage({ownerId,threadId:thread.id,body:`@${agentId} ${body}`,clientRequestId:randomUUID()}).receipt;},
    async runFor(agentId,nextHandler,receipt){if(receipt)for(const w of receipt.wakes)production.queue.enqueueWake(w.id);production.queue.scanPending();
      for(let i=0;i<12;i++){const claim=production.queue.claimNext(`rc02:${name}`);assert.ok(claim,`Expected pending work for ${agentId}`);activeClaim=claim;f.handlerError=undefined;let matched=false;
        handler=async c=>{if(c.binding.agentId===agentId){matched=true;return nextHandler(c);}return 'Unrelated durable notification processed';};
        const result=await production.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));if(matched)return claim;}
      assert.fail(`No pending work for ${agentId}`);},
    async close(){await production.shutdown(200);messaging.close();if(db.open)db.close();}};
  fixtures.push(f);return f;
}
const tool=async(f,claim,name,input)=>JSON.parse(await f.production.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
const ok=answer=>{assert.equal(answer.ok,true,JSON.stringify(answer));return answer.result;};
try{
  assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER,undefined);
  {
    const f=await direct('absent',{config:null});assert.equal(f.provider,null);assert.equal(f.network,0);assert.equal(f.credentials,0);
    const p=await fixture('not-registered',{github:false});const status=JSON.stringify(p.production.admission());assert.match(status,/github/i);
    await p.runFor(p.agentIds[0],async claim=>{const denied=await tool(p,claim,'track_event',{idempotencyKey:'missing',jobKey:'missing',source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}});
      assert.equal(denied.ok,false);return 'Unavailable GitHub source is explicit';},p.user('Attempt unregistered GitHub tracking'));
    checks.push('RC02-01: absent registration stays explicitly unavailable in actual production factory; no GitHub credentials or transport are used and tracking fails closed');
  }
  {
    const f=await direct('valid');assert.ok(f.provider);assert.equal(f.provider.status().state,'registered');assert.equal(f.credentials,0);
    const result=await f.provider.pr.current(scope,subject);assert.equal(result.headSha,'a'.repeat(40));assert.equal(f.network,2);assert.equal(f.provider.status().state,'ready');
    assert.ok(f.provider.tracking.authorization(scope,`${repository}#${number}`));assert.equal(f.provider.tracking.authorization(scope,`${repository}#17`),null);
    assert.equal(f.provider.pr.authorize({...scope,threadId:'other'},repository),null);assert.equal(f.provider.pr.authorize({...scope,agentId:'other'},repository),null);
    assert.equal(f.provider.pr.authorize({...scope,ownerId:'other'},repository),null);assert.equal(f.provider.pr.authorize(scope,'outside/repo'),null);
    const before=f.network,credentials=f.credentials;await rejected(()=>f.provider.pr.current(scope,{...subject,number:17}));await rejected(()=>f.provider.pr.current(scope,{...subject,repository:'outside/repo'}));
    assert.equal(f.network,before);assert.equal(f.credentials,credentials);assert.ok(!JSON.stringify(f.provider.status()).includes(fakeToken));
    checks.push('RC02-02: fixed owner/Thread/actor/repository/PR allowlists bind the provider; denied scopes/PRs fail before reading a token or sending; status contains no credential bytes');
  }
  {
    for(const [label,change] of [['url',v=>({...v,url:'https://outside.invalid'})],['inline-token',v=>({...v,credential:{...v.credential,token:fakeToken}})],
      ['source',v=>({...v,credential:{...v.credential,source:'git'}})],['no-pr',v=>({...v,repositories:[{...v.repositories[0],pullNumbers:[]} ]})]]){
      const config=change(pack());await rejected(()=>direct(`invalid-${label}`,{config}));}
    const f=await direct('model-url');const before=f.network,credentials=f.credentials;await rejected(()=>f.provider.pr.current(scope,{...subject,repository:'https://outside.invalid'}));
    assert.equal(f.network,before);assert.equal(f.credentials,credentials);
    checks.push('RC02-03: registration rejects arbitrary URL, inline secret, unknown credential source and empty PR domain; malformed model subject cannot select transport or credentials');
  }
  {
    const f=await direct('missing-token',{token:null});await rejected(()=>f.provider.pr.current(scope,subject));assert.equal(f.network,0);
    const g=await direct('rotated-token');await g.provider.pr.current(scope,subject);g.token('different-fixture-value');const before=g.network;await rejected(()=>g.provider.pr.current(scope,subject));assert.equal(g.network,before);
    checks.push('RC02-04: missing token is explicitly unavailable; changing credential bytes under the same pinned registration invalidates the provider before network and requires operator repair/rebuild');
  }
  {
    const f=await direct('config-drift');await f.provider.pr.current(scope,subject);await writeFile(f.file,JSON.stringify({...pack(),version:2}));
    const before=f.network,credentials=f.credentials;await rejected(()=>f.provider.pr.current(scope,subject));assert.equal(f.network,before);assert.equal(f.credentials,credentials);
    const g=await direct('scope-revocation');g.authorize(false);assert.equal(g.provider.pr.authorize(scope,repository),null);await rejected(()=>g.provider.pr.current(scope,subject));assert.equal(g.network,0);
    checks.push('RC02-05: registration file drift and current member-authority revocation reject already installed access before token or external GET');
  }
  {
    for(const [label,value,status] of [['wrong-number',{...fact(),number:17},200],['wrong-repository',{...fact(),base:{repo:{full_name:'outside/repo'}}},200],
      ['bad-sha',{...fact(),head:{sha:'invalid'}},200],['redirect',{},302],['error',{},500]]){
      const f=await direct(label,{fetch:async()=>new Response(JSON.stringify(value),{status,headers:status===302?{Location:'https://outside.invalid'}:{}})});
      await rejected(()=>f.provider.pr.current(scope,subject));assert.equal(f.network,2);}
    const f=await direct('transaction');f.transaction(true);await rejected(()=>f.provider.pr.current(scope,subject));assert.equal(f.network,0);assert.equal(f.credentials,0);
    checks.push('RC02-06: official GET enforces no redirect/no cache, exact repository/PR response identity and SHA; redirect/error/mismatched facts fail closed, and SQLite transaction network I/O is rejected before reading a token');
  }
  {
    const f=await direct('principal-mismatch',{principal:'unexpected-principal'});await rejected(()=>f.provider.pr.current(scope,subject));assert.equal(f.network,1);
    const g=await direct('io-revocation',{fetch:async()=>{g.authorize(false);return new Response(JSON.stringify(fact()),{headers:{'content-type':'application/json'}});}});
    await rejected(()=>g.provider.pr.current(scope,subject));assert.equal(g.network,2);
    checks.push('RC02-07: the official /user response must match the pinned single GitHub principal before any PR fact is read; authorization revoked during GET prevents accepting returned bytes');
  }
  {
    for(const status of [401,403]){
      const f=await direct(`credential-http-${status}`,{fetch:async()=>new Response('{}',{status})});await rejected(()=>f.provider.pr.current(scope,subject));
      assert.equal(f.provider.status().state,'credential_unavailable');const network=f.network,credentials=f.credentials;
      assert.equal(f.provider.pr.authorize(scope,repository),null);assert.equal(f.provider.tracking.authorization(scope,`${repository}#${number}`),null);
      await rejected(()=>f.provider.pr.current(scope,subject));await rejected(()=>f.provider.tracking.observe(scope,`${repository}#${number}`));
      assert.equal(f.network,network);assert.equal(f.credentials,credentials);
    }
    const f=await direct('unknown-mode',{mode:'unknown'});assert.equal(f.provider.pr.authorize(scope,repository),null);
    assert.equal(f.provider.tracking.authorization(scope,`${repository}#${number}`),null);await rejected(()=>f.provider.pr.current(scope,subject));assert.equal(f.network,0);assert.equal(f.credentials,0);
    checks.push('RC02-08: official HTTP 401/403 creates a stable credential-unavailable fault; authorization and repeated PR/tracking reads perform no further token/network I/O, and an unknown mode is denied before I/O');
  }
  {
    const f=await direct('observe',{mode:'observe'});const before={network:f.network,credentials:f.credentials};
    assert.equal(f.provider.pr.authorize(scope,repository),null);await rejected(()=>f.provider.pr.current(scope,subject));await rejected(()=>f.provider.tracking.observe(scope,`${repository}#${number}`));
    assert.equal(f.network,before.network);assert.equal(f.credentials,before.credentials);
    const p=await fixture('observing',{mode:'observe'}),changes=p.db.prepare('SELECT total_changes() n').get().n,tokens=tokenReads,network=githubReads;
    p.production.admission();p.production.capabilities(p.ownerId,p.thread.id);assert.equal(p.production.recover().observed,true);await p.production.collaboration.tracking.refresh();
    assert.equal(p.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(tokenReads,tokens);assert.equal(githubReads,network);
    checks.push('RC02-09: observe denies provider authorization and real factory recovery/reads remain free of GitHub network, token reads and business DB changes');
  }
  {
    const f=await fixture('closed',{mode:'closed'}),network=githubReads,tokens=tokenReads;
    assert.equal(f.production.admission().canCreate,false);assert.throws(()=>f.production.createThread({ownerId:f.ownerId,title:'No activation',clientRequestId:'closed'}));
    assert.equal(githubReads,network);assert.equal(tokenReads,tokens);
    checks.push('RC02-10: installing GitHub registration does not open default closed mode or create/adopt new work, even when a fixture retains previously granted Thread controls');
  }
  {
    const f=await fixture('tracking');let waitId;
    await f.runFor(f.agentIds[0],async claim=>{const result=ok(await tool(f,claim,'track_event',{idempotencyKey:'head-wait',jobKey:'head-wait',source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}}));waitId=result.waitId;return 'Durable baseline registered';},f.user('Track this permitted PR HEAD'));
    const baseline=f.db.prepare('SELECT * FROM threaded_waits WHERE id=?').get(waitId);assert.equal(baseline.state,'awaiting');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?').get(waitId).n,0);
    await f.production.collaboration.tracking.refresh();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?').get(waitId).n,0);
    f.head('b'.repeat(40));await f.production.collaboration.tracking.refresh();await f.production.collaboration.tracking.refresh();
    const settled=f.db.prepare('SELECT state,outcome FROM threaded_waits WHERE id=?').get(waitId);assert.equal(settled.state,'settled');assert.equal(JSON.parse(settled.outcome).event.headChanged,true);
    const callbacks=f.db.prepare('SELECT id,message_id FROM threaded_collaboration_callbacks WHERE source_id=?').all(waitId);assert.equal(callbacks.length,1);
    await f.rebuild();const requests=modelRequests;f.production.recover();await f.production.collaboration.tracking.refresh();f.production.collaboration.recover();
    assert.deepEqual(f.db.prepare('SELECT id,message_id FROM threaded_collaboration_callbacks WHERE source_id=?').all(waitId),callbacks);assert.equal(modelRequests,requests);
    checks.push('RC02-11: actual production tracking persists a no-wake baseline, ignores unchanged HEAD, emits one injected new-HEAD callback and preserves it across SQLite/factory rebuild without model replay');
  }
  {
    const f=await fixture('revoked');let waitId;
    await f.runFor(f.agentIds[0],async claim=>{waitId=ok(await tool(f,claim,'track_event',{idempotencyKey:'revoked-wait',jobKey:'revoked-wait',source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}})).waitId;return 'Awaiting authorized PR';},f.user('Register before account revocation'));
    f.db.prepare('INSERT INTO account_revocations VALUES(?,?)').run(f.accountId,new Date().toISOString());f.db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(f.accountId);
    const network=githubReads,tokens=tokenReads;await f.production.collaboration.tracking.refresh();assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(waitId).state,'withdrawn');
    assert.equal(githubReads,network);assert.equal(tokenReads,tokens);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?').get(waitId).n,0);
    checks.push('RC02-12: actual account revocation withdraws the persisted wait using current release/member pins, sends no request, reads no token and does not turn revocation into business success');
  }
  {
    const f=await fixture('permission-revoked');let waitId;
    await f.runFor(f.agentIds[0],async claim=>{waitId=ok(await tool(f,claim,'track_event',{idempotencyKey:'permission-wait',jobKey:'permission-wait',source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}})).waitId;return 'Awaiting pinned permission';},f.user('Track before permission version changes'));
    f.db.prepare('UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id=?').run(f.thread.id,f.agentIds[0]);
    const network=githubReads,tokens=tokenReads;await f.production.collaboration.tracking.refresh();assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(waitId).state,'withdrawn');
    assert.equal(githubReads,network);assert.equal(tokenReads,tokens);
    checks.push('RC02-13: changing a joined member permission version invalidates the release grant and withdraws its old tracking wait before token/network');
  }
  {
    const f=await fixture('stored-event-revoked');let waitId;
    await f.runFor(f.agentIds[0],async claim=>{waitId=ok(await tool(f,claim,'track_event',{idempotencyKey:'stored-event',jobKey:'stored-event',source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}})).waitId;return 'Awaiting durable fact';},f.user('Persist a wait for the crash window'));
    const record=JSON.parse(f.db.prepare('SELECT record FROM threaded_waits WHERE id=?').get(waitId).record);
    // Seed an authenticated-producer event as a crash snapshot: durable fact exists, settlement has not run.
    const event={type:'github_pr',headSha:'b'.repeat(40),state:'open',merged:false,mergeCommitSha:null,headChanged:true,__authorization:record.trackingAuthorization};
    const identity=randomUUID();f.db.prepare('INSERT INTO threaded_tracking_events(owner_id,source,subject,event_key,request_hash,record,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(f.ownerId,'github_pr',`${repository}#${number}`,identity,identity,JSON.stringify(event),Date.now());
    f.token(null);const network=githubReads;f.production.collaboration.cooperation.recover();
    const wait=f.db.prepare('SELECT state,outcome FROM threaded_waits WHERE id=?').get(waitId);assert.notEqual(wait.state,'settled');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?').get(waitId).n,0);assert.equal(githubReads,network);
    checks.push('RC02-14: a persisted matching event from the previous provider authorization cannot settle its wait after credential revocation; recovery emits no callback or business-success fact');
  }
  {
    const f=await fixture('waiting-callback-revoked');let waitId;
    await f.runFor(f.agentIds[0],async claim=>{waitId=ok(await tool(f,claim,'track_event',{idempotencyKey:'paused-callback',jobKey:'paused-callback',source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}})).waitId;return 'Awaiting fact before pause';},f.user('Register a wait whose callback will be paused'));
    const record=JSON.parse(f.db.prepare('SELECT record FROM threaded_waits WHERE id=?').get(waitId).record);
    f.db.prepare("UPDATE threaded_threads SET state='paused' WHERE id=?").run(f.thread.id);
    const identity=randomUUID(),event={type:'github_pr',headSha:'b'.repeat(40),state:'open',merged:false,mergeCommitSha:null,headChanged:true,__authorization:record.trackingAuthorization};
    f.db.prepare('INSERT INTO threaded_tracking_events(owner_id,source,subject,event_key,request_hash,record,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(f.ownerId,'github_pr',`${repository}#${number}`,identity,identity,JSON.stringify(event),Date.now());
    f.production.collaboration.cooperation.recover();assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(waitId).state,'settled');
    assert.equal(f.db.prepare('SELECT state FROM threaded_collaboration_callbacks WHERE source_id=?').get(waitId).state,'waiting');
    f.token(null);f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(f.thread.id);
    const messages=f.db.prepare('SELECT COUNT(*) n FROM threaded_messages').get().n,network=githubReads;f.production.collaboration.cooperation.recover();
    const callback=f.db.prepare('SELECT state,message_id FROM threaded_collaboration_callbacks WHERE source_id=?').get(waitId);assert.equal(callback.state,'rejected');assert.equal(callback.message_id,null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_messages').get().n,messages);assert.equal(githubReads,network);
    checks.push('RC02-15: a tracking callback already settled but held by pause is reauthorized before delivery; provider revocation rejects it after resume without creating an old ordinary wake');
  }
  {
    const f=await fixture('review');let action,context,report,completed,gate;const [author,reviewer]=f.agentIds;
    await f.runFor(author,async claim=>{action=ok(await tool(f,claim,'transfer_action',{idempotencyKey:'review-transfer',subject,predicate:'review_delivered',family:'review',successorSlot:'review',targets:[reviewer]}));return 'Assigned exact current-head review';},f.user('Request independent local review'));
    await f.runFor(reviewer,async claim=>{context=ok(await tool(f,claim,'review_context',{actionId:action.actionId}));
      const input={idempotencyKey:'local-review',actionId:action.actionId,expectedGeneration:context.generation,expectedVersion:context.workflowVersion,authorAgentId:context.authorAgentId,
        acceptedSourceMessageId:context.acceptedSourceMessageId,acceptedRevision:context.acceptedRevision,reviewedHeadSha:context.headSha,verdict:'changes_requested',findings:['Injected review fixture is not an engineering approval.'],resolvedFindingIds:[],body:'RC02 local review delivery only.'};
      const stale=await tool(f,claim,'submit_review',{...input,idempotencyKey:'old-head',reviewedHeadSha:'f'.repeat(40),verdict:'approved',findings:[]});assert.equal(stale.code,'THREADED_REVIEW_STALE_HEAD');
      report=ok(await tool(f,claim,'submit_review',input));assert.equal(report.actionCompleted,false);assert.equal(report.approvalGateSatisfied,false);
      completed=ok(await tool(f,claim,'complete_action',{idempotencyKey:'complete-delivery',actionId:action.actionId,expectedGeneration:context.generation,evidenceId:report.evidenceId}));
      gate=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:report.version}));assert.equal(completed.state,'completed');assert.equal(gate.approvalGateSatisfied,false);return 'Changes request delivered; gate remains blocked';});
    const prior=f.db.prepare('SELECT record FROM threaded_review_workflows WHERE action_id=?').get(action.actionId).record;
    await f.rebuild();assert.equal(f.db.prepare('SELECT record FROM threaded_review_workflows WHERE action_id=?').get(action.actionId).record,prior);
    await f.runFor(author,async claim=>{const wake=f.production.collaboration.cooperation.source(claim.binding);assert.equal(wake.id,report.messageId);assert.equal(f.production.collaboration.actions.capture(claim.binding),null);
      const current=ok(await tool(f,claim,'check_review_gate',{actionId:action.actionId,expectedVersion:report.version}));assert.equal(current.approvalGateSatisfied,false);return 'Ordinary local A2A report received after rebuild';});
    checks.push('RC02-16: actual factory PR source/resolver binds current HEAD and accepted revision, rejects old-HEAD approval, delivers a local independent changes request, separates completion from gate and preserves ordinary author delivery after rebuild');
  }
  {
    let tablesScanned=0,rowsScanned=0;
    const serialize=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?String(item):item);
    const assertNoToken=value=>assert.ok(!serialize(value).includes(fakeToken),'GitHub credential bytes must not cross into persisted/public facts');
    for(const f of fixtures){
      for(const {name} of f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
        const rows=f.db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all();tablesScanned++;rowsScanned+=rows.length;assertNoToken(rows);
        for(const row of rows)for(const value of Object.values(row))if(Buffer.isBuffer(value))assert.ok(!value.includes(Buffer.from(fakeToken)),'Raw DB blob cannot retain GitHub credential bytes');
      }
      assertNoToken(f.production.admission());assertNoToken(f.production.capabilities(f.ownerId,f.thread.id));
    }
    const f=await direct('public-secret-boundary'),pr=await f.provider.pr.current(scope,subject),tracking=await f.provider.tracking.observe(scope,`${repository}#${number}`);
    assertNoToken({pr,tracking,authorization:f.provider.pr.authorize(scope,repository),trackingAuthorization:f.provider.tracking.authorization(scope,`${repository}#${number}`),status:f.provider.status()});
    const key='THREADED_GITHUB_TOKEN_RC02_WORKER',workerSecret='fixture-only-worker-secret-not-a-real-token',previous=process.env[key];
    try{process.env[key]=workerSecret;const workerEnvironment=cleanEnvironment();assert.equal(Object.hasOwn(workerEnvironment,key),false);assert.ok(!serialize(workerEnvironment).includes(workerSecret));}
    finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
    secretBoundary={tablesScanned,rowsScanned,rawTokenPersisted:false,tokenInPublicFacts:false,workerInheritsGithubToken:false,workerEnvironmentRestored:true};
    checks.push('RC02-17: every temporary DB user table and public admission/capability/PR/tracking result excludes the raw fixture credential; cleanEnvironment removes a synthetic GitHub token key/value from worker inheritance and the test restores the parent environment');
  }
  {
    const f=await direct('principal-concurrency');let resolveSecond,userGets=0,prGets=0,network=0;
    const secondResponse=new Promise(resolve=>{resolveSecond=resolve;});
    const successfulUser={ok:true,status:200,redirected:false,url:'https://api.github.com/user',headers:new Headers(),body:{
      getReader(){let reads=0;return {read(){
        if(reads++===0)return Promise.resolve({done:false,value:Buffer.from(JSON.stringify({id:123,login:'fixture-principal'}))});
        // Run the other GET's 401 after this readJson's final authorization check,
        // but before its caller resumes and tries to publish principalVerified/ready.
        queueMicrotask(()=>resolveSecond(new Response('{}',{status:401})));
        return Promise.resolve({done:true});
      },releaseLock(){}};},async cancel(){}}};
    const provider=loadThreadedProductionGithub({...f.options,fetch:(url,init)=>{
      network++;githubReads++;assertGet(url,init);
      if(new URL(url).pathname==='/user')return ++userGets===1?successfulUser:secondResponse;
      prGets++;return Promise.resolve(new Response(JSON.stringify(fact())));
    }});
    const results=await Promise.allSettled([provider.pr.current(scope,subject),provider.pr.current(scope,subject)]);
    assert.equal(userGets,2);assert.ok(results.every(result=>result.status==='rejected'));assert.equal(prGets,0);
    assert.equal(provider.status().state,'credential_unavailable');const reads=f.credentials,requests=network;
    assert.equal(provider.pr.authorize(scope,repository),null);assert.equal(provider.tracking.authorization(scope,`${repository}#${number}`),null);
    await rejected(()=>provider.pr.current(scope,subject));assert.equal(f.credentials,reads);assert.equal(network,requests);
    checks.push('RC02-18: concurrent first-principal GETs interleave a successful /user body with another 401; both callers reject, the permanent credential fault survives the old success continuation, no PR fact is accepted and later access performs no token/network I/O');
  }
  assert.equal(forbiddenNetwork,0);
  const report={ok:true,stage:'RC02',groups:checks.length,checks,isolatedExecutionBypass:false,
    scope:'Temporary SQLite with actual production release/settings/runtime factory, pinned registration and injected GitHub REST GET/model transport. No daily data, real credentials, suppliers or external writes.',
    injectedGithubGets:githubReads,injectedTokenReads:tokenReads,injectedModelHttpRequests:modelRequests,secretBoundary,realNetworkRequests:0,realModelRequests:0,realModelTokens:0,realExternalWrites:0,
    naturalHeadEvent:'not_observed; RC04 remains pending',productionRelease:false};
  const output=process.env.THREADED_RC02_OUTPUT??'docs/reports/evidence/threaded-rc02-production-github/isolated.json';await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{for(const f of fixtures.reverse())await f.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
