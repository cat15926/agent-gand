import path from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
const [root,port,webPort,packMode,mode]=process.argv.slice(2);
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-global.sqlite'),AGENTS_DIR:path.join(root,'agents'),
  HOST:'127.0.0.1',PORT:port,ACCOUNT_TRUSTED_ORIGINS:`http://127.0.0.1:${port},http://127.0.0.1:${webPort}`,THREADED_COLLABORATION_MODE:'closed'});
delete process.env.THREADED_RELEASE_MEMBERS_FILE;
globalThis.fetch=async()=>{throw new Error('Real supplier/network access forbidden in T12 production UI fixture');};
const {applyOrchestrationSchemaMigrations}=await import('../../apps/server/src/db/orchestrationMigrations.ts');
const {createThreadedStore}=await import('../../apps/server/src/threaded/store.ts');
const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
const {assertResourceSessionCurrent}=await import('../../apps/server/src/execution/resources/sessions.ts');
const {createThreadedAuthority}=await import('../../apps/server/src/threaded/authority.ts');
const {createThreadedMessaging}=await import('../../apps/server/src/threaded/messaging.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../../apps/server/src/threaded/backends/evidence.ts');
const {loadThreadedProductionSettings}=await import('../../apps/server/src/threaded/productionSettings.ts');
const {createThreadedProduction}=await import('../../apps/server/src/threaded/production.ts');
const {createThreadedAccess}=await import('../../apps/server/src/threaded/access.ts');
const {createThreadedView}=await import('../../apps/server/src/threaded/view.ts');
const {registerThreadedAccessBridge,registerThreadedRoutes}=await import('../../apps/server/src/api/threadedRoutes.ts');
const management=await import('../../apps/server/src/accounts/access.ts');
const {default:Fastify}=await import('../../apps/server/node_modules/fastify/fastify.js');
const {default:websocket}=await import('../../apps/server/node_modules/@fastify/websocket/index.js');
// The executor follows the production account/role authority branch, not the isolated-worker bypass.
delete process.env.AGENT_GAND_ISOLATED_WORKER;
const db=new Database(path.join(root,'production-ui.sqlite'),{timeout:10000});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');
if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'").get()){
  db.exec(readFileSync(new URL('../../apps/server/src/db/schema.sql',import.meta.url),'utf8'));db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
}
applyOrchestrationSchemaMigrations(db);
const members=['pinned-alpha','pinned-beta'].map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model:'anthropic:fixture-model',roleVersion:1,permissionVersion:1,
  accountId:`${agentId}-account`,accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
for(const m of members)if(!db.prepare('SELECT 1 FROM agents WHERE id=?').get(m.agentId)){
  const stamp=new Date().toISOString();
  db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
    .run(m.accountId,'UI fixture metadata','anthropic','api_key','managed',stamp,stamp);
  db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(m.accountId,JSON.stringify({baseUrl:'https://fixture.invalid',protocols:['anthropic-messages'],models:[m.model],defaultModel:m.model,timeoutMs:2000}),stamp);
  db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(m.accountId,'fixture-only-key-id','fixture-only-ciphertext','fixture-only-nonce','fixture-only-tag','fake',stamp);
  db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(m.agentId,m.agentId,JSON.stringify({id:m.agentId,name:m.agentId,
    model:m.model,systemPrompt:'Return a concise fixture response. No external requests.',tools:['post_message'],permissionMode:'readonly',accountRef:m.accountId,requiresAccount:true}),'t12-ui',stamp,stamp);
}
const packFile=path.join(root,'ui-pack.json');writeFileSync(packFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:['post_message'],maxOutputTokens:128,maxInputTokens:65536,maxRequests:3,
  prices:Object.fromEntries(members.map(m=>[m.agentId,{inputPerMillion:1,outputPerMillion:1}]))}));
let credentialResolutions=0,injectedModelCalls=0;
const settings=loadThreadedProductionSettings(db,{file:packMode==='pack'?packFile:undefined,workspaceRoot:path.join(root,'workspace'),privateRoot:path.join(root,'private'),platform:'darwin',
  readCredential(id,version){if(!members.some(m=>m.accountId===id)||version!==1)throw new Error('Only fixture account metadata allowed');credentialResolutions++;return 'fixture-nonsecret';}});
const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();let resources;
resources=createExecutionResourceCoordinator(db,{ownerNonce:`t12-ui:${randomUUID()}`,validateRequest:r=>assertResourceSessionCurrent(db,r),
  verifyEvidence:(_r,id,evidence)=>{const saved=resources.getClaim(id.claimId);return !!saved&&verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
const messaging=createThreadedMessaging(db,{authority:createThreadedAuthority(db,resources),repairIntervalMs:0});
const production=createThreadedProduction(db,{resources,messaging,settings,mode:()=>mode,fetch:async url=>{
  if(new URL(url).origin!=='https://fixture.invalid')throw new Error('Fixture-only model transport required');injectedModelCalls++;
  return new Response(JSON.stringify({id:randomUUID(),type:'message',content:[{type:'text',text:'T12_UI_ACCEPTED_WORK_COMPLETED'}],stop_reason:'end_turn',usage:{input_tokens:9,output_tokens:3}}),{headers:{'content-type':'application/json'}});}});
const access=createThreadedAccess(()=>ownerId),view=createThreadedView(db,{store,messages:messaging.messages,capabilities:production.capabilities});
const context={store,access,messages:production.messaging.messages,lifecycle:production.lifecycle,collaboration:production.collaboration,view,operations:production,
  messageAdmission:production.messageAdmission,onMessageNotification:production.messaging.onNotification};
const app=Fastify({logger:false});await app.register(websocket);await app.register(async accounts=>{
  accounts.addHook('onRequest',async request=>{management.assertManagementBoundary(request);if(request.routeOptions.url!=='/api/accounts/session'||request.method!=='POST')management.requireManagementSession(request);});
  accounts.post('/api/accounts/session',async(request,reply)=>management.createManagementSession(request,reply));
  accounts.delete('/api/accounts/session',async(request,reply)=>management.deleteManagementSession(request,reply));await registerThreadedAccessBridge(accounts,context);
});await registerThreadedRoutes(app,context);
if(mode!=='observe'){production.recover();production.startDispatch();}
await app.listen({host:'127.0.0.1',port:Number(port)});
function snapshot(){const tableNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'sqlite_sequence' ORDER BY name").all().map(r=>r.name),rows=Object.fromEntries(tableNames.map(t=>[t,db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  return {admission:production.admission(),release:production.release.snapshot(ownerId),databaseHash:createHash('sha256').update(JSON.stringify(rows)).digest('hex'),injectedModelCalls,credentialResolutions,
    threads:store.listThreads(ownerId).map(t=>({id:t.id,title:t.title,state:t.state,members:store.listMembers(t.id,ownerId).map(m=>m.agentId)})),
    messages:db.prepare('SELECT id,thread_id,body FROM threaded_messages ORDER BY seq').all(),terminals:db.prepare('SELECT invocation_id,status FROM threaded_invocation_terminals ORDER BY rowid').all()};}
process.on('message',message=>{try{if(message.action==='snapshot')process.send?.({id:message.id,snapshot:snapshot()});else process.send?.({id:message.id,error:'Unsupported fixture operation'});}catch(error){process.send?.({id:message.id,error:error.message});}});
process.send?.({type:'ready',mode,pack:packMode,members:members.map(m=>m.agentId)});
