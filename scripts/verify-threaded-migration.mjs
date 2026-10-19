import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {
  ORCHESTRATION_MIGRATIONS, applyOrchestrationSchemaMigrations,
  assertOrchestrationSchemaCompatible, migrationChecksum, migrateRoomPreferences,
} from '../apps/server/src/db/orchestrationMigrations.ts';
import { createThreadedStore } from '../apps/server/src/threaded/store.ts';

const root = await mkdtemp(path.join(os.tmpdir(), 'threaded-migration-'));
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [];
const checks = [];
const open = name => {
  const db = new Database(path.join(root, name));
  databases.push(db);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  return db;
};
const bootstrap = name => {
  const db = open(name);
  assertOrchestrationSchemaCompatible(db);
  db.exec(schema);
  return db;
};
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const tables = db => db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','trigger','index') ORDER BY type,name").all();
const seedV24 = db => {
  db.exec(`CREATE TABLE orchestration_schema_migrations (
    version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)`);
  const insert = db.prepare('INSERT INTO orchestration_schema_migrations VALUES(?,?,?,?)');
  for (const migration of ORCHESTRATION_MIGRATIONS.filter(m => m.version <= 24)) {
    insert.run(migration.version, migration.name, migrationChecksum(migration.descriptor), '2026-10-18T00:00:00.000Z');
  }
};
const addAgent = (db, id) => db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
  VALUES(?,?,?,'fixture',?,?)`).run(id, id, '{}', '2026-10-18', '2026-10-18');
const input = (title = 'Thread fixture', clientRequestId = 'request-1') => ({
  title, clientRequestId,
  members: [{ agentId: 'agent-a', handle: 'Agent-A', roleVersion: 1, permissionVersion: 1 }],
});
const sqlInvocation = (db, id, thread, owner = thread.ownerId) => db.prepare(`INSERT INTO threaded_invocations
  (id,thread_id,owner_id,agent_id,authority_epoch,causal_root_id,created_at,updated_at)
  VALUES(?,?,?,'agent-a',1,?,'2026-10-19','2026-10-19')`).run(id, thread.id, owner, `root-${id}`);
const sqlRun = (db, id, thread, mode = 'threaded') => db.prepare(`INSERT INTO runs
  (id,goal,mode,conversation_id,status,agent_ids,created_at) VALUES(?,'fixture',?,?,'pending','["agent-a"]','2026-10-19')`).run(id, mode, thread.conversationId);

try {
  // Empty database bootstrap, repeated migrations, stable identity across reopen.
  const empty = bootstrap('empty.sqlite');
  const oldMessageColumns = empty.pragma('table_info(messages)');
  applyOrchestrationSchemaMigrations(empty);
  assert.equal(empty.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version, 25);
  const emptyStore = createThreadedStore(empty);
  const owner = emptyStore.getInstanceOwnerId();
  assert.match(owner, /^[0-9a-f-]{36}$/);
  applyOrchestrationSchemaMigrations(empty);
  assert.equal(emptyStore.getInstanceOwnerId(), owner);
  assert.equal(count(empty, 'threaded_instances'), 1);
  assert.deepEqual(empty.pragma('table_info(messages)'), oldMessageColumns);
  assert.throws(() => empty.prepare('UPDATE threaded_instances SET instance_owner_id=?').run('replacement'), /IDENTITY_IMMUTABLE/);
  assert.throws(() => empty.exec('DELETE FROM threaded_instances'), /IDENTITY_IMMUTABLE/);
  empty.close();
  const reopened = open('empty.sqlite');
  applyOrchestrationSchemaMigrations(reopened);
  assert.equal(createThreadedStore(reopened).getInstanceOwnerId(), owner);
  checks.push('empty bootstrap, repeated migration, stable owner and unchanged legacy messages');

  // Synthetic v24 history is never adopted into the new protocol.
  const legacy = bootstrap('v24.sqlite');
  seedV24(legacy);
  addAgent(legacy, 'agent-a');
  addAgent(legacy, 'agent-b');
  legacy.exec(`INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at)
    VALUES('old-room','历史房间','collaboration','["agent-a"]','2026-10-18','2026-10-18');
    INSERT INTO runs(id,goal,mode,conversation_id,status,agent_ids,created_at)
    VALUES('old-run','历史目标','collaboration','old-room','completed','["agent-a"]','2026-10-18');
    INSERT INTO messages(id,run_id,conversation_id,from_agent,to_agent,kind,body,created_at)
    VALUES('old-message','old-run','old-room','agent-a','all','agent','历史正文保持原样','2026-10-18');`);
  const history = () => ({
    rooms: legacy.prepare("SELECT * FROM conversations WHERE id='old-room'").all(),
    runs: legacy.prepare("SELECT * FROM runs WHERE id='old-run'").all(),
    messages: legacy.prepare("SELECT * FROM messages WHERE id='old-message'").all(),
    migrations: legacy.prepare('SELECT * FROM orchestration_schema_migrations WHERE version<=24 ORDER BY version').all(),
  });
  const before = history();
  applyOrchestrationSchemaMigrations(legacy);
  applyOrchestrationSchemaMigrations(legacy);
  assert.deepEqual(history(), before);
  assert.equal(count(legacy, 'threaded_threads'), 0);
  checks.push('v24 upgrade preserves historical rows and migration checksums byte-for-byte');

  const store = createThreadedStore(legacy);
  const initialCounts = ['runs','messages','tasks','orchestration_model_calls','execution_cost_reservations'].map(table => [table, count(legacy, table)]);
  const thread = store.createThread(input());
  assert.equal(thread.state, 'closed');
  assert.equal(thread.ownerId, store.getInstanceOwnerId());
  assert.equal(thread.mode, 'threaded');
  assert.equal(thread.schemaVersion, 1);
  assert.equal(store.listMembers(thread.id, thread.ownerId)[0].handle, 'agent-a');
  assert.equal(legacy.prepare('SELECT mode FROM conversations WHERE id=?').get(thread.conversationId).mode, 'threaded');
  assert.deepEqual(store.createThread(input()), thread);
  assert.throws(() => store.createThread(input('Changed title')), /THREADED_IDEMPOTENCY_CONFLICT/);
  assert.equal(store.getThread(thread.id, 'another-owner'), null);
  assert.deepEqual(store.listThreads('another-owner'), []);
  assert.deepEqual(store.listMembers(thread.id, 'another-owner'), []);
  assert.deepEqual(initialCounts.map(([table]) => [table, count(legacy, table)]), initialCounts);
  legacy.prepare('UPDATE conversations SET preferences=? WHERE id=?').run('{"threaded":"future policy"}',thread.conversationId);
  assert.ok(migrateRoomPreferences(legacy).skipped.includes(thread.conversationId));
  assert.equal(legacy.prepare('SELECT preferences_version FROM conversations WHERE id=?').get(thread.conversationId).preferences_version,null);
  assert.throws(() => store.createThread({ ...input('Duplicate members','duplicate'), members: [input().members[0],input().members[0]] }), /THREADED_INVALID_INPUT/);
  assert.throws(() => store.createThread({ ...input('Bad agent','bad-agent'), members: [{ ...input().members[0], agentId:'missing' }] }), /unavailable/);
  const roomCount = count(legacy, 'conversations');
  const threadCount = count(legacy, 'threaded_threads');
  legacy.exec(`CREATE TRIGGER fixture_member_failure BEFORE INSERT ON threaded_members
    WHEN NEW.handle='fail' BEGIN SELECT RAISE(ABORT,'fixture_atomic_failure'); END;`);
  assert.throws(() => store.createThread({ title:'Atomic rollback',clientRequestId:'rollback-thread',members:[
    input().members[0], {agentId:'agent-b',handle:'fail',roleVersion:1,permissionVersion:1},
  ] }), /fixture_atomic_failure/);
  assert.equal(count(legacy, 'conversations'), roomCount);
  assert.equal(count(legacy, 'threaded_threads'), threadCount);
  legacy.exec('DROP TRIGGER fixture_member_failure');
  checks.push('atomic closed Thread + Conversation + members, idempotency conflict and owner-filtered reads; no execution side effects');

  // Scope and version constraints protect the future Invocation/Attempt adapter.
  assert.throws(() => sqlInvocation(legacy,'wrong-owner',thread,'another-owner'), /FOREIGN KEY/);
  sqlInvocation(legacy,'inv-1',thread);
  sqlInvocation(legacy,'inv-2',thread);
  const attempt = legacy.prepare(`INSERT INTO threaded_attempts
    (id,invocation_id,thread_id,owner_id,agent_id,attempt_no,generation,authority_epoch,created_at,updated_at)
    VALUES(?,?,?,?,'agent-a',?,1,1,'2026-10-19','2026-10-19')`);
  attempt.run('attempt-1','inv-1',thread.id,thread.ownerId,1);
  assert.throws(() => attempt.run('attempt-duplicate','inv-1',thread.id,thread.ownerId,1), /UNIQUE/);
  attempt.run('attempt-2','inv-1',thread.id,thread.ownerId,2);
  assert.throws(() => legacy.prepare('UPDATE threaded_invocations SET current_attempt_id=? WHERE id=?').run('attempt-1','inv-2'), /FOREIGN KEY/);
  legacy.prepare('UPDATE threaded_invocations SET current_attempt_id=? WHERE id=?').run('attempt-2','inv-1');
  assert.throws(() => legacy.prepare('UPDATE threaded_invocations SET schema_version=2 WHERE id=?').run('inv-1'), /CHECK/);
  sqlRun(legacy,'wrong-mode-run',thread,'collaboration');
  sqlRun(legacy,'run-1',thread);
  sqlRun(legacy,'run-2',thread);
  const bind = legacy.prepare(`INSERT INTO threaded_run_bindings(invocation_id,run_id,thread_id,owner_id,created_at) VALUES(?,?,?,?,'2026-10-19')`);
  assert.throws(() => bind.run('inv-1','wrong-mode-run',thread.id,thread.ownerId), /SCOPE_MISMATCH/);
  bind.run('inv-1','run-1',thread.id,thread.ownerId);
  assert.throws(() => bind.run('inv-1','run-2',thread.id,thread.ownerId), /UNIQUE/);
  assert.throws(() => bind.run('inv-2','run-1',thread.id,thread.ownerId), /UNIQUE/);
  assert.throws(() => legacy.prepare("DELETE FROM threaded_run_bindings WHERE invocation_id='inv-1'").run(), /IMMUTABLE/);
  assert.throws(() => legacy.prepare("UPDATE runs SET mode='collaboration' WHERE id='run-1'").run(), /IMMUTABLE/);
  assert.throws(() => legacy.prepare("UPDATE conversations SET mode='collaboration' WHERE id=?").run(thread.conversationId), /IMMUTABLE/);
  assert.deepEqual(legacy.pragma('foreign_key_check'), []);
  checks.push('owner/version and attempt identity constraints, same-invocation current Attempt, unique scoped Run binding');

  // Fail after DDL/identity creation but before v25 registration: all of it rolls back.
  const rollback = bootstrap('rollback.sqlite');
  seedV24(rollback);
  rollback.exec(`CREATE TRIGGER fixture_v25_failure BEFORE INSERT ON orchestration_schema_migrations
    WHEN NEW.version=25 BEGIN SELECT RAISE(ABORT,'fixture_migration_failure'); END;`);
  const schemaBefore = tables(rollback);
  assert.throws(() => applyOrchestrationSchemaMigrations(rollback), /fixture_migration_failure/);
  assert.deepEqual(tables(rollback), schemaBefore);
  assert.equal(rollback.prepare('SELECT MAX(version) n FROM orchestration_schema_migrations').get().n, 24);
  rollback.exec('DROP TRIGGER fixture_v25_failure');
  applyOrchestrationSchemaMigrations(rollback);
  assert.equal(count(rollback, 'threaded_instances'), 1);
  checks.push('DDL, stable owner and migration registration roll back together, followed by successful retry');

  // A future/tampered catalog is rejected before any schema mutations.
  const future = bootstrap('future.sqlite');
  seedV24(future);
  future.prepare('INSERT INTO orchestration_schema_migrations VALUES(?,?,?,?)').run(26,'future','unknown','2026-10-19');
  const futureBefore = tables(future);
  assert.throws(() => applyOrchestrationSchemaMigrations(future), /26.*不受此 worker 支持/);
  assert.deepEqual(tables(future), futureBefore);
  future.exec('DELETE FROM orchestration_schema_migrations WHERE version=26');
  future.exec("UPDATE orchestration_schema_migrations SET checksum='changed' WHERE version=24");
  assert.throws(() => applyOrchestrationSchemaMigrations(future), /24.*不受此 worker 支持/);
  checks.push('future version and mutated historical checksum rejected before mutation');

  // Execute the real frozen v24 compatibility guard, not a newly written imitation.
  const oldSource = execFileSync('git', ['show','0a2f1b4d26a263da64b4c950bcb1e3589b0ed64c:apps/server/src/db/orchestrationMigrations.ts'], { encoding:'utf8', cwd:new URL('..', import.meta.url) });
  const oldJs = ts.transpileModule(oldSource, { compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText;
  const oldModule = { exports:{} };
  new Function('require','module','exports',oldJs)(name => {
    if (name === 'node:crypto') return { createHash };
    if (name === '@agent-gand/shared') return {}; // Only schema compatibility is invoked.
    throw new Error(`Unexpected frozen module import: ${name}`);
  }, oldModule, oldModule.exports);
  const upgradedBefore = tables(legacy);
  assert.throws(() => oldModule.exports.assertOrchestrationSchemaCompatible(legacy), /25.*不受此 worker 支持/);
  assert.deepEqual(tables(legacy), upgradedBefore);
  checks.push('actual frozen v24 worker compatibility guard refuses v25 without mutation');

  console.log(JSON.stringify({ status:'passed', scope:'T02/DB03 isolated SQLite foundation; no application or model execution', checks },null,2));
} finally {
  for (const db of databases) if (db.open) db.close();
  await rm(root, { recursive:true,force:true });
}
