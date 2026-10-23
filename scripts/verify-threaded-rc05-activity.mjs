/** RC05 real-clock activity slices; injected transport, isolated production backend composition. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'threaded-rc05-activity-')));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(root, 'unused-global.sqlite'), AGENTS_DIR: path.join(root, 'agents'),
  AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), THREADED_COLLABORATION_MODE: 'closed' });
let forbiddenNetworkCalls = 0;
globalThis.fetch = async () => { forbiddenNetworkCalls++; throw new Error('RC05_ACTIVITY_EXTERNAL_NETWORK_FORBIDDEN'); };
const { DEFAULT_THREADED_BUDGET } = await import('../apps/server/src/threaded/budget.ts');
const fixtures = [], checks = [], evidence = [];
const blockMs = 1250;
function synchronousPreparation() {
  const began = performance.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
  return { injectedSynchronousWork: true, minimumMs: blockMs, elapsedMs: performance.now() - began };
}
function response() {
  return new Response(JSON.stringify({ id: randomUUID(), type: 'message',
    content: [{ type: 'text', text: 'RC05 local activity acceptance response' }], stop_reason: 'end_turn',
    usage: { input_tokens: 20, output_tokens: 7 } }), { headers: { 'content-type': 'application/json' } });
}
function snapshot(f) {
  const tables = ['threaded_backend_requests', 'threaded_outputs', 'threaded_invocation_terminals',
    'threaded_attempts', 'threaded_budget_outcomes', 'threaded_budget_versions'];
  const tableNames = new Set(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  return {
    counts: Object.fromEntries(tables.filter(table => tableNames.has(table)).map(table =>
      [table, f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n])),
    requests: f.db.prepare('SELECT id,state,delivered,input_tokens,output_tokens FROM threaded_backend_requests ORDER BY rowid').all(),
    attempts: f.db.prepare('SELECT id,status,execution_stage,execution_reason,resource_release_state FROM threaded_attempts ORDER BY rowid').all(),
    queue: f.db.prepare('SELECT state,reason FROM threaded_wake_queue ORDER BY seq').all(),
    claims: f.db.prepare('SELECT state FROM execution_resource_claims ORDER BY rowid').all(),
    activity: f.db.prepare('SELECT state,kind,started_at,observed_at,ended_at FROM threaded_budget_activity ORDER BY rowid').all(),
    budgetOutcomes: f.db.prepare('SELECT authorization_id,outcome_hash,kind,record FROM threaded_budget_outcomes ORDER BY rowid').all(),
    budgetRequests: f.db.prepare('SELECT id,execution_state,usage_state,outcome_hash,outcome_kind FROM threaded_budget_requests ORDER BY rowid').all(),
    foreignKeys: f.db.pragma('foreign_key_check'),
  };
}
async function fixture(name, fetch) {
  const f = await openBackendRuntimeFixture(root, name, { agentIds: ['api-member'], fetch });
  fixtures.push(f);
  const receipt = f.user(`RC05 ${name}`), budgetRoot = f.runtime.budget.ensureRootForMessage(receipt.message.id);
  assert.equal(budgetRoot.policy.activityAllowanceMs, 1000);
  return { f, budgetRoot };
}
function revise(f, budgetRoot, patch) {
  const revised = f.runtime.reviseRoot({ ownerId: f.thread.ownerId, rootId: budgetRoot.id,
    expectedVersion: budgetRoot.version, requestId: randomUUID(), reason: 'RC05 disposable explicit activity acceptance', patch });
  const after = f.runtime.budget.getRoot(budgetRoot.id);
  for (const [key, value] of Object.entries(budgetRoot.policy)) if (!(key in patch)) assert.deepEqual(after.policy[key], value);
  return { receipt: revised, policy: after.policy };
}
function armPreparation(f) {
  const configuration = f.configurations.get('api-member'), instructions = configuration.instructions;
  let armed = true;
  const events = [];
  Object.defineProperty(configuration, 'instructions', { configurable: true, get() {
    if (armed && f.db.prepare("SELECT 1 FROM threaded_budget_activity WHERE state='active'").get()) {
      armed = false; events.push(synchronousPreparation());
    }
    return instructions;
  } });
  return events;
}
async function execute(f) {
  const claim = f.runtime.queue.claimNext(`rc05-activity:${process.pid}`); assert.ok(claim);
  const began = performance.now(), result = await f.runtime.executeClaim(claim);
  return { elapsedMs: performance.now() - began, result, binding: claim.binding };
}
async function assertNoReplay(f, providerCount) {
  const before = snapshot(f), attempts = before.counts.threaded_attempts;
  f.reopen(); f.runtime.recover(); f.runtime.recover();
  assert.equal(f.runtime.queue.claimNext(`rc05-activity-recovery:${process.pid}`), null);
  const after = snapshot(f);
  assert.equal(after.counts.threaded_attempts, attempts);
  assert.equal(after.counts.threaded_backend_requests, before.counts.threaded_backend_requests);
  assert.equal(after.counts.threaded_outputs, before.counts.threaded_outputs);
  assert.equal(after.counts.threaded_invocation_terminals, before.counts.threaded_invocation_terminals);
  assert.deepEqual(after.budgetOutcomes, before.budgetOutcomes, 'Recovery must preserve the first unknown cause and immutable budget hashes');
  assert.deepEqual(after.budgetRequests, before.budgetRequests, 'Recovery must preserve all unknown reservations and settlement identities');
  assert.deepEqual(after.attempts, before.attempts, 'Recovery must not replace the original unknown cause');
  return { before, after, injectedProviderCalls: providerCount() };
}
function check(id, description, data) {
  checks.push({ id, description, passed: true }); evidence.push({ id, ...data });
}
try {
  assert.equal(DEFAULT_THREADED_BUDGET.activityAllowanceMs, 1000);
  {
    let calls = 0;
    const { f, budgetRoot } = await fixture('default-async-progress', async () => { calls++; await delay(1600); return response(); });
    const execution = await execute(f), state = snapshot(f), usage = f.runtime.budget.getUsage(budgetRoot.id);
    assert.equal(execution.result.status, 'completed'); assert.equal(calls, 1); assert.ok(execution.elapsedMs >= 1600);
    assert.equal(state.counts.threaded_invocation_terminals, 1); assert.equal(state.requests[0].state, 'complete');
    assert.equal(usage.actualRequests, 1); assert.equal(usage.outputTokens, 7); assert.equal(usage.unknownRequests, 0);
    assert.ok(usage.activityMs >= 1600); assert.equal(usage.activityReservedMs, 0);
    check('ACT01', 'Default 1000ms renewable slices preserve one asynchronous 1600ms request through live runner checkpoints; exact receipt and terminal commit once.',
      { ...execution, state, usage, injectedProviderCalls: calls });
  }
  {
    let calls = 0;
    const { f, budgetRoot } = await fixture('default-sync-preparation-expired', async () => { calls++; return response(); });
    const work = armPreparation(f), execution = await execute(f), state = snapshot(f);
    assert.equal(work.length, 1); assert.ok(work[0].elapsedMs >= blockMs - 5);
    assert.notEqual(execution.result.status, 'completed'); assert.equal(calls, 0);
    assert.equal(state.counts.threaded_backend_requests, 0); assert.equal(state.counts.threaded_outputs, 0);
    assert.equal(state.counts.threaded_invocation_terminals, 0); assert.equal(state.attempts[0].execution_stage, 'unknown');
    const recovery = await assertNoReplay(f, () => calls); assert.equal(calls, 0);
    check('ACT02', 'A 1250ms synchronous preparation exceeds the default slice before provider request admission; it cannot publish success, release the unknown fence or silently replay after rebuilding.',
      { ...execution, synchronousWork: work, state, usage: f.runtime.budget.getUsage(budgetRoot.id), recovery });
  }
  {
    let calls = 0;
    const { f, budgetRoot } = await fixture('explicit-sync-preparation-allowed', async () => { calls++; return response(); });
    const policy = revise(f, budgetRoot, { activityAllowanceMs: 10_000 });
    const work = armPreparation(f), execution = await execute(f), state = snapshot(f), usage = f.runtime.budget.getUsage(budgetRoot.id);
    assert.equal(work.length, 1); assert.equal(execution.result.status, 'completed'); assert.equal(calls, 1);
    assert.equal(state.counts.threaded_invocation_terminals, 1); assert.equal(usage.actualRequests, 1); assert.equal(usage.outputTokens, 7);
    assert.equal(usage.unknownRequests, 0); assert.equal(usage.activityReservedMs, 0);
    check('ACT03', 'Explicit Owner CAS selects a 10000ms slice for the identical synchronous work; all other root limits remain equal and the response commits once.',
      { ...execution, synchronousWork: work, policy, state, usage, injectedProviderCalls: calls });
  }
  {
    let calls = 0, synchronousWork;
    const { f, budgetRoot } = await fixture('default-sync-after-send-expired', async () => {
      calls++; synchronousWork = synchronousPreparation(); return response();
    });
    const execution = await execute(f), state = snapshot(f);
    assert.notEqual(execution.result.status, 'completed'); assert.equal(calls, 1);
    assert.equal(state.counts.threaded_backend_requests, 1); assert.equal(state.requests[0].state, 'unknown');
    assert.equal(state.counts.threaded_outputs, 0); assert.equal(state.counts.threaded_invocation_terminals, 0);
    assert.equal(state.attempts[0].execution_stage, 'unknown');
    const recovery = await assertNoReplay(f, () => calls); assert.equal(calls, 1);
    const usage = f.runtime.budget.getUsage(budgetRoot.id); assert.equal(usage.actualRequests, 1); assert.equal(usage.unknownRequests, 1);
    check('ACT04', 'After durable request admission, a blocked event loop expires the slice; late response parsing fails closed, preserves unknown request/usage and never automatically sends again.',
      { ...execution, synchronousWork, state, usage, recovery });
  }
  {
    let calls = 0;
    const { f, budgetRoot } = await fixture('explicit-slice-original-deadline', async () => { calls++; return response(); });
    const policy = revise(f, budgetRoot, { activityAllowanceMs: 10_000, deadlineAt: Date.now() + 1000 });
    const work = armPreparation(f), execution = await execute(f), state = snapshot(f);
    assert.equal(work.length, 1); assert.notEqual(execution.result.status, 'completed'); assert.equal(calls, 0);
    assert.equal(state.counts.threaded_backend_requests, 0); assert.equal(state.counts.threaded_outputs, 0);
    const recovery = await assertNoReplay(f, () => calls); assert.equal(calls, 0);
    check('ACT05', 'An explicit 10000ms slice remains bounded by its original absolute deadline; synchronous preparation crossing it cannot send or revive on recovery.',
      { ...execution, synchronousWork: work, policy, state, usage: f.runtime.budget.getUsage(budgetRoot.id), recovery });
  }
  assert.equal(forbiddenNetworkCalls, 0);
  const report = { ok: true, groups: checks.length, productionDefaultActivityAllowanceMs: 1000,
    mainIndexProcess: false, realClock: true, injectedSynchronousWorkMs: blockMs, realSupplierRequests: 0,
    realSupplierTokens: 0, remoteWrites: 0, forbiddenNetworkCalls, checks, evidence,
    limitations: ['Production backend runtime and SQLite are exercised with injected transport and deliberately blocked synchronous preparation.',
      'The default 1000ms slice is unchanged; ACT02 is an availability limitation, not a successful long-preparation execution.',
      'Explicit Owner selection of a longer slice does not prove a different target release configuration, provider or native SDK is accepted.'] };
  const output = path.resolve(process.env.THREADED_RC05_ACTIVITY_OUTPUT ?? 'docs/reports/evidence/threaded-rc05/activity.json');
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, evidence: undefined, output }, null, 2));
} finally {
  for (const f of fixtures) if (f.db.open) f.close();
  await rm(root, { recursive: true, force: true });
}
