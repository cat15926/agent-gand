import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { isLegacyRunMode, legacyRoomPreferences, ROOM_PREFERENCES_VERSION } from '@agent-gand/shared';
import { applyThreadedFoundationMigration, THREADED_FOUNDATION_MIGRATION } from './threadedMigration.ts';
import { applyThreadedExecutionMigration, THREADED_EXECUTION_MIGRATION } from './threadedExecutionMigration.ts';

// These descriptors are immutable. Later upgrades append a version instead of editing one.
export const ORCHESTRATION_MIGRATIONS = [
  { version: 1, name: 'o1-o5-additive-baseline', descriptor: 'requests-v1;previews-v1;bindings-v1;member-tickets-v1;run-controls-v1;token-reservations-v1;room-preferences-nullable' },
  { version: 2, name: 'o6-versioned-room-defaults', descriptor: 'preferences-version-v1;origin-explicit-or-legacy;mapping-audits-v1;entry-statistics-v1' },
  { version: 3, name: 'business-stage-execution-v1', descriptor: 'stage-gated-contract-v1;owner-accept-before-next-step;durable-accepted-gate-wake;stage-timing-v1;stage-token-reservations-v1' },
  { version: 4, name: 'business-stage-checkpoint-v1', descriptor: 'owner-confirmed-stage-checkpoint-v1;skip-confirmed-workers;accepted-prefix-provenance;immutable-output-and-file-archive;fresh-run-workspace;known-token-charge-carry' },
  { version: 5, name: 'business-stage-rework-v1', descriptor: 'owner-explicit-rejected-stage-rework-v1;immutable-rejection-audit;accepted-prefix-only;rejected-output-not-evidence;atomic-source-closure;carried-rework-instruction' },
  { version: 6, name: 'private-interaction-artifact-acl-v1', descriptor: 'owner-task-scope-v1;private-coordination-admission;managed-artifact-versions-v1;scope-filtered-file-read-search-evidence;owner-authorized-release-audit-v1' },
  { version: 7, name: 'artifact-worktree-snapshots-v1', descriptor: 'declared-delivery-manifest-v1;encrypted-self-contained-git-tree-pack;controlled-add-modify-delete-binary;fresh-isolated-restore;accepted-and-referenced-retention;public-managed-stage-checkpoint-v2' },
  { version: 8, name: 'private-write-recovery-v1', descriptor: 'owner-effect-reconciliation-v1;immutable-source;scope-bound-encrypted-stage-checkpoint-v3;exact-write-snapshot;fresh-run-native-home;no-unknown-effect-replay' },
  { version: 9, name: 'cost-budget-governance-v1', descriptor: 'versioned-owner-pricing-policy;atomic-run-stage-money-reservation;unknown-cost-not-zero;estimate-only-backend-admission;immutable-lineage-cost-carry' },
  { version: 10, name: 'branch-rework-contract-revision-v1', descriptor: 'business-contract-v2;explicit-member-dependencies;validated-rework-closure;immutable-contract-successor;engine-recovery-matrix;lineage-budget-side-effect-guards' },
  { version: 11, name: 'scoped-stage-batch-scheduling-v1', descriptor: 'business-contract-v3;assignment-scope-and-explicit-join;frozen-concurrency;deterministic-receipts;model-call-admission-ledger-v1;owner-scheduling-projection' },
  { version: 12, name: 'scoped-collaboration-foundation-v1', descriptor: 'boundary-v2;tool-api-v3-reserved;immutable-scope-manifest-v1;attempt-binding-v1;append-only-input-provenance-v1;closed-capability-packages' },
  { version: 13, name: 'scoped-action-boundary-fingerprint-v1', descriptor: 'runtime-action-commands-boundary-fingerprint;scope-attempt-ledger-output-bound-idempotency-v1' },
  { version: 14, name: 'scoped-delivery-v1', descriptor: 'owner-sealed-preview;immutable-delivery-plan-envelope;all-batches-status-only-return;unique-parent-wake;shared-token-ledger-v1' },
  { version: 15, name: 'scoped-release-v1', descriptor: 'sealed-intake-preview;immutable-source-authorized-aggregate;versioned-private-draft;single-use-policy-grant-record;exact-text-status-projection;registered-release-hold-v1' },
  { version: 16, name: 'scoped-recovery-v1', descriptor: 'readonly-single-batch-any;atomic-winner-fence;call-id-token-money-binding;attempt-local-crash-reconciliation;known-output-retry-charged;unknown-call-no-replay;member-ticket-attempt-fence' },
  { version: 17, name: 'scoped-native-coordination-v1', descriptor: 'polymorphic-scope-attempt-binding;native-cold-home-workspace-v1;ephemeral-native-memory;scope-tool-provenance;coordination-static-scope-adapter-v1;verified-combination-admission' },
  { version: 18, name: 'autonomous-task-authority-v1', descriptor: 'immutable-root-task-policy-v1;tool-api-v4-reserved;subject-bound-attenuating-grants;attempt-authority-binding;append-only-revocation;single-run-token-money-budget;no-autonomous-executor-ac1' },
  { version: 19, name: 'autonomous-dynamic-delegation-v1', descriptor: 'explicit-ac2-api-root;immutable-work-dag;attempt-bound-scopes;append-only-delegation-rounds;atomic-command-wait;dependency-ready-dispatch;generation-fenced-status-only-wake;no-default-ui-no-autonomous-release' },
  { version: 20, name: 'autonomous-result-delivery-v1', descriptor: 'explicit-ac3-root;sealed-accepted-result-provenance;derived-input-grants;aggregate-task-scopes;exact-emission-plans-and-records;owner-only-single-decision;approved-intake-copies;question-answer-wake;known-usage-terminal-delivery;no-ac2-upgrade' },
  { version: 21, name: 'autonomous-default-entry-v1', descriptor: 'explicit-entry-v2;immutable-submission-and-user-instructions;frozen-readonly-cost-policy;actual-task-progress;instruction-aware-context-and-final;durable-pause-resume;no-old-root-upgrade' },
  { version: 22, name: 'autonomous-validated-flow-v1', descriptor: 'frozen-protocol-catalog;immutable-flow-states-jobs-actions-sources;accepted-action-provenance;structured-projection;root-ledger-dag;phase-fence;bounded-correction;no-old-root-upgrade' },
  { version: 23, name: 'autonomous-managed-sdk-rollout-v1', descriptor: 'explicit-ac6-root;frozen-execution-drivers;managed-sdk-v4-cold-transport;per-room-admission;close-and-drain-existing-root;no-codex-admission;no-old-root-upgrade' },
  { version: 24, name: 'autonomous-estimated-cost-reserve-v1', descriptor: 'explicit-cost-version1;known-output-estimate-reserve-can-complete;unknown-money-remains-charged;unknown-execution-or-tokens-still-block;stop-policy-and-old-roots-unchanged' },
  THREADED_FOUNDATION_MIGRATION,
  THREADED_EXECUTION_MIGRATION,
] as const;
export const migrationChecksum = (descriptor: string): string => createHash('sha256').update(descriptor).digest('hex');
const tables = (db: Database.Database): Set<string> => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name));

