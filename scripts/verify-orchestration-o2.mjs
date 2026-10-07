import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-o2-'));
const repository = path.join(root, 'repo'); await mkdir(repository);
await writeFile(path.join(repository, 'README.md'), 'O2 baseline\n');
execFileSync('git', ['init', '-q', repository]); execFileSync('git', ['-C', repository, 'add', '.']);
execFileSync('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'baseline']);
const native = path.join(root, 'native'); await copyFile(new URL('./fixtures/external-agent-o2.mjs', import.meta.url), native); await chmod(native, 0o755);
const logFile = path.join(root, 'native.jsonl'); await writeFile(logFile, '');
const codexHome = path.join(root, 'codex'); await mkdir(codexHome);
await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'o2-fixture' } }));
Object.assign(process.env, { NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
  DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  COORDINATION_PLANNER_MODEL: '', COORDINATION_RUNTIME_KERNEL: 'execute', APPROVAL_TIMEOUT_MS: '0',
  EXTERNAL_WORKSPACE_MODE: 'isolated', EXTERNAL_AGENT_TIMEOUT_MS: '12000', EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: native,
  EXTERNAL_CODEX_COMMAND: native, EXTERNAL_CODEX_HOME: codexHome, EXTERNAL_CLAUDE_HOME: path.join(root, 'claude'),
  ANTHROPIC_API_KEY: 'fixture-not-a-real-key', LLM_OPENAI_API_KEY: '', LLM_ANTHROPIC_API_KEY: '',
  FAKE_D_LOG: logFile, FAKE_O2_SERVER_ROOT: path.resolve('apps/server') });
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const service = await import('../apps/server/src/orchestration/service.ts');
const { previewCoordination, prepareCoordination } = await import('../apps/server/src/coordination/service.ts');
const { buildCoordinationPlan } = await import('../apps/server/src/coordination/compiler.ts');
const store = await import('../apps/server/src/coordination/store.ts');
const runtime = await import('../apps/server/src/coordination/runtime.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const authority = await import('../apps/server/src/execution/authority.ts');
const executions = await import('../apps/server/src/execution/store.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const { recoverExternalExecutions } = await import('../apps/server/src/execution/recovery.ts');
const approvals = await import('../apps/server/src/hitl/approvals.ts');
const holds = await import('../apps/server/src/runtime/holds.ts');
const { createExecutionBridge } = await import('../apps/server/src/execution/bridge.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { getIsolatedWorkspace } = await import('../apps/server/src/workspaces/isolated.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const app = Fastify(); await app.register(registerRoutes);
const workspace = 'ext:' + registerExternal({ path: repository, trusted: true }).id;
const checks = [];
const originalFetch = globalThis.fetch;
let providerRequests = 0;
globalThis.fetch = (url, ...args) => {
  if (!String(url).startsWith('http://127.0.0.1:')) { providerRequests++; throw new Error('O2 forbids provider requests'); }
  return originalFetch(url, ...args);
};
const role = (id, more = {}) => ({ id, name: id, description: 'O2 fixture', systemPrompt: 'Execute current step.', capabilities: ['execute'],
  model: 'mock:fixture', permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '🤖', ...more });
async function waitFor(fn, label, timeout = 18000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Timeout: ' + label); }
const logs = async () => (await readFile(logFile, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
async function seed(ids, protocol = 'single_agent', more = {}) {
  const goal = more.goal ?? 'O2 fixture goal';
  const preview = protocol === 'supervisor_aggregation'
    ? await prepareCoordination({ goal, agentIds: ids, requestedProtocol: 'parallel_fanout', deterministicOnly: true })
    : await previewCoordination({ goal, agentIds: ids, requestedProtocol: protocol, deterministicOnly: true });
  if (protocol === 'supervisor_aggregation') {
    preview.draft.protocols = [{ protocol: 'parallel_fanout', version: 1 }, { protocol: 'supervisor_aggregation', version: 1 }];
    preview.plan = buildCoordinationPlan(preview.draft, preview.snapshot);
    store.savePlanningResult(preview.snapshot, preview.draft, preview.plan);
  }
  assert.deepEqual(preview.draft.validationErrors, [], JSON.stringify(preview.plan.validationIssues));
  const result = service.submitLegacyOrchestration('room_create', { goal, mode: preview.plan.runtimeMode, agentIds: ids,
    coordinationDraftId: preview.draft.id, ...(more.workspace ? { workspace: more.workspace } : {}) });
  return result;
}
async function approvePending(runId) {
  for (const row of db.all("SELECT id FROM approvals WHERE run_id=? AND status='pending'", runId)) approvals.decide(row.id, { decision: 'approve', by: 'fixture' });
  for (const hold of holds.claimReadyDurableHolds({ claimOwner: 'o2-fixture', runId })) holds.completeDurableHoldClaim({ id: hold.id, claimToken: hold.claimToken });
}
async function execute(value) {
  let settled = false; const promise = runtime.runCoordinationPlan(value.run, value.run.goal).finally(() => { settled = true; });
  void promise.catch(() => {});
  await waitFor(async () => { await approvePending(value.run.id); return settled; }, 'coordination completed');
  await promise; assert.equal(trace.getRun(value.run.id).status, 'completed');
  assert.equal(db.get("SELECT COUNT(*) n FROM tasks WHERE run_id=?", value.run.id).n, 0, 'Coordination must not create task attempts');
}
function claim(value) {
  trace.setRunStatus(value.run.id, 'running'); store.setCoordinationPlanStatus(value.plan.id, 'active');
  const plan = store.getRunCoordinationPlan(value.run.id); const step = plan.steps[0];
  const result = store.claimCoordinationStep(plan, step, 'O2 bound input'); assert.ok(result.executionBinding);
  return { ...value, plan, step, claimed: result, binding: result.executionBinding };
}
function options(value, more = {}) { return { run: value.run, agent: trace.listRunAgentSnapshots(value.run.id).find(agent => agent.id === value.step.agentId),
  parentSpanId: trace.startSpan(value.run.id, { spanKind: 'agent', name: 'o2-manual' }).id,
  messages: [{ role: 'user', content: 'O2 fixture input' }], attemptId: value.claimed.attempt.id,
  executionScopeId: value.claimed.attempt.idempotencyKey, executionBinding: value.binding, workspaceScope: value.plan.id.slice(0, 8), ...more }; }
try {
  registry.createAgent(role('api'));
  registry.createAgent(role('api-review', { capabilities: ['review'] }));
  registry.createAgent(role('manager', { capabilities: ['coordinate', 'execute'] }));
  for (const [id, driver] of [['sdk', 'claude-sdk'], ['codex', 'codex-app-server']]) {
    registry.createAgent(role(id, { model: 'fixture-session', execution: { kind: 'external', driver, sessionPolicy: 'run' } }));
    registry.createAgent(role(id + '-write', { model: 'fixture-write', permissionMode: driver === 'claude-sdk' ? 'auto' : 'confirm', execution: { kind: 'external', driver, ...(driver === 'claude-sdk' ? { nativeTools: ['Write'] } : {}) } }));
    registry.createAgent(role(id + '-review', { model: 'fixture-review', capabilities: ['review'], permissionMode: driver === 'claude-sdk' ? 'auto' : 'readonly',
      execution: { kind: 'external', driver, sessionPolicy: 'run', ...(driver === 'claude-sdk' ? { nativeTools: ['Write'] } : {}) } }));
    registry.createAgent(role(id + '-artifact', { model: 'fixture-bridge', permissionMode: 'confirm', tools: ['fs.write'], execution: { kind: 'external', driver, platformTools: ['fs.write'] } }));
  }
  registry.createAgent(role('revision-review', { model: 'fixture-review-revision', capabilities: ['review'], execution: { kind: 'external', driver: 'codex-app-server' } }));
  registry.createAgent(role('cli', { model: 'default', execution: { kind: 'external', driver: 'claude-cli' } }));
  registry.createAgent(role('wait', { model: 'fixture-wait', execution: { kind: 'external', driver: 'claude-sdk' } }));
  for (const id of ['api', 'sdk', 'codex']) await execute(await seed([id]));
  checks.push('API / Claude SDK / Codex app-server 单步共用 Coordination Runtime');
  const httpPreview = await app.inject({ method: 'POST', url: '/api/coordination/preview', payload: { goal: 'O2 HTTP fixture', agentIds: ['sdk'], requestedProtocol: 'single_agent' } });
  assert.equal(httpPreview.statusCode, 201); const httpDraft = httpPreview.json();
  const httpCreate = await app.inject({ method: 'POST', url: '/api/conversations', payload: { goal: 'O2 HTTP fixture', agentIds: ['sdk'], mode: httpDraft.plan.runtimeMode, coordinationDraftId: httpDraft.draft.id } });
  assert.equal(httpCreate.statusCode, 201); const httpRun = httpCreate.json().run;
  await waitFor(() => ['completed', 'failed'].includes(trace.getRun(httpRun.id).status), 'HTTP dispatcher native plan');
  assert.equal(trace.getRun(httpRun.id).status, 'completed'); assert.equal(executions.listExecutions(httpRun.id)[0].executionBinding.origin, 'coordination_step_attempt');
  checks.push('旧 HTTP 预览/建房入口经共同提交服务和 dispatcher 执行 SDK Coordination');
  for (const [worker, reviewer] of [['api', 'sdk-review'], ['sdk-write', 'api-review'], ['sdk-write', 'codex-review'], ['codex-write', 'sdk-review']]) {
    const value = await seed([worker, reviewer], 'review_revision', { workspace }); await execute(value);
    const bindings = db.all('SELECT record FROM execution_bindings WHERE run_id=?', value.run.id).map(row => JSON.parse(row.record));
    assert.ok(bindings.find(binding => binding.stepId === 'review-implement').workspaceSnapshot);
    const review = executions.listExecutions(value.run.id).find(item => item.agentId === reviewer);
    if (review) { assert.equal(review.permissionMode, 'readonly'); assert.ok(review.cwd.includes('/snapshots/')); assert.equal(review.executionBinding.reviewTargets.length, 1); }
    assert.notEqual(getIsolatedWorkspace(value.run.id).cwd, repository);
  }
  checks.push('API / SDK / app-server 混合实现与独立评审，固定快照和只读权限');
  const revision = await seed(['sdk-write', 'revision-review'], 'review_revision', { workspace }); await execute(revision);
  assert.equal(store.listCoordinationStepAttempts(revision.plan.id).filter(attempt => attempt.stepId === 'review-independent').length, 2);
  checks.push('原生 Reviewer FAIL → 返工 → 新快照 → PASS');
  for (const protocol of ['sequential_pipeline', 'parallel_fanout', 'supervisor_aggregation']) await execute(await seed(['sdk', 'codex', 'manager'], protocol));
  await execute(await seed(['sdk-artifact', 'codex-artifact', 'sdk-review'], 'debate', { workspace, goal: '辩论，进行1轮，给出裁决' }));
  assert.ok((await logs()).some(item => item.kind === 'bridge'));
  checks.push('六种已验证 execute 协议：顺序、并行、汇总、评审和辩论产物 MCP');
  const sessionSteps = await seed(['sdk', 'codex'], 'parallel_fanout', { goal: '分别独立分析，由 @sdk 汇总结果' }); await execute(sessionSteps);
  const sdkSessions = executions.listExecutions(sessionSteps.run.id).filter(item => item.agentId === 'sdk');
  assert.equal(sdkSessions.length, 2); assert.ok(sdkSessions.every(item => item.sessionMode === 'cold'));
  assert.notEqual(sdkSessions[0].sessionBindingId, sdkSessions[1].sessionBindingId);
  checks.push('同一原生成员的不同步骤隔离会话，避免分支上下文污染汇总');
  const cli = await previewCoordination({ goal: 'read', agentIds: ['cli'], requestedProtocol: 'single_agent', deterministicOnly: true });
  assert.ok(cli.draft.validationErrors.includes('READONLY_CLI_COORDINATION_UNSUPPORTED'));
  const complex = await previewCoordination({ goal: 'plan', agentIds: ['sdk', 'manager'], requestedProtocol: 'supervisor_dag', deterministicOnly: true });
  assert.ok(complex.draft.validationErrors.includes('EXTERNAL_PROTOCOL_NOT_VERIFIED'));
  assert.throws(() => registry.createAgent(role('bad-manager', { model: 'default', capabilities: ['coordinate'], execution: { kind: 'external', driver: 'claude-sdk' } })));
  checks.push('只读 CLI、外部主管、未验证复杂协议仍拒绝');
  const fenced = claim(await seed(['sdk'])); assert.equal(authority.bindingAuthorized(fenced.binding), true);
  for (const patch of [{ generation: fenced.binding.generation + 1 }, { contractRevision: 999 }, { planRevision: 999 }, { leaseExpiresAt: '2000-01-01T00:00:00.000Z' }, { origin: 'unknown' }]) assert.equal(authority.bindingAuthorized({ ...fenced.binding, ...patch }), false);
  db.run('UPDATE runtime_custody SET generation=generation+1 WHERE subject_id=?', fenced.binding.subjectId);
  assert.equal(authority.bindingAuthorized(fenced.binding), false); db.run('UPDATE runtime_custody SET generation=generation-1 WHERE subject_id=?', fenced.binding.subjectId);
  db.run('UPDATE coordination_plans SET revision=revision+1 WHERE id=?', fenced.plan.id);
  assert.equal(authority.bindingAuthorized(fenced.binding), false); db.run('UPDATE coordination_plans SET revision=revision-1 WHERE id=?', fenced.plan.id);
  db.run("UPDATE coordination_step_attempts SET started_at='2000-01-01T00:00:00.000Z' WHERE id=?", fenced.binding.attemptId);
  assert.equal(authority.bindingAuthorized(fenced.binding), false); db.run('UPDATE coordination_step_attempts SET started_at=? WHERE id=?', fenced.binding.startedAt, fenced.binding.attemptId);
  await assert.rejects(() => runAgentTurn(options(fenced, { executionBinding: { ...fenced.binding, generation: 999 } })), /绑定已失效/);
  const { createTask } = await import('../apps/server/src/messaging/tasks.ts');
  const { createAttempt } = await import('../apps/server/src/tasks/attempts.ts');
  const task = createTask({ runId: fenced.run.id, title: 'O2 lease fixture', createdBy: 'fixture' });
  const taskAttempt = createAttempt({ taskId: task.id, runId: fenced.run.id, agentId: 'sdk', kind: 'work', attemptNo: 1, inputContext: 'fixture', leaseMs: 10000 });
  const taskBinding = authority.captureExecutionBinding(fenced.run.id, 'sdk', taskAttempt.id);
  assert.equal(taskBinding.origin, 'task_attempt'); assert.equal(authority.bindingAuthorized(taskBinding), true);
  db.run("UPDATE task_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?", taskAttempt.id);
  assert.equal(authority.bindingAuthorized(taskBinding), false);
  const fakeExecution = executions.createExecution({ runId: fenced.run.id, agentId: 'sdk', scopeId: 'callback', driver: 'claude-sdk', agentVersion: 1, cwd: root });
  Object.assign(fakeExecution, { attemptId: fenced.binding.attemptId, executionBinding: fenced.binding }); executions.updateExecution(fakeExecution.id, fakeExecution);
  const bridge = await createExecutionBridge(options(fenced), fakeExecution, new AbortController().signal, false);
  db.run('UPDATE runtime_custody SET generation=generation+1 WHERE subject_id=?', fenced.binding.subjectId);
  const callback = await fetch(bridge.launch.env.AGENT_GAND_BRIDGE_URL + 'tools', { headers: { authorization: 'Bearer ' + bridge.launch.env.AGENT_GAND_BRIDGE_TOKEN } }); assert.equal(callback.status, 403);
  await bridge.close(); executions.updateExecution(fakeExecution.id, { status: 'cancelled' }); trace.finishRun(fenced.run.id, 'cancelled');
  checks.push('generation / contract / lease / revision / 未知来源失效后不能调用模型或 MCP');
  const lateReview = claim(await seed(['api', 'sdk-review'], 'review_revision'));
  const delivered = await runAgentTurn(options(lateReview));
  assert.equal(store.completeCoordinationStep(lateReview.plan, lateReview.step.id, lateReview.binding.attemptId, delivered.content, { version: 2, type: 'complete', summary: delivered.content }).accepted, true);
  store.prepareCoordinationReadySteps(lateReview.plan);
  const reviewStep = lateReview.plan.steps.find(step => step.type === 'review');
  const reviewClaim = store.claimCoordinationStep(lateReview.plan, reviewStep, 'review input');
  assert.equal(authority.bindingAuthorized(reviewClaim.executionBinding), true);
  db.run('UPDATE runtime_custody SET generation=generation+1 WHERE subject_id=?', lateReview.binding.subjectId);
  assert.equal(authority.bindingAuthorized(reviewClaim.executionBinding), false);
  await assert.rejects(() => runAgentTurn(options({ ...lateReview, step: reviewStep, claimed: reviewClaim, binding: reviewClaim.executionBinding })), /绑定已失效/);
  trace.finishRun(lateReview.run.id, 'cancelled'); checks.push('评审目标换代使当前 Reviewer 失权，旧 PASS 不能用于新实现');
  const paused = await seed(['codex-write', 'sdk'], 'sequential_pipeline', { workspace });
  let pauseDone = false; const pausePromise = runtime.runCoordinationPlan(paused.run, paused.run.goal).finally(() => { pauseDone = true; }); void pausePromise.catch(() => {});
  const card = await waitFor(() => db.get("SELECT id FROM approvals WHERE run_id=? AND status='pending'", paused.run.id), 'native approval');
  assert.ok(holds.listDurableHolds(paused.run.id).some(hold => hold.condition.approvalId === card.id));
  runtime.requestCoordinationPause(paused.run.id); await approvePending(paused.run.id);
  await waitFor(() => pauseDone, 'safe boundary pause'); await pausePromise;
  assert.equal(store.getRunCoordinationPlan(paused.run.id).status, 'paused'); assert.equal(executions.listExecutions(paused.run.id).length, 1);
  await runtime.resumeCoordinationRun(paused.run.id); assert.equal(trace.getRun(paused.run.id).status, 'completed'); assert.equal(executions.listExecutions(paused.run.id).length, 2);
  checks.push('原生审批绑定 Durable Hold；安全步骤边界暂停/恢复不重放已完成写入');
  const snapshotReview = await seed(['codex-write', 'sdk-review'], 'review_revision', { workspace });
  let snapshotDone = false; const snapshotPromise = runtime.runCoordinationPlan(snapshotReview.run, snapshotReview.run.goal).finally(() => { snapshotDone = true; }); void snapshotPromise.catch(() => {});
  await waitFor(() => db.get("SELECT id FROM approvals WHERE run_id=? AND status='pending'", snapshotReview.run.id), 'snapshot implementation approval');
  runtime.requestCoordinationPause(snapshotReview.run.id); await approvePending(snapshotReview.run.id);
  await waitFor(() => snapshotDone, 'snapshot pause'); await snapshotPromise;
  const snapshotWriter = executions.listExecutions(snapshotReview.run.id)[0];
  await writeFile(path.join(snapshotWriter.cwd, 'work.txt'), 'later mutable change');
  await runtime.resumeCoordinationRun(snapshotReview.run.id);
  const snapshotReader = executions.listExecutions(snapshotReview.run.id).at(-1);
  assert.equal(snapshotReader.cwd, snapshotWriter.snapshot.path); assert.equal(JSON.parse(snapshotReader.content).summary, 'fixture write');
  checks.push('暂停后可变目录发生修改，恢复评审仍读取实现时的固定快照');
  const revoked = claim(await seed(['codex-write'], 'single_agent', { workspace }));
  const pendingTurn = runAgentTurn(options(revoked)); void pendingTurn.catch(() => {});
  const revokedCard = await waitFor(() => db.get("SELECT id FROM approvals WHERE run_id=? AND status='pending'", revoked.run.id), 'revoked native approval');
  db.run('UPDATE runtime_custody SET generation=generation+1 WHERE subject_id=?', revoked.binding.subjectId);
  assert.throws(() => approvals.decide(revokedCard.id, { decision: 'approve', by: 'fixture' }), /失效/);
  await assert.rejects(() => pendingTurn); assert.equal(executions.listExecutions(revoked.run.id)[0].status, 'cancelled');
  await assert.rejects(() => readFile(path.join(getIsolatedWorkspace(revoked.run.id).cwd, 'work.txt')));
  trace.finishRun(revoked.run.id, 'cancelled'); checks.push('迟到批准不能授权旧代际写入，执行被收敛');
  const restarting = claim(await seed(['sdk']));
  const stale = executions.createExecution({ runId: restarting.run.id, agentId: 'sdk', scopeId: restarting.claimed.attempt.idempotencyKey, driver: 'claude-sdk', agentVersion: 1, cwd: root });
  executions.updateExecution(stale.id, { attemptId: restarting.binding.attemptId, executionBinding: restarting.binding });
  const invocationCount = (await logs()).filter(item => item.kind === 'turn').length;
  await recoverExternalExecutions(); const resumable = store.recoverInterruptedCoordinationSteps();
  assert.ok(!resumable.includes(restarting.run.id)); assert.equal(store.getRunCoordinationPlan(restarting.run.id).status, 'paused'); assert.equal(authority.bindingAuthorized(restarting.binding), false);
  const output = execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', '--input-type=module', '-e',
    "const db=await import('./apps/server/src/db/database.ts');const a=await import('./apps/server/src/execution/authority.ts');const b=JSON.parse(db.get('SELECT record FROM execution_bindings WHERE id=?',process.argv[1]).record);console.log(a.bindingAuthorized(b));db.closeDatabase();", restarting.binding.id], { env: process.env, encoding: 'utf8' });
  assert.equal(output.trim(), 'false');
  await assert.rejects(() => runtime.resumeCoordinationRun(restarting.run.id), /检查实际变更后创建新运行/);
  const blockedResume = await app.inject({ method: 'POST', url: `/api/runs/${restarting.run.id}/coordination/resume` });
  assert.equal(blockedResume.statusCode, 409); assert.match(blockedResume.json().error, /检查实际变更后创建新运行/);
  assert.equal(store.getRunCoordinationPlan(restarting.run.id).status, 'paused');
  await assert.rejects(() => runAgentTurn(options(restarting)));
  assert.equal((await logs()).filter(item => item.kind === 'turn').length, invocationCount);
  trace.finishRun(restarting.run.id, 'cancelled'); checks.push('服务重启持久化绑定可读，旧执行失权，未知原生执行暂停且不自动重放');
  const deadlineRun = await seed(['wait']);
  const deadlinePlan = store.getRunCoordinationPlan(deadlineRun.run.id);
  deadlinePlan.steps[0].timeoutMs = 300;
  db.run('UPDATE coordination_plans SET payload=? WHERE id=?', JSON.stringify(deadlinePlan), deadlinePlan.id);
  await assert.rejects(() => runtime.runCoordinationPlan(deadlineRun.run, deadlineRun.run.goal));
  assert.equal(trace.getRun(deadlineRun.run.id).status, 'failed');
  assert.ok(store.listCoordinationStepAttempts(deadlinePlan.id).every(attempt => attempt.status === 'failed'));
  assert.equal(db.get("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id IN (SELECT id FROM external_agent_executions WHERE run_id=?) AND status='active'", deadlineRun.run.id).n, 0);
  checks.push('步骤租约超时撤销执行，同一 scheduler 可失败收尾，不遗留 running 或原生进程');
  assert.equal(providerRequests, 0); console.log(JSON.stringify({ status: 'passed', checks, providerRequests }, null, 2));
} catch (error) {
  console.error(executions.listExecutions(db.get('SELECT id FROM runs ORDER BY rowid DESC LIMIT 1')?.id ?? '').map(item => ({ status: item.status, error: item.error, binding: item.executionBinding?.origin })));
  throw error;
} finally { globalThis.fetch = originalFetch; await shutdownExternalAgents(); await app.close(); db.closeDatabase(); await rm(root, { recursive: true, force: true }); }
