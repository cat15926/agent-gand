import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { legacyRoomPreferences, ROOM_PREFERENCES_VERSION, type RunMode } from '@agent-gand/shared';

// These descriptors are immutable. Later upgrades append a version instead of editing one.
export const ORCHESTRATION_MIGRATIONS = [
  { version: 1, name: 'o1-o5-additive-baseline', descriptor: 'requests-v1;previews-v1;bindings-v1;member-tickets-v1;run-controls-v1;token-reservations-v1;room-preferences-nullable' },
  { version: 2, name: 'o6-versioned-room-defaults', descriptor: 'preferences-version-v1;origin-explicit-or-legacy;mapping-audits-v1;entry-statistics-v1' },
] as const;
export const migrationChecksum = (descriptor: string): string => createHash('sha256').update(descriptor).digest('hex');
const tables = (db: Database.Database): Set<string> => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name));

/** Run before schema.sql: an older compatible worker must reject a future DB without mutating it. */
export function assertOrchestrationSchemaCompatible(db: Database.Database): void {
  if (!tables(db).has('orchestration_schema_migrations')) return;
  for (const row of db.prepare('SELECT version,name,checksum FROM orchestration_schema_migrations').all() as Array<{ version: number; name: string; checksum: string }>) {
    const supported = ORCHESTRATION_MIGRATIONS.find(m => m.version === row.version);
    if (!supported || row.name !== supported.name || row.checksum !== migrationChecksum(supported.descriptor)) {
      throw new Error(`编排数据库迁移版本 ${row.version} 不受此 worker 支持；请保留支持该契约的 worker，禁止降级数据库`);
    }
  }
}

/** The pre-O6 idempotent schema is retained; explicitly adopt its verified baseline. */
export function applyOrchestrationSchemaMigrations(db: Database.Database): void {
  db.transaction(() => {
    for (const name of ['orchestration_requests','orchestration_previews','execution_bindings','execution_member_tickets','orchestration_run_controls','orchestration_token_reservations']) {
      if (!tables(db).has(name)) throw new Error(`编排迁移基线缺少 ${name}`);
    }
    const columns = new Set((db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>).map(c => c.name));
    if (!columns.has('preferences_version')) db.exec('ALTER TABLE conversations ADD COLUMN preferences_version INTEGER');
    if (!columns.has('preferences_origin')) db.exec('ALTER TABLE conversations ADD COLUMN preferences_origin TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS orchestration_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_preferences_migration_audits (
      conversation_id TEXT PRIMARY KEY, mapping_version INTEGER NOT NULL, legacy_mode TEXT NOT NULL,
      preferences_digest TEXT NOT NULL, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orchestration_entry_statistics (
      endpoint TEXT NOT NULL, input_format TEXT NOT NULL, outcome TEXT NOT NULL, http_status INTEGER NOT NULL,
      calls INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
      PRIMARY KEY(endpoint,input_format,outcome,http_status))`);
    for (const migration of ORCHESTRATION_MIGRATIONS) db.prepare(`INSERT OR IGNORE INTO orchestration_schema_migrations
      (version,name,checksum,applied_at) VALUES (?,?,?,?)`).run(migration.version, migration.name, migrationChecksum(migration.descriptor), new Date().toISOString());
  }).immediate();
}

/** Atomic and repeatable. Preserves modes, timestamps, teams, workspaces and every Run record. */
export function migrateRoomPreferences(db: Database.Database): { mapped: number; adopted: number; skipped: string[] } {
  return db.transaction(() => {
    let mapped = 0, adopted = 0; const skipped: string[] = [];
    const rows = db.prepare('SELECT id,mode,supervisor_id,default_reviewer_id,preferences,preferences_version FROM conversations').all() as Array<{
      id: string; mode: string; supervisor_id: string | null; default_reviewer_id: string | null; preferences: string | null; preferences_version: number | null;
    }>;
    for (const row of rows) {
      if (row.preferences !== null) {
        // O5 explicit preferences are adopted verbatim, without rewriting JSON or invalidating tasks.
        if (row.preferences_version === null) { db.prepare("UPDATE conversations SET preferences_version=?,preferences_origin='explicit' WHERE id=?").run(ROOM_PREFERENCES_VERSION,row.id); adopted++; }
        continue;
      }
      if (!['collaboration','pipeline','supervisor'].includes(row.mode)) { skipped.push(row.id); continue; }
      const preferences = JSON.stringify(legacyRoomPreferences(row.mode as RunMode,row.supervisor_id,row.default_reviewer_id));
      db.prepare(`UPDATE conversations SET preferences=?,preferences_version=?,preferences_origin='legacy_mapping',
        members_version=members_version+1 WHERE id=? AND preferences IS NULL`).run(preferences,ROOM_PREFERENCES_VERSION,row.id);
      db.prepare(`INSERT OR IGNORE INTO room_preferences_migration_audits
        (conversation_id,mapping_version,legacy_mode,preferences_digest,applied_at) VALUES (?,?,?,?,?)`)
        .run(row.id,ROOM_PREFERENCES_VERSION,row.mode,migrationChecksum(preferences),new Date().toISOString());
      mapped++;
    }
    return { mapped, adopted, skipped };
  }).immediate();
}

/** Validate active frozen entry contracts before recovery can invoke any backend. */
export function assertActiveOrchestrationCompatible(db: Database.Database): void {
  if (!tables(db).has('orchestration_requests')) return;
  const records = db.prepare(`SELECT o.schema_version,o.snapshot,o.run_id FROM orchestration_requests o JOIN runs r ON r.id=o.run_id
    WHERE r.status NOT IN ('completed','failed','cancelled')`).all() as Array<{ schema_version: number; snapshot: string; run_id: string }>;
  for (const row of records) {
    let item;
    try { item = JSON.parse(row.snapshot); } catch { throw new Error(`任务 ${row.run_id} 的冻结编排契约损坏，禁止恢复`); }
    if (row.schema_version !== 1 || item.schemaVersion !== 1 || item.request?.schemaVersion !== 1
      || !['o1-templates-v1','o4-workflows-v1'].includes(item.decision?.templateVersion)
      || !['o1-rules-v1','o4-rules-v1'].includes(item.decision?.resolverVersion)
      || !['legacy','orchestration'].includes(item.executionAuthority)
      || item.executionAuthority === 'orchestration' && (!['collaboration','coordination','pipeline'].includes(item.execution?.engine)
        || item.decision?.templateVersion !== 'o4-workflows-v1' || typeof item.execution?.readonly !== 'boolean'
        || item.execution.engine === 'coordination' && typeof item.execution.planId !== 'string')) {
      throw new Error(`任务 ${row.run_id} 的冻结编排契约不受此 worker 支持，禁止降级或重新规划`);
    }
  }
}
