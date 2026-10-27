import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,realpath,rm,symlink,chmod} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {applyOrchestrationSchemaMigrations} from '../apps/server/src/db/orchestrationMigrations.ts';
import {preflightTarget,inspectHost} from './threaded-release-preflight.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const root=await realpath(await mkdtemp(path.join(tmpdir(),'gand-rc11-preflight-'))),checks=[];
const paths=Object.fromEntries(['private','roles','sandbox','managedWorkspaces','codexHome','claudeHome'].map(key=>[key,path.join(root,key)]));
for(const directory of Object.values(paths))await mkdir(directory,{mode:0o700});
paths.database=path.join(root,'database.sqlite');
const db=new Database(paths.database);db.pragma('foreign_keys=ON');
db.exec(await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8'));
db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
const audit=path.join(root,'rc10.json');
const blockedAudit={schemaVersion:1,stage:'RC10',ok:true,releaseDecision:{dailyReleaseReady:false,fullContinuousCollaborationAccepted:false,all59Passed:false,coreContractsReduced:false,blockingIssueIds:['RC10-G01']}};
await writeFile(audit,JSON.stringify(blockedAudit));
const target={schemaVersion:1,targetId:'synthetic-rc11',expectedSchema:35,mode:'closed',paths,registeredWorkspaces:[],files:{releasePack:null,githubRegistration:null,commandRegistration:null},rc10Audit:{path:audit,sha256:hash(await readFile(audit))},backupManifest:null,keySource:'unverified'};
const fresh=()=>structuredClone(target),has=(result,code)=>result.findings.some(item=>item.code===code),blocked=(result,code)=>result.releaseBlockers.some(item=>item.code===code);
const check=async(name,fn)=>{await fn();checks.push({name,passed:true});};
try{
  await check('valid metadata preparation passes while RC10 and independent operation gates block release',async()=>{
    const before=hash(await readFile(paths.database)),result=await preflightTarget(fresh());
    assert.equal(result.preparationPassed,true,JSON.stringify(result.findings));assert.equal(result.targetReleaseReady,false);assert.equal(result.wholeDatabaseRollbackReady,false);assert.ok(blocked(result,'RC10_RELEASE_GATE_BLOCKED'));assert.equal(hash(await readFile(paths.database)),before);
  });
  await check('missing target fields and self-supplied ready flags are rejected',async()=>{
    const missing=fresh();delete missing.paths.private;assert.ok(has(await preflightTarget(missing),'TARGET_MANIFEST_INVALID'));
    const forged=fresh();forged.targetReleaseReady=true;assert.ok(has(await preflightTarget(forged),'TARGET_MANIFEST_INVALID'));
  });
  await check('missing paths fail preparation instead of being silently created',async()=>{
    const item=fresh();item.paths.roles=path.join(root,'absent');assert.ok(has(await preflightTarget(item),'PATH_MISSING'));
  });
  await check('leaf and ancestor symlinks are rejected',async()=>{
    const link=path.join(root,'link');await symlink(paths.roles,link);const item=fresh();item.paths.roles=link;assert.ok(has(await preflightTarget(item),'PATH_SYMLINK'));
    const parent=path.join(root,'parent-link');await symlink(root,parent);item.paths.roles=path.join(parent,'roles');assert.ok(has(await preflightTarget(item),'PATH_SYMLINK'));
  });
  await check('source component overlaps are rejected',async()=>{
    const item=fresh();item.paths.roles=paths.private;assert.ok(has(await preflightTarget(item),'PATH_OVERLAP'));
  });
  await check('private directory permissions are checked without reading its files',async()=>{
    await chmod(paths.private,0o755);assert.ok(has(await preflightTarget(fresh()),'PRIVATE_DIRECTORY_PERMISSION_INVALID'));await chmod(paths.private,0o700);
  });
  await check('migration gaps and altered checksums are rejected without repair',async()=>{
    const row=db.prepare('SELECT * FROM orchestration_schema_migrations WHERE version=25').get();db.prepare('DELETE FROM orchestration_schema_migrations WHERE version=25').run();
    assert.ok(has(await preflightTarget(fresh()),'MIGRATION_GAP'));assert.equal(db.prepare('SELECT COUNT(*) n FROM orchestration_schema_migrations WHERE version=25').get().n,0);
    db.prepare('INSERT INTO orchestration_schema_migrations VALUES(?,?,?,?)').run(row.version,row.name,row.checksum,row.applied_at);
    db.prepare("UPDATE orchestration_schema_migrations SET checksum='changed' WHERE version=25").run();assert.ok(has(await preflightTarget(fresh()),'MIGRATION_UNSUPPORTED_OR_CHANGED'));
    db.prepare('UPDATE orchestration_schema_migrations SET checksum=? WHERE version=25').run(row.checksum);
  });
  await check('older and future schema are explicit blockers',async()=>{
    const row=db.prepare('SELECT * FROM orchestration_schema_migrations WHERE version=35').get();db.prepare('DELETE FROM orchestration_schema_migrations WHERE version=35').run();assert.ok(has(await preflightTarget(fresh()),'MIGRATION_REQUIRED'));
    db.prepare('INSERT INTO orchestration_schema_migrations VALUES(?,?,?,?)').run(row.version,row.name,row.checksum,row.applied_at);
    db.prepare('INSERT INTO orchestration_schema_migrations VALUES(36,?,?,?)').run('future','unknown',new Date().toISOString());assert.ok(has(await preflightTarget(fresh()),'MIGRATION_UNSUPPORTED_OR_CHANGED'));db.prepare('DELETE FROM orchestration_schema_migrations WHERE version=36').run();
  });
  await check('schema metadata does not hide a missing required table',async()=>{
    db.exec('ALTER TABLE threaded_backend_processes RENAME TO missing_fixture_processes');assert.ok(has(await preflightTarget(fresh()),'SCHEMA_TABLES_MISSING'));db.exec('ALTER TABLE missing_fixture_processes RENAME TO threaded_backend_processes');
  });
  await check('remote host and failed exact process probe are unverifiable and block preparation',async()=>{
    db.prepare('INSERT INTO external_runtime_host VALUES(1,?,?,?,?,?)').run('fixture','other-host',process.pid,'fixture',new Date().toISOString());assert.ok(has(await preflightTarget(fresh()),'SERVICE_QUIESCENCE_UNVERIFIABLE'));
    assert.ok(has(await preflightTarget(fresh(),{hostProbe:()=>({state:'unverifiable',reason:'HOST_PROBE_FAILED'})}),'SERVICE_QUIESCENCE_UNVERIFIABLE'));db.prepare('DELETE FROM external_runtime_host').run();
  });
  await check('exact live local process identity is active, never a stopped-host proof',async()=>{
    const text=execFileSync('ps',['-p',String(process.pid),'-o','stat=','-o','lstart='],{encoding:'utf8'}).trim(),identity=text.replace(/^\S+\s+/,'');
    assert.equal(inspectHost({host:hostname(),pid:process.pid,identity}).state,'active');
    db.prepare('INSERT INTO external_runtime_host VALUES(1,?,?,?,?,?)').run('fixture',hostname(),process.pid,identity,new Date().toISOString());assert.ok(has(await preflightTarget(fresh()),'SERVICE_STILL_ACTIVE'));db.prepare('DELETE FROM external_runtime_host').run();
  });
  await check('unknown model calls remain present and block a clean-preparation claim',async()=>{
    db.pragma('foreign_keys=OFF');db.prepare("INSERT INTO orchestration_model_calls(id,run_id,agent_id,backend,model,status,queued_at) VALUES('unknown','root','agent','api','fixture','unknown','now')").run();
    const result=await preflightTarget(fresh());assert.equal(result.inventory.work.unknownModelCalls,1);assert.ok(has(result,'UNSETTLED_DATABASE_WORK'));assert.equal(db.prepare("SELECT status FROM orchestration_model_calls WHERE id='unknown'").get().status,'unknown');db.prepare("DELETE FROM orchestration_model_calls WHERE id='unknown'").run();db.pragma('foreign_keys=ON');
  });
  await check('master-key existence never proves matching and key contents are not parsed',async()=>{
    db.pragma('foreign_keys=OFF');db.prepare("INSERT INTO account_credentials VALUES('fixture-account',1,'key-id','not-ciphertext','nonce','tag','suffix','now')").run();
    const item=fresh();item.keySource='file';assert.ok(has(await preflightTarget(item),'MASTER_KEY_FILE_MISSING'));
    await writeFile(path.join(paths.private,'account-master-key.json'),'Intentionally invalid secret fixture; never parse this.',{mode:0o600});
    const result=await preflightTarget(item);assert.equal(result.credentialMaterialRead,false);assert.ok(blocked(result,'KEY_AND_ENCRYPTED_CONTENT_MATCH_UNVERIFIED'));assert.ok(!has(result,'MASTER_KEY_FILE_MISSING'));
    db.prepare("DELETE FROM account_credentials WHERE account_id='fixture-account'").run();db.pragma('foreign_keys=ON');
  });
  await check('registered project omissions and native workspace mismatch are explicit',async()=>{
    db.prepare("INSERT INTO external_workspaces(id,label,abs_path,trusted,created_at) VALUES('project','fixture',?,0,'now')").run(path.join(root,'unregistered-in-manifest'));
    assert.ok(has(await preflightTarget(fresh()),'REGISTERED_WORKSPACE_NOT_DECLARED'));db.prepare("DELETE FROM external_workspaces WHERE id='project'").run();
    db.pragma('foreign_keys=OFF');db.prepare("INSERT INTO execution_resource_sessions VALUES('session','owner','binding',1,'native','resource','ready',?,0)").run(JSON.stringify({kind:'threaded',policy:{workspace:path.join(root,'uncovered')}}));
    const result=await preflightTarget(fresh());assert.ok(has(result,'SESSION_WORKSPACE_NOT_COVERED'));assert.ok(blocked(result,'NATIVE_SESSION_WORKSPACE_MATCH_UNVERIFIED'));db.prepare("DELETE FROM execution_resource_sessions WHERE id='session'").run();db.pragma('foreign_keys=ON');
  });
  await check('RC10 evidence digest mismatch is rejected',async()=>{
    const item=fresh();item.rc10Audit.sha256='0'.repeat(64);assert.ok(has(await preflightTarget(item),'RC10_EVIDENCE_DIGEST_MISMATCH'));
  });
  await check('forged green RC10 booleans and backup manifest cannot authorize deployment',async()=>{
    const green={...blockedAudit,releaseDecision:{dailyReleaseReady:true,fullContinuousCollaborationAccepted:true,all59Passed:true,coreContractsReduced:false,blockingIssueIds:[]}};await writeFile(audit,JSON.stringify(green));
    const item=fresh();item.rc10Audit.sha256=hash(await readFile(audit));item.backupManifest=path.join(root,'backup.json');await writeFile(item.backupManifest,JSON.stringify({format:'agent-gand-accounts-backup-v1',sources:[],files:[]}));
    const result=await preflightTarget(item);assert.equal(result.preparationPassed,true);assert.equal(result.targetReleaseReady,false);assert.equal(result.backup.contentVerified,false);assert.ok(blocked(result,'MATCHED_COMPONENT_BACKUP_AND_RESTORE_UNVERIFIED'));await writeFile(audit,JSON.stringify(blockedAudit));
  });
  await check('private key path cannot be presented as a public release file',async()=>{
    const item=fresh();item.files.releasePack=path.join(paths.private,'account-master-key.json');assert.ok(has(await preflightTarget(item),'PUBLIC_METADATA_PATH_FORBIDDEN'));
  });
  await check('WAL sources are refused before SQLite opens and DB/WAL/SHM bytes stay unchanged',async()=>{
    db.pragma('journal_mode=WAL');db.exec('CREATE TABLE rc11_wal_fixture(value TEXT); INSERT INTO rc11_wal_fixture VALUES(\'committed only in WAL\')');
    const files=[paths.database,paths.database+'-wal',paths.database+'-shm'],before=await Promise.all(files.map(async file=>hash(await readFile(file))));
    const result=await preflightTarget(fresh());assert.equal(result.databaseErrorCode,'WAL_REQUIRES_QUIESCENT_SNAPSHOT');assert.equal(result.inventory,undefined);assert.ok(has(result,'DATABASE_METADATA_UNAVAILABLE'));
    assert.deepEqual(await Promise.all(files.map(async file=>hash(await readFile(file)))),before);db.pragma('journal_mode=DELETE');db.exec('DROP TABLE rc11_wal_fixture');
  });
  const final=await preflightTarget(fresh());assert.equal(final.preparationPassed,true);assert.equal(final.targetReleaseReady,false);
  const report={schemaVersion:1,stage:'RC11',date:'2026-10-28',scope:'Metadata-only explicit target preparation and fail-closed negative cases; synthetic SQLite and paths, no daily migration or credential content.',checks,checksPassed:checks.length,providerRequests:0,productionDatabaseAccess:false,credentialMaterialRead:false,messageBodyReads:0,targetReleaseReady:false,sourceUnknownCleared:false};
  const out=new URL('../docs/reports/evidence/threaded-rc11/preflight.json',import.meta.url);await mkdir(path.dirname(out.pathname),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{db.close();await rm(root,{recursive:true,force:true});}
