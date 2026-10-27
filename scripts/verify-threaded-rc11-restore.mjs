import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

// This is a disposable restore rehearsal, never a production restore command.
// No configured database, .env, user credential, provider, or native process is read.
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-rc11-restore-'));
const repo = path.resolve(new URL('..', import.meta.url).pathname);
const evidenceFile = process.env.THREADED_RC11_RESTORE_REPORT
  ? path.resolve(process.env.THREADED_RC11_RESTORE_REPORT)
  : path.join(repo, 'docs/reports/evidence/threaded-rc11/restore.json');
const live = path.join(root, 'isolated-original-path');
const database = path.join(live, 'database.sqlite');
const privateDir = path.join(live, 'private');
const roles = path.join(live, 'roles');
const nativeDir = path.join(live, 'threaded-native');
const workspace = path.join(live, 'workspace');
const artifactDir = path.join(live, 'artifacts');
const deploy = path.join(live, 'deployment');
const bundles = path.join(root, 'bundles');
await mkdir(bundles, { mode: 0o700 });
for (const dir of [privateDir, roles, nativeDir, workspace, artifactDir, deploy]) await mkdir(dir, { recursive: true, mode: 0o700 });
Object.assign(process.env, {
  AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: roles,
  ACCOUNT_MASTER_KEY: '', ACCOUNT_ADMIN_TOKEN: '', THREADED_COLLABORATION_MODE: 'closed',
});
const originalFetch = globalThis.fetch;
let providerRequests = 0;
globalThis.fetch = async () => { providerRequests++; throw new Error('RC11_RESTORE_NETWORK_FORBIDDEN'); };
const { backupAccounts, verifyBackup, auditAccounts } = await import('./accounts-maintenance.mjs');
const current = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedMessages } = await import('../apps/server/src/threaded/messages.ts');
const { createThreadedRelease } = await import('../apps/server/src/threaded/release.ts');
const { createThreadedBudget } = await import('../apps/server/src/threaded/budget.ts');
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
const oldRevision = execFileSync('git', ['rev-parse', 'a871910'], { cwd: repo, encoding: 'utf8' }).trim();
const stamp = '2026-10-28T00:00:00.000Z';
const options = { dbPath: database, agentsDir: roles,
  accounts: { privateDir, masterKey: '' },
  externalAgents: { codexHome: path.join(live, 'legacy-codex'), claudeHome: path.join(live, 'legacy-claude') } };
