import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'threaded-migration-'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents'), LOG_LEVEL: 'silent' });
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const { ORCHESTRATION_MIGRATIONS, applyOrchestrationSchemaMigrations,
  assertOrchestrationSchemaCompatible, migrationChecksum, migrateRoomPreferences,
} = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const foundation = await import('../apps/server/src/db/threadedMigration.ts');
const executionBoundary = await import('../apps/server/src/db/threadedExecutionMigration.ts');
const resourceBoundary = await import('../apps/server/src/db/executionResourcesMigration.ts');
const messageBoundary = await import('../apps/server/src/db/threadedMessagingMigration.ts');
const schedulingBoundary = await import('../apps/server/src/db/threadedSchedulingMigration.ts');
const contextBoundary = await import('../apps/server/src/db/threadedContextMigration.ts');
const collaborationBoundary = await import('../apps/server/src/db/threadedCollaborationMigration.ts');
const actionBoundary = await import('../apps/server/src/db/threadedActionMigration.ts');
const latestVersion = 33;
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
const frozenMigration = revision => {
  const source = execFileSync('git', ['show',`${revision}:apps/server/src/db/orchestrationMigrations.ts`], { encoding:'utf8', cwd:new URL('..', import.meta.url) });
  const js = ts.transpileModule(source, { compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports:{} };
  new Function('require','module','exports',js)(name => {
    if (name === 'node:crypto') return { createHash };
    if (name === '@agent-gand/shared') return {};
    if (name === './threadedMigration.ts') return foundation; // The v25 descriptor/DDL is unchanged.
    if (name === './threadedExecutionMigration.ts') return executionBoundary; // The v26 descriptor/DDL is unchanged.
    if (name === './executionResourcesMigration.ts') return resourceBoundary; // The v27 descriptor/DDL is unchanged.
    if (name === './threadedMessagingMigration.ts') return messageBoundary; // The v28 descriptor/DDL is unchanged.
    if (name === './threadedSchedulingMigration.ts') return schedulingBoundary; // The v29 descriptor/DDL is unchanged.
    if (name === './threadedContextMigration.ts') return contextBoundary; // The v30 descriptor/DDL is unchanged.
    if (name === './threadedCollaborationMigration.ts') return collaborationBoundary;
    if (name === './threadedActionMigration.ts') return actionBoundary; // The v32 descriptor/DDL is unchanged.
    throw new Error(`Unexpected frozen module import: ${name}`);
  }, module, module.exports);
  return module.exports;
};
const frozenThreadedModule = (revision, filename, cache = new Map()) => {
  if (cache.has(filename)) return cache.get(filename);
  const source = execFileSync('git', ['show', `${revision}:${filename}`], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  cache.set(filename, module.exports);
  new Function('require', 'module', 'exports', js)(name => {
    if (name === 'node:crypto') return { createHash, randomUUID };
    if (name === '@agent-gand/shared') return {};
    if (name.startsWith('./')) return frozenThreadedModule(revision, path.posix.join(path.posix.dirname(filename), name), cache);
    throw new Error(`Unexpected frozen threaded import: ${name}`);
  }, module, module.exports);
  return module.exports;
};

try {
  // Empty database bootstrap, repeated migrations, stable identity across reopen.
  const empty = bootstrap('empty.sqlite');
  const oldMessageColumns = empty.pragma('table_info(messages)');
  applyOrchestrationSchemaMigrations(empty);
  assert.equal(empty.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version, latestVersion);
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

  const v25Worker = frozenMigration('5298a9d');
  const v25 = bootstrap('v25.sqlite');
  v25Worker.applyOrchestrationSchemaMigrations(v25);
  addAgent(v25, 'agent-a');
  const v25Store = createThreadedStore(v25);
  const v25Thread = v25Store.createThread(input());
  sqlInvocation(v25,'preserved-invocation',v25Thread);
  const v25Snapshot = () => ({
    owner: v25Store.getInstanceOwnerId(), thread:v25Store.getThread(v25Thread.id,v25Thread.ownerId),
    migrations:v25.prepare('SELECT * FROM orchestration_schema_migrations WHERE version<=25 ORDER BY version').all(),
  });
  const v25Before = v25Snapshot();
  v25.exec(`CREATE TRIGGER fixture_v26_failure BEFORE INSERT ON orchestration_schema_migrations
    WHEN NEW.version=26 BEGIN SELECT RAISE(ABORT,'fixture_v26_migration_failure'); END;`);
  const v25SchemaBefore = tables(v25);
  assert.throws(() => applyOrchestrationSchemaMigrations(v25), /fixture_v26_migration_failure/);
  assert.deepEqual(tables(v25), v25SchemaBefore);
  assert.deepEqual(v25Snapshot(),v25Before);
  v25.exec('DROP TRIGGER fixture_v26_failure');
  applyOrchestrationSchemaMigrations(v25);
  applyOrchestrationSchemaMigrations(v25);
  assert.deepEqual(v25Snapshot(),v25Before);
  assert.equal(v25.prepare('SELECT goal FROM threaded_invocations WHERE id=?').get('preserved-invocation').goal,'');
  assert.equal(v25.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version, latestVersion);
  checks.push('actual v25 upgrade preserves identity/history/checksums; v26 failure rolls back added columns and tables, then retries');

  const v26Worker = frozenMigration('c3b36db');
  const v26 = bootstrap('v26.sqlite');
  v26Worker.applyOrchestrationSchemaMigrations(v26);
  addAgent(v26, 'agent-a');
  const v26Store = createThreadedStore(v26);
  const v26Thread = v26Store.createThread(input());
  sqlInvocation(v26, 'preserved-v26-invocation', v26Thread);
  const v26Snapshot = () => ({
    owner: v26Store.getInstanceOwnerId(),
    thread: v26Store.getThread(v26Thread.id, v26Thread.ownerId),
    invocations: v26.prepare('SELECT * FROM threaded_invocations ORDER BY id').all(),
    migrations: v26.prepare('SELECT * FROM orchestration_schema_migrations WHERE version<=26 ORDER BY version').all(),
  });
  const v26Before = v26Snapshot();
  v26.exec(`CREATE TRIGGER fixture_v27_failure BEFORE INSERT ON orchestration_schema_migrations
    WHEN NEW.version=27 BEGIN SELECT RAISE(ABORT,'fixture_v27_migration_failure'); END;`);
  const v26SchemaBefore = tables(v26);
  assert.throws(() => applyOrchestrationSchemaMigrations(v26), /fixture_v27_migration_failure/);
  assert.deepEqual(tables(v26), v26SchemaBefore);
  assert.deepEqual(v26Snapshot(), v26Before);
  v26.exec('DROP TRIGGER fixture_v27_failure');
  applyOrchestrationSchemaMigrations(v26);
  applyOrchestrationSchemaMigrations(v26);
  assert.deepEqual(v26Snapshot(), v26Before);
  assert.equal(v26.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version, latestVersion);
  assert.deepEqual(v26.pragma('foreign_key_check'), []);
  checks.push('actual v26 upgrade preserves Thread/Invocation and historical descriptors; v27 migration rolls back atomically and repeats safely');

  const v27Worker = frozenMigration('12d99e6');
  const v27 = bootstrap('v27.sqlite');
  v27Worker.applyOrchestrationSchemaMigrations(v27);
  addAgent(v27, 'agent-a');
  const v27Store = createThreadedStore(v27);
  const v27Thread = v27Store.createThread(input());
  sqlInvocation(v27, 'preserved-v27-invocation', v27Thread);
  v27.prepare('INSERT INTO execution_resource_epochs(resource_key,generation) VALUES(?,?)').run('fixture:preserved-generation', 17);
  v27.prepare(`INSERT INTO execution_resource_sessions(id,owner_id,binding_key,version,native_id,resource_key,state,record,updated_at)
    VALUES('preserved-session',?,'preserved-binding',1,'preserved-native','preserved-resource','ready','{}',1)`).run(v27Thread.ownerId);
  const v27Snapshot = () => ({
    owner: v27Store.getInstanceOwnerId(), thread: v27Store.getThread(v27Thread.id, v27Thread.ownerId),
    invocations: v27.prepare('SELECT * FROM threaded_invocations ORDER BY id').all(),
    epochs: v27.prepare('SELECT * FROM execution_resource_epochs ORDER BY resource_key').all(),
    sessions: v27.prepare('SELECT * FROM execution_resource_sessions ORDER BY id').all(),
    migrations: v27.prepare('SELECT * FROM orchestration_schema_migrations WHERE version<=27 ORDER BY version').all(),
  });
  const v27Before = v27Snapshot();
  v27.exec(`CREATE TRIGGER fixture_v28_failure BEFORE INSERT ON orchestration_schema_migrations
    WHEN NEW.version=28 BEGIN SELECT RAISE(ABORT,'fixture_v28_migration_failure'); END;`);
  const v27SchemaBefore = tables(v27);
  assert.throws(() => applyOrchestrationSchemaMigrations(v27), /fixture_v28_migration_failure/);
  assert.deepEqual(tables(v27), v27SchemaBefore);
  assert.deepEqual(v27Snapshot(), v27Before);
  v27.exec('DROP TRIGGER fixture_v28_failure');
  applyOrchestrationSchemaMigrations(v27);
  applyOrchestrationSchemaMigrations(v27);
  assert.deepEqual(v27Snapshot(), v27Before);
  assert.equal(v27.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version, latestVersion);
  assert.deepEqual(v27.pragma('foreign_key_check'), []);
  checks.push('actual frozen v27 upgrade preserves Thread/Invocation/resource generations/Session identity; failed v28 rolls back all DDL and retries idempotently');

  const v28Worker = frozenMigration('98b331f');
  const v28 = bootstrap('v28.sqlite');
  v28Worker.applyOrchestrationSchemaMigrations(v28);
  addAgent(v28, 'agent-a');
  const v28Store = createThreadedStore(v28), v28Thread = v28Store.createThread(input());
  v28.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(v28Thread.id);
  const v28Messages = frozenThreadedModule('98b331f', 'apps/server/src/threaded/messages.ts').createThreadedMessages(v28);
  const v28Input = { ownerId: v28Thread.ownerId, threadId: v28Thread.id, clientRequestId: 'preserved-v28-request',
    body: 'Frozen v28 message and owned attachment', targets: ['agent-a'],
    attachments: [{ name: 'preserved.txt', mediaType: 'text/plain', contentBase64: Buffer.from('frozen v28 bytes').toString('base64') }] };
  const v28Receipt = v28Messages.acceptUserMessage(v28Input);
  const v28Outbox = frozenThreadedModule('98b331f', 'apps/server/src/threaded/outbox.ts').createThreadedOutbox(v28);
  const v28Event = v28Outbox.claim('frozen-v28-worker');
  assert.ok(v28Event);
  assert.equal(v28Outbox.ack(v28Event, 'frozen-v28-consumer'), true);
  const v28Snapshot = () => ({
    owner: v28Store.getInstanceOwnerId(), thread: v28Store.getThread(v28Thread.id, v28Thread.ownerId),
    records: Object.fromEntries(['threaded_message_sequences', 'threaded_messages', 'threaded_message_attachments',
      'threaded_deliveries', 'threaded_wakes', 'threaded_outbox', 'threaded_outbox_receipts']
      .map(table => [table, v28.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
    migrations: v28.prepare('SELECT * FROM orchestration_schema_migrations WHERE version<=28 ORDER BY version').all(),
  });
  const v28Before = v28Snapshot();
  v28.exec(`CREATE TRIGGER fixture_v29_failure BEFORE INSERT ON orchestration_schema_migrations
    WHEN NEW.version=29 BEGIN SELECT RAISE(ABORT,'fixture_v29_migration_failure'); END;`);
  const v28SchemaBefore = tables(v28);
  assert.throws(() => applyOrchestrationSchemaMigrations(v28), /fixture_v29_migration_failure/);
  assert.deepEqual(tables(v28), v28SchemaBefore);
  assert.deepEqual(v28Snapshot(), v28Before);
  v28.exec('DROP TRIGGER fixture_v29_failure');
  applyOrchestrationSchemaMigrations(v28);
  applyOrchestrationSchemaMigrations(v28);
  assert.deepEqual(v28Snapshot(), v28Before);
  assert.deepEqual(v28Messages.acceptUserMessage(v28Input), v28Receipt);
  assert.equal(v28.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version, latestVersion);
  assert.deepEqual(v28.pragma('foreign_key_check'), []);
  checks.push('actual frozen v28 registry/message/outbox create preserved receipt, owned bytes and consumer ACK; failed v29 rolls back all DDL, then repeated upgrade preserves every prior fact');

  const v29Worker = frozenMigration('79bad41');
  const v29 = bootstrap('v29.sqlite');
  v29Worker.applyOrchestrationSchemaMigrations(v29);
  addAgent(v29, 'agent-a');
  const v29Store = createThreadedStore(v29), v29Thread = v29Store.createThread(input());
  v29.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(v29Thread.id);
  const v29Messages = frozenThreadedModule('79bad41', 'apps/server/src/threaded/messages.ts').createThreadedMessages(v29);
  const v29Input = { ownerId: v29Thread.ownerId, threadId: v29Thread.id, clientRequestId: 'preserved-v29-request',
    body: 'Frozen v29 Wake and causal budget root', targets: ['agent-a'] };
  const v29Receipt = v29Messages.acceptUserMessage(v29Input);
  const v29Budget = frozenThreadedModule('79bad41', 'apps/server/src/threaded/budget.ts').createThreadedBudget(v29, {});
  const v29Root = v29Budget.ensureRootForMessage(v29Receipt.message.id);
  // Enqueue only: the frozen scheduler persists its real FIFO/authorization facts
  // without requesting resource admission or running a model.
  const v29Queue = frozenThreadedModule('79bad41', 'apps/server/src/threaded/queue.ts').createThreadedQueue(v29, {
    budget: v29Budget, now: () => Date.now() + 60_000,
  });
  const v29Queued = v29Queue.enqueueWake(v29Receipt.wakes[0].id);
  assert.equal(v29Queued.causalRootId, v29Root.id);
  const v29TableNames = v29.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'sqlite_sequence' ORDER BY name").all().map(row => row.name);
  const v29Snapshot = () => Object.fromEntries(v29TableNames.map(table => [table,
    v29.prepare(`SELECT * FROM ${table}${table === 'orchestration_schema_migrations' ? ' WHERE version<=29' : ''}`).all()]));
  const v29Before = v29Snapshot();
  v29.exec(`CREATE TRIGGER fixture_v30_failure BEFORE INSERT ON orchestration_schema_migrations
    WHEN NEW.version=30 BEGIN SELECT RAISE(ABORT,'fixture_v30_migration_failure'); END;`);
  const v29SchemaBefore = tables(v29);
  assert.throws(() => applyOrchestrationSchemaMigrations(v29), /fixture_v30_migration_failure/);
  assert.deepEqual(tables(v29), v29SchemaBefore);
  assert.deepEqual(v29Snapshot(), v29Before);
  v29.exec('DROP TRIGGER fixture_v30_failure');
  applyOrchestrationSchemaMigrations(v29);
  applyOrchestrationSchemaMigrations(v29);
  assert.deepEqual(v29Snapshot(), v29Before);
  assert.deepEqual(v29Messages.acceptUserMessage(v29Input), v29Receipt);
  assert.deepEqual(v29Queue.enqueueWake(v29Receipt.wakes[0].id), v29Queued);
  assert.equal(count(v29, 'threaded_context_manifests'), 0);
  assert.equal(count(v29, 'threaded_session_anchors'), 0);
  assert.deepEqual(v29.pragma('foreign_key_check'), []);
  checks.push('actual frozen v29 message/budget/queue preserve causal root, FIFO and immutable receipts; v30 failure rolls back both context fragments, then repeated upgrade preserves every prior table');

  const v30Worker=frozenMigration('a773698'),v30=bootstrap('v30.sqlite');
  v30Worker.applyOrchestrationSchemaMigrations(v30);addAgent(v30,'agent-a');
  const v30Thread=createThreadedStore(v30).createThread(input());v30.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(v30Thread.id);
  const v30Messages=frozenThreadedModule('a773698','apps/server/src/threaded/messages.ts').createThreadedMessages(v30);
  const v30Input={ownerId:v30Thread.ownerId,threadId:v30Thread.id,clientRequestId:'v30-stable',body:'old canonical request hash',targets:['agent-a']};
  const v30Receipt=v30Messages.acceptUserMessage(v30Input);
  const oldTables=v30.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'sqlite_sequence' ORDER BY name").all().map(r=>r.name);
  const snapshot=()=>Object.fromEntries(oldTables.map(t=>[t,v30.prepare(`SELECT * FROM ${t}${t==='orchestration_schema_migrations'?' WHERE version<=30':''}`).all()]));
  const before31=snapshot();
  v30.exec("CREATE TRIGGER fixture_v31_failure BEFORE INSERT ON orchestration_schema_migrations WHEN NEW.version=31 BEGIN SELECT RAISE(ABORT,'fixture_v31_failure'); END;");
  const schemaBefore31=tables(v30);
  assert.throws(()=>applyOrchestrationSchemaMigrations(v30),/fixture_v31_failure/);
  assert.deepEqual(tables(v30),schemaBefore31);assert.deepEqual(snapshot(),before31);v30.exec('DROP TRIGGER fixture_v31_failure');
  applyOrchestrationSchemaMigrations(v30);applyOrchestrationSchemaMigrations(v30);assert.deepEqual(snapshot(),before31);
  const {createThreadedMessages:currentMessages}=await import('../apps/server/src/threaded/messages.ts');
  assert.deepEqual(currentMessages(v30).acceptUserMessage(v30Input),v30Receipt,'new optional callback lineage must preserve old message request hashes');
  assert.equal(count(v30,'threaded_consultations'),0);assert.equal(count(v30,'threaded_waits'),0);assert.deepEqual(v30.pragma('foreign_key_check'),[]);
  checks.push('actual frozen v30 upgrades to v31 without changing any prior fact or message request hash; callback lineage is additive, DDL failure rolls back and repeated upgrade is stable');

  const v31Worker=frozenMigration('72efefd'),v31=bootstrap('v31.sqlite');
  v31Worker.applyOrchestrationSchemaMigrations(v31);
  const before32=tables(v31),rows31=v31.prepare('SELECT * FROM orchestration_schema_migrations ORDER BY version').all();
  v31.exec("CREATE TRIGGER fixture_v32_failure BEFORE INSERT ON orchestration_schema_migrations WHEN NEW.version=32 BEGIN SELECT RAISE(ABORT,'fixture_v32_failure'); END;");
  const faultSchema=tables(v31);assert.throws(()=>applyOrchestrationSchemaMigrations(v31),/fixture_v32_failure/);assert.deepEqual(tables(v31),faultSchema);
  v31.exec('DROP TRIGGER fixture_v32_failure');applyOrchestrationSchemaMigrations(v31);applyOrchestrationSchemaMigrations(v31);
  assert.deepEqual(v31.prepare('SELECT * FROM orchestration_schema_migrations WHERE version<=31 ORDER BY version').all(),rows31);
  assert.equal(count(v31,'threaded_actions'),0);assert.deepEqual(v31.pragma('foreign_key_check'),[]);
  assert.throws(()=>v31Worker.assertOrchestrationSchemaCompatible(v31),/32.*不受此 worker 支持/);
  checks.push('actual frozen v31 upgrades atomically to v32; injected failure rolls back DDL, repeated upgrade preserves prior descriptors and a v31 worker rejects v32');

  // Run the actual pushed T10/v32 catalog, including its immutable Action fragment.
  const v32Worker=frozenMigration('c944c9d'),v32=bootstrap('v32.sqlite');
  v32Worker.applyOrchestrationSchemaMigrations(v32);addAgent(v32,'agent-a');
  assert.equal(v32.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version,32);
  const v32Thread=createThreadedStore(v32).createThread(input());v32.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(v32Thread.id);
  const v32Messages=frozenThreadedModule('c944c9d','apps/server/src/threaded/messages.ts').createThreadedMessages(v32);
  const v32Input={ownerId:v32Thread.ownerId,threadId:v32Thread.id,clientRequestId:'v32-stable',body:'Preserve canonical Action and task facts',targets:['agent-a']};
  const v32Receipt=v32Messages.acceptUserMessage(v32Input);
  const v32Budget=frozenThreadedModule('c944c9d','apps/server/src/threaded/budget.ts').createThreadedBudget(v32,{});
  const v32Root=v32Budget.ensureRootForMessage(v32Receipt.message.id);
  const v32Queue=frozenThreadedModule('c944c9d','apps/server/src/threaded/queue.ts').createThreadedQueue(v32,{budget:v32Budget});
  const v32Queued=v32Queue.enqueueWake(v32Receipt.wakes[0].id);
  // Nonempty domain rows ensure v33 does not rewrite an old canonical subject, frozen criteria or holder.
  const criteria=['Keep frozen acceptance'],criteriaHash=createHash('sha256').update(JSON.stringify(criteria)).digest('hex');
  v32.prepare(`INSERT INTO tasks(id,title,status,created_by,assignee,acceptance_criteria,created_at,updated_at)
    VALUES('v32-task','Preserved task','pending','agent-a','agent-a',?,'2026-10-21','2026-10-21')`).run(JSON.stringify(criteria));
  v32.prepare('INSERT INTO threaded_task_ownership VALUES(?,?,?,\'agent-a\',1,?,?)')
    .run('v32-task',v32Thread.ownerId,v32Thread.id,criteriaHash,JSON.stringify({sourceRefs:[v32Receipt.message.id]}));
  v32.prepare("INSERT INTO threaded_actions VALUES('v32-action',?,?,'task:v32-task','work','primary',1,1,'active',?,1,1)")
    .run(v32Thread.ownerId,v32Thread.id,v32Root.id);
  v32.prepare("INSERT INTO threaded_action_generations VALUES('v32-action',1,?,1)").run(JSON.stringify({
    subject:{kind:'task',taskId:'v32-task'},predicate:'task_done',criteriaHash,holders:['agent-a'],scope:{sourceRefs:[v32Receipt.message.id]},
  }));
  v32.prepare("INSERT INTO threaded_action_holders VALUES('v32-action',1,'agent-a',NULL,NULL)").run();
  v32.prepare("INSERT INTO threaded_actions VALUES('v32-pr-action',?,?,'github:zts212653/clowder-ai#1','review','review',1,1,'active',?,1,1)")
    .run(v32Thread.ownerId,v32Thread.id,v32Root.id);
  const v32Tables=v32.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name<>'sqlite_sequence' ORDER BY name").all().map(r=>r.name);
  const snapshot32=()=>Object.fromEntries(v32Tables.map(t=>[t,v32.prepare(`SELECT * FROM ${t}${t==='orchestration_schema_migrations'?' WHERE version<=32':''}`).all()]));
  const rowsBefore33=snapshot32();
  v32.exec("CREATE TRIGGER fixture_v33_failure BEFORE INSERT ON orchestration_schema_migrations WHEN NEW.version=33 BEGIN SELECT RAISE(ABORT,'fixture_v33_failure'); END;");
  const schemaBefore33=tables(v32);
  assert.throws(()=>applyOrchestrationSchemaMigrations(v32),/fixture_v33_failure/);
  assert.deepEqual(tables(v32),schemaBefore33);assert.deepEqual(snapshot32(),rowsBefore33);
  for(const t of ['threaded_review_legacy_admissions','threaded_review_workflows','threaded_sops','threaded_knowledge'])assert.equal(v32.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(t).n,0);
  v32.exec('DROP TRIGGER fixture_v33_failure');applyOrchestrationSchemaMigrations(v32);applyOrchestrationSchemaMigrations(v32);
  assert.deepEqual(snapshot32(),rowsBefore33);assert.deepEqual(v32Messages.acceptUserMessage(v32Input),v32Receipt);
  assert.deepEqual(v32Queue.enqueueWake(v32Receipt.wakes[0].id),v32Queued);
  assert.equal(v32.prepare('SELECT MAX(version) version FROM orchestration_schema_migrations').get().version,latestVersion);
  for(const t of ['threaded_review_workflows','threaded_sops','threaded_knowledge'])assert.equal(count(v32,t),0);
  assert.deepEqual(v32.prepare('SELECT * FROM threaded_review_legacy_admissions').all(),[{action_id:'v32-pr-action',generation:1}]);
  v32.prepare("INSERT INTO threaded_actions VALUES('v33-pr-action',?,?,'github:zts212653/clowder-ai#2','review','review',1,1,'active',?,1,1)")
    .run(v32Thread.ownerId,v32Thread.id,v32Root.id);
  applyOrchestrationSchemaMigrations(v32);
  assert.deepEqual(v32.prepare('SELECT * FROM threaded_review_legacy_admissions').all(),[{action_id:'v32-pr-action',generation:1}]);
  assert.throws(()=>v32.exec("UPDATE threaded_review_legacy_admissions SET generation=2"),/IMMUTABLE/);
  assert.throws(()=>v32.exec('DELETE FROM threaded_review_legacy_admissions'),/RETAINED/);
  assert.deepEqual(v32.pragma('foreign_key_check'),[]);
  const upgradedV33Schema=tables(v32),upgradedV33Rows=snapshot32();
  assert.throws(()=>v32Worker.assertOrchestrationSchemaCompatible(v32),/33.*不受此 worker 支持/);
  assert.throws(()=>v32Worker.applyOrchestrationSchemaMigrations(v32),/33.*不受此 worker 支持/);
  assert.deepEqual(tables(v32),upgradedV33Schema);assert.deepEqual(snapshot32(),upgradedV33Rows);
  checks.push('actual frozen pushed v32/c944c9d upgrades to v33; DDL failure rolls back all Review/SOP/Knowledge fragments and registration, repeated upgrade preserves every prior table including task/Action/budget/queue, pre-v33 review compatibility admissions freeze once and never adopt new Actions on reopen, and the v32 worker rejects v33 without mutation');

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

  legacy.prepare('UPDATE threaded_attempts SET claim_id=?,claim_owner=?,fencing_token=? WHERE id=?')
    .run('claim-1','fixture-owner','token-1','attempt-2');
  legacy.prepare(`INSERT INTO threaded_execution_bindings
    (id,attempt_id,invocation_id,thread_id,owner_id,agent_id,run_id,authority_epoch,thread_authority_epoch,
     claim_id,claim_owner,generation,fencing_token,member_version,role_version,permission_version,agent_version,agent_definition_hash,created_at)
    VALUES('binding-1','attempt-2','inv-1',?,?,'agent-a','run-1',1,1,'claim-1','fixture-owner',1,'token-1',1,1,1,1,'fixture-hash','2026-10-19')`)
    .run(thread.id,thread.ownerId);
  assert.throws(() => legacy.exec("UPDATE threaded_execution_bindings SET generation=2 WHERE id='binding-1'"), /IMMUTABLE/);
  assert.throws(() => legacy.exec("DELETE FROM threaded_execution_bindings WHERE id='binding-1'"), /IMMUTABLE/);
  assert.throws(() => legacy.exec("UPDATE threaded_attempts SET fencing_token='replaced' WHERE id='attempt-2'"), /IMMUTABLE/);
  const output = legacy.prepare(`INSERT INTO threaded_outputs(id,thread_id,owner_id,invocation_id,attempt_id,binding_id,content_hash,content,created_at)
    VALUES(?,?,?,?,'attempt-2','binding-1',?,'fixture output','2026-10-19')`);
  const digest = createHash('sha256').update('fixture output').digest('hex');
  assert.throws(() => output.run('wrong-output',thread.id,thread.ownerId,'inv-2',digest), /FOREIGN KEY/);
  output.run('output-1',thread.id,thread.ownerId,'inv-1',digest);
  assert.throws(() => legacy.exec("UPDATE threaded_outputs SET content='changed' WHERE id='output-1'"), /IMMUTABLE/);
  const approval = legacy.prepare(`INSERT INTO threaded_approvals(id,thread_id,owner_id,invocation_id,attempt_id,binding_id,request_key,created_at,updated_at)
    VALUES('approval-1',?,?,?,'attempt-2','binding-1','approval-request','2026-10-19','2026-10-19')`);
  assert.throws(() => approval.run(thread.id,thread.ownerId,'inv-2'), /FOREIGN KEY/);
  approval.run(thread.id,thread.ownerId,'inv-1');
  assert.throws(() => legacy.exec("UPDATE threaded_approvals SET invocation_id='inv-2' WHERE id='approval-1'"), /IMMUTABLE/);
  const terminal = legacy.prepare(`INSERT INTO threaded_invocation_terminals
    (invocation_id,thread_id,owner_id,run_id,attempt_id,binding_id,output_id,status,proof,committed_at)
    VALUES('inv-1',?,?,'run-1','attempt-2','binding-1',?,'completed','{}','2026-10-19')`);
  assert.throws(() => terminal.run(thread.id,thread.ownerId,null), /CHECK/);
  assert.throws(() => terminal.run(thread.id,thread.ownerId,'missing-output'), /FOREIGN KEY/);
  terminal.run(thread.id,thread.ownerId,'output-1');
  assert.throws(() => legacy.exec("DELETE FROM threaded_invocation_terminals WHERE invocation_id='inv-1'"), /IMMUTABLE/);
  assert.deepEqual(legacy.pragma('foreign_key_check'),[]);
  checks.push('v26 binding/fence immutability and scope FKs protect approvals, immutable outputs and terminal proof identity');

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
  future.prepare('INSERT INTO orchestration_schema_migrations VALUES(?,?,?,?)').run(31,'future','unknown','2026-10-19');
  const futureBefore = tables(future);
  assert.throws(() => applyOrchestrationSchemaMigrations(future), /31.*不受此 worker 支持/);
  assert.deepEqual(tables(future), futureBefore);
  future.exec('DELETE FROM orchestration_schema_migrations WHERE version=31');
  future.exec("UPDATE orchestration_schema_migrations SET checksum='changed' WHERE version=24");
  assert.throws(() => applyOrchestrationSchemaMigrations(future), /24.*不受此 worker 支持/);
  checks.push('future version and mutated historical checksum rejected before mutation');

  // Execute the real frozen v24 compatibility guard, not a newly written imitation.
  const oldWorker = frozenMigration('0a2f1b4d26a263da64b4c950bcb1e3589b0ed64c');
  const upgradedBefore = tables(legacy);
  assert.throws(() => oldWorker.assertOrchestrationSchemaCompatible(legacy), /25.*不受此 worker 支持/);
  assert.throws(() => v25Worker.assertOrchestrationSchemaCompatible(legacy), /26.*不受此 worker 支持/);
  assert.throws(() => v26Worker.assertOrchestrationSchemaCompatible(legacy), /27.*不受此 worker 支持/);
  assert.throws(() => v27Worker.assertOrchestrationSchemaCompatible(legacy), /28.*不受此 worker 支持/);
  assert.throws(() => v28Worker.assertOrchestrationSchemaCompatible(legacy), /29.*不受此 worker 支持/);
  assert.throws(() => v29Worker.assertOrchestrationSchemaCompatible(legacy), /30.*不受此 worker 支持/);
  assert.throws(() => v30Worker.assertOrchestrationSchemaCompatible(legacy), /31.*不受此 worker 支持/);
  assert.deepEqual(tables(legacy), upgradedBefore);
  checks.push('actual frozen v24/v25/v26/v27/v28/v29/v30 worker compatibility guards refuse v25/v26/v27/v28/v29/v30/v31 without mutation');

  console.log(JSON.stringify({ status:'passed', scope:'T02-T11/DB03 isolated SQLite migration; no model execution',groups:checks.length,checks },null,2));
} finally {
  for (const db of databases) if (db.open) db.close();
  await rm(root, { recursive:true,force:true });
}
