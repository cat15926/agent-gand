/** Disposable RC05 storage/authority fault composition. It runs the real
 * production factory and SQLite, with an injected deterministic model transport.
 * It is not index.ts, a real supplier, or an arbitrary filesystem fault emulator. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

let imports;
async function modules(root){
  if(!imports){
    Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-import.sqlite'),AGENTS_DIR:path.join(root,'unused-agents')});
    assert.notEqual(process.env.AGENT_GAND_ISOLATED_WORKER,'1','Storage acceptance must enforce production authority');
    imports=Promise.all([
      import('../../apps/server/src/db/orchestrationMigrations.ts'),import('../../apps/server/src/threaded/store.ts'),
      import('../../apps/server/src/execution/resources/coordinator.ts'),import('../../apps/server/src/execution/resources/sessions.ts'),
      import('../../apps/server/src/threaded/backends/evidence.ts'),import('../../apps/server/src/threaded/authority.ts'),
      import('../../apps/server/src/threaded/messaging.ts'),import('../../apps/server/src/threaded/productionSettings.ts'),
      import('../../apps/server/src/threaded/production.ts'),
    ]).then(modules=>Object.assign({},...modules));
  }
  return imports;
}

export async function openRc05Storage(root,name){
  assert.ok(path.isAbsolute(root));assert.match(name,/^[a-z0-9-]{1,60}$/);
  const m=await modules(root),directory=path.join(root,name);await mkdir(directory,{recursive:true});
  const file=path.join(directory,'business.sqlite'),packFile=path.join(directory,'release.json');
  let db=new Database(file,{timeout:50}),production,messaging,resources,activeClaim,plan={},transportCalls=0,closed=false;
  const stamp=new Date().toISOString(),accountId=`${name}-account`,author=`${name}-author`,peer=`${name}-peer`,agentIds=[author,peer],model='anthropic:rc05-storage-fixture';
  db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');
  db.exec(await readFile(new URL('../../apps/server/src/db/schema.sql',import.meta.url),'utf8'));
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');m.applyOrchestrationSchemaMigrations(db);
  db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
    .run(accountId,'Disposable RC05 storage account','anthropic','api_key','managed',stamp,stamp);
  db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(accountId,JSON.stringify({baseUrl:'https://rc05-storage.invalid',protocols:['anthropic-messages'],models:[model],defaultModel:model,timeoutMs:120000}),stamp);
  db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(accountId,'fixture-key-id','fixture-ciphertext','fixture-nonce','fixture-tag','fake',stamp);
  const members=agentIds.map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model,roleVersion:1,permissionVersion:1,accountId,
    accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
  for(const id of agentIds)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id,
    JSON.stringify({id,name:id,model,systemPrompt:'RC05 local deterministic storage acceptance.',tools:[],permissionMode:'readonly',accountRef:accountId,requiresAccount:true}),'rc05-storage-isolated',stamp,stamp);
  await writeFile(packFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools:[],maxOutputTokens:128,maxInputTokens:65536,maxRequests:3,
    prices:Object.fromEntries(agentIds.map(id=>[id,{inputPerMillion:1,outputPerMillion:1}]))}));
  const ownerId=m.createThreadedStore(db).getInstanceOwnerId();
  function attach(){
    const settings=m.loadThreadedProductionSettings(db,{file:packFile,workspaceRoot:path.join(directory,'workspace'),privateRoot:path.join(directory,'private'),platform:'darwin',readCredential:()=> 'rc05-local-fixture-key'});
    resources=m.createExecutionResourceCoordinator(db,{ownerNonce:`rc05-storage:${randomUUID()}`,validateRequest:r=>m.assertResourceSessionCurrent(db,r),
      verifyEvidence:(_r,claim,evidence)=>{const saved=resources.getClaim(claim.claimId);return !!saved&&m.verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
    messaging=m.createThreadedMessaging(db,{authority:m.createThreadedAuthority(db,resources),repairIntervalMs:0});
    production=m.createThreadedProduction(db,{resources,messaging,settings,mode:()=> 'execute',fetch:async(input,init)=>{
      assert.equal(new URL(input).origin,'https://rc05-storage.invalid');assert.equal(db.inTransaction,false);transportCalls++;
      await plan.beforeResponse?.({binding:activeClaim.binding,signal:init.signal});
      return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:plan.body??'RC05 deterministic final'}],
        stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
    }});
    production.collaboration.close();
  }
  attach();
  production.release.change({ownerId,expectedVersion:0,requestId:'rc05-storage-open-fixture',admissionOpen:true,dispatchOpen:true,reason:'Disposable RC05 storage acceptance only'});
  const thread=production.createThread({ownerId,title:`RC05 storage ${name}`,clientRequestId:'rc05-new-local-thread'});
  const counts=()=>Object.fromEntries(['threaded_messages','threaded_wakes','threaded_outbox','threaded_invocations','runs','threaded_attempts','threaded_invocation_terminals',
    'threaded_outputs','threaded_backend_requests','threaded_budget_roots','threaded_budget_requests','threaded_budget_outcomes','threaded_release_roots','execution_resource_claims','threaded_approvals']
    .map(table=>[table,db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n]));
  const rows=(table,columns='*')=>db.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all();
  const snapshot=()=>({name,transportCalls,counts:counts(),messages:rows('threaded_messages','id,origin,body,causal_root_id'),
    wakes:rows('threaded_wakes','id,source_message_id,target_agent_id'),queue:rows('threaded_wake_queue','id,state,reason,agent_id,causal_root_id,invocation_id'),
    attempts:rows('threaded_attempts','id,invocation_id,status,execution_stage,outcome_record,resource_release_state'),
    invocations:rows('threaded_invocations','id,status,authority_epoch,current_attempt_id,recovery_reason,causal_root_id'),
    runs:rows('runs','id,status,terminal_disposition,finished_at'),terminals:rows('threaded_invocation_terminals'),outputs:rows('threaded_outputs'),
    budgets:rows('threaded_budget_requests'),budgetOutcomes:rows('threaded_budget_outcomes'),backend:rows('threaded_backend_requests'),
    claims:rows('execution_resource_claims','id,state'),approvals:rows('threaded_approvals','id,status,invocation_id,binding_id,decision_request_id'),foreignKeys:db.pragma('foreign_key_check')});
  const fixture={file,ownerId,thread,author,peer,accountId,get db(){return db;},get production(){return production;},get resources(){return resources;},get transportCalls(){return transportCalls;},snapshot,
    user(body='RC05 storage source',requestId=randomUUID()){
      const receipt=production.collaboration.routing.acceptUserMessage({ownerId,threadId:thread.id,body:`@${author} ${body}`,clientRequestId:requestId}).receipt;
      const budget=production.budget.ensureRootForMessage(receipt.message.id);
      if(budget.version===1)production.budget.reviseRoot({ownerId,rootId:budget.id,expectedVersion:budget.version,requestId:`storage-activity:${requestId}`,
        reason:'Disposable storage fault fixture isolates transaction behavior with an explicit ten-second renewable activity slice; production defaults are unchanged',patch:{activityAllowanceMs:10000}});
      for(const wake of receipt.wakes)production.queue.enqueueWake(wake.id);production.queue.scanPending();return receipt;
    },
    claim(){production.queue.scanPending();return production.queue.claimNext(`rc05-storage:${name}`);},
    async execute(claim,nextPlan={}){activeClaim=claim;plan=nextPlan;assert.ok(claim,'Claim required');try{return await production.executeClaim(claim);}finally{activeClaim=undefined;plan={};production.collaboration.close();}},
    async reopen(){assert.equal(activeClaim,undefined,'Cannot rebuild while an execution Promise is active');await production.shutdown(200);messaging.close();db.close();
      db=new Database(file,{timeout:50,fileMustExist:true});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');m.assertOrchestrationSchemaCompatible(db);attach();return fixture;},
    recover(){const value=production.recover();production.collaboration.close();return value;},
    restrict(kind){
      if(kind==='permission')db.prepare('UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id=?').run(thread.id,author);
      else if(kind==='member-left')db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id=?").run(thread.id,author);
      else if(kind==='account'){db.transaction(()=>{db.prepare('UPDATE accounts SET enabled=0,version=version+1 WHERE id=?').run(accountId);
        db.prepare('INSERT OR IGNORE INTO account_revocations VALUES(?,?)').run(accountId,new Date().toISOString());production.lifecycle.revokeAccount(accountId);}).immediate();}
      else throw new Error('Unsupported fixture restriction');
    },
    async close(){if(closed)return;closed=true;await production.shutdown(200);messaging.close();if(db.open)db.close();},
  };
  return fixture;
}
