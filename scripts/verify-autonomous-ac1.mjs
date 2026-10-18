import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';
import {nativeScopeFixture} from './helpers/scoped-native-fixture.mjs';

const env=await createDemoEnvironment(),db=env.database,checks=[];
const qa=path.resolve('apps/server/data/autonomous-ac1-qa');await mkdir(qa,{recursive:true,mode:0o700});
const previousModule=path.join(qa,'previous-worker-'+randomUUID()+'.ts');
const registry=await import('../apps/server/src/agents/registry.ts'),rooms=await import('../apps/server/src/conversations/service.ts'),trace=await import('../apps/server/src/runs/trace.ts');
const {post}=await import('../apps/server/src/messaging/inbox.ts'),policy=await import('../apps/server/src/runtime/runPolicy.ts'),scopes=await import('../apps/server/src/runtime/scopedCollaboration.ts');
const {freezeRuntimeContract,runtimeControlActionVersion}=await import('../apps/server/src/runtime/controlAction.ts'),tasks=await import('../apps/server/src/runtime/autonomousTasks.ts');
const {loadAutonomousTaskPolicy}=await import('../apps/server/src/runtime/autonomousPolicy.ts'),{withAutonomousExecution}=await import('../apps/server/src/runtime/autonomousExecution.ts');
const {observeClaim}=await import('../apps/server/src/runtime/shadow.ts'),{budgetedChat}=await import('../apps/server/src/orchestration/executionBudget.ts');
const calls=await import('../apps/server/src/orchestration/modelCalls.ts'),nativeBudget=await import('../apps/server/src/execution/scopedNativeBudget.ts');
const {config}=await import('../apps/server/src/config.ts');
const latestSchema=(await import('../apps/server/src/db/orchestrationMigrations.ts')).ORCHESTRATION_MIGRATIONS.at(-1).version;
const coordinator='ac-coordinator',reader='ac-reader',writer='ac-writer',sdk='ac-sdk';
const ids=[coordinator,reader,writer,sdk];
for(const id of ids.slice(0,3))registry.createAgent({id,name:id,description:'AC1 isolated fixture',systemPrompt:'Use the task authority only.',model:'mock:'+id,capabilities:['execute'],permissionMode:id===writer?'auto':'readonly',tools:['fs.read','search.files',...(id===writer?['fs.write']:[])],disallowedTools:[],color:'#4477aa',avatar:''});
registry.createAgent({...registry.getAnyAgent('sdk'),id:sdk,name:sdk,permissionMode:'readonly',tools:['fs.read'],execution:{...registry.getAnyAgent('sdk').execution,platformTools:['fs.read']}});
const rootDraft=(extra={})=>({coordinatorId:coordinator,participantIds:ids,budget:{maxOutputTokens:30,maxTokensPerCall:20,maxDispatches:10,maxDepth:2},...extra});
function seed({privateRoot=false,onlyCoordinator=false,costLimit=.1}={}){
  const members=onlyCoordinator?[coordinator]:ids;
  const room=rooms.createConversation({title:'AC1 root fixture',mode:'collaboration',agentIds:members,workspace:null,preferences:{strategy:'auto',workflow:'routine',constraints:{costPolicy:{version:1,currency:'USD',mode:'estimate',maxCost:costLimit,unknownAction:'reserve',unknownReserve:.01,prices:[]}}}});
  const run=trace.createRun('AC1 approved root objective','collaboration',members,null,null,room.id);trace.setRunStatus(run.id,'running');
  const root=post({runId:run.id,from:'user',to:coordinator,kind:'user',body:run.goal,...(privateRoot?{visibility:'private',audience:['user',coordinator]}:{})});
  return {run,room,root};
}
function subject(f,parent,agentId){const id=randomUUID(),now=new Date().toISOString();db.run("INSERT INTO runtime_subjects VALUES(?,?,?,?,?,'active',?,?,?)",id,f.run.id,randomUUID(),'consultation',parent,'child '+agentId,now,now);db.run("INSERT INTO runtime_custody VALUES(?,'unassigned',NULL,NULL,0,0,?)",id,now);return id;}
function attempt(f,grant){const dispatch=randomUUID(),id=randomUUID(),now=new Date().toISOString();
  db.run("INSERT INTO collaboration_dispatches(id,run_id,conversation_id,source_message_id,kind,from_actor,target_agent_id,status,depth,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,'running',?,?,?)",dispatch,f.run.id,f.room.id,f.root.id,grant.parentGrantId?'fanout':'initial','user',grant.agentId,grant.depth,dispatch,now);
  db.run('INSERT INTO runtime_dispatch_subjects VALUES(?,?,?)',dispatch,grant.subjectId,null);
  db.run("INSERT INTO collaboration_attempts(id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,lease_owner,lease_expires_at,created_at,started_at) VALUES(?,?,?,?,?,1,'running',?,?,?,?)",id,dispatch,f.run.id,f.room.id,grant.agentId,'ac1-fixture',new Date(Date.now()+120000).toISOString(),now,now);
  observeClaim(dispatch,id,grant.agentId);return tasks.bindAutonomousAttempt(grant.id,id);
}
const failure=(fn,code)=>assert.throws(fn,error=>error.code===code||String(error.message).includes(code));
const response=(tokens=5)=>({content:'已完成独立检查，证据和局限明确。',toolCalls:[],usage:{tokensIn:3,tokensOut:tokens,costUsd:.001,costKnown:true,costSource:'reported',inputKnown:true,outputKnown:true},stopReason:'end_turn',truncated:false});
let providerCalls=0;
const chat=(binding,agentId,provider,maxTokens=200)=>withAutonomousExecution(binding,()=>budgetedChat(binding.runId,provider,{model:registry.getAnyAgent(agentId).model,messages:[{role:'user',content:'approved synthetic task'}],maxTokens},undefined,agentId,binding.attemptId));
try{
  // A real v17 fixture has nonempty Scope/provenance and an old unknown reservation.
  const historical=nativeScopeFixture({db,scopes,policy,freezeRuntimeContract,post});
  const oldScope=historical.create(historical.message('HISTORICAL_PRIVATE_INPUT')),oldBinding=historical.binding(oldScope);scopes.assembleScopedContext(oldBinding);
  db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,used,status,created_at) VALUES(?,?,4096,4096,'unknown',?)",randomUUID(),historical.runId,new Date().toISOString());
  const tables=['runs','messages','runtime_contracts','runtime_execution_scopes','runtime_context_manifests','runtime_scope_attempts','runtime_input_provenance','orchestration_token_reservations'];
  const digest=database=>createHash('sha256').update(JSON.stringify(tables.map(t=>database.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex');
  const migrationFile=path.join(env.root,'v17.sqlite');await db.db.backup(migrationFile);const oldDb=new Database(migrationFile);
  oldDb.exec('PRAGMA foreign_keys=OFF;DROP TABLE autonomous_pause_points;DROP TABLE autonomous_user_instructions;DROP TABLE autonomous_submissions;DROP TABLE autonomous_tool_receipts;DROP TABLE autonomous_intake_copies;DROP TABLE autonomous_decision_resolutions;DROP TABLE autonomous_decision_proposals;DROP TABLE autonomous_emission_records;DROP TABLE autonomous_emission_plans;DROP TABLE autonomous_aggregate_sources;DROP TABLE autonomous_results;DROP TABLE autonomous_delegation_rounds;DROP TABLE autonomous_dispatch_work;DROP TABLE autonomous_work_dependencies;DROP TABLE autonomous_work_items;DROP TABLE autonomous_attempt_grants;DROP TABLE autonomous_task_revocations;DROP TABLE autonomous_task_grants;DROP TABLE autonomous_task_policies;DELETE FROM orchestration_schema_migrations WHERE version>=18;PRAGMA foreign_keys=ON');
  const oldDigest=digest(oldDb);await writeFile(previousModule,execFileSync('git',['show','0460b37:apps/server/src/db/orchestrationMigrations.ts'],{encoding:'utf8'}),{mode:0o600});
  const oldWorker=await import(pathToFileURL(previousModule).href);oldWorker.assertOrchestrationSchemaCompatible(oldDb);oldDb.close();
  const migrate=`const d=await import('./apps/server/src/db/database.ts');if(d.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n!==${latestSchema})throw new Error('SCHEMA_NOT_CURRENT');d.closeDatabase();`;
  for(let i=0;i<2;i++)execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',migrate],{env:{...process.env,DB_PATH:migrationFile},stdio:'pipe'});
  const upgraded=new Database(migrationFile,{readonly:true});assert.equal(digest(upgraded),oldDigest);assert.deepEqual(upgraded.pragma('foreign_key_check'),[]);assert.throws(()=>oldWorker.assertOrchestrationSchemaCompatible(upgraded),/版本|migration|schema/i);upgraded.close();
  checks.push('v17 → current twice preserves historical root/Scope/provenance/unknown bytes; actual v17 worker rejects current');

  const f=seed(),secret=post({runId:f.run.id,from:'user',to:reader,kind:'system',body:'PRIVATE_READER_ONLY',visibility:'private',audience:['user',reader]});
  const draft=rootDraft({inputs:[{kind:'message',id:secret.id,readers:[reader]}]}),frozen=tasks.freezeAutonomousTask(f.run.id,draft),binding=attempt(f,frozen.rootGrant);
  assert.equal(policy.resolveRunPolicy(f.run.id).toolApiVersion,4);assert.deepEqual(tasks.freezeAutonomousTask(f.run.id,{...draft,budget:{...draft.budget}}),frozen);
  failure(()=>tasks.freezeAutonomousTask(f.run.id,{...draft,budget:{maxOutputTokens:31}}),'AUTONOMOUS_AUTHORITY_INVALID');
  assert.equal(tasks.autonomousCollaborationSupport().executionAvailable,false);assert.equal(config.autonomousCollaborationMode,'closed');
  config.autonomousCollaborationMode='execute';failure(()=>policy.assertExecutableCollaborationPolicy(f.run.id),'RUNTIME_CAPABILITY_UNAVAILABLE');failure(()=>runtimeControlActionVersion(f.run.id),'RUNTIME_CAPABILITY_UNAVAILABLE');config.autonomousCollaborationMode='closed';
  assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_model_calls WHERE run_id=?',f.run.id).n,0);
  checks.push('independent v4 policy and root Subject freeze idempotently; changed request rejected; executor remains closed even under execute setting');

  const childSubject=subject(f,frozen.rootGrant.subjectId,reader),childRequest={agentId:reader,inputIds:[secret.id],allowedTools:['fs.read'],actions:['delegate','complete'],commandKey:'ac1-child-'+randomUUID()};
  const child=tasks.deriveAutonomousGrant(binding,childSubject,childRequest),childBinding=attempt(f,child);
  assert.equal(tasks.deriveAutonomousGrant(binding,childSubject,childRequest).id,child.id);
  failure(()=>tasks.deriveAutonomousGrant(binding,childSubject,{...childRequest,agentId:writer}),'AUTONOMOUS_ACCESS_DENIED');
  failure(()=>tasks.deriveAutonomousGrant(binding,childSubject,{...childRequest,outputAccess:{visibility:'public',audience:[]},commandKey:randomUUID()}),'AUTONOMOUS_ACCESS_DENIED');
  failure(()=>tasks.deriveAutonomousGrant(binding,childSubject,{...childRequest,maxOutputTokens:999999,commandKey:randomUUID()}),'AUTONOMOUS_CONTRACT_INVALID');
  failure(()=>tasks.deriveAutonomousGrant(binding,childSubject,{...childRequest,allowedTools:['shell.exec'],commandKey:randomUUID()}),'AUTONOMOUS_ACCESS_DENIED');
  failure(()=>tasks.deriveAutonomousGrant(binding,childSubject,{...childRequest,expiresAt:new Date(Date.parse(frozen.policy.budget.deadlineAt)+1).toISOString(),commandKey:randomUUID()}),'AUTONOMOUS_LIMIT_EXCEEDED');
  const outsider=seed(),outsideSubject=subject(outsider,frozen.rootGrant.subjectId,reader);
  failure(()=>tasks.deriveAutonomousGrant(binding,outsideSubject,childRequest),'AUTONOMOUS_AUTHORITY_INVALID');
  const grandSubject=subject(f,child.subjectId,writer);
  failure(()=>tasks.deriveAutonomousGrant(childBinding,grandSubject,{agentId:writer,commandKey:randomUUID()}),'AUTONOMOUS_ACCESS_DENIED');
  const writeGrant=tasks.deriveAutonomousGrant(binding,subject(f,frozen.rootGrant.subjectId,writer),{agentId:writer,allowedTools:['fs.write'],commandKey:randomUUID()});
  assert.deepEqual(writeGrant.allowedTools,['fs.write']);assert.ok(!frozen.rootGrant.allowedTools.includes('fs.write'),'a readonly coordinator may assign an authorized writer without gaining write permission itself');
  checks.push('subject/Attempt-bound attenuating grants; blind private forwarding; no ACL/tool/participant/expiry/budget/Run escalation; separate delegated tool ceiling');

  const privateRoot=seed({privateRoot:true});failure(()=>tasks.freezeAutonomousTask(privateRoot.run.id,rootDraft()),'AUTONOMOUS_ACCESS_DENIED');
  assert.equal(loadAutonomousTaskPolicy(privateRoot.run.id),null,'rejection rolls back all authority');
  failure(()=>tasks.freezeAutonomousTask(historical.runId,rootDraft({participantIds:['a','b'],coordinatorId:'a'})),'AUTONOMOUS_CONTRACT_INVALID');
  const beforePrivate=db.get('SELECT COUNT(*) n FROM autonomous_task_grants').n;
  db.run("UPDATE messages SET audience='[\"user\"]' WHERE id=?",secret.id);
  failure(()=>tasks.assertAutonomousGrant(childBinding),'AUTONOMOUS_POLICY_DRIFT');
  assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_task_grants').n,beforePrivate);
  checks.push('explicit private root is never widened; historical Run cannot upgrade; source ACL drift rejects a formerly valid grant');

  // An API call and a second branch consume the same root reservations.
  const money=seed(),budget=tasks.freezeAutonomousTask(money.run.id,rootDraft()),ownerBinding=attempt(money,budget.rootGrant);
  const second=tasks.deriveAutonomousGrant(ownerBinding,subject(money,budget.rootGrant.subjectId,reader),{agentId:reader,commandKey:randomUUID()}),secondBinding=attempt(money,second);
  let unblock;const barrier=new Promise(resolve=>unblock=resolve),maxima=[];
  const provider={chat:async req=>{providerCalls++;maxima.push(req.maxTokens);await barrier;return response();}};
  const parallel=[chat(ownerBinding,coordinator,provider),chat(secondBinding,reader,provider)];
  for(let n=0;n<100&&maxima.length!==2;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.deepEqual([...maxima].sort((a,b)=>a-b),[10,20]);assert.equal(db.get("SELECT SUM(reserved) n FROM orchestration_token_reservations WHERE run_id=? AND status='pending'",money.run.id).n,30);
  unblock();await Promise.all(parallel);
  assert.equal(db.get('SELECT SUM(used) n FROM orchestration_token_reservations WHERE run_id=?',money.run.id).n,10);
  assert.equal(db.get('SELECT COUNT(*) n FROM execution_cost_reservations WHERE run_id=?',money.run.id).n,2);
  await assert.rejects(()=>budgetedChat(money.run.id,provider,{model:'mock:'+coordinator,messages:[]},undefined,coordinator,ownerBinding.attemptId),/AUTONOMOUS_AUTHORITY_INVALID/);
  await assert.rejects(()=>withAutonomousExecution(ownerBinding,()=>budgetedChat(outsider.run.id,provider,{model:'mock:'+coordinator,messages:[]},undefined,coordinator,ownerBinding.attemptId)),/AUTONOMOUS_AUTHORITY_INVALID/);
  await assert.rejects(()=>withAutonomousExecution(ownerBinding,()=>budgetedChat(money.run.id,provider,{model:'forged-model',messages:[]},undefined,coordinator,ownerBinding.attemptId)),/AUTONOMOUS_AUTHORITY_INVALID/);
  assert.equal(providerCalls,2);
  checks.push('concurrent API branches share 30 root tokens and one money ledger; unbound/cross-Run/changed-model calls never reach a provider');

  const nativeGrant=tasks.deriveAutonomousGrant(ownerBinding,subject(money,budget.rootGrant.subjectId,sdk),{agentId:sdk,commandKey:randomUUID()}),nativeBinding=attempt(money,nativeGrant);
  await withAutonomousExecution(nativeBinding,async()=>{
    const call=calls.queueModelCall(money.run.id,sdk,registry.getAnyAgent(sdk).model,'claude-sdk',nativeBinding.attemptId);
    await nativeBudget.reserveScopedNativeTokens(money.run.id,call,AbortSignal.timeout(2000));assert.equal(db.get('SELECT reserved FROM orchestration_token_reservations WHERE id=?',call).reserved,20);
    calls.startModelCall(call);nativeBudget.settleScopedNativeTokens(call,null);calls.finishModelCall(call,false);
  });
  await assert.rejects(()=>chat(ownerBinding,coordinator,provider),/未知|UNKNOWN/);assert.equal(providerCalls,2);
  assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id=? AND status='unknown' AND reserved=20",money.run.id).n,1);
  checks.push('native ledger fixture reserves only the API remainder; unknown retains 20 and blocks following root requests; native model calls = 0');

  const bounded=seed({costLimit:.01}),boundedRoot=tasks.freezeAutonomousTask(bounded.run.id,rootDraft()),boundedBinding=attempt(bounded,boundedRoot.rootGrant);
  const paid={chat:async()=>{providerCalls++;return {...response(),usage:{...response().usage,costUsd:.01}};}};
  await chat(boundedBinding,coordinator,paid);await assert.rejects(()=>chat(boundedBinding,coordinator,paid),/费用预算不足/);
  assert.equal(providerCalls,3);assert.equal(db.get("SELECT SUM(known) n FROM execution_cost_reservations WHERE run_id=?",bounded.run.id).n,10000);
  checks.push('root money ceiling applies across calls; exhausted cost budget stops before provider I/O');

  const throttled=seed(),throttledRoot=tasks.freezeAutonomousTask(throttled.run.id,rootDraft({budget:{maxOutputTokens:30,maxTokensPerCall:20,maxConcurrency:1,maxDepth:1,maxDispatches:2}})),throttledBinding=attempt(throttled,throttledRoot.rootGrant);
  const onlyChild=tasks.deriveAutonomousGrant(throttledBinding,subject(throttled,throttledRoot.rootGrant.subjectId,reader),{agentId:reader,participantIds:ids,actions:['delegate','complete'],commandKey:randomUUID()}),onlyChildBinding=attempt(throttled,onlyChild);
  failure(()=>tasks.deriveAutonomousGrant(throttledBinding,subject(throttled,throttledRoot.rootGrant.subjectId,writer),{agentId:writer,commandKey:randomUUID()}),'AUTONOMOUS_LIMIT_EXCEEDED');
  failure(()=>tasks.deriveAutonomousGrant(onlyChildBinding,subject(throttled,onlyChild.subjectId,writer),{agentId:writer,commandKey:randomUUID()}),'AUTONOMOUS_LIMIT_EXCEEDED');
  let releaseCall;const oneAtATime=new Promise(resolve=>releaseCall=resolve);let started=false;
  const busy={chat:async()=>{providerCalls++;started=true;await oneAtATime;return response();}};
  const first=chat(throttledBinding,coordinator,busy);for(let n=0;n<100&&!started;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(started);
  await assert.rejects(()=>chat(onlyChildBinding,reader,busy),/AUTONOMOUS_LIMIT_EXCEEDED/);releaseCall();await first;assert.equal(providerCalls,4);
  checks.push('frozen depth/dispatch/concurrency ceilings cannot be raised by descendants; pre-I/O blocked reservations are released');

  const late=seed(),lateRoot=tasks.freezeAutonomousTask(late.run.id,rootDraft()),lateBinding=attempt(late,lateRoot.rootGrant);
  let releaseLate,lateStarted=false;const lateBarrier=new Promise(resolve=>releaseLate=resolve),lateDeltas=[];
  const lateProvider={chat:async(_request,delta)=>{providerCalls++;lateStarted=true;await lateBarrier;delta?.('late revoked content');return response();}};
  const lateCall=withAutonomousExecution(lateBinding,()=>budgetedChat(late.run.id,lateProvider,{model:registry.getAnyAgent(coordinator).model,messages:[]},text=>lateDeltas.push(text),coordinator,lateBinding.attemptId));
  const rejectedLate=assert.rejects(lateCall,/AUTONOMOUS_GRANT_REVOKED/);
  for(let n=0;n<100&&!lateStarted;n++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(lateStarted);
  tasks.revokeAutonomousAuthority(late.run.id,lateRoot.rootGrant.id,'revoked during provider I/O');releaseLate();await rejectedLate;
  assert.deepEqual(lateDeltas,[]);assert.equal(providerCalls,5);
  assert.deepEqual(db.get('SELECT used,status FROM orchestration_token_reservations WHERE run_id=?',late.run.id),{used:5,status:'settled'});
  assert.equal(db.get('SELECT status FROM orchestration_model_calls WHERE run_id=?',late.run.id).status,'completed');
  assert.equal(db.get('SELECT status FROM execution_cost_reservations WHERE run_id=?',late.run.id).status,'settled');
  checks.push('revocation during I/O suppresses late deltas and final content while preserving known completed token/money usage');

  const malformed=seed(),frozenContract=policy.loadRuntimeContract(f.run.id);
  db.run('INSERT INTO runtime_contracts VALUES(?,?,?,?)',malformed.run.id,1,JSON.stringify({...frozenContract,runId:malformed.run.id,features:{...frozenContract.features,autonomousCollaboration:{...frozenContract.features.autonomousCollaboration,version:99}}}),new Date().toISOString());
  failure(()=>policy.loadRuntimeContract(malformed.run.id),'RUNTIME_POLICY_UNKNOWN_VERSION');
  await assert.rejects(()=>budgetedChat(malformed.run.id,provider,{model:'mock:'+coordinator,messages:[]},undefined,coordinator),/AUTONOMOUS_AUTHORITY_INVALID/);
  const beforeNow=Date.now;try{Date.now=()=>Date.parse(frozen.policy.budget.deadlineAt)+1;failure(()=>tasks.assertAutonomousGrant(binding),'AUTONOMOUS_TASK_EXPIRED');}finally{Date.now=beforeNow;}
  checks.push('unknown autonomous versions are rejected without downgrade; expired root authority cannot be reused');

  const revoked=seed(),rev=tasks.freezeAutonomousTask(revoked.run.id,rootDraft()),revBinding=attempt(revoked,rev.rootGrant);
  const revChild=tasks.deriveAutonomousGrant(revBinding,subject(revoked,rev.rootGrant.subjectId,reader),{agentId:reader,commandKey:randomUUID()}),revChildBinding=attempt(revoked,revChild);
  tasks.revokeAutonomousAuthority(revoked.run.id,rev.rootGrant.id,'owner revocation fixture');failure(()=>tasks.assertAutonomousGrant(revChildBinding),'AUTONOMOUS_GRANT_REVOKED');
  const originalGeneration=db.get('SELECT generation FROM runtime_custody WHERE subject_id=?',budget.rootGrant.subjectId).generation;
  db.run('UPDATE runtime_custody SET generation=? WHERE subject_id=?',originalGeneration+1,budget.rootGrant.subjectId);
  assert.throws(()=>tasks.assertAutonomousGrant(ownerBinding),/失效|AUTHORITY/);
  for(const [table,column,id] of [['autonomous_task_policies','run_id',f.run.id],['autonomous_task_grants','id',child.id],['autonomous_attempt_grants','attempt_id',childBinding.attemptId]]){
    assert.throws(()=>db.run(`DELETE FROM ${table} WHERE ${column}=?`,id),/immutable/);
  }
  assert.throws(()=>db.run("UPDATE autonomous_task_policies SET sha256='forged' WHERE run_id=?",f.run.id),/immutable/);
  assert.throws(()=>db.run("UPDATE autonomous_task_revocations SET reason='forged' WHERE run_id=?",revoked.run.id),/immutable/);
  checks.push('ancestor revocation and custody generation fence late use; policies/grants/attempt bindings/revocations are immutable');

  const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');await registerAccountRoutes(env.app);
  const headers={host:'127.0.0.1:'+config.port};
  const denied=await env.app.inject({method:'GET',url:'/api/accounts/autonomous-collaboration/capabilities',headers});assert.equal(denied.statusCode,401);
  const session=await env.app.inject({method:'POST',url:'/api/accounts/session',headers:{...headers,'x-gand-bootstrap':'1'},payload:{}});
  const metadata=await env.app.inject({method:'GET',url:'/api/accounts/autonomous-collaboration/capabilities',headers:{...headers,cookie:session.headers['set-cookie'].split(';')[0]}});
  assert.equal(metadata.statusCode,200);assert.equal(metadata.headers['cache-control'],'no-store');assert.equal(metadata.json().executionAvailable,false);
  checks.push('capability discovery uses management authentication/no-store and truthfully reports authority-only availability');
  assert.equal(env.externalRequests,0);assert.deepEqual(db.db.pragma('foreign_key_check'),[]);
  const report={passed:true,checks,schema:latestSchema,fixtureApiCalls:providerCalls,realSupplierRequests:0,realNativeInvocations:0,ordinaryAutonomousAdmission:false};
  await writeFile(path.join(qa,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await rm(previousModule,{force:true});await env.close();}
