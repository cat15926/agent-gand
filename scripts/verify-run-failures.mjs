import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = await mkdtemp(path.join(tmpdir(), 'gand-failures-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'),
  SANDBOX_DIR: path.join(root, 'sandbox'), AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent' });
globalThis.fetch = () => { throw new Error('No provider/network in failure ledger verification'); };
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const store = await import('../apps/server/src/collaboration/store.ts');
const executions = await import('../apps/server/src/execution/store.ts');
const { runFailureReport } = await import('../apps/server/src/runs/failures.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { commitRunTerminal } = await import('../apps/server/src/runtime/terminal.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const { assessRunRecovery } = await import('../apps/server/src/runtime/recovery.ts');
const { commitHandoffActionCommand } = await import('../apps/server/src/runtime/actionCommands.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const { config } = await import('../apps/server/src/config.ts');
config.collaboration.maxConcurrency = 16;
const { getRunCoordinationPlan } = await import('../apps/server/src/coordination/store.ts');
const role = id => ({ id, name: id, description: 'failure fixture', model: 'mock:fixture', systemPrompt: 'Analyze only.',
  tools: [], disallowedTools: [], permissionMode: 'readonly', capabilities: ['execute'], color: '#4477aa', avatar: '' });
for (const id of ['host', 'peer', 'outsider']) registry.createAgent(role(id));

function fixture(name, privateSource = false) {
  const room = rooms.createConversation({ title: name, mode: 'collaboration', agentIds: ['host', 'peer', 'outsider'], workspace: null });
  const run = trace.createRun('failure fixture', 'collaboration', room.agentIds, null, null, room.id);
  trace.setRunStatus(run.id, 'running');
  const admission = planCollaborationAdmission({ runId: run.id, objective: run.goal, participantIds: run.agentIds, targetAgentIds: run.agentIds,
    completionEngine: true, controlActionVersion: 2, messageVisibilityVersion: 1,
    completionCandidateVersion: 1, successorObligationVersion: 1, evidenceBundleVersion: 1,
    contextContributorVersion: 1, durableHoldVersion: 2, exitGuard: { version: 1, maxCorrections: 1, correctionMaxTokens: 512 } });
  freezeRuntimeContract(admission.contract);
  const dispatches = run.agentIds.map(id => {
    const message = inbox.post({ runId: run.id, from: 'user', to: id, kind: 'user', body: 'fixture input',
      ...(privateSource && id === 'host' ? { visibility: 'private', audience: ['user', 'host'] } : {}) });
    return store.createDispatch({ runId: run.id, conversationId: room.id, sourceMessageId: message.id, kind: 'initial', from: 'user', targetAgentId: id, depth: 0, idempotencyKey: name + ':' + id });
  });
  observeAdmission(admission.contract, admission.subjects, dispatches.map(item => item.id));
  const claims = run.agentIds.map(() => store.claimNextDispatch(room.id, 'fixture'));
  assert.ok(claims.every(Boolean), JSON.stringify(store.listDispatches(run.id)));
  return { run, room, claims };
}
function fail(f, index, error, code = 'timeout', extra = {}) {
  const claim = f.claims[index];
  store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id, status: 'failed', error });
  const record = executions.createExecution({ runId: f.run.id, agentId: claim.attempt.agentId, scopeId: claim.attempt.id, driver: 'claude-sdk', agentVersion: 1, cwd: root });
  executions.updateExecution(record.id, { status: 'failed', permissionMode: 'readonly', attemptId: claim.attempt.id, error, errorCode: code, finishedAt: new Date().toISOString(), ...extra });
  return record;
}
const terminal = f => commitRunTerminal({ runId: f.run.id, status: 'failed', disposition: 'failed', source: 'failure_fixture', prepare: () => ({ reasonCodes: ['FAILED_DISPATCH'] }) });
try {
  const f = fixture('two roots');
  const first = fail(f, 0, '首响应等待超时', 'timeout', { failureDetails: { timeoutKind: 'first_response', phase: 'before_first_activity',
    stderr: 'Authorization: Bearer fixture_secret_token_12345678', secondary: [{ step: 'evidence_capture', message: '证据目录不可读取' }] } });
  const second = fail(f, 1, '登录未完成', 'auth_required');
  terminal(f);
  const thirdClaim = f.claims[2];
  store.finishAttempt({ attemptId: thirdClaim.attempt.id, dispatchId: thirdClaim.dispatch.id, status: 'cancelled', error: '后续停止' });
  const third = executions.createExecution({ runId: f.run.id, agentId: 'outsider', scopeId: 'cancelled', driver: 'codex-app-server', agentVersion: 1, cwd: root });
  executions.updateExecution(third.id, { status: 'cancelled', attemptId: thirdClaim.attempt.id, errorCode: 'cancelled', error: '原任务失败，后续停止', failureDetails: { cause: { kind: 'run_terminal', id: f.run.id } } });
  const evidenceOnly = executions.createExecution({ runId: f.run.id, agentId: 'peer', scopeId: 'completed-with-secondary', driver: 'claude-sdk', agentVersion: 1, cwd: root });
  executions.updateExecution(evidenceOnly.id, { status: 'completed', failureDetails: { secondary: [{ step: 'evidence_capture', message: '仅证据采集异常' }] } });
  const before = db.db.prepare('SELECT * FROM run_events WHERE run_id=?').all(f.run.id);
  const report = runFailureReport(f.run.id);
  assert.deepEqual(new Set(report.primaryNodeIds), new Set([`execution:${first.id}`, `execution:${second.id}`]));
  assert.ok(report.links.some(edge => edge.relation === 'terminal_cancel' && edge.to === `execution:${third.id}`));
  assert.equal(report.links.filter(edge => edge.relation === 'failed_at_terminal').length, 2);
  assert.ok(report.nodes.some(node => node.role === 'secondary' && node.message === '证据目录不可读取'));
  assert.doesNotMatch(JSON.stringify(report), /fixture_secret_token|cwd|inputContext/);
  assert.deepEqual(db.db.prepare('SELECT * FROM run_events WHERE run_id=?').all(f.run.id), before, 'diagnostic read never changes evidence');
  terminal(f);
  assert.equal(trace.listEvents(f.run.id).filter(event => event.name === 'failure:terminal_boundary').length, 1, 'duplicate terminal creates no extra boundary');
  const cold = JSON.parse(execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
    `const {runFailureReport}=await import('./apps/server/src/runs/failures.ts'); console.log(JSON.stringify(runFailureReport(${JSON.stringify(f.run.id)})));`], { cwd: path.resolve('.'), env: process.env, encoding: 'utf8' }));
  assert.deepEqual(cold.primaryNodeIds, report.primaryNodeIds); assert.deepEqual(cold.links, report.links, 'cold process uses persisted causes');

  const closing = fixture('terminal cleanup'); const rootFailure = fail(closing, 0, '真实执行超时');
  commitRunTerminal({ runId: closing.run.id, status: 'failed', disposition: 'failed', source: 'cleanup_fixture', closeExecution: () => {
    for (const claim of closing.claims.slice(1)) store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id, status: 'failed', error: 'closed by adapter' });
  } });
  const cleanup = runFailureReport(closing.run.id);
  assert.deepEqual(cleanup.primaryNodeIds, ['execution:' + rootFailure.id], 'terminal cleanup cannot manufacture primary failures');
  assert.equal(cleanup.links.filter(edge => edge.relation === 'failed_at_terminal').length, 1);
  assert.equal(cleanup.nodes.filter(node => node.kind === 'dispatch' && node.role === 'affected').length, 2);

  const retried = fixture('historical retry'); const oldFailure = fail(retried, 0, '旧调用超时');
  const oldClaim = retried.claims[0], newAttemptId = randomUUID(), at = new Date().toISOString();
  db.run(`INSERT INTO collaboration_attempts(id,dispatch_id,run_id,conversation_id,agent_id,attempt_no,status,created_at,started_at,ended_at)
    VALUES(?,?,?,?,?,2,'completed',?,?,?)`, newAttemptId, oldClaim.dispatch.id, retried.run.id, retried.room.id, 'host', at, at, at);
  db.run("UPDATE collaboration_dispatches SET status='completed',error=NULL WHERE id=?", oldClaim.dispatch.id);
  const oldSpan = trace.startSpan(retried.run.id, { spanKind: 'llm', name: 'old model failure', attributes: { 'collaboration.attempt.id': oldClaim.attempt.id } });
  trace.endSpan(oldSpan, { status: 'error', output: '旧供应商错误', attributes: { 'llm.http_status': 403, 'llm.request_id': 'req_historical' } });
  const currentFailure = fail(retried, 1, '本次模型错误');
  store.finishAttempt({ attemptId: retried.claims[2].attempt.id, dispatchId: retried.claims[2].dispatch.id, status: 'completed', output: 'independent result' });
  terminal(retried);
  const history = runFailureReport(retried.run.id);
  assert.deepEqual(history.primaryNodeIds, ['execution:' + currentFailure.id]);
  assert.equal(history.nodes.find(node => node.id === 'execution:' + oldFailure.id).resolved, true);
  const historicSpan = history.nodes.find(node => node.refs.spanId === oldSpan.id);
  assert.equal(historicSpan.resolved, true); assert.equal(historicSpan.refs.attemptId, oldClaim.attempt.id);
  assert.deepEqual(historicSpan.providerDiagnostic, { httpStatus: 403, requestId: 'req_historical' });
  const controlled = trace.startSpan(retried.run.id, { spanKind: 'tool', name: 'native:agent_handoff', attributes: { 'collaboration.attempt.id': retried.claims[1].attempt.id } });
  trace.endSpan(controlled, { status: 'ok', output: 'controlled stop', attributes: { 'tool.outcome': 'control_interruption' } });
  const uncertain = trace.startSpan(retried.run.id, { spanKind: 'tool', name: 'native:command', attributes: { 'collaboration.attempt.id': retried.claims[1].attempt.id } });
  trace.endSpan(uncertain, { status: 'error', output: 'no terminal event', attributes: { 'tool.outcome': 'missing_terminal' } });
  const controlledReport = runFailureReport(retried.run.id);
  assert.equal(controlledReport.nodes.find(node => node.refs.spanId === controlled.id).role, 'control_interruption');
  assert.equal(controlledReport.nodes.find(node => node.refs.spanId === controlled.id).control.state, 'candidate_only');
  assert.equal(controlledReport.nodes.find(node => node.refs.spanId === uncertain.id).role, 'unknown');
  assert.deepEqual(controlledReport.primaryNodeIds, history.primaryNodeIds, 'control/missing-terminal records are not proven primary tool failures');

  const committedControl = fixture('committed control'); const sender = committedControl.claims[0];
  const command = commitHandoffActionCommand({ runId: committedControl.run.id, commandKey: 'fixture-control:' + sender.attempt.id,
    attemptId: sender.attempt.id, dispatchId: sender.dispatch.id, execute: () => null }).command;
  const controlSpan = trace.startSpan(committedControl.run.id, { spanKind: 'tool', name: 'native:agent_handoff', attributes: { 'collaboration.attempt.id': sender.attempt.id } });
  trace.endSpan(controlSpan, { status: 'ok', output: 'controlled interruption', attributes: { 'tool.outcome': 'control_interruption' } });
  store.finishAttempt({ attemptId: sender.attempt.id, dispatchId: sender.dispatch.id, status: 'completed', output: 'handoff committed' });
  fail(committedControl, 1, '接收成员超时');
  store.finishAttempt({ attemptId: committedControl.claims[2].attempt.id, dispatchId: committedControl.claims[2].dispatch.id, status: 'completed', output: 'confirmed' });
  terminal(committedControl);
  assert.deepEqual(runFailureReport(committedControl.run.id).nodes.find(node => node.refs.spanId === controlSpan.id).control,
    { state: 'committed', kind: 'handoff', commandId: command.id });

  const lateCancel = fixture('late cancellation'); fail(lateCancel, 0, '临时超时');
  for (const claim of lateCancel.claims.slice(1)) store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id, status: 'completed', output: 'confirmed' });
  terminal(lateCancel);
  const late = executions.createExecution({ runId: lateCancel.run.id, agentId: 'peer', scopeId: 'late cancelled', driver: 'codex-app-server', agentVersion: 1, cwd: root });
  executions.updateExecution(late.id, { status: 'cancelled', attemptId: lateCancel.claims[1].attempt.id, permissionMode: 'readonly', errorCode: 'cancelled' });
  assert.equal(assessRunRecovery(lateCancel.run.id).category, 'temporary_failure', 'late cancellation cannot replace the failed member recovery category');

  const hidden = fixture('private', true);
  const secret = fail(hidden, 0, 'PRIVATE_DIAGNOSTIC_SECRET');
  for (const claim of hidden.claims.slice(1)) store.finishAttempt({ attemptId: claim.attempt.id, dispatchId: claim.dispatch.id, status: 'completed', output: 'confirmed' });
  terminal(hidden);
  assert.match(JSON.stringify(runFailureReport(hidden.run.id)), /PRIVATE_DIAGNOSTIC_SECRET/);
  const publicReport = runFailureReport(hidden.run.id, 'outsider');
  assert.doesNotMatch(JSON.stringify(publicReport), /PRIVATE_DIAGNOSTIC_SECRET/);
  assert.equal(publicReport.nodes.some(node => node.refs.executionId === secret.id), false);
  assert.equal(publicReport.recovery, null); assert.deepEqual(publicReport.primaryNodeIds, []);

  const rollback = fixture('rollback'); fail(rollback, 0, 'fixture failed');
  const emitted = []; const off = subscribe(event => emitted.push(event));
  assert.throws(() => db.tx(() => { terminal(rollback); throw new Error('ROLLBACK'); }), /ROLLBACK/);
  off(); assert.equal(trace.getRun(rollback.run.id).status, 'running');
  assert.equal(trace.listEvents(rollback.run.id).some(event => event.name === 'failure:terminal_boundary'), false);
  assert.equal(emitted.length, 0, 'rollback publishes no diagnostic or terminal');
  store.cancelCollaborationRun(rollback.run.id);

  const input = { goal: '两阶段分析', agentIds: ['host', 'peer'], strategy: 'serial', workflow: 'routine', constraints: { readonly: true } };
  const preview = await entry.previewExecutionOrchestration(input);
  const coordinated = entry.submitExecutionOrchestration({ ...input, entryVersion: 1, clientRequestId: 'failure-coordination', previewId: preview.previewId, orchestrationFingerprint: preview.fingerprint });
  const plan = getRunCoordinationPlan(coordinated.run.id); assert.ok(plan?.steps.length > 1);
  const failedStep = plan.steps[0], downstream = plan.steps.find(step => step.dependsOn.includes(failedStep.id)); assert.ok(downstream);
  db.run("UPDATE coordination_step_states SET status='failed',error='upstream failed' WHERE plan_id=? AND step_id=?", plan.id, failedStep.id);
  commitRunTerminal({ runId: coordinated.run.id, status: 'failed', disposition: 'failed', source: 'coordination_failure' });
  const graph = runFailureReport(coordinated.run.id);
  assert.ok(graph.nodes.some(node => node.refs.stepId === downstream.id && node.role === 'affected'));
  assert.equal(graph.nodes.find(node => node.refs.stepId === downstream.id).resolved, false);
  assert.ok(graph.links.some(edge => edge.relation === 'depends_on' && edge.from.endsWith(':' + failedStep.id) && edge.to.endsWith(':' + downstream.id)));

  const legacy = fixture('legacy'); fail(legacy, 0, 'legacy'); trace.setRunStatus(legacy.run.id, 'failed');
  const historical = runFailureReport(legacy.run.id);
  assert.equal(historical.links.some(edge => edge.relation === 'failed_at_terminal'), false, 'never infer historical causality from chronology');
  const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
  const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
  const app = Fastify(); await registerRoutes(app);
  try { assert.equal((await app.inject(`/api/runs/${f.run.id}/failures`)).statusCode, 200); assert.equal((await app.inject('/api/runs/not-found/failures')).statusCode, 404); }
  finally { await app.close(); }
  console.log('Run failures verified: independent roots, explicit terminal/cancellation links, secondary evidence, privacy, redaction, immutable reads, rollback, cold read, dependencies and HTTP contract');
} finally { db.closeDatabase(); await rm(root, { recursive: true, force: true }); }
