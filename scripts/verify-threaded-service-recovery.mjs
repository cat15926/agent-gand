import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-t12-service-')));
const workers = [], checks = [], evidence = [], checkpoints = [];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deadline = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`T12 timeout: ${label}`)), 20_000); })])
    .finally(() => clearTimeout(timer));
};
async function worker(name, restore = false, clock = Date.now() + 60_000) {
  const child = fork(new URL('./fixtures/threadedT12ServiceWorker.mjs', import.meta.url),
    [root, name, restore ? 'restore' : 'new', String(clock)], {
      execArgv: ['--import', new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url).pathname],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env } });
  let stderr = '', sequence = 0, readyResolve, readyReject, exitResolve;
  const pending = new Map(), events = [], waiters = [];
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exit = new Promise(resolve => { exitResolve = resolve; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('message', message => {
    if (message.ready) { readyResolve(message); return; }
    if (message.event) {
      const index = waiters.findIndex(waiter => waiter.name === message.event);
      if (index < 0) events.push(message); else waiters.splice(index, 1)[0].resolve(message);
      return;
    }
    const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve(message.result);
  });
  child.on('error', error => { readyReject(error); for (const value of pending.values()) value.reject(error); });
  child.on('exit', (code, signal) => {
    const error = Object.assign(new Error(`T12 worker exited ${code}/${signal}: ${stderr}`), { code, signal });
    readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear();
    exitResolve({ code, signal });
  });
  const readyState = await deadline(ready, `${name} startup`);
  checkpoints.push({ name, pid: readyState.pid, restore, composition: readyState.composition, mainIndex: false,
    externalProviders: false, transport: readyState.transport });
  const w = { child, name, readyState, exit,
    call(operation, ...args) { return deadline(new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, operation, args });
    }), `${name} ${operation}`); },
    event(name) { const index = events.findIndex(event => event.event === name);
      return deadline(index >= 0 ? Promise.resolve(events.splice(index, 1)[0]) : new Promise(resolve => waiters.push({ name, resolve })), `${name} event`); },
    async kill() { child.kill('SIGKILL'); const status = await deadline(exit, `${name} SIGKILL`); assert.equal(status.signal, 'SIGKILL'); return status; },
    async close() { if (child.exitCode !== null || child.signalCode) return; await w.call('close'); await deadline(exit, `${name} close`); },
  };
  workers.push(w); return w;
}
async function snapshot(w, label) {
  const value = await w.call('snapshot');
  assert.equal(value.forbiddenNetworkCalls, 0); assert.deepEqual(value.foreignKeys, []);
  evidence.push({ label, process: w.readyState.pid, ...value, digest: hash(value) }); return value;
}
async function recover(w) { await w.call('recover'); await w.call('recover'); }
const check = (id, description) => checks.push({ id, description, passed: true });
const count = (s, table) => s.counts[table];
async function run(w, plan = {}) {
  const claim = await w.call('claim'); assert.ok(claim, `${w.name}: runnable source`);
  const result = await w.call('execute', claim, plan); assert.equal(result.outcome.status, 'completed', JSON.stringify(result)); return result;
}
try {
  {
    const w = await worker('message-before-notification');
    const crashed = w.call('acceptAndDie', 'T12_DURABLE_BEFORE_NOTIFICATION').catch(error => error);
    assert.equal((await w.exit).signal, 'SIGKILL'); await crashed;
    const resumed = await worker(w.name, true); await recover(resumed);
    const before = await snapshot(resumed, 'message committed before any notification or model request; fresh service recovery');
    assert.equal(count(before, 'threaded_messages'), 1); assert.equal(count(before, 'threaded_wakes'), 1);
    assert.equal(count(before, 'fixture_t12_requests'), 0); assert.equal(before.queue.length, 1);
    await run(resumed); const after = await snapshot(resumed, 'recovered durable source executed exactly once');
    assert.equal(count(after, 'fixture_t12_requests'), 1); assert.equal(count(after, 'threaded_invocation_terminals'), 1);
    await recover(resumed); assert.equal(await resumed.call('claim'), null); await resumed.close();
    check('SR01', 'Actual API/backend service composition SIGKILL immediately after message COMMIT and before its scheduled notification; new process recovers one Wake and one execution.');
  }
  {
    const w = await worker('claimed-not-sent'); const receipt = await w.call('accept', 'T12_NOT_SENT');
    const first = await w.call('claim'); assert.ok(first); await w.kill();
    const resumed = await worker(w.name, true, w.readyState.clock + 120_000); await recover(resumed);
    const before = await snapshot(resumed, 'prepared process died; trusted not-started recovery');
    assert.equal(count(before, 'fixture_t12_requests'), 0);
    const second = await resumed.call('claim'); assert.ok(second, JSON.stringify(before.queue));
    assert.equal(second.binding.invocationId, first.binding.invocationId); assert.equal(second.binding.runId, first.binding.runId);
    assert.notEqual(second.binding.attemptId, first.binding.attemptId); assert.equal(second.queue.causalRootId, receipt.message.causalRootId);
    assert.equal((await resumed.call('execute', second, {})).outcome.status, 'completed');
    const after = await snapshot(resumed, 'same Invocation/Run/root with replacement Attempt; exactly one synthetic send');
    assert.equal(count(after, 'runs'), 1); assert.equal(count(after, 'threaded_attempts'), 2); assert.equal(count(after, 'fixture_t12_requests'), 1);
    const usage = await resumed.call('budgetUsage', receipt.message.causalRootId); assert.equal(usage.actualRequests, 1); assert.equal(usage.attempts, 2);
    await resumed.close(); check('SR02', 'Prepared-but-not-sent crash retries only a new Attempt within the same Invocation, Run and causal budget root.');
  }
  {
    const w = await worker('request-maybe-sent'); const receipt = await w.call('accept', 'T12_UNKNOWN_REQUEST');
    const claim = await w.call('claim'); const running = w.call('execute', claim, { holdRequest: true }).catch(error => error);
    await w.event('request-started'); await w.kill(); await running;
    const resumed = await worker(w.name, true, w.readyState.clock + 120_000); await recover(resumed);
    const before = await snapshot(resumed, 'request barrier crossed then SIGKILL; unknown persists on first restart');
    assert.equal(count(before, 'fixture_t12_requests'), 1); assert.equal(before.queue[0].state, 'unknown');
    assert.equal(before.attempts[0].execution_stage, 'unknown'); assert.equal(before.claims[0].state, 'unknown');
    assert.equal(await resumed.call('claim'), null);
    await resumed.call('clock', w.readyState.clock + 86_400_000); await recover(resumed);
    assert.equal(await resumed.call('claim'), null);
    const usage = await resumed.call('budgetUsage', receipt.message.causalRootId);
    assert.equal(usage.actualRequests, 1); assert.equal(usage.unknownRequests, 1);
    const after = await snapshot(resumed, 'one-day lease aging and repeated recovery cannot prove no-send or replay request');
    assert.equal(count(after, 'threaded_attempts'), 1); assert.equal(count(after, 'threaded_invocation_terminals'), 0);
    assert.ok(usage.outputTokens >= 256); await resumed.close();
    check('SR03', 'Possible-send crash stays unknown with reserved budget and resource fences; repeated restart/TTL never issues another request or false terminal.');
  }
  {
    const w = await worker('response-successor-committed'); const receipt = await w.call('accept', 'T12_SUCCESSOR');
    const claim = await w.call('claim');
    const running = w.call('execute', claim, { body: '@other-member T12_COMMITTED_SUCCESSOR', killAfterCommit: true }).catch(error => error);
    assert.equal((await w.exit).signal, 'SIGKILL'); await running;
    const resumed = await worker(w.name, true, w.readyState.clock + 120_000); await recover(resumed);
    const before = await snapshot(resumed, 'terminal, final message and successor committed before release; fresh process repairs release only');
    assert.equal(count(before, 'fixture_t12_requests'), 1); assert.equal(count(before, 'threaded_invocation_terminals'), 1);
    assert.equal(before.messages.filter(message => message.body === '@other-member T12_COMMITTED_SUCCESSOR').length, 1);
    assert.equal(before.attempts[0].resource_release_state, 'released');
    const second = await resumed.call('claim'); assert.ok(second); assert.equal(second.binding.agentId, 'other-member');
    assert.equal(second.queue.causalRootId, receipt.message.causalRootId);
    assert.equal((await resumed.call('execute', second, {})).outcome.status, 'completed');
    await recover(resumed); assert.equal(await resumed.call('claim'), null);
    const after = await snapshot(resumed, 'successor executes once under original root; original response never replayed');
    assert.equal(count(after, 'fixture_t12_requests'), 2); assert.equal(count(after, 'threaded_invocation_terminals'), 2);
    assert.equal(count(after, 'threaded_budget_roots'), 1);
    const usage = await resumed.call('budgetUsage', receipt.message.causalRootId); assert.equal(usage.actualRequests, 2); assert.equal(usage.outputTokens, 14);
    await resumed.close(); check('SR04', 'Post-response COMMIT crash reconstructs terminal/release/projection and preserves one successor with the original cumulative causal budget.');
  }
  {
    for (const restriction of [null, 'permission']) {
      const w = await worker(`multi-mention-${restriction ?? 'partial'}`); await w.call('accept', 'T12_CONSULTATION');
      await run(w, { tools: [{ name: 'multi_mention', input: { idempotencyKey: 't12-consult',
        targets: ['other-member', 'fourth-member'], question: 'Retain different answers across service restart',
        callbackTo: 'api-member', timeoutMinutes: 3, overrideReason: 'T12 isolated fresh question' } }] });
      const group = (await w.event('tools-complete')).results[0]; await run(w, { body: 'T12_FIRST_DIFFERING_ANSWER' });
      if (restriction) await w.call('restrict', restriction); await w.kill();
      const resumed = await worker(w.name, true, group.deadline + 1); await recover(resumed);
      const after = await snapshot(resumed, `partial MM restart at original deadline; ${restriction ?? 'authorized callback'}`);
      assert.equal(count(after, 'fixture_t12_requests'), 2); assert.equal(after.settlements.length, 1);
      assert.equal(after.settlements[0].kind, 'partial');
      assert.equal(after.settlements[0].responses.filter(response => response.status === 'timeout').length, 1);
      assert.ok(JSON.stringify(after.settlements).includes('T12_FIRST_DIFFERING_ANSWER'));
      assert.equal(after.callbacks.length, 1); assert.equal(after.callbacks[0].state, restriction ? 'rejected' : 'delivered');
      await recover(resumed); const repeated = await snapshot(resumed, 'MM repeated recovery remains one settlement/callback and no model replay');
      assert.equal(count(repeated, 'threaded_consultation_settlements'), 1); assert.equal(count(repeated, 'threaded_collaboration_callbacks'), 1);
      await resumed.close();
    }
    check('SR05', 'Partial multi_mention survives SIGKILL, times out only missing targets at its original deadline, settles/calls back once, and rejects a callback after permission drift.');
  }
  {
    const w = await worker('approval-restart'); await w.call('login'); await w.call('accept', 'T12_APPROVAL');
    const claim = await w.call('claim'); const running = w.call('execute', claim, { approval: true }).catch(error => error);
    const pending = await w.event('approval-pending'); const oldAuth = await w.call('login');
    await w.kill(); await running;
    const resumed = await worker(w.name, true, w.readyState.clock + 120_000); await recover(resumed);
    const threadId = resumed.readyState.thread.id;
    const staleSession = await resumed.call('api', '/api/threaded/session', undefined, oldAuth, 'GET'); assert.equal(staleSession.statusCode, 401);
    await resumed.call('login');
    const approved = await resumed.call('api', `/api/threaded/threads/${threadId}/approvals/${pending.approval.id}/decision`,
      { decision: 'approve', requestId: 't12-post-restart-approve' });
    assert.equal(approved.statusCode, 409, JSON.stringify(approved)); assert.equal(await resumed.call('claim'), null);
    const after = await snapshot(resumed, 'stale Owner session expires; reauthenticated approve cannot revive old driver or unknown request');
    assert.equal(after.approvals[0].status, 'expired'); assert.equal(count(after, 'fixture_t12_requests'), 1);
    assert.equal(count(after, 'threaded_invocation_terminals'), 0); await resumed.close();
    check('SR06', 'Approval-wait SIGKILL expires in-memory login and old approval authority; fresh authenticated Owner approve is rejected and cannot restart an unknown driver.');
  }
  {
    for (const restriction of ['member-left', 'account', 'stop']) {
      const w = await worker(`revoke-${restriction}`); await w.call('accept', `T12_REVOKE_${restriction}`);
      await w.call('restrict', restriction); await w.kill();
      const resumed = await worker(w.name, true, w.readyState.clock + 120_000); await recover(resumed);
      assert.equal(await resumed.call('claim'), null); const after = await snapshot(resumed, `${restriction} survives process restart`);
      assert.equal(count(after, 'fixture_t12_requests'), 0); assert.equal(count(after, 'threaded_attempts'), 0);
      assert.equal(count(after, 'execution_resource_claims'), 0); await resumed.close();
    }
    check('SR07', 'Departed member, disabled/revoked account and stopped Thread remain denied across restart before creating any Attempt/resource/provider send.');
  }
  {
    const w = await worker('storage-fail-closed'); await w.call('login');
    const before = await snapshot(w, 'before real SQLite query_only storage failure'); await w.call('queryOnly', true);
    const posted = await w.call('api', `/api/threaded/threads/${w.readyState.thread.id}/messages`,
      { clientRequestId: randomUUID(), body: 'T12_MUST_NOT_REPORT_SAVED', targets: ['api-member'] });
    assert.equal(posted.statusCode, 500); assert.equal(posted.body.code, 'THREADED_OPERATION_FAILED');
    await w.call('queryOnly', false); const after = await snapshot(w, 'HTTP failure creates no message/Wake/outbox/attempt or false success');
    assert.deepEqual(after.counts, before.counts); assert.equal(await w.call('claim'), null);
    await w.kill(); const resumed = await worker(w.name, true); await recover(resumed);
    const fresh = await snapshot(resumed, 'fresh process finds no phantom successful message');
    assert.equal(count(fresh, 'threaded_messages'), 0); assert.equal(count(fresh, 'fixture_t12_requests'), 0);
    await resumed.close(); check('SR08', 'Actual readonly SQLite HTTP submission fails closed with no durable partial message, Wake, outbox, execution or phantom success after restart.');
  }
  {
    const w = await worker('mixed-mode-isolation'); await w.call('login');
    const before = await snapshot(w, 'legacy message coexists in the same isolated service database');
    await w.call('accept', 'T12_THREADED_ONLY'); await run(w); await w.kill();
    const resumed = await worker(w.name, true); await recover(resumed); await resumed.call('login');
    const view = await resumed.call('api', `/api/threaded/threads/${resumed.readyState.thread.id}/view`, undefined, undefined, 'GET');
    assert.equal(view.statusCode, 200); assert.ok(!JSON.stringify(view.body).includes('T12_LEGACY_ONLY'));
    const after = await snapshot(resumed, 'restored real HTTP projection omits legacy tables and keeps them unchanged');
    assert.deepEqual(after.legacy, before.legacy); assert.equal(count(after, 'fixture_t12_requests'), 1);
    const caps = await resumed.call('api', '/api/threaded/capabilities', undefined, undefined, 'GET');
    assert.equal(caps.body.implemented.execution, false); assert.equal(caps.body.implemented.admission, false);
    await resumed.close(); check('SR09', 'Mixed legacy/threaded data remains isolated through SIGKILL and authenticated HTTP projection; production capability declarations remain closed.');
  }
  const result = { ok: true, groups: checks.length, checks, actualChildProcesses: checkpoints.length,
    composition: 'Fastify registered HTTP routes + authenticated access + real backendRuntime/lifecycle/collaboration/view',
    mainIndexProcess: false, modelTransport: 'injected deterministic Anthropic Messages response',
    realModelCalls: 0, realSupplierTokens: 0, remoteWrites: 0, forbiddenNetworkCalls: 0,
    limitations: ['This fixture composes production modules inside a real child process; it is not apps/server/src/index.ts.',
      'Supplier transport is injected. No provider, native SDK, external process resumption or remote PR write is exercised.',
      'An approval cannot restore a driver that died after possible send; such approval expires and the Invocation remains unknown.'],
    checkpoints, evidence };
  const output = path.resolve('docs/reports/evidence/threaded-t12-service-recovery/isolated.json');
  await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, checkpoints: undefined, evidence: undefined, output }, null, 2));
} finally {
  for (const w of workers) if (w.child.exitCode === null && !w.child.signalCode) { w.child.kill('SIGKILL'); await w.exit; }
  await rm(root, { recursive: true, force: true });
}
