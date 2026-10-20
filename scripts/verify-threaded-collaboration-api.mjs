import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t08-api-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents'),
  HOST:'127.0.0.1',PORT:'3010',ACCOUNT_TRUSTED_ORIGINS:'http://127.0.0.1:3010',THREADED_COLLABORATION_MODE:'closed'});
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No external network');};
let f,app,database,access,handler;const checks=[];
try{
  f=await openBackendRuntimeFixture(root,'http',{applicationTools:['conversation_decision','settle_decision'],fetch:async()=>{
    await handler?.();return new Response(JSON.stringify({id:'fixture',type:'message',content:[{type:'text',text:'done'}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});}});
  const {default:Fastify}=await import('../apps/server/node_modules/fastify/fastify.js');
  const {default:websocket}=await import('../apps/server/node_modules/@fastify/websocket/index.js');
  const {createThreadedAccess}=await import('../apps/server/src/threaded/access.ts');
  const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
  const {registerThreadedAccessBridge,registerThreadedRoutes}=await import('../apps/server/src/api/threadedRoutes.ts');
  const {rejectThreadedAdmission}=await import('../apps/server/src/threaded/policy.ts');
  const management=await import('../apps/server/src/accounts/access.ts');database=await import('../apps/server/src/db/database.ts');
  access=createThreadedAccess(()=>f.thread.ownerId);let admit=false;
  const context={store:createThreadedStore(f.db),access,messages:f.runtime.messages,lifecycle:f.runtime.lifecycle,collaboration:f.runtime.collaboration,
    messageAdmission(){if(!admit)rejectThreadedAdmission();}};
  app=Fastify({logger:false});await app.register(websocket);
  await app.register(async accounts=>{
    accounts.addHook('onRequest',async request=>{management.assertManagementBoundary(request);
      if(request.routeOptions.url!=='/api/accounts/session'||request.method!=='POST')management.requireManagementSession(request);});
    accounts.post('/api/accounts/session',async(request,reply)=>management.createManagementSession(request,reply));
    await registerThreadedAccessBridge(accounts,context);
  });await registerThreadedRoutes(app,context);await app.ready();
  const headers={host:'127.0.0.1:3010',origin:'http://127.0.0.1:3010'};
  const request=(url,method='GET',auth={},payload)=>app.inject({method,url,headers:{...headers,...auth},...(payload===undefined?{}:{payload})});
  const parent=await request('/api/accounts/session','POST',{'x-gand-bootstrap':'1'});assert.equal(parent.statusCode,200,parent.body);
  const grant=await request('/api/accounts/threaded/access-session','POST',{cookie:parent.headers['set-cookie'].split(';')[0],'x-gand-csrf':parent.json().csrfToken});assert.equal(grant.statusCode,200,grant.body);
  const auth={cookie:grant.headers['set-cookie'].split(';')[0],'x-gand-csrf':grant.json().csrfToken},base=`/api/threaded/threads/${f.thread.id}`;
  assert.equal((await request(`${base}/routing-preview`,'POST',{}, {body:'next'})).statusCode,401);
  const policy={expectedVersion:0,policy:{defaultAgent:'api-member',preferred:[],groups:{team:['api-member','other-member']}}};
  assert.equal((await request(`${base}/routing-policy`,'PUT',{...auth,'x-gand-csrf':'wrong'},policy)).statusCode,403);
  const configured=await request(`${base}/routing-policy`,'PUT',auth,policy);assert.equal(configured.statusCode,200,configured.body);
  assert.equal((await request(`${base}/routing-policy`,'PUT',auth,policy)).statusCode,409);
  const body='@team #critique independent';
  const preview=await request(`${base}/routing-preview`,'POST',auth,{body});assert.equal(preview.statusCode,200,preview.body);
  assert.equal(preview.json().route.strategy,'parallel');assert.deepEqual(preview.json().route.promptTags,['critique']);
  checks.push('R01/R02 HTTP: owner session/CSRF and versioned routing-policy CAS, shared preview with critique prompt tag and default multi-target independent strategy');
  const input={body,clientRequestId:'http-t08'};
  for(const mode of ['closed','observe','execute']){process.env.THREADED_COLLABORATION_MODE=mode;assert.equal((await request(`${base}/messages`,'POST',auth,input)).statusCode,mode==='closed'?403:501);}
  process.env.THREADED_COLLABORATION_MODE='closed';admit=true;
  const [a,b]=await Promise.all([request(`${base}/messages`,'POST',auth,input),request(`${base}/messages`,'POST',auth,input)]);
  assert.equal(a.statusCode,200,a.body);assert.deepEqual(a.json(),b.json());assert.deepEqual(a.json().route,preview.json().route);
  assert.equal((await request(`${base}/messages`,'POST',auth,{...input,actor:'system'})).statusCode,400);
  assert.equal((await request(`${base}/messages`,'POST',auth,{...input,body:'changed'})).statusCode,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_attempts').get().n,0);
  checks.push('Production closed/observe/execute all refuse new work; isolated admitted HTTP routing persists one stable canonical receipt and preview-identical decision, with no executor or forged identity');
  for(const wake of a.json().receipt.wakes)f.runtime.queue.enqueueWake(wake.id);
  const claim=f.runtime.queue.claimNext('http-decision');assert.equal(claim.binding.agentId,'api-member');let decision;
  handler=async()=>{const result=JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,'conversation_decision',{
    idempotencyKey:'decision',jobKey:'http-question',question:'Choose an option',block:'interactive',once:true},'http-tool',['conversation_decision']));assert.equal(result.ok,true,JSON.stringify(result));decision=result.result;};
  await f.runtime.executeClaim(claim);handler=undefined;
  const waits=await request(`${base}/waits?agentId=api-member`,'GET',auth);assert.equal(waits.statusCode,200,waits.body);
  assert.equal(waits.json().waits[0].question,'Choose an option');assert.ok(!waits.body.includes('frozen'));
  const endpoint=`${base}/decisions/${decision.waitId}/responses`,answer={clientRequestId:'human-answer',expectedVersion:1,body:'option A'};
  assert.equal((await request(endpoint,'POST',{},answer)).statusCode,401);
  assert.equal((await request(endpoint,'POST',{...auth,'x-gand-csrf':'wrong'},answer)).statusCode,403);
  assert.equal((await request(endpoint,'POST',auth,{...answer,expectedVersion:2})).statusCode,409);
  admit=false;assert.equal((await request(endpoint,'POST',auth,answer)).statusCode,403);admit=true;
  const replied=await request(endpoint,'POST',auth,answer);assert.equal(replied.statusCode,200,replied.body);
  assert.equal(replied.json().receipt.message.causalRootId,claim.queue.causalRootId);
  checks.push('W02/W06 HTTP: safe Owner wait projection, authenticated exact-revision canonical answer, CSRF/closed gate, and original causal-root budget inheritance');
  let next=f.runtime.queue.claimNext('other-original');assert.equal(next.binding.agentId,'other-member');await f.runtime.executeClaim(next);
  next=f.runtime.queue.claimNext('answer');assert.equal(next.binding.agentId,'api-member');
  handler=async()=>{const result=JSON.parse(await f.runtime.collaboration.tools.execute(next.binding,'settle_decision',{
    idempotencyKey:'settle',operationId:'settle',waitId:decision.waitId,expectedVersion:1,responseMessageId:replied.json().receipt.message.id},'settle-tool',['settle_decision']));assert.equal(result.ok,true,JSON.stringify(result));};
  await f.runtime.executeClaim(next);handler=undefined;
  assert.deepEqual((await request(endpoint,'POST',auth,answer)).json(),replied.json());
  assert.equal((await request(endpoint,'POST',auth,{...answer,clientRequestId:'late'})).statusCode,409);
  const settled=(await request(`${base}/waits?agentId=api-member`,'GET',auth)).json().waits[0];assert.equal(settled.state,'settled');assert.equal(settled.outcome.businessApproval,false);
  checks.push('Lost HTTP answer receipt retries remain stable even after the Agent settles; stale new answers cannot settle another question or grant business approval');
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,groups:checks.length,checks,realModelCalls:0,externalNetworkCalls:0,scope:'Fastify injection, real access bridge/runtime/canonical messages and injected provider'},null,2));
}finally{handler=undefined;await app?.close();access?.close();f?.close();database?.closeDatabase();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
