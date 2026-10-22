/** RC03 actual production factory, real bounded native command, injected model transport. */
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'threaded-rc03-production-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {applyOrchestrationSchemaMigrations}=await import('../apps/server/src/db/orchestrationMigrations.ts');
const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
const {createExecutionResourceCoordinator}=await import('../apps/server/src/execution/resources/coordinator.ts');
const {assertResourceSessionCurrent}=await import('../apps/server/src/execution/resources/sessions.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../apps/server/src/threaded/backends/evidence.ts');
const {verifyThreadedOsCommandResourceEvidence}=await import('../apps/server/src/threaded/osCommands.ts');
const {createThreadedAuthority}=await import('../apps/server/src/threaded/authority.ts');
const {createThreadedMessaging}=await import('../apps/server/src/threaded/messaging.ts');
const {loadThreadedProductionSettings}=await import('../apps/server/src/threaded/productionSettings.ts');
const {createThreadedProduction}=await import('../apps/server/src/threaded/production.ts');
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
delete process.env.AGENT_GAND_ISOLATED_WORKER;
const originalFetch=globalThis.fetch;let forbiddenNetwork=0,injectedModelRequests=0;
globalThis.fetch=async()=>{forbiddenNetwork++;throw new Error('No external network permitted');};
const fixtures=[],checks=[];
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
async function fixture(name){
  const db=new Database(path.join(root,`${name}.sqlite`));db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.exec(schema);db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
  const stamp=new Date().toISOString(),accountId=`${name}-account`,agentIds=[`${name}-author`,`${name}-operator`],model='anthropic:fixture-model';
  db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
    .run(accountId,'RC03 isolated account','anthropic','api_key','managed',stamp,stamp);
  db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(accountId,JSON.stringify({baseUrl:'https://fixture.invalid',protocols:['anthropic-messages'],models:[model],defaultModel:model,timeoutMs:2000}),stamp);
  db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(accountId,'fixture-only-key','fixture-only-ciphertext','fixture-only-nonce','fixture-only-tag','fake',stamp);
  const members=agentIds.map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model,roleVersion:1,permissionVersion:1,accountId,
    accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
  for(const agentId of agentIds)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(agentId,agentId,
    JSON.stringify({id:agentId,name:agentId,model,systemPrompt:'Use the registered platform tools in this isolated acceptance.',tools:THREADED_APPLICATION_TOOL_NAMES,permissionMode:'readonly',accountRef:accountId,requiresAccount:true}),'rc03-isolated',stamp,stamp);
  const releaseFile=path.join(root,`${name}-release.json`),commandsFile=path.join(root,`${name}-commands.json`);
  await writeFile(releaseFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:THREADED_APPLICATION_TOOL_NAMES,
    maxOutputTokens:128,maxInputTokens:65536,maxRequests:4,prices:Object.fromEntries(agentIds.map(id=>[id,{inputPerMillion:1,outputPerMillion:1}]))}));
  const settings=loadThreadedProductionSettings(db,{file:releaseFile,workspaceRoot:path.join(root,name,'workspace'),privateRoot:path.join(root,name,'private'),readCredential:()=> 'fixture-only-model-key'});
  const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();let resources,production,messaging,mode='execute',activeClaim,handler=async()=> 'Done',f;
  function attach(register=false){
    resources=createExecutionResourceCoordinator(db,{ownerNonce:`rc03:${randomUUID()}`,validateRequest:r=>assertResourceSessionCurrent(db,r),
      verifyEvidence:(_r,identity,evidence)=>{const claim=resources.getClaim(identity.claimId);return !!claim&&(verifyThreadedBackendResourceEvidence(db,claim,evidence)||verifyThreadedOsCommandResourceEvidence(db,claim,evidence));}});
    messaging=createThreadedMessaging(db,{authority:createThreadedAuthority(db,resources),repairIntervalMs:0});
    production=createThreadedProduction(db,{resources,messaging,settings,mode:()=>mode,...(register?{commands:{file:commandsFile}}:{}),
      fetch:async url=>{assert.equal(new URL(url).origin,'https://fixture.invalid');assert.equal(db.inTransaction,false);injectedModelRequests++;
        try{return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:await handler(activeClaim)}],stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:2}}),{headers:{'content-type':'application/json'}});}catch(error){f.handlerError=error;throw error;}}});
    production.collaboration.close();
  }
  attach();production.release.change({ownerId,expectedVersion:0,requestId:'open',admissionOpen:true,dispatchOpen:true,reason:'RC03 isolated production acceptance'});
  const thread=production.createThread({ownerId,title:name,clientRequestId:'thread'});
  const projectRoot=path.join(root,`${name}-project`),workspace=path.join(projectRoot,'member'),output=path.join(projectRoot,'output');
  await mkdir(workspace,{recursive:true});await mkdir(output);await writeFile(path.join(workspace,'source.txt'),'pinned input\n');
  const configuration={schemaVersion:1,version:1,ownerId,projects:[{id:'project',root:projectRoot,members:[{threadId:thread.id,agentId:agentIds[1],workspace}]}],
    commands:[{id:'manifest',projectId:'project',threadId:thread.id,agentId:agentIds[1],profile:'project_manifest_v1',cwd:output,readPaths:[workspace],writeRoot:output,settleDelayMs:100}]};
  f={db,ownerId,agentIds,thread,workspace,output,commandsFile,configuration,get production(){return production;},get resources(){return resources;},mode:v=>{mode=v;},
    async register(){await production.shutdown(200);messaging.close();await writeFile(commandsFile,JSON.stringify(configuration));attach(true);},
    async runFor(agentId,nextHandler,receipt){if(receipt)for(const wake of receipt.wakes)production.queue.enqueueWake(wake.id);production.queue.scanPending();
      for(let i=0;i<10;i++){const claim=production.queue.claimNext(`rc03:${name}`);assert.ok(claim);activeClaim=claim;f.handlerError=undefined;let matched=false;
        handler=async c=>{if(c.binding.agentId===agentId){matched=true;return nextHandler(c);}return 'Other notification';};
        const result=await production.executeClaim(claim);if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));if(matched)return claim;}
      assert.fail('Target member never dispatched');},
    user(body){return production.collaboration.routing.acceptUserMessage({ownerId,threadId:thread.id,body:`@${agentIds[0]} ${body}`,clientRequestId:randomUUID()}).receipt;},
    async close(){await production.shutdown(500);messaging.close();db.close();}};
  fixtures.push(f);return f;
}
const tool=async(f,claim,name,input)=>JSON.parse(await f.production.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
const ok=v=>{assert.equal(v.ok,true,JSON.stringify(v));return v.result;};
const wait=async(test,label)=>{const end=Date.now()+10000;while(!await test()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,30));assert.ok(await test(),label);};
async function assign(f){let action;await f.runFor(f.agentIds[0],async claim=>{
  const task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Bounded production command',acceptanceCriteria:['Manifest is independently verified']}));
  action=ok(await tool(f,claim,'transfer_action',{idempotencyKey:'action',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:[f.agentIds[1]]}));return 'Assigned';},f.user('Inspect selected project'));return action;}
