import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {constants,openSync,readSync,closeSync,fstatSync,lstatSync} from 'node:fs';
import {lstat, readFile, realpath} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {ORCHESTRATION_MIGRATIONS, migrationChecksum} from '../apps/server/src/db/orchestrationMigrations.ts';

// Deliberately do not import config/database/service: this command neither loads
// credentials nor initializes schema, sessions, workspaces or recovery workers.
const PATH_KEYS=['database','private','roles','sandbox','managedWorkspaces','codexHome','claudeHome'];
const FILE_KEYS=['releasePack','githubRegistration','commandRegistration'];
const ENV_KEYS=['DB_PATH','AGENTS_DIR','EXTERNAL_WORKSPACE_DIR','EXTERNAL_CODEX_HOME','EXTERNAL_CLAUDE_HOME','THREADED_COLLABORATION_MODE','THREADED_RELEASE_MEMBERS_FILE','THREADED_GITHUB_REGISTRATIONS_FILE','THREADED_COMMAND_REGISTRATIONS_FILE'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const latest=ORCHESTRATION_MIGRATIONS.at(-1).version;
const keys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const secretName=file=>/^(?:\.env(?:\..*)?|account-master-key\.json|auth\.json|\.credentials\.json)$/i.test(path.basename(file));
async function publicBytes(file,target){
  if(secretName(file)||overlaps(file,target.paths.private)||file===target.paths.database)throw new Error('PUBLIC_METADATA_PATH_FORBIDDEN');
  await inspectPath(file,'file');return readFile(file);
}

/** Read the SQLite signature/mode only, never a page containing application data. */
export function databaseFileMetadata(file){
  if(secretName(file))throw new Error('DATABASE_PATH_FORBIDDEN');
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let info,header;
  try{info=fstatSync(fd);if(!info.isFile()||info.nlink!==1)throw new Error('DATABASE_PATH_INVALID');header=Buffer.alloc(20);if(readSync(fd,header,0,20,0)!==20||header.subarray(0,16).toString('binary')!=='SQLite format 3\u0000')throw new Error('DATABASE_HEADER_INVALID');}finally{closeSync(fd);}
  const sidecars={};for(const suffix of ['-wal','-shm','-journal']){try{const st=lstatSync(file+suffix);sidecars[suffix]={exists:true,bytes:st.size,mtimeMs:st.mtimeMs,symbolicLink:st.isSymbolicLink()};}catch(error){if(error.code!=='ENOENT')throw error;sidecars[suffix]={exists:false};}}
  return {headerBytesRead:20,bytes:info.size,mtimeMs:info.mtimeMs,device:info.dev,inode:info.ino,journalMode:header[18]===2||header[19]===2?'wal':'rollback',sidecars};
}

/** Every ancestor is checked: a safe leaf behind a symlink is not a safe path. */
async function inspectPath(file,kind){
  if(typeof file!=='string'||!path.isAbsolute(file)||path.normalize(file)!==file)throw new Error('PATH_NOT_CANONICAL_ABSOLUTE');
  const parts=file.slice(path.parse(file).root.length).split(path.sep).filter(Boolean);let current=path.parse(file).root;
  for(const part of parts){current=path.join(current,part);const st=await lstat(current);if(st.isSymbolicLink())throw new Error('PATH_SYMLINK');}
  const st=await lstat(file);
  if(kind==='file'?!st.isFile()||st.nlink!==1:!st.isDirectory())throw new Error('PATH_TYPE_INVALID');
  if(await realpath(file)!==file)throw new Error('PATH_NOT_CANONICAL_ABSOLUTE');
  return {kind,bytes:kind==='file'?st.size:undefined,mode:st.mode&0o777,uid:st.uid,device:st.dev,inode:st.ino};
}

/** No broad process scan; failure to inspect the exact recorded PID is unknown. */
export function inspectHost(row){
  if(!row)return {state:'no_registered_host'};
  if(row.host!==hostname())return {state:'unverifiable',reason:'DIFFERENT_HOST'};
  if(!Number.isSafeInteger(row.pid)||row.pid<1||typeof row.identity!=='string'||!row.identity)return {state:'unverifiable',reason:'HOST_IDENTITY_INVALID'};
  try{
    const text=execFileSync('ps',['-p',String(row.pid),'-o','stat=','-o','lstart='],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','pipe']}).trim();
    if(!text)return {state:'unverifiable',reason:'HOST_PROBE_EMPTY'};
    if(text.startsWith('Z'))return {state:'stopped',reason:'ZOMBIE'};
    return {state:text.replace(/^\S+\s+/,'')===row.identity?'active':'stopped',reason:'EXACT_PID_IDENTITY_CHECK'};
  }catch(error){
    if(error.status===1&&!String(error.stdout??'').trim()&&!String(error.stderr??'').trim())return {state:'stopped',reason:'PID_NOT_PRESENT'};
    return {state:'unverifiable',reason:'HOST_PROBE_FAILED'};
  }
}

const COUNTS={
  activeRuns:['runs',"status NOT IN ('completed','failed','cancelled')"],
  activeAttempts:['collaboration_attempts',"status='running'"],
  legacyNativeProcesses:['external_native_processes',"status='active'"],
  uncertainNativeExecutions:['external_agent_executions',"status IN ('running','interrupted')"],
  unknownModelCalls:['orchestration_model_calls',"status='unknown'"],
  unknownTokens:['orchestration_token_reservations',"status='unknown'"],
  unknownCosts:['execution_cost_reservations',"status IN ('unknown','carried_unknown')"],
  unsettledTools:['tool_executions',"status IN ('running','interrupted','needs_attention') OR (replay_policy='manual' AND status='failed')"],
  accountLogins:['account_login_operations',"status IN ('starting','pending')"],
  accountTests:['account_checks',"status='running'"],
  sharedClaims:['execution_resource_claims',"state<>'released'"],
  threadedInvocations:['threaded_invocations',"status IN ('queued','running','waiting','unknown')"],
  threadedWakes:['threaded_wakes',"status IN ('pending','blocked')"],
  threadedQueue:['threaded_wake_queue',"state IN ('queued','blocked')"],
  threadedActions:['threaded_actions',"state<>'completed'"],
  threadedOutbox:['threaded_outbox',"status IN ('pending','claimed')"],
  threadedCommands:['threaded_commands',"state NOT IN ('completed','failed','cancelled')"],
  threadedWaits:['threaded_waits',"state='awaiting'"],
  threadedConsultations:['threaded_consultations',"state='collecting'"],
  threadedCallbacks:['threaded_collaboration_callbacks',"state IN ('pending','waiting')"],
  threadedApprovals:['threaded_approvals',"status='pending'"],
  threadedUnknownRequests:['threaded_budget_requests',"usage_state='unknown' OR execution_state='unknown'"],
  threadedProcesses:['threaded_backend_processes',"state<>'verified_stopped'"],
};

export function inventoryDatabase(file,{hostProbe=inspectHost}={}){
  const source=databaseFileMetadata(file);
  // A normal readonly SQLite WAL reader may create/change shared-memory marks.
  // Do not use immutable=1: that could ignore committed, uncheckpointed WAL.
  if(source.journalMode==='wal'||source.sidecars['-wal'].exists||source.sidecars['-shm'].exists)throw new Error('WAL_REQUIRES_QUIESCENT_SNAPSHOT');
  if(source.sidecars['-journal'].exists)throw new Error('JOURNAL_REQUIRES_QUIESCENT_SNAPSHOT');
  const db=new Database(file,{readonly:true,fileMustExist:true});
  try{
    db.pragma('query_only=ON');db.exec('BEGIN');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
    const count=(table,where='1')=>tables.has(table)?db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get().n:0;
    const migrations=tables.has('orchestration_schema_migrations')?db.prepare('SELECT version,name,checksum FROM orchestration_schema_migrations ORDER BY version').all():[];
    const migrationIssues=[];const max=migrations.at(-1)?.version??0;
    if(migrations.some(row=>!Number.isSafeInteger(row.version)||row.version<1)||new Set(migrations.map(row=>row.version)).size!==migrations.length)migrationIssues.push({code:'MIGRATION_IDENTITY_INVALID'});
    for(let version=1;version<=Math.min(max,latest);version++){
      const row=migrations.find(item=>item.version===version),expected=ORCHESTRATION_MIGRATIONS.find(item=>item.version===version);
      if(!row)migrationIssues.push({code:'MIGRATION_GAP',version});
      else if(!expected||row.name!==expected.name||row.checksum!==migrationChecksum(expected.descriptor))migrationIssues.push({code:'MIGRATION_UNSUPPORTED_OR_CHANGED',version});
    }
    if(max>latest)migrationIssues.push({code:'MIGRATION_UNSUPPORTED_OR_CHANGED',version:max});
    const work=Object.fromEntries(Object.entries(COUNTS).map(([name,[table,where]])=>[name,count(table,where)]));
    const host=hostProbe(tables.has('external_runtime_host')?db.prepare('SELECT host,pid,identity FROM external_runtime_host WHERE id=1').get():null);
    const registeredPaths=tables.has('external_workspaces')?db.prepare('SELECT abs_path FROM external_workspaces ORDER BY abs_path').all().map(row=>row.abs_path):[];
    const sessionPaths=tables.has('execution_resource_sessions')?db.prepare("SELECT DISTINCT json_extract(record,'$.policy.workspace') p FROM execution_resource_sessions WHERE json_extract(record,'$.kind')='threaded'").all().map(row=>row.p).filter(Boolean):[];
    const nativePaths=tables.has('account_native_identities')?db.prepare("SELECT directory FROM account_native_identities WHERE status='authenticated'").all().map(row=>row.directory):[];
    const missingTables=max===latest?['accounts','account_credentials','runs','external_runtime_host',...new Set(Object.values(COUNTS).map(([table])=>table))].filter(table=>!tables.has(table)):[];
    return {readOnly:true,schema:max,expectedSchema:latest,migrationRequired:max<latest,migrationIssues,missingTables,
      databaseCheck:db.pragma('quick_check',{simple:true}),foreignKeyErrors:db.pragma('foreign_key_check').length,host,work,
      metadata:{accounts:count('accounts'),credentials:count('account_credentials'),nativeIdentities:count('account_native_identities'),legacySessions:count('external_agent_sessions'),resourceSessions:count('execution_resource_sessions'),registeredWorkspaces:registeredPaths.length},
      paths:{registeredPaths,sessionPaths,nativePaths}};
  }finally{if(db.inTransaction)db.exec('ROLLBACK');db.close();}
}

/** The .env file is read; only whitelisted path/mode values are parsed/exported. */
export async function discoverTarget(repo){
  const root=await realpath(path.resolve(repo)),server=path.join(root,'apps/server');let text='',dotEnvRead=false;
  try{text=await readFile(path.join(server,'.env'),'utf8');dotEnvRead=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  const selected={};
  for(const line of text.split('\n')){const item=line.trim(),eq=item.indexOf('=');if(eq<=0||item.startsWith('#'))continue;const key=item.slice(0,eq).trim();if(ENV_KEYS.includes(key))selected[key]=item.slice(eq+1).trim().replace(/^["']|["']$/g,'');}
  for(const key of ENV_KEYS)if(process.env[key]!==undefined)selected[key]=process.env[key];
  const resolve=value=>path.resolve(root,value),database=resolve(selected.DB_PATH||path.join(server,'data/agent-gand.sqlite')),data=path.dirname(database);
  const manifest={schemaVersion:1,targetId:'repository-default-candidate',expectedSchema:latest,mode:selected.THREADED_COLLABORATION_MODE||'closed',
    paths:{database,private:path.join(data,'private'),roles:resolve(selected.AGENTS_DIR||path.join(root,'agents')),sandbox:path.join(server,'data/sandbox'),managedWorkspaces:resolve(selected.EXTERNAL_WORKSPACE_DIR||path.join(data,'external/workspaces')),codexHome:resolve(selected.EXTERNAL_CODEX_HOME||path.join(data,'external/codex')),claudeHome:resolve(selected.EXTERNAL_CLAUDE_HOME||path.join(data,'external/claude'))},
    registeredWorkspaces:[],files:{releasePack:selected.THREADED_RELEASE_MEMBERS_FILE?resolve(selected.THREADED_RELEASE_MEMBERS_FILE):null,githubRegistration:selected.THREADED_GITHUB_REGISTRATIONS_FILE?resolve(selected.THREADED_GITHUB_REGISTRATIONS_FILE):null,commandRegistration:selected.THREADED_COMMAND_REGISTRATIONS_FILE?resolve(selected.THREADED_COMMAND_REGISTRATIONS_FILE):null},
    rc10Audit:{path:path.join(root,'docs/reports/evidence/threaded-rc10/acceptance-audit.json'),sha256:null},backupManifest:null,keySource:'unverified'};
  manifest.rc10Audit.sha256=sha(await readFile(manifest.rc10Audit.path));
  let inventory=null,inventoryError=null,databaseFile=null,databaseFileAfter=null;
  try{await inspectPath(database,'file');databaseFile=databaseFileMetadata(database);inventory=inventoryDatabase(database);manifest.registeredWorkspaces=[...new Set(inventory.paths.registeredPaths)];}catch(error){inventoryError=error.code??error.message;}
  try{databaseFileAfter=databaseFileMetadata(database);}catch{}
  return {schemaVersion:1,stage:'RC11',readOnly:true,providerRequests:0,dotEnvReadForPathSelection:dotEnvRead,credentialValuesParsed:false,credentialValuesExported:false,messageBodyReads:0,discoveryOnly:true,targetReleaseReady:false,manifest,inventory,inventoryError,databaseFile,databaseMetadataUnchanged:databaseFile!==null&&JSON.stringify(databaseFile)===JSON.stringify(databaseFileAfter),
    caveats:['Candidate paths are not a selected deployment or a backup.','A relative environment path is resolved against the supplied repository; a differently configured service cwd needs an explicit manifest.','The .env file is read only to select whitelisted paths/mode; credential values are not parsed, exported, decrypted or used.','WAL databases are not opened by SQLite: daily SQL inventory, schema and quiescence remain unverified until a separate consistent offline snapshot is available.','Session transcripts, message bodies and the application runtime are not loaded.']};
}

export async function preflightTarget(target,{hostProbe=inspectHost}={}){
  const findings=[],releaseBlockers=[];const issue=(code,field)=>findings.push({code,...(field?{field}:{})});
  const report={schemaVersion:1,stage:'RC11',readOnly:true,providerRequests:0,credentialMaterialRead:false,messageBodyReads:0,preparationPassed:false,targetReleaseReady:false,wholeDatabaseRollbackReady:false,findings,releaseBlockers};
  if(!keys(target,['schemaVersion','targetId','expectedSchema','mode','paths','registeredWorkspaces','files','rc10Audit','backupManifest','keySource'])||target.schemaVersion!==1||typeof target.targetId!=='string'||!target.targetId||target.expectedSchema!==latest||!['closed','observe'].includes(target.mode)||!keys(target.paths,PATH_KEYS)||!PATH_KEYS.every(key=>typeof target.paths[key]==='string')||!Array.isArray(target.registeredWorkspaces)||target.registeredWorkspaces.some(item=>typeof item!=='string')||!keys(target.files,FILE_KEYS)||!FILE_KEYS.every(key=>target.files[key]===null||typeof target.files[key]==='string')||!keys(target.rc10Audit,['path','sha256'])||typeof target.rc10Audit.path!=='string'||!/^[a-f0-9]{64}$/.test(target.rc10Audit.sha256)||!['file','environment','unverified'].includes(target.keySource)||!(target.backupManifest===null||typeof target.backupManifest==='string')){
    issue('TARGET_MANIFEST_INVALID');releaseBlockers.push({code:'EXPLICIT_VALID_TARGET_REQUIRED'});return report;
  }
  report.targetId=target.targetId;report.mode=target.mode;report.paths={};
  const entries=[...PATH_KEYS.map(key=>[key,target.paths[key],key==='database'?'file':'directory']),...target.registeredWorkspaces.map((file,index)=>[`registeredWorkspace${index}`,file,'directory'])];
  for(const [field,file,kind]of entries){try{report.paths[field]={path:file,...await inspectPath(file,kind)};}catch(error){issue(error.code==='ENOENT'?'PATH_MISSING':error.code??error.message,field);}}
  if(report.paths.private&&((report.paths.private.mode&0o077)||(process.getuid&&report.paths.private.uid!==process.getuid())))issue('PRIVATE_DIRECTORY_PERMISSION_INVALID','private');
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)if(overlaps(entries[i][1],entries[j][1]))issue('PATH_OVERLAP',`${entries[i][0]}:${entries[j][0]}`);
  for(const key of FILE_KEYS){const file=target.files[key];if(file===null){if(key==='releasePack')releaseBlockers.push({code:'RELEASE_PACK_NOT_SELECTED'});continue;}try{report.paths[key]={path:file,sha256:sha(await publicBytes(file,target))};}catch(error){issue(error.code==='ENOENT'?'CONFIG_FILE_MISSING':error.code??error.message,key);}}
  if(!findings.some(item=>item.field==='database')){
    try{
      report.databaseFile=databaseFileMetadata(target.paths.database);
      const inventory=inventoryDatabase(target.paths.database,{hostProbe});report.inventory=inventory;
      for(const item of inventory.migrationIssues)findings.push(item);
      if(inventory.missingTables.length)issue('SCHEMA_TABLES_MISSING');
      if(inventory.migrationRequired)issue('MIGRATION_REQUIRED');
      if(inventory.databaseCheck!=='ok'||inventory.foreignKeyErrors)issue('DATABASE_INTEGRITY_FAILED');
      if(inventory.host.state==='active')issue('SERVICE_STILL_ACTIVE');
      else if(inventory.host.state==='unverifiable')issue('SERVICE_QUIESCENCE_UNVERIFIABLE');
      if(Object.values(inventory.work).some(value=>value>0))issue('UNSETTLED_DATABASE_WORK');
      for(const file of inventory.paths.registeredPaths)if(!target.registeredWorkspaces.includes(file))issue('REGISTERED_WORKSPACE_NOT_DECLARED');
      for(const file of inventory.paths.sessionPaths)if(![target.paths.sandbox,target.paths.managedWorkspaces,...target.registeredWorkspaces].some(root=>file===root||file.startsWith(root+path.sep)))issue('SESSION_WORKSPACE_NOT_COVERED');
      for(const file of inventory.paths.nativePaths)if(file!==target.paths.private&&!file.startsWith(target.paths.private+path.sep))issue('NATIVE_IDENTITY_NOT_COVERED');
      if(inventory.metadata.credentials>0){if(target.keySource==='file'){try{const info=await inspectPath(path.join(target.paths.private,'account-master-key.json'),'file');if((info.mode&0o077)||(process.getuid&&info.uid!==process.getuid()))issue('MASTER_KEY_PERMISSION_INVALID');}catch(error){issue(error.code==='ENOENT'?'MASTER_KEY_FILE_MISSING':error.code??error.message);}}releaseBlockers.push({code:'KEY_AND_ENCRYPTED_CONTENT_MATCH_UNVERIFIED'});}
      if(inventory.metadata.nativeIdentities+inventory.metadata.legacySessions+inventory.metadata.resourceSessions>0)releaseBlockers.push({code:'NATIVE_SESSION_WORKSPACE_MATCH_UNVERIFIED'});
    }catch(error){issue('DATABASE_METADATA_UNAVAILABLE');report.databaseErrorCode=error.code??(['WAL_REQUIRES_QUIESCENT_SNAPSHOT','JOURNAL_REQUIRES_QUIESCENT_SNAPSHOT'].includes(error.message)?error.message:'METADATA_QUERY_FAILED');}
  }
  if(!report.inventory)releaseBlockers.push({code:'KEY_AND_ENCRYPTED_CONTENT_MATCH_UNVERIFIED'},{code:'NATIVE_SESSION_WORKSPACE_MATCH_UNVERIFIED'});
  try{
    const bytes=await publicBytes(target.rc10Audit.path,target);
    if(sha(bytes)!==target.rc10Audit.sha256)issue('RC10_EVIDENCE_DIGEST_MISMATCH');
    const audit=JSON.parse(bytes),decision=audit.releaseDecision;
    report.rc10={sha256:sha(bytes),stage:audit.stage,dailyReleaseReady:decision?.dailyReleaseReady===true,blockingIssueIds:Array.isArray(decision?.blockingIssueIds)?decision.blockingIssueIds.filter(id=>typeof id==='string'):[]};
    if(audit.stage!=='RC10'||audit.schemaVersion!==1||audit.ok!==true||!decision||decision.dailyReleaseReady!==true||decision.fullContinuousCollaborationAccepted!==true||decision.all59Passed!==true||decision.coreContractsReduced!==false||!Array.isArray(decision.blockingIssueIds)||decision.blockingIssueIds.length)releaseBlockers.push({code:'RC10_RELEASE_GATE_BLOCKED'});
  }catch{issue('RC10_EVIDENCE_UNAVAILABLE');releaseBlockers.push({code:'RC10_RELEASE_GATE_UNVERIFIED'});}
  if(target.backupManifest!==null){try{const bytes=await publicBytes(target.backupManifest,target),backup=JSON.parse(bytes);if(backup.format!=='agent-gand-accounts-backup-v1'||!Array.isArray(backup.sources)||!Array.isArray(backup.files))issue('BACKUP_MANIFEST_INVALID');report.backup={manifestSha256:sha(bytes),contentVerified:false,restoreVerified:false};}catch{issue('BACKUP_MANIFEST_UNAVAILABLE');}}
  releaseBlockers.push({code:'MATCHED_COMPONENT_BACKUP_AND_RESTORE_UNVERIFIED'},{code:'TARGET_FORWARD_MIGRATION_AND_OLD_WORKER_REJECTION_UNVERIFIED'},{code:'TARGET_CLOSED_AND_OBSERVE_REHEARSAL_UNVERIFIED'},{code:'INDEPENDENT_OPERATION_REVIEW_REQUIRED'});
  report.preparationPassed=findings.length===0;
  report.interpretation='Preparation checks are metadata only. Component overlaps (including registered projects nested in managed roots) are conservatively unsupported by this preflight and require an explicit coverage review; this is not a claim that the deployment is invalid. This command cannot authorize deployment, confirm credential matching, certify native recovery, or permit whole-database rollback. RC10 audit booleans or self-supplied manifest fields never make targetReleaseReady true.';
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const [command,flag,file,...extra]=process.argv.slice(2);if(extra.length||!file)throw new Error('USAGE');
    let result;
    if(command==='discover'&&flag==='--repo')result=await discoverTarget(file);
    else if(command==='check'&&flag==='--target'){if(secretName(file))throw new Error('TARGET_PATH_FORBIDDEN');await inspectPath(path.resolve(file),'file');result=await preflightTarget(await json(file));}
    else throw new Error('USAGE');
    console.log(JSON.stringify(result,null,2));if(command==='check'&&!result.preparationPassed)process.exitCode=2;
  }catch(error){console.error(error.message==='USAGE'?'Usage: threaded-release-preflight.mjs discover --repo <absolute repo> | check --target <manifest.json>':`Preflight failed (${error.code??'INVALID_INPUT'}); no runtime was started.`);process.exitCode=1;}
}
