import { pathToFileURL } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { config } from '../apps/server/src/config.ts';
import { assertOrchestrationSchemaCompatible, assertActiveOrchestrationCompatible } from '../apps/server/src/db/orchestrationMigrations.ts';
import { scopedCollaborationSupport } from '../apps/server/src/runtime/scopedCapabilities.ts';

/** Reads metadata only. Never initializes the DB, decrypts a preview or calls a model. */
export function inspectScopedCollaboration(db) {
  assertOrchestrationSchemaCompatible(db);assertActiveOrchestrationCompatible(db);
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  const scalar=(table,sql)=>tables.has(table)?db.prepare(sql).get().n:0;
  const scoped=`SELECT run_id FROM runtime_contracts WHERE json_extract(payload,'$.features.scopedCollaboration') IS NOT NULL OR json_extract(payload,'$.features.coordinationScopes')=1`;
  if(!tables.has('runtime_contracts'))return {readOnly:true,providerRequests:0,schema:0,migrationRequired:true,support:scopedCollaborationSupport()};
  const runs=db.prepare(`SELECT r.status,COUNT(*) count FROM runs r WHERE r.id IN (${scoped}) GROUP BY r.status`).all();
  const unknown=scalar('orchestration_token_reservations',`SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id IN (${scoped}) AND status='unknown'`);
  const activeAttempts=scalar('collaboration_attempts',`SELECT COUNT(*) n FROM collaboration_attempts WHERE run_id IN (${scoped}) AND status='running'`)
    +scalar('coordination_step_attempts',`SELECT COUNT(*) n FROM coordination_step_attempts WHERE run_id IN (${scoped}) AND status='running'`);
  const nativeProcesses=scalar('external_native_processes',`SELECT COUNT(*) n FROM external_native_processes p JOIN external_agent_executions e ON e.id=p.execution_id WHERE e.run_id IN (${scoped}) AND p.status='active'`);
  const activeRuns=`SELECT id FROM runs WHERE status NOT IN ('completed','failed','cancelled')`;
  const queuedDispatches=scalar('collaboration_dispatches',`SELECT COUNT(*) n FROM collaboration_dispatches WHERE run_id IN (${scoped}) AND run_id IN (${activeRuns}) AND status='queued'`);
  const waitingHolds=scalar('runtime_holds',`SELECT COUNT(*) n FROM runtime_holds WHERE run_id IN (${scoped}) AND run_id IN (${activeRuns}) AND status IN ('open','claimed')`);
  const readyGrants=scalar('information_release_grants',`SELECT COUNT(*) n FROM information_release_grants g JOIN information_release_policies p ON p.id=g.policy_id
    WHERE g.status='ready' AND p.status='approved' AND p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND g.run_id IN (${activeRuns})`);
  return {readOnly:true,providerRequests:0,schema:scalar('orchestration_schema_migrations','SELECT COALESCE(MAX(version),0) n FROM orchestration_schema_migrations'),support:scopedCollaborationSupport(),
    runs,activeAttempts,nativeProcesses,queuedDispatches,waitingHolds,readyGrants,unknownTokenReservations:unknown,
    publications:scalar('information_release_records','SELECT COUNT(*) n FROM information_release_records'),
    drain:{newAdmissionClosed:scopedCollaborationSupport().admissionMode==='closed',noExecutingAttempts:activeAttempts===0&&nativeProcesses===0,
      compatibleWorkerRequired:activeAttempts+nativeProcesses+queuedDispatches+waitingHolds+readyGrants>0,
      unknownUsageNeedsReview:unknown>0},
    databaseCheck:db.pragma('quick_check',{simple:true}),foreignKeyErrors:db.pragma('foreign_key_check').length};
}
export function scopedInventory(databasePath=config.dbPath) {
  const db=new Database(databasePath,{readonly:true,fileMustExist:true});
  try{return inspectScopedCollaboration(db);}finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv.length!==2)throw new Error('用法：通过 DB_PATH 指定只读检查目标，再运行 scoped:inventory');console.log(JSON.stringify(scopedInventory(),null,2));}
  catch(error){console.error('独立协作检查失败：'+(error.code??'请检查数据库版本、路径和权限'));process.exitCode=1;}
}
