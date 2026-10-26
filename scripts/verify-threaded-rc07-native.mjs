import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

// This suite never reads configured accounts or calls a remote model. Automatic
// compaction is produced by the installed SDK from explicitly synthetic usage.
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc07-native-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let deniedNetwork = 0;
globalThis.fetch = async () => { deniedNetwork++; throw new Error('RC07_REAL_NETWORK_FORBIDDEN'); };
const { invokeThreadedSdkProcess } = await import('../apps/server/src/threaded/backends/sdkProcess.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const fixtures = [], checks = [], evidence = [], failures = [], cleanup = [];
const reportArg = process.argv.find(value => value.startsWith('--report='));
const report = path.resolve(reportArg?.slice('--report='.length) ?? 'docs/reports/evidence/threaded-rc07/native.json');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const groupAlive = pid => execFileSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8', timeout: 1000 })
  .split('\n').some(line => { const [group, status] = line.trim().split(/\s+/); return Number(group) === pid && status && !status.startsWith('Z'); });
async function until(predicate, code, timeout = 60000) {
  const end = Date.now() + timeout;
  do { const value = predicate(); if (value) return value; await delay(30); } while (Date.now() < end);
  throw new Error(code);
}
function response(body, sequence, inputTokens, text = 'RC07_NATIVE_ACK') {
  const usage = { input_tokens: inputTokens, output_tokens: 7 };
  if (!body.stream) return new Response(JSON.stringify({ id: `rc07-${sequence}`, type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }), { headers: { 'content-type': 'application/json' } });
  const frames = [
    { type: 'message_start', message: { id: `rc07-${sequence}`, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
async function make(name, options = {}) {
  const calls = [], records = [];
  let f;
  f = await openBackendRuntimeFixture(root, name, { model: 'claude-sonnet-4-5-20250929',
    quote: { maxOutputTokens: 8192, estimatedCostMicrousd: 1000, pricingReference: 'fixture-only' },
    connection: { baseUrl: 'https://rc07-native.invalid', headers: {}, timeoutMs: 120000 },
    sdkProcess: async input => {
      await invokeThreadedSdkProcess({ ...input, ...(options.nativeEnvironment ? { environment: { ...input.environment, ...options.nativeEnvironment } } : {}), onRecord(record) {
        if (record.type === 'system' && ['compact_boundary', 'status'].includes(record.subtype)) records.push(structuredClone(record));
        if (record.type === 'assistant') records.push({ type: 'observed_assistant_usage', usage: record.message?.usage });
        if (record.type === 'result') records.push({ type: 'observed_result_usage', usage: record.usage, modelUsage: record.modelUsage });
        if (options.dropCheckpoint?.(record)) return;
        input.onRecord(record);
      } });
      await options.afterProcess?.(f);
    },
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://rc07-native.invalid');
      const body = JSON.parse(init.body);
      const receipt = f.db.prepare("SELECT id,binding_id,manifest_id,request_key FROM threaded_backend_requests WHERE request_hash=? AND state='sending'")
        .all(digest(init.body));
      assert.equal(receipt.length, 1);
      const n = calls.length + 1;
      calls.push({ sequence: n, ...receipt[0], path: new URL(url).pathname, bodyHash: digest(init.body),
        inputBytes: Buffer.byteLength(init.body), containsForeign: init.body.includes('RC07_FOREIGN_PRIVATE'),
        containsRevoked: init.body.includes('RC07_REVOKED_SOURCE'), body });
      if (new URL(url).pathname.endsWith('/count_tokens')) return new Response('{"input_tokens":20}', { headers: { 'content-type': 'application/json' } });
      return response(body, n, options.usage?.(n, body) ?? 20);
    }, ...options.fixture });
  fixtures.push(f);
  return Object.assign(f, { calls, records });
}
function claim(f, receipt) {
  const budget = f.runtime.budget.ensureRootForMessage(receipt.message.id);
  f.runtime.reviseRoot({ ownerId: budget.ownerId, rootId: budget.id, expectedVersion: budget.version, requestId: randomUUID(),
    reason: 'Isolated RC07 actual native acceptance', patch: { activityAllowanceMs: 10000 } });
  f.runtime.queue.enqueueWake(receipt.wakes[0].id);
  const value = f.runtime.queue.claimNext('rc07-native'); assert.ok(value); return value;
}
const preparation = (f, c) => JSON.parse(f.db.prepare('SELECT preparation FROM threaded_wake_queue WHERE invocation_id=?')
  .get(c.binding.invocationId).preparation).threadedContext.decision;
function facts(f) {
  const read = table => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { sessions: read('execution_resource_sessions'), anchors: read('threaded_session_anchors'),
    events: read('threaded_session_context_events'), nativeEvents: read('threaded_backend_native_events'),
    processes: read('threaded_backend_processes'), requests: read('threaded_backend_requests'),
    intents: read('threaded_session_input_intents'), manifests: read('threaded_context_manifests'),
    claims: read('execution_resource_claims'), terminals: read('threaded_invocation_terminals') };
}
async function execute(f, body, extra) {
  const c = claim(f, f.user(body, ['sdk-member'], extra)), decision = preparation(f, c);
  const result = await f.runtime.executeClaim(c);
  return { claim: c, decision, result };
}
async function scenario(id, action) {
  try { await action(); }
  catch (error) { failures.push({ id, code: error.code ?? 'RC07_NATIVE_ACCEPTANCE_FAILED', message: error.message.slice(0, 2000),
    stack: String(error.stack).split('\n').slice(0, 6) }); process.exitCode = 1; }
}
try {
  await scenario('automatic-compaction', async () => {
    const f = await make('automatic-compaction', { usage: n => n === 1 ? 190000 : 20,
      nativeEnvironment: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' } });
    f.user('RC07_FOREIGN_PRIVATE', [], { visibility: 'private', audience: ['other-member'] });
    const a = await execute(f, 'Keep RC07_OWN_MARKER. Reply RC07_NATIVE_ACK.');
    assert.equal(a.result.status, 'completed', JSON.stringify(a.result));
    assert.equal(a.decision.mode, 'cold');
    assert.ok(facts(f).anchors.length);
    checks.push('Actual SDK cold execution creates a durable checkpoint; foreign private member content is absent from every wire request');
    const b = await execute(f, 'Continue RC07_OWN_MARKER. Reply RC07_NATIVE_ACK.');
    const observed = facts(f);
    evidence.push({ id: 'automatic-compaction', first: a, second: b, facts: observed, records: f.records, calls: f.calls,
      triggerConditions: { injectedInitialUsageInputTokens: 190000, thresholdOverride: { window: 100000, percentage: 1 }, remoteSupplier: false } });
    assert.equal(b.decision.mode, 'resume');
    assert.equal(b.result.status, 'completed', JSON.stringify(b.result));
    const compact = observed.events.filter(row => row.kind === 'compaction').map(row => JSON.parse(row.record));
    assert.ok(compact.length, 'RC07_NATIVE_AUTOMATIC_COMPACTION_NOT_OBSERVED');
    assert.equal(compact.at(-1).evidence.metadata.trigger, 'auto');
    assert.ok(compact.at(-1).evidence.metadata.preTokens >= 0);
    assert.ok(compact.at(-1).sourceMessageIds.includes(a.claim.queue.sourceMessageId));
    assert.ok(f.calls.every(call => !call.containsForeign));
    checks.push('Installed SDK emits automatic compact_boundary from synthetic usage; validated metadata and authorized platform source IDs persist without exposing another member transcript');
    const c = await execute(f, 'Continue after compaction. Reply RC07_NATIVE_ACK.');
    assert.equal(c.result.status, 'completed', JSON.stringify(c.result));
    assert.ok(['resume', 'cold'].includes(c.decision.mode));
    if (c.decision.mode === 'resume') {
      assert.equal(c.decision.session.nativeId, b.decision.session.nativeId);
      const anchor = JSON.parse(observed.anchors.at(-1).record);
      assert.equal(anchor.evidence.compactionBoundary, compact.at(-1).boundary);
    } else {
      assert.equal(c.decision.reason, 'unconfirmed_input');
      assert.notEqual(c.decision.session.nativeId, b.decision.session.nativeId);
    }
    evidence.push({ id: 'after-compaction', continuation: c, facts: facts(f), calls: f.calls });
    checks.push('Post-compaction continuation uses an exact confirmed native boundary or explicitly rotates identity when a usable input checkpoint is absent');
  });
  await scenario('source-acl-revocation', async () => {
    const f = await make('source-acl-revocation');
    const store = createThreadedStore(f.db);
    const sourceThread = store.createThread({ title: 'RC07 source', members: ['api-member', 'sdk-member', 'other-member'].map(agentId => ({
      agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(sourceThread.id);
    const source = f.runtime.messages.acceptUserMessage({ ownerId: sourceThread.ownerId, threadId: sourceThread.id,
      clientRequestId: randomUUID(), body: 'RC07_REVOKED_SOURCE', targets: [] });
    const a = await execute(f, 'RC07_REVOKED_SOURCE derived content. Reply RC07_NATIVE_ACK.', { sourceRefs: [source.message.id] });
    assert.equal(a.result.status, 'completed', JSON.stringify(a.result));
    const oldAnchor = JSON.parse(facts(f).anchors.at(-1).record), beforeCalls = f.calls.length;
    const localBefore = f.db.prepare('SELECT * FROM threaded_members WHERE thread_id=? AND agent_id=?').get(f.thread.id, 'sdk-member');
    f.db.prepare("UPDATE threaded_members SET status='left' WHERE thread_id=? AND agent_id='sdk-member'").run(sourceThread.id);
    assert.deepEqual(f.db.prepare('SELECT * FROM threaded_members WHERE thread_id=? AND agent_id=?').get(f.thread.id, 'sdk-member'), localBefore);
    assert.equal(f.runtime.sessionContext.getAnchor({ ownerId: f.thread.ownerId, threadId: f.thread.id, agentId: 'sdk-member' }, oldAnchor.id), null);
    const b = await execute(f, 'Current authorized instruction. Reply RC07_NATIVE_ACK.');
    assert.equal(b.decision.mode, 'cold'); assert.equal(b.decision.reason, 'source_authorization_changed');
    assert.notEqual(b.decision.session.nativeId, a.decision.session.nativeId);
    assert.equal(b.result.status, 'completed', JSON.stringify(b.result));
    assert.ok(f.calls.slice(beforeCalls).every(call => !call.containsRevoked));
    evidence.push({ id: 'source-acl-revocation', mutation: 'Temporary fixture source-Thread membership status changed to left; local membership unchanged',
      first: a, next: b, facts: facts(f), calls: f.calls });
    checks.push('Revoking only a cross-Thread source membership hides the old anchor, preserves exposure facts, and actual SDK cold-starts a new native identity without revoked derived content');
  });
  await scenario('trusted-low-level-seal', async () => {
    let sealOnce = true, sealed;
    const f = await make('trusted-low-level-seal', { afterProcess: current => {
      if (!sealOnce) return; sealOnce = false;
      const row = current.db.prepare('SELECT b.*,m.id manifest_id,q.preparation FROM threaded_execution_bindings b JOIN threaded_context_manifests m ON m.binding_id=b.id JOIN threaded_wake_queue q ON q.invocation_id=b.invocation_id ORDER BY b.rowid DESC LIMIT 1').get();
      const binding = { schemaVersion: 1, id: row.id, origin: 'threaded_invocation_attempt', threadId: row.thread_id,
        invocationId: row.invocation_id, runId: row.run_id, attemptId: row.attempt_id, ownerId: row.owner_id, agentId: row.agent_id,
        authorityEpoch: row.authority_epoch, claimId: row.claim_id, generation: row.generation, fencingToken: row.fencing_token };
      const decision = JSON.parse(row.preparation).threadedContext.decision;
      const input = { manifestId: row.manifest_id, decision, requestId: 'rc07-explicit-seal', reason: 'Temporary fixture trusted low-level seal after actual SDK process completes' };
      sealed = current.runtime.sessionContext.seal(binding, input);
      assert.deepEqual(current.runtime.sessionContext.seal(binding, input), sealed);
      assert.throws(() => current.runtime.sessionContext.assertForManifest(binding, row.manifest_id, decision), /SEALED/);
    } });
    const a = await execute(f, 'Complete prior to trusted seal. Reply RC07_NATIVE_ACK.');
    assert.ok(sealed); assert.equal(a.result.status, 'failed', JSON.stringify(a.result));
    assert.equal(f.resources.getClaim(a.claim.binding.claimId).state, 'released');
    const b = await execute(f, 'Continue after explicit seal. Reply RC07_NATIVE_ACK.');
    assert.equal(b.decision.mode, 'cold'); assert.equal(b.decision.reason, 'session_sealed');
    assert.notEqual(b.decision.session.nativeId, a.decision.session.nativeId);
    assert.equal(b.result.status, 'completed', JSON.stringify(b.result));
    evidence.push({ id: 'trusted-low-level-seal', seal: sealed, first: a, next: b, facts: facts(f), calls: f.calls });
    checks.push('Explicit trusted low-level seal is immutable/idempotent, blocks the old checkpoint, safely releases the quiescent claim and actual SDK continues under a cold identity');
  });
  await scenario('missing-checkpoint-cold', async () => {
    let omit = true;
    const f = await make('missing-checkpoint-cold', { dropCheckpoint: record => {
      if (record.type !== 'threaded_checkpoint' || !omit) return false;
      omit = false; return true;
    } });
    const a = await execute(f, 'Finish with checkpoint delivery fault. Reply RC07_NATIVE_ACK.');
    assert.equal(a.result.status, 'completed', JSON.stringify(a.result));
    assert.equal(facts(f).anchors.length, 0);
    assert.equal(facts(f).intents.length, 1);
    const b = await execute(f, 'Continue without a confirmed checkpoint. Reply RC07_NATIVE_ACK.');
    assert.equal(b.decision.mode, 'cold'); assert.equal(b.decision.reason, 'unconfirmed_input');
    assert.notEqual(b.decision.session.nativeId, a.decision.session.nativeId);
    assert.equal(b.result.status, 'completed', JSON.stringify(b.result));
    evidence.push({ id: 'missing-checkpoint-cold', injectedFault: 'Drop the first actual sdk/checkpoint at the adapter boundary only',
      first: a, next: b, facts: facts(f), calls: f.calls });
    checks.push('A missing checkpoint preserves actual delivery and exposure, then explicitly cold-starts the next actual SDK invocation instead of trusting an unconfirmed native chain');
  });
  await scenario('compaction-metadata-producer-contract', async () => {
    const f = fixtures.find(value => facts(value).anchors.length);
    assert.ok(f);
    const snapshot = facts(f), anchorRow = snapshot.anchors.at(-1), anchor = JSON.parse(anchorRow.record);
    const row = f.db.prepare('SELECT * FROM threaded_execution_bindings WHERE id=?').get(anchorRow.binding_id);
    const binding = { schemaVersion: 1, id: row.id, origin: 'threaded_invocation_attempt', threadId: row.thread_id,
      invocationId: row.invocation_id, runId: row.run_id, attemptId: row.attempt_id, ownerId: row.owner_id, agentId: row.agent_id,
      authorityEpoch: row.authority_epoch, claimId: row.claim_id, generation: row.generation, fencingToken: row.fencing_token };
    const prepared = { contextManifestId: anchor.manifestId, session: { nativeId: anchor.session.nativeId, backendVersion: '0.3.288' } };
    const before = snapshot.nativeEvents.length;
    for (const metadata of [null, [], {}, { trigger: 'automatic', pre_tokens: 1 }, { trigger: 'auto', pre_tokens: -1 },
      { trigger: 'manual', pre_tokens: 1.2 }, { trigger: 'auto', pre_tokens: 1, post_tokens: -1 },
      { trigger: 'auto', pre_tokens: 1, duration_ms: NaN }]) {
      assert.throws(() => f.runtime.backendEvidence.nativeCompaction(binding, prepared, randomUUID(), metadata), /COMPACTION_METADATA_INVALID/);
    }
    assert.equal(facts(f).nativeEvents.length, before);
    const absent = f.runtime.backendEvidence.nativeCompaction(binding, prepared, randomUUID());
    assert.deepEqual(absent.metadata, { trigger: 'unknown' });
    const manual = f.runtime.backendEvidence.nativeCompaction(binding, prepared, randomUUID(),
      { trigger: 'manual', pre_tokens: 200, post_tokens: 30, duration_ms: 0.5, future_metadata: 'ignored' });
    assert.deepEqual(manual.metadata, { trigger: 'manual', preTokens: 200, postTokens: 30, durationMs: 0.5 });
    evidence.push({ id: 'compaction-metadata-producer-contract', layer: 'Direct trusted producer contract, deliberately injected metadata; not actual native event observation',
      rejectedMetadata: 8, absent, manual, recordedSessionContextEvents: 0 });
    checks.push('Malformed compact metadata produces no durable event; absent metadata stays unknown and manual metadata is preserved without claiming an automatic trigger');
  });
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(deniedNetwork, 0);
} catch (error) { failures.push({ id: 'suite', message: error.message }); process.exitCode = 1; }
finally {
  for (const f of fixtures) {
    evidence.push({ id: 'final-fixture-facts', facts: facts(f), records: f.records, calls: f.calls });
    try {
      await f.runtime.shutdown(5000);
      for (const p of f.db.prepare('SELECT token,host,pid FROM threaded_backend_processes').all()) {
        if (groupAlive(p.pid)) {
          assert.equal(p.host, hostname()); const command = execFileSync('ps', ['-p', String(p.pid), '-o', 'command='], { encoding: 'utf8' });
          assert.ok(command.includes('/execution/guardian.mjs') && command.includes(p.token), 'RC07_PROCESS_OWNERSHIP_UNCONFIRMED');
          try { process.kill(-p.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
          await delay(600); if (groupAlive(p.pid)) process.kill(-p.pid, 'SIGKILL');
        }
        await until(() => !groupAlive(p.pid), 'RC07_NATIVE_CLEANUP_FAILED', 5000); cleanup.push({ pid: p.pid, stopped: true });
      }
    } catch (error) { failures.push({ id: 'cleanup', message: error.message }); process.exitCode = 1; }
    f.close();
  }
  const result = { ok: failures.length === 0, stage: 'RC07', date: new Date().toISOString(), groups: checks.length, checks, failures,
    evidence, cleanup, actualSdkVersion: '0.3.288', actualGuardianAndSdkCli: true, actualIndexEntry: false,
    isolatedWorkerBypass: true, transport: 'injected synthetic responses and usage', realSupplierCalls: 0, realModelTokens: 0,
    dailyDatabaseRead: false, dailyConfigurationChanged: false, credentialsRead: false, deniedRealNetwork: deniedNetwork,
    targetActivityAllowanceMs: 10000, productionDefaultActivityAllowanceMs: 1000,
    limitations: ['Automatic compaction is an actual installed SDK event induced by synthetic supplier usage; it is not natural real-provider compaction.',
      'Seal is explicitly invoked by a trusted fixture through the low-level server port; no production HTTP/UI seal action exists.',
      'ACL revocation mutates source membership in an isolated fixture; subsequent SDK execution and native identity selection are actual.',
      'This suite uses an isolated factory execution bypass and does not prove actual index.ts production entry.'] };
  await mkdir(path.dirname(report), { recursive: true }); await writeFile(report, JSON.stringify(result, null, 2) + '\n');
  globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: result.ok, groups: checks.length, failures, actualGuardianAndSdkCli: true, realSupplierCalls: 0, report }));
}
