/** Actual production factory/registered OS profile; model responses remain explicitly injected. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rename,symlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

export async function verifyRc06ProductionWorkspace(root){
  const {applyOrchestrationSchemaMigrations}=await import('../../apps/server/src/db/orchestrationMigrations.ts');
  const {createThreadedStore}=await import('../../apps/server/src/threaded/store.ts');
  const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
  const {assertResourceSessionCurrent}=await import('../../apps/server/src/execution/resources/sessions.ts');
  const {verifyThreadedBackendResourceEvidence}=await import('../../apps/server/src/threaded/backends/evidence.ts');
  const {verifyThreadedOsCommandResourceEvidence}=await import('../../apps/server/src/threaded/osCommands.ts');
  const {createThreadedAuthority}=await import('../../apps/server/src/threaded/authority.ts');
  const {createThreadedMessaging}=await import('../../apps/server/src/threaded/messaging.ts');
  const {loadThreadedProductionSettings}=await import('../../apps/server/src/threaded/productionSettings.ts');
  const {loadThreadedProductionCommands}=await import('../../apps/server/src/threaded/productionCommands.ts');
  const {createThreadedProduction}=await import('../../apps/server/src/threaded/production.ts');
  const {THREADED_APPLICATION_TOOL_NAMES}=await import('../../apps/server/src/threaded/tools.ts');
  const priorBypass=process.env.AGENT_GAND_ISOLATED_WORKER;delete process.env.AGENT_GAND_ISOLATED_WORKER;
  const directory=path.join(root,'production-shared-project');await mkdir(directory);
  const db=new Database(path.join(directory,'production.sqlite'));db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');
  const schema=await readFile(new URL('../../apps/server/src/db/schema.sql',import.meta.url),'utf8');
  db.exec(schema);db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
  let production,messaging,resources,activeClaim,handler=async()=> 'Done',handlerError;
  let injectedModelRequests=0;const checks=[],claimFacts=[],commandFacts=[],resourceDiagnostics=[];
  const stamp=new Date().toISOString(),accountId='rc06-workspace-account',agentIds=['workspace-manager','workspace-a','workspace-b'],model='anthropic:fixture-model';
  try{
    db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
      .run(accountId,'RC06 isolated account','anthropic','api_key','managed',stamp,stamp);
    db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(accountId,JSON.stringify({baseUrl:'https://fixture.invalid',protocols:['anthropic-messages'],models:[model],defaultModel:model,timeoutMs:30000}),stamp);
    db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(accountId,'fixture-only-key','fixture-only-ciphertext','fixture-only-nonce','fixture-only-tag','fake',stamp);
    const members=agentIds.map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model,roleVersion:1,permissionVersion:1,accountId,accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
    for(const agentId of agentIds)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(agentId,agentId,
      JSON.stringify({id:agentId,name:agentId,model,systemPrompt:'Use registered platform tools for isolated shared engineering project acceptance.',tools:THREADED_APPLICATION_TOOL_NAMES,permissionMode:'readonly',accountRef:accountId,requiresAccount:true}),'rc06-isolated',stamp,stamp);
    const releaseFile=path.join(directory,'release.json'),commandsFile=path.join(directory,'commands.json');
    await writeFile(releaseFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:THREADED_APPLICATION_TOOL_NAMES,maxOutputTokens:128,maxInputTokens:65536,maxRequests:4,
      prices:Object.fromEntries(agentIds.map(id=>[id,{inputPerMillion:1,outputPerMillion:1}]))}));
    const settings=loadThreadedProductionSettings(db,{file:releaseFile,workspaceRoot:path.join(directory,'unused-private-workspace'),privateRoot:path.join(directory,'private'),readCredential:()=> 'fixture-only-model-key'});
    const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();
    function attach(registered=false){
      resources=createExecutionResourceCoordinator(db,{ownerNonce:`rc06-production:${randomUUID()}`,validateRequest:r=>assertResourceSessionCurrent(db,r),
        verifyEvidence:(_request,identity,evidence)=>{const claim=resources.getClaim(identity.claimId);return !!claim&&(verifyThreadedBackendResourceEvidence(db,claim,evidence)||verifyThreadedOsCommandResourceEvidence(db,claim,evidence));}});
      for(const name of ['enqueue','tryAcquire','assertExecutable']){const original=resources[name];resources[name]=(...args)=>{try{const result=original(...args);if(name==='tryAcquire')resourceDiagnostics.push({stage:name,acquired:!!result});return result;}catch(error){resourceDiagnostics.push({stage:name,code:String(error.code??error.message).replace(/[^A-Z_]/g,'').slice(0,120)});throw error;}};}
      messaging=createThreadedMessaging(db,{authority:createThreadedAuthority(db,resources),repairIntervalMs:0});
      production=createThreadedProduction(db,{resources,messaging,settings,mode:()=> 'execute',...(registered?{commands:{file:commandsFile}}:{}),
        fetch:async url=>{assert.equal(new URL(url).origin,'https://fixture.invalid');assert.equal(db.inTransaction,false);injectedModelRequests++;
          try{return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:await handler(activeClaim)}],stop_reason:'end_turn',usage:{input_tokens:5,output_tokens:2}}),{headers:{'content-type':'application/json'}});}catch(error){handlerError=error;throw error;}}});
      production.collaboration.close();
    }
    attach();production.release.change({ownerId,expectedVersion:0,requestId:'open',admissionOpen:true,dispatchOpen:true,reason:'RC06 disposable shared workspace acceptance'});
    const thread=production.createThread({ownerId,title:'Actual shared project root',clientRequestId:'thread'});
    const project=path.join(directory,'project'),src=path.join(project,'src'),artifactRoot=path.join(directory,'artifacts');await mkdir(src,{recursive:true});await mkdir(artifactRoot);
    await writeFile(path.join(src,'source.txt'),'RC06 shared engineering source\n');
    const outputs=Object.fromEntries(agentIds.slice(1).map(agentId=>[agentId,path.join(artifactRoot,agentId)]));for(const output of Object.values(outputs))await mkdir(output);
    const config={schemaVersion:1,version:1,ownerId,projects:[{id:'shared-project',root:project,artifactRoot,members:agentIds.map(agentId=>({threadId:thread.id,agentId,workspace:project,workspaceMode:'shared_project'}))}],
      commands:agentIds.slice(1).map((agentId,index)=>({id:`manifest-${index}`,projectId:'shared-project',threadId:thread.id,agentId,profile:'project_manifest_v1',cwd:outputs[agentId],readPaths:[src],writeRoot:outputs[agentId],settleDelayMs:30000}))};
    await production.shutdown(200);messaging.close();await writeFile(commandsFile,JSON.stringify(config));attach(true);
    const options={file:commandsFile,ownerId,mode:()=> 'execute',authorizeMember:s=>s.ownerId===ownerId&&s.threadId===thread.id&&agentIds.includes(s.agentId)?'fixture-live-member':null,resources};
    let registry=loadThreadedProductionCommands(db,options);
    try{
      for(const agentId of agentIds){assert.equal(registry.resolveWorkspace({ownerId,threadId:thread.id,agentId}),project);assert.match(registry.workspaceIdentity({ownerId,threadId:thread.id,agentId}),/^[a-f0-9]{64}$/);}
      assert.equal(registry.resolveWorkspace({ownerId,threadId:'foreign-thread',agentId:agentIds[1]}),null);
      assert.equal(registry.commands['manifest-0'].authorization({ownerId,threadId:thread.id,agentId:agentIds[2]}),null);
      const invalid=[
        c=>delete c.projects[0].artifactRoot,
        c=>c.projects[0].artifactRoot=src,
        c=>c.projects[0].artifactRoot=directory,
        c=>c.projects[0].members[0].workspaceMode='isolated',
        c=>c.projects[0].members[0].workspaceMode='unregistered-mode',
        c=>c.projects[0].members[0].workspace=src,
        c=>delete c.projects[0].members[0].workspaceMode,
        c=>c.commands[0].cwd=c.commands[0].writeRoot=src,
        c=>c.commands[0].cwd=c.commands[0].writeRoot=artifactRoot,
        c=>c.commands[1].cwd=c.commands[1].writeRoot=c.commands[0].writeRoot,
        c=>c.commands[0].readPaths=[artifactRoot],
        c=>c.projects.push({...structuredClone(c.projects[0]),id:'second-project',members:[{threadId:'foreign-thread',agentId:'foreign-agent',workspace:project,workspaceMode:'shared_project'}]}),
      ];
      for(const [index,mutate] of invalid.entries()){const changed=structuredClone(config);mutate(changed);const file=path.join(directory,`invalid-${index}.json`);await writeFile(file,JSON.stringify(changed));
        assert.throws(()=>loadThreadedProductionCommands(db,{...options,file}),/CONFIGURATION_INVALID/);}
      checks.push('RC06-WP01: actual production shared_project registration maps three scoped members to exactly one canonical project root and a disjoint explicit artifactRoot; twelve malformed/mixed/overlapping/input-escape configurations and foreign command authority reject');
    }finally{registry.close();}
    const tool=async(claim,name,input)=>JSON.parse(await production.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
    const ok=answer=>{assert.equal(answer.ok,true,JSON.stringify(answer));return answer.result;};
    async function runFor(agentId,next,receipt){
      if(receipt)for(const wake of receipt.wakes)production.queue.enqueueWake(wake.id);production.queue.scanPending();
      for(let i=0;i<12;i++){
        const claim=production.queue.claimNext('rc06-workspace');assert.ok(claim);activeClaim=claim;handlerError=undefined;let matched=false;
        handler=async c=>{if(c.binding.agentId!==agentId)return 'Other notification';matched=true;return next(c);};
        const result=await production.executeClaim(claim);if(handlerError)throw handlerError;assert.equal(result.status,'completed',JSON.stringify(result));if(matched)return claim;
      }assert.fail('RC06 target never dispatched');
    }
    const receipt=production.collaboration.routing.acceptUserMessage({ownerId,threadId:thread.id,body:`@${agentIds[0]} Inspect the shared engineering project with both registered commands`,clientRequestId:'inspect'}).receipt;
    const initialBudget=production.budget.ensureRootForMessage(receipt.message.id);
    production.budget.reviseRoot({ownerId,rootId:initialBudget.id,expectedVersion:initialBudget.version,requestId:'rc06-fixture-activity',reason:'Disposable acceptance allows bounded full contract preparation',patch:{activityAllowanceMs:10000}});
    const actions=new Map(),commands=new Map();
    await runFor(agentIds[0],async claim=>{
      for(const [index,agentId] of agentIds.slice(1).entries()){
        const task=ok(await tool(claim,'create_task',{idempotencyKey:`task-${index}`,title:`Inspect shared source ${index}`,acceptanceCriteria:['Exact host-verified artifact']}));
        actions.set(agentId,ok(await tool(claim,'transfer_action',{idempotencyKey:`action-${index}`,subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:[agentId]})));
      }return 'Assigned shared source inspections';
    },receipt);
    for(const [index,agentId] of agentIds.slice(1).entries())await runFor(agentId,async claim=>{
      assert.deepEqual(resources.getClaim(claim.binding.claimId).request.workspaces,[{path:project,access:'read'}]);
      const sessions=db.prepare("SELECT record FROM execution_resource_sessions WHERE json_extract(record,'$.policy.agentId')=? ORDER BY rowid DESC").all(agentId);
      assert.ok(sessions.length);assert.equal(JSON.parse(sessions[0].record).policy.workspace,project);
      const context=db.prepare('SELECT base_boundary FROM threaded_session_context_versions WHERE agent_id=? ORDER BY rowid DESC LIMIT 1').get(agentId);assert.match(context.base_boundary,/:project:/);
      claimFacts.push({agentId,workspace:path.relative(root,project),access:'read',claimId:claim.binding.claimId,sessionWorkspaceMatches:true});
      const action=actions.get(agentId),command=ok(await tool(claim,'run_command',{idempotencyKey:`command-${index}`,actionId:action.actionId,expectedGeneration:1,command:`manifest-${index}`,args:{}}));
      commands.set(agentId,command);ok(await tool(claim,'wait_command',{idempotencyKey:`wait-${index}`,actionId:action.actionId,expectedGeneration:1,commandId:command.commandId}));return 'Await verified isolated artifact';
    });
    const liveCommands=resources.listClaims().filter(c=>c.request.threadedCommand);
    assert.equal(liveCommands.length,2,JSON.stringify({resourceDiagnostics,receipts:[...commands.entries()],commands:db.prepare("SELECT command_id,state,json_extract(record,'$.stage') stage FROM threaded_os_commands").all(),events:db.prepare('SELECT kind,created_at FROM threaded_os_command_events').all()}));assert.ok(liveCommands.every(c=>c.state==='started'));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM threaded_os_command_events WHERE kind='native_started'").get().n,2);
    checks.push('RC06-WP02: actual createThreadedProduction with bypass absent binds both operators’ Session policy/context and model claims to the entire shared project root; two real registered native commands remain started together, reading shared source and writing separate external artifacts without narrowing the model read claim');
    const deadline=Date.now()+40000;let completed=false;
    while(Date.now()<deadline){await production.collaboration.commands.recover();completed=db.prepare("SELECT COUNT(*) n FROM threaded_commands WHERE state='completed'").get().n===2;if(completed)break;await new Promise(resolve=>setTimeout(resolve,50));}
    assert.ok(completed,'Both actual native commands must complete');
    for(const agentId of agentIds.slice(1)){
      const command=commands.get(agentId),row=db.prepare('SELECT * FROM threaded_os_commands WHERE command_id=?').get(command.commandId),record=JSON.parse(row.record);
      assert.equal(record.groupStopped,true);assert.equal(record.effectsReconciled,true);assert.equal(record.resourceReleased,true);
      const claim=resources.getClaim(JSON.parse(row.claim_record).claimId);assert.equal(claim.state,'released');assert.equal(claim.request.capacity,false);assert.equal(claim.request.session,undefined);
      assert.deepEqual(claim.request.workspaces,[{path:src,access:'read'},{path:outputs[agentId],access:'write'}].sort((a,b)=>a.path.localeCompare(b.path)));
      const bytes=await readFile(path.join(outputs[agentId],'manifest.json')),manifest=JSON.parse(bytes.toString());assert.deepEqual(manifest.files.map(f=>f.path),['src/source.txt']);
      commandFacts.push({agentId,commandId:command.commandId,guardianPid:record.pid,profile:'project_manifest_v1',readPath:path.relative(root,src),writePath:path.relative(root,outputs[agentId]),sha256:createHash('sha256').update(bytes).digest('hex'),groupStopped:true,effectsReconciled:true,resourceReleased:true});
    }
    assert.equal(commandFacts[0].sha256,commandFacts[1].sha256);
    checks.push('RC06-WP03: both real macOS guardian/native manifests independently settle with exact matching source hashes, distinct artifact roots, complete read/write leases, process-group stop and host side-effect receipts; no model/native capacity or actual Session is double-counted for either OS command');
    // Fresh registry after settled output is allowed; replacing the artifact root then fails closed.
    registry=loadThreadedProductionCommands(db,options);
    try{const moved=artifactRoot+'-moved';await rename(artifactRoot,moved);await symlink(moved,artifactRoot);
      assert.equal(registry.commands['manifest-0'].authorization({ownerId,threadId:thread.id,agentId:agentIds[1]}),null);
      assert.equal(registry.status().state,'path_changed');assert.throws(()=>registry.resolveWorkspace({ownerId,threadId:thread.id,agentId:agentIds[1]}),/MAPPING_CHANGED/);
    }finally{registry.close();}
    checks.push('RC06-WP04: replacing the registered external artifact root with a symlink revokes command and shared workspace mapping; the production registry fails closed and cannot fall back to a member-specific directory');
    return {groups:checks.length,checks,platform:process.platform,injectedModelRequests,realNativeCommands:2,observedConcurrentStartedNativeCommands:2,claimFacts,commandFacts,productionProjectBindingVerified:true,
      fixtureActivityAllowanceMs:10000,productionDefaultActivityAllowanceChanged:false,realModelCalls:0,realModelTokens:0,productionEngineeringWriteOrMergeTool:false};
  }finally{
    if(production)await production.shutdown(1000);messaging?.close();if(db.open)db.close();
    if(priorBypass===undefined)delete process.env.AGENT_GAND_ISOLATED_WORKER;else process.env.AGENT_GAND_ISOLATED_WORKER=priorBypass;
  }
}
