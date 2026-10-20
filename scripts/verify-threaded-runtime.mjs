import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { isolateRuntimeFixture, openRuntimeFixture, runtimeFixtureNetworkAttempts } from './fixtures/threadedRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-runtime-')));
const originalFetch = globalThis.fetch;
isolateRuntimeFixture(root);
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedDispatcher } = await import('../apps/server/src/threaded/dispatcher.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const fixtures = [], children = [], dispatchers = [], checks = [];
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const snapshot = (db, tables) => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const deadline = (promise, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000); })])
    .finally(() => clearTimeout(timer));
};

async function fixture(name, options = {}) {
  const databasePath = path.join(root, `${name}.sqlite`), seed = new Database(databasePath);
  seed.pragma('foreign_keys = ON'); seed.pragma('journal_mode = WAL'); seed.exec(schema);
  seed.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER'); applyOrchestrationSchemaMigrations(seed);
  const now = new Date().toISOString();
  if (options.withAccount) seed.prepare(`INSERT INTO accounts
    (id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at)
    VALUES('fixture-account','Fixture','mock','api_key','managed',1,1,1,?,?)`).run(now, now);
  for (const id of ['aa', 'bb', 'cc']) seed.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, model: 'mock:fixture', version: 1,
      enabled: true, tools: [], permissionMode: 'readonly', systemPrompt: 'No external calls',
      ...(options.withAccount ? { accountRef: 'fixture-account' } : {}) }), now, now);
  seed.exec(`CREATE TABLE fixture_external_calls(attempt_id TEXT PRIMARY KEY,invocation_id TEXT NOT NULL,created_at INTEGER NOT NULL)`);
  const store = createThreadedStore(seed);
  const thread = store.createThread({ title: name, members: ['aa', 'bb', 'cc'].map(agentId => ({
    agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
  })) });
  seed.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  seed.close();
  const f = await openRuntimeFixture(databasePath, options);
  fixtures.push(f);
  const user = (values = {}) => ({ ownerId: thread.ownerId, threadId: thread.id,
    clientRequestId: randomUUID(), body: name, targets: ['aa'], ...values });
  return { ...f, databasePath, thread, ownerId: thread.ownerId, user };
}

function completedOutcome(f, claim, changes = {}) {
  f.runtime.lifecycle.startAttempt(claim.binding);
  f.db.prepare('INSERT INTO fixture_external_calls(attempt_id,invocation_id,created_at) VALUES(?,?,?)')
    .run(claim.binding.attemptId, claim.binding.invocationId, Date.now());
  return { kind: 'completed', content: 'atomic response for bb', response: { targets: ['bb'] }, budgetState: 'settled',
    budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${claim.binding.attemptId}` },
    quiescence: f.proof(claim.binding), ...changes };
}
const executedResponse = (input, context) => ({
  kind: 'completed', content: `active notification response ${input.binding.attemptId}`, budgetState: 'settled',
  budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${input.binding.attemptId}` },
  quiescence: context.proof(input.binding),
});
async function flushRuntime(runtime) {
  // Yield only to already-scheduled commit notifications. This is not a repair
  // poll or a manual queue/drain hint.
  await new Promise(resolve => setImmediate(resolve));
  await deadline(runtime.whenIdle(), 'committed notification drain');
}

async function worker(databasePath) {
  const child = fork(fileURLToPath(new URL('./fixtures/threadedRuntimeWorker.mjs', import.meta.url)), [databasePath, `runtime-worker:${randomUUID()}`], {
    execArgv: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url))],
    env: { ...process.env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.push(child);
  let sequence = 0, stderr = '', readyResolve, readyReject;
  const pending = new Map(), ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stderr.on('data', value => { stderr += value; });
  const failed = error => { readyReject(error); for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on('message', message => {
    if (message.ready) { readyResolve(); return; }
    const waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else waiter.resolve(message.result);
  });
  child.on('error', failed);
  child.on('exit', code => failed(Object.assign(new Error(`Runtime fixture worker exited ${code}: ${stderr}`), { exitCode: code })));
  await deadline(ready, 'worker ready');
  const call = (operation, ...args) => deadline(new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, operation, args });
  }), `worker ${operation}`);
  return { call, close: () => child.connected ? call('close') : Promise.resolve() };
}

