import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { isolateRuntimeFixture, runtimeFixtureNetworkAttempts } from './fixtures/threadedRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc07-context-')));
const originalFetch = globalThis.fetch;
isolateRuntimeFixture(root);
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedRuntime } = await import('../apps/server/src/threaded/runtime.ts');
const { createThreadedContext } = await import('../apps/server/src/threaded/context.ts');
const { createExecutionResourceCoordinator } = await import('../apps/server/src/execution/resources/coordinator.ts');
const { prepareThreadedSession, assertResourceSessionCurrent } = await import('../apps/server/src/execution/resources/sessions.ts');
const { createThreadedBackendEvidence, verifyThreadedBackendDelivery } = await import('../apps/server/src/threaded/backends/evidence.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const fixtures = [], checks = [], workers = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const factIds = db => db.prepare("SELECT DISTINCT message_id FROM threaded_context_cursor_facts WHERE kind='delivery' ORDER BY message_seq").all().map(row => row.message_id);
const check = (id, description, evidence) => checks.push({ id, description, ...evidence });

async function fixture(name, backend = 'claude-sdk') {
  const file = path.join(root, `${name}.sqlite`), db = new Database(file);
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER'); applyOrchestrationSchemaMigrations(db);
  const clock = Date.now() + 60_000, created = new Date(clock).toISOString();
  for (const id of ['aa', 'bb']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1, model: 'mock:fixture',
      enabled: true, tools: [], permissionMode: 'readonly', systemPrompt: 'RC07 isolated context acceptance' }), created, created);
  const store = createThreadedStore(db), thread = store.createThread({ title: name,
    members: ['aa', 'bb'].map(agentId => ({ agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const workspace = path.join(root, name); await mkdir(workspace, { recursive: true });
  const resources = createExecutionResourceCoordinator(db, { now: () => clock, ownerNonce: randomUUID(),
    validateRequest: request => assertResourceSessionCurrent(db, request) });
  const runtime = createThreadedRuntime(db, { resources, now: () => clock, autoStart: false, dispatchEnabled: false,
    repairIntervalMs: 0, prepareResources: ({ queue }) => ({
      session: prepareThreadedSession(db, { ownerId: queue.ownerId, threadId: queue.threadId, agentId: queue.agentId,
        backend, backendVersion: 'fixture-only', model: 'mock:fixture', workspace, informationBoundary: 'thread-members-v1' }),
      workspaces: [{ path: workspace, access: 'read' }], providerKey: 'mock',
      quote: { maxOutputTokens: 10, estimatedCostMicrousd: 10, pricingReference: 'fixture-only' },
    }) });
  const context = createThreadedContext(db, { authority: runtime.authority, assertExecutable: runtime.queue.assertExecutable,
    now: () => clock, verifyDeliveryEvidence: (binding, manifest, _intent, outcome) => verifyThreadedBackendDelivery(db, binding, manifest, outcome) });
  const evidence = createThreadedBackendEvidence(db, { now: () => clock });
  const user = (values = {}) => runtime.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: randomUUID(), body: name, targets: ['aa'], ...values });
  const claim = () => { const value = runtime.queue.claimNext('rc07-context-fixture'); assert.ok(value); runtime.lifecycle.startAttempt(value.binding); return value; };
  const prepare = (binding, budget = 50_000) => context.prepareManifest(binding, {
    session: resources.getClaim(binding.claimId).request.session, mode: backend === 'api' ? 'reconstructed' : 'native_incremental',
    budget: { maxInputTokens: budget, reservedSystemTokens: 100 }, requestKey: randomUUID() });
  const receipt = (claimed, prepared, status = 'delivered', intent) => {
    intent ??= context.markSending(claimed.binding, prepared.manifest.id, `input:${randomUUID()}`);
    const authorization = db.prepare('SELECT id FROM threaded_budget_requests WHERE attempt_id=? ORDER BY rowid LIMIT 1').get(claimed.binding.attemptId);
    const stored = evidence.begin(claimed.binding, { kind: backend, contextManifestId: prepared.manifest.id,
      serializedContext: prepared.payload.serialized, model: 'mock:fixture', session: {
        nativeId: prepared.manifest.session.nativeId, version: prepared.manifest.session.version, backendVersion: 'fixture-only' } },
    authorization.id, `fixture-receipt:${randomUUID()}`, prepared.payload.serialized, true);
    if (status === 'delivered') evidence.complete(stored.id, { delivered: true, inputTokens: 1, outputTokens: 1 });
    else evidence.unknown(stored.id);
    return { intent, outcome: { intentId: intent.id, status, evidence: { key: stored.reference,
      reference: stored.reference, nativeId: prepared.manifest.session.nativeId } }, stored };
  };
  const f = { db, file, runtime, resources, thread, user, claim, prepare, context, receipt };
  fixtures.push(f); return f;
}

async function worker(f, operation, values = {}) {
  const child = fork(new URL('./fixtures/threadedRc07ContextWorker.mjs', import.meta.url), [], {
    env: { PATH: process.env.PATH, RC07_CONTEXT_ROOT: root },
    execArgv: ['--import', new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '', result;
  child.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    await new Promise((resolve, reject) => {
      child.on('message', message => { result = message; });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 && result ? resolve() : reject(new Error(`RC07 context worker ${code}/${signal}: ${stderr}`)));
      child.send({ file: f.file, operation, ...values });
    });
  } finally { clearTimeout(timeout); }
  assert.equal(result.error, undefined); assert.equal(result.networkCalls, 0); assert.deepEqual(result.foreignKeys, []);
  workers.push({ pid: result.pid, operation, exitCode: 0, networkCalls: 0 }); return result;
}

try {
  {
    const f = await fixture('composite-holes');
    const hidden = f.user({ body: 'bb-secret-must-not-expand', visibility: 'private', audience: ['bb'], targets: [] });
    const draft = f.user({ body: 'draft-must-not-expand', state: 'draft', targets: [] });
    const old = f.user({ body: 'deferred-old-source-'.repeat(180), targets: [] });
    const source = f.user({ body: 'small-current-source' }), claimed = f.claim();
    f.context.markSeen(claimed.binding, [old.message.id], 'seen-does-not-deliver');
    f.context.acknowledgeMentions(claimed.binding, [source.message.id], 'ack-does-not-deliver');
    const first = f.prepare(claimed.binding, 1200);
    assert.deepEqual(first.payload.messages.map(value => value.id), [source.message.id]);
    assert.deepEqual(first.manifest.items.map(value => value.decision), ['denied_acl', 'unpublished', 'deferred_budget', 'included']);
    const sent = f.receipt(claimed, first); f.context.recordDeliveryOutcome(claimed.binding, sent.outcome);
    assert.deepEqual(factIds(f.db), [source.message.id]);
    const second = f.prepare(claimed.binding), supplement = second.payload.messages.map(value => value.id);
    assert.deepEqual(supplement, [old.message.id, source.message.id]);
    assert.ok(!second.payload.serialized.includes(hidden.message.body) && !second.payload.serialized.includes(draft.message.body));
    const cursors = f.context.getCursors(claimed.binding);
    assert.deepEqual(cursors.find(value => value.kind === 'seen').messageIds, [old.message.id]);
    assert.deepEqual(cursors.find(value => value.kind === 'mention_ack').messageIds, [source.message.id]);
    check('CTX-RC07-01', 'Composite private/draft/budget holes preserve exact delivery, seen and mention facts; native input supplements an older visible hole below maxSeq.',
      { manifest: first.manifest, supplementManifest: second.manifest, cursors });
  }
  {
    const f = await fixture('utf8-attachment-boundary', 'api');
    const bytes = Buffer.from(Array.from({ length: 257 }, (_, index) => index % 256));
    f.user({ body: '汉字🙂é'.repeat(30), attachments: [{ name: 'bytes.bin', mediaType: 'application/octet-stream', contentBase64: bytes.toString('base64') }] });
    const claimed = f.claim(), large = f.prepare(claimed.binding), exactBytes = Buffer.byteLength(large.payload.serialized);
    const exact = f.prepare(claimed.binding, exactBytes + 100), short = f.prepare(claimed.binding, exactBytes + 99);
    assert.equal(exact.manifest.state, 'ready'); assert.equal(exact.manifest.estimatedTokens, exactBytes + 100);
    assert.equal(exact.payload.messages[0].attachments[0].contentHash, hash(bytes));
    assert.equal(exact.payload.messages[0].attachments[0].contentBase64, bytes.toString('base64'));
    assert.equal(short.manifest.state, 'blocked'); assert.equal(short.manifest.reason, 'THREADED_CONTEXT_SOURCE_OVER_BUDGET');
    assert.deepEqual(short.payload.messages, []); assert.ok(short.manifest.items.every(value => value.truncated === false));
    assert.throws(() => f.context.markSending(claimed.binding, short.manifest.id, 'blocked'), /SOURCE_OVER_BUDGET/);
    assert.equal(count(f.db, 'threaded_context_send_intents'), 0); assert.equal(count(f.db, 'threaded_context_cursor_facts'), 0);
    check('CTX-RC07-02', 'UTF-8 text plus original attachment base64 and JSON framing have an exact byte-estimator boundary; one byte less blocks the entire Wake source without send or cursor.',
      { exactPayloadBytes: exactBytes, exactManifest: exact.manifest, blockedManifest: short.manifest });
  }
  {
    const f = await fixture('api-reconstruction', 'api');
    const old = f.user({ body: 'already-delivered-history', targets: [] }); f.user({ body: 'current-source' });
    const claimed = f.claim(), first = f.prepare(claimed.binding), sent = f.receipt(claimed, first);
    f.context.recordDeliveryOutcome(claimed.binding, sent.outcome); f.context.markSeen(claimed.binding, [old.message.id], 'read');
    const next = f.prepare(claimed.binding);
    assert.deepEqual(next.payload.messages, first.payload.messages); assert.equal(next.manifest.session.nativeId, null);
    assert.equal(next.manifest.mode, 'reconstructed');
    check('CTX-RC07-03', 'API reconstructs the exact authorized input despite previous delivery/seen facts and has no synthetic native identity.',
      { firstManifest: first.manifest, nextManifest: next.manifest });
  }
  {
    const f = await fixture('cross-process-cursor-update-fault', 'api');
    f.user({ body: 'first-in-transaction', targets: [] }); f.user({ body: 'second-fails-cursor-update' });
    const claimed = f.claim(), prepared = f.prepare(claimed.binding), sent = f.receipt(claimed, prepared);
    // First item inserts a cursor; second item enters UPDATE. A failure there
    // must roll back both items, receipt and sending status as one transaction.
    f.db.exec("CREATE TRIGGER rc07_cursor_update_failure BEFORE UPDATE ON threaded_context_cursors BEGIN SELECT RAISE(ABORT,'rc07_cursor_update_failure'); END");
    const failed = await worker(f, 'repair'); assert.equal(failed.result.error, 'SQLITE_CONSTRAINT_TRIGGER');
    assert.match(failed.result.message, /rc07_cursor_update_failure/);
    for (const table of ['threaded_context_send_receipts', 'threaded_context_deliveries', 'threaded_context_cursor_facts', 'threaded_context_cursors']) assert.deepEqual(failed.snapshot[table], []);
    assert.equal(failed.snapshot.threaded_context_send_intents[0].status, 'sending');
    assert.equal(failed.snapshot.threaded_backend_requests[0].state, 'complete');
    f.db.exec('DROP TRIGGER rc07_cursor_update_failure');
    const repaired = await worker(f, 'repair'); assert.equal(repaired.result.contextRepaired, 1);
    assert.deepEqual(factIds(f.db), prepared.payload.messages.map(value => value.id));
    assert.equal(repaired.snapshot.threaded_context_send_receipts.length, 1);
    const replay = await worker(f, 'repair'); assert.equal(replay.result.contextRepaired, 0); assert.deepEqual(replay.snapshot, repaired.snapshot);
    const repeated = await worker(f, 'outcome', { binding: claimed.binding, outcome: sent.outcome });
    assert.deepEqual(repeated.snapshot, replay.snapshot);
    check('CTX-RC07-04', 'Four fresh process connections prove cursor UPDATE failure rolls back all exposure state while preserving the immutable backend receipt; restart repair and exact receipt replay do not duplicate facts.',
      { manifest: prepared.manifest, failed, repaired, replay, repeated });
  }
  {
    const f = await fixture('revoked-late-delivery', 'api'); f.user({ body: 'authorized-at-send' });
    const claimed = f.claim(), prepared = f.prepare(claimed.binding), sent = f.receipt(claimed, prepared);
    f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
    const repaired = await worker(f, 'repair'); assert.equal(repaired.result.contextRepaired, 1);
    assert.deepEqual(factIds(f.db), prepared.payload.messages.map(value => value.id));
    assert.throws(() => f.context.markSending(claimed.binding, prepared.manifest.id, 'revoked-send'));
    assert.throws(() => f.context.prepareManifest(claimed.binding, { session: prepared.manifest.session,
      mode: 'reconstructed', budget: prepared.manifest.budget, requestKey: 'revoked-prepare' }));
    const forged = await worker(f, 'outcome', { binding: { ...claimed.binding, agentId: 'bb' }, outcome: sent.outcome });
    assert.match(forged.result.error, /BINDING_UNAUTHORIZED/); assert.deepEqual(forged.snapshot, repaired.snapshot);
    check('CTX-RC07-05', 'A late trusted transport receipt remains historical exposure after permission revocation; it grants neither another send nor a forged member delivery authority.',
      { manifest: prepared.manifest, repaired, forged });
  }
  {
    const f = await fixture('unknown-stays-unexposed'); f.user({ body: 'uncertain-transport-input' });
    const claimed = f.claim(), prepared = f.prepare(claimed.binding); f.receipt(claimed, prepared, 'unknown');
    const repaired = await worker(f, 'repair'); assert.equal(repaired.result.contextRepaired, 1);
    assert.equal(repaired.snapshot.threaded_context_send_intents[0].status, 'unknown');
    assert.deepEqual(repaired.snapshot.threaded_context_deliveries, []); assert.deepEqual(repaired.snapshot.threaded_context_cursor_facts, []);
    const another = f.prepare(claimed.binding);
    assert.throws(() => f.context.markSending(claimed.binding, another.manifest.id, 'blind-retry'), /RECONCILIATION_REQUIRED/);
    check('CTX-RC07-06', 'Restart recovery preserves unknown transport as a replay barrier with no message exposure or delivery cursor.', { manifest: prepared.manifest, repaired });
  }
  {
    const f = await fixture('later-member-frozen-wave');
    f.user({ body: 'bb-private-before-wave', visibility: 'private', audience: ['bb'], targets: [] });
    const source = f.user({ body: 'independent-wave', targets: ['aa', 'bb'] }), a = f.claim();
    assert.equal(a.binding.agentId, 'aa');
    const answer = f.runtime.messages.postAgentMessage({ binding: a.binding, toolCallId: 'early-response',
      body: 'aa-current-wave-answer-must-not-enter-b', targets: [] });
    const b = f.claim(); assert.equal(b.binding.agentId, 'bb');
    const prepared = f.prepare(b.binding);
    assert.equal(prepared.manifest.inputMaxSeq, source.message.seq); assert.equal(prepared.manifest.waveId, source.message.waveId);
    assert.ok(answer.message.seq > prepared.manifest.inputMaxSeq);
    assert.ok(prepared.payload.serialized.includes('bb-private-before-wave'));
    assert.ok(!prepared.payload.serialized.includes(answer.message.body));
    assert.ok(prepared.manifest.items.every(value => value.seq <= source.message.seq));
    check('CTX-RC07-07', 'A member starting after a same-wave early answer retains the original cutoff while still receiving its own authorized private history.',
      { sourceMessageId: source.message.id, laterAnswerId: answer.message.id, manifest: prepared.manifest });
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(runtimeFixtureNetworkAttempts(), 0);
  const report = { status: 'passed', scope: 'RC07 DB-injected production context and backend recovery; simulated transport receipts, no actual index or supplier',
    groups: checks.length, independentProcessCount: new Set(workers.map(value => value.pid)).size, workers,
    supplierCalls: 0, tokens: 0, dailyDatabaseReads: 0, schemaVersion: 35, checks,
    limitations: ['The parent deliberately writes simulated complete/unknown transport receipts through the production evidence producer.',
      'The process workers use the production evidence verifier and recovery code, but do not run index.ts, a native SDK or a real supplier.',
      'Automatic native compaction, production concurrency and actual supplier behavior require separate acceptance.'] };
  const output = process.env.THREADED_RC07_CONTEXT_OUTPUT;
  if (output) { await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(JSON.stringify({ ...report, checks: checks.map(({ id, description }) => ({ id, description })) }, null, 2));
} finally {
  for (const f of fixtures) { f.runtime.close(); if (f.db.open) f.db.close(); }
  globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
}
