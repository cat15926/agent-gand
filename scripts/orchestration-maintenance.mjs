import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { config } from '../apps/server/src/config.ts';
import { isRoomPreferences } from '../packages/shared/src/roomPreferences.ts';
import { assertOrchestrationSchemaCompatible, assertActiveOrchestrationCompatible, migrateRoomPreferences, ORCHESTRATION_MIGRATIONS } from '../apps/server/src/db/orchestrationMigrations.ts';

// Inspection must not import database.ts, create tables, decrypt keys, or invoke a provider.
const names = db => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
const rows = (db,tables,name) => tables.has(name) ? db.prepare(`SELECT * FROM ${name}`).all() : [];
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
export function inspectOrchestration(db) {
  const tables = names(db), issues = [], warnings = [];
  const add = (code,fields={}) => issues.push({code,...fields});
  if (db.pragma('quick_check',{simple:true}) !== 'ok') add('DATABASE_INTEGRITY_FAILED');
  try { assertOrchestrationSchemaCompatible(db); } catch { add('UNSUPPORTED_SCHEMA_MIGRATION'); }
  try { assertActiveOrchestrationCompatible(db); } catch { add('UNSUPPORTED_ACTIVE_CONTRACT'); }
  const migrations = rows(db,tables,'orchestration_schema_migrations');
  const pendingMigrations = ORCHESTRATION_MIGRATIONS.filter(m => !migrations.some(r => r.version === m.version)).map(m => m.version);
  const rooms = rows(db,tables,'conversations'), runs = rows(db,tables,'runs'), requests = rows(db,tables,'orchestration_requests');
  const bindings = rows(db,tables,'execution_bindings'), roles = rows(db,tables,'agents');
  const controls=rows(db,tables,'orchestration_run_controls'),native=rows(db,tables,'external_agent_executions'),tickets=rows(db,tables,'execution_member_tickets'),plans=rows(db,tables,'coordination_plans'),tools=rows(db,tables,'tool_executions');
  const pendingRooms = [], configurationRequiredRooms = [];
  for (const room of rooms) {
    if (room.preferences == null) { pendingRooms.push(room.id); if (!['pipeline','supervisor','collaboration'].includes(room.mode)) add('UNKNOWN_ROOM_MODE',{conversationId:room.id}); continue; }
    const prefs = parse(room.preferences);
    if (!isRoomPreferences(prefs)) add('INVALID_ROOM_PREFERENCES',{conversationId:room.id});
    if (room.preferences_version != null && room.preferences_version !== 1) add('UNSUPPORTED_PREFERENCES_VERSION',{conversationId:room.id});
    const ids = parse(room.agent_ids);
    if (!Array.isArray(ids)) { add('INVALID_ROOM_TEAM',{conversationId:room.id}); continue; }
    if (prefs?.workflow === 'supervisor_decomposition') {
      const eligible=r=>{const def=parse(r?.definition);return r?.enabled&&ids.includes(r.id)&&def?.capabilities?.includes('coordinate')&&def?.execution?.kind!=='external';};
      const supervisor=prefs.supervisorId ? roles.find(r=>r.id===prefs.supervisorId) : roles.find(eligible);
      if (!supervisor || !eligible(supervisor)) configurationRequiredRooms.push(room.id);
    }
  }
  const activeRuns = runs.filter(r => !['completed','failed','cancelled'].includes(r.status)).map(r => {
    const row = requests.find(o => o.run_id === r.id), snapshot = parse(row?.snapshot);
    const control = controls.find(c => c.run_id === r.id);
    const uncertainNative = native.some(e => e.run_id === r.id && ['running','interrupted'].includes(e.status));
    const uncertainTicket = tickets.some(t => t.run_id === r.id && t.status === 'interrupted');
    return { runId:r.id,conversationId:r.conversation_id,status:r.status,authority:snapshot?.executionAuthority ?? 'legacy_without_entry_snapshot',
      snapshotVersion:row?.schema_version ?? null,templateVersion:snapshot?.decision?.templateVersion ?? null,
      engine:snapshot?.execution?.engine ?? r.mode,requiresInspection:!!control?.recovery_attention || uncertainNative || uncertainTicket };
  });
  for (const request of requests) {
    const snapshot = parse(request.snapshot), run = runs.find(r => r.id === request.run_id);
    if (!run || !snapshot || snapshot.runId !== request.run_id || snapshot.conversationId !== request.conversation_id || snapshot.submissionDigest !== request.submission_digest)
      add('INVALID_SUBMISSION_RECORD',{runId:request.run_id});
    if (run && snapshot?.executionAuthority === 'orchestration') {
      if (!tables.has('execution_bindings') || !tables.has('runtime_contracts')) add('EXECUTION_SCHEMA_MISSING',{runId:run.id});
      if (snapshot.execution?.engine === 'coordination' && !plans.some(p => p.id === snapshot.execution.planId && p.run_id === run.id)) add('FROZEN_PLAN_MISSING',{runId:run.id});
    }
  }
  if (pendingMigrations.length || pendingRooms.length) warnings.push({code:'MIGRATION_PENDING',pendingMigrations,roomCount:pendingRooms.length});
  if (configurationRequiredRooms.length) warnings.push({code:'ROOM_CONFIGURATION_REQUIRED',conversationIds:configurationRequiredRooms});
  const inspectionRequiredRunIds=[...new Set([...controls.filter(r=>r.recovery_attention).map(r=>r.run_id),...native.filter(r=>['running','interrupted'].includes(r.status)).map(r=>r.run_id),...tools.filter(r=>r.status==='needs_attention'||r.replay_policy==='manual'&&['running','failed','interrupted'].includes(r.status)).map(r=>r.run_id)])];
  // Cancelling a Run does not certify its filesystem effects. Include terminal fences too.
  if (inspectionRequiredRunIds.length) warnings.push({code:'UNKNOWN_EXECUTION_REQUIRES_INSPECTION',runIds:inspectionRequiredRunIds});
  return { readOnly:true,providerRequests:0,ok:issues.length===0,supportedWorker:'o6-compatible',
    migrations:migrations.map(({version,name,checksum,applied_at})=>({version,name,checksum,appliedAt:applied_at})),pendingMigrations,pendingRoomIds:pendingRooms,
    counts:{rooms:rooms.length,runs:runs.length,requests:requests.length,bindings:bindings.length,roomMappings:rows(db,tables,'room_preferences_migration_audits').length},
    activeRuns,inspectionRequiredRunIds,issues,warnings,entryStatistics:rows(db,tables,'orchestration_entry_statistics'),admission:config.orchestrationRollout };
}
export function auditOrchestration(dbPath = config.dbPath) {
  const db = new Database(dbPath,{readonly:true,fileMustExist:true});
  try { return inspectOrchestration(db); } finally { db.close(); }
}
export function rollbackCheck(target,dbPath = config.dbPath) {
  const audit = auditOrchestration(dbPath);
  const compatible = target === 'o6-compatible' && audit.ok && audit.pendingMigrations.length === 0;
  return { ...audit, target,canRollback:compatible,
    reason: compatible ? '仅回退新任务接入开关；保留此版本兼容 worker 与全部数据库状态。' : '目标 worker 未经验证可识别当前数据库和冻结契约，禁止使用旧二进制恢复或降低数据库版本。',
    shutdownAdmission:{ORCHESTRATION_ENTRY_MODE:'closed',ORCHESTRATION_LEGACY_ENTRY_ENABLED:'false'},
    deleteState:false,downgradeContracts:false };
}
function processAlive(owner) {
  if (owner.host !== hostname()) return true;
  try { const status = execFileSync('ps',['-p',String(owner.pid),'-o','stat=','-o','lstart='],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}).trim();
    return !!status && !status.startsWith('Z') && status.replace(/^\S+\s+/,'') === owner.identity;
  } catch { return false; }
}
/** Offline only, data mapping only. Schema adoption is performed by a supported server at boot. */
export function migrateOrchestration(dbPath = config.dbPath) {
  const db = new Database(dbPath,{fileMustExist:true});
  try {
    return db.transaction(() => {
      const tables = names(db);
      if (rows(db,tables,'external_runtime_host').some(processAlive)) throw new Error('服务仍在运行，请先正常停止服务');
      if (rows(db,tables,'external_native_processes').some(r => r.status === 'active') || rows(db,tables,'external_agent_executions').some(r => r.status === 'running')
        || rows(db,tables,'execution_member_tickets').some(r => r.status === 'active')) throw new Error('存在未收敛的执行，请由兼容 worker 先检查恢复');
      const audit = inspectOrchestration(db);
      if (!audit.ok || audit.pendingMigrations.length) throw new Error('数据库需要兼容 worker 升级或修复；维护命令不会盲目创建或降级表');
      return {readOnly:false,providerRequests:0,...migrateRoomPreferences(db)};
    }).immediate();
  } finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command,...args] = process.argv.slice(2); let result;
    if (command === 'audit' && !args.length) result = auditOrchestration();
    else if (command === 'rollback-check' && args.length === 2 && args[0] === '--target') result = rollbackCheck(args[1]);
    else if (command === 'migrate' && !args.length) result = migrateOrchestration();
    else throw new Error('用法：orchestration:audit / orchestration:migrate / orchestration:rollback-check --target o6-compatible');
    console.log(JSON.stringify(result,null,2)); if (result.ok === false || result.canRollback === false) process.exitCode = 2;
  } catch (error) { console.error(error.code ? `维护操作失败（${error.code}），请检查路径和权限` : error.message); process.exitCode = 1; }
}
