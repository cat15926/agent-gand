import assert from 'node:assert/strict';
process.env.EXTERNAL_WORKSPACE_MODE = 'registered'; // Phase D tests cover isolated worktrees separately.
import { readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-c-'));
const workspace = path.join(root, 'repo'); await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), 'fixture\n');
execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, 'add', '.']);
execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
const cli = path.join(root, 'native'); await copyFile(new URL('./fixtures/external-agent-c.mjs', import.meta.url), cli); await chmod(cli, 0o755);
const log = path.join(root, 'native.jsonl'); await writeFile(log, '');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'agents'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  EXTERNAL_CODEX_COMMAND: cli, EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: cli, EXTERNAL_CODEX_HOME: path.join(root, 'codex'), EXTERNAL_AGENT_TIMEOUT_MS: '15000',
  ANTHROPIC_API_KEY: 'fixture-never-used', FAKE_C_LOG: log, FAKE_C_SERVER_ROOT: fileURLToPath(new URL('../apps/server', import.meta.url)) });
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { db, closeDatabase } = await import('../apps/server/src/db/database.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { getRun, createRun, startSpan, finishRun, listRunAgentSnapshots } = await import('../apps/server/src/runs/trace.ts');
const { createConversation } = await import('../apps/server/src/conversations/service.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const { createExecution, updateExecution, listExecutions } = await import('../apps/server/src/execution/store.ts');
const { createExecutionBridge } = await import('../apps/server/src/execution/bridge.ts');
const { collaborationControlTools, parseControlCall } = await import('../apps/server/src/collaboration/controlTools.ts');
const { admitCollaborationRun } = await import('../apps/server/src/collaboration/scheduler.ts');
const { claimNextDispatch, listDispatches, listAttempts, listDecisions, cancelCollaborationRun, interruptExpiredAttempts } = await import('../apps/server/src/collaboration/store.ts');
const { loadResponsibilitySnapshot } = await import('../apps/server/src/runtime/responsibilitySnapshot.ts');
const { recoverDurableHolds } = await import('../apps/server/src/runs/recovery.ts');
const { listRuntimeActionCommands } = await import('../apps/server/src/runtime/actionCommands.ts');
const { listToolExecutions } = await import('../apps/server/src/tools/executions.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const app = Fastify(); await registerRoutes(app); const registered = registerExternal({ path: workspace });
const api = async (url, method = 'GET', body) => { const response = await app.inject({ url, method, ...(body ? { payload: body } : {}) }); return { status: response.statusCode, data: response.json() }; };
const logs = async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const handoffFences = [];
const unsubscribe = subscribe((event) => {
  if (event.type !== 'runtime.action_command.committed' || event.command.kind !== 'handoff') return;
  const child = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((item) => item.kind === 'child').at(-1);
  handoffFences.push({ runId: event.command.runId, reaped: !!child && !alive(child.pid) && !alive(child.childPid) });
});
async function waitFor(fn, label, timeout = 18000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await fn(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error('Timeout: ' + label); }
const definition = (id, driver, model = 'fixture-complete', more = {}) => ({ id, name: id, description: '阶段 C 验收', systemPrompt: '使用当前 Runtime 工具处理责任。', model,
  execution: { kind: 'external', driver }, permissionMode: 'readonly', capabilities: ['execute'], tools: [], disallowedTools: [], color: '#6655aa', avatar: '', ...more });
async function agent(...args) { const result = await api('/api/agents', 'POST', definition(...args)); assert.equal(result.status, 201, JSON.stringify(result.data)); }
async function room(ids, goal = 'C-SCENARIO:complete') { const result = await api('/api/conversations', 'POST', { mode: 'collaboration', agentIds: ids, goal, workspace: 'ext:' + registered.id }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data; }
async function complete(runId) { await waitFor(() => ['completed', 'failed', 'waiting_for_user'].includes(getRun(runId)?.status), 'Runtime terminal'); assert.equal(getRun(runId).status, 'completed', JSON.stringify(listDispatches(runId))); await waitFor(() => listExecutions(runId).every((record) => record.status !== 'running'), 'native cleanup'); }

try {
  await agent('sdk-worker', 'claude-sdk'); await agent('codex-worker', 'codex-app-server');
  await agent('sdk-handoff', 'claude-sdk', 'fixture-handoff'); await agent('codex-handoff', 'codex-app-server', 'fixture-handoff');
  await agent('sdk-plain', 'claude-sdk', 'fixture-plain'); await agent('codex-plain', 'codex-app-server', 'fixture-plain');
  await agent('sdk-forge', 'claude-sdk', 'fixture-forge');
  const builtin = await api('/api/agents', 'POST', { ...definition('builtin-worker', 'claude-sdk', 'mock:worker'), execution: { kind: 'builtin-llm' } }); assert.equal(builtin.status, 201);
  for (const id of ['sdk-worker', 'codex-worker', 'sdk-forge']) {
    const { run } = await room([id]); await complete(run.id);
    assert.equal(listRuntimeActionCommands(run.id).filter((item) => item.kind === 'complete').length, 1);
    assert.equal(listExecutions(run.id)[0].controlAction.type, 'complete');
  }
  // Both carrier directions, plus control-only correction in the same Attempt/scope.
  for (const ids of [['sdk-handoff', 'codex-plain'], ['codex-handoff', 'sdk-plain']]) {
    const { run } = await room(ids, 'C-SCENARIO:handoff'); await complete(run.id);
    assert.deepEqual(listRuntimeActionCommands(run.id).map((item) => item.kind), ['handoff', 'complete']);
    assert.ok(handoffFences.some((fence) => fence.runId === run.id && fence.reaped), 'Native process group must exit before handoff commits');
    const records = listExecutions(run.id); assert.equal(records.length, 2); assert.equal(records[1].exitCorrectionAttempts, 1);
    assert.ok(records.every((record) => record.attemptId && record.runtimeBinding));
    assert.ok(!(await logs()).some((item) => item.kind === 'late-write'));
    const child = (await logs()).filter((item) => item.kind === 'child').at(-1); assert.ok(!alive(child.pid) && !alive(child.childPid));
  }
  for (const join of ['all', 'any']) {
    await agent('sdk-consult-' + join, 'claude-sdk', 'fixture-consult-' + join);
    const { run } = await room(['sdk-consult-' + join, 'codex-worker', 'builtin-worker'], 'C-SCENARIO:consult'); await complete(run.id);
    assert.equal(listRuntimeActionCommands(run.id).filter((item) => item.kind === 'consult_' + join).length, 1);
    assert.ok(listDispatches(run.id).some((item) => item.kind === 'aggregate'));
  }
  await agent('codex-no-correction', 'codex-app-server', 'fixture-no-correction');
  const exhausted = await room(['sdk-handoff', 'codex-no-correction'], 'C-SCENARIO:bounded-correction');
  await waitFor(() => ['waiting_for_user', 'failed'].includes(getRun(exhausted.run.id)?.status), 'correction exhaustion');
  assert.equal(listExecutions(exhausted.run.id).find((item) => item.agentId === 'codex-no-correction').exitCorrectionAttempts, 1);
  assert.equal(listRuntimeActionCommands(exhausted.run.id).filter((item) => item.kind === 'complete').length, 0, 'Plain stdout cannot bypass Completion');
  await api(`/api/collaboration/runs/${exhausted.run.id}/stop`, 'POST');
  for (const [driver, id] of [['claude-sdk', 'sdk-hold'], ['codex-app-server', 'codex-hold']]) {
    await agent(id, driver, 'fixture-hold-user');
    const { run } = await room([id], 'C-SCENARIO:hold-user');
    const decision = await waitFor(() => listDecisions(run.id).find((item) => item.status === 'pending'), 'durable user Hold');
    assert.equal(getRun(run.id).status, 'waiting_for_user'); assert.ok(listExecutions(run.id).every((record) => record.status === 'completed'));
    const answer = { action: 'answer', message: '允许继续并完成。' };
    assert.equal((await api(`/api/collaboration/decisions/${decision.id}/resolve`, 'POST', answer)).status, 200);
    assert.equal((await api(`/api/collaboration/decisions/${decision.id}/resolve`, 'POST', answer)).status, 200);
    await complete(run.id); assert.equal(listDispatches(run.id).filter((item) => item.kind === 'resume').length, 1);
  }
  await agent('codex-timer', 'codex-app-server', 'fixture-hold-timer');
  const timed = await room(['codex-timer'], 'C-SCENARIO:hold-timer');
  await waitFor(() => db.prepare('SELECT id FROM runtime_holds WHERE run_id=?').get(timed.run.id), 'timer Hold');
  await waitFor(() => { recoverDurableHolds(timed.run.id); return getRun(timed.run.id)?.status === 'completed'; }, 'timer wake');
  await complete(timed.run.id); assert.equal(listDispatches(timed.run.id).filter((item) => item.kind === 'resume').length, 1);

  await agent('sdk-business', 'claude-sdk', 'fixture-business', { permissionMode: 'confirm', execution: { kind: 'external', driver: 'claude-sdk', platformTools: ['fs.write'] } });
  const business = await room(['sdk-business'], 'C-SCENARIO:business');
  const approval = await waitFor(async () => (await api('/api/approvals?status=pending')).data.find((item) => item.runId === business.run.id), 'business approval');
  await assert.rejects(() => readFile(path.join(workspace, 'bridge-result.txt')));
  assert.equal((await api(`/api/approvals/${approval.id}/decide`, 'POST', { decision: 'approve' })).status, 200);
  await complete(business.run.id);
  assert.equal(await readFile(path.join(workspace, 'bridge-result.txt'), 'utf8'), 'MCP ledger evidence\n');
  assert.equal(listToolExecutions(business.run.id).filter((tool) => tool.toolName === 'fs.write' && tool.status === 'completed').length, 1);

  // Per-Agent Stop, without relying on a Run terminal event.
  await agent('codex-wait', 'codex-app-server', 'fixture-wait');
  const stopping = await room(['codex-wait']);
  await waitFor(async () => (await logs()).find((item) => item.kind === 'start' && item.model === 'fixture-wait'), 'waiting native');
  assert.equal((await api('/api/collaboration/agents/codex-wait/stop', 'POST', { conversationId: stopping.conversation.id })).status, 409);
  assert.equal(getRun(stopping.run.id).status, 'running', '缺少 Run 的停止请求不能撤销当前执行');
  assert.equal((await api('/api/collaboration/agents/codex-wait/stop', 'POST', { conversationId: stopping.conversation.id, runId: stopping.run.id })).status, 200);
  assert.ok(listExecutions(stopping.run.id).every((item) => item.status !== 'running'));

  // Direct authenticated callback contract with real Runtime custody, isolated from scheduling.
  const conversation = createConversation({ title: 'callback fences', mode: 'collaboration', agentIds: ['sdk-worker', 'codex-worker'], workspace: 'ext:' + registered.id });
  const run = createRun('callback fences', 'collaboration', conversation.agentIds, conversation.workspace, null, conversation.id, 1);
  admitCollaborationRun(run, conversation);
  const claim = claimNextDispatch(conversation.id, 'test-owner'); assert.ok(claim);
  const actor = listRunAgentSnapshots(run.id)[0]; const snapshot = loadResponsibilitySnapshot({ runId: run.id, attemptId: claim.attempt.id });
  const execution = createExecution({ runId: run.id, agentId: actor.id, scopeId: 'callback', driver: 'claude-sdk', agentVersion: actor.version, cwd: workspace });
  Object.assign(execution, { attemptId: claim.attempt.id, permissionMode: 'readonly', runtimeBinding: { subjectId: snapshot.subjectId, generation: snapshot.custody.generation, contractRevision: snapshot.contractRevision } }); updateExecution(execution.id, execution);
  const opts = { run, agent: actor, attemptId: claim.attempt.id, parentSpanId: startSpan(run.id, { spanKind: 'agent', name: 'callback' }).id, messages: [],
    controlTools: collaborationControlTools(2, { externalWaitVersion: 1, consultAnyVersion: 1 }), handleControlCalls: (calls) => parseControlCall(calls[0], run.agentIds, actor.id, 2, { externalWaitVersion: 1, consultAnyVersion: 1 }) };
  const bridge = await createExecutionBridge(opts, execution, new AbortController().signal, false);
  const callback = (body, credential = bridge.launch.env.AGENT_GAND_BRIDGE_TOKEN) => fetch(bridge.launch.env.AGENT_GAND_BRIDGE_URL + 'call', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await callback({ requestId: 'bad', name: 'agent_complete', arguments: { summary: 'x' } }, 'wrong')).status, 403);
    assert.equal((await callback({ requestId: 'forged', name: 'agent_complete', arguments: { summary: 'x', subjectId: 'foreign' } })).status, 400);
    const body = { requestId: 'same', name: 'agent_handoff', arguments: { target: 'codex-worker', objective: 'next', reason: 'test' } };
    const [first, second] = await Promise.all([callback(body), callback(body)]); assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.equal((await callback({ ...body, arguments: { ...body.arguments, objective: 'mutated' } })).status, 400);
    assert.equal((await callback({ requestId: 'conflict', name: 'agent_complete', arguments: { summary: 'wrong' } })).status, 400);
    assert.equal(listRuntimeActionCommands(run.id).length, 0, 'MCP may only prepare a candidate');
    db.prepare('UPDATE runtime_custody SET generation=generation+1 WHERE subject_id=?').run(snapshot.subjectId);
    assert.equal((await callback(body)).status, 403, 'Old credential must lose authority after generation changes');
  } finally { await bridge.close(); cancelCollaborationRun(run.id); finishRun(run.id, 'cancelled'); updateExecution(execution.id, { status: 'cancelled' }); }
  // Native effects remain uncertain even when the platform tool ledger is empty.
  const recoveryConversation = createConversation({ title: 'native recovery fence', mode: 'collaboration', agentIds: ['sdk-worker'], workspace: 'ext:' + registered.id });
  const recoveryRun = createRun('native recovery fence', 'collaboration', recoveryConversation.agentIds, recoveryConversation.workspace, null, recoveryConversation.id, 1);
  admitCollaborationRun(recoveryRun, recoveryConversation);
  const recoveryClaim = claimNextDispatch(recoveryConversation.id, 'recovery-owner'); assert.ok(recoveryClaim);
  const uncertain = createExecution({ runId: recoveryRun.id, agentId: 'sdk-worker', scopeId: 'uncertain', driver: 'claude-sdk', agentVersion: 1, cwd: workspace });
  updateExecution(uncertain.id, { attemptId: recoveryClaim.attempt.id });
  db.prepare("UPDATE collaboration_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(recoveryClaim.attempt.id);
  assert.ok(interruptExpiredAttempts({ onlyExpired: true }).includes(recoveryConversation.id));
  assert.equal(listToolExecutions(recoveryRun.id).length, 0);
  assert.equal(listDispatches(recoveryRun.id).find((item) => item.id === recoveryClaim.dispatch.id).status, 'failed', 'Uncertain native effects must not be requeued');
  cancelCollaborationRun(recoveryRun.id); finishRun(recoveryRun.id, 'cancelled'); updateExecution(uncertain.id, { status: 'interrupted' });
  console.log('Phase C verified: real stdio MCP bridge, mixed handoff/consult, control-only correction, durable user/timer Holds, business approval/ledger, Stop, request deduplication and custody fences');
} catch (error) {
  console.error(db.prepare('SELECT record FROM external_agent_executions').all().map(({ record }) => { const r = JSON.parse(record); return { agent: r.agentId, status: r.status, error: r.error, action: r.controlAction }; }));
  console.error((await logs()).filter((item) => item.kind === 'error').slice(-5));
  throw error;
} finally { unsubscribe(); await shutdownExternalAgents(); await app.close(); closeDatabase(); await rm(root, { recursive: true, force: true }); }
