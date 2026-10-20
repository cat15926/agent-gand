import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createFakeThreadedResources } from './fixtures/threadedFakeExecutor.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-budget-'));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Network forbidden in budget fixture'); };
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
const { createThreadedMessages } = await import('../apps/server/src/threaded/messages.ts');
const { createThreadedBudget, DEFAULT_THREADED_BUDGET } = await import('../apps/server/src/threaded/budget.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [], checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const quote = { maxOutputTokens: 100, estimatedCostMicrousd: 1000, pricingReference: 'fixture-price-v1' };
const evidence = (outputTokens = 20, costMicrousd = 200) => ({ outputTokens, costMicrousd, evidenceReference: 'fixture-final-receipt' });

function fixture(name, defaultPolicy = {}, options = {}) {
  const db = new Database(':memory:'); databases.push(db);
  db.pragma('foreign_keys=ON'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  let clock = Date.parse('2026-10-20T00:00:00.000Z');
  for (const id of ['aa', 'bb', 'cc']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture','now','now')`).run(id, id, JSON.stringify({ id, version: 1,
      model: 'mock:fixture', enabled: true, tools: [], permissionMode: 'readonly' }));
  const store = createThreadedStore(db);
  const room = () => {
    const value = store.createThread({ title: name, members: ['aa', 'bb', 'cc'].map(agentId => ({
      agentId, handle: agentId, roleVersion: 1, permissionVersion: 1 })) });
    db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(value.id); return value;
  };
  const thread = room(), ownerId = thread.ownerId;
  const resources = createFakeThreadedResources(), authority = createThreadedAuthority(db, resources);
  const budget = createThreadedBudget(db, { authority, resources, now: () => clock, defaultPolicy,
    verifyUsage: (_binding, _authorization, usage) => usage.evidenceReference === 'fixture-final-receipt', ...options });
  const lifecycle = createThreadedLifecycle(db, authority, { resources,
    maxAttempts: id => budget.getRoot(db.prepare('SELECT causal_root_id FROM threaded_invocations WHERE id=?').get(id).causal_root_id)
      ?.policy.maxAttemptsPerInvocation ?? 2 });
  const messages = createThreadedMessages(db, { authority });
  const user = (extra = {}) => messages.acceptUserMessage({ ownerId, threadId: thread.id,
    clientRequestId: randomUUID(), body: name, targets: ['aa', 'bb', 'cc'], ...extra });
  const source = user(), rootBudget = budget.ensureRootForMessage(source.message.id);
  function prepare({ agentId = 'aa', receipt = source, existingInvocation, quoted = quote } = {}) {
    const inv = existingInvocation ?? lifecycle.createInvocation({ ownerId, threadId: receipt.message.threadId, agentId,
      causalRootId: receipt.message.causalRootId, goal: name, requestId: randomUUID() });
    const claim = resources.acquire({ ownerId, threadId: receipt.message.threadId, invocationId: inv.id,
      runId: inv.runId, agentId });
    const input = { invocationId: inv.id, attemptId: claim.attemptId, sourceMessageId: receipt.message.id, quote: quoted, claim };
    const value = db.transaction(() => {
      const authorization = budget.reserveAdmission(input);
      const binding = lifecycle.prepareAttempt({ ownerId, invocationId: inv.id, claim });
      return { inv, claim, input, authorization, binding };
    }).immediate();
    return value;
  }
  const start = work => db.transaction(() => {
    lifecycle.startAttempt(work.binding);
    return budget.markStartedWithinTransaction(work.binding, work.authorization.id);
  }).immediate();
  const outcome = (work, usage = evidence(), kind = 'completed') => ({
    kind, ...(kind === 'completed' ? { content: 'fixture result' } : { reason: 'fixture', retryable: true }),
    budgetState: usage ? 'settled' : 'unknown', ...(usage ? { budgetUsage: usage } : {}),
    quiescence: resources.quiescent(work.binding, kind === 'not_started' ? { reason: 'not_started', sideEffects: 'none' } : {}),
  });
  const settle = (work, value) => db.transaction(() =>
    budget.settleOutcomeWithinTransaction(work.binding, work.authorization.id, value)).immediate();
  return { db, thread, ownerId, room, resources, authority, lifecycle, messages, budget, source, rootBudget,
    prepare, start, outcome, settle, user, advance(ms) { clock += ms; }, now: () => clock };
}

