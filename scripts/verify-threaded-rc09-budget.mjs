import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const reportIndex = process.argv.indexOf('--report');
const reportPath = reportIndex < 0 ? 'docs/reports/evidence/threaded-rc09/budget.json' : process.argv[reportIndex + 1];
if (!reportPath.endsWith('.json')) throw new Error('RC09_BUDGET_REPORT_JSON_REQUIRED');
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc09-budget-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let blockedNetworkCalls = 0, injectedHttpCalls = 0;
globalThis.fetch = async () => { blockedNetworkCalls++; throw new Error('RC09_BUDGET_REAL_NETWORK_FORBIDDEN'); };
const { createThreadedBackendEvidence, verifyThreadedBackendUsage } = await import('../apps/server/src/threaded/backends/evidence.ts');
const fixtures = [], checks = [];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rows = (f, table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const effectTables = ['threaded_invocations', 'threaded_attempts', 'threaded_outputs', 'threaded_messages',
  'threaded_wakes', 'threaded_queue_claims', 'threaded_outbox', 'threaded_invocation_terminals'];
const effects = f => Object.fromEntries(effectTables.map(table => [table, rows(f, table)]));
const ledger = f => Object.fromEntries(['threaded_budget_requests', 'threaded_budget_activity',
  'threaded_budget_attempts', 'threaded_budget_reconciliations'].map(table => [table, rows(f, table)]));
const response = (text = 'Original provider result', usage = { input_tokens: 20, output_tokens: 7 }, content) => new Response(JSON.stringify({
  id: randomUUID(), type: 'message', role: 'assistant', content: content ?? [{ type: 'text', text }],
  stop_reason: content ? 'tool_use' : 'end_turn', ...(usage === null ? {} : { usage }),
}), { status: 200, headers: { 'content-type': 'application/json' } });
async function fixture(name, options = {}) {
  const injected = options.fetch ?? (async () => response());
  const f = await openBackendRuntimeFixture(root, name, { ...options,
    fetch: async (...args) => { injectedHttpCalls++; return injected(...args); } });
  fixtures.push(f); return f;
}
async function execute(f, source = f.user('RC09 request reconciliation acceptance')) {
  f.runtime.queue.enqueueWake(source.wakes[0].id);
  const claim = f.runtime.queue.claimNext('rc09-budget'); assert.ok(claim);
  const result = await f.runtime.executeClaim(claim);
  return { claim, binding: claim.binding, result, source };
}
const receipt = f => rows(f, 'threaded_backend_requests')[0];
const evidence = value => ({ ...(value.output_tokens === null ? {} : { outputTokens: value.output_tokens }),
  ...(value.cost_microusd === null ? {} : { costMicrousd: value.cost_microusd }),
  evidenceReference: `threaded-backend-request:${value.id}` });
function reconcile(f, work, requestId, usage = evidence(receipt(f))) {
  return f.runtime.budget.reconcileRequest({ binding: work.binding, authorizationId: receipt(f).authorization_id, requestId, usage });
}
const check = (id, description, details = {}) => checks.push({ id, description, ...details });
function fault(f) { f.db.exec(`CREATE TRIGGER rc09_budget_reconciliation_fault BEFORE INSERT ON threaded_budget_reconciliations
  BEGIN SELECT RAISE(ABORT,'rc09_budget_reconciliation_fault'); END;`); }
function unfault(f) { f.db.exec('DROP TRIGGER rc09_budget_reconciliation_fault'); }
let failure;
try {
  {
    const f = await fixture('exact-binding'), work = await execute(f), saved = receipt(f), usage = evidence(saved);
    assert.equal(work.result.status, 'completed');
    const before = digest(ledger(f)), auth = f.runtime.budget.getAuthorization(saved.authorization_id);
    assert.equal(verifyThreadedBackendUsage(f.db, work.binding, auth, usage), true);
    for (const [field, value] of Object.entries({ id: 'wrong-binding', ownerId: 'wrong-owner', threadId: 'wrong-thread',
      invocationId: 'wrong-invocation', attemptId: 'wrong-attempt', agentId: 'wrong-agent', runId: 'wrong-run',
      authorityEpoch: work.binding.authorityEpoch + 1, claimId: 'wrong-claim', generation: work.binding.generation + 1,
      fencingToken: 'wrong-fence', workspaceSnapshot: {} })) {
      assert.throws(() => f.runtime.budget.reconcileRequest({ binding: { ...work.binding, [field]: value },
        authorizationId: saved.authorization_id, requestId: `forged:${field}`, usage }), /BINDING_MISMATCH|AUTHORIZATION_REQUIRED|CLAIM_MISMATCH/);
    }
    assert.throws(() => reconcile(f, work, 'wrong-output', { ...usage, outputTokens: usage.outputTokens + 1 }), /USAGE_EVIDENCE_REQUIRED/);
    assert.throws(() => reconcile(f, work, 'wrong-price', { ...usage, costMicrousd: usage.costMicrousd + 1 }), /USAGE_EVIDENCE_REQUIRED/);
    assert.throws(() => reconcile(f, work, 'invented-proof', { ...usage, evidenceReference: 'model-said-free' }), /USAGE_EVIDENCE_REQUIRED/);
    assert.equal(digest(ledger(f)), before);
    check('RB01', 'Production receipt verifier plus canonical persisted binding rejects every modified identity, invented receipt and changed usage without ledger writes.',
      { identityVariants: 12, trueVerifier: 'verifyThreadedBackendUsage' });
  }
  {
    const f = await fixture('partial-known', { price: null }), work = await execute(f), saved = receipt(f), usage = evidence(saved);
    assert.equal(saved.output_tokens, 7); assert.equal(saved.cost_microusd, null);
    const beforeEffects = digest(effects(f));
    assert.equal(reconcile(f, work, 'partial-billing').usageState, 'unknown');
    const after = digest(ledger(f));
    assert.equal(reconcile(f, work, 'partial-billing').usageState, 'unknown'); assert.equal(digest(ledger(f)), after);
    assert.throws(() => reconcile(f, work, 'partial-billing', { ...usage, outputTokens: 8 }), /RECONCILIATION_CONFLICT/);
    assert.throws(() => reconcile(f, work, 'fabricated-free-price', { ...usage, costMicrousd: 0 }), /USAGE_EVIDENCE_REQUIRED/);
    const budgetUsage = f.runtime.budget.getUsage(work.source.message.id);
    assert.equal(budgetUsage.outputTokens, 7); assert.equal(budgetUsage.costMicrousd, 1000); assert.equal(budgetUsage.unknownRequests, 1);
    assert.equal(f.resources.getClaim(work.binding.claimId).state, 'released');
    assert.equal(digest(effects(f)), beforeEffects);
    check('RB02', 'Known output with unknown price keeps the full cost reservation; same-key replay is stable, conflicting replay and fabricated zero price are rejected, and usage reconciliation publishes nothing.', { budgetUsage });
  }
  {
    const f = await fixture('usage-absent', { fetch: async () => response('No supplier usage', null) }), work = await execute(f);
    const saved = receipt(f), usage = evidence(saved), before = digest(ledger(f));
    assert.equal(work.result.status, 'completed'); assert.equal(saved.state, 'complete');
    assert.equal(saved.output_tokens, null); assert.equal(saved.cost_microusd, null);
    assert.equal(f.runtime.budget.settleRequest(work.binding, saved.authorization_id, usage).usageState, 'unknown');
    assert.equal(digest(ledger(f)), before);
    assert.throws(() => reconcile(f, work, 'no-known-dimension'), /USAGE_EVIDENCE_REQUIRED/);
    assert.throws(() => createThreadedBackendEvidence(f.db).complete(saved.id, { outputTokens: 0, costMicrousd: 0, delivered: true }), /RECEIPT_FINAL/);
    const budgetUsage = f.runtime.budget.getUsage(work.source.message.id);
    assert.equal(budgetUsage.outputTokens, 256); assert.equal(budgetUsage.costMicrousd, 1000);
    check('RB03', 'A complete transport receipt may prove request completion without any usage; both reservations remain, the immutable receipt cannot be rewritten and reconciliation cannot invent zero.', { budgetUsage });
  }
  {
    const f = await fixture('settle-rollback'); fault(f);
    const work = await execute(f), saved = receipt(f), usage = evidence(saved);
    assert.equal(saved.state, 'complete'); assert.equal(f.runtime.budget.getAuthorization(saved.authorization_id).usageState, 'unknown');
    const before = digest(ledger(f)), beforeEffects = digest(effects(f));
    assert.throws(() => f.runtime.budget.settleRequest(work.binding, saved.authorization_id, usage), /rc09_budget_reconciliation_fault/);
    assert.equal(digest(ledger(f)), before, 'Settlement row, span and receipt must all roll back together');
    unfault(f);
    assert.equal(f.runtime.budget.settleRequest(work.binding, saved.authorization_id, usage).usageState, 'settled');
    const committed = digest(ledger(f));
    f.runtime.budget.settleRequest(work.binding, saved.authorization_id, usage);
    assert.equal(digest(ledger(f)), committed); assert.equal(digest(effects(f)), beforeEffects);
    assert.equal(rows(f, 'threaded_backend_requests').length, 1);
    check('RB04', 'A real SQLite reconciliation-insert fault preserves the complete transport receipt and atomically rolls back usage/spans; exact receipt repair settles once without replay or terminal publication.',
      { beforeLedgerSha256: before, repairedLedgerSha256: committed, originalInvocationStatus: work.result.status });
  }
  {
    const f = await fixture('reconcile-rollback'), work = await execute(f), beforeEffects = digest(effects(f));
    fault(f); const before = digest(ledger(f));
    assert.throws(() => reconcile(f, work, 'atomic-billing'), /rc09_budget_reconciliation_fault/);
    assert.equal(digest(ledger(f)), before); unfault(f);
    reconcile(f, work, 'atomic-billing'); const committed = digest(ledger(f));
    reconcile(f, work, 'atomic-billing'); assert.equal(digest(ledger(f)), committed);
    assert.equal(digest(effects(f)), beforeEffects);
    check('RB05', 'Operator-style exact usage reconciliation is atomic with its idempotency receipt; failure leaves no partial update and successful replay remains a ledger-only action.');
  }
  {
    const f = await fixture('local-stop-remote-unknown', { fetch: async () => { throw new Error('RC09 injected lost transport acknowledgement'); } });
    const work = await execute(f), saved = receipt(f), producer = createThreadedBackendEvidence(f.db);
    assert.equal(work.result.status, 'unknown'); assert.equal(saved.state, 'unknown');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20)'], { detached: true, stdio: 'ignore' });
    assert.ok(child.pid); const closed = once(child, 'close'), token = randomUUID();
    producer.registerProcess(work.binding, { token, pid: child.pid }); await closed;
    producer.processClosed(token); producer.confirmProcessStopped(token);
    assert.equal(producer.processes(work.binding)[0].state, 'verified_stopped');
    assert.throws(() => producer.quiescence(work.binding), /QUIESCENCE_UNCONFIRMED/);
    assert.throws(() => reconcile(f, work, 'local-stop-is-not-billing', { outputTokens: 0, costMicrousd: 0,
      evidenceReference: `threaded-backend-request:${saved.id}` }), /USAGE_EVIDENCE_REQUIRED/);
    const usage = f.runtime.budget.getUsage(work.source.message.id), beforeEffects = digest(effects(f));
    f.reopen(); f.runtime.recover(); f.runtime.recover();
    assert.equal(f.runtime.budget.getAuthorization(saved.authorization_id).usageState, 'unknown');
    assert.equal(f.resources.getClaim(work.binding.claimId).state, 'unknown');
    assert.equal(f.runtime.queue.claimNext('never-replay-unknown'), null);
    assert.equal(digest(effects(f)), beforeEffects);
    assert.equal(rows(f, 'threaded_backend_requests').length, 1);
    check('RB06', 'An actually exited local fixture child with a verified-stopped receipt cannot clear an unresolved remote request; production quiescence rejects, reservations and unknown claim survive factory rebuild, and no replay occurs.',
      { localChildPid: child.pid, requestUsageBeforeRestart: usage,
        scope: 'A real short-lived Node child supplies the local stop fact; this is not a Claude SDK process test.' });
  }
  {
    const f = await fixture('old-binding-ledger-only'); fault(f);
    const old = await execute(f), saved = receipt(f), oldUsage = evidence(saved); unfault(f);
    const secondSource = f.user('Successor must remain separate');
    f.runtime.queue.enqueueWake(secondSource.wakes[0].id);
    const successor = f.runtime.queue.claimNext('rc09-successor'); assert.ok(successor);
    assert.notEqual(successor.binding.claimId, old.binding.claimId);
    assert.ok(successor.binding.generation > old.binding.generation);
    f.resources.assertCurrent(f.runtime.authority.claim(successor.binding));
    assert.throws(() => f.runtime.authority.assertAuthorized(old.binding));
    const beforeEffects = digest(effects(f)), beforeSuccessor = f.resources.getClaim(successor.binding.claimId);
    const result = f.runtime.budget.reconcileRequest({ binding: old.binding, authorizationId: saved.authorization_id,
      requestId: 'late-original-billing', usage: oldUsage });
    assert.equal(result.usageState, 'settled');
    assert.equal(digest(effects(f)), beforeEffects);
    assert.deepEqual(f.resources.getClaim(successor.binding.claimId), beforeSuccessor);
    assert.throws(() => f.runtime.authority.assertAuthorized(old.binding));
    f.resources.assertCurrent(f.runtime.authority.claim(successor.binding));
    assert.equal(f.runtime.budget.getUsage(old.source.message.id).actualRequests, 1);
    assert.equal(f.runtime.budget.getUsage(secondSource.message.id).actualRequests, 0);
    check('RB07', 'A late exact original receipt can settle the retired binding ledger while its successor holds capacity; it cannot restore old authority, alter the successor, publish old output or add a request.',
      { oldGeneration: old.binding.generation, successorGeneration: successor.binding.generation,
        oldClaimId: old.binding.claimId, successorClaimId: successor.binding.claimId,
        scope: 'Successor is acquired but deliberately not executed. Repairing the earlier pending delivery intent is a separate recovery responsibility.' });
  }
  {
    let clock = Date.parse('2026-10-27T00:00:00.000Z');
    const f = await fixture('owner-window-unknown', { price: null, now: () => clock }), work = await execute(f);
    clock += 86_400_001;
    const window = f.runtime.budget.getOwnerWindow();
    assert.equal(window.usage.outputTokens, 0); assert.equal(window.usage.costMicrousd, 1000);
    assert.equal(window.usage.unknownRequests, 1);
    assert.equal(f.runtime.budget.getUsage(work.source.message.id).outputTokens, 7);
    check('RB08', 'Rolling past the Owner 24-hour window expires known usage from that window while unresolved cost remains reserved; the causal-root ledger retains its original known output.', { ownerWindowUsage: window.usage });
  }
  {
    let calls = 0;
    const f = await fixture('two-requests-one-attempt', { applicationTools: ['search_messages'], fetch: async () => ++calls === 1
      ? response('', { input_tokens: 20, output_tokens: 7 }, [{ type: 'tool_use', id: 'search-proof', name: 'search_messages', input: { query: 'RC09' } }])
      : response('Final after authorized read', { input_tokens: 30, output_tokens: 11 }) });
    const work = await execute(f), saved = rows(f, 'threaded_backend_requests');
    assert.equal(work.result.status, 'completed'); assert.equal(saved.length, 2);
    assert.equal(saved[0].binding_id, saved[1].binding_id); assert.notEqual(saved[0].authorization_id, saved[1].authorization_id);
    const before = digest(ledger(f));
    for (const [a, b] of [[0, 1], [1, 0]]) assert.throws(() => f.runtime.budget.reconcileRequest({ binding: work.binding,
      authorizationId: saved[a].authorization_id, requestId: `cross-request-${a}`, usage: evidence(saved[b]) }), /USAGE_EVIDENCE_REQUIRED/);
    assert.equal(digest(ledger(f)), before);
    const budgetUsage = f.runtime.budget.getUsage(work.source.message.id);
    assert.equal(budgetUsage.invocations, 1); assert.equal(budgetUsage.attempts, 1);
    assert.equal(budgetUsage.actualRequests, 2); assert.equal(budgetUsage.outputTokens, 18);
    check('RB09', 'Two actual injected provider requests in one Attempt have distinct authorizations; even identical binding identity cannot apply one receipt to the other, while root usage counts one Invocation and two requests.', { budgetUsage });
  }
  for (const f of fixtures) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(blockedNetworkCalls, 0);
} catch (error) {
  failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  const result = { status: failure ? 'failed' : 'passed', checkCount: checks.length, checks,
    injectedHttpCalls, realSupplierHttpCalls: 0, blockedNetworkCalls,
    scope: 'Isolated SQLite; production budget, lifecycle, backend receipt verifiers and resource coordinator; injected HTTP; one actual short-lived local Node process. Factory rebuild is not OS-process restart.',
    ...(failure ? { failure } : {}) };
  await mkdir(path.dirname(reportPath), { recursive: true }); await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
  globalThis.fetch = originalFetch;
  for (const f of fixtures) if (f.db.open) f.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ status: result.status, checkCount: checks.length, injectedHttpCalls, report: reportPath }));
  if (failure) { console.error(failure.stack); process.exitCode = 1; }
}
