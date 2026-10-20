import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { isolateRuntimeFixture } from './fixtures/threadedRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-context-')));
const originalFetch = globalThis.fetch;
isolateRuntimeFixture(root);
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedRuntime } = await import('../apps/server/src/threaded/runtime.ts');
const { createThreadedContext } = await import('../apps/server/src/threaded/context.ts');
const { createExecutionResourceCoordinator } = await import('../apps/server/src/execution/resources/coordinator.ts');
const { prepareThreadedSession, assertResourceSessionCurrent } = await import('../apps/server/src/execution/resources/sessions.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const fixtures = [], checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const hash = text => createHash('sha256').update(text).digest('hex');

async function fixture(name, backend = 'api') {
  const file = path.join(root, `${name}.sqlite`), db = new Database(file);
  db.pragma('foreign_keys = ON'); db.exec(schema); db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  const clock = Date.now() + 60_000, created = new Date(clock).toISOString();
  for (const id of ['aa', 'bb']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1, model: 'mock:fixture',
      enabled: true, tools: [], permissionMode: 'readonly', systemPrompt: 'Context fixture' }), created, created);
  const store = createThreadedStore(db), thread = store.createThread({ title: name, members: ['aa', 'bb'].map(agentId => ({
    agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
  })) });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const workspace = path.join(root, name); await mkdir(workspace, { recursive: true });
  const resources = createExecutionResourceCoordinator(db, { now: () => clock, ownerNonce: randomUUID(),
    validateRequest: request => assertResourceSessionCurrent(db, request),
    verifyEvidence: (_request, claim, evidence) => evidence.reference === `fixture-exit:${claim.claimId}`,
  });
  const runtime = createThreadedRuntime(db, { resources, now: () => clock, autoStart: false, dispatchEnabled: false,
    repairIntervalMs: 0, prepareResources: ({ queue }) => ({
      session: prepareThreadedSession(db, { ownerId: queue.ownerId, threadId: queue.threadId, agentId: queue.agentId,
        backend, backendVersion: 'fixture-only', model: 'mock:fixture', workspace, informationBoundary: 'thread-members-v1' }),
      workspaces: [{ path: workspace, access: 'read' }], providerKey: 'mock',
      quote: { maxOutputTokens: 10, estimatedCostMicrousd: 10, pricingReference: 'fixture-only' },
    }),
  });
  const options = { authority: runtime.authority, assertExecutable: runtime.queue.assertExecutable,
    now: () => clock, verifyDeliveryEvidence: (_binding, manifest, intent, outcome) =>
      outcome.evidence.reference === `fixture:${intent.id}:${manifest.payloadHash}` };
  const context = createThreadedContext(db, options);
  const user = (values = {}) => runtime.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: randomUUID(), body: name, targets: ['aa'], ...values });
  const claim = () => runtime.queue.claimNext('context-fixture');
  const session = binding => resources.getClaim(binding.claimId).request.session;
  const prepare = (binding, values = {}) => context.prepareManifest(binding, { session: session(binding),
    mode: backend === 'api' ? 'reconstructed' : 'native_incremental',
    budget: { maxInputTokens: 50_000, reservedSystemTokens: 100 }, requestKey: randomUUID(), ...values });
  const outcome = (binding, intent, status = 'delivered', key = randomUUID()) => context.recordDeliveryOutcome(binding,
    { intentId: intent.id, status, evidence: { key, reference: `fixture:${intent.id}:${intent.payloadHash}` } });
  const start = binding => runtime.lifecycle.startAttempt(binding);
  const f = { db, file, runtime, resources, context, options, thread, store, user, claim, prepare, session, start, outcome };
  fixtures.push(f); return f;
}