try {
  {
    const f = fixture('frozen-defaults');
    assert.deepEqual(f.rootBudget.policy, DEFAULT_THREADED_BUDGET);
    assert.equal(f.rootBudget.id, f.source.message.id);
    assert.deepEqual(f.budget.ensureRootForMessage(f.source.message.id), f.rootBudget);
    const other = createThreadedBudget(f.db, { authority: f.authority, resources: f.resources,
      defaultPolicy: { maxInvocations: 999 } });
    assert.deepEqual(other.ensureRootForMessage(f.source.message.id), f.rootBudget);
    assert.throws(() => f.budget.ensureRootForMessage('model-invented-root'), /SOURCE_REQUIRED/);
    assert.deepEqual(f.budget.getOwnerWindow().policy, {});
    checks.push('Root is derived from the durable authored user message; defaults freeze once and a restart/config change cannot reset or replace them');
  }
  {
    const f = fixture('atomic-reservation-and-idempotency');
    const work = f.prepare();
    assert.equal(count(f.db, 'runs'), 1);
    const first = f.budget.getUsage(f.rootBudget.id);
    assert.deepEqual([first.invocations, first.attempts, first.actualRequests, first.outputTokens, first.costMicrousd],
      [1, 1, 0, 100, 1000]);
    assert.deepEqual(f.db.transaction(() => f.budget.reserveAdmission(work.input)).immediate(), work.authorization);
    assert.throws(() => f.db.transaction(() => f.budget.reserveAdmission({ ...work.input,
      quote: { ...quote, maxOutputTokens: 101 } })).immediate(), /IDEMPOTENCY_CONFLICT/);
    assert.throws(() => f.db.transaction(() => f.budget.reserveAdmission({ ...work.input,
      claim: { ...work.claim, fencingToken: 'forged' } })).immediate(), /FAKE_|CLAIM_MISMATCH/);
    assert.deepEqual(f.budget.getUsage(f.rootBudget.id), first);
    assert.throws(() => f.budget.markStartedWithinTransaction(work.binding, work.authorization.id), /TRANSACTION_REQUIRED/);
    f.start(work); assert.equal(f.budget.getUsage(f.rootBudget.id).actualRequests, 1);
    assert.throws(() => f.budget.assertAuthorized(work.authorization.id, { ...work.binding, generation: 9 }), /BINDING_MISMATCH/);
    checks.push('Admission reserves once before I/O with exact claim identity; Run/Attempt are not additional charges and stale or changed replays cannot mint a second request');
  }
  {
    const f = fixture('rollback-before-run');
    const inv = f.lifecycle.createInvocation({ ownerId: f.ownerId, threadId: f.thread.id, agentId: 'aa',
      causalRootId: f.rootBudget.id, goal: 'rollback', requestId: randomUUID() });
    const claim = f.resources.acquire({ ownerId: f.ownerId, threadId: f.thread.id,
      invocationId: inv.id, runId: inv.runId, agentId: 'aa' });
    assert.throws(() => f.db.transaction(() => {
      f.budget.reserveAdmission({ invocationId: inv.id, attemptId: claim.attemptId,
        sourceMessageId: f.source.message.id, claim, quote });
      f.lifecycle.prepareAttempt({ ownerId: f.ownerId, invocationId: inv.id, claim });
      throw new Error('fixture_atomic_rollback');
    }).immediate(), /fixture_atomic_rollback/);
    assert.equal(count(f.db, 'runs'), 0); assert.equal(count(f.db, 'threaded_attempts'), 0);
    assert.equal(count(f.db, 'threaded_budget_requests'), 0); assert.equal(f.budget.getUsage(f.rootBudget.id).invocations, 0);
    checks.push('A fault after reservation and Attempt preparation rolls back request, attempt/invocation charges and Run in the same transaction');
  }
  {
    const f = fixture('request-and-root-limits', { maxOutputTokens: 150, maxCostMicrousd: 1500 });
    f.prepare();
    const inv = f.lifecycle.createInvocation({ ownerId: f.ownerId, threadId: f.thread.id, agentId: 'bb',
      causalRootId: f.rootBudget.id, goal: 'queued', requestId: randomUUID() });
    const assess = quoted => f.budget.assessAdmission({ invocationId: inv.id, attemptId: randomUUID(),
      sourceMessageId: f.source.message.id, quote: quoted });
    assert.equal(assess(quote).reason, 'THREADED_BUDGET_OUTPUT_LIMIT');
    assert.equal(assess({ ...quote, maxOutputTokens: 10 }).reason, 'THREADED_BUDGET_COST_LIMIT');
    assert.equal(assess({ maxOutputTokens: 10 }).reason, 'THREADED_BUDGET_PRICE_UNKNOWN');
    assert.equal(assess({ ...quote, maxOutputTokens: 24_577 }).reason, 'THREADED_BUDGET_PER_REQUEST_OUTPUT');
    assert.equal(count(f.db, 'runs'), 1); assert.equal(count(f.db, 'threaded_budget_requests'), 1);
    checks.push('Root output/cost caps, per-request output cap and unknown-price policy reject before any second Attempt or actual request is admitted');
  }
  {
    const f = fixture('unknown-price-explicit-policy', { unknownCost: 'reserve', unknownCostReserveMicrousd: 2500 });
    const work = f.prepare({ quoted: { maxOutputTokens: 50 } });
    assert.equal(work.authorization.reservedCostMicrousd, 2500);
    f.start(work);
    const completed = f.outcome(work, undefined);
    delete completed.budgetUsage; completed.budgetState = 'unknown';
    assert.equal(f.settle(work, completed), 'unknown');
    f.lifecycle.recordOutcome(work.binding, completed);
    assert.equal(f.db.prepare('SELECT status FROM threaded_invocations WHERE id=?').get(work.inv.id).status, 'completed');
    assert.equal(f.resources.isHeld(work.binding), false);
    const auth = f.budget.getAuthorization(work.authorization.id), usage = f.budget.getUsage(f.rootBudget.id);
    assert.equal(auth.executionState, 'quiescent'); assert.equal(auth.usageState, 'unknown');
    assert.equal(usage.outputTokens, 50); assert.equal(usage.costMicrousd, 2500);
    assert.equal(usage.activityReservedMs, 0);
    checks.push('Explicit unknown-price reserve is charged; a quiescent completed Invocation can release execution resources while unknown token/cost dimensions remain reserved');
  }
  {
    const f = fixture('partial-usage-reconciliation'), work = f.prepare(); f.start(work);
    const completed = f.outcome(work, { outputTokens: 7, evidenceReference: 'fixture-final-receipt' });
    assert.equal(f.settle(work, completed), 'unknown');
    assert.equal(f.budget.getUsage(f.rootBudget.id).outputTokens, 7);
    assert.equal(f.budget.getUsage(f.rootBudget.id).costMicrousd, 1000);
    const reconciliation = { binding: work.binding, authorizationId: work.authorization.id,
      requestId: 'billing-proof', usage: evidence(7, 90) };
    assert.equal(f.budget.reconcileRequest(reconciliation).usageState, 'settled');
    assert.deepEqual(f.budget.reconcileRequest(reconciliation), f.budget.getAuthorization(work.authorization.id));
    assert.throws(() => f.budget.reconcileRequest({ ...reconciliation, usage: evidence(7, 91) }), /CONFLICT/);
    assert.throws(() => f.budget.reconcileRequest({ ...reconciliation, requestId: 'untrusted',
      usage: { ...evidence(7, 90), evidenceReference: 'model-said-free' } }), /USAGE_EVIDENCE_REQUIRED/);
    assert.equal(f.budget.getUsage(f.rootBudget.id).costMicrousd, 90);
    checks.push('Known output does not free unknown cost; verified exact-request reconciliation is idempotent and rejects changed values, untrusted receipts and free-by-assertion claims');
  }
  {
    const f = fixture('unknown-final-reconciliation'), work = f.prepare(); f.start(work); f.advance(200);
    f.budget.beginActivity(work.binding, work.authorization.id, 'tool:unknown');
    const unknown = { kind: 'unknown', reason: 'fixture process outcome missing' };
    assert.equal(f.settle(work, unknown), 'unknown');
    assert.throws(() => f.budget.endActivity(work.binding, work.authorization.id, 'tool:unknown'), /QUIESCENCE_REQUIRED/);
    f.advance(1200);
    assert.equal(f.budget.getUsage(f.rootBudget.id).activityMs, 1400);
    assert.throws(() => f.budget.assertAuthorized(work.authorization.id, work.binding), /REQUEST_NOT_ACTIVE/);
    const completed = f.outcome(work, evidence());
    assert.equal(f.settle(work, completed), 'settled');
    assert.equal(f.settle(work, completed), 'settled');
    assert.equal(count(f.db, 'threaded_budget_outcomes'), 2);
    assert.throws(() => f.settle(work, { ...completed, content: 'different final' }), /SETTLEMENT_CONFLICT/);
    const closed = f.budget.getUsage(f.rootBudget.id).activityMs; f.advance(1000);
    assert.equal(f.budget.getUsage(f.rootBudget.id).activityMs, closed);
    checks.push('Execution unknown retains an open activity interval through time/restart boundaries; trusted quiescent final reconciliation preserves its unknown audit and cannot overwrite an existing known final');
  }
  {
    const f = fixture('separate-actual-requests'), work = f.prepare(); f.start(work); f.advance(100);
    const tool = 'tool:shared-attempt';
    f.budget.beginActivity(work.binding, work.authorization.id, tool);
    f.budget.settleRequest(work.binding, work.authorization.id, evidence(10, 50));
    const next = f.budget.reserveRequest(work.binding, 'actual-provider-request-2', quote);
    f.db.transaction(() => f.budget.markStartedWithinTransaction(work.binding, next.id)).immediate();
    f.advance(100); f.budget.endActivity(work.binding, work.authorization.id, tool);
    f.budget.settleRequest(work.binding, next.id, { outputTokens: 5, evidenceReference: 'fixture-final-receipt' });
    const usage = f.budget.getUsage(f.rootBudget.id);
    assert.deepEqual([usage.invocations, usage.attempts, usage.actualRequests], [1, 1, 2]);
    assert.equal(usage.outputTokens, 15); assert.equal(usage.costMicrousd, 1050);
    assert.equal(usage.activityMs, 200, 'overlapping model/tool time within this Attempt is charged once');
    assert.equal(usage.activityReservedMs, 0);
    assert.deepEqual(f.budget.settleRequest(work.binding, next.id, { outputTokens: 5,
      evidenceReference: 'fixture-final-receipt' }), f.budget.getAuthorization(next.id));
    checks.push('Two real request identities in one Attempt reserve/settle separately without double-counting Invocation, Run or overlapping tool activity; the second unknown cost stays charged');
  }
  {
    const f = fixture('attempt-aggregate-and-unused-refunds'), work = f.prepare(); f.start(work);
    const second = f.budget.reserveRequest(work.binding, 'second-started', quote);
    f.db.transaction(() => f.budget.markStartedWithinTransaction(work.binding, second.id)).immediate();
    const unused = f.budget.reserveRequest(work.binding, 'third-never-started', quote);
    const failed = f.outcome(work, evidence(), 'failed');
    failed.budgetState = f.settle(work, failed);
    assert.equal(failed.budgetState, 'unknown');
    assert.equal(f.budget.getAuthorization(work.authorization.id).usageState, 'settled');
    assert.equal(f.budget.getAuthorization(second.id).executionState, 'quiescent');
    assert.equal(f.budget.getAuthorization(second.id).usageState, 'unknown');
    assert.equal(f.budget.getAuthorization(unused.id).executionState, 'not_started');
    assert.equal(f.budget.getAuthorization(unused.id).usageState, 'settled');
    assert.equal(f.budget.getUsage(f.rootBudget.id).costMicrousd, 1200);
    assert.equal(f.budget.getUsage(f.rootBudget.id).outputTokens, 120);
    const result = f.lifecycle.recordOutcome(work.binding, failed);
    assert.equal(result.retryable, undefined);
    assert.equal(result.status, 'failed');
    const unstarted = fixture('all-unused-refund'), prepared = unstarted.prepare();
    unstarted.budget.reserveRequest(prepared.binding, 'unused-sibling', quote);
    assert.throws(() => unstarted.settle(prepared, { ...unstarted.outcome(prepared), kind: 'not_started' }), /NOT_STARTED_PROOF_REQUIRED/);
    assert.equal(unstarted.settle(prepared, unstarted.outcome(prepared, undefined, 'not_started')), 'settled');
    assert.equal(unstarted.budget.getUsage(unstarted.rootBudget.id).costMicrousd, 0);
    assert.equal(unstarted.budget.getUsage(unstarted.rootBudget.id).outputTokens, 0);
    assert.equal(unstarted.budget.getUsage(unstarted.rootBudget.id).actualRequests, 0);
    checks.push('Attempt settlement aggregates every actual request: one unknown sibling forbids automatic retry, and verified quiescence refunds all unused reservations while retaining started unknown usage');
  }
  {
    const f = fixture('safe-retry-count'), first = f.prepare();
    const notStarted = f.outcome(first, undefined, 'not_started');
    f.settle(first, notStarted); f.lifecycle.recordOutcome(first.binding, notStarted);
    assert.equal(f.budget.getUsage(f.rootBudget.id).actualRequests, 0);
    assert.equal(f.budget.getUsage(f.rootBudget.id).outputTokens, 0);
    const second = f.prepare({ existingInvocation: first.inv });
    const secondNotStarted = f.outcome(second, undefined, 'not_started');
    f.settle(second, secondNotStarted);
    assert.deepEqual([f.budget.getUsage(f.rootBudget.id).invocations, f.budget.getUsage(f.rootBudget.id).attempts], [1, 2]);
    assert.equal(f.budget.assessAdmission({ invocationId: first.inv.id, attemptId: randomUUID(),
      sourceMessageId: f.source.message.id, quote }).reason, 'THREADED_BUDGET_ATTEMPT_LIMIT');
    const changed = f.budget.reviseRoot({ ownerId: f.ownerId, rootId: f.rootBudget.id, expectedVersion: 1,
      requestId: 'owner-allows-third-attempt', reason: 'Explicit isolated test decision', patch: { maxAttemptsPerInvocation: 3 } });
    assert.equal(changed.version, 2);
    f.lifecycle.recordOutcome(second.binding, secondNotStarted);
    const third = f.prepare({ existingInvocation: first.inv });
    assert.equal(f.budget.getUsage(f.rootBudget.id).attempts, 3); assert.equal(count(f.db, 'runs'), 1);
    assert.equal(third.authorization.rootId, first.authorization.rootId);
    checks.push('Confirmed not-started refunds only unused request quota; safe retry keeps its root and Run, counts Attempts once, and requires a versioned Owner decision to exceed the frozen two-Attempt default');
  }
  {
    const f = fixture('activity-union-and-hold'), a = f.prepare(), b = f.prepare({ agentId: 'bb' });
    f.start(a); f.advance(100); f.start(b); f.advance(100);
    f.budget.beginActivity(a.binding, a.authorization.id, 'tool:nested'); f.advance(300);
    f.budget.endActivity(a.binding, a.authorization.id, 'tool:nested');
    f.budget.checkpoint(a.binding, a.authorization.id); f.budget.checkpoint(b.binding, b.authorization.id);
    f.advance(200); f.settle(a, f.outcome(a)); f.advance(100); f.settle(b, f.outcome(b));
    assert.equal(f.budget.getUsage(f.rootBudget.id).activityMs, 1400, 'A [0,700] plus B [100,800]');
    const usage = f.budget.getUsage(f.rootBudget.id); f.advance(60_000);
    assert.equal(f.budget.getUsage(f.rootBudget.id).activityMs, usage.activityMs);
    assert.equal(f.budget.getUsage(f.rootBudget.id).activityReservedMs, 0);
    checks.push('Nested model/tool spans use the per-Attempt union; concurrent Attempts add their durations, while a later idle/hold interval adds no activity');
  }
  {
    const f = fixture('deadline-and-expired-allowance', { maxActivityMs: 1500,
      deadlineAt: Date.parse('2026-10-20T00:00:00.000Z') + 900 });
    const work = f.prepare(); assert.equal(f.start(work).validUntil, f.now() + 900);
    f.advance(901);
    assert.throws(() => f.budget.checkpoint(work.binding, work.authorization.id), /DEADLINE|EXPIRED/);
    const before = f.budget.getUsage(f.rootBudget.id);
    f.budget.recover(); f.advance(200);
    assert.ok(f.budget.getUsage(f.rootBudget.id).activityMs > before.activityMs);
    assert.equal(f.budget.getAuthorization(work.authorization.id).executionState, 'unknown');
    assert.equal(f.budget.getUsage(f.rootBudget.id).outputTokens, 100);
    checks.push('Absolute deadlines bound activity allowances; expired work cannot silently renew, and recovery retains both monetary/token reservations and ongoing unknown execution time');
  }
  {
    const f = fixture('owner-window-and-decisions'), work = f.prepare(); f.start(work);
    f.settle(work, f.outcome(work, { outputTokens: 10, evidenceReference: 'fixture-final-receipt' }));
    const decision = { ownerId: f.ownerId, expectedVersion: 1, requestId: 'owner-window-cap',
      reason: 'Explicit owner window control', policy: { maxCostMicrousd: 1100 } };
    assert.equal(f.budget.configureOwnerWindow(decision).version, 2);
    assert.equal(f.budget.configureOwnerWindow(decision).version, 2);
    assert.throws(() => f.budget.configureOwnerWindow({ ...decision, policy: { maxCostMicrousd: 1200 } }), /IDEMPOTENCY_CONFLICT/);
    const second = f.user(); f.budget.ensureRootForMessage(second.message.id);
    assert.throws(() => f.prepare({ receipt: second, agentId: 'bb' }), /OWNER_COST_BUDGET/);
    f.advance(86_400_001);
    const window = f.budget.getOwnerWindow();
    assert.equal(window.usage.outputTokens, 0, 'known output outside the rolling window is historical');
    assert.equal(window.usage.costMicrousd, 1000, 'unresolved cost cannot age into a free allowance');
    assert.equal(window.usage.unknownRequests, 1);
    assert.equal(f.budget.getUsage(f.rootBudget.id).outputTokens, 10, 'root lifetime accounting never resets at the owner window edge');
    checks.push('Default owner 24-hour usage is durable; explicit versioned window caps apply across roots, and unresolved dimensions do not become free when their request ages out');
  }
  {
    const f = fixture('causal-depth-cross-thread', { maxA2ADepth: 1 }), first = f.prepare(); f.start(first);
    const other = f.room();
    const post = f.messages.postAgentMessage({ binding: first.binding, threadId: other.id, toolCallId: 'cross-post',
      body: 'inherited causal work', targets: ['bb'], sourceRefs: [f.source.message.id] });
    assert.equal(f.budget.ensureRootForMessage(post.message.id).id, f.rootBudget.id);
    const next = f.prepare({ agentId: 'bb', receipt: post }); f.start(next);
    const back = f.messages.postAgentMessage({ binding: next.binding, threadId: f.thread.id, toolCallId: 'second-hop',
      body: 'second hop', targets: ['aa'], sourceRefs: [post.message.id] });
    assert.throws(() => f.prepare({ receipt: back }), /A2A_DEPTH/);
    assert.equal(f.budget.getUsage(f.rootBudget.id).invocations, 2);
    assert.equal(count(f.db, 'threaded_budget_roots'), 1);
    checks.push('Agent relay and cross-post inherit the original root across Threads; depth derives from the persistent parent Invocation and the frozen A2A limit cannot be reset by another message');
  }
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls, realModelCalls: 0,
    scope: 'T06 pure durable budget accounting, trusted fake resource/usage receipts; no supplier billing guarantee' }, null, 2));
} finally {
  for (const db of databases) if (db.open) db.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
