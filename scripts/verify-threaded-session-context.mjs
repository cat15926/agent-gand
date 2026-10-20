import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { isolateRuntimeFixture, runtimeFixtureNetworkAttempts } from './fixtures/threadedRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-session-context-')));
const originalFetch = globalThis.fetch;
isolateRuntimeFixture(root);
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedRuntime } = await import('../apps/server/src/threaded/runtime.ts');
const { createThreadedContext } = await import('../apps/server/src/threaded/context.ts');
const { createThreadedSessionContext } = await import('../apps/server/src/threaded/sessionContext.ts');
const { createExecutionResourceCoordinator } = await import('../apps/server/src/execution/resources/coordinator.ts');
const { assertResourceSessionCurrent } = await import('../apps/server/src/execution/resources/sessions.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const fixtures = [], checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

async function fixture(name, backend = 'claude-sdk', account = false) {
  const file = path.join(root, `${name}.sqlite`), db = new Database(file);
  db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
  db.exec(schema); db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  db.exec(`CREATE TABLE fixture_backend_receipts (
    reference TEXT PRIMARY KEY,binding_id TEXT,manifest_id TEXT,native_id TEXT,terminal_uuid TEXT,boundary TEXT
  )`);
  const clock = Date.now() + 60_000, created = new Date(clock).toISOString();
  if (account) db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at)
    VALUES('fixture-account','Fixture account','mock','api_key','fixture',1,1,1,?,?)`).run(created, created);
  for (const id of ['aa', 'bb']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1, model: 'mock:fixture',
      enabled: true, tools: [], permissionMode: 'readonly', systemPrompt: 'Session fixture',
      ...(account ? { accountRef: 'fixture-account' } : {}) }), created, created);
  const store = createThreadedStore(db), thread = store.createThread({ title: name, members: ['aa', 'bb'].map(agentId => ({
    agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
  })) });
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const workspace = path.join(root, name); await mkdir(workspace, { recursive: true });
  const preparation = { backend, backendVersion: 'fixture-sdk-v1', model: 'mock:fixture', workspace,
    informationBoundary: 'thread-members-v1' };
  const resources = createExecutionResourceCoordinator(db, { now: () => clock, ownerNonce: randomUUID(),
    validateRequest: request => assertResourceSessionCurrent(db, request),
    verifyEvidence: (_request, claim, evidence) => evidence.reference === `fixture-exit:${claim.claimId}`,
  });
  let sessions;
  const decisions = new Map();
  const runtime = createThreadedRuntime(db, { resources, now: () => clock, autoStart: false, dispatchEnabled: false,
    repairIntervalMs: 0, verifyUsage: (binding, _authorization, usage) => usage.evidenceReference === `fixture-usage:${binding.attemptId}`,
    prepareResources: ({ queue, invocationId }) => {
      const decision = sessions.prepare({ ownerId: queue.ownerId, threadId: queue.threadId, agentId: queue.agentId,
        inputMaxSeq: queue.inputMaxSeq, ...preparation });
      decisions.set(invocationId, decision);
      return { session: decision.session, workspaces: [{ path: preparation.workspace, access: 'read' }], providerKey: 'mock',
        ...(account ? { accountId: 'fixture-account' } : {}),
        quote: { maxOutputTokens: 10, estimatedCostMicrousd: 10, pricingReference: 'fixture-only' } };
    },
  });
  const context = createThreadedContext(db, { authority: runtime.authority, assertExecutable: runtime.queue.assertExecutable,
    now: () => clock, verifyDeliveryEvidence: (_binding, manifest, intent, outcome) =>
      outcome.evidence.reference === `fixture-delivered:${intent.id}:${manifest.payloadHash}` });
  const options = { authority: runtime.authority, context, now: () => clock,
    verifyAnchor: (binding, manifest, decision, evidence) => !!db.prepare(`SELECT 1 FROM fixture_backend_receipts
      WHERE reference=? AND binding_id=? AND manifest_id=? AND native_id=? AND terminal_uuid=?`)
      .get(evidence.reference, binding.id, manifest.id, decision.session.nativeId, evidence.terminalRecordUuid),
    verifyCompaction: (binding, manifest, decision, evidence) => !!db.prepare(`SELECT 1 FROM fixture_backend_receipts
      WHERE reference=? AND binding_id=? AND manifest_id=? AND native_id=? AND boundary=?`)
      .get(evidence.reference, binding.id, manifest.id, decision.session.nativeId, evidence.boundary),
  };
  sessions = createThreadedSessionContext(db, options);
  const user = (values = {}) => runtime.messages.acceptUserMessage({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: randomUUID(), body: name, targets: ['aa'], ...values });
  const prepare = (values = {}) => sessions.prepare({ ownerId: thread.ownerId, threadId: thread.id, agentId: 'aa',
    inputMaxSeq: db.prepare('SELECT COALESCE(MAX(seq),0) n FROM threaded_messages WHERE thread_id=?').get(thread.id).n,
    ...preparation, ...values });
  const begin = (values = {}, send = true) => {
    const source = user(values), claim = runtime.queue.claimNext('session-fixture'); assert.ok(claim);
    const binding = claim.binding, decision = decisions.get(binding.invocationId);
    const prepared = context.prepareManifest(binding, { session: decision.session,
      mode: backend === 'api' ? 'reconstructed' : 'native_incremental',
      budget: { maxInputTokens: 50_000, reservedSystemTokens: 100 }, requestKey: randomUUID() });
    runtime.lifecycle.startAttempt(binding);
    const b = { source, claim, binding, decision, prepared };
    if (send) sendInput(b);
    return b;
  };
  const sendInput = b => db.transaction(() => {
    const requestId = `input:${b.binding.attemptId}`;
    b.exposure = sessions.recordInputIntent(b.binding, { manifestId: b.prepared.manifest.id, decision: b.decision, requestId });
    b.sendIntent = context.markSending(b.binding, b.prepared.manifest.id, requestId);
  }).immediate();
  const delivered = b => context.recordDeliveryOutcome(b.binding, { intentId: b.sendIntent.id, status: 'delivered',
    evidence: { key: `delivered:${b.binding.attemptId}`, reference: `fixture-delivered:${b.sendIntent.id}:${b.prepared.manifest.payloadHash}` } });
  const proof = b => b.quiescence ??= resources.recordQuiescence(runtime.authority.claim(b.binding),
    { reason: 'process_exited', sideEffects: 'reconciled', reference: `fixture-exit:${b.binding.claimId}` });
  const anchorInput = (b, overrides = {}) => {
    const evidence = { reference: `fixture-anchor:${b.binding.id}`, nativeId: b.decision.session.nativeId,
      backendVersion: preparation.backendVersion, requestReceiptId: b.sendIntent.id,
      terminalRecordUuid: `terminal:${b.binding.id}`, resumeToken: `resume:${b.binding.id}`, ...overrides };
    db.prepare('INSERT OR REPLACE INTO fixture_backend_receipts VALUES(?,?,?,?,?,NULL)')
      .run(evidence.reference, b.binding.id, b.prepared.manifest.id, b.decision.session.nativeId, `terminal:${b.binding.id}`);
    return { manifestId: b.prepared.manifest.id, decision: b.decision, requestId: `anchor:${b.binding.attemptId}`,
      evidence, quiescence: proof(b) };
  };
  const finish = (b, withAnchor = true, overrides = {}) => {
    delivered(b);
    if (withAnchor) b.anchor = sessions.recordAnchor(b.binding, anchorInput(b, overrides));
    runtime.lifecycle.recordOutcome(b.binding, { kind: 'completed', content: 'fixture response', budgetState: 'settled',
      budgetUsage: { outputTokens: 1, costMicrousd: 1, evidenceReference: `fixture-usage:${b.binding.attemptId}` },
      quiescence: proof(b) });
    return b;
  };
  const f = { db, file, runtime, resources, context, options, sessions, thread, store, preparation,
    user, begin, prepare, sendInput, delivered, proof, anchorInput, finish };
  fixtures.push(f); return f;
}

try {
  {
    const f = await fixture('cold-resume-restart');
    const first = f.begin(); assert.equal(first.decision.mode, 'cold');
    assert.equal(count(f.db, 'threaded_context_deliveries'), 0);
    const input = f.anchorInput(first);
    const denied = createThreadedSessionContext(f.db, { ...f.options, verifyAnchor: undefined });
    assert.throws(() => denied.recordAnchor(first.binding, input), /ANCHOR_UNVERIFIED/);
    // Delivery confirmation is distinct from possible exposure and an anchor.
    f.delivered(first);
    const anchor = f.sessions.recordAnchor(first.binding, input);
    assert.deepEqual(f.sessions.recordAnchor(first.binding, input), anchor);
    f.finish(first, false);
    const reopened = new Database(f.file); reopened.pragma('foreign_keys=ON');
    try {
      const restored = createThreadedSessionContext(reopened, f.options).prepare({
        ownerId: f.thread.ownerId, threadId: f.thread.id, agentId: 'aa', inputMaxSeq: 1000, ...f.preparation,
      });
      assert.equal(restored.mode, 'resume'); assert.equal(restored.anchorId, anchor.id);
      assert.deepEqual(restored.session, first.decision.session);
    } finally { reopened.close(); }
    const second = f.begin();
    assert.notEqual(second.binding.invocationId, first.binding.invocationId);
    assert.deepEqual(second.decision.session, first.decision.session);
    assert.equal(second.decision.mode, 'resume');
    assert.equal(second.prepared.manifest.items.find(i => i.messageId === first.source.message.id).decision, 'already_delivered');
    f.finish(second);
    const savedAnchor = f.db.prepare('SELECT * FROM threaded_session_anchors WHERE id=?').get(anchor.id);
    const columns = Object.keys(savedAnchor).filter(column => column !== 'seq');
    const insert = f.db.prepare(`INSERT INTO threaded_session_anchors(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    const forged = { ...savedAnchor, id: randomUUID(), request_id: 'wrong-binding-anchor', binding_id: second.binding.id };
    assert.throws(() => insert.run(...columns.map(column => forged[column])), /SCOPE_MISMATCH|EVIDENCE_MISMATCH/);
    checks.push('Cold native input requires trusted quiescent terminal evidence; anchor replay and a fresh SQLite connection restore the same native identity across Invocations.');
  }
  {
    const f = await fixture('reconstructed-api', 'api'), b = f.begin();
    assert.equal(b.decision.mode, 'reconstructed'); assert.equal(b.decision.sessionKind, 'reconstructed');
    assert.equal(b.decision.session.nativeId, null); assert.equal(b.decision.session.resourceKey, null);
    assert.throws(() => f.sessions.recordAnchor(b.binding, { ...f.anchorInput(b), evidence: {
      ...f.anchorInput(b).evidence, nativeId: 'invented-native-id' } }), /BACKEND_MISMATCH/);
    f.finish(b, false);
    assert.equal(f.prepare().mode, 'reconstructed');
    checks.push('API Sessions remain reconstructable metadata with no native ID, resume token or SDK anchor capability.');
  }
  {
    const f = await fixture('session-cas'), first = f.prepare({ expectedVersion: 0 });
    assert.deepEqual(f.prepare({ expectedVersion: 1 }).session, first.session);
    const other = new Database(f.file); other.pragma('foreign_keys=ON');
    try {
      const second = createThreadedSessionContext(other, f.options).prepare({
        ownerId: f.thread.ownerId, threadId: f.thread.id, agentId: 'aa', inputMaxSeq: 0,
        ...f.preparation, informationBoundary: 'second-connection-boundary', expectedVersion: 1,
      });
      assert.equal(second.session.version, 2);
      assert.throws(() => f.prepare({ expectedVersion: 1, informationBoundary: 'losing-writer-boundary' }), /CAS_CONFLICT/);
      assert.equal(count(f.db, 'threaded_session_context_versions'), 2);
      assert.equal(count(f.db, 'execution_resource_session_versions'), 2);
      assert.notEqual(first.session.nativeId, second.session.nativeId);
    } finally { other.close(); }
    checks.push('Two SQLite connections enforce Session CAS: a stale writer cannot replace the winning native identity or append an orphan context version.');
  }
  {
    const f = await fixture('policy-identity', 'claude-sdk', true);
    let prior = f.prepare();
    const changed = (mutate, input = {}) => {
      mutate(); const next = f.prepare(input);
      assert.equal(next.mode, 'cold'); assert.equal(next.session.version, prior.session.version + 1);
      assert.notEqual(next.session.nativeId, prior.session.nativeId); prior = next;
    };
    changed(() => { f.preparation.backendVersion = 'fixture-sdk-v2'; });
    changed(() => { f.preparation.model = 'mock:different'; });
    const nextWorkspace = path.join(root, 'different-workspace'); await mkdir(nextWorkspace);
    changed(() => { f.preparation.workspace = nextWorkspace; });
    changed(() => { f.preparation.informationBoundary = 'new-boundary'; });
    for (const column of ['config_version', 'credential_version']) changed(() =>
      f.db.prepare(`UPDATE accounts SET ${column}=${column}+1 WHERE id='fixture-account'`).run());
    const identityDirectory = path.join(root, 'fixture-native-identity'); await mkdir(identityDirectory);
    changed(() => {
      f.db.prepare("UPDATE accounts SET auth_type='native_login',identity_generation=1 WHERE id='fixture-account'").run();
      f.db.prepare(`INSERT INTO account_native_identities(account_id,generation,client,directory,status,created_at,updated_at)
        VALUES('fixture-account',1,'claude-sdk',?,'authenticated','fixture','fixture')`).run(identityDirectory);
    });
    changed(() => {
      f.db.prepare("UPDATE accounts SET identity_generation=2 WHERE id='fixture-account'").run();
      f.db.prepare(`INSERT INTO account_native_identities(account_id,generation,client,directory,status,created_at,updated_at)
        VALUES('fixture-account',2,'claude-sdk',?,'authenticated','fixture','fixture')`).run(identityDirectory);
    });
    changed(() => f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id));
    changed(() => {
      const row = f.db.prepare("SELECT definition FROM agents WHERE id='aa'").get();
      f.db.prepare("UPDATE agents SET version=version+1,definition=? WHERE id='aa'").run(JSON.stringify({ ...JSON.parse(row.definition), tools: ['fixture-tool'] }));
      f.db.prepare("UPDATE threaded_members SET role_version=role_version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
    });
    checks.push('Backend version, model, workspace, information boundary, account config/credential/native identity generation, permission and role/tool changes each create a fresh retained native identity.');
  }
  {
    const f = await fixture('private-and-scope');
    const secret = f.user({ body: 'bb-private-transcript', visibility: 'private', audience: ['bb'], targets: [] });
    const draft = f.user({ body: 'draft-never-exposed', state: 'draft', targets: [] });
    const b = f.begin();
    assert.ok(!b.prepared.payload.serialized.includes('bb-private-transcript'));
    assert.ok(!b.exposure.sourceMessageIds.includes(secret.message.id) && !b.exposure.sourceMessageIds.includes(draft.message.id));
    const foreign = f.prepare({ agentId: 'bb' });
    assert.throws(() => f.sessions.assertForManifest(b.binding, b.prepared.manifest.id, foreign), /SCOPE_MISMATCH/);
    assert.throws(() => f.prepare({ boundarySources: [secret.message.id] }), /SOURCE_REVOKED/);
    f.finish(b);
    assert.equal(f.sessions.getAnchor({ ownerId: f.thread.ownerId, threadId: f.thread.id, agentId: 'bb' }, b.anchor.id), null);
    assert.equal(f.sessions.getAnchor({ ownerId: 'another-owner', threadId: f.thread.id, agentId: 'aa' }, b.anchor.id), null);
    checks.push('Only included, authorized published sources become possible exposure; private/draft text and another member or owner anchor never cross the Session boundary.');
  }
  {
    const f = await fixture('source-authorization');
    const sourceThread = f.store.createThread({ title: 'Source', members: ['aa', 'bb'].map(agentId => ({
      agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(sourceThread.id);
    const source = f.user({ threadId: sourceThread.id, body: 'cross-thread source', targets: [] });
    const b = f.begin({ sourceRefs: [source.message.id] }); f.finish(b);
    const local = f.db.prepare("SELECT * FROM threaded_members WHERE thread_id=? AND agent_id='aa'").get(f.thread.id);
    f.db.prepare("UPDATE threaded_members SET status='left' WHERE thread_id=? AND agent_id='aa'").run(sourceThread.id);
    assert.deepEqual(f.db.prepare("SELECT * FROM threaded_members WHERE thread_id=? AND agent_id='aa'").get(f.thread.id), local);
    assert.equal(f.sessions.getAnchor({ ownerId: f.thread.ownerId, threadId: f.thread.id, agentId: 'aa' }, b.anchor.id), null);
    const cold = f.prepare(); assert.equal(cold.mode, 'cold'); assert.equal(cold.reason, 'source_authorization_changed');
    assert.notEqual(cold.session.nativeId, b.decision.session.nativeId);
    assert.equal(count(f.db, 'threaded_session_anchors'), 1);
    checks.push('Recursive source authorization is rechecked across Threads even when local permissions stay unchanged; revoked history forces a new Session and hides the old anchor.');
  }
  {
    const f = await fixture('unknown-fence'), b = f.begin();
    f.runtime.lifecycle.recordOutcome(b.binding, { kind: 'unknown', reason: 'fixture transport disappeared' });
    const before = f.db.prepare('SELECT * FROM execution_resource_sessions').all();
    assert.throws(() => f.prepare(), /ACTIVE_IDENTITY/);
    assert.throws(() => f.prepare({ informationBoundary: 'force-cold' }), /ACTIVE_IDENTITY/);
    assert.deepEqual(f.db.prepare('SELECT * FROM execution_resource_sessions').all(), before);
    assert.equal(count(f.db, 'threaded_session_context_versions'), 1);
    checks.push('Unknown execution retains its real claim; neither unconfirmed input nor an explicit cold boundary may silently rotate the active native identity.');
  }
  {
    const f = await fixture('unconfirmed-input'), b = f.begin(); f.finish(b, false);
    const cold = f.prepare(); assert.equal(cold.mode, 'cold'); assert.equal(cold.reason, 'unconfirmed_input');
    assert.notEqual(cold.session.nativeId, b.decision.session.nativeId);
    checks.push('A successful transport delivery without a trusted terminal anchor remains possible exposure and cold-starts after resource release.');
  }
  {
    const f = await fixture('native-id-conflict'), b = f.begin(), input = f.anchorInput(b, { nativeId: randomUUID() });
    const before = f.db.prepare('SELECT native_id,resource_key,version FROM execution_resource_sessions').get();
    assert.throws(() => f.sessions.recordAnchor(b.binding, input), /IDENTITY_RECONCILIATION_REQUIRED/);
    const after = f.db.prepare('SELECT native_id,resource_key,version,state FROM execution_resource_sessions').get();
    assert.deepEqual({ native_id: after.native_id, resource_key: after.resource_key, version: after.version }, before);
    assert.equal(after.state, 'reconciling'); assert.equal(count(f.db, 'threaded_session_anchors'), 0);
    assert.throws(() => f.prepare(), /RECONCILIATION_REQUIRED/);
    checks.push('An unexpected backend UUID durably marks reconciliation while preserving the original native ID and lock; no automatic replacement or false anchor is recorded.');
  }
  {
    const f = await fixture('compaction'), b = f.begin();
    const evidence = { reference: `compact:${b.binding.id}`, nativeId: b.decision.session.nativeId,
      backendVersion: f.preparation.backendVersion, boundary: 'compact-boundary-1' };
    const input = { manifestId: b.prepared.manifest.id, decision: b.decision, requestId: 'compact', evidence,
      summary: { text: 'Fixture summary of its own authorized source.', sourceMessageIds: [b.source.message.id] } };
    assert.throws(() => f.sessions.recordCompaction(b.binding, input), /COMPACTION_UNVERIFIED/);
    f.db.prepare('INSERT INTO fixture_backend_receipts VALUES(?,?,?,?,NULL,?)')
      .run(evidence.reference, b.binding.id, b.prepared.manifest.id, evidence.nativeId, evidence.boundary);
    assert.throws(() => f.sessions.recordCompaction(b.binding, { ...input, summary: { text: 'foreign', sourceMessageIds: ['unowned-source'] } }), /SUMMARY_FORBIDDEN/);
    const event = f.sessions.recordCompaction(b.binding, input);
    assert.deepEqual(f.sessions.recordCompaction(b.binding, input), event);
    assert.throws(() => f.sessions.recordAnchor(b.binding, f.anchorInput(b)), /COMPACTION_UNCONFIRMED/);
    f.finish(b, true, { compactionBoundary: evidence.boundary });
    assert.equal(f.prepare().mode, 'resume');
    assert.throws(() => f.db.exec("UPDATE threaded_session_context_events SET record='{}'"), /IMMUTABLE/);
    checks.push('Compaction requires verified native evidence and authorized source provenance; only a terminal anchor covering the exact boundary may resume.');
  }
  {
    const f = await fixture('seal'), b = f.begin();
    const input = { manifestId: b.prepared.manifest.id, decision: b.decision, requestId: 'seal', reason: 'context reset' };
    const sealed = f.sessions.seal(b.binding, input);
    assert.deepEqual(f.sessions.seal(b.binding, input), sealed);
    assert.throws(() => f.sessions.assertForManifest(b.binding, b.prepared.manifest.id, b.decision), /SEALED/);
    assert.throws(() => f.prepare(), /ACTIVE_IDENTITY/);
    f.finish(b, false);
    const cold = f.prepare(); assert.equal(cold.mode, 'cold'); assert.equal(cold.reason, 'session_sealed');
    assert.notEqual(cold.session.nativeId, b.decision.session.nativeId);
    checks.push('Seal is an immutable idempotent boundary; it blocks further input and rotates identity only after the old claim is safely released.');
  }
  {
    const f = await fixture('frozen-cutoff'), b = f.begin(); f.finish(b);
    const later = f.begin({ body: 'later-message-in-native-memory' }); f.finish(later);
    const cold = f.prepare({ inputMaxSeq: b.source.message.seq });
    assert.equal(cold.mode, 'cold'); assert.equal(cold.reason, 'input_boundary_rewound');
    assert.notEqual(cold.session.nativeId, later.decision.session.nativeId);
    checks.push('Restoring an older Wake cutoff cannot reuse native memory containing later messages; the new cutoff produces a cold identity after safe release.');
  }
  {
    const f = await fixture('atomic-exposure'), b = f.begin({}, false);
    f.db.exec("CREATE TRIGGER fixture_input_failure BEFORE INSERT ON threaded_context_send_intents BEGIN SELECT RAISE(ABORT,'fixture_input_failure'); END");
    assert.throws(() => f.sendInput(b), /fixture_input_failure/);
    assert.equal(count(f.db, 'threaded_session_input_intents'), 0); assert.equal(count(f.db, 'threaded_context_send_intents'), 0);
    f.db.exec('DROP TRIGGER fixture_input_failure'); f.sendInput(b); f.delivered(b);
    const input = f.anchorInput(b);
    f.db.exec("CREATE TRIGGER fixture_anchor_failure BEFORE INSERT ON threaded_session_anchors BEGIN SELECT RAISE(ABORT,'fixture_anchor_failure'); END");
    assert.throws(() => f.sessions.recordAnchor(b.binding, input), /fixture_anchor_failure/);
    assert.equal(count(f.db, 'threaded_session_anchors'), 0);
    f.db.exec('DROP TRIGGER fixture_anchor_failure');
    assert.ok(f.sessions.recordAnchor(b.binding, input));
    assert.throws(() => f.db.exec('DELETE FROM threaded_session_input_intents'), /RETAINED/);
    checks.push('Possible exposure and context sending share one transaction; write failures roll back both, and failed anchors never become recoverable facts.');
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(runtimeFixtureNetworkAttempts(), 0);
  console.log(JSON.stringify({ status: 'passed', scope: 'T07 Session/context boundaries; real SQLite/coordinator/runtime, fake backend evidence only, no models', groups: checks.length, checks }, null, 2));
} finally {
  for (const f of fixtures) { f.runtime.close(); if (f.db.open) f.db.close(); }
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