try {
  {
    const f = await fixture('acl-and-attachments');
    f.user({ body: 'private-bb-secret', visibility: 'private', audience: ['bb'], targets: [] });
    f.user({ body: 'draft-never-context', state: 'draft', targets: [] });
    const publicMessage = f.user({ body: 'public-readable', targets: [] });
    const bytes = Buffer.from([0, 1, 2, 200, 255]);
    const source = f.user({ body: 'private-aa-readable', visibility: 'private', audience: ['aa'],
      attachments: [{ name: 'bytes.bin', mediaType: 'application/octet-stream', contentBase64: bytes.toString('base64') }] });
    const claim = f.claim(), prepared = f.prepare(claim.binding);
    assert.deepEqual(prepared.payload.messages.map(m => m.id), [publicMessage.message.id, source.message.id]);
    assert.ok(!prepared.payload.serialized.includes('private-bb-secret') && !prepared.payload.serialized.includes('draft-never-context'));
    assert.equal(prepared.payload.messages.at(-1).attachments[0].contentBase64, bytes.toString('base64'));
    assert.equal(prepared.payload.messages.at(-1).attachments[0].contentHash, hash(bytes));
    assert.equal(prepared.manifest.payloadHash, hash(prepared.payload.serialized));
    assert.equal(prepared.manifest.estimatedTokens, Buffer.byteLength(prepared.payload.serialized) + 100);
    assert.equal(count(f.db, 'threaded_context_deliveries'), 0);
    checks.push('Published ACL, private audience and draft boundaries filter actual payload; original attachment bytes and base64 overhead are hashed and estimated.');
  }
  {
    const f = await fixture('native-holes', 'claude-sdk');
    const old = f.user({ body: 'old-undelivered-'.repeat(150), targets: [] });
    const source = f.user({ body: 'current-small-source' }), claim = f.claim(); f.start(claim.binding);
    f.context.markSeen(claim.binding, [old.message.id], 'explicit-seen');
    const first = f.prepare(claim.binding, { budget: { maxInputTokens: 700, reservedSystemTokens: 10 } });
    assert.equal(first.manifest.items.find(i => i.messageId === old.message.id).decision, 'deferred_budget');
    assert.deepEqual(first.payload.messages.map(m => m.id), [source.message.id]);
    const intent = f.context.markSending(claim.binding, first.manifest.id, 'first-send');
    f.outcome(claim.binding, intent);
    const cursors = f.context.getCursors(claim.binding);
    assert.equal(cursors.find(c => c.kind === 'delivery').maxSeq, source.message.seq);
    assert.deepEqual(cursors.find(c => c.kind === 'delivery').messageIds, [source.message.id]);
    assert.deepEqual(cursors.find(c => c.kind === 'seen').messageIds, [old.message.id]);
    const second = f.prepare(claim.binding);
    assert.ok(second.payload.messages.some(m => m.id === old.message.id));
    assert.equal(second.manifest.items.find(i => i.messageId === old.message.id).decision, 'included');
    f.outcome(claim.binding, f.context.markSending(claim.binding, second.manifest.id, 'supplement'));
    assert.deepEqual(f.context.getCursors(claim.binding).find(c => c.kind === 'delivery').messageIds, [old.message.id, source.message.id]);
    checks.push('Native incremental delivery supplements a budget hole below a higher delivery cursor; explicit seen never suppresses input injection.');
  }
  {
    const f = await fixture('independent-cursors');
    const source = f.user(), claim = f.claim(); f.start(claim.binding);
    f.context.acknowledgeMentions(claim.binding, [source.message.id], 'mention-only');
    let cursors = f.context.getCursors(claim.binding);
    assert.equal(cursors.find(c => c.kind === 'mention_ack').maxSeq, source.message.seq);
    assert.equal(cursors.find(c => c.kind === 'delivery').maxSeq, 0);
    assert.equal(cursors.find(c => c.kind === 'seen').maxSeq, 0);
    const prepared = f.prepare(claim.binding), intent = f.context.markSending(claim.binding, prepared.manifest.id, 'send');
    f.outcome(claim.binding, intent);
    cursors = f.context.getCursors(claim.binding);
    assert.equal(cursors.find(c => c.kind === 'seen').maxSeq, 0);
    assert.equal(f.db.prepare('SELECT status FROM threaded_invocations WHERE id=?').get(claim.binding.invocationId).status, 'running');
    checks.push('Delivery, seen and mention acknowledgement have independent exact facts and never complete the Invocation or an Action.');
  }
  {
    const f = await fixture('unknown-send');
    f.user(); const claim = f.claim(); f.start(claim.binding);
    const prepared = f.prepare(claim.binding), intent = f.context.markSending(claim.binding, prepared.manifest.id, 'send');
    const deny = createThreadedContext(f.db, { ...f.options, verifyDeliveryEvidence: undefined });
    assert.throws(() => deny.recordDeliveryOutcome(claim.binding, { intentId: intent.id, status: 'delivered',
      evidence: { key: 'invented', reference: 'claimed-delivery' } }), /EVIDENCE_REQUIRED/);
    f.outcome(claim.binding, intent, 'unknown', 'unknown');
    assert.equal(count(f.db, 'threaded_context_deliveries'), 0);
    const other = f.prepare(claim.binding);
    assert.throws(() => f.context.markSending(claim.binding, other.manifest.id, 'blind-retry'), /RECONCILIATION_REQUIRED/);
    f.outcome(claim.binding, intent, 'not_sent', 'verified-not-sent');
    const retry = f.context.markSending(claim.binding, prepared.manifest.id, 'verified-retry');
    f.outcome(claim.binding, retry, 'delivered', 'confirmed');
    const n = count(f.db, 'threaded_context_send_receipts');
    f.outcome(claim.binding, retry, 'delivered', 'confirmed');
    assert.equal(count(f.db, 'threaded_context_send_receipts'), n);
    assert.throws(() => f.outcome(claim.binding, retry, 'unknown', 'confirmed'), /IDEMPOTENCY_CONFLICT/);
    checks.push('Unverified ACK is rejected; unknown sends retain a replay barrier and do not advance delivery; trusted not-sent reconciliation permits one new intent.');
  }
  {
    const f = await fixture('frozen-wave');
    const original = f.user({ targets: ['aa', 'bb'] });
    const a = f.claim(); f.start(a.binding);
    const response = f.runtime.messages.postAgentMessage({ binding: a.binding, toolCallId: 'early-post',
      body: 'same-wave-early-answer', targets: [] });
    const b = f.claim(), prepared = f.prepare(b.binding);
    assert.equal(prepared.manifest.waveId, original.message.waveId);
    assert.equal(prepared.manifest.inputMaxSeq, original.message.seq);
    assert.ok(response.message.seq > prepared.manifest.inputMaxSeq);
    assert.ok(!prepared.payload.serialized.includes('same-wave-early-answer'));
    checks.push('A later-starting member uses the frozen wave inputMaxSeq and cannot absorb an earlier member post from the same wave.');
  }
  {
    const f = await fixture('source-too-large');
    f.user({ body: 'huge-source'.repeat(1000) }); const claim = f.claim(); f.start(claim.binding);
    const prepared = f.prepare(claim.binding, { budget: { maxInputTokens: 500, reservedSystemTokens: 20 } });
    assert.equal(prepared.manifest.state, 'blocked');
    assert.equal(prepared.manifest.reason, 'THREADED_CONTEXT_SOURCE_OVER_BUDGET');
    assert.equal(prepared.payload.messages.length, 0);
    assert.throws(() => f.context.markSending(claim.binding, prepared.manifest.id, 'cannot-send'), /SOURCE_OVER_BUDGET/);
    assert.equal(count(f.db, 'threaded_context_send_intents'), 0);
    assert.equal(count(f.db, 'threaded_context_cursor_facts'), 0);
    checks.push('An oversized Wake source is explicitly blocked without truncation, send intent or exposure facts.');
  }
  {
    const f = await fixture('cursor-write-fault');
    f.user(); const claim = f.claim(); f.start(claim.binding);
    const prepared = f.prepare(claim.binding), intent = f.context.markSending(claim.binding, prepared.manifest.id, 'send');
    f.db.exec("CREATE TRIGGER fixture_cursor_failure BEFORE INSERT ON threaded_context_cursors BEGIN SELECT RAISE(ABORT,'fixture_cursor_failure'); END");
    assert.throws(() => f.outcome(claim.binding, intent, 'delivered', 'receipt'), /fixture_cursor_failure/);
    for (const table of ['threaded_context_send_receipts', 'threaded_context_deliveries', 'threaded_context_cursor_facts']) assert.equal(count(f.db, table), 0);
    assert.equal(f.db.prepare('SELECT status FROM threaded_context_send_intents WHERE id=?').get(intent.id).status, 'sending');
    f.db.exec('DROP TRIGGER fixture_cursor_failure');
    f.outcome(claim.binding, intent, 'delivered', 'receipt');
    assert.equal(count(f.db, 'threaded_context_send_receipts'), 1);
    assert.throws(() => f.db.prepare('UPDATE threaded_context_manifest_items SET decision=?').run('included'), /IMMUTABLE/);
    checks.push('A cursor write fault rolls back receipt, per-message delivery and cursor facts atomically; immutable manifests cannot be rewritten.');
  }
  {
    const f = await fixture('revocation-after-send');
    f.user(); const claim = f.claim(); f.start(claim.binding);
    const prepared = f.prepare(claim.binding), intent = f.context.markSending(claim.binding, prepared.manifest.id, 'send');
    f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
    assert.throws(() => f.context.assertManifestCurrent(claim.binding, prepared.manifest.id));
    f.outcome(claim.binding, intent);
    assert.equal(count(f.db, 'threaded_context_deliveries'), 1);
    assert.throws(() => f.context.markSending(claim.binding, prepared.manifest.id, 'after-revoke'));
    checks.push('Late verified transport evidence preserves historical exposure after revocation but cannot authorize another input or execution.');
  }
  {
    const f = await fixture('source-acl-change');
    const ancestor = f.user({ targets: [] });
    const other = f.store.createThread({ title: 'Destination', members: ['aa', 'bb'].map(agentId => ({
      agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
    })) });
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(other.id);
    f.user({ threadId: other.id, sourceRefs: [ancestor.message.id] });
    const claim = f.claim(); f.start(claim.binding); const prepared = f.prepare(claim.binding);
    f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
    assert.throws(() => f.context.markSending(claim.binding, prepared.manifest.id, 'stale-source'), /SOURCE_AUTHORITY_CHANGED/);
    assert.equal(count(f.db, 'threaded_context_send_intents'), 0);
    checks.push('The send boundary rechecks recursive cross-Thread source ACL even when the destination Binding itself remains valid.');
  }
  {
    const f = await fixture('reconstructed-history');
    const old = f.user({ targets: [] }); f.user();
    const claim = f.claim(); f.start(claim.binding);
    const first = f.prepare(claim.binding);
    f.outcome(claim.binding, f.context.markSending(claim.binding, first.manifest.id, 'send'));
    f.context.markSeen(claim.binding, [old.message.id], 'seen');
    const next = f.prepare(claim.binding);
    assert.deepEqual(next.payload.messages.map(m => m.id), first.payload.messages.map(m => m.id));
    assert.throws(() => f.prepare(claim.binding, { session: { ...f.session(claim.binding), version: 999 } }), /SESSION_MISMATCH/);
    assert.throws(() => f.prepare({ ...claim.binding, agentId: 'bb' }));
    checks.push('API reconstructed context still includes authorized prior delivery and seen history; wrong Session versions and forged member bindings are rejected.');
  }
  {
    const f = await fixture('manifest-idempotency');
    f.user(); const claim = f.claim();
    const original = f.prepare(claim.binding, { requestKey: 'stable' });
    assert.deepEqual(f.prepare(claim.binding, { requestKey: 'stable' }), original);
    assert.throws(() => f.prepare(claim.binding, { requestKey: 'stable', budget: { maxInputTokens: 1000, reservedSystemTokens: 10 } }), /IDEMPOTENCY_CONFLICT/);
    const before = count(f.db, 'threaded_context_manifests');
    assert.throws(() => f.db.transaction(() => { f.prepare(claim.binding); throw Error('fixture_rollback'); })(), /fixture_rollback/);
    assert.equal(count(f.db, 'threaded_context_manifests'), before);
    const ro = new Database(f.file, { readonly: true }); ro.pragma('foreign_keys = ON');
    try {
      const readOnlyContext = createThreadedContext(ro, f.options);
      assert.throws(() => readOnlyContext.prepareManifest(claim.binding, { session: f.session(claim.binding), mode: 'reconstructed',
        budget: { maxInputTokens: 5000, reservedSystemTokens: 100 }, requestKey: 'read-only-write' }), /readonly/i);
    } finally { ro.close(); }
    checks.push('Manifest request identity is exact and immutable; outer rollback and read-only database errors never manufacture committed manifests.');
  }
  {
    const f = await fixture('native-future-memory', 'claude-sdk');
    const older = f.user({ body: 'older blocked source' });
    f.runtime.budget.ensureRootForMessage(older.message.id);
    f.runtime.budget.reviseRoot({ ownerId: f.thread.ownerId, rootId: older.message.id, expectedVersion: 1,
      requestId: randomUUID(), reason: 'Fixture blocked older root', state: 'paused' });
    const younger = f.user({ body: 'future context already exposed' }), active = f.claim();
    assert.equal(active.sourceMessageId, younger.message.id); f.start(active.binding);
    const prepared = f.prepare(active.binding);
    f.outcome(active.binding, f.context.markSending(active.binding, prepared.manifest.id, 'younger-send'));
    const quiescence = f.resources.recordQuiescence(f.runtime.authority.claim(active.binding), {
      reason: 'process_exited', sideEffects: 'reconciled', reference: `fixture-exit:${active.binding.claimId}`,
    });
    f.runtime.lifecycle.recordOutcome(active.binding, { kind: 'failed', reason: 'Fixture finished', retryable: false,
      budgetState: 'unknown', quiescence });
    f.runtime.budget.reviseRoot({ ownerId: f.thread.ownerId, rootId: older.message.id, expectedVersion: 2,
      requestId: randomUUID(), reason: 'Fixture resume older root', state: 'open' });
    const resumed = f.claim(); assert.equal(resumed.sourceMessageId, older.message.id);
    assert.equal(f.session(resumed.binding).version, prepared.manifest.session.version);
    assert.throws(() => f.prepare(resumed.binding), /NATIVE_CUTOFF_REQUIRES_COLD/);
    checks.push('A native Session that already saw a later sequence cannot serve an older resumed Wake merely by filtering the new prompt; cold preparation is required.');
  }
  {
    const f = await fixture('multiple-request-delivery');
    f.user(); const claim = f.claim(); f.start(claim.binding);
    const prepared = f.prepare(claim.binding), intent = f.context.markSending(claim.binding, prepared.manifest.id, 'logical-input');
    f.outcome(claim.binding, intent, 'delivered', 'http-request-one');
    const facts = count(f.db, 'threaded_context_cursor_facts'), exposures = count(f.db, 'threaded_context_deliveries');
    f.outcome(claim.binding, intent, 'delivered', 'http-request-two');
    const late = f.outcome(claim.binding, intent, 'unknown', 'http-request-three');
    assert.equal(late.status, 'delivered');
    assert.equal(count(f.db, 'threaded_context_send_receipts'), 3);
    assert.equal(count(f.db, 'threaded_context_cursor_facts'), facts);
    assert.equal(count(f.db, 'threaded_context_deliveries'), exposures);
    assert.throws(() => f.context.markSending(claim.binding, prepared.manifest.id, 'new-unproved-send'), /RECONCILIATION_REQUIRED/);
    assert.throws(() => f.context.recordDeliveryOutcome(claim.binding, { intentId: intent.id, status: 'delivered',
      evidence: { key: 'untrusted', reference: 'caller-claimed-http-request' } }), /EVIDENCE_REQUIRED/);
    checks.push('Multiple verified transport receipts audit one logical input monotonically: later unknown cannot erase delivery or duplicate message exposure facts.');
  }
  {
    const f = await fixture('terminal-receipt-repair');
    f.user(); const claim = f.claim(); f.start(claim.binding);
    const prepared = f.prepare(claim.binding), intent = f.context.markSending(claim.binding, prepared.manifest.id, 'send');
    const quiescence = f.resources.recordQuiescence(f.runtime.authority.claim(claim.binding), {
      reason: 'process_exited', sideEffects: 'reconciled', reference: `fixture-exit:${claim.binding.claimId}`,
    });
    f.runtime.lifecycle.recordOutcome(claim.binding, { kind: 'failed', retryable: false,
      reason: 'Fixture callback failed after transport', budgetState: 'unknown', quiescence });
    assert.deepEqual(f.context.listPendingSends().map(item => item.id), [intent.id]);
    assert.throws(() => f.context.getPayload(claim.binding, prepared.manifest.id));
    f.outcome(claim.binding, intent, 'delivered', 'late-durable-transport');
    assert.equal(f.context.listPendingSends().length, 0);
    assert.equal(count(f.db, 'threaded_context_deliveries'), 1);
    assert.equal(count(f.db, 'threaded_context_send_intents'), 1);
    assert.equal(f.db.prepare('SELECT status FROM threaded_invocations WHERE id=?').get(claim.binding.invocationId).status, 'failed');
    checks.push('Pending send repair accepts verified historical evidence after terminal resource release without reopening the Invocation or authorizing another send.');
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks,
    scope: 'T07 context contract fixtures only; isolated SQLite, injected trusted evidence, no provider, business database or native transcript' }, null, 2));
} finally {
  for (const f of fixtures) { f.runtime.close(); if (f.db.open) f.db.close(); }
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