const checks = [], details = {};
const connections = [];
const sourceHashes = [];
const assertInside = file => assert.ok(path.resolve(file).startsWith(root + path.sep), 'Only owned temporary paths may be restored');
function frozenModule(filename, cache = new Map()) {
  if (cache.has(filename)) return cache.get(filename);
  const bytes = execFileSync('git', ['show', `${oldRevision}:${filename}`], { cwd: repo });
  sourceHashes.push({ path: filename, sha256: hash(bytes) });
  const js = ts.transpileModule(bytes.toString(), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; cache.set(filename, module.exports);
  new Function('require', 'module', 'exports', js)(name => {
    if (name === 'node:crypto') return { createHash, randomUUID };
    if (name === '@agent-gand/shared') return {}; // No legacy preference rewrite is invoked by this fixture.
    if (name.startsWith('./')) return frozenModule(path.posix.join(path.posix.dirname(filename), name), cache);
    throw new Error(`Unapproved frozen dependency: ${name}`);
  }, module, module.exports);
  return module.exports;
}
const oldWorker = frozenModule('apps/server/src/db/orchestrationMigrations.ts');
// v35 must append its migration, never rewrite any shipped v25-v34 fragment.
for (const source of sourceHashes.filter(source => !source.path.endsWith('/orchestrationMigrations.ts'))) {
  assert.equal(hash(await readFile(path.join(repo, source.path))), source.sha256, `Historical migration changed: ${source.path}`);
}
details.historicalSourceCompatibility = { revision: oldRevision, unchangedFragmentCount: sourceHashes.length - 1,
  comparedTo: 'Current repository bytes; orchestrationMigrations catalog is excluded because v35 is appended there' };
function open(file = database, readonly = false) {
  assertInside(file);
  const db = new Database(file, { readonly, fileMustExist: readonly }); connections.push(db);
  db.pragma('foreign_keys=ON');
  if (!readonly) { db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0'); }
  return db;
}
function tableRows(db, table) {
  return db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function snapshot(db, tableList) {
  const names = tableList ?? db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  return Object.fromEntries(names.map(name => [name, tableRows(db, name)]));
}
function integrity(db) {
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
}
async function inspectBackupCopy(file) {
  // Even a readonly SQLite connection can create WAL/SHM beside a WAL-mode file.
  // Never open the checksum-protected bundle itself as a SQLite database.
  const copy = path.join(root, `inspection-${randomUUID()}.sqlite`);
  await cp(file, copy); return open(copy, true);
}
function tableDigest(db) { return jsonHash(snapshot(db)); }
async function filesUnder(directory, relative = '') {
  const list = [];
  for (const name of (await readdir(path.join(directory, relative))).sort()) {
    const child = path.join(relative, name), absolute = path.join(directory, child), info = await lstat(absolute);
    assert.ok(!info.isSymbolicLink() && (info.isDirectory() || info.isFile()));
    if (info.isDirectory()) list.push(...await filesUnder(directory, child));
    else { assert.equal(info.nlink, 1); list.push({ path: child, sha256: hash(await readFile(absolute)), bytes: info.size }); }
  }
  return list;
}
async function saveSupplement(bundle) {
  const target = path.join(bundle, 'supplement'); await mkdir(target, { mode: 0o700 });
  for (const [name, source] of [['threaded-native', nativeDir], ['workspace', workspace], ['artifacts', artifactDir], ['deployment', deploy]]) {
    await cp(source, path.join(target, name), { recursive: true });
  }
  const files = await filesUnder(target);
  const record = { format: 'rc11-isolated-matching-supplement-v1', revision,
    scope: 'Synthetic files only; not a deployable source archive or real native session', files };
  await writeFile(path.join(bundle, 'supplement-manifest.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  return record;
}
async function verifySupplement(bundle) {
  const manifest = JSON.parse(await readFile(path.join(bundle, 'supplement-manifest.json')));
  assert.equal(manifest.format, 'rc11-isolated-matching-supplement-v1'); assert.equal(manifest.revision, revision);
  assert.deepEqual(await filesUnder(path.join(bundle, 'supplement')), manifest.files);
  return manifest;
}
async function takeBundle(name, db) {
  const bundle = path.join(bundles, name); await mkdir(bundle, { mode: 0o700 });
  const accountBundle = path.join(bundle, 'accounts');
  const before = tableDigest(db);
  assert.equal((await backupAccounts(accountBundle, options)).ok, true);
  assert.equal((await verifyBackup(accountBundle)).ok, true);
  assert.equal(tableDigest(db), before, 'backup must not modify source rows');
  const supplement = await saveSupplement(bundle); await verifySupplement(bundle);
  const backed = await inspectBackupCopy(path.join(accountBundle, 'database.sqlite'));
  assert.equal(tableDigest(backed), before); integrity(backed); backed.close();
  return { directory: bundle, databaseDigest: before, supplementDigest: jsonHash(supplement),
    accountManifestDigest: hash(await readFile(path.join(accountBundle, 'manifest.json'))) };
}
async function restoreBundle(bundle) {
  const accountBundle = path.join(bundle.directory, 'accounts');
  await verifyBackup(accountBundle); await verifySupplement(bundle.directory);
  // The restore mapping is explicit and confined to this process-owned temp root.
  // Untrusted manifest.restoreTo strings are deliberately never executed.
  assert.ok(connections.every(db => !db.open), 'close all SQLite handles before restoring');
  for (const file of [database, database + '-wal', database + '-shm']) { assertInside(file); await rm(file, { force: true }); }
  await cp(path.join(accountBundle, 'database.sqlite'), database);
  const mapping = [['private', privateDir], ['roles', roles], ['legacy-codex', options.externalAgents.codexHome], ['legacy-claude', options.externalAgents.claudeHome]];
  for (const [name, destination] of mapping) {
    assertInside(destination); await rm(destination, { recursive: true, force: true });
    await cp(path.join(accountBundle, name), destination, { recursive: true });
  }
  for (const [name, destination] of [['threaded-native', nativeDir], ['workspace', workspace], ['artifacts', artifactDir], ['deployment', deploy]]) {
    assertInside(destination); await rm(destination, { recursive: true, force: true });
    await cp(path.join(bundle.directory, 'supplement', name), destination, { recursive: true });
  }
  // SQLite starts with only the restored database; no newer WAL/SHM is reused.
  for (const suffix of ['-wal', '-shm']) await assert.rejects(stat(database + suffix), { code: 'ENOENT' });
  const restored = open(); integrity(restored); assert.equal(tableDigest(restored), bundle.databaseDigest);
  assert.equal((await auditAccounts(options)).ok, true);
  return restored;
}
function insert(db, table, row) {
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}
function seedUnknown(db, thread, message, tag) {
  // These are synthetic historical rows, not claims that a provider/OS request ran.
  const owner = thread.ownerId, member = 'rc11-member';
  const id = suffix => `${tag}-${suffix}`;
  const budget = createThreadedBudget(db, { authority: {} }); budget.ensureRootForMessage(message.id);
  insert(db, 'threaded_invocations', { id: id('invocation'), thread_id: thread.id, owner_id: owner, agent_id: member,
    authority_epoch: 1, causal_root_id: message.id, status: 'unknown', created_at: stamp, updated_at: stamp });
  insert(db, 'runs', { id: id('run'), goal: 'Synthetic unresolved restore fixture', mode: 'threaded', conversation_id: thread.conversationId,
    status: 'failed', agent_ids: JSON.stringify([member]), created_at: stamp });
  insert(db, 'run_agent_snapshots', { run_id: id('run'), agent_id: member, version: 1,
    definition: db.prepare('SELECT definition FROM agents WHERE id=?').get(member).definition, created_at: stamp });
  insert(db, 'threaded_attempts', { id: id('attempt'), invocation_id: id('invocation'), thread_id: thread.id, owner_id: owner,
    agent_id: member, attempt_no: 1, generation: 1, authority_epoch: 1, claim_id: id('claim'), claim_owner: 'synthetic-stopped-worker',
    fencing_token: id('fence'), status: 'unknown', created_at: stamp, updated_at: stamp });
  insert(db, 'threaded_run_bindings', { invocation_id: id('invocation'), run_id: id('run'), thread_id: thread.id, owner_id: owner, created_at: stamp });
  insert(db, 'threaded_execution_bindings', { id: id('binding'), attempt_id: id('attempt'), invocation_id: id('invocation'),
    thread_id: thread.id, owner_id: owner, agent_id: member, run_id: id('run'), authority_epoch: 1, thread_authority_epoch: 1,
    claim_id: id('claim'), claim_owner: 'synthetic-stopped-worker', generation: 1, fencing_token: id('fence'), member_version: 1,
    role_version: 1, permission_version: 1, agent_version: 1, agent_definition_hash: 'synthetic-source-hash', created_at: stamp });
  insert(db, 'threaded_budget_invocations', { invocation_id: id('invocation'), root_id: message.id, owner_id: owner,
    thread_id: thread.id, source_message_id: message.id, a2a_depth: 0, policy_version: 1, admitted_at: 1 });
  insert(db, 'threaded_budget_attempts', { attempt_id: id('attempt'), invocation_id: id('invocation'), root_id: message.id,
    owner_id: owner, thread_id: thread.id, attempt_no: 1, reserved_activity_ms: 1000, activity_valid_until: 1001, admitted_at: 1 });
  insert(db, 'threaded_budget_requests', { id: id('authorization'), root_id: message.id, owner_id: owner, thread_id: thread.id,
    invocation_id: id('invocation'), attempt_id: id('attempt'), request_key: id('request-key'), request_hash: 'synthetic-request-hash',
    policy_version: 1, claim_id: id('claim'), generation: 1, fencing_token: id('fence'), claim_owner: 'synthetic-stopped-worker',
    reserved_output: 777, reserved_cost: 12345, execution_state: 'unknown', usage_state: 'unknown', created_at: 1, started_at: 2 });
  insert(db, 'threaded_backend_requests', { id: id('backend-request'), binding_id: id('binding'), authorization_id: id('authorization'),
    owner_id: owner, thread_id: thread.id, invocation_id: id('invocation'), attempt_id: id('attempt'), claim_id: id('claim'),
    generation: 1, fencing_token: id('fence'), backend: 'api', request_key: id('request-key'), manifest_id: id('manifest'),
    payload_hash: 'synthetic-payload-hash', request_hash: 'synthetic-request-hash', session_version: 1,
    backend_version: 'threaded-http-v1', model: 'synthetic-model', state: 'unknown', payload_included: 1, created_at: 2 });
  insert(db, 'threaded_actions', { id: id('action'), owner_id: owner, thread_id: thread.id, subject_key: `task:${tag}`,
    family: 'work', slot: 'primary', version: 1, generation: 1, state: 'active', root_id: message.id, created_at: 1, updated_at: 1 });
  insert(db, 'threaded_action_generations', { action_id: id('action'), generation: 1,
    record: JSON.stringify({ fixtureOnly: true, disposition: 'preserve unresolved responsibility; never replay' }), created_at: 1 });
  const usage = budget.getUsage(message.id);
  assert.equal(usage.unknownRequests, 1); assert.equal(usage.outputTokens, 777); assert.equal(usage.costMicrousd, 12345);
  return { rootId: message.id, authorizationId: id('authorization'), backendRequestId: id('backend-request'),
    actionId: id('action'), unknownRequests: usage.unknownRequests, retainedOutputTokens: usage.outputTokens, retainedCostMicrousd: usage.costMicrousd };
}

let db;
try {
  db = open(); db.exec(await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8'));
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER'); oldWorker.applyOrchestrationSchemaMigrations(db);
  assert.equal(db.prepare('SELECT MAX(version) n FROM orchestration_schema_migrations').get().n, 34);
  const definition = { id: 'rc11-member', name: 'RC11 synthetic', model: 'mock:rc11', tools: [], permissionMode: 'readonly' };
  insert(db, 'agents', { id: definition.id, name: definition.name, definition: JSON.stringify(definition), source: 'rc11-synthetic', created_at: stamp, updated_at: stamp });
  const key = randomBytes(32), keyId = hash(key).slice(0, 32), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(['agent-gand-account-v1', 'rc11-synthetic-account', 1, keyId])));
  const ciphertext = Buffer.concat([cipher.update('rc11-not-a-provider-credential'), cipher.final()]);
  await writeFile(path.join(privateDir, 'account-master-key.json'), JSON.stringify({ version: 1, key: key.toString('hex') }), { mode: 0o600 });
  insert(db, 'accounts', { id: 'rc11-synthetic-account', display_name: 'RC11 synthetic only', provider: 'anthropic', auth_type: 'api_key',
    source: 'rc11-synthetic', version: 1, config_version: 1, credential_version: 1, created_at: stamp, updated_at: stamp });
  insert(db, 'account_versions', { account_id: 'rc11-synthetic-account', version: 1, connection: '{"baseUrl":"https://fixture.invalid"}', created_at: stamp });
  insert(db, 'account_credentials', { account_id: 'rc11-synthetic-account', version: 1, key_id: keyId, ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), suffix: 'fixture', created_at: stamp });
  const identityDir = path.join(privateDir, 'native-identity-1'); await mkdir(identityDir, { mode: 0o700 });
  await writeFile(path.join(identityDir, 'synthetic-identity.txt'), 'Synthetic identity marker; never usable for login.\n', { mode: 0o600 });
  insert(db, 'account_native_identities', { account_id: 'rc11-synthetic-account', generation: 1, client: 'claude', directory: identityDir,
    status: 'authenticated', created_at: stamp, updated_at: stamp });
  for (const dir of [options.externalAgents.codexHome, options.externalAgents.claudeHome]) {
    await mkdir(dir, { mode: 0o700 }); await writeFile(path.join(dir, 'synthetic.txt'), 'Dedicated synthetic native directory', { mode: 0o600 });
  }
  await writeFile(path.join(roles, 'rc11-member.md'), '# RC11 synthetic role\n', { mode: 0o600 });
  await writeFile(path.join(nativeDir, 'synthetic-session.json'), JSON.stringify({ sessionId: 'rc11-synthetic-session', boundary: 'synthetic-restoration-only' }), { mode: 0o600 });
  await writeFile(path.join(workspace, 'source.txt'), 'original synthetic project\n', { mode: 0o600 });
  await writeFile(path.join(artifactDir, 'result.txt'), 'original synthetic artifact\n', { mode: 0o600 });
  await writeFile(path.join(deploy, 'application.json'), JSON.stringify({ revision, schema: 35, mode: 'closed', sourceHashes }), { mode: 0o600 });
  const members = [{ agentId: definition.id, backend: 'api', backendVersion: 'threaded-http-v1', model: 'mock:rc11', roleVersion: 1, permissionVersion: 1 }];
  await writeFile(path.join(deploy, 'release-pack.json'), JSON.stringify({ fixtureOnly: true, members }), { mode: 0o600 });
  const store = createThreadedStore(db), ownerId = store.getInstanceOwnerId();
  const thread = store.createThread({ title: 'RC11 synthetic restored Thread', members: [{ agentId: definition.id, handle: definition.id, roleVersion: 1, permissionVersion: 1 }] });
  const messages = createThreadedMessages(db), release = createThreadedRelease(db, { mode: () => 'execute', members: () => members });
  release.change({ ownerId, expectedVersion: 0, requestId: 'rc11-open-fixture', admissionOpen: true, dispatchOpen: false, reason: 'synthetic backup fixture; no executor attached' });
  release.grantThread({ ownerId, threadId: thread.id, requestId: 'rc11-fixture-grant' });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const ingress = body => db.transaction(() => {
    const accepted = messages.acceptUserMessageWithinTransaction({ ownerId, threadId: thread.id, clientRequestId: randomUUID(), body, targets: [] });
    release.recordRootWithin(ownerId, thread.id, accepted.message.id); return accepted.message;
  }).immediate();
  const rootMessage = ingress('Original pre-migration unresolved responsibility');
  details.originalUnknown = seedUnknown(db, thread, rootMessage, 'pre-upgrade');
  insert(db, 'conversations', { id: 'rc11-legacy-room', title: 'Preserved legacy', mode: 'collaboration', agent_ids: '["rc11-member"]', created_at: stamp, updated_at: stamp });
  insert(db, 'runs', { id: 'rc11-legacy-run', goal: 'Old mode retained', mode: 'collaboration', conversation_id: 'rc11-legacy-room', status: 'completed', agent_ids: '["rc11-member"]', created_at: stamp });
  insert(db, 'run_agent_snapshots', { run_id: 'rc11-legacy-run', agent_id: definition.id, version: 1, definition: JSON.stringify(definition), created_at: stamp });
  insert(db, 'messages', { id: 'rc11-legacy-message', run_id: 'rc11-legacy-run', conversation_id: 'rc11-legacy-room', from_agent: definition.id,
    to_agent: 'all', kind: 'agent', body: '旧模式历史正文逐字保留', created_at: stamp });
  for (let i = 0; i < 5; i++) ingress(`WAL committed synthetic message ${i} ${'x'.repeat(4096)}`);
  release.change({ ownerId, expectedVersion: 1, requestId: 'rc11-close-fixture', admissionOpen: false, dispatchOpen: false, reason: 'preserve paused unresolved work before backup' });
  integrity(db); assert.equal((await auditAccounts(options)).ok, true);
  const originalSnapshot = snapshot(db), historicalRows = db.prepare('SELECT * FROM orchestration_schema_migrations WHERE version BETWEEN 25 AND 34 ORDER BY version').all();
  details.original = { schema: 34, digest: jsonHash(originalSnapshot), tableCount: Object.keys(originalSnapshot).length,
    migration25To34Digest: jsonHash(historicalRows), walBytes: (await stat(database + '-wal')).size };
  assert.ok(details.original.walBytes > 0);
  checks.push({ id: 'RC11-RESTORE-01', result: 'passed', summary: 'Frozen a871910 v34 schema with committed WAL, real grant/root/ingress, synthetic encrypted account/identity and explicit unresolved execution/usage/Action rows passes integrity and account audit' });
  const baseline = await takeBundle('v34-baseline', db); details.baselineBundle = { ...baseline, directory: 'temporary/v34-baseline' };
  const manifest = JSON.parse(await readFile(path.join(baseline.directory, 'accounts/manifest.json')));
  assert.equal(manifest.application.gitHead, revision); assert.equal(manifest.externalMasterKeyRequired, false);
  assert.ok(manifest.files.some(f => f.path === 'private/account-master-key.json'));
  checks.push({ id: 'RC11-RESTORE-02', result: 'passed', summary: 'Production backupAccounts SQLite backup API includes committed WAL and checksums matching synthetic account key/private identity/roles; separately verified native Session, workspace, artifacts and deployment metadata' });
  const tampered = path.join(bundles, 'tampered'); await cp(path.join(baseline.directory, 'accounts'), tampered, { recursive: true });
  await writeFile(path.join(tampered, 'roles/rc11-member.md'), 'corrupted backup', { mode: 0o600 });
  await assert.rejects(verifyBackup(tampered), /不匹配/);
  await writeFile(path.join(privateDir, 'account-master-key.json'), JSON.stringify({ version: 1, key: randomBytes(32).toString('hex') }), { mode: 0o600 });
  assert.ok((await auditAccounts(options)).issues.some(i => i.code === 'CREDENTIAL_LOCKED'));
  db.close(); db = await restoreBundle(baseline);
  assert.deepEqual(snapshot(db), originalSnapshot); assert.equal(await readFile(path.join(workspace, 'source.txt'), 'utf8'), 'original synthetic project\n');
  checks.push({ id: 'RC11-RESTORE-03', result: 'passed', summary: 'Corrupted backup and mismatched synthetic master key rejected; verified whole matching bundle restored at the original isolated absolute paths with no newer WAL/SHM and exact all-table equality' });
  const beforeMigration = tableDigest(db);
  db.exec("CREATE TRIGGER rc11_migration_failure BEFORE INSERT ON orchestration_schema_migrations WHEN NEW.version=35 BEGIN SELECT RAISE(ABORT,'RC11_MIGRATION_FAULT'); END;");
  assert.throws(() => current.applyOrchestrationSchemaMigrations(db), /RC11_MIGRATION_FAULT/);
  assert.equal(tableDigest(db), beforeMigration); assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='threaded_hold_admissions'").get().n, 0);
  db.exec('DROP TRIGGER rc11_migration_failure');
  current.applyOrchestrationSchemaMigrations(db); current.assertOrchestrationSchemaCompatible(db); integrity(db);
  assert.equal(db.prepare('SELECT MAX(version) n FROM orchestration_schema_migrations').get().n, 35);
  assert.deepEqual(db.prepare('SELECT * FROM orchestration_schema_migrations WHERE version BETWEEN 25 AND 34 ORDER BY version').all(), historicalRows);
  for (const [table, rows] of Object.entries(originalSnapshot)) {
    if (table === 'orchestration_schema_migrations') assert.deepEqual(tableRows(db, table).filter(r => r.version <= 34), rows);
    else assert.deepEqual(tableRows(db, table), rows, `Restored ${table} must survive forward migration`);
  }
  const migrated = tableDigest(db); current.applyOrchestrationSchemaMigrations(db); assert.equal(tableDigest(db), migrated);
  details.migration = { from: 34, to: 35, beforeDigest: beforeMigration, afterDigest: migrated, preservedVersions: [25, 34], transactionFaultRolledBack: true };
  checks.push({ id: 'RC11-RESTORE-04', result: 'passed', summary: 'Forward v35 migration on restored v34 bundle preserves all prior rows and v25-v34 migration facts; injected registration failure rolls back, successful retry and repeated migration are stable' });
  const beforeOldWorker = tableDigest(db), schemaBefore = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all();
  const totalBefore = db.prepare('SELECT total_changes() n').get().n;
  assert.throws(() => oldWorker.assertOrchestrationSchemaCompatible(db), /35.*不受此 worker 支持/);
  assert.throws(() => oldWorker.applyOrchestrationSchemaMigrations(db), /35.*不受此 worker 支持/);
  assert.equal(db.prepare('SELECT total_changes() n').get().n, totalBefore); assert.equal(tableDigest(db), beforeOldWorker);
  assert.deepEqual(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').all(), schemaBefore);
  details.oldWorker = { revision: oldRevision, maxSupportedSchema: 34, rejectedSchema: 35, rowDigest: beforeOldWorker, totalChangesDelta: 0, sourceHashes };
  checks.push({ id: 'RC11-RESTORE-05', result: 'passed', summary: 'Actual frozen RC02 v34 compatibility/migration functions reject restored v35 before schema or data mutation; this is the compatibility gate, not an old full service launch' });
  const restoredMessages = createThreadedMessages(db);
  const restoredRelease = createThreadedRelease(db, { mode: () => 'execute', members: () => members });
  // This isolated Owner explicitly admits one new root, then closes admission again.
  // No executor is attached and dispatch remains closed throughout the rehearsal.
  restoredRelease.change({ ownerId, expectedVersion: 2, requestId: 'rc11-open-post-upgrade-fixture', admissionOpen: true,
    dispatchOpen: false, reason: 'admit one synthetic post-upgrade root before preserving its increment' });
  const newMessage = db.transaction(() => {
    const accepted = restoredMessages.acceptUserMessageWithinTransaction({ ownerId, threadId: thread.id,
      clientRequestId: 'rc11-post-upgrade-message', body: 'Post-upgrade data must remain in the separately retained bundle', targets: [] });
    restoredRelease.recordRootWithin(ownerId, thread.id, accepted.message.id); return accepted.message;
  }).immediate();
  details.newUnknown = seedUnknown(db, thread, newMessage, 'post-upgrade');
  restoredRelease.change({ ownerId, expectedVersion: 3, requestId: 'rc11-close-post-upgrade-fixture', admissionOpen: false,
    dispatchOpen: false, reason: 'retain current accepted root without running or replaying unknown work' });
  await writeFile(path.join(workspace, 'source.txt'), 'post-upgrade source change retained separately\n', { mode: 0o600 });
  await writeFile(path.join(artifactDir, 'new-result.txt'), 'post-upgrade artifact retained separately\n', { mode: 0o600 });
  integrity(db);
  const latest = await takeBundle('v35-preserved-increment', db); details.currentBundle = { ...latest, directory: 'temporary/v35-preserved-increment' };
  const newSnapshot = snapshot(db); db.close();
  db = await restoreBundle(baseline); assert.equal(tableDigest(db), baseline.databaseDigest); db.close();
  const retained = await inspectBackupCopy(path.join(latest.directory, 'accounts/database.sqlite'));
  assert.deepEqual(snapshot(retained), newSnapshot); assert.equal(retained.prepare("SELECT COUNT(*) n FROM threaded_budget_requests WHERE usage_state='unknown'").get().n, 2);
  retained.close();
  assert.equal(await readFile(path.join(latest.directory, 'supplement/workspace/source.txt'), 'utf8'), 'post-upgrade source change retained separately\n');
  assert.equal(await readFile(path.join(latest.directory, 'supplement/artifacts/new-result.txt'), 'utf8'), 'post-upgrade artifact retained separately\n');
  checks.push({ id: 'RC11-RESTORE-06', result: 'passed', summary: 'Historical whole-bundle restore only after independently preserving post-upgrade v35 database/unknowns/workspace/artifacts; new rows are retained in their matching bundle, not falsely merged into the historical snapshot' });
  db = await restoreBundle(latest); current.assertOrchestrationSchemaCompatible(db);
  const beforeReopen = tableDigest(db); current.applyOrchestrationSchemaMigrations(db); assert.equal(tableDigest(db), beforeReopen);
  const finalUnknown = db.prepare("SELECT id,root_id,execution_state,usage_state,reserved_output,reserved_cost,known_output,known_cost FROM threaded_budget_requests ORDER BY id").all();
  assert.equal(finalUnknown.length, 2); for (const row of finalUnknown) {
    assert.equal(row.execution_state, 'unknown'); assert.equal(row.usage_state, 'unknown');
    assert.equal(row.reserved_output, 777); assert.equal(row.reserved_cost, 12345); assert.equal(row.known_output, null); assert.equal(row.known_cost, null);
  }
  assert.equal(db.prepare('SELECT admission_open FROM threaded_release_controls').get().admission_open, 0);
  assert.equal(db.prepare('SELECT dispatch_open FROM threaded_release_controls').get().dispatch_open, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM threaded_actions WHERE state='active'").get().n, 2);
  assert.equal(providerRequests, 0); details.finalUnknown = finalUnknown;
  details.final = { schema: 35, digest: tableDigest(db), quickCheck: 'ok', foreignKeyViolations: 0, admissionOpen: false, dispatchOpen: false,
    unresolvedRequestCount: 2, unknownOutputReserve: 1554, unknownCostReserveMicrousd: 24690 };
  checks.push({ id: 'RC11-RESTORE-07', result: 'passed', summary: 'Matching current v35 bundle reopens with exact current data, both generations of unknown usage and Action responsibility retained, admission/dispatch closed, zero provider requests and no executor attached' });
} finally {
  for (const connection of connections) if (connection.open) connection.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
const report = { schemaVersion: 1, stage: 'RC11', kind: 'isolated-matching-backup-restore-rehearsal', generatedAt: new Date().toISOString(),
  applicationRevision: revision, result: 'passed', checksPassed: checks.length, checks, details,
  isolation: { dailyDatabaseRead: false, dailyDatabaseMigrated: false, configuredCredentialsRead: false, syntheticCredentialOnly: true,
    providerRequests, spawnedNativeProcesses: 0, executorAttached: false, temporaryFilesRemoved: true },
  limitations: ['No target deployment selected or migrated; production RC11 exit remains blocked by RC10 and actual target readiness.',
    'Historical unknowns are synthetic SQL fixture rows; this rehearsal tests preservation, not provider reconciliation or execution recovery.',
    'Supplement copies synthetic native/working files only; it is not proof of real native session resumption or a complete production source/dependency archive.',
    'Historical restore does not undo external effects; post-snapshot increments remain separately retained until an operator resolves them.',
    'The frozen v34 compatibility gate was executed in isolation; no old full service was launched.'] };
await mkdir(path.dirname(evidenceFile), { recursive: true });
await writeFile(evidenceFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ result: report.result, checksPassed: checks.length, providerRequests, evidence: path.relative(repo, evidenceFile) }, null, 2));
