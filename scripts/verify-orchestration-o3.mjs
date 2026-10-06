import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-o3-'));
Object.assign(process.env, { NODE_ENV: 'test', AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'),
  DB_PATH: path.join(root, 'db.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  COORDINATION_PLANNER_MODEL: '', COORDINATION_RUNTIME_KERNEL: 'execute', EXTERNAL_AGENT_TIMEOUT_MS: '20000',
  LLM_OPENAI_API_KEY: '', LLM_ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY: '', O3_LOG: path.join(root, 'calls.jsonl') });
await writeFile(process.env.O3_LOG, '');
globalThis.fetch = async () => { throw new Error('O3 must not call real providers'); };
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const tasks = await import('../apps/server/src/messaging/tasks.ts');
const attempts = await import('../apps/server/src/tasks/attempts.ts');
const adapter = await import('../apps/server/src/runtime/taskAdapter.ts');
const admission = await import('../apps/server/src/execution/memberAdmission.ts');
const authority = await import('../apps/server/src/execution/authority.ts');
const recovery = await import('../apps/server/src/runs/recovery.ts');
const holds = await import('../apps/server/src/runtime/holds.ts');
const actions = await import('../apps/server/src/orchestration/actions.ts');
const { pipelineOrchestrator, resumePipelineRun } = await import('../apps/server/src/orchestration/pipeline.ts');
const { resumeSupervisorRun } = await import('../apps/server/src/orchestration/supervisor.ts');
const { enqueueConversationRun } = await import('../apps/server/src/conversations/dispatcher.ts');
const { submitLegacyOrchestration } = await import('../apps/server/src/orchestration/service.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const app = Fastify(); await registerRoutes(app);
const calls = []; const gates = new Map(); const checks = []; const children = [];
const waitFor = async (read, label, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) {
  const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20));
} throw new Error('Timeout: ' + label); };
const request = async (url, payload) => { const result = await app.inject({ method: payload ? 'POST' : 'GET', url, ...(payload ? { payload } : {}) }); return { status: result.statusCode, data: result.json() }; };
const role = (id, more = {}) => ({ id, name: id, description: 'O3 fixture', systemPrompt: 'Provide a complete deliverable',
  capabilities: ['execute'], model: 'mock:' + id, permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#4477aa', avatar: '🤖', ...more });
for (const id of ['aa','bb','cc']) await registry.createAgent(role(id));
await registry.createAgent(role('planner', { capabilities: ['coordinate','execute'] }));
await registry.createAgent(role('reviewer', { capabilities: ['review'] }));
mockProvider.chat = async req => {
  const content = req.messages.filter(m => m.role === 'user').map(m => m.content).join('\n');
  const label = [...content.matchAll(/O3:([\w-]+)/g)].at(-1)?.[1] ?? 'control';
  const entry = { agent: req.model, label, started: Date.now(), finished: null }; calls.push(entry);
  if (gates.has(label)) await gates.get(label).promise;
  else await new Promise(resolve => setTimeout(resolve, 80));
  entry.finished = Date.now();
  let output = label === 'empty' ? '' : label === 'ack' ? '收到。' : `完整交付结果 ${label}`;
  if (req.model === 'mock:reviewer') output = JSON.stringify({ verdict: 'PASS', summary: '依据当前实现审查通过', issues: [] });
  return { content: output, toolCalls: [], stopReason: 'end_turn', usage: { tokensIn: 1, tokensOut: 1, costUsd: 0 } };
};
function gate(label) { let release; const promise = new Promise(resolve => { release = resolve; }); gates.set(label, { promise, release }); return release; }
function seed(label, ids = ['aa'], extra = {}) { return submitLegacyOrchestration('room_create', { goal: 'O3:' + label, mode: 'pipeline', agentIds: ids, ...extra }); }
async function execute(value) { enqueueConversationRun(value.run.id); return waitFor(() => {
  const current = trace.getRun(value.run.id); return ['completed','failed','cancelled','waiting_for_user'].includes(current.status) ? current : null;
}, value.run.goal); }
function fork(item, more = {}) {
  const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'scripts/fixtures/orchestration-o3-worker.mjs'], {
    env: { ...process.env, O3_RUN_ID: item.id, ...more }, stdio: ['ignore','pipe','pipe'] });
  children.push(child); let output = ''; child.stderr.on('data', chunk => { output += chunk; });
  child.finished = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, output })));
  return child;
}
async function logs() { return (await readFile(process.env.O3_LOG, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
try {
  const simple = seed('simple'); assert.equal((await execute(simple)).status, 'completed');
  assert.equal(db.get('SELECT json_extract(payload,\'$.executionPolicy.profile\') profile FROM runtime_contracts WHERE run_id=?', simple.run.id).profile, 'execute');
  const binding = JSON.parse(db.get('SELECT record FROM execution_bindings WHERE run_id=?', simple.run.id).record);
  assert.ok(binding.responsibility); assert.equal(binding.origin, 'task_attempt'); assert.equal(authority.bindingAuthorized(binding), false);
  assert.equal(adapter.finishAdapterRun(simple.run.id, 'completed').committed, false);
  assert.equal(trace.finishRun(simple.run.id, 'failed'), false); trace.setRunStatus(simple.run.id, 'running');
  assert.equal(trace.getRun(simple.run.id).status, 'completed');
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_run_terminals WHERE run_id=?', simple.run.id).n, 1);
  const completedAttempt = tasks.listTasks(simple.run.id).flatMap(task => attempts.listAttempts(task.id))[0];
  assert.equal(attempts.completeAttempt(completedAttempt.id, completedAttempt.output).id, completedAttempt.id);
  assert.throws(() => attempts.completeAttempt(completedAttempt.id, '改写旧结果'), /不能覆盖/);
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='complete'", simple.run.id).n, 1);
  checks.push('旧直接 Run / 流水线采用 execute 契约、TaskAttempt 责任绑定与一次终态 CAS，终态不可复活');

  for (const label of ['empty','ack']) { const value = seed(label); assert.equal((await execute(value)).status, 'failed'); }
  const fast = submitLegacyOrchestration('conversation_message', { body: 'O3:ack', recipientIds: ['aa'], clientMessageId: 'fast-ack' }, simple.conversation.id);
  assert.equal((await execute(fast)).status, 'failed');
  const multi = seed('multi', ['aa','bb']); assert.equal((await execute(multi)).status, 'completed');
  const before = mockProvider.chat;
  mockProvider.chat = async req => req.model === 'mock:bb' ? { content: 'ACK', toolCalls: [], stopReason: 'end_turn', usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 } } : before(req);
  const mixed = submitLegacyOrchestration('conversation_message', { body: 'O3:partial', recipientIds: ['aa','bb'], clientMessageId: 'o3-partial' }, multi.conversation.id);
  assert.equal((await execute(mixed)).status, 'failed');
  mockProvider.chat = before;
  checks.push('空输出和 ACK 不能完成流水线或定向 fast path');

  const releaseA = gate('fifo-a'); const first = seed('fifo-a'); const pFirst = execute(first);
  await waitFor(() => calls.some(c => c.label === 'fifo-a'), 'A started');
  const second = submitLegacyOrchestration('conversation_message', { body: 'O3:fifo-b', recipientIds: ['aa'], clientMessageId: 'o3-fifo-b' }, first.conversation.id);
  const pSecond = execute(second); await waitFor(() => admission.memberQueue(second.run.id).some(t => t.status === 'waiting'), 'B queued');
  const third = seed('fifo-c'); const pThird = execute(third);
  await waitFor(() => admission.memberQueue(third.run.id).some(t => t.status === 'waiting'), 'C queued');
  const independent = seed('independent', ['bb']); assert.equal((await execute(independent)).status, 'completed');
  assert.equal(calls.some(c => c.label === 'fifo-b' || c.label === 'fifo-c'), false);
  assert.ok(calls.find(c => c.label === 'independent').finished && !calls.find(c => c.label === 'fifo-a').finished);
  releaseA(); assert.equal((await pFirst).status, 'completed'); assert.equal((await pSecond).status, 'completed'); assert.equal((await pThird).status, 'completed');
  const fifo = calls.filter(c => c.label.startsWith('fifo-')); assert.deepEqual(fifo.map(c => c.label), ['fifo-a','fifo-b','fifo-c']);
  assert.ok(fifo[1].started >= fifo[0].finished && fifo[2].started >= fifo[1].finished);
  checks.push('同房间 / 跨房间同成员 FIFO，独立只读成员不被聊天室串行锁阻塞');

  const releaseCollab = gate('collab-held');
  const collabA = seed('collab-held', ['aa'], { mode: 'collaboration' }); const pCollabA = execute(collabA);
  await waitFor(() => calls.some(c => c.label === 'collab-held'), 'collaboration held');
  const pipelineB = seed('mixed-pipeline'); const pPipelineB = execute(pipelineB);
  await waitFor(() => admission.memberQueue(pipelineB.run.id).some(t => t.status === 'waiting'), 'mixed pipeline queued');
  const collabC = seed('mixed-collaboration', ['aa'], { mode: 'collaboration' }); const pCollabC = execute(collabC);
  await waitFor(() => admission.memberQueue(collabC.run.id).some(t => t.status === 'waiting'), 'mixed collaboration queued');
  releaseCollab(); assert.equal((await pCollabA).status, 'completed'); assert.equal((await pPipelineB).status, 'completed'); assert.equal((await pCollabC).status, 'completed');
  assert.deepEqual(calls.filter(c => ['collab-held','mixed-pipeline','mixed-collaboration'].includes(c.label)).map(c => c.label), ['collab-held','mixed-pipeline','mixed-collaboration']);
  const releaseCollabPause = gate('collab-pause'); const collabPaused = seed('collab-pause', ['aa'], { mode: 'collaboration' }); const pCollabPause = execute(collabPaused);
  await waitFor(() => calls.some(c => c.label === 'collab-pause'), 'collaboration pause');
  await request(`/api/runs/${collabPaused.run.id}/actions`, { action: 'pause' }); releaseCollabPause();
  assert.equal((await pCollabPause).status, 'waiting_for_user');
  await request(`/api/runs/${collabPaused.run.id}/actions`, { action: 'resume' });
  await waitFor(() => trace.getRun(collabPaused.run.id).status === 'completed', 'collaboration resumed');
  assert.equal(calls.filter(c => c.label === 'collab-pause').length, 1);
  checks.push('Collaboration 与兼容流水线共用成员 FIFO；资源释放唤醒跨房间队列，暂停恢复复用已验收输出');

  const releaseCancel = gate('cancel-a'); const cancelA = seed('cancel-a'); const pCancelA = execute(cancelA);
  await waitFor(() => calls.some(c => c.label === 'cancel-a'), 'cancel A started');
  const cancelB = seed('cancel-b'); const pCancelB = execute(cancelB);
  await waitFor(() => admission.memberQueue(cancelB.run.id).some(t => t.status === 'waiting'), 'cancel B queued');
  assert.equal((await request(`/api/runs/${cancelB.run.id}/actions`, { action: 'cancel' })).data.status, 'cancelled');
  assert.equal(trace.getRun(cancelA.run.id).status, 'running'); releaseCancel(); await pCancelA; await pCancelB;
  assert.equal(calls.some(c => c.label === 'cancel-b'), false);
  assert.equal((await request(`/api/runs/${cancelB.run.id}/actions`, { action: 'resume' })).status, 409);
  checks.push('取消排队任务 B 不撤销 A；取消后不调用模型，不允许恢复终态');

  const releasePause = gate('pause'); const paused = seed('pause', ['aa','bb']); const pausedPromise = execute(paused);
  await waitFor(() => calls.some(c => c.label === 'pause' && c.agent === 'mock:aa'), 'pause first step');
  await request(`/api/runs/${paused.run.id}/actions`, { action: 'pause' }); releasePause();
  assert.equal((await pausedPromise).status, 'waiting_for_user'); assert.equal(calls.filter(c => c.label === 'pause').length, 1);
  assert.equal((await request(`/api/runs/${paused.run.id}/actions`, { action: 'resume' })).status, 200);
  await waitFor(() => trace.getRun(paused.run.id).status === 'completed', 'pause resume');
  assert.equal(calls.filter(c => c.label === 'pause' && c.agent === 'mock:aa').length, 1);
  checks.push('流水线安全边界暂停 / 恢复，只执行未完成步骤');

  const supervisor = seed('supervisor', ['planner','aa','reviewer'], { mode: 'supervisor', supervisorId: 'planner' });
  assert.equal((await execute(supervisor)).status, 'completed');
  assert.ok(db.get("SELECT COUNT(*) n FROM runtime_task_subjects m JOIN tasks t ON t.id=m.task_id WHERE t.run_id=? AND m.kind='review'", supervisor.run.id).n >= 3);
  assert.equal(db.get("SELECT COUNT(*) n FROM execution_bindings WHERE run_id=? AND json_extract(record,'$.responsibility.subjectId') IS NULL", supervisor.run.id).n, 0);
  let rejectImplementation = true; const steady = mockProvider.chat;
  mockProvider.chat = async req => { const prompt = req.messages.map(m => m.content).join('\n');
    if (rejectImplementation && req.model === 'mock:aa' && prompt.includes('O3:retry') && prompt.includes('任务：完成实现')) throw new Error('fixture implementation failure');
    return steady(req);
  };
  const failedSupervisor = seed('retry', ['planner','aa','reviewer'], { mode: 'supervisor', supervisorId: 'planner' });
  assert.equal((await execute(failedSupervisor)).status, 'failed');
  const branch = tasks.listTasks(failedSupervisor.run.id).find(task => task.title.startsWith('完成实现'));
  assert.equal(branch.status, 'failed'); rejectImplementation = false;
  const retried = await request(`/api/runs/${failedSupervisor.run.id}/actions`, { action: 'retry', taskId: branch.id });
  assert.equal(retried.status, 200, JSON.stringify(retried.data)); assert.notEqual(retried.data.runId, failedSupervisor.run.id);
  const duplicateRetry = await request(`/api/runs/${failedSupervisor.run.id}/actions`, { action: 'retry', taskId: branch.id });
  assert.equal(duplicateRetry.data.id, retried.data.id);
  await waitFor(() => trace.getRun(retried.data.runId).status === 'completed', 'retry supervisor');
  assert.equal(trace.getRun(failedSupervisor.run.id).status, 'failed');
  assert.equal(db.get('SELECT COUNT(*) n FROM task_attempts WHERE task_id=?', branch.id).n, 3);
  mockProvider.chat = steady;
  checks.push('主管工作 / 审查 / 汇总共用执行契约；失败分支重试新建 Run、保留确认分支、原终态不变');

  const named = 'o3-' + path.basename(root).slice(-12); const releaseWrite = gate('writer');
  await registry.createAgent(role('writer', { permissionMode: 'auto', tools: ['fs.write'] }));
  const writer = seed('writer', ['writer'], { workspace: named }); const pWrite = execute(writer);
  await waitFor(() => calls.some(c => c.label === 'writer'), 'writer held lock');
  const reader = seed('reader', ['cc'], { workspace: named }); const pRead = execute(reader);
  await waitFor(() => admission.memberQueue(reader.run.id).some(t => t.status === 'active'), 'reader waiting workspace');
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(calls.some(c => c.label === 'reader'), false);
  releaseWrite(); await pWrite; await pRead;
  assert.ok(calls.find(c => c.label === 'reader').started >= calls.find(c => c.label === 'writer').finished);
  checks.push('同名工作区跨 Run 共享读 / 独占写租约，不能因 Run ID 不同绕过');

  const crossA = seed('cross-a'); const crossB = seed('cross-b'); const crossC = seed('cross-c');
  const ca = fork(crossA.run, { O3_DELAY: '1200' }); await waitFor(async () => (await logs()).some(l => l.runId === crossA.run.id && l.event === 'start'), 'process A');
  const duplicateOwner = fork(crossA.run); assert.equal((await duplicateOwner.finished).code, 0);
  const cb = fork(crossB.run); await waitFor(() => admission.memberQueue(crossB.run.id).some(t => t.status === 'waiting'), 'process B queued');
  const cc = fork(crossC.run); await Promise.all([ca.finished, cb.finished, cc.finished]).then(results => results.forEach(result => assert.equal(result.code, 0, result.output)));
  const cross = (await logs()).filter(l => [crossA.run.id,crossB.run.id,crossC.run.id].includes(l.runId));
  assert.deepEqual(cross.filter(l => l.event === 'start').map(l => l.runId), [crossA.run.id,crossB.run.id,crossC.run.id]);
  assert.ok(cross.find(l => l.runId === crossB.run.id && l.event === 'start').time >= cross.find(l => l.runId === crossA.run.id && l.event === 'end').time);
  checks.push('多个 worker 共用持久成员锁，跨进程 FIFO 不并发调用同一成员');

  const unknown = seed('unknown'); const queued = seed('queued-recovery'); const crash = fork(unknown.run, { O3_DELAY: '60000' });
  await waitFor(async () => (await logs()).some(l => l.runId === unknown.run.id), 'crash invocation started');
  const waiting = fork(queued.run); await waitFor(() => admission.memberQueue(queued.run.id).some(t => t.status === 'waiting'), 'crash queued');
  crash.kill('SIGKILL'); waiting.kill('SIGKILL'); await Promise.all([crash.finished, waiting.finished]);
  admission.recoverMemberAdmissions(); attempts.interruptRunningAttempts(); adapter.reopenInterruptedTaskResponsibilities(); tasks.recoverInterruptedTasks();
  assert.equal(trace.getRun(unknown.run.id).status, 'waiting_for_user');
  assert.equal((await request(`/api/runs/${unknown.run.id}/actions`, { action: 'resume' })).status, 409);
  const uncertainSubject = db.get(`SELECT m.subject_id FROM runtime_task_subjects m JOIN tasks t ON t.id=m.task_id WHERE t.run_id=?`, unknown.run.id);
  const recoveryHold = holds.createDurableHold({ runId: unknown.run.id, subjectId: uncertainSubject.subject_id,
    holderAgentId: 'aa', condition: { kind: 'timer', wakeAt: new Date(Date.now() - 1000).toISOString() },
    recoveryPolicy: { kind: 'wake_run' }, idempotencyKey: 'o3-unknown-timer' });
  assert.equal(recovery.recoverDurableHolds(unknown.run.id), 0, '定时唤醒不能绕过未知调用围栏');
  assert.equal(db.get('SELECT status FROM runtime_holds WHERE id=?', recoveryHold.id).status, 'open');
  assert.equal(trace.getRun(unknown.run.id).status, 'waiting_for_user');
  await resumePipelineRun(queued.run.id); assert.equal(trace.getRun(queued.run.id).status, 'completed');
  assert.equal((await logs()).filter(l => l.runId === unknown.run.id && l.event === 'start').length, 1);
  assert.equal(calls.filter(c => c.label === 'queued-recovery').length, 1);
  checks.push('领取后未调用的队列可恢复；调用已开始但结果未知则暂停且禁止自动重放');

  await actions.applyRunAction(unknown.run.id, 'cancel');
  const persisted = seed('persisted'); const saved = fork(persisted.run, { O3_MODE: 'turn_only' }); assert.equal((await saved.finished).code, 0);
  assert.equal(trace.getRun(persisted.run.id).status, 'running'); await resumePipelineRun(persisted.run.id);
  assert.equal(trace.getRun(persisted.run.id).status, 'completed');
  assert.equal((await logs()).filter(l => l.runId === persisted.run.id && l.event === 'start').length, 1);
  assert.equal(calls.filter(c => c.label === 'persisted').length, 0);
  checks.push('结果已持久化但编排未提交终态时，从已确认 TaskAttempt 恢复，模型不重复调用');
  const planningCrash = seed('planning-crash', ['planner','aa'], { mode: 'supervisor', supervisorId: 'planner' });
  const planningWorker = fork(planningCrash.run, { O3_MODE: 'planning_only' }); assert.equal((await planningWorker.finished).code, 0);
  assert.equal(tasks.listTasks(planningCrash.run.id).filter(task => !adapter.isAdapterTurnTask(task.id)).length, 0);
  await resumeSupervisorRun(planningCrash.run.id);
  assert.equal(trace.getRun(planningCrash.run.id).status, 'completed');
  assert.equal(tasks.listTasks(planningCrash.run.id).filter(task => !adapter.isAdapterTurnTask(task.id)).length, 1);
  assert.ok(tasks.listTasks(planningCrash.run.id).some(task => task.title === '恢复已确认的规划任务'));
  assert.equal((await logs()).filter(l => l.runId === planningCrash.run.id && l.event === 'start').length, 1);
  const historical = seed('historical'); trace.setRunStatus(historical.run.id, 'running');
  await resumePipelineRun(historical.run.id); assert.equal(trace.getRun(historical.run.id).status, 'waiting_for_user');
  assert.equal(calls.filter(c => c.label === 'historical').length, 0);
  assert.equal((await request(`/api/runs/${historical.run.id}/actions`, { action: 'resume' })).status, 409);
  checks.push('规划已确认但 DAG 未落库时恢复实际任务；历史无有效契约的活跃运行保留等待，不自动重跑');
  console.log(JSON.stringify({ status: 'passed', checks, realProviderRequests: 0 }, null, 2));
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const value of gates.values()) value.release();
  await app.close(); db.closeDatabase(); await rm(root, { recursive: true, force: true });
}