try {
  {
    const f = await fixture('same-wake-workers');
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    const a = await worker(f.databasePath), b = await worker(f.databasePath);
    const [qa, qb] = await Promise.all([a.call('enqueueWake', receipt.wakes[0].id), b.call('enqueueWake', receipt.wakes[0].id)]);
    assert.deepEqual(qb, qa);
    const claims = await Promise.all([a.call('claimNext'), b.call('claimNext')]);
    assert.equal(claims.filter(Boolean).length, 1, JSON.stringify(f.runtime.queue.getQueue(qa.id)));
    const winner = claims[0] ? a : b, claim = claims.find(Boolean);
    assert.equal(count(f.db, 'threaded_wake_queue'), 1);
    assert.equal(count(f.db, 'threaded_invocation_wakes'), 1);
    assert.equal(count(f.db, 'threaded_invocations'), 1);
    assert.equal(count(f.db, 'runs'), 1); assert.equal(count(f.db, 'threaded_attempts'), 1);
    assert.equal(count(f.db, 'execution_resource_claims'), 1);
    assert.equal(count(f.db, 'fixture_external_calls'), 0);
    const result = await winner.call('executeClaim', claim);
    assert.equal(result.status, 'completed');
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    assert.equal(f.runtime.queue.getQueue(qa.id).state, 'settled');
    assert.equal(await a.call('claimNext'), null); assert.equal(await b.call('claimNext'), null);
    assert.equal(f.runtime.queue.enqueueWake(receipt.wakes[0].id).id, qa.id);
    assert.equal(count(f.db, 'threaded_attempts'), 1);
    await a.close(); await b.close();
    checks.push('Q01/DB01: two real SQLite IPC workers map the same Wake once, claim exactly one Invocation/Run/Attempt/resource, execute once and cannot claim its settled source again');
  }

  {
    const f = await fixture('distinct-wakes-same-text');
    const one = f.runtime.messages.acceptUserMessage(f.user({ body: 'identical text' }));
    const two = f.runtime.messages.acceptUserMessage(f.user({ body: 'identical text' }));
    const qa = f.runtime.queue.enqueueWake(one.wakes[0].id), qb = f.runtime.queue.enqueueWake(two.wakes[0].id);
    assert.notEqual(qa.id, qb.id); assert.ok(qa.seq < qb.seq);
    const first = f.runtime.queue.claimNext('same-slot');
    assert.equal(first.queue.id, qa.id);
    assert.equal(f.runtime.queue.claimNext('same-slot'), null);
    await f.runtime.executeClaim(first);
    const second = f.runtime.queue.claimNext('same-slot');
    assert.ok(second, JSON.stringify(f.runtime.queue.getQueue(qb.id)));
    assert.equal(second.queue.id, qb.id);
    assert.notEqual(first.binding.invocationId, second.binding.invocationId);
    assert.notEqual(first.binding.runId, second.binding.runId);
    await f.runtime.executeClaim(second);
    assert.equal(count(f.db, 'threaded_invocation_wakes'), 2);
    assert.equal(count(f.db, 'runs'), 2); assert.equal(count(f.db, 'fixture_external_calls'), 2);
    assert.notEqual(first.queue.causalRootId, second.queue.causalRootId);
    checks.push('Distinct same-text user sources remain independent Wake/Invocation/Run/root identities and preserve same-slot FIFO');
  }

  {
    const f = await fixture('drain-empty-boundary');
    let injected = false, scans = 0, dispatcher;
    dispatcher = createThreadedDispatcher({
      claimNext() {
        scans++;
        const claim = f.runtime.queue.claimNext('empty-boundary');
        if (!claim && !injected) {
          injected = true;
          const receipt = f.runtime.messages.acceptUserMessage(f.user());
          f.runtime.queue.enqueueWake(receipt.wakes[0].id);
          // Enqueue fires the subscription while the last empty scan is still
          // on the stack. Returning null must not clear that request.
        }
        return claim;
      },
      execute: claim => f.runtime.executeClaim(claim),
      onWake: callback => f.runtime.queue.onAvailable(callback),
      onAvailable: callback => f.resources.onAvailable(callback),
      repairIntervalMs: 0,
    });
    dispatchers.push(dispatcher);
    dispatcher.wakeup();
    await deadline(dispatcher.whenIdle(), 'empty-boundary reentrant wake');
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    assert.ok(scans >= 2); assert.equal(dispatcher.diagnostics().lastError, null);
    checks.push('Q05: durable enqueue reenters the final empty drain scan and still runs immediately with repair polling disabled');
  }

  {
    let releaseFirst, sawFirstResolve;
    const sawFirst = new Promise(resolve => { sawFirstResolve = resolve; });
    const f = await fixture('drain-release-enqueue', { execute: async (input, context) => {
      if (!releaseFirst) {
        await new Promise(resolve => { releaseFirst = resolve; sawFirstResolve(); });
      }
      return { kind: 'completed', content: `release response ${input.binding.attemptId}`, budgetState: 'settled',
        budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${input.binding.attemptId}` },
        quiescence: context.proof(input.binding) };
    } });
    const first = f.runtime.messages.acceptUserMessage(f.user());
    const second = f.runtime.messages.acceptUserMessage(f.user());
    f.runtime.queue.enqueueWake(first.wakes[0].id); f.runtime.queue.enqueueWake(second.wakes[0].id);
    let insertedAtRelease = false;
    const unsubscribe = f.resources.onAvailable(event => {
      if (insertedAtRelease || !/release/.test(event.reason)) return;
      insertedAtRelease = true;
      const third = f.runtime.messages.acceptUserMessage(f.user());
      f.runtime.queue.enqueueWake(third.wakes[0].id);
    });
    const claimed = [];
    const dispatcher = createThreadedDispatcher({
      claimNext() { const claim = f.runtime.queue.claimNext('release-boundary'); if (claim) claimed.push(claim.queue.seq); return claim; },
      execute: claim => f.runtime.executeClaim(claim),
      onWake: callback => f.runtime.queue.onAvailable(callback), onAvailable: callback => f.resources.onAvailable(callback),
      repairIntervalMs: 0,
    });
    dispatchers.push(dispatcher);
    dispatcher.wakeup(); await deadline(sawFirst, 'first execution started');
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    releaseFirst(); await deadline(dispatcher.whenIdle(), 'release/enqueue drain');
    unsubscribe();
    assert.equal(insertedAtRelease, true); assert.equal(count(f.db, 'fixture_external_calls'), 3);
    assert.deepEqual(claimed, [...claimed].sort((a, b) => a - b));
    assert.equal(dispatcher.diagnostics().lastError, null);
    checks.push('Q05: work queued during active execution and synchronously during resource release drains without a repair timer or lost wake, retaining FIFO');
  }

  {
    const f = await fixture('crash-before-start');
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    f.runtime.queue.enqueueWake(receipt.wakes[0].id);
    const crashed = await worker(f.databasePath), first = await crashed.call('claimNext');
    assert.ok(first); assert.equal(count(f.db, 'fixture_external_calls'), 0);
    await assert.rejects(crashed.call('exitPrepared'), error => error.exitCode === 24);
    f.setClock(Date.now() + 120_000);
    await f.runtime.recover();
    const second = f.runtime.queue.claimNext('after-prepared-crash');
    assert.ok(second);
    assert.equal(second.binding.invocationId, first.binding.invocationId);
    assert.equal(second.binding.runId, first.binding.runId);
    assert.equal(second.queue.causalRootId, first.queue.causalRootId);
    assert.notEqual(second.binding.attemptId, first.binding.attemptId);
    assert.equal(count(f.db, 'runs'), 1); assert.equal(count(f.db, 'threaded_attempts'), 2);
    assert.equal(count(f.db, 'fixture_external_calls'), 0);
    assert.equal(f.runtime.budget.getUsage(first.queue.causalRootId).actualRequests, 0);
    await f.runtime.executeClaim(second);
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    assert.equal(f.runtime.budget.getUsage(first.queue.causalRootId).actualRequests, 1);
    assert.equal(f.runtime.budget.getUsage(first.queue.causalRootId).attempts, 2);
    await f.runtime.recover(); await f.runtime.recover();
    assert.equal(f.runtime.queue.claimNext('no-third-call'), null);
    assert.equal(count(f.db, 'threaded_attempts'), 2);
    checks.push('REC02: real worker exits after durable preparation but before start; trusted not-started recovery retries a new Attempt in the same Invocation/Run/root and performs exactly one external fake call');
  }

  {
    const f = await fixture('crash-after-start');
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    const queued = f.runtime.queue.enqueueWake(receipt.wakes[0].id);
    const crashed = await worker(f.databasePath), first = await crashed.call('claimNext');
    await assert.rejects(crashed.call('startAndExit', first), error => error.exitCode === 23);
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    f.setClock(Date.now() + 120_000);
    await f.runtime.recover(); await f.runtime.recover();
    assert.equal(f.runtime.queue.getQueue(queued.id).state, 'unknown');
    assert.equal(f.resources.getClaim(first.binding.claimId).state, 'unknown');
    const unknownBudget = f.runtime.budget.getAuthorization(first.budgetAuthorization.id);
    assert.equal(unknownBudget.executionState, 'unknown');
    assert.equal(unknownBudget.usageState, 'unknown');
    const unknownUsage = f.runtime.budget.getUsage(first.queue.causalRootId);
    assert.equal(unknownUsage.actualRequests, 1); assert.equal(unknownUsage.unknownRequests, 1);
    assert.equal(unknownUsage.costMicrousd, 1000); assert.equal(unknownUsage.outputTokens, 100);
    assert.equal(f.runtime.queue.claimNext('after-started-crash'), null);
    f.setClock(Date.now() + 86_400_000);
    f.resources.recoverExpired(); await f.runtime.recover();
    assert.equal(f.runtime.queue.claimNext('ttl-never-proves-exit'), null);
    assert.equal(count(f.db, 'threaded_attempts'), 1); assert.equal(count(f.db, 'runs'), 1);
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 0);
    checks.push('REC03: a real worker exits after persisted start/possible request; repeated recovery and TTL retain unknown resource/budget fences without a second Attempt or model request');
  }

  {
    const f = await fixture('pause-input-and-resume');
    const control = action => f.runtime.lifecycle.requestControl({ ownerId: f.ownerId, scope: { kind: 'thread', threadId: f.thread.id },
      action, requestId: randomUUID() });
    control('pause');
    const one = f.runtime.messages.acceptUserMessage(f.user()), two = f.runtime.messages.acceptUserMessage(f.user());
    const qa = f.runtime.queue.enqueueWake(one.wakes[0].id), qb = f.runtime.queue.enqueueWake(two.wakes[0].id);
    assert.equal(f.runtime.queue.claimNext('paused'), null);
    assert.equal(count(f.db, 'runs'), 0); assert.equal(count(f.db, 'execution_resource_claims'), 0);
    assert.equal(count(f.db, 'fixture_external_calls'), 0);
    control('resume');
    const a = f.runtime.queue.claimNext('resumed');
    assert.ok(a); assert.equal(a.queue.id, qa.id); assert.equal(a.queue.seq, qa.seq);
    await f.runtime.executeClaim(a);
    const b = f.runtime.queue.claimNext('resumed');
    assert.ok(b); assert.equal(b.queue.id, qb.id); assert.equal(b.queue.seq, qb.seq);
    await f.runtime.executeClaim(b);
    assert.equal(count(f.db, 'fixture_external_calls'), 2);
    checks.push('Pause retains authorized messages and queued Wakes without resources or Runs; Owner resume restores their original FIFO age and executes each once');
  }

  {
    for (const restriction of ['closed', 'member-left', 'account-revoked']) {
      const f = await fixture(`deny-${restriction}`, { withAccount: restriction === 'account-revoked' });
      const receipt = f.runtime.messages.acceptUserMessage(f.user());
      f.runtime.queue.enqueueWake(receipt.wakes[0].id);
      if (restriction === 'closed') f.runtime.lifecycle.requestControl({ ownerId: f.ownerId,
        scope: { kind: 'thread', threadId: f.thread.id }, action: 'stop', requestId: randomUUID() });
      else if (restriction === 'member-left') f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='aa'").run(f.thread.id);
      else {
        f.db.prepare("INSERT INTO account_revocations(account_id,revoked_at) VALUES('fixture-account',?)").run(new Date().toISOString());
        f.runtime.lifecycle.revokeAccount('fixture-account');
      }
      assert.equal(f.runtime.queue.claimNext(`denied-${restriction}`), null);
      assert.equal(count(f.db, 'runs'), 0, restriction);
      assert.equal(count(f.db, 'threaded_attempts'), 0, restriction);
      assert.equal(count(f.db, 'execution_resource_claims'), 0, restriction);
      assert.equal(count(f.db, 'fixture_external_calls'), 0, restriction);
    }
    checks.push('Closed Thread, departed member and revoked account each stop previously queued work before any Run, Attempt, resource claim or external call');
  }

  {
    const faults = [
      ['threaded_outputs', 'INSERT', ''],
      ['threaded_invocation_terminals', 'INSERT', ''],
      ['threaded_invocations', 'UPDATE', "WHEN NEW.status='completed'"],
      ['threaded_attempts', 'UPDATE', "WHEN NEW.status='completed'"],
      ['runs', 'UPDATE', "WHEN NEW.status='completed'"],
      ['threaded_message_sequences', 'UPDATE', ''],
      ['threaded_messages', 'INSERT', "WHEN NEW.origin='agent_response'"],
      ['threaded_deliveries', 'INSERT', ''],
      ['threaded_wakes', 'INSERT', ''],
      ['threaded_outbox', 'INSERT', ''],
      ['threaded_wake_queue', 'UPDATE', "WHEN NEW.state='settled'"],
      ['threaded_queue_claims', 'UPDATE', "WHEN NEW.phase='settled'"],
      ['threaded_budget_requests', 'UPDATE', "WHEN NEW.usage_state='settled'"],
      ['threaded_budget_outcomes', 'INSERT', ''],
      ['threaded_budget_activity', 'UPDATE', "WHEN NEW.state='closed'"],
      ['threaded_budget_attempts', 'UPDATE', ''],
    ];
    for (const [table, operation, condition] of faults) {
      const f = await fixture(`terminal-rollback-${table}`);
      const receipt = f.runtime.messages.acceptUserMessage(f.user());
      f.runtime.queue.enqueueWake(receipt.wakes[0].id);
      const claim = f.runtime.queue.claimNext('terminal-fault');
      assert.ok(claim);
      const outcome = completedOutcome(f, claim);
      const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map(row => row.name).filter(name => /^(threaded_|execution_resource_|runs$|run_agents$|sqlite_sequence$)/.test(name));
      const before = snapshot(f.db, tables);
      f.db.exec(`CREATE TRIGGER fixture_terminal_fault BEFORE ${operation} ON ${table} ${condition}
        BEGIN SELECT RAISE(ABORT,'fixture_terminal_fault'); END;`);
      assert.throws(() => f.runtime.lifecycle.recordOutcome(claim.binding, outcome), /fixture_terminal_fault/, table);
      assert.deepEqual(snapshot(f.db, tables), before, table);
      assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'quiescent');
      assert.equal(count(f.db, 'fixture_external_calls'), 1);
      f.db.exec('DROP TRIGGER fixture_terminal_fault');
      const result = f.runtime.lifecycle.recordOutcome(claim.binding, outcome);
      assert.equal(result.status, 'completed', table);
      assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'released');
      assert.equal(count(f.db, 'threaded_outputs'), 1);
      assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
      assert.equal(count(f.db, 'threaded_messages'), 2);
      assert.equal(count(f.db, 'threaded_wakes'), 2);
      assert.equal(f.runtime.queue.getQueue(claim.queue.id).state, 'settled');
      const response = f.db.prepare("SELECT record FROM threaded_messages WHERE origin='agent_response'").get();
      assert.equal(JSON.parse(response.record).causalRootId, receipt.message.causalRootId);
      const committed = snapshot(f.db, tables);
      assert.equal(f.runtime.lifecycle.recordOutcome(claim.binding, outcome).status, 'completed');
      assert.deepEqual(snapshot(f.db, tables), committed, `duplicate outcome ${table}`);
      assert.equal(count(f.db, 'fixture_external_calls'), 1);
    }
    checks.push('REC06/ISO05: trigger failure at every response/output/terminal/projection/Delivery/Wake/Outbox/queue write rolls back all durable facts; same result retry commits once with inherited root and no second model execution');
  }

  {
    const faults = [
      ['execution_resource_claims', 'INSERT', ''], ['execution_resource_epochs', 'INSERT', ''],
      ['threaded_budget_invocations', 'INSERT', ''], ['threaded_budget_attempts', 'INSERT', ''],
      ['threaded_budget_requests', 'INSERT', ''], ['runs', 'INSERT', ''],
      ['threaded_run_bindings', 'INSERT', ''], ['threaded_attempts', 'INSERT', ''],
      ['threaded_execution_bindings', 'INSERT', ''], ['threaded_queue_claims', 'INSERT', ''],
      ['threaded_wake_queue', 'UPDATE', "WHEN NEW.state='claimed'"],
    ];
    const atomicTables = ['execution_resource_claims', 'execution_resource_epochs', 'threaded_budget_invocations',
      'threaded_budget_attempts', 'threaded_budget_requests', 'runs', 'threaded_run_bindings',
      'threaded_attempts', 'threaded_execution_bindings', 'threaded_queue_claims'];
    for (const [table, operation, condition] of faults) {
      const f = await fixture(`claim-rollback-${table}`);
      const receipt = f.runtime.messages.acceptUserMessage(f.user());
      const queued = f.runtime.queue.enqueueWake(receipt.wakes[0].id);
      f.db.exec(`CREATE TRIGGER fixture_claim_fault BEFORE ${operation} ON ${table} ${condition}
        BEGIN SELECT RAISE(ABORT,'fixture_claim_fault'); END;`);
      assert.throws(() => f.runtime.queue.claimNext('claim-fault'), /fixture_claim_fault/, table);
      for (const name of atomicTables) assert.equal(count(f.db, name), 0, `${table}: ${name}`);
      assert.notEqual(f.runtime.queue.getQueue(queued.id).state, 'claimed');
      assert.equal(count(f.db, 'fixture_external_calls'), 0);
      f.db.exec('DROP TRIGGER fixture_claim_fault');
      const claim = f.runtime.queue.claimNext('claim-retry');
      assert.ok(claim, table);
      assert.equal(count(f.db, 'threaded_invocations'), 1);
      for (const name of atomicTables) {
        if (name === 'execution_resource_epochs') {
          assert.ok(count(f.db, name) > 0);
          assert.ok(f.db.prepare('SELECT generation FROM execution_resource_epochs').all().every(row => row.generation === 1));
        } else assert.equal(count(f.db, name), 1, `${table}: retry ${name}`);
      }
      await f.runtime.executeClaim(claim);
    }
    checks.push('REC06: every claim/epoch/budget reservation/Run/binding/Attempt/dispatch write fails atomically; retry claims the original Wake once with no partial capacity or prior external execution');
  }

  {
    const f = await fixture('commit-then-crash-before-release');
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    const queued = f.runtime.queue.enqueueWake(receipt.wakes[0].id);
    const crashed = await worker(f.databasePath), claim = await crashed.call('claimNext');
    await assert.rejects(crashed.call('executeThenExitBeforeRelease', claim), error => error.exitCode === 25);
    assert.equal(f.runtime.queue.getQueue(queued.id).state, 'settled');
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    assert.equal(count(f.db, 'threaded_messages'), 2);
    assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'quiescent');
    assert.equal(f.db.prepare('SELECT resource_release_state FROM threaded_attempts WHERE id=?').get(claim.binding.attemptId).resource_release_state, 'pending');
    const frozen = snapshot(f.db, ['threaded_messages', 'threaded_deliveries', 'threaded_wakes', 'threaded_invocation_terminals',
      'threaded_outputs', 'threaded_budget_requests']);
    await f.runtime.recover(); await f.runtime.recover();
    assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'released');
    assert.equal(f.runtime.queue.claimNext('after-terminal-crash'), null);
    assert.deepEqual(snapshot(f.db, Object.keys(frozen)), frozen);
    assert.equal(count(f.db, 'fixture_external_calls'), 1); assert.equal(count(f.db, 'threaded_attempts'), 1);
    checks.push('REC04/REC05: real process exit after atomic response/terminal/budget COMMIT but before release/notification only replays durable cleanup and outbox; no second result, Attempt or model request');
  }

  {
    const f = await fixture('budget-blocked-fifo');
    const one = f.runtime.messages.acceptUserMessage(f.user()), two = f.runtime.messages.acceptUserMessage(f.user());
    const qa = f.runtime.queue.enqueueWake(one.wakes[0].id), qb = f.runtime.queue.enqueueWake(two.wakes[0].id);
    const rootA = f.runtime.budget.ensureRootForMessage(one.message.id);
    const paused = f.runtime.budget.reviseRoot({ ownerId: f.ownerId, rootId: rootA.id, expectedVersion: rootA.version,
      requestId: randomUUID(), reason: 'fixture budget hold', state: 'paused' });
    // B is also paused so restoring A can prove its original age before either
    // candidate consumes capacity.
    const rootB = f.runtime.budget.ensureRootForMessage(two.message.id);
    const pausedB = f.runtime.budget.reviseRoot({ ownerId: f.ownerId, rootId: rootB.id, expectedVersion: rootB.version,
      requestId: randomUUID(), reason: 'fixture budget hold', state: 'paused' });
    assert.equal(f.runtime.queue.claimNext('budget-blocked'), null);
    assert.equal(f.runtime.queue.getQueue(qa.id).state, 'blocked');
    assert.equal(count(f.db, 'runs'), 0); assert.equal(count(f.db, 'execution_resource_claims'), 0);
    assert.equal(count(f.db, 'threaded_budget_requests'), 0);
    for (const current of [pausedB, paused]) f.runtime.budget.reviseRoot({ ownerId: f.ownerId, rootId: current.id,
      expectedVersion: current.version, requestId: randomUUID(), reason: 'Owner resumes original root', state: 'open' });
    const a = f.runtime.queue.claimNext('budget-restored');
    assert.ok(a); assert.equal(a.queue.id, qa.id); assert.equal(a.queue.seq, qa.seq);
    assert.equal(a.budgetAuthorization.rootId, rootA.id);
    await f.runtime.executeClaim(a);
    const b = f.runtime.queue.claimNext('budget-restored');
    assert.ok(b); assert.equal(b.queue.id, qb.id); assert.equal(b.queue.seq, qb.seq);
    assert.equal(b.budgetAuthorization.rootId, rootB.id);
    await f.runtime.executeClaim(b);
    assert.equal(count(f.db, 'threaded_budget_roots'), 2);
    assert.equal(f.runtime.budget.getUsage(rootA.id).actualRequests, 1);
    checks.push('B01 integrated: budget-blocked tickets retain FIFO age and consume no resource/Run/request reservation; Owner restores versioned original roots without minting replacement allowance');
  }

  {
    const f = await fixture('cancel-a-preserve-b');
    const receipt = f.runtime.messages.acceptUserMessage(f.user({ targets: ['aa', 'bb'] }));
    for (const wake of receipt.wakes) f.runtime.queue.enqueueWake(wake.id);
    const first = f.runtime.queue.claimNext('parallel'), second = f.runtime.queue.claimNext('parallel');
    assert.ok(first); assert.ok(second);
    const a = first.binding.agentId === 'aa' ? first : second, b = first === a ? second : first;
    for (const claim of [a, b]) {
      f.runtime.lifecycle.startAttempt(claim.binding);
      f.db.prepare('INSERT INTO fixture_external_calls(attempt_id,invocation_id,created_at) VALUES(?,?,?)')
        .run(claim.binding.attemptId, claim.binding.invocationId, Date.now());
    }
    f.runtime.lifecycle.requestControl({ ownerId: f.ownerId, scope: { kind: 'invocation', threadId: f.thread.id,
      invocationId: a.binding.invocationId }, action: 'stop', requestId: randomUUID() });
    assert.throws(() => f.runtime.authority.assertAuthorized(a.binding), /THREADED_|RESOURCE_/);
    f.runtime.authority.assertAuthorized(b.binding);
    const aResult = f.runtime.lifecycle.recordOutcome(a.binding, { kind: 'completed', content: 'late cancelled A response',
      response: { targets: ['cc'] }, budgetState: 'settled', quiescence: f.proof(a.binding),
      budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${a.binding.attemptId}` } });
    assert.equal(aResult.status, 'cancelled');
    assert.equal(f.resources.getClaim(b.binding.claimId).state, 'started');
    f.runtime.authority.assertAuthorized(b.binding);
    const bResult = f.runtime.lifecycle.recordOutcome(b.binding, { kind: 'completed', content: 'B continues',
      budgetState: 'settled', quiescence: f.proof(b.binding),
      budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${b.binding.attemptId}` } });
    assert.equal(bResult.status, 'completed');
    assert.equal(f.runtime.queue.getQueue(a.queue.id).state, 'cancelled');
    assert.equal(f.runtime.queue.getQueue(b.queue.id).state, 'settled');
    assert.equal(count(f.db, 'threaded_messages'), 2);
    assert.equal(count(f.db, 'threaded_wakes'), 2);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM threaded_messages WHERE body LIKE '%cancelled A%'").get().n, 0);
    assert.equal(count(f.db, 'fixture_external_calls'), 2);
    checks.push('Q06: cancelling parallel Invocation A discards its late completed body/successor while B retains its exact resource/budget authority and commits normally');
  }

  {
    const f = await fixture('readonly-runtime');
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    f.runtime.queue.enqueueWake(receipt.wakes[0].id);
    const claim = f.runtime.queue.claimNext('readonly-parent'), outcome = completedOutcome(f, claim);
    const before = snapshot(f.db, ['threaded_invocations', 'threaded_attempts', 'threaded_messages', 'threaded_outputs',
      'threaded_invocation_terminals', 'threaded_budget_requests', 'execution_resource_claims']);
    // Reuse the initialized real coordinator: its constructor persists default
    // policy even on an existing DB. The lifecycle/budget/queue connection is
    // genuinely read-only, and must fail before any post-commit release.
    const readonly = await openRuntimeFixture(f.databasePath, { readonly: true, resources: f.resources });
    fixtures.push(readonly);
    assert.throws(() => readonly.runtime.lifecycle.recordOutcome(claim.binding, outcome), /readonly/i);
    assert.deepEqual(snapshot(f.db, Object.keys(before)), before);
    assert.equal(f.resources.getClaim(claim.binding.claimId).state, 'quiescent');
    readonly.close();
    assert.equal(f.runtime.lifecycle.recordOutcome(claim.binding, outcome).status, 'completed');
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    checks.push('REC06: read-only SQLite refuses response/terminal/budget success and retains the quiescent claim; writable retry commits the existing result without another external call');
  }

  {
    let f;
    f = await fixture('post-final-independent-successors', { execute: async (input, context) => {
      const authored = input.binding.agentId === 'aa';
      if (authored) f.runtime.messages.postAgentMessage({ binding: input.binding, toolCallId: 'explicit-post',
        body: 'Identical explicit post and final body', targets: ['bb'] });
      return { kind: 'completed', content: authored ? 'Identical explicit post and final body' : `bb response ${input.binding.attemptId}`,
        ...(authored ? { response: { targets: ['bb'] } } : {}), budgetState: 'settled',
        budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${input.binding.attemptId}` },
        quiescence: context.proof(input.binding) };
    } });
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    f.runtime.queue.enqueueWake(receipt.wakes[0].id);
    const a = f.runtime.queue.claimNext('post-and-final');
    assert.ok(a); await f.runtime.executeClaim(a);
    const authored = f.db.prepare(`SELECT id,origin,body_hash,causal_root_id FROM threaded_messages
      WHERE source_invocation_id=? ORDER BY seq`).all(a.binding.invocationId);
    assert.equal(authored.length, 2);
    assert.deepEqual(authored.map(row => row.origin), ['agent_post', 'agent_response']);
    assert.equal(authored[0].body_hash, authored[1].body_hash);
    assert.notEqual(authored[0].id, authored[1].id);
    const successors = [];
    for (let i = 0; i < 2; i++) {
      const claim = f.runtime.queue.claimNext('post-and-final');
      assert.ok(claim); assert.equal(claim.binding.agentId, 'bb');
      assert.equal(claim.budgetAuthorization.rootId, receipt.message.causalRootId);
      successors.push(claim);
      await f.runtime.executeClaim(claim);
    }
    assert.notEqual(successors[0].binding.invocationId, successors[1].binding.invocationId);
    assert.deepEqual(successors.map(claim => claim.sourceMessageId), authored.map(row => row.id));
    assert.equal(f.runtime.queue.claimNext('post-and-final'), null);
    assert.equal(count(f.db, 'threaded_budget_roots'), 1);
    assert.equal(count(f.db, 'runs'), 3); assert.equal(count(f.db, 'fixture_external_calls'), 3);
    const usage = f.runtime.budget.getUsage(receipt.message.causalRootId);
    assert.equal(usage.actualRequests, 3); assert.equal(usage.invocations, 3); assert.equal(usage.attempts, 3);
    assert.equal(usage.outputTokens, 21); assert.equal(usage.costMicrousd, 33);
    checks.push('M01/B01: actual explicit post plus committed final with identical text create two independent addressed successor Invocations; all three executions settle against one original root without resetting request/token/cost counters');
  }

  {
    let startedResolve;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const f = await fixture('active-resume-notification', { dispatchEnabled: true, execute: async (input, context) => {
      startedResolve(); return executedResponse(input, context);
    } });
    const control = action => f.runtime.lifecycle.requestControl({ ownerId: f.ownerId,
      scope: { kind: 'thread', threadId: f.thread.id }, action, requestId: randomUUID() });
    control('pause');
    const receipt = f.runtime.messages.acceptUserMessage(f.user());
    await flushRuntime(f.runtime);
    assert.equal(count(f.db, 'threaded_wakes'), 1);
    assert.equal(count(f.db, 'threaded_invocations'), 0);
    assert.equal(count(f.db, 'runs'), 0); assert.equal(count(f.db, 'fixture_external_calls'), 0);
    assert.equal(f.runtime.queue.getQueueForWake(receipt.wakes[0].id).state, 'blocked');
    control('resume');
    await deadline(started, 'Owner resume actively starts queued work');
    await flushRuntime(f.runtime);
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    assert.equal(count(f.db, 'runs'), 1);
    assert.equal(f.runtime.queue.getQueueForWake(receipt.wakes[0].id).state, 'settled');
    assert.equal(f.runtime.diagnostics().lastError, null);
    checks.push('Q05 injected runtime composition: with execution enabled, autoStart false and repair polling off, paused input persists only a Wake; committed Owner resume actively runs it once without manual scan or wakeup');
  }

  {
    for (const decision of ['root', 'owner-window']) {
      let startedResolve;
      const started = new Promise(resolve => { startedResolve = resolve; });
      const f = await fixture(`active-budget-${decision}`, { dispatchEnabled: true, execute: async (input, context) => {
        startedResolve(); return executedResponse(input, context);
      } });
      const receipt = f.runtime.messages.acceptUserMessage(f.user());
      const budgetRoot = f.runtime.budget.ensureRootForMessage(receipt.message.id);
      const blocked = decision === 'root'
        ? f.runtime.reviseRoot({ ownerId: f.ownerId, rootId: budgetRoot.id, expectedVersion: budgetRoot.version,
          requestId: randomUUID(), reason: 'Owner pauses root before dispatch', state: 'paused' })
        : f.runtime.configureOwnerWindow({ ownerId: f.ownerId, expectedVersion: f.runtime.budget.getOwnerWindow().version,
          requestId: randomUUID(), reason: 'Owner window blocks estimated request cost', policy: { maxCostMicrousd: 1 } });
      await flushRuntime(f.runtime);
      const queued = f.runtime.queue.getQueueForWake(receipt.wakes[0].id);
      assert.equal(queued.state, 'blocked');
      assert.equal(count(f.db, 'runs'), 0); assert.equal(count(f.db, 'execution_resource_claims'), 0);
      assert.equal(count(f.db, 'fixture_external_calls'), 0);
      if (decision === 'root') f.runtime.reviseRoot({ ownerId: f.ownerId, rootId: budgetRoot.id, expectedVersion: blocked.version,
        requestId: randomUUID(), reason: 'Owner resumes original root', state: 'open' });
      else f.runtime.configureOwnerWindow({ ownerId: f.ownerId, expectedVersion: blocked.version,
        requestId: randomUUID(), reason: 'Owner approves sufficient window allowance', policy: { maxCostMicrousd: 100_000 } });
      await deadline(started, `Owner ${decision} decision actively dispatches`);
      await flushRuntime(f.runtime);
      const settled = f.runtime.queue.getQueueForWake(receipt.wakes[0].id);
      assert.equal(settled.state, 'settled'); assert.equal(settled.seq, queued.seq);
      assert.equal(settled.causalRootId, budgetRoot.id);
      assert.equal(count(f.db, 'fixture_external_calls'), 1);
      assert.equal(count(f.db, 'threaded_budget_roots'), 1);
      assert.equal(f.runtime.diagnostics().lastError, null);
    }
    checks.push('B01/Q05 composition: committed runtime root revisions and Owner-window decisions each actively unblock execution with no repair timer/manual hint, preserving queue age and the original root');
  }

  {
    let startedResolve, release;
    const started = new Promise(resolve => { startedResolve = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    let aborts = 0;
    const f = await fixture('rollback-does-not-abort-executor', { dispatchEnabled: true, withAccount: true,
      execute: async (input, context) => {
        input.signal.addEventListener('abort', () => { aborts++; }, { once: true });
        startedResolve(input);
        await released;
        input.assertAuthorized();
        return executedResponse(input, context);
      } });
    f.runtime.messages.acceptUserMessage(f.user());
    const input = await deadline(started, 'rollback fixture executor starts');
    assert.equal(input.signal.aborted, false);
    const prior = snapshot(f.db, ['threaded_invocations', 'threaded_attempts', 'threaded_control_requests',
      'account_revocations', 'execution_resource_claims']);
    assert.throws(() => f.db.transaction(() => {
      f.runtime.lifecycle.requestControl({ ownerId: f.ownerId, scope: { kind: 'invocation', threadId: f.thread.id,
        invocationId: input.binding.invocationId }, action: 'stop', requestId: randomUUID() });
      throw new Error('fixture rollback control');
    }).immediate(), /fixture rollback control/);
    assert.equal(input.signal.aborted, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.signal.aborted, false);
    assert.deepEqual(snapshot(f.db, Object.keys(prior)), prior);
    assert.throws(() => f.db.transaction(() => {
      f.db.prepare("INSERT INTO account_revocations(account_id,revoked_at) VALUES('fixture-account',?)").run(new Date().toISOString());
      assert.deepEqual(f.runtime.lifecycle.revokeAccount('fixture-account').affectedRunIds, [input.binding.runId]);
      throw new Error('fixture rollback account revoke');
    }).immediate(), /fixture rollback account revoke/);
    assert.equal(input.signal.aborted, false);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(input.signal.aborted, false); assert.equal(aborts, 0);
    assert.deepEqual(snapshot(f.db, Object.keys(prior)), prior);
    release(); await flushRuntime(f.runtime);
    assert.equal(count(f.db, 'fixture_external_calls'), 1);
    assert.equal(f.db.prepare('SELECT status FROM threaded_invocations WHERE id=?').get(input.binding.invocationId).status, 'completed');
    assert.equal(aborts, 0);
    checks.push('Rollback safety: real control and persisted account-revocation changes rolled back by an outer transaction cannot abort the barrier-held active executor or alter its authority; the same call later completes');
  }

  assert.ok(checks.length, 'Runtime acceptance must contain executable groups');
  for (const f of fixtures) if (f.db.open) assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(runtimeFixtureNetworkAttempts(), 0);
  console.log(JSON.stringify({ ok: true, groups: checks.length, checks, networkCalls: runtimeFixtureNetworkAttempts(), realModelCalls: 0 }, null, 2));
} finally {
  for (const dispatcher of dispatchers) dispatcher.close();
  for (const child of children) {
    if (child.exitCode !== null) continue;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill(); await exited;
  }
  for (const f of fixtures) f.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