/** Preserve every historical byte while removing the Collaboration-only foreign key.
 * schema.sql installs the shared Attempt authority trigger before any worker starts. */
export function migrateScopedAttemptBindings(db: Database.Database): void {
  if (!tables(db).has('runtime_scope_attempts')) return;
  const keys = db.prepare('PRAGMA foreign_key_list(runtime_scope_attempts)').all() as Array<{table:string}>;
  if (!keys.some(k => k.table === 'collaboration_attempts')) return;
  const enabled = db.pragma('foreign_keys', { simple:true });
  db.pragma('foreign_keys = OFF');
  try { db.transaction(() => {
    db.exec(`CREATE TABLE runtime_scope_attempts_g5 (
      attempt_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES runtime_execution_scopes(id),
      context_sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO runtime_scope_attempts_g5 SELECT * FROM runtime_scope_attempts;
      DROP TABLE runtime_scope_attempts;
      ALTER TABLE runtime_scope_attempts_g5 RENAME TO runtime_scope_attempts;`);
  }).immediate(); } finally { if (enabled) db.pragma('foreign_keys = ON'); }
}

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
  assertOrchestrationSchemaCompatible(db);
  db.transaction(() => {
    assertOrchestrationSchemaCompatible(db);
    db.exec(`CREATE TABLE IF NOT EXISTS orchestration_model_calls (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt_id TEXT, agent_id TEXT NOT NULL,
      backend TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, waiting_reason TEXT,
      queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
      CREATE INDEX IF NOT EXISTS orchestration_model_calls_run ON orchestration_model_calls(run_id,attempt_id)`);
    for (const name of ['orchestration_requests','orchestration_previews','execution_bindings','execution_member_tickets','orchestration_run_controls','orchestration_token_reservations','business_stage_executions','business_stage_token_reservations','business_run_checkpoints']) {
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
    applyThreadedFoundationMigration(db);
    applyThreadedExecutionMigration(db);
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
      if (!isLegacyRunMode(row.mode)) { skipped.push(row.id); continue; }
      if (row.preferences !== null) {
        // O5 explicit preferences are adopted verbatim, without rewriting JSON or invalidating tasks.
        if (row.preferences_version === null) { db.prepare("UPDATE conversations SET preferences_version=?,preferences_origin='explicit' WHERE id=?").run(ROOM_PREFERENCES_VERSION,row.id); adopted++; }
        continue;
      }
      const preferences = JSON.stringify(legacyRoomPreferences(row.mode,row.supervisor_id,row.default_reviewer_id));
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