try{
  {
    const f=await fixture('registered'),action=await assign(f);assert.deepEqual(f.production.admission().domains.commands,{configured:false,state:'not_registered'});
    await f.register();assert.equal(f.production.admission().domains.commands.state,'registered');let command;
    await f.runFor(f.agentIds[1],async claim=>{
      for(const name of ['shell','constructor','__proto__','toString']){
        const denied=await tool(f,claim,'run_command',{idempotencyKey:`unregistered-${name}`,actionId:action.actionId,expectedGeneration:1,command:name,args:{}});assert.equal(denied.code,'THREADED_COMMAND_NOT_AUTHORIZED');
      }
      const session=f.db.prepare("SELECT record FROM execution_resource_sessions WHERE json_extract(record,'$.policy.agentId')=? ORDER BY version DESC LIMIT 1").get(f.agentIds[1]);
      assert.equal(JSON.parse(session.record).policy.workspace,f.workspace);
      const boundary=f.db.prepare('SELECT base_boundary FROM threaded_session_context_versions WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(f.agentIds[1]);assert.match(boundary.base_boundary,/:project:/);
      command=ok(await tool(f,claim,'run_command',{idempotencyKey:'manifest',actionId:action.actionId,expectedGeneration:1,command:'manifest',args:{}}));
      assert.ok(['running','completed'].includes(command.state),JSON.stringify(command));
      ok(await tool(f,claim,'wait_command',{idempotencyKey:'wake',actionId:action.actionId,expectedGeneration:1,commandId:command.commandId}));return 'Command retains independent resources';});
    const commandClaim=f.resources.listClaims().find(c=>c.request.threadedCommand?.commandId===command.commandId);assert.ok(commandClaim);
    assert.equal(commandClaim.request.capacity,false);assert.equal(commandClaim.request.session,undefined);
    assert.deepEqual(commandClaim.request.workspaces,[{path:f.workspace,access:'read'},{path:f.output,access:'write'}].sort((a,b)=>a.path.localeCompare(b.path)));
    await wait(async()=>{await f.production.collaboration.commands.recover();return f.db.prepare('SELECT state FROM threaded_commands WHERE id=?').get(command.commandId).state==='completed';},'Native manifest settles through actual production registration');
    const record=JSON.parse(f.db.prepare('SELECT record FROM threaded_os_commands').get().record);assert.equal(record.groupStopped,true);assert.equal(record.effectsReconciled,true);assert.equal(record.resourceReleased,true);
    const manifest=JSON.parse(await readFile(path.join(f.output,'manifest.json'),'utf8'));assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].path,'member/source.txt');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='command' AND state='delivered'").get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_hold_admissions WHERE kind=\'command\'').get().n,1);
    assert.equal(f.db.prepare('SELECT state FROM threaded_actions').get().state,'active');
    const before=f.db.prepare('SELECT COUNT(*) n FROM threaded_os_commands').get().n;await f.production.collaboration.commands.recover();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_os_commands').get().n,before);
    checks.push('RC03-P01: actual production factory enforces retained release/account authority with fixture bypass absent; selected project mapping pins native Session, unregistered shell rejects, real bounded command owns complete read/write claims without model capacity, independent manifest/process proofs release resources, one shared-admission wake never completes the business Action');
  }
  {
    const f=await fixture('observe');await f.register();f.mode('observe');const before=f.db.prepare('SELECT total_changes() n').get().n,requests=injectedModelRequests;
    assert.equal(f.production.recover().observed,true);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(injectedModelRequests,requests);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_os_commands').get().n,0);
    checks.push('RC03-P02: production observe with installed command registration performs no command launch, model call or collaboration recovery write');
  }
  assert.equal(forbiddenNetwork,0);const report={ok:true,groups:checks.length,checks,platform:process.platform,realNativeCommands:1,injectedModelRequests,realModelCalls:0,externalNetworkCalls:forbiddenNetwork,
    scope:'Actual createThreadedProduction with isolated DB, real macOS guardian/native manifest worker and production authority/resources; model transport injected, no daily configuration touched'};
  const output=process.env.THREADED_RC03_PRODUCTION_OUTPUT??'docs/reports/evidence/threaded-rc03-production.json';await mkdir(path.dirname(path.resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{for(const f of fixtures)await f.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
