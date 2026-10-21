import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const root=await mkdtemp(path.join(tmpdir(),'agent-gand-t12-production-'));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-global.sqlite'),
  AGENTS_DIR:path.join(root,'agents'),HOST:'127.0.0.1',PORT:'3010',ACCOUNT_TRUSTED_ORIGINS:'http://127.0.0.1:3010',THREADED_COLLABORATION_MODE:'closed'});
delete process.env.THREADED_RELEASE_MEMBERS_FILE;
const originalFetch=globalThis.fetch;let externalRequests=0,injectedRequests=0,credentialResolutions=0;const fixtures=[],checks=[];
globalThis.fetch=async()=>{externalRequests++;throw new Error('No real model or external network requests permitted');};
const {applyOrchestrationSchemaMigrations,assertOrchestrationSchemaCompatible}=await import('../apps/server/src/db/orchestrationMigrations.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const {createExecutionResourceCoordinator}=await import('../apps/server/src/execution/resources/coordinator.ts');
const {assertResourceSessionCurrent}=await import('../apps/server/src/execution/resources/sessions.ts');
const {createThreadedAuthority}=await import('../apps/server/src/threaded/authority.ts');
const {createThreadedMessaging}=await import('../apps/server/src/threaded/messaging.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../apps/server/src/threaded/backends/evidence.ts');
const {loadThreadedProductionSettings}=await import('../apps/server/src/threaded/productionSettings.ts');
const {createThreadedProduction}=await import('../apps/server/src/threaded/production.ts');
const {createThreadedAccess}=await import('../apps/server/src/threaded/access.ts');
const {createThreadedView}=await import('../apps/server/src/threaded/view.ts');
const {registerThreadedAccessBridge,registerThreadedRoutes}=await import('../apps/server/src/api/threadedRoutes.ts');
const management=await import('../apps/server/src/accounts/access.ts');
const database=await import('../apps/server/src/db/database.ts');
const {threadedRuntime:defaultProduction}=await import('../apps/server/src/threaded/service.ts');
const {default:Fastify}=await import('../apps/server/node_modules/fastify/fastify.js');
const {default:websocket}=await import('../apps/server/node_modules/@fastify/websocket/index.js');
// Exercise the actual production authority path, never the fixture-only executor bypass.
delete process.env.AGENT_GAND_ISOLATED_WORKER;
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
const response=(text='production fixture completed',tools=[])=>new Response(JSON.stringify({type:'message',id:randomUUID(),
  content:[...(text?[{type:'text',text}]:[]),...tools.map(tool=>({type:'tool_use',id:tool.id??randomUUID(),name:tool.name,input:tool.input}))],
  stop_reason:tools.length?'tool_use':'end_turn',usage:{input_tokens:30,output_tokens:9}}),{headers:{'content-type':'application/json'}});
const wait=async(predicate,label,timeout=5000)=>{const end=Date.now()+timeout;while(!predicate()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(predicate(),label);};
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
async function fixture(name,{pack=true,mode='closed',fetch,tools=['post_message'],readCredential,memberCount=1}={}){
  const file=path.join(root,`${name}.sqlite`),db=new Database(file,{timeout:10000});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.exec(schema);db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
  const stamp=new Date().toISOString(),agentId=`${name}-agent`,accountId=`${name}-account`,model='anthropic:fixture-model';
  const member={agentId,backend:'api',backendVersion:'threaded-http-v1',model,roleVersion:1,permissionVersion:1,
    accountId,accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null};
  const definition={id:agentId,name:agentId,model,systemPrompt:'Respond using platform tools only when asked. Keep all fixture responses concise.',
    tools,permissionMode:'readonly',accountRef:accountId,requiresAccount:true};
  const agentIds=Array.from({length:memberCount},(_,i)=>i===0?agentId:`${name}-peer-${i}`),members=agentIds.map(id=>({...member,agentId:id}));
  db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
    .run(accountId,'Isolated metadata','anthropic','api_key','managed',stamp,stamp);
  db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(accountId,JSON.stringify({baseUrl:'https://fixture.invalid',protocols:['anthropic-messages'],models:[model],defaultModel:model,timeoutMs:2000}),stamp);
  db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(accountId,'fixture-only-key-id','fixture-only-ciphertext','fixture-only-nonce','fixture-only-tag','fake',stamp);
  for(const id of agentIds)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id,JSON.stringify({...definition,id,name:id}),'t12-isolated',stamp,stamp);
  const packFile=path.join(root,`${name}-pack.json`);await writeFile(packFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:tools,
    maxOutputTokens:128,maxInputTokens:65536,maxRequests:3,prices:Object.fromEntries(agentIds.map(id=>[id,{inputPerMillion:1,outputPerMillion:1}]))}));
  const settings=loadThreadedProductionSettings(db,{file:pack?packFile:undefined,workspaceRoot:path.join(root,name,'workspace'),privateRoot:path.join(root,name,'private'),platform:'darwin',
    readCredential(id,version){assert.equal(id,accountId);assert.equal(version,1);credentialResolutions++;return readCredential?.(id,version)??'fixture-only-nonsecret';}});
  const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();let currentMode=mode,resources;
  resources=createExecutionResourceCoordinator(db,{ownerNonce:`t12:${randomUUID()}`,validateRequest:request=>assertResourceSessionCurrent(db,request),
    verifyEvidence:(_request,claim,evidence)=>{const saved=resources.getClaim(claim.claimId);return !!saved&&verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
  const messaging=createThreadedMessaging(db,{authority:createThreadedAuthority(db,resources),repairIntervalMs:0});
  let f;const production=createThreadedProduction(db,{resources,messaging,settings,mode:()=>currentMode,
    fetch:async(url,init)=>{assert.equal(new URL(url).origin,'https://fixture.invalid');assert.equal(db.inTransaction,false);injectedRequests++;return await(fetch?.(f,url,init)??response());}});
  const access=createThreadedAccess(()=>ownerId),view=createThreadedView(db,{store,messages:production.messaging.messages,capabilities:production.capabilities});
  const context={store,access,messages:production.messaging.messages,lifecycle:production.lifecycle,collaboration:production.collaboration,view,
    operations:production,messageAdmission:production.messageAdmission,onMessageNotification:production.messaging.onNotification};
  const app=Fastify({logger:false});await app.register(websocket);await app.register(async accounts=>{
    accounts.addHook('onRequest',async request=>{management.assertManagementBoundary(request);if(request.routeOptions.url!=='/api/accounts/session'||request.method!=='POST')management.requireManagementSession(request);});
    accounts.post('/api/accounts/session',async(request,reply)=>management.createManagementSession(request,reply));await registerThreadedAccessBridge(accounts,context);
  });await registerThreadedRoutes(app,context);await app.ready();
  const headers={host:'127.0.0.1:3010',origin:'http://127.0.0.1:3010'};
  const parent=await app.inject({method:'POST',url:'/api/accounts/session',headers:{...headers,'x-gand-bootstrap':'1'}});assert.equal(parent.statusCode,200,parent.body);
  const grant=await app.inject({method:'POST',url:'/api/accounts/threaded/access-session',headers:{...headers,cookie:parent.headers['set-cookie'].split(';')[0],'x-gand-csrf':parent.json().csrfToken}});assert.equal(grant.statusCode,200,grant.body);
  const auth={...headers,cookie:grant.headers['set-cookie'].split(';')[0],'x-gand-csrf':grant.json().csrfToken};
  const request=(method,url,payload,extra={})=>app.inject({method,url,headers:{...auth,...extra},...(payload===undefined?{}:{payload})});
  f={file,db,settings,production,store,ownerId,agentId,agentIds,member,packFile,resources,messaging,access,app,auth,request,mode(value){currentMode=value;},
    async control(extra={}){const r=await request('POST','/api/threaded/release/controls',{expectedVersion:production.release.state(ownerId).version,requestId:randomUUID(),reason:'isolated production acceptance',admissionOpen:true,dispatchOpen:true,...extra});assert.equal(r.statusCode,200,r.body);return r.json();},
    async thread(title='Isolated release Thread',clientRequestId=randomUUID()){const r=await request('POST','/api/threaded/threads',{title,clientRequestId});assert.equal(r.statusCode,200,r.body);return r.json().thread;},
    message(t,body='production ingress',clientRequestId=randomUUID()){return request('POST',`/api/threaded/threads/${t.id}/messages`,{body,clientRequestId});},
    async close(){await production.shutdown(200);await app.close();access.close();messaging.close();if(db.open)db.close();}};fixtures.push(f);return f;
}
try{
  assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER,undefined);
  {
    const f=await fixture('no-pack',{pack:false});const before=credentialResolutions;
    assert.equal(f.production.admission().configured,false);assert.equal(f.production.diagnostics().executionEnabled,false);
    assert.equal((await f.request('POST','/api/threaded/threads',{title:'No release pack',clientRequestId:'closed'})).statusCode,403);
    f.mode('execute');await f.control();assert.equal((await f.request('POST','/api/threaded/threads',{title:'No adoption',clientRequestId:'execute-no-pack'})).statusCode,403);
    assert.equal(count(f,'threaded_threads'),0);assert.equal(credentialResolutions,before);assert.equal(injectedRequests,0);
    assert.equal((await f.app.inject({url:'/api/threaded/release',headers:{host:'127.0.0.1:3010'}})).statusCode,401);
    checks.push('OPS01: actual production factory without a registered release pack stays closed/no executor in every configured mode; authenticated routes refuse room creation and never resolve credentials or start a model');
  }
  {
    const f=await fixture('closed-pack');const before=injectedRequests,credentials=credentialResolutions;
    await f.control();assert.equal(f.production.admission().configured,true);assert.equal(f.production.admission().canCreate,false);
    assert.equal((await f.request('POST','/api/threaded/threads',{title:'Closed despite explicit controls',clientRequestId:'still-closed'})).statusCode,403);
    f.production.recover();f.production.startDispatch();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(count(f,'threaded_threads'),0);assert.equal(injectedRequests,before);assert.equal(credentialResolutions,credentials);
    checks.push('OPS01: a valid pinned release pack plus open durable flags still cannot create new work while configured mode stays closed; recovery/dispatch scans alone never decrypt an account or invent a Thread');
  }
  {
    const f=await fixture('observe',{mode:'observe'});
    const t=f.store.createThread({title:'Observe seeded existing room',members:[{agentId:f.agentId,handle:f.agentId,roleVersion:1,permissionVersion:1,accountVersion:1}]});
    f.production.collaboration.routing.configure(f.ownerId,t.id,{preferred:[],defaultAgent:f.agentId},0);
    const before=f.db.prepare('SELECT total_changes() n').get().n,credentials=credentialResolutions;
    assert.equal(f.production.recover().observed,true);assert.equal((await f.request('GET','/api/threaded/release')).statusCode,200);assert.equal((await f.request('GET','/api/threaded/admission')).json().canCreate,false);
    assert.equal((await f.request('POST','/api/threaded/threads',{title:'Read only observe',clientRequestId:'observe'})).statusCode,403);
    assert.equal((await f.request('PUT',`/api/threaded/threads/${t.id}/routing-policy`,{expectedVersion:1,policy:{preferred:[],defaultAgent:f.agentId}})).statusCode,403);
    for(const [url,payload] of [
      [`/api/threaded/threads/${t.id}/controls`,{action:'stop',requestId:'observe-stop-thread'}],
      [`/api/threaded/threads/${t.id}/members/${f.agentId}/controls`,{action:'pause',requestId:'observe-pause-member'}],
      [`/api/threaded/threads/${t.id}/invocations/forged-invocation/controls`,{action:'stop',requestId:'observe-stop-invocation'}],
      [`/api/threaded/threads/${t.id}/approvals/forged-approval/decision`,{decision:'approve',requestId:'observe-approval'}],
      ['/api/threaded/release/controls',{expectedVersion:0,requestId:'observe-release',admissionOpen:true,dispatchOpen:true,reason:'must remain read only'}],
      [`/api/threaded/threads/${t.id}/decisions/forged-decision/responses`,{expectedVersion:1,clientRequestId:'observe-decision',body:'not permitted'}],
    ]){const denied=await f.request('POST',url,payload);assert.equal(denied.statusCode,403,denied.body);assert.equal(denied.json().code,'THREADED_RELEASE_OBSERVE_ONLY');}
    assert.equal((await f.request('POST',`/api/threaded/threads/${t.id}/routing-preview`,{body:'Preview remains read only'})).statusCode,200);
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(credentialResolutions,credentials);assert.equal(injectedRequests,0);
    checks.push('OPS01: observe uses the production read-only recovery plan, routing preview and authenticated admission/release snapshots; actual HTTP thread/member/invocation stop or pause, approval/Decision, release controls, routing-policy and new Thread writes all return OBSERVE_ONLY before any DB write or account decryption');
  }
  {
    let requests=0;const f=await fixture('observe-events',{mode:'execute',tools:['hold_ball'],fetch:async()=>{
      requests++;return requests===1?response('',[{name:'hold_ball',input:{idempotencyKey:'hold',jobKey:'overdue-observe-wait',seconds:5,waitSourceRef:'ordinary current Thread request'}}]):response('Durable timer registered');}});
    await f.control();const t=await f.thread();f.production.startDispatch();const accepted=await f.message(t,'Register a durable timer before observation');assert.equal(accepted.statusCode,200,accepted.body);
    await wait(()=>f.db.prepare("SELECT 1 FROM threaded_invocations WHERE status='completed'").get(),'timer registration Invocation should finish');await f.production.whenIdle();
    const timer=f.db.prepare("SELECT id,deadline,state FROM threaded_waits WHERE kind='timer'").get();assert.equal(timer.state,'awaiting');
    const queued=f.production.lifecycle.createInvocation({ownerId:f.ownerId,threadId:t.id,agentId:f.agentId,causalRootId:accepted.json().receipt.message.id,goal:'Trusted preexisting queued work for revocation propagation',requestId:'observe-revocable-pending'});
    await f.production.shutdown(200);let notificationCalls=0;
    const observedMessaging={...f.messaging,notifyCommitted(){notificationCalls++;return f.messaging.notifyCommitted();}};
    const observed=createThreadedProduction(f.db,{resources:f.resources,messaging:observedMessaging,settings:f.settings,mode:()=> 'observe',fetch:async()=>{throw new Error('Observe cannot send');}});
    try{await wait(()=>Date.now()>timer.deadline,'seeded timer must actually be overdue before observe notifications',6500);
      const tables=['threaded_waits','threaded_collaboration_callbacks','threaded_outbox','threaded_outbox_receipts','threaded_messages'];
      const business=()=>tables.map(table=>[table,f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);const before=business(),changes=f.db.prepare('SELECT total_changes() n').get().n,network=injectedRequests;
      observed.collaboration.notifyCommitted();observed.wakeup();assert.equal(observed.recover().observed,true);await new Promise(resolve=>setTimeout(resolve,40));
      assert.deepEqual(business(),before);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);assert.equal(notificationCalls,0);
      f.db.transaction(()=>{f.db.prepare('INSERT INTO account_revocations VALUES(?,?)').run(f.member.accountId,new Date().toISOString());f.db.prepare('UPDATE accounts SET enabled=0 WHERE id=?').run(f.member.accountId);observed.lifecycle.revokeAccount(f.member.accountId);}).immediate();
      assert.equal(f.db.prepare('SELECT cancel_requested FROM threaded_invocations WHERE id=?').get(queued.id).cancel_requested,1,'necessary trusted revocation must still fence its preexisting work');
      const afterRevocation=business(),revocationChanges=f.db.prepare('SELECT total_changes() n').get().n;
      await new Promise(resolve=>setTimeout(resolve,40));assert.deepEqual(business(),afterRevocation);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,revocationChanges);
      assert.equal(f.db.prepare('SELECT state FROM threaded_waits WHERE id=?').get(timer.id).state,'awaiting');assert.equal(notificationCalls,0);assert.equal(injectedRequests,network);
      checks.push('OPS01: observe with an actually overdue durable timer ignores trusted collaboration notifications, wake/recovery hints and account-revocation follow-up microtasks; necessary revocation fences existing work, then no callback/message/outbox/ACK or other follow-up DB mutation occurs');
    }finally{await observed.shutdown(200);}
  }
  {
    const f=await fixture('historical',{mode:'execute'});await f.control();const before=injectedRequests;
    const t=f.store.createThread({title:'Historical ungranted Thread',members:[{agentId:f.agentId,handle:f.agentId,roleVersion:1,permissionVersion:1,accountVersion:1}]});
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(t.id);f.production.collaboration.routing.configure(f.ownerId,t.id,{preferred:[],defaultAgent:f.agentId},0);
    f.production.messages.acceptUserMessage({ownerId:f.ownerId,threadId:t.id,clientRequestId:'old-direct-ingress',body:'Historical work is not a granted root',targets:[f.agentId]});
    f.production.startDispatch();await new Promise(resolve=>setTimeout(resolve,50));assert.equal(injectedRequests,before);assert.equal(count(f,'threaded_release_grants'),0);assert.equal(count(f,'threaded_release_roots'),0);
    const denied=await f.message(t,'Attempt to adopt a historical Thread');assert.equal(denied.statusCode,403,denied.body);assert.equal(denied.json().code,'THREADED_RELEASE_THREAD_NOT_GRANTED');
    f.db.exec("CREATE TRIGGER production_grant_fault BEFORE INSERT ON threaded_release_grants BEGIN SELECT RAISE(ABORT,'production-grant-fault'); END;");
    const threads=count(f,'threaded_threads');const failed=await f.request('POST','/api/threaded/threads',{title:'Rollback fresh room',clientRequestId:'grant-failure'});assert.equal(failed.statusCode,500,failed.body);assert.equal(count(f,'threaded_threads'),threads);assert.equal(count(f,'threaded_release_grants'),0);f.db.exec('DROP TRIGGER production_grant_fault');
    checks.push('OPS01/DB01: authenticated release never adopts an ungranted historical room or fabricated old wake; new Thread, server roster, grant and routing creation roll back atomically when grant persistence fails');
  }
  {
    let first=true;const f=await fixture('execute',{mode:'execute',fetch:async()=>{if(first){first=false;return response('',[{name:'post_message',input:{idempotencyKey:'actual-platform-post',body:'Published through actual platform tool',targets:[]}}]);}return response('Authoritative response committed');}});
    const before=injectedRequests;assert.equal((await f.request('POST','/api/threaded/threads',{title:'Gated room',clientRequestId:'no-control'})).statusCode,403);assert.equal(injectedRequests,before);
    await f.control();const t=await f.thread('Controlled execution','execute-room');const grant=f.production.release.grant(f.ownerId,t.id);assert.equal(grant.members.length,1);assert.equal(grant.members[0].agentId,f.agentId);assert.equal(f.store.getThread(t.id,f.ownerId).state,'open');
    assert.equal((await f.request('POST','/api/threaded/threads',{title:'Forged roster',clientRequestId:'forged',members:['other-agent']})).statusCode,400);
    const accepted=await f.message(t,'Use post_message then finish','lost-ack');assert.equal(accepted.statusCode,200,accepted.body);assert.equal(count(f,'threaded_release_roots'),1);
    await new Promise(resolve=>setTimeout(resolve,80));assert.equal(injectedRequests,before,'startup recovery barrier must prevent all automatic request starts');
    f.production.recover();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(injectedRequests,before,'recover itself cannot release startup dispatch barrier');
    f.production.startDispatch();await wait(()=>f.db.prepare("SELECT 1 FROM threaded_invocations WHERE status='completed'").get(),'automatic production dispatcher must complete received work');
    await f.production.whenIdle();assert.equal(injectedRequests-before,2);assert.equal(count(f,'threaded_tool_receipts'),1);
    const messages=f.production.messages.listMessages({ownerId:f.ownerId,threadId:t.id,viewer:{kind:'owner'}});assert.equal(messages.length,3);assert.ok(messages.some(m=>m.body==='Published through actual platform tool'));assert.ok(messages.some(m=>m.body==='Authoritative response committed'));
    const claims=f.db.prepare('SELECT state FROM execution_resource_claims').all();assert.ok(claims.every(c=>c.state==='released'));
    f.mode('closed');await f.control({admissionOpen:false});const replay=await f.message(t,'Use post_message then finish','lost-ack');assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),accepted.json());assert.equal(count(f,'threaded_release_roots'),1);assert.equal(injectedRequests-before,2);
    const rejected=await f.message(t,'New root closed','new-closed');assert.equal(rejected.statusCode,403,rejected.body);assert.equal(count(f,'threaded_release_roots'),1);
    const read=await f.request('GET',`/api/threaded/threads/${t.id}/view`);assert.equal(read.statusCode,200,read.body);assert.equal(read.json().snapshot.invocations[0].status,'completed');
    checks.push('OPS01/ISO03/M03/UI01: authenticated execute creates a fresh server-roster/grant/routing Thread atomically; actual ingress, tool, response and shared resource release run via automatic dispatcher only after startup barrier; closed lost-ACK replay returns exact receipt with no new root/request');
  }
  {
    let releaseFirst,started=false;const blocked=new Promise(resolve=>{releaseFirst=resolve;});
    const f=await fixture('drain',{mode:'execute',fetch:async()=>{started=true;await blocked;return response('active request finished under paused dispatch');}});await f.control();const t=await f.thread();f.production.startDispatch();
    const first=await f.message(t,'First accepted root');assert.equal(first.statusCode,200,first.body);await wait(()=>started,'first live injected request should start');
    await f.control({admissionOpen:false,dispatchOpen:false});f.mode('closed');const before=injectedRequests;
    assert.equal((await f.message(t,'No new root while closed')).statusCode,403);releaseFirst();await wait(()=>f.db.prepare("SELECT 1 FROM threaded_invocations WHERE status='completed'").get(),'active authorized request must finish after only dispatch paused');
    assert.equal(injectedRequests,before);assert.ok(f.db.prepare("SELECT COUNT(*) n FROM threaded_budget_requests WHERE usage_state='settled'").get().n>0);
    await f.production.whenIdle();checks.push('OPS01: closing new ingress and pausing new dispatch preserve an already running request, its exact authority and normal settlement; emergency cancellation remains a separate Owner control');
  }
  {
    const f=await fixture('queued-drain',{mode:'execute'});await f.control();const t=await f.thread();const accepted=await f.message(t,'Accepted before closing');assert.equal(accepted.statusCode,200,accepted.body);
    await f.control({admissionOpen:false,dispatchOpen:false});f.mode('closed');const before=injectedRequests;f.production.startDispatch();await new Promise(resolve=>setTimeout(resolve,80));assert.equal(injectedRequests,before);
    await f.control({admissionOpen:false,dispatchOpen:true});await wait(()=>f.db.prepare("SELECT 1 FROM threaded_invocations WHERE status='completed'").get(),'accepted queued root must drain when only dispatch reopens');
    assert.equal(injectedRequests-before,1);assert.equal(count(f,'threaded_release_roots'),1);assert.equal(f.production.release.state(f.ownerId).admissionOpen,false);
    checks.push('OPS01: previously accepted queued work stays pending behind dispatch pause; reopening dispatch while mode/new ingress remain closed drains its frozen root once');
  }
  {
    let requestNumber=0;const f=await fixture('decision-drain',{mode:'execute',tools:['conversation_decision','settle_decision'],fetch:async current=>{
      requestNumber++;
      if(requestNumber===1)return response('',[{name:'conversation_decision',input:{idempotencyKey:'decision',jobKey:'release-question',question:'Choose the approved continuation',once:true,block:'interactive'}}]);
      if(requestNumber===3){const w=current.db.prepare("SELECT id,version FROM threaded_waits WHERE kind='decision' AND state='awaiting'").get();
        const answer=current.db.prepare('SELECT message_id FROM threaded_decision_responses WHERE wait_id=?').get(w.id);
        return response('',[{name:'settle_decision',input:{idempotencyKey:'settle',waitId:w.id,expectedVersion:w.version,operationId:'settle-answered-question',responseMessageId:answer.message_id}}]);}
      return response(requestNumber===2?'Waiting for the Owner answer':'The existing decision is settled');}});
    await f.control();const t=await f.thread();f.production.startDispatch();const accepted=await f.message(t,'Ask the Owner a question');assert.equal(accepted.statusCode,200,accepted.body);
    await wait(()=>f.db.prepare("SELECT 1 FROM threaded_invocations WHERE status='completed'").get(),'first decision request must finish its Invocation');await f.production.whenIdle();
    const w=f.db.prepare("SELECT * FROM threaded_waits WHERE kind='decision'").get();assert.equal(w.state,'awaiting');const rootId=accepted.json().receipt.message.id;
    await f.control({admissionOpen:false});f.mode('closed');const url=`/api/threaded/threads/${t.id}/decisions/${w.id}/responses`,input={clientRequestId:'closed-decision-answer',expectedVersion:w.version,body:'Continue the accepted work'};
    const reply=await f.request('POST',url,input);assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().receipt.message.causalRootId,rootId);
    await wait(()=>f.db.prepare("SELECT state FROM threaded_waits WHERE id=?").get(w.id).state==='settled','closed mode must allow settling its already accepted decision');await f.production.whenIdle();
    assert.equal(count(f,'threaded_release_roots'),1);assert.equal(count(f,'threaded_budget_roots'),1);assert.equal(requestNumber,4);
    const replay=await f.request('POST',url,input);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),reply.json());assert.equal(requestNumber,4);
    f.mode('observe');assert.equal((await f.request('POST',url,{...input,clientRequestId:'observe-answer'})).statusCode,403);
    checks.push('OPS01/W06/B01: closed new ingress still permits an authenticated response to a previously created interactive decision; actual platform settle tool resumes the same causal root/budget, exact answer replay is idempotent, and observe rejects business writes');
  }
  {
    const f=await fixture('pack-drift',{mode:'execute'});await f.control();const t=await f.thread();const accepted=await f.message(t,'Frozen API driver must remain API');assert.equal(accepted.statusCode,200,accepted.body);
    const before=injectedRequests,credentials=credentialResolutions;await f.production.shutdown(200);
    const raw=JSON.parse(await readFile(f.packFile,'utf8'));raw.members[0].backend='claude-sdk';raw.members[0].backendVersion='0.3.288';await writeFile(f.packFile,JSON.stringify(raw));
    const changed=loadThreadedProductionSettings(f.db,{file:f.packFile,workspaceRoot:path.join(root,'pack-drift','workspace'),privateRoot:path.join(root,'pack-drift','private'),platform:'darwin',
      readCredential(){credentialResolutions++;return 'fixture-only-nonsecret';}});
    const replacement=createThreadedProduction(f.db,{resources:f.resources,messaging:f.messaging,settings:changed,mode:()=> 'closed',fetch:async()=>{throw new Error('Changed carrier must never run');}});
    try{replacement.recover();replacement.startDispatch();await wait(()=>f.db.prepare("SELECT 1 FROM threaded_wake_queue WHERE state='blocked' AND reason='THREADED_RELEASE_CONFIGURATION_NOT_RETAINED'").get(),'new backend pack must explicitly pause work from the old frozen API grant');
      const caps=replacement.capabilities(f.ownerId,t.id);assert.equal(caps.implemented.admission,false);assert.equal(caps.implemented.execution,false);assert.equal(caps.implemented.tools,false);
      assert.equal(injectedRequests,before);assert.equal(credentialResolutions,credentials);assert.equal(count(f,'threaded_release_roots'),1);assert.equal(count(f,'threaded_release_grants'),1);assert.equal(f.production.release.grant(f.ownerId,t.id).members[0].backend,'api');
      assert.equal(count(f,'threaded_backend_requests'),0);assert.equal(count(f,'threaded_backend_processes'),0);assert.equal(replacement.release.snapshot(f.ownerId).drain.ready,false);
    }finally{await replacement.shutdown(200);}
    checks.push('OPS01/CTX06: rebuilding the same SQLite service with a different allowed backend pack explicitly pauses the accepted API root as CONFIGURATION_NOT_RETAINED; it preserves the original grant/root and never resolves credentials, starts SDK/model transport or silently changes carrier');
  }
  {
    const f=await fixture('partial-pack',{mode:'execute',memberCount:2});await f.control();const t=await f.thread();const peer=f.agentIds[1];
    const accepted=await f.message(t,`@${peer} Keep this accepted peer work on its existing API driver`);assert.equal(accepted.statusCode,200,accepted.body);assert.deepEqual(accepted.json().route.targets,[peer]);await f.production.shutdown(200);
    const raw=JSON.parse(await readFile(f.packFile,'utf8'));raw.members[0].backend='claude-sdk';raw.members[0].backendVersion='0.3.288';await writeFile(f.packFile,JSON.stringify(raw));
    const changed=loadThreadedProductionSettings(f.db,{file:f.packFile,workspaceRoot:path.join(root,'partial-pack','workspace'),privateRoot:path.join(root,'partial-pack','private'),platform:'darwin',readCredential(){credentialResolutions++;return 'fixture-only-nonsecret';}});
    let requests=0;const replacement=createThreadedProduction(f.db,{resources:f.resources,messaging:f.messaging,settings:changed,mode:()=> 'execute',fetch:async(url)=>{assert.equal(new URL(url).origin,'https://fixture.invalid');requests++;injectedRequests++;return response('Unchanged peer completed its accepted work');}});
    try{const caps=replacement.capabilities(f.ownerId,t.id);assert.equal(caps.implemented.admission,false,'a mixed old/new pack cannot accept a new root into its old Thread');assert.equal(caps.implemented.execution,true);assert.equal(caps.implemented.tools,true);
      replacement.recover();replacement.startDispatch();await wait(()=>f.db.prepare("SELECT 1 FROM threaded_invocations WHERE agent_id=? AND status='completed'").get(peer),'unchanged peer must keep its compatible drain authority');await replacement.whenIdle();assert.equal(requests,1);assert.equal(count(f,'threaded_release_roots'),1);
      checks.push('OPS01/ISO03: Thread capabilities deny new ingress for a partly changed pack while retaining execution/tools for a compatible peer; that unchanged peer actually drains its previously accepted root once without switching the changed member driver');
    }finally{await replacement.shutdown(200);}
  }
  {
    const f=await fixture('missing-credential',{mode:'execute'});await f.control();const t=await f.thread();const before=injectedRequests,credentials=credentialResolutions;
    f.db.prepare('DELETE FROM account_credentials WHERE account_id=? AND version=1').run(f.member.accountId);
    const admission=await f.request('GET','/api/threaded/admission');assert.equal(admission.json().ready,false);assert.equal(admission.json().reason,'THREADED_RELEASE_CREDENTIAL_VERSION_MISSING');
    const rejected=await f.message(t,'Missing credential version must reject before ingress');assert.equal(rejected.statusCode,409,rejected.body);assert.equal(rejected.json().code,'THREADED_RELEASE_CREDENTIAL_VERSION_MISSING');
    assert.equal(count(f,'threaded_release_roots'),0);assert.equal(count(f,'threaded_messages'),0);assert.equal(injectedRequests,before);assert.equal(credentialResolutions,credentials);
    checks.push('OPS01/ISO03: a missing encrypted credential version row makes admission not ready and rejects new ingress before creating root/message or attempting decryption/transport');
  }
  {
    const f=await fixture('accepted-missing-credential',{mode:'execute'});await f.control();const t=await f.thread();const accepted=await f.message(t,'Accepted before credential metadata was lost');assert.equal(accepted.statusCode,200,accepted.body);
    const before=injectedRequests,credentials=credentialResolutions;f.db.prepare('DELETE FROM account_credentials WHERE account_id=? AND version=1').run(f.member.accountId);
    await f.control({admissionOpen:false});f.mode('closed');f.production.startDispatch();
    await wait(()=>f.db.prepare("SELECT 1 FROM threaded_wake_queue WHERE state='blocked' AND reason='THREADED_RELEASE_CREDENTIAL_VERSION_MISSING'").get(),'accepted root must explicitly block for its missing credential row');
    assert.equal(count(f,'threaded_release_roots'),1);assert.equal(injectedRequests,before);assert.equal(credentialResolutions,credentials);assert.equal(f.production.release.snapshot(f.ownerId).drain.ready,false);
    checks.push('OPS01: losing a credential version after ingress preserves the frozen grant/root and explicitly blocks its queue under closed mode without decrypting, sending or pretending to drain');
  }
  {
    let attempts=0;const f=await fixture('unavailable-credential',{mode:'execute',readCredential(){attempts++;throw new Error('Synthetic master key or credential decryption failure');}});await f.control();const t=await f.thread();const accepted=await f.message(t,'Credential row exists but secure read fails');assert.equal(accepted.statusCode,200,accepted.body);
    const before=injectedRequests;f.production.startDispatch();await wait(()=>f.db.prepare("SELECT 1 FROM threaded_wake_queue WHERE state='blocked' AND reason='THREADED_RELEASE_CREDENTIAL_UNAVAILABLE'").get(),'credential read failure must become an explicit stable queue fault');
    for(let i=0;i<3;i++){f.production.wakeup();await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(attempts,1,'failed decryption must not trigger a queued/blocked notification retry loop');assert.equal(injectedRequests,before);assert.equal(count(f,'threaded_release_roots'),1);
    const admission=await f.request('GET','/api/threaded/admission');assert.equal(admission.json().ready,false);assert.equal(admission.json().reason,'THREADED_RELEASE_CREDENTIAL_UNAVAILABLE');
    assert.equal((await f.message(t,'Cannot accept another root with a known credential fault')).json().code,'THREADED_RELEASE_CREDENTIAL_UNAVAILABLE');
    checks.push('OPS01/REC03: secure credential read errors become a stable CREDENTIAL_UNAVAILABLE queue/admission fault with one attempted injected decryption, no retry livelock or network, and accepted work retained until operator repair/restart');
  }
  {
    const f=await fixture('pin-change',{mode:'execute'});await f.control();const t=await f.thread();const before=injectedRequests;
    f.db.prepare('UPDATE accounts SET credential_version=2 WHERE id=?').run(f.member.accountId);
    const admission=await f.request('GET','/api/threaded/admission');assert.equal(admission.json().ready,false);assert.equal(admission.json().reason,'THREADED_RELEASE_PIN_CHANGED');
    const rejected=await f.message(t,'Stale account pin');assert.equal(rejected.statusCode,409,rejected.body);assert.equal(count(f,'threaded_release_roots'),0);assert.equal(count(f,'threaded_messages'),0);assert.equal(injectedRequests,before);
    checks.push('OPS01/ISO03: current account metadata pin change fails before ingress, context or network; no credential version silently replaces an existing grant');
  }
  {
    let finish;const pending=new Promise(resolve=>{finish=resolve;});let started=false;
    const f=await fixture('shutdown',{mode:'execute',fetch:async()=>{started=true;await pending;return response('late body cannot become authorized result');}});await f.control();const t=await f.thread();f.production.startDispatch();const accepted=await f.message(t,'Unconfirmed cancellation transport');assert.equal(accepted.statusCode,200,accepted.body);await wait(()=>started,'shutdown request must start');
    const outcome=await f.production.shutdown(20);assert.equal(outcome.idle,false);assert.equal(outcome.unknown.length,1);assert.equal(f.production.release.snapshot(f.ownerId).drain.ready,false);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_invocations WHERE status='unknown'").get().n,1);assert.ok(f.db.prepare("SELECT COUNT(*) n FROM execution_resource_claims WHERE state='unknown'").get().n>0);
    const reopened=new Database(f.file,{fileMustExist:true});try{assertOrchestrationSchemaCompatible(reopened);assert.equal(reopened.prepare("SELECT COUNT(*) n FROM threaded_invocations WHERE status='unknown'").get().n,1);}finally{reopened.close();}
    finish();await wait(()=>f.production.diagnostics().active===0,'late aborted transport should settle without publishing');assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_messages WHERE origin='agent_response'").get().n,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_invocations WHERE status='unknown'").get().n,1);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_backend_requests WHERE state='unknown'").get().n,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM execution_resource_claims WHERE state='unknown'").get().n,1);
    assert.ok(f.db.prepare("SELECT COUNT(*) n FROM threaded_budget_requests WHERE usage_state='unknown'").get().n>0);
    assert.equal(f.production.release.snapshot(f.ownerId).drain.ready,false);assert.ok(f.db.prepare("SELECT COUNT(*) n FROM threaded_budget_outcomes WHERE kind='unknown'").get().n>0);
    checks.push('OPS01/REC03/B02: bounded production shutdown persists unknown invocation/resource fences in a new SQLite connection while transport ignores abort; late response bytes fail the activity/abort checkpoint before trusted parsing, publish nothing and retain request, claim, usage and unknown audit for Owner reconciliation');
  }
  assert.equal(externalRequests,0);const report={ok:true,stage:'T12',groups:checks.length,checks,injectedModelHttpRequests:injectedRequests,
    realModelRequests:0,externalNetworkRequests:0,credentialResolutions:'injected metadata-only resolver',injectedCredentialReads:credentialResolutions,
    isolatedExecutionBypass:false,productionDatabaseAccess:false,productionRelease:false};
  const output=process.env.THREADED_PRODUCTION_OUTPUT??'docs/reports/evidence/threaded-t12-production/isolated.json';await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
  for(const f of fixtures.reverse())await f.close();defaultProduction.close();database.closeDatabase();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});
}
