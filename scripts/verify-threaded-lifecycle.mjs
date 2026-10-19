import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createFakeThreadedExecutor, createFakeThreadedResources, deferred } from './fixtures/threadedFakeExecutor.mjs';

// All files and databases belong to this fixture. No provider, native SDK or app server starts.
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-lifecycle-'));
process.env.AGENT_GAND_ISOLATED_WORKER = '1';
process.env.DB_PATH = path.join(root, 'unused-business-singleton.sqlite');
process.env.AGENTS_DIR = path.join(root, 'agents');
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network access from Threaded fixture'); };

const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
const { createThreadedRunner } = await import('../apps/server/src/threaded/runner.ts');
const { abortThreadedExecution } = await import('../apps/server/src/threaded/executionSignals.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const databases = [];
const checks = [];
const now = '2026-10-19T00:00:00.000Z';

function openFixture(name) {
  const db = new Database(path.join(root, `${name}.sqlite`));
  databases.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  // Mirror the legacy database bootstrap column without importing its singleton.
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
  applyOrchestrationSchemaMigrations(db);
  const agent = id => ({ id, name: id, capabilities: ['execute'], systemPrompt: 'Deterministic fixture',
    model: 'mock:fixture', tools: [], disallowedTools: [], permissionMode: 'readonly', color: '#123456',
    source: 'db', enabled: true, version: 1 });
  for (const id of ['agent-a', 'agent-b']) db.prepare(`INSERT INTO agents
    (id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify(agent(id)), now, now);
  const store = createThreadedStore(db);
  const thread = store.createThread({ title: name, members: ['agent-a', 'agent-b'].map(agentId => ({
    agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
  })) });
  // Only trusted test setup opens the room. HTTP admission remains closed in production.
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const resources = createFakeThreadedResources();
  const executor = createFakeThreadedExecutor(resources);
  const authority = createThreadedAuthority(db, resources);
  const lifecycle = createThreadedLifecycle(db, authority, { resources,
    onInvalidate: ids => { for (const id of ids) abortThreadedExecution(id); } });
  const events = [];
  const runner = createThreadedRunner(authority, lifecycle, executor, { onEvent: (binding, event) => events.push({ binding, event }) });
  const createInvocation = (agentId = 'agent-a', options = {}) => lifecycle.createInvocation({
    ownerId: thread.ownerId, threadId: thread.id, agentId, causalRootId: `root:${name}`,
    goal: `fixture:${name}`, requestId: randomUUID(), ...options,
  });
  const prepare = invocation => lifecycle.prepareAttempt({ ownerId: thread.ownerId, invocationId: invocation.id,
    claim: resources.acquire({ ownerId: thread.ownerId, threadId: thread.id, invocationId: invocation.id,
      runId: invocation.runId, agentId: invocation.agentId }),
  });
  return { db, store, thread, ownerId: thread.ownerId, resources, executor, authority, lifecycle,
    runner, events, createInvocation, prepare };
}

const row = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const snapshot = (db, tables) => Object.fromEntries(tables.map(table => [table,
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const rejectsThreaded = error => /^THREADED_|^FAKE_/.test(error?.code ?? error?.message ?? '');
const input = binding => ({ binding, contextManifestId: 'fixture-context', sessionBindingId: 'fixture-session',
  budgetAuthorizationId: 'fixture-budget' });
const executionTables = ['threaded_invocations', 'threaded_attempts', 'threaded_run_bindings',
  'threaded_execution_bindings', 'runs', 'threaded_outputs', 'threaded_invocation_terminals'];
const complete = (binding, resources, content = 'deterministic response', budgetState = 'settled') => {
  resources.setAlive(binding, false);
  return { kind: 'completed', content, budgetState, quiescence: resources.quiescent(binding) };
};

try {
  {
    const f = openFixture('binding-authority');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    const baseline = snapshot(f.db, executionTables);
    const forged = [undefined, ...Object.entries({ schemaVersion: 2, id: 'forged-id', origin: 'task_attempt',
      ownerId: 'foreign-owner', threadId: 'foreign-thread', invocationId: 'foreign-invocation',
      runId: 'foreign-run', attemptId: 'foreign-attempt', agentId: 'agent-b',
      authorityEpoch: binding.authorityEpoch + 1, claimId: 'foreign-claim',
      generation: binding.generation + 1, fencingToken: 'foreign-fence',
      workspaceSnapshot: { commit: 'forged', path: '/untrusted' },
    }).map(([key, value]) => ({ ...binding, [key]: value }))];
    for (const value of forged) await assert.rejects(f.runner.execute(input(value)), rejectsThreaded);
    assert.equal(f.executor.calls.length, 0, 'Forged or absent binding must not reach an executor');
    assert.deepEqual(snapshot(f.db, executionTables), baseline);
    assert.equal(f.authority.authorized(binding), true);

    for (const [table, key, value] of [
      ['threaded_members', 'permission_version', 2], ['threaded_members', 'version', 2],
      ['threaded_members', 'role_version', 2], ['agents', 'version', 2],
    ]) {
      const where = table === 'agents' ? "id='agent-a'" : "agent_id='agent-a'";
      f.db.exec(`UPDATE ${table} SET ${key}=${value} WHERE ${where}`);
      assert.equal(f.authority.authorized(binding), false, `${table}.${key} revokes the captured authority`);
      await assert.rejects(f.runner.execute(input(binding)), rejectsThreaded);
      f.db.exec(`UPDATE ${table} SET ${key}=1 WHERE ${where}`);
    }
    for (const table of ['threaded_threads', 'threaded_invocations']) {
      f.db.exec(`UPDATE ${table} SET authority_epoch=authority_epoch+1`);
      await assert.rejects(f.runner.execute(input(binding)), rejectsThreaded);
      f.db.exec(`UPDATE ${table} SET authority_epoch=authority_epoch-1`);
    }
    const definition = f.db.prepare("SELECT definition FROM agents WHERE id='agent-a'").get().definition;
    f.db.prepare("UPDATE agents SET definition=? WHERE id='agent-a'").run(JSON.stringify({ ...JSON.parse(definition), tools: ['forged-tool'] }));
    await assert.rejects(f.runner.execute(input(binding)), rejectsThreaded);
    f.db.prepare("UPDATE agents SET definition=? WHERE id='agent-a'").run(definition);
    assert.equal(f.executor.calls.length, 0);
    const savedFlag = process.env.AGENT_GAND_ISOLATED_WORKER;
    delete process.env.AGENT_GAND_ISOLATED_WORKER;
    try { await assert.rejects(f.runner.execute(input(binding)), /THREADED_EXECUTION_NOT_ENABLED/); }
    finally { process.env.AGENT_GAND_ISOLATED_WORKER = savedFlag; }
    checks.push('ISO03: missing/forged/stale authority and production execution gate reject before 0 executor calls');
  }

  {
    const f = openFixture('invocation-run-retry');
    const first = f.createInvocation();
    const second = f.createInvocation('agent-b');
    assert.equal(count(f.db, 'runs'), 0, 'Queued invocation reserves an identity without creating an execution Run');
    const firstBinding = f.prepare(first);
    const secondBinding = f.prepare(second);
    assert.notEqual(firstBinding.runId, secondBinding.runId);
    assert.notEqual(row(f.db, 'runs', firstBinding.runId).turn_no, row(f.db, 'runs', secondBinding.runId).turn_no);
    assert.equal(count(f.db, 'threaded_run_bindings'), 2);
    f.lifecycle.recordOutcome(firstBinding, { kind: 'not_started', reason: 'fixture-confirmed-not-sent',
      quiescence: f.resources.quiescent(firstBinding, { reason: 'not_started', sideEffects: 'none' }) });
    assert.equal(row(f.db, 'threaded_invocations', first.id).status, 'queued');
    assert.equal(row(f.db, 'runs', firstBinding.runId).status, 'pending');
    assert.equal(row(f.db, 'runs', firstBinding.runId).finished_at, null);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 0);
    const retryBinding = f.prepare(first);
    assert.equal(retryBinding.runId, firstBinding.runId);
    assert.notEqual(retryBinding.attemptId, firstBinding.attemptId);
    assert.ok(retryBinding.generation > firstBinding.generation);
    assert.equal(row(f.db, 'threaded_attempts', retryBinding.attemptId).attempt_no, 2);
    assert.equal(row(f.db, 'threaded_invocations', first.id).causal_root_id, `root:invocation-run-retry`);
    const beforeLate = snapshot(f.db, executionTables);
    assert.throws(() => f.lifecycle.recordOutcome(firstBinding, { kind: 'unknown', reason: 'late callback' }), rejectsThreaded);
    assert.deepEqual(snapshot(f.db, executionTables), beforeLate);
    assert.equal(f.resources.isHeld(retryBinding), true, 'An old callback must not release the retry claim');
    f.executor.enqueue(({ binding }, resources) => complete(binding, resources));
    await f.runner.execute(input(retryBinding));
    assert.equal(f.executor.calls.length, 1);
    assert.equal(row(f.db, 'threaded_invocations', first.id).status, 'completed');
    assert.equal(row(f.db, 'runs', firstBinding.runId).status, 'completed');
    assert.equal(count(f.db, 'runs'), 2, 'Retry reuses the original Run');
    assert.equal(count(f.db, 'runtime_run_terminals'), 0, 'No synthetic legacy completion evaluation or terminal is inserted');
    checks.push('ISO05/REC02: first claim creates one scoped Run, transaction turn numbers differ, safe retry preserves Run/root and fences old callbacks');
  }

  {
    const f = openFixture('alive-after-error');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    f.executor.enqueue(() => { throw new Error('Transport failed while fake subprocess remains alive'); });
    await f.runner.execute(input(binding));
    assert.equal(f.executor.calls.length, 1);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'unknown');
    assert.equal(row(f.db, 'runs', binding.runId).status, 'waiting_for_user');
    assert.equal(row(f.db, 'runs', binding.runId).finished_at, null);
    assert.equal(f.resources.isAlive(binding), true);
    assert.equal(f.resources.isHeld(binding), true);
    assert.equal(f.resources.releases.length, 0);
    assert.throws(() => f.resources.quiescent(binding), /live executor/);
    assert.throws(() => f.prepare(invocation), rejectsThreaded);
    assert.throws(() => f.lifecycle.requestControl({ ownerId: f.ownerId,
      scope: { kind: 'invocation', threadId: f.thread.id, invocationId: invocation.id },
      action: 'resume', requestId: randomUUID() }), rejectsThreaded);
    f.lifecycle.reconcile(invocation.id);
    f.lifecycle.reconcile(invocation.id);
    assert.equal(f.resources.releases.length, 0);
    assert.equal(f.executor.calls.length, 1, 'Recovery must never blindly replay an uncertain request');
    f.resources.setAlive(binding, false);
    const uncertain = snapshot(f.db, executionTables);
    assert.throws(() => f.lifecycle.recordOutcome(binding, { kind: 'not_started', reason: 'Unproven no-send claim',
      quiescence: f.resources.quiescent(binding, { reason: 'reconciled', sideEffects: 'reconciled' }) }), rejectsThreaded);
    assert.deepEqual(snapshot(f.db, executionTables), uncertain, 'A quiescent process does not prove that no request was sent');
    assert.equal(f.resources.releases.length, 0);
    checks.push('REC03/Q06 subcase: executor error with a live process retains unknown/fence, manual resume/retry and repeated recovery cannot replay');
  }

  {
    const f = openFixture('cost-unknown-only');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    f.executor.enqueue(({ binding }, resources) => complete(binding, resources, 'Known result; usage receipt unavailable', 'unknown'));
    await f.runner.execute(input(binding));
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'completed');
    assert.equal(row(f.db, 'runs', binding.runId).status, 'completed');
    assert.equal(f.resources.isHeld(binding), false, 'Known quiescence releases execution resources despite an unknown cost');
    const terminal = f.db.prepare('SELECT * FROM threaded_invocation_terminals WHERE invocation_id=?').get(invocation.id);
    assert.equal(JSON.parse(terminal.proof).budgetState, 'unknown');
    assert.equal(f.executor.calls.length, 1);
    checks.push('Known response with unknown cost is distinct from unknown execution; terminal retains unresolved budget state');
  }

  {
    const f = openFixture('terminal-atomicity');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    let outcome;
    f.executor.enqueue(({ binding }, resources) => { outcome = complete(binding, resources); return outcome; });
    f.db.exec(`CREATE TRIGGER fixture_terminal_abort BEFORE INSERT ON threaded_invocation_terminals
      BEGIN SELECT RAISE(ABORT,'fixture_terminal_transaction_failure'); END;`);
    await assert.rejects(f.runner.execute(input(binding)), /fixture_terminal_transaction_failure/);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'running');
    assert.equal(row(f.db, 'threaded_attempts', binding.attemptId).status, 'running');
    assert.equal(row(f.db, 'runs', binding.runId).status, 'running');
    assert.equal(count(f.db, 'threaded_outputs'), 0);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 0);
    assert.equal(f.resources.releases.length, 0, 'A rolled back terminal cannot release its claim');
    f.db.exec('DROP TRIGGER fixture_terminal_abort');
    f.lifecycle.recordOutcome(binding, outcome);
    assert.equal(count(f.db, 'threaded_outputs'), 1);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    const committed = snapshot(f.db, executionTables);
    f.lifecycle.recordOutcome(binding, outcome);
    f.lifecycle.reconcile(invocation.id);
    f.lifecycle.reconcile(invocation.id);
    assert.deepEqual(snapshot(f.db, executionTables), committed);
    assert.equal(f.resources.releases.length, 1);
    assert.equal(f.executor.calls.length, 1);
    checks.push('ISO05/REC04–06 subcases: terminal transaction rollback covers output/Attempt/Run/Invocation; replay and recovery commit only once');
  }

  {
    const f = openFixture('quiescence-proof');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    f.lifecycle.startAttempt(binding);
    const proof = f.resources.quiescent(binding);
    const before = snapshot(f.db, executionTables);
    assert.throws(() => f.lifecycle.recordOutcome(binding, { kind: 'completed', content: 'Forged proof',
      budgetState: 'settled', quiescence: structuredClone(proof) }), rejectsThreaded);
    assert.deepEqual(snapshot(f.db, executionTables), before);
    assert.equal(f.resources.isHeld(binding), true);
    checks.push('A client-shaped or copied quiescence proof cannot authorize terminal commit or resource release');
  }

  {
    const f = openFixture('write-failure-before-execution');
    const invocation = f.createInvocation();
    const queued = snapshot(f.db, executionTables);
    f.db.exec(`CREATE TRIGGER fixture_claim_abort BEFORE INSERT ON threaded_execution_bindings
      BEGIN SELECT RAISE(ABORT,'fixture_claim_transaction_failure'); END;`);
    assert.throws(() => f.prepare(invocation), /fixture_claim_transaction_failure/);
    assert.deepEqual(snapshot(f.db, executionTables), queued, 'Run, Attempt and binding roll back as one claim');
    f.db.exec('DROP TRIGGER fixture_claim_abort');
    const binding = f.prepare(invocation);
    const prepared = snapshot(f.db, executionTables);
    f.db.exec(`CREATE TRIGGER fixture_start_abort BEFORE UPDATE OF execution_stage ON threaded_attempts
      WHEN NEW.execution_stage='started' BEGIN SELECT RAISE(ABORT,'fixture_start_transaction_failure'); END;`);
    await assert.rejects(f.runner.execute(input(binding)), /fixture_start_transaction_failure/);
    assert.deepEqual(snapshot(f.db, executionTables), prepared);
    assert.equal(f.executor.calls.length, 0, 'Failure to durably mark request intent prevents the external call');
    checks.push('REC06 subcase: binding/start persistence failures roll back and cannot promise or start external work');
  }

  {
    const f = openFixture('account-authority');
    f.db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,
      credential_version,identity_generation,created_at,updated_at) VALUES('fixture-account','Fake','openai',
      'api_key','managed',1,1,1,NULL,?,?)`).run(now, now);
    const definition = JSON.parse(f.db.prepare("SELECT definition FROM agents WHERE id='agent-a'").get().definition);
    f.db.prepare("UPDATE agents SET definition=? WHERE id='agent-a'").run(JSON.stringify({ ...definition, accountRef: 'fixture-account', requiresAccount: true }));
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    assert.equal(f.authority.authorized(binding), true);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).account_id, 'fixture-account');
    for (const key of ['config_version', 'credential_version']) {
      f.db.exec(`UPDATE accounts SET ${key}=2 WHERE id='fixture-account'`);
      await assert.rejects(f.runner.execute(input(binding)), rejectsThreaded);
      f.db.exec(`UPDATE accounts SET ${key}=1 WHERE id='fixture-account'`);
    }
    f.db.prepare("INSERT INTO account_revocations(account_id,revoked_at) VALUES('fixture-account',?)").run(now);
    await assert.rejects(f.runner.execute(input(binding)), rejectsThreaded);
    assert.equal(f.executor.calls.length, 0, 'Persistent account revocation rejects calls even before an in-memory notification');
    checks.push('ISO03/ISO04: frozen account versions and the durable revocation ledger are checked before execution');
  }

  {
    const f = openFixture('approval-current-attempt');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    const registered = deferred();
    const continueExecution = deferred();
    f.executor.enqueue(async (context, resources) => {
      const approval = f.lifecycle.registerApproval(context.binding, { requestKey: 'tool:approval', record: { tool: 'fixture-only' } });
      registered.resolve({ approval, context });
      await continueExecution.promise;
      context.assertAuthorized();
      context.onEvent({ type: 'text', value: 'approved fixture response' });
      return complete(context.binding, resources);
    });
    const execution = f.runner.execute(input(binding));
    const { approval, context } = await registered.promise;
    assert.equal(f.lifecycle.registerApproval(binding, { requestKey: 'tool:approval', record: { tool: 'fixture-only' } }).id, approval.id);
    assert.throws(() => f.lifecycle.registerApproval(binding, { requestKey: 'tool:approval', record: { tool: 'different-tool' } }), rejectsThreaded);
    assert.equal(row(f.db, 'runs', binding.runId).status, 'awaiting_approval');
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'running');
    assert.throws(context.assertAuthorized, rejectsThreaded);
    assert.equal(f.resources.isHeld(binding), true, 'Pending approval retains the native/session/resource fence');
    assert.throws(() => f.lifecycle.decideApproval({ ownerId: 'forged-owner', threadId: f.thread.id,
      approvalId: approval.id, decision: 'approve', requestId: 'forged-approval' }), rejectsThreaded);
    const decision = { ownerId: f.ownerId, threadId: f.thread.id, approvalId: approval.id,
      decision: 'approve', requestId: 'approval-decision-1' };
    f.lifecycle.decideApproval(decision);
    const decided = snapshot(f.db, [...executionTables, 'threaded_approvals']);
    f.lifecycle.decideApproval(decision);
    assert.deepEqual(snapshot(f.db, [...executionTables, 'threaded_approvals']), decided);
    f.lifecycle.resumeAfterApproval(approval.id);
    f.lifecycle.resumeAfterApproval(approval.id);
    assert.equal(f.executor.calls.length, 1, 'Approval continuation never starts another model request');
    continueExecution.resolve();
    await execution;
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'completed');
    assert.equal(f.events.length, 1);
    checks.push('ISO04: current-attempt approval gates effects, owner is checked, repeated approval resumes only the original fake call');
  }

  {
    const f = openFixture('approval-after-restart');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    const registered = deferred();
    const lateResult = deferred();
    f.executor.enqueue(async context => {
      registered.resolve(f.lifecycle.registerApproval(context.binding, { requestKey: 'restart-approval' }));
      await lateResult.promise;
      assert.equal(context.signal.aborted, true);
      assert.throws(context.assertAuthorized, rejectsThreaded);
      return { kind: 'unknown', reason: 'Process alive after owner restart' };
    });
    const execution = f.runner.execute(input(binding));
    const approval = await registered.promise;
    const restartedAuthority = createThreadedAuthority(f.db, f.resources);
    const restarted = createThreadedLifecycle(f.db, restartedAuthority, { resources: f.resources,
      onInvalidate: ids => { for (const id of ids) abortThreadedExecution(id); } });
    restarted.recoverAll();
    const recovered = snapshot(f.db, [...executionTables, 'threaded_approvals']);
    restarted.recoverAll();
    assert.deepEqual(snapshot(f.db, [...executionTables, 'threaded_approvals']), recovered);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'unknown');
    assert.equal(row(f.db, 'runs', binding.runId).status, 'waiting_for_user');
    assert.equal(row(f.db, 'threaded_approvals', approval.id).status, 'expired');
    assert.throws(() => restarted.decideApproval({ ownerId: f.ownerId, threadId: f.thread.id,
      approvalId: approval.id, decision: 'approve', requestId: 'late-approval' }), rejectsThreaded);
    assert.throws(() => restarted.resumeAfterApproval(approval.id), rejectsThreaded);
    lateResult.resolve();
    await execution;
    assert.equal(f.executor.calls.length, 1);
    assert.equal(f.resources.releases.length, 0);
    checks.push('ISO04/REC03: restart during approval revokes the old continuation, retains unknown/fence and cannot replay the call');
  }

  for (const action of ['pause', 'stop']) {
    const f = openFixture(`control-${action}`);
    const invocation = f.createInvocation();
    const other = f.createInvocation('agent-b');
    const binding = f.prepare(invocation);
    const otherBinding = f.prepare(other);
    const entered = f.executor.nextCall();
    const lateResult = deferred();
    let context;
    f.executor.enqueue(async current => {
      context = current;
      await lateResult.promise;
      assert.equal(current.signal.aborted, true);
      assert.throws(current.assertAuthorized, rejectsThreaded);
      assert.throws(() => current.onEvent({ type: 'text', value: 'late forbidden output' }), rejectsThreaded);
      return complete(current.binding, f.resources, 'Late output must not be committed');
    });
    const execution = f.runner.execute(input(binding));
    await entered;
    const otherBefore = row(f.db, 'threaded_invocations', other.id);
    const command = { ownerId: f.ownerId, scope: { kind: 'invocation', threadId: f.thread.id, invocationId: invocation.id },
      action, requestId: `${action}-request-1` };
    const receipt = f.lifecycle.requestControl(command);
    assert.equal(receipt.status, 'pending');
    assert.equal(context.signal.aborted, true);
    const controlled = snapshot(f.db, [...executionTables, 'threaded_control_requests']);
    f.lifecycle.requestControl(command);
    assert.deepEqual(snapshot(f.db, [...executionTables, 'threaded_control_requests']), controlled);
    assert.deepEqual(row(f.db, 'threaded_invocations', other.id), otherBefore, 'A member-scoped invocation control does not cancel B');
    assert.equal(f.authority.authorized(otherBinding), true);
    assert.equal(f.resources.isHeld(binding), true, 'Requesting stop/pause does not establish external quiescence');
    assert.equal(f.resources.releases.length, 0);
    lateResult.resolve();
    await execution;
    assert.equal(count(f.db, 'threaded_outputs'), 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.resources.isHeld(binding), false);
    assert.equal(f.resources.isHeld(otherBinding), true);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, action === 'pause' ? 'waiting' : 'cancelled');
    assert.equal(row(f.db, 'runs', binding.runId).status, action === 'pause' ? 'waiting_for_user' : 'cancelled');
    if (action === 'pause') {
      assert.throws(() => f.lifecycle.requestControl({ ...command, action: 'resume', requestId: 'resume-request' }), rejectsThreaded,
        'Quiescence of an already completed call does not prove that replaying its effects is safe');
    }
    checks.push(`ISO04/Q06 subcases: ${action} invalidates A only, drops late events/output, waits for quiescence and preserves B`);
  }

  {
    const f = openFixture('not-started-recovery');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    f.lifecycle.reconcile(invocation.id);
    const recovered = snapshot(f.db, executionTables);
    f.lifecycle.reconcile(invocation.id);
    assert.deepEqual(snapshot(f.db, executionTables), recovered);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'waiting');
    assert.equal(f.resources.isHeld(binding), true);
    assert.equal(f.executor.calls.length, 0);
    f.lifecycle.recordOutcome(binding, { kind: 'not_started', reason: 'Durable host probe confirms no request was sent',
      quiescence: f.resources.quiescent(binding, { reason: 'not_started', sideEffects: 'none' }) });
    assert.equal(f.resources.isHeld(binding), false);
    f.lifecycle.requestControl({ ownerId: f.ownerId, scope: { kind: 'invocation', threadId: f.thread.id, invocationId: invocation.id },
      action: 'resume', requestId: 'resume-after-not-started-recovery' });
    const next = f.prepare(invocation);
    assert.equal(next.runId, binding.runId);
    assert.notEqual(next.attemptId, binding.attemptId);
    assert.equal(f.authority.authorized(binding), false);
    assert.equal(f.authority.authorized(next), true);
    assert.equal(f.executor.calls.length, 0);
    checks.push('REC02/REC05 subcases: prepared restart is idempotent and only verified no-send quiescence permits a fresh Attempt');
  }

  {
    const f = openFixture('account-revocation-lifecycle');
    f.db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,
      credential_version,identity_generation,created_at,updated_at) VALUES('fixture-account','Fake','openai',
      'api_key','managed',1,1,1,NULL,?,?)`).run(now, now);
    const definition = JSON.parse(f.db.prepare("SELECT definition FROM agents WHERE id='agent-a'").get().definition);
    f.db.prepare("UPDATE agents SET definition=? WHERE id='agent-a'").run(JSON.stringify({ ...definition, accountRef: 'fixture-account', requiresAccount: true }));
    const invocation = f.createInvocation();
    const queued = f.createInvocation();
    const other = f.createInvocation('agent-b');
    const binding = f.prepare(invocation);
    const otherBinding = f.prepare(other);
    const entered = f.executor.nextCall();
    const lateResult = deferred();
    let context;
    f.executor.enqueue(async current => {
      context = current;
      await lateResult.promise;
      assert.throws(current.assertAuthorized, rejectsThreaded);
      return complete(current.binding, f.resources, 'Revoked account output must be ignored');
    });
    const execution = f.runner.execute(input(binding));
    await entered;
    f.db.prepare("INSERT INTO account_revocations(account_id,revoked_at) VALUES('fixture-account',?)").run(now);
    const receipt = f.lifecycle.revokeAccount('fixture-account');
    assert.deepEqual(receipt.affectedRunIds, [binding.runId]);
    assert.equal(context.signal.aborted, true);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'unknown');
    assert.equal(row(f.db, 'threaded_invocations', queued.id).status, 'cancelled');
    assert.equal(f.resources.isHeld(binding), true);
    assert.equal(f.resources.isHeld(otherBinding), true);
    assert.equal(f.authority.authorized(otherBinding), true);
    const revoked = snapshot(f.db, executionTables);
    f.lifecycle.revokeAccount('fixture-account');
    assert.deepEqual(snapshot(f.db, executionTables), revoked, 'Repeated account revoke cannot create new epochs/work');
    lateResult.resolve();
    await execution;
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'cancelled');
    assert.equal(row(f.db, 'runs', binding.runId).status, 'cancelled');
    assert.equal(count(f.db, 'threaded_outputs'), 0);
    assert.equal(f.resources.isHeld(binding), false);
    assert.equal(f.resources.isHeld(otherBinding), true);
    checks.push('ISO04: account revoke aborts active authority, cancels queued work, isolates other accounts and discards late results');
  }

  for (const failure of ['resource-release', 'release-acknowledgement']) {
    const f = openFixture(failure);
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    const release = f.resources.release.bind(f.resources);
    if (failure === 'resource-release') f.resources.release = () => { throw new Error('Fixture resource unavailable'); };
    else f.db.exec(`CREATE TRIGGER fixture_release_ack_abort BEFORE UPDATE OF resource_release_state ON threaded_attempts
      WHEN NEW.resource_release_state='released' BEGIN SELECT RAISE(ABORT,'fixture_release_ack_failure'); END;`);
    let outcome;
    f.executor.enqueue((context, resources) => { outcome = complete(context.binding, resources); return outcome; });
    const result = await f.runner.execute(input(binding));
    assert.equal(result.resourceReleasePending, true);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'completed');
    assert.equal(row(f.db, 'runs', binding.runId).status, 'completed');
    assert.equal(row(f.db, 'threaded_attempts', binding.attemptId).resource_release_state, 'pending');
    assert.equal(count(f.db, 'threaded_outputs'), 1);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    assert.equal(f.lifecycle.releaseResources(binding, structuredClone(outcome.quiescence)).resourceReleasePending, true);
    if (failure === 'resource-release') f.resources.release = release;
    else f.db.exec('DROP TRIGGER fixture_release_ack_abort');
    const cleanup = f.lifecycle.releaseResources(binding, outcome.quiescence);
    assert.equal(cleanup.resourceReleasePending, false);
    f.lifecycle.releaseResources(binding, outcome.quiescence);
    assert.equal(row(f.db, 'threaded_attempts', binding.attemptId).resource_release_state, 'released');
    assert.equal(f.resources.releases.length, 1);
    assert.equal(f.resources.isHeld(binding), false);
    assert.equal(count(f.db, 'threaded_outputs'), 1);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    assert.equal(f.executor.calls.length, 1);
    checks.push(`REC05/REC06 subcases: ${failure} leaves a durable pending cleanup; exact-proof retry releases once without replaying output/model`);
  }

  {
    const f = openFixture('retry-awaits-resource-cleanup');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    const release = f.resources.release.bind(f.resources);
    f.resources.release = () => { throw new Error('Fixture resource unavailable'); };
    const proof = f.resources.quiescent(binding, { reason: 'not_started', sideEffects: 'none' });
    const result = f.lifecycle.recordOutcome(binding, { kind: 'not_started', reason: 'No request sent', quiescence: proof });
    assert.equal(result.resourceReleasePending, true);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'queued');
    assert.throws(() => f.prepare(invocation), rejectsThreaded);
    f.resources.release = release;
    f.lifecycle.releaseResources(binding, proof);
    const next = f.prepare(invocation);
    assert.equal(next.runId, binding.runId);
    assert.ok(next.generation > binding.generation);
    assert.equal(f.resources.isHeld(next), true);
    assert.throws(() => f.resources.release(f.authority.claim(next), proof), rejectsThreaded);
    assert.equal(f.resources.isHeld(next), true, 'An old finally/proof cannot release the successor claim');
    assert.equal(f.executor.calls.length, 0);
    checks.push('A retry cannot overtake a committed but unreleased predecessor claim');
  }

  {
    const f = openFixture('outer-transaction-release');
    const invocation = f.createInvocation();
    const binding = f.prepare(invocation);
    const proof = f.resources.quiescent(binding, { reason: 'not_started', sideEffects: 'none' });
    const outcome = { kind: 'not_started', reason: 'No external request', quiescence: proof };
    const before = snapshot(f.db, executionTables);
    f.db.transaction(() => {
      assert.throws(() => f.lifecycle.recordOutcome(binding, outcome), /THREADED_OUTCOME_REQUIRES_OUTERMOST_TRANSACTION/);
      assert.throws(() => f.lifecycle.commitTerminal({ binding, status: 'failed', budgetState: 'settled', quiescence: proof }),
        /THREADED_OUTCOME_REQUIRES_OUTERMOST_TRANSACTION/);
    }).immediate();
    assert.deepEqual(snapshot(f.db, executionTables), before);
    assert.equal(f.resources.releases.length, 0);
    const release = f.resources.release.bind(f.resources);
    f.resources.release = () => { throw new Error('Fixture resource unavailable'); };
    f.lifecycle.recordOutcome(binding, outcome);
    f.resources.release = release;
    f.db.transaction(() => {
      assert.throws(() => f.lifecycle.releaseResources(binding, proof), /THREADED_OUTCOME_REQUIRES_OUTERMOST_TRANSACTION/);
    }).immediate();
    assert.equal(f.resources.releases.length, 0, 'No external release may occur before an enclosing transaction commits');
    assert.equal(f.resources.isHeld(binding), true);
    f.lifecycle.releaseResources(binding, proof);
    assert.equal(f.resources.releases.length, 1);
    checks.push('Outcome, terminal and cleanup ports reject an outer transaction so resources cannot escape a later rollback');
  }

  {
    const f = openFixture('member-pause-survives-thread-resume');
    const a = f.createInvocation();
    const b = f.createInvocation('agent-b');
    const command = (kind, action, requestId, agentId) => f.lifecycle.requestControl({ ownerId: f.ownerId,
      scope: { kind, threadId: f.thread.id, ...(agentId ? { agentId } : {}) }, action, requestId });
    command('member', 'pause', 'member-pause', 'agent-a');
    command('thread', 'pause', 'thread-pause');
    command('thread', 'resume', 'thread-resume');
    assert.equal(row(f.db, 'threaded_threads', f.thread.id).state, 'open');
    assert.equal(row(f.db, 'threaded_invocations', a.id).status, 'waiting');
    assert.equal(row(f.db, 'threaded_invocations', a.id).pause_requested, 1);
    assert.equal(row(f.db, 'threaded_invocations', b.id).status, 'queued');
    assert.equal(row(f.db, 'threaded_invocations', b.id).pause_requested, 0);
    assert.throws(() => f.createInvocation('agent-a'), rejectsThreaded);
    assert.throws(() => f.prepare(a), rejectsThreaded);
    const bindingB = f.prepare(b);
    assert.equal(f.authority.authorized(bindingB), true);
    command('member', 'resume', 'member-resume', 'agent-a');
    const bindingA = f.prepare(a);
    assert.equal(f.authority.authorized(bindingA), true);
    assert.equal(f.authority.authorized(bindingB), true);
    assert.equal(f.executor.calls.length, 0);
    checks.push('ISO04: Thread pause/resume preserves a separately paused member until its own authorized resume');
  }

  {
    const f = openFixture('verified-failure-retry');
    const invocation = f.createInvocation();
    const first = f.prepare(invocation);
    const failure = ({ binding }, resources) => {
      resources.setAlive(binding, false);
      return { kind: 'failed', reason: 'Verified retryable fixture failure', retryable: true, budgetState: 'settled',
        quiescence: resources.quiescent(binding, { sideEffects: 'none' }) };
    };
    f.executor.enqueue(failure);
    const firstResult = await f.runner.execute(input(first));
    assert.equal(firstResult.retryable, true);
    assert.equal(row(f.db, 'threaded_attempts', first.attemptId).status, 'failed');
    assert.equal(row(f.db, 'runs', first.runId).status, 'pending');
    assert.equal(row(f.db, 'runs', first.runId).finished_at, null);
    const second = f.prepare(invocation);
    f.executor.enqueue(failure);
    await f.runner.execute(input(second));
    assert.equal(first.runId, second.runId);
    assert.equal(row(f.db, 'threaded_invocations', invocation.id).status, 'failed');
    assert.equal(row(f.db, 'runs', first.runId).status, 'failed');
    assert.equal(count(f.db, 'threaded_attempts'), 2);
    assert.equal(count(f.db, 'threaded_invocation_terminals'), 1);
    assert.equal(count(f.db, 'threaded_outputs'), 0);
    assert.throws(() => f.prepare(invocation), rejectsThreaded);
    assert.equal(f.executor.calls.length, 2);
    assert.equal(count(f.db, 'runtime_run_terminals'), 0);
    checks.push('ISO05: verified retryable failure starts one new Attempt on the same Run; the second failure terminates within the frozen 2-Attempt cap');
  }

  {
    const f = openFixture('retry-retains-invocation-snapshot');
    f.db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,
      credential_version,identity_generation,created_at,updated_at) VALUES('fixture-account','Fake','openai',
      'api_key','managed',1,1,1,NULL,?,?)`).run(now, now);
    const definition = JSON.parse(f.db.prepare("SELECT definition FROM agents WHERE id='agent-a'").get().definition);
    f.db.prepare("UPDATE agents SET definition=? WHERE id='agent-a'").run(JSON.stringify({ ...definition, accountRef: 'fixture-account', requiresAccount: true }));
    const invocation = f.createInvocation();
    const first = f.prepare(invocation);
    f.executor.enqueue(({ binding }, resources) => {
      resources.setAlive(binding, false);
      return { kind: 'failed', reason: 'Verified retryable fixture failure', retryable: true, budgetState: 'settled',
        quiescence: resources.quiescent(binding, { sideEffects: 'none' }) };
    });
    await f.runner.execute(input(first));
    assert.equal(row(f.db, 'runs', first.runId).status, 'pending');
    assert.equal(row(f.db, 'threaded_attempts', first.attemptId).resource_release_state, 'released');
    const frozen = snapshot(f.db, executionTables);
    for (const [table, key, where] of [
      ['accounts', 'config_version', "id='fixture-account'"],
      ['accounts', 'credential_version', "id='fixture-account'"],
      ['threaded_members', 'permission_version', "agent_id='agent-a'"],
      ['threaded_members', 'version', "agent_id='agent-a'"],
    ]) {
      f.db.exec(`UPDATE ${table} SET ${key}=2 WHERE ${where}`);
      assert.throws(() => f.prepare(invocation), /THREADED_INVOCATION_SNAPSHOT_CHANGED/);
      assert.deepEqual(snapshot(f.db, executionTables), frozen, 'Retry configuration drift must roll back the new Attempt/binding');
      assert.equal(f.executor.calls.length, 1);
      f.db.exec(`UPDATE ${table} SET ${key}=1 WHERE ${where}`);
    }
    const second = f.prepare(invocation);
    assert.equal(second.runId, first.runId);
    f.executor.enqueue(({ binding }, resources) => complete(binding, resources));
    await f.runner.execute(input(second));
    assert.equal(f.executor.calls.length, 2);
    assert.equal(count(f.db, 'runs'), 1);
    assert.equal(count(f.db, 'threaded_attempts'), 2);
    assert.equal(row(f.db, 'runs', first.runId).status, 'completed');
    checks.push('ISO03/ISO05: retry retains the first Invocation account/member/permission snapshot; drift rolls back before any new execution');
  }

  assert.equal(networkCalls, 0);
  console.log(`Threaded lifecycle passed (${checks.length} groups, zero network/real-model calls):\n${checks.map(check => `- ${check}`).join('\n')}`);
} finally {
  for (const db of databases) if (db.open) db.close();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
