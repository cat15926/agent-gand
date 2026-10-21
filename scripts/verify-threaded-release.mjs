import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {applyOrchestrationSchemaMigrations,assertOrchestrationSchemaCompatible} from '../apps/server/src/db/orchestrationMigrations.ts';
import {applyThreadedReleaseSchema} from '../apps/server/src/db/threadedReleaseSchema.ts';
import {createThreadedRelease} from '../apps/server/src/threaded/release.ts';
import {createThreadedStore} from '../apps/server/src/threaded/store.ts';
import {createThreadedMessages} from '../apps/server/src/threaded/messages.ts';

const root=await mkdtemp(path.join(tmpdir(),'agent-gand-t12-release-'));
const originalFetch=globalThis.fetch;let remoteRequests=0;
globalThis.fetch=async()=>{remoteRequests++;throw new Error('No external/model requests permitted');};
const connections=[],checks=[];
const members=['release-a','release-b'].map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model:'fixture-model',roleVersion:1,permissionVersion:1}));
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
async function fixture(name){const file=path.join(root,`${name}.sqlite`),db=new Database(file);connections.push(db);
  db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.exec(schema);db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);db.transaction(()=>applyThreadedReleaseSchema(db)).immediate();
  const stamp=new Date(1).toISOString();for(const m of members)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(m.agentId,m.agentId,JSON.stringify({id:m.agentId,name:m.agentId,model:m.model,tools:[],permissionMode:'readonly'}),'t12-release-isolated',stamp,stamp);
  const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId(),messages=createThreadedMessages(db);let currentMode='execute',pack=members;
  const release=createThreadedRelease(db,{mode:()=>currentMode,members:()=>pack,now:()=>10});
  const thread=()=>store.createThread({title:`${name}-${randomUUID()}`,members:members.map(m=>({agentId:m.agentId,handle:m.agentId,roleVersion:1,permissionVersion:1}))});
  const change=(extra={})=>release.change({ownerId,expectedVersion:release.state(ownerId).version,requestId:randomUUID(),admissionOpen:true,dispatchOpen:true,reason:'isolated release verification',...extra});
  function ingress(t,body='authorized ingress',extra={}){return db.transaction(()=>{
    const receipt=messages.acceptUserMessageWithinTransaction({ownerId,threadId:t.id,clientRequestId:randomUUID(),body,targets:['release-a'],...extra});
    release.recordRootWithin(ownerId,t.id,receipt.message.id);return receipt;}).immediate();}
  function grant(t){return release.grantThread({ownerId,threadId:t.id,requestId:randomUUID()});}
  function open(t){db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(t.id);}
  return {file,db,store,ownerId,messages,release,thread,change,ingress,grant,open,mode(value){currentMode=value;},pack(value){pack=value;}};
}
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
async function workers(file,operations){const processes=operations.map(()=>{
  const child=fork(new URL('./fixtures/threadedReleaseWorker.mjs',import.meta.url),[file],{execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',v=>stderr+=v);
  const ready=new Promise((resolve,reject)=>{child.on('message',v=>{if(v.type==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
  const result=new Promise((resolve,reject)=>{child.on('message',v=>{if(v.type==='committed'){child.kill('SIGKILL');resolve(v);}else if(v.type==='result')resolve(v);});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
  const exited=new Promise(resolve=>child.once('exit',resolve));return {child,ready,result,exited};});
  await Promise.all(processes.map(p=>p.ready));processes.forEach((p,i)=>p.child.send(operations[i]));const results=await Promise.all(processes.map(p=>p.result));await Promise.all(processes.map(p=>p.exited));return results;
}
try{
  {
    const f=await fixture('read-only-observe');assert.throws(()=>applyThreadedReleaseSchema(f.db),/THREADED_MIGRATION_REQUIRES_TRANSACTION/);
    const before=f.db.prepare('SELECT total_changes() n').get().n;f.mode('observe');
    for(let i=0;i<3;i++){assert.equal(f.release.state(f.ownerId).version,0);assert.equal(f.release.snapshot(f.ownerId).readOnly,true);}
    assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(count(f,'threaded_release_controls'),0);
    const t=f.thread();assert.throws(()=>f.grant(t),/THREADED_RELEASE_OBSERVE_ONLY/);
    f.mode('closed');assert.throws(()=>f.grant(t),/THREADED_MODE_CLOSED/);
    f.mode('execute');assert.throws(()=>f.grant(t),/THREADED_RELEASE_ADMISSION_CLOSED/);
    f.change();f.grant(t);f.open(t);const ingress=f.ingress(t);
    f.mode('observe');assert.throws(()=>f.release.assertExistingWork({ownerId:f.ownerId,threadId:t.id,agentId:'release-a',causalRootId:ingress.message.id}),/THREADED_RELEASE_OBSERVE_ONLY/);
    assert.throws(()=>f.ingress(t),/THREADED_RELEASE_OBSERVE_ONLY/);assert.equal(count(f,'threaded_messages'),1);
    checks.push('OPS01: observe snapshots and virtual control version zero are read only; observe never grants, records new ingress or dispatches; closed and unopened admission reject new grants');
  }
  {
    const f=await fixture('grant-and-drain');f.change();const t=f.thread(),epoch=t.authorityEpoch;f.grant(t);f.open(t);const accepted=f.ingress(t);
    f.mode('closed');f.change({admissionOpen:false});
    const scope={ownerId:f.ownerId,threadId:t.id,agentId:'release-a',causalRootId:accepted.message.id};
    assert.equal(f.release.assertExistingWork(scope).agentId,'release-a');assert.throws(()=>f.release.assertNewRoot(f.ownerId,t.id),/THREADED_MODE_CLOSED/);
    f.db.transaction(()=>f.release.recordRootWithin(f.ownerId,t.id,accepted.message.id)).immediate();assert.equal(count(f,'threaded_release_roots'),1);
    assert.equal(f.store.getThread(t.id,f.ownerId).authorityEpoch,epoch);assert.equal(f.store.getThread(t.id,f.ownerId).state,'open');
    const ungranted=f.thread();f.open(ungranted);assert.throws(()=>f.release.assertExistingWork({...scope,threadId:ungranted.id}),/THREADED_RELEASE_THREAD_NOT_GRANTED/);
    assert.throws(()=>f.release.assertExistingWork({...scope,causalRootId:'forged-historical-root'}),/THREADED_RELEASE_ROOT_NOT_GRANTED/);
    f.change({admissionOpen:false,dispatchOpen:false});assert.throws(()=>f.release.assertExistingWork(scope),/THREADED_RELEASE_DISPATCH_CLOSED/);
    assert.equal(f.release.assertExistingWork(scope,{allowDispatchClosed:true}).agentId,'release-a','trusted active executor can finish while only new dispatch is paused');
    f.mode('observe');assert.throws(()=>f.release.assertExistingWork(scope,{allowDispatchClosed:true}),/THREADED_RELEASE_OBSERVE_ONLY/);f.mode('closed');
    f.change({admissionOpen:false});f.pack([]);assert.equal(f.release.assertExistingWork(scope).backend,'api','removed new-entry pack does not revoke frozen drain');
    f.db.prepare("UPDATE agents SET version=2 WHERE id='release-b'").run();assert.equal(f.release.assertExistingWork(scope).agentId,'release-a','unrelated member role change cannot revoke this member');
    f.db.prepare("UPDATE agents SET version=2 WHERE id='release-a'").run();assert.throws(()=>f.release.assertExistingWork(scope),/THREADED_RELEASE_MEMBER_CHANGED/);
    checks.push('OPS01/K13-K16: independent admission and dispatch flags preserve Thread state/epoch; closed retains granted causal roots for drain, denies forged roots/ungranted rooms, freezes backend pack and rechecks only executing member authority');
  }
  {
    const f=await fixture('atomic-ingress');f.change();const historical=f.thread();f.open(historical);f.messages.acceptUserMessage({ownerId:f.ownerId,threadId:historical.id,clientRequestId:'history',body:'historical thread',targets:[]});
    assert.throws(()=>f.grant(historical),/THREADED_RELEASE_HISTORICAL_THREAD_REJECTED/);assert.equal(count(f,'threaded_release_grants'),0);
    const before=count(f,'threaded_threads');assert.throws(()=>f.db.transaction(()=>{const t=f.thread();f.grant(t);throw new Error('atomic-create-fault');}).immediate(),/atomic-create-fault/);
    assert.equal(count(f,'threaded_threads'),before);assert.equal(count(f,'threaded_release_grants'),0);
    const previousControl=f.release.state(f.ownerId);f.db.exec("CREATE TRIGGER fixture_release_change_fault BEFORE INSERT ON threaded_release_changes BEGIN SELECT RAISE(ABORT,'release-control-audit-fault'); END;");
    assert.throws(()=>f.change({admissionOpen:false}),/release-control-audit-fault/);assert.deepEqual(f.release.state(f.ownerId),previousControl);f.db.exec('DROP TRIGGER fixture_release_change_fault');
    const t=f.thread();f.grant(t);f.open(t);const tables=['threaded_messages','threaded_wakes','threaded_outbox','threaded_release_roots'];
    const snapshot=()=>tables.map(name=>[name,f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]);const prior=snapshot();
    f.db.exec("CREATE TRIGGER fixture_release_fault BEFORE INSERT ON threaded_release_roots BEGIN SELECT RAISE(ABORT,'release-ingress-fault'); END;");
    assert.throws(()=>f.ingress(t),/release-ingress-fault/);assert.deepEqual(snapshot(),prior);f.db.exec('DROP TRIGGER fixture_release_fault');
    f.ingress(t);assert.equal(count(f,'threaded_release_roots'),1);
    for(const table of ['threaded_release_changes','threaded_release_grants','threaded_release_roots']){
      assert.throws(()=>f.db.prepare(`UPDATE ${table} SET record='{}'`).run(),/THREADED_RELEASE_FACT_IMMUTABLE/);
      assert.throws(()=>f.db.prepare(`DELETE FROM ${table}`).run(),/THREADED_RELEASE_FACT_RETAINED/);}
    checks.push('DB01/OPS01: existing populated Threads cannot be adopted; Thread creation/grant and accepted message/wake/outbox/ingress fact share outer atomic transactions; immutable release history and fault rollback verified');
  }
  {
    const f=await fixture('release-cas');f.change();const input=i=>({ownerId:f.ownerId,expectedVersion:1,requestId:`worker-${i}`,admissionOpen:false,dispatchOpen:i===0,reason:`CAS worker ${i}`});
    const answers=await workers(f.file,[0,1].map(i=>({input:input(i)})));assert.equal(answers.filter(a=>a.result).length,1);assert.equal(answers.find(a=>a.error).error.code,'THREADED_RELEASE_VERSION_CONFLICT');
    const winner=answers[0].result?0:1;assert.deepEqual(f.release.change(input(winner)),answers[winner].result);
    const audit=JSON.parse(f.db.prepare('SELECT record FROM threaded_release_changes WHERE request_id=?').get(input(winner).requestId).record);assert.equal(audit.reason,input(winner).reason);assert.equal(audit.expectedVersion,1);
    assert.throws(()=>f.release.change({...input(winner),reason:'same key different payload'}),/THREADED_RELEASE_IDEMPOTENCY_CONFLICT/);
    const crash={ownerId:f.ownerId,expectedVersion:2,requestId:'crash-after-commit',admissionOpen:false,dispatchOpen:true,reason:'durable close receipt'};
    const [result]=await workers(f.file,[{input:crash,crashAfterCommit:true}]);assert.deepEqual(f.release.change(crash),result.result);assert.equal(f.release.state(f.ownerId).version,3);
    assert.throws(()=>f.db.prepare('UPDATE threaded_release_controls SET version=9').run(),/THREADED_RELEASE_CONTROL_CAS/);
    checks.push('OPS01/REC01: two actual IPC writers share one SQLite CAS winner; idempotent close receipt survives committed worker SIGKILL; conflicting request and skipped versions rejected');
  }
  {
    const f=await fixture('account-fence');
    f.db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
      .run('release-account','Isolated account metadata','anthropic','api_key','t12-isolated',new Date(1).toISOString(),new Date(1).toISOString());
    for(const m of members){const definition=JSON.parse(f.db.prepare('SELECT definition FROM agents WHERE id=?').get(m.agentId).definition);definition.accountRef='release-account';definition.requiresAccount=true;
      f.db.prepare('UPDATE agents SET definition=? WHERE id=?').run(JSON.stringify(definition),m.agentId);}
    const pack=members.map(m=>({...m,accountId:'release-account',accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));f.pack(pack);f.change();const t=f.thread();
    f.db.prepare('UPDATE threaded_members SET account_version=1 WHERE thread_id=?').run(t.id);f.grant(t);f.open(t);const accepted=f.ingress(t);
    f.mode('closed');const scope={ownerId:f.ownerId,threadId:t.id,agentId:'release-a',causalRootId:accepted.message.id};assert.equal(f.release.assertExistingWork(scope).accountConfigVersion,1);
    f.db.prepare('UPDATE accounts SET credential_version=2 WHERE id=?').run('release-account');assert.throws(()=>f.release.assertExistingWork(scope),/THREADED_RELEASE_ACCOUNT_CHANGED/);
    assert.equal(count(f,'threaded_release_roots'),1,'account change cannot erase ingress or grant');
    assert.equal(count(f,'account_credentials'),0,'release only inspected metadata; no credential storage was populated or read');
    checks.push('OPS01/ISO03: trusted account ID/config/credential/identity versions and role definition fingerprints freeze in grant; credential rotation blocks stale drain authority without deleting accepted work or accessing secrets');
  }
  {
    Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-runtime.sqlite'),AGENTS_DIR:path.join(root,'agents')});
    const {openBackendRuntimeFixture}=await import('./fixtures/threadedBackendRuntimeFixture.mjs');
    const f=await openBackendRuntimeFixture(root,'unknown-drain',{agentIds:members.map(m=>m.agentId),fetch:async()=>{throw new Error('No model request should start');}});
    try{const release=createThreadedRelease(f.db,{mode:()=> 'execute',members:()=>members,now:()=>30});const ownerId=f.thread.ownerId;
      release.change({ownerId,expectedVersion:0,requestId:'open',admissionOpen:true,dispatchOpen:true,reason:'isolated unknown drain'});release.grantThread({ownerId,threadId:f.thread.id,requestId:'grant'});
      const accepted=f.db.transaction(()=>{const receipt=f.runtime.messages.acceptUserMessageWithinTransaction({ownerId,threadId:f.thread.id,clientRequestId:'new-root',body:'Reserve but do not call backend',targets:['release-a']});release.recordRootWithin(ownerId,f.thread.id,receipt.message.id);return receipt;}).immediate();
      f.runtime.queue.enqueueWake(accepted.wakes[0].id);const claim=f.runtime.queue.claimNext('release-unknown-verification');assert.ok(claim);
      assert.equal(release.snapshot(ownerId).work.activeClaims,1);f.runtime.lifecycle.startAttempt(claim.binding);
      f.db.transaction(()=>f.runtime.budget.markStartedWithinTransaction(claim.binding,claim.budgetAuthorization.id)).immediate();
      f.runtime.lifecycle.recordOutcome(claim.binding,{kind:'unknown',reason:'isolated uncertain executor boundary'});
      release.change({ownerId,expectedVersion:1,requestId:'close',admissionOpen:false,dispatchOpen:true,reason:'preserve uncertain facts'});
      const before=release.snapshot(ownerId);assert.equal(before.work.unknownExecutions,1);assert.ok(before.work.unknownUsage>0);assert.equal(before.work.activeClaims,1);assert.equal(before.drain.ready,false);assert.equal(before.drain.unknownNeedsReview,true);
      f.reopen();f.runtime.recover();const restored=createThreadedRelease(f.db,{mode:()=> 'closed',members:()=>[],now:()=>40}).snapshot(ownerId);
      assert.equal(restored.work.unknownExecutions,1);assert.ok(restored.work.unknownUsage>0);assert.equal(restored.work.activeClaims,1);assert.equal(restored.drain.ready,false);
      checks.push('OPS01/REC03/B02: real queue/resource/budget reservation followed by authoritative unknown retains execution uncertainty, usage charge and capacity claim through factory/SQLite recovery; drain never declares ready or replays the backend');
    }finally{f.close();}
  }
  {
    const f=await fixture('restore-plan');f.change();const t=f.thread();f.grant(t);f.open(t);const accepted=f.ingress(t);
    const snapshot=f.release.snapshot(f.ownerId,t.id);assert.ok(snapshot.work.pendingOutbox>0);assert.equal(snapshot.drain.ready,false);assert.equal(snapshot.drain.compatibleWorkerRequired,true);
    const backup=path.join(root,'consistent-backup.sqlite');await f.db.backup(backup);const restored=new Database(backup,{fileMustExist:true});connections.push(restored);restored.pragma('foreign_keys=ON');
    assertOrchestrationSchemaCompatible(restored);const release=createThreadedRelease(restored,{mode:()=> 'closed',members:()=>[],now:()=>20});
    assert.equal(release.assertExistingWork({ownerId:f.ownerId,threadId:t.id,agentId:'release-a',causalRootId:accepted.message.id}).agentId,'release-a');
    assert.equal(release.snapshot(f.ownerId,t.id).drain.ready,false);assert.equal(restored.pragma('quick_check',{simple:true}),'ok');assert.equal(restored.pragma('foreign_key_check').length,0);
    const before=restored.prepare('SELECT total_changes() n').get().n;release.snapshot(f.ownerId);assert.equal(restored.prepare('SELECT total_changes() n').get().n,before);
    const migrations=await import('../apps/server/src/db/orchestrationMigrations.ts');const latest=migrations.ORCHESTRATION_MIGRATIONS.at(-1);
    const version=restored.prepare('SELECT MAX(version) n FROM orchestration_schema_migrations').get().n;
    const oldSource=execFileSync('git',['show','ba438b1:apps/server/src/db/orchestrationMigrations.ts'],{encoding:'utf8',maxBuffer:2_000_000});
    const frozen=oldSource.replace(/from '(\.\/[^']+|@agent-gand\/shared)'/g,(_all,name)=>`from '${name==='@agent-gand/shared'
      ?new URL('../packages/shared/src/index.ts',import.meta.url).href:new URL(`../apps/server/src/db/${name.slice(2)}`,import.meta.url).href}'`);
    const oldFile=path.join(root,'v33-compatibility-worker.ts');await writeFile(oldFile,frozen);const oldWorker=await import(pathToFileURL(oldFile).href);
    assert.equal(oldWorker.ORCHESTRATION_MIGRATIONS.at(-1).version,33);assert.ok(version>=34,'v34 aggregator must be installed before claiming old worker rejection');
    const beforeOld=restored.prepare('SELECT total_changes() n').get().n;
    assert.throws(()=>oldWorker.assertOrchestrationSchemaCompatible(restored),/不受此 worker 支持/);assert.equal(restored.prepare('SELECT total_changes() n').get().n,beforeOld);
    restored.prepare('INSERT INTO orchestration_schema_migrations VALUES(?,?,?,?)').run(version+1,'fixture-future-worker','unrecognized',new Date().toISOString());
    assert.throws(()=>assertOrchestrationSchemaCompatible(restored),/不受此 worker 支持/);assert.equal(restored.prepare('SELECT MAX(version) n FROM orchestration_schema_migrations').get().n,version+1);
    assert.ok(latest.version>=33);
    checks.push('OPS01/DB03: consistent SQLite backup restores frozen drain facts under closed mode; pending durable work prevents ready; integrity and foreign keys pass; actual ba438b1 v33 compatibility worker and future writer guard reject without downgrading or deleting data');
  }
  assert.equal(remoteRequests,0);
  const report={schemaVersion:1,stage:'T12',scope:'release control, fresh Thread grants, ingress provenance and drain planning',checks,externalRequests:0,modelRequests:0,productionDatabaseAccess:false,productionRelease:false};
  const output=process.env.THREADED_RELEASE_OUTPUT;if(output)await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{globalThis.fetch=originalFetch;for(const db of connections)if(db.open)db.close();await rm(root,{recursive:true,force:true});}
