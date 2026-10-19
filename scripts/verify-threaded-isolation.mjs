import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// No server, provider, SDK process or repository workspace is started by this test.
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-threaded-isolation-'));
process.env.AGENT_GAND_ISOLATED_WORKER = '1';
process.env.AGENTS_DIR = path.join(root, 'agents');
process.env.DB_PATH = path.join(root, 'isolation.sqlite');
const { config } = await import('../apps/server/src/config.ts');
config.sandboxDir = path.join(root, 'sandbox');
const db = await import('../apps/server/src/db/database.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const conversations = await import('../apps/server/src/conversations/service.ts');
const dispatcher = await import('../apps/server/src/conversations/dispatcher.ts');
const recovery = await import('../apps/server/src/runs/recovery.ts');
const terminal = await import('../apps/server/src/runtime/terminal.ts');
const scheduler = await import('../apps/server/src/collaboration/scheduler.ts');
const collaboration = await import('../apps/server/src/collaboration/store.ts');
const authority = await import('../apps/server/src/execution/authority.ts');
const native = await import('../apps/server/src/execution/runner.ts');
const externalRecovery = await import('../apps/server/src/execution/recovery.ts');
const admission = await import('../apps/server/src/execution/memberAdmission.ts');
const attempts = await import('../apps/server/src/tasks/attempts.ts');
const tasks = await import('../apps/server/src/messaging/tasks.ts');
const coordination = await import('../apps/server/src/coordination/store.ts');
const taskAdapter = await import('../apps/server/src/runtime/taskAdapter.ts');
const cost = await import('../apps/server/src/orchestration/costBudget.ts');
const actions = await import('../apps/server/src/orchestration/actions.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { runAdmittedTurn } = await import('../apps/server/src/orchestration/admittedTurn.ts');
const { executeToolOnce } = await import('../apps/server/src/tools/executions.ts');
const approvals = await import('../apps/server/src/hitl/approvals.ts');
const { submitExecutionOrchestration } = await import('../apps/server/src/orchestration/entry.ts');
const { submitLegacyOrchestration } = await import('../apps/server/src/orchestration/service.ts');
const { commitWakeActionCommand } = await import('../apps/server/src/runtime/actionCommands.ts');
const { assessRunRecovery } = await import('../apps/server/src/runtime/recovery.ts');
const { isLegacyRun, assertLegacyRun } = await import('../apps/server/src/runs/legacyMode.ts');
const { isLegacyRunMode } = await import('../packages/shared/src/run.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');

const rejected = error => error?.code === 'LEGACY_MODE_REQUIRED';
const now = new Date().toISOString();
const before = '2000-01-01T00:00:00.000Z';
let executorCalls = 0;
const events = [];
const unsubscribe = subscribe(event => events.push(event));

function fixture(id, mode, roomMode = mode, status = 'running') {
  const conversationId = `room:${id}`;
  db.run('INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES(?,?,?,?,?,?)', conversationId, id, roomMode, '["sentinel"]', now, now);
  db.run('INSERT INTO runs(id,goal,mode,conversation_id,turn_no,status,agent_ids,created_at) VALUES(?,?,?,?,1,?,?,?)', id, id, mode, conversationId, status, '["sentinel"]', now);
  db.run(`INSERT INTO collaboration_dispatches(id,run_id,conversation_id,source_message_id,kind,from_actor,target_agent_id,status,idempotency_key,created_at)
    VALUES(?,?,?,'source','initial','user','sentinel','queued',?,?)`, `dispatch:${id}`, id, conversationId, id, now);
  db.run(`INSERT INTO collaboration_attempts(id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,lease_expires_at,created_at)
    VALUES(?,?,?,?,'sentinel',1,'running',?,?)`, `attempt:${id}`, `dispatch:${id}`, id, conversationId, before, now);
  db.run(`INSERT INTO execution_member_tickets(ticket_key,run_id,agent_id,status,created_at)
    VALUES(?,?,'sentinel','active',?)`, `ticket:${id}`, id, now);
  db.run(`INSERT INTO approvals(id,run_id,agent_id,tool_name,status,created_at)
    VALUES(?,?,'sentinel','sentinel','pending',?)`, `approval:${id}`, id, now);
  const execution = { id: `execution:${id}`, runId: id, agentId: 'sentinel', scopeId: id,
    driver: 'codex-exec', agentVersion: 1, cwd: root, status: 'running', sessionId: null,
    startedAt: now, finishedAt: null, content: '', tokensIn: null, tokensOut: null, costUsd: null,
    error: null, errorCode: null, driverVersion: null };
  db.run(`INSERT INTO external_agent_executions(id,run_id,agent_id,scope_id,status,record)
    VALUES(?,?,'sentinel',?,'running',?)`, execution.id, id, id, JSON.stringify(execution));
  db.run(`INSERT INTO external_agent_sessions(id,binding_key,status,execution_id,record)
    VALUES(?,?,'inflight',?,'{}')`, `session:${id}`, id, execution.id);
  return { id, conversationId, execution };
}

function snapshot() {
  const tables = ['runs', 'conversations', 'collaboration_dispatches', 'collaboration_attempts',
    'execution_member_tickets', 'external_agent_executions', 'external_agent_sessions', 'approvals',
    'runtime_run_terminals', 'runtime_action_commands', 'run_events', 'messages', 'execution_bindings',
    'tool_executions', 'orchestration_model_calls', 'runtime_holds'];
  return Object.fromEntries(tables.map(table => [table, db.all(`SELECT * FROM ${table} ORDER BY rowid`)]));
}

try {
  assert.equal(isLegacyRunMode('threaded'), false);
  assert.equal(isLegacyRunMode('future-mode'), false);
  for (const mode of ['pipeline', 'supervisor', 'collaboration']) assert.equal(isLegacyRunMode(mode), true);
  const fixtures = [fixture('threaded-running', 'threaded'), fixture('threaded-pending', 'threaded', 'threaded', 'pending'),
    fixture('threaded-approval', 'threaded', 'threaded', 'awaiting_approval'),
    fixture('unknown-mode', 'future-mode'), fixture('wrong-mode-threaded-room', 'pipeline', 'threaded'),
    fixture('wrong-mode-unknown-room', 'collaboration', 'future-mode')];
  const initial = snapshot();
  for (const item of fixtures) {
    const run = trace.getRun(item.id);
    assert.ok(run, 'Shared reads retain new-mode records for the dedicated API');
    assert.equal(isLegacyRun(item.id), false);
    assert.throws(() => assertLegacyRun(item.id), rejected);
    assert.throws(() => trace.setRunStatus(item.id, 'failed'), rejected);
    assert.throws(() => trace.finishRun(item.id, 'failed'), rejected);
    assert.throws(() => terminal.commitRunTerminal({ runId: item.id, status: 'cancelled', disposition: 'cancelled',
      source: 'legacy-isolation-test', closeExecution: () => executorCalls++, prepare: () => { executorCalls++; return {}; } }), rejected);
    assert.throws(() => commitWakeActionCommand({ runId: item.id, commandKey: item.id, execute: () => executorCalls++ }), rejected);
    assert.throws(() => assessRunRecovery(item.id), rejected);
    assert.throws(() => collaboration.createDispatch({ runId: item.id, conversationId: item.conversationId,
      sourceMessageId: 'source', kind: 'initial', from: 'user', targetAgentId: 'sentinel', depth: 0, idempotencyKey: `new:${item.id}` }), rejected);
    assert.equal(collaboration.claimNextDispatch(item.conversationId, 'test-owner'), null);
    assert.throws(() => admission.reserveMember(item.id, 'sentinel', 'forged'), rejected);
    assert.throws(() => approvals.decide(`approval:${item.id}`, { decision: 'approve', by: 'user' }), rejected);
    assert.throws(() => approvals.expireApproval(`approval:${item.id}`), rejected);
    for (const action of ['cancel', 'pause', 'resume']) await assert.rejects(actions.applyRunAction(item.id, action), rejected);
    assert.equal(authority.executionAuthorized(item.execution), false, 'Missing binding cannot use the legacy no-attempt fallback');
    assert.throws(() => authority.captureExecutionBinding(item.id, 'sentinel', 'forged'), rejected);
    const binding = { schemaVersion: 1, id: 'forged', origin: 'threaded_invocation_attempt', runId: item.id,
      threadId: 'thread', invocationId: 'invocation', attemptId: 'attempt', agentId: 'sentinel', ownerId: 'owner',
      authorityEpoch: 1, claimId: 'claim', generation: 1, fencingToken: 'fence' };
    assert.equal(authority.bindingAuthorized(binding), false);
    assert.equal(authority.bindingCanFailAttempt(binding), false);
    assert.equal(authority.bindingAuthorized({ ...binding, origin: 'task_attempt', taskId: 'task', startedAt: now, leaseOwner: 'owner' }), false);
    const opts = { run, messages: [], get agent() { executorCalls++; throw new Error('Executor dependency was reached'); } };
    for (const execute of [runAgentTurn, runAdmittedTurn, native.runExternalAgentTurn]) await assert.rejects(execute(opts), rejected);
    await assert.rejects(executeToolOnce({ runId: item.id, agentId: 'sentinel', toolName: 'sentinel',
      input: '{}', idempotencyKey: item.id, replayPolicy: 'manual', spanId: 'none',
      execute: async () => { executorCalls++; return 'unexpected'; } }), rejected);
    dispatcher.enqueueConversationRun(item.id);
    recovery.wakeRun(item.id);
    await dispatcher.resumeFastPathRun(item.id);
    scheduler.finalizeCollaborationRun(item.id);
    scheduler.settleCollaborationRun(item.id);
  }
  // The same handlers used at server startup must preserve unfamiliar records.
  await externalRecovery.recoverExternalExecutions();
  cost.recoverCostReservations();
  admission.recoverMemberAdmissions();
  attempts.interruptRunningAttempts();
  taskAdapter.reopenInterruptedTaskResponsibilities();
  collaboration.interruptExpiredAttempts({ onlyExpired: true });
  tasks.recoverInterruptedTasks();
  coordination.recoverInterruptedCoordinationSteps();
  dispatcher.recoverPendingConversationRuns();
  recovery.recoverDurableHolds();
  scheduler.recoverCollaborationRuns();
  recovery.recoverDurableRuns();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(snapshot(), initial, 'Legacy lifecycle/recovery must not mutate or terminalize threaded/unknown/mismatched records');
  assert.equal(executorCalls, 0, 'No executor dependencies, terminal hooks, wake callbacks or tool callbacks may run');
  assert.deepEqual(events, [], 'Rejected and skipped paths must emit no legacy events');

  assert.throws(() => trace.createRun('invalid', 'threaded', []), rejected);
  assert.throws(() => conversations.createConversation({ title: 'invalid', mode: 'threaded', agentIds: [], supervisorId: null, workspace: null }), rejected);
  assert.throws(() => submitExecutionOrchestration({ goal: 'invalid', mode: 'threaded', entryVersion: 2 }), rejected);
  assert.throws(() => submitLegacyOrchestration('direct_run', { goal: 'invalid', mode: 'threaded' }), rejected);
  assert.throws(() => submitExecutionOrchestration({ goal: 'invalid', entryVersion: 2 }, fixtures[0].conversationId), rejected);

  // Positive control: compatibility terminal behavior still works for all old modes.
  for (const mode of ['pipeline', 'supervisor', 'collaboration']) {
    const id = `legacy:${mode}`;
    db.run('INSERT INTO runs(id,goal,mode,status,agent_ids,created_at) VALUES(?,?,?,\'running\',\'[]\',?)', id, id, mode, now);
    assert.equal(isLegacyRun(id), true);
    assert.equal(trace.finishRun(id, 'failed'), true);
    assert.equal(trace.getRun(id).status, 'failed');
  }
  console.log('Threaded isolation passed: 6 malformed/new-mode fixtures; startup recovery unchanged; 0 executor/callback invocations; legacy terminal positive controls.');
} finally {
  unsubscribe();
  db.closeDatabase();
  await rm(root, { recursive: true, force: true });
}
