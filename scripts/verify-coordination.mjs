import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-coordination-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);

// AG-COORD-01：辩论步骤现在声明产物并强制落盘校验，辩手需要可写的 fs 工具（auto 档免审批）
function agent(name, capabilities) {
  return `---\nname: ${name}\ndescription: ${name} coordination fixture\nmodel: mock:${name.toLowerCase()}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: ["fs.read", "fs.write"]\npermissionMode: auto\ncolor: '#6677aa'\n---\n${name} fixture`;
}
await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agent('Planner', ['coordinate', 'execute'])),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agent('Coder', ['execute'])),
  writeFile(path.join(agentsDir, 'reviewer.agent.md'), agent('Reviewer', ['review'])),
]);

const dbPath = path.join(root, 'test.sqlite');
const port = 44000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let child = null;
let childExit = null;
let logs = '';

function startServer(extraEnv = {}) {
  assert.equal(child, null, 'server already running');
  child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const current = child;
  childExit = new Promise((resolve) => current.once('exit', resolve));
  current.stdout.on('data', (chunk) => { logs += chunk; });
  current.stderr.on('data', (chunk) => { logs += chunk; });
}

async function stopServer(signal = 'SIGTERM') {
  if (!child || !childExit) return;
  const currentExit = childExit;
  child.kill(signal);
  await currentExit;
  child = null;
  childExit = null;
}

async function waitForServer() {
  for (let index = 0; index < 100; index += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server 启动超时\n${logs}`);
}

async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}

async function poll(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} 超时：${JSON.stringify(latest)}\n${logs}`);
}

async function preview(body) {
  const result = await api('/api/coordination/preview', 'POST', body);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function startDraft(previewResult, body = {}) {
  const result = await api('/api/conversations', 'POST', {
    goal: previewResult.draft.taskBrief.objective,
    mode: previewResult.draft.runtimeMode,
    agentIds: previewResult.draft.taskBrief.participantIds,
    coordinationDraftId: previewResult.draft.id,
    ...body,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data;
}

async function waitForRun(runId, timeoutMs = 15_000) {
  const detail = await poll(
    async () => {
      const result = await api(`/api/runs/${runId}`);
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data;
    },
    (value) => ['completed', 'failed'].includes(value.run.status),
    `Run ${runId} 完成`,
    timeoutMs,
  );
  assert.equal(detail.run.status, 'completed', JSON.stringify(detail));
  return detail;
}

async function coordination(runId) {
  const result = await api(`/api/runs/${runId}/coordination`);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

function attemptsFor(detail, stepId) {
  return detail.attempts.filter((attempt) => attempt.stepId === stepId);
}

/** run 工作区磁盘目录：命名/room 工作区 → workspaces/<name>；null → runs/<runId> */
function sandboxDirOf(run) {
  return run.workspace ? path.join(repo, 'apps/server/data/sandbox/workspaces', run.workspace) : path.join(repo, 'apps/server/data/sandbox/runs', run.id);
}

/** 外部工作区写入会强制审批：持续批准该 run 的 pending 审批直到终态（C/D 场景共用） */
async function approveUntilDone(runId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await api(`/api/runs/${runId}`);
    if (['completed', 'failed'].includes(latest.data?.run?.status)) return latest;
    const list = (await api('/api/approvals?status=pending')).data ?? [];
    for (const item of list.filter((approval) => approval.runId === runId)) {
      await api(`/api/approvals/${item.id}/decide`, 'POST', { decision: 'approve', by: 'coordination-verifier' });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const runtime = await coordination(runId);
  throw new Error(`approveUntilDone 超时：${JSON.stringify(latest?.data?.run)}\nsteps=${JSON.stringify(runtime.steps.map((s) => [s.stepId, s.status]))}\nattempts=${JSON.stringify(runtime.attempts.map((a) => [a.stepId, a.attemptNo, a.status, a.error?.slice(0, 60)]))}\nevents=${JSON.stringify(runtime.events.slice(-12).map((e) => [e.kind, e.payload?.stepId ?? '']))}\n${logs}`);
}

startServer();
try {
  await waitForServer();

  const protocols = await api('/api/coordination/protocols');
  assert.equal(protocols.status, 200);
  assert.equal(protocols.data.length, 10);
  assert.ok(protocols.data.every((item) => item.version === 1 && item.roleSlots.length > 0 && item.completionCondition));

  const single = await preview({ goal: '总结当前内容', agentIds: ['coder'] });
  assert.deepEqual(single.draft.protocols.map((item) => item.protocol), ['single_agent']);
  assert.equal(single.draft.decision, 'auto_start');
  assert.equal(single.draft.runtimeMode, 'collaboration');
  assert.deepEqual(single.draft.validationErrors, []);
  assert.deepEqual(single.plan.steps.map((step) => step.id), ['single-response', 'complete']);
  assert.equal(single.plan.validationIssues.filter((item) => item.severity === 'error').length, 0);
  assert.ok(single.plan.hardConstraintBindings.some((item) => item.constraint === 'participantIds'));

  const snapshot = await api(`/api/coordination/capability-snapshots/${single.snapshot.id}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.schemaVersion, 1);
  const storedPlan = await api(`/api/coordination/plans/${single.plan.id}`);
  assert.equal(storedPlan.status, 200);
  const revisions = await api(`/api/coordination/plans/${single.plan.id}/revisions`);
  assert.equal(revisions.status, 200);
  assert.equal(revisions.data.length, 1);
  const initialEvents = await api(`/api/coordination/drafts/${single.draft.id}/events`);
  assert.equal(initialEvents.status, 200);
  assert.deepEqual(initialEvents.data.map((item) => item.kind), ['snapshot_created', 'draft_created', 'draft_validated', 'plan_compiled', 'plan_validated']);

  const started = await startDraft(single, { recipientIds: ['coder'] });
  assert.equal(started.plan.id, single.plan.id);
  const runPlan = await api(`/api/runs/${started.run.id}/coordination-plan`);
  assert.equal(runPlan.status, 200);
  assert.equal(runPlan.data.runId, started.run.id);
  await waitForRun(started.run.id);
  const singleRuntime = await coordination(started.run.id);
  assert.equal(singleRuntime.plan.status, 'completed');
  assert.ok(singleRuntime.steps.every((step) => step.status === 'completed'));
  assert.deepEqual(singleRuntime.events.filter((event) => event.kind.startsWith('plan_')).map((event) => event.kind).slice(-2), ['plan_activated', 'plan_completed']);

  const roomsBeforeDuplicate = await api('/api/conversations');
  const duplicateStart = await api('/api/conversations', 'POST', {
    goal: '总结当前内容', mode: 'collaboration', agentIds: ['coder'], recipientIds: ['coder'], coordinationDraftId: single.draft.id,
  });
  assert.equal(duplicateStart.status, 409);
  const roomsAfterDuplicate = await api('/api/conversations');
  assert.equal(roomsAfterDuplicate.data.length, roomsBeforeDuplicate.data.length, 'Plan 激活失败时聊天室与 Run 必须原子回滚');

  const parallel = await preview({ goal: '让两位成员分别独立分析两个方案并汇总', agentIds: ['planner', 'coder'] });
  assert.deepEqual(parallel.draft.protocols.map((item) => item.protocol), ['parallel_fanout', 'supervisor_aggregation']);
  assert.equal(parallel.draft.runtimeMode, 'pipeline');
  assert.deepEqual(parallel.draft.validationErrors, []);
  assert.equal(parallel.plan.steps.filter((step) => step.type === 'fanout').length, 2);
  assert.equal(parallel.plan.steps.filter((step) => step.type === 'aggregate').length, 1);
  const parallelStarted = await startDraft(parallel);
  await waitForRun(parallelStarted.run.id);
  const parallelRuntime = await coordination(parallelStarted.run.id);
  const branches = parallelRuntime.steps.filter((step) => step.stepId.startsWith('parallel-branch-'));
  const aggregate = parallelRuntime.steps.find((step) => step.stepId === 'parallel-aggregate');
  assert.equal(branches.length, 2);
  assert.ok(branches.every((step) => step.status === 'completed'));
  assert.equal(aggregate.status, 'completed');
  assert.ok(branches.every((step) => new Date(aggregate.startedAt) >= new Date(step.completedAt)), '汇总步骤必须等待全部并行分支完成');

  const ordered = await preview({ goal: '先实现再汇总', agentIds: ['coder', 'planner'], requestedProtocol: 'sequential_pipeline' });
  assert.deepEqual(ordered.plan.steps.filter((step) => step.type === 'agent_turn').map((step) => step.agentId), ['coder', 'planner']);

  const review = await preview({
    goal: '实现登录修复，交给 Reviewer 审查，有问题继续修改 __MOCK_REVIEW_FAIL_ONCE__',
    agentIds: ['coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  assert.deepEqual(review.draft.protocols.map((item) => item.protocol), ['review_revision']);
  assert.deepEqual(review.draft.validationErrors, []);
  assert.deepEqual(review.plan.steps.map((step) => step.type), ['agent_turn', 'review', 'completion_gate']);
  assert.notEqual(review.plan.actorBindings.implementer, review.plan.actorBindings.reviewer);
  const reviewStarted = await startDraft(review, { defaultReviewerId: 'reviewer' });
  await waitForRun(reviewStarted.run.id);
  const reviewRuntime = await coordination(reviewStarted.run.id);
  assert.equal(attemptsFor(reviewRuntime, 'review-implement').length, 2, 'Reviewer FAIL 后实现步骤必须返工一次');
  assert.equal(attemptsFor(reviewRuntime, 'review-independent').length, 2, '返工后必须重新独立审查');
  assert.ok(reviewRuntime.steps.every((step) => step.status === 'completed'));

  // [tool:fs.write]：mock 依据步骤 prompt 里的"冻结到 `<path>`"指令写入产物（AG-COORD-01 落盘链路）
  const debateGoal = '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [tool:fs.write]';
  const debate = await preview({
    goal: debateGoal, agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  assert.deepEqual(debate.draft.protocols.map((item) => item.protocol), ['debate']);
  assert.deepEqual(debate.draft.validationErrors, []);
  const debateTurns = debate.plan.steps.filter((step) => step.protocol === 'debate' && step.type === 'agent_turn');
  assert.equal(debateTurns.length, 6);
  const judge = debate.plan.steps.find((step) => step.id === 'debate-judge');
  assert.equal(judge.dependsOn.length, 6);
  assert.notEqual(judge.agentId, debate.plan.actorBindings.pro);
  assert.notEqual(judge.agentId, debate.plan.actorBindings.con);
  assert.ok(debate.plan.steps.at(-1).dependsOn.includes('debate-judge'));
  const debateStarted = await startDraft(debate, { defaultReviewerId: 'reviewer' });
  const debateDetail = await waitForRun(debateStarted.run.id);
  // 过程消息（工具轮中间正文，informational）与结论消息（result/review_result）分开计
  const isFinalAgent = (message) => message.kind === 'agent' && message.meta?.round === undefined; // meta.round = 工具轮过程消息
  const debateMessages = debateDetail.messages.filter(isFinalAgent);
  assert.equal(debateMessages.length, 7, '三轮辩论必须形成六次独立发言和一次裁决');
  assert.deepEqual(debateMessages.map((message) => message.payload.coordinationStepId), [
    'debate-r1-pro', 'debate-r1-con', 'debate-r2-pro', 'debate-r2-con', 'debate-r3-pro', 'debate-r3-con', 'debate-judge',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settledDebate = await api(`/api/runs/${debateStarted.run.id}`);
  assert.equal(settledDebate.data.messages.filter(isFinalAgent).length, 7, '完成后不得出现迟到输出');
  assert.ok(debateMessages.length > 0 && debateDetail.messages.some((message) => message.kind === 'agent' && message.messageType === 'informational' && message.meta?.round !== undefined), '工具轮中间正文应落库为过程消息');
  const observed = await api(`/api/runs/${debateStarted.run.id}/observability`);
  assert.equal(observed.status, 200);
  assert.equal(observed.data.graph.nodes.filter((node) => node.kind === 'coordination_step').length, debate.plan.steps.length);
  assert.equal(observed.data.groups.filter((group) => group.kind === 'coordination_step').length, 7);
  // AG-COORD-01：六篇发言产物必须真实落盘且非 stub（run 工作区 debate/ 下）
  const debateSandbox = sandboxDirOf(debateDetail.run);
  for (const rel of ['debate/r1-pro.md', 'debate/r1-con.md', 'debate/r2-pro.md', 'debate/r2-con.md', 'debate/r3-pro.md', 'debate/r3-con.md']) {
    const content = await readFile(path.join(debateSandbox, rel), 'utf8');
    assert.ok(content.length >= 64, `产物过短或未落盘：${rel}`);
  }

  // ---- Follow-up Router（docs/plans/followup-routing-plan.md）----
  const conversationId = debateStarted.conversation.id;
  const judgeMessage = debateDetail.messages.find((message) => message.kind === 'agent' && message.payload?.coordinationStepId === 'debate-judge');
  assert.ok(judgeMessage, '找不到裁判裁决消息');
  const askUrl = `/api/conversations/${conversationId}/messages`;

  // 显式定向：回复裁判消息 → 仅 reviewer 回应，不重跑编排
  const directed = await api(askUrl, 'POST', { body: '请用一句话总结你的裁决结论', replyTo: judgeMessage.id, clientMessageId: crypto.randomUUID() });
  assert.equal(directed.status, 202, JSON.stringify(directed.data));
  const directedDetail = await waitForRun(directed.data.run.id);
  const directedAnswers = directedDetail.messages.filter(isFinalAgent);
  assert.equal(directedAnswers.length, 1, `定向追问应只有一个 Agent 回应，实际 ${directedAnswers.length}`);
  assert.equal(directedAnswers[0].from, 'reviewer', `回复裁判应由 reviewer 回应，实际 ${directedAnswers[0]?.from}`);
  const directedRuntime = await api(`/api/runs/${directed.data.run.id}/coordination-plan`);
  assert.equal(directedRuntime.status, 404, '定向快速路径不得创建 Coordination Plan');

  // 无定向简单追问 → 最近成功回复者（裁判 reviewer），单 turn 完成
  const simple = await api(askUrl, 'POST', { body: '介绍一下这个裁决的背景知识', clientMessageId: crypto.randomUUID() });
  assert.equal(simple.status, 202, JSON.stringify(simple.data));
  const simpleDetail = await waitForRun(simple.data.run.id);
  const simpleAnswers = simpleDetail.messages.filter(isFinalAgent);
  assert.equal(simpleAnswers.length, 1, `简单追问应走最近回复者快速路径，实际 ${simpleAnswers.length} 条 agent 消息`);
  assert.equal(simpleAnswers[0].from, 'reviewer', `最近成功回复者应为 reviewer，实际 ${simpleAnswers[0]?.from}`);

  // 结构化追问（再进行1轮辩论）→ 协调房间服务端重新规划新 Plan，而非 pipeline 重跑
  const structured = await api(askUrl, 'POST', { body: '进行1轮辩论，正方支持方案 C，反方支持方案 D，最后由 Reviewer 裁判 [tool:fs.write]', clientMessageId: crypto.randomUUID() });
  assert.equal(structured.status, 202, JSON.stringify(structured.data));
  await waitForRun(structured.data.run.id, 30_000);
  const structuredPlan = await api(`/api/runs/${structured.data.run.id}/coordination-plan`);
  assert.equal(structuredPlan.status, 200, '结构化追问应生成新 Coordination Plan');
  assert.ok(structuredPlan.data.protocols.some((item) => item.protocol === 'debate'));
  assert.notEqual(structuredPlan.data.id, debate.plan.id, '必须是新 Plan 而非复用上一轮');
  const structuredRuntime = await coordination(structured.data.run.id);
  assert.ok(structuredRuntime.steps.every((step) => step.status === 'completed'));
  const structuredSandbox = sandboxDirOf(structured.data.run);
  for (const rel of ['debate/r1-pro.md', 'debate/r1-con.md']) {
    const content = await readFile(path.join(structuredSandbox, rel), 'utf8');
    assert.ok(content.length >= 64, `新 Plan 产物未落盘：${rel}`);
  }

  // 定向 + 结构化复合诉求（真机会话 31ec5657 seq30 形态）："@A @B 分别调研…最后由 @reviewer 汇总"
  // → 必须走编排（汇总步骤等待全部分支），@提及不得短路成并行问答；点名成员绑定聚合步骤
  const hybrid = await api(askUrl, 'POST', {
    body: '@planner @coder 分别调研两个方案的优劣，最后由 @reviewer 进行汇总',
    recipientIds: ['planner', 'coder'], clientMessageId: crypto.randomUUID(),
  });
  assert.equal(hybrid.status, 202, JSON.stringify(hybrid.data));
  await waitForRun(hybrid.data.run.id, 30_000);
  const hybridPlan = await api(`/api/runs/${hybrid.data.run.id}/coordination-plan`);
  assert.equal(hybridPlan.status, 200, '定向+结构化复合诉求必须生成 Coordination Plan，不得短路成定向问答');
  assert.ok(hybridPlan.data.protocols.some((item) => item.protocol === 'parallel_fanout'));
  const aggregateStep = hybridPlan.data.steps.find((step) => step.id === 'parallel-aggregate');
  assert.equal(aggregateStep.agentId, 'reviewer', `点名汇总者应绑定聚合步骤，实际 ${aggregateStep.agentId}`);
  const hybridRuntime = await coordination(hybrid.data.run.id);
  assert.ok(hybridRuntime.steps.every((step) => step.status === 'completed'));
  const hybridBranches = hybridRuntime.steps.filter((step) => step.stepId.startsWith('parallel-branch-'));
  const hybridAggregate = hybridRuntime.steps.find((step) => step.stepId === 'parallel-aggregate');
  assert.equal(hybridBranches.length, 2);
  assert.ok(hybridBranches.every((step) => new Date(hybridAggregate.startedAt) >= new Date(step.completedAt)), '汇总步骤必须等待全部调研分支完成');
  const hybridAnswers = (await api(`/api/runs/${hybrid.data.run.id}`)).data.messages.filter(isFinalAgent);
  assert.equal(hybridAnswers.length, 3, '两个调研分支 + 一次汇总');
  assert.equal(hybridAnswers[2].from, 'reviewer', '最后一条必须是 reviewer 的汇总');

  const ambiguous = await preview({ goal: '分析认证方案的取舍', agentIds: ['planner', 'coder'] });
  assert.equal(ambiguous.draft.decision, 'clarify');
  assert.ok(ambiguous.draft.clarificationQuestion);
  assert.equal(ambiguous.draft.clarificationOptions.length, 2);

  const invalidSingle = await preview({ goal: '共同总结', agentIds: ['planner', 'coder'], requestedProtocol: 'single_agent' });
  assert.equal(invalidSingle.draft.decision, 'unavailable');
  assert.ok(invalidSingle.draft.validationErrors.includes('AGENT_COUNT_ABOVE_MAXIMUM'));

  const invalidRounds = await preview({
    goal: '进行1000000轮辩论，正方与反方固定立场，最后由 Reviewer 裁判',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  assert.equal(invalidRounds.draft.decision, 'unavailable');
  assert.ok(invalidRounds.draft.validationErrors.includes('INVALID_DEBATE_ROUNDS'));
  assert.ok(invalidRounds.plan.steps.length <= 22, '无效轮次不得造成无界 Plan 展开');

  const repeat = await preview({
    goal: debateGoal, agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const shape = (value) => ({
    protocols: value.draft.protocols,
    brief: value.draft.taskBrief,
    steps: value.plan.steps.map(({ id, protocol, type, actorRole, agentId, dependsOn, completion, maxAttempts, onFailure, metadata }) => ({ id, protocol, type, actorRole, agentId, dependsOn, completion, maxAttempts, onFailure, metadata })),
    completion: value.plan.completion,
  });
  assert.deepEqual(shape(repeat), shape(debate));

  const recovery = await preview({
    goal: '进行10轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [tool:fs.write]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const recoveryStarted = await startDraft(recovery, { defaultReviewerId: 'reviewer' });
  await poll(
    () => coordination(recoveryStarted.run.id),
    (value) => value.steps.some((step) => step.status === 'completed') && value.steps.some((step) => step.status === 'running'),
    '等待可恢复的运行中步骤',
  );
  await stopServer('SIGKILL');
  startServer();
  await waitForServer();
  const recoveredDetail = await waitForRun(recoveryStarted.run.id, 20_000);
  const recoveredRuntime = await coordination(recoveryStarted.run.id);
  assert.ok(recoveredRuntime.steps.every((step) => step.status === 'completed'));
  assert.equal(recoveredRuntime.attempts.length, recovery.plan.steps.length, '重启后必须复用 interrupted attempt，不得重复增加 attempt');
  assert.equal(new Set(recoveredRuntime.attempts.map((attempt) => attempt.idempotencyKey)).size, recoveredRuntime.attempts.length);
  const recoveredMessages = recoveredDetail.messages.filter(isFinalAgent);
  assert.equal(recoveredMessages.length, 21, '十轮辩论恢复后应恰好有二十次发言和一次裁决');
  assert.equal(new Set(recoveredMessages.map((message) => message.payload.coordinationStepId)).size, 21);

  // ---- AG-COORD-01：承诺冻结但未落盘 → 步骤失败、裁判不得启动、plan 失败 ----
  const noFreeze = await preview({
    goal: '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [no-freeze]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const noFreezeStarted = await startDraft(noFreeze, { defaultReviewerId: 'reviewer' });
  const noFreezeFinal = await poll(
    async () => api(`/api/runs/${noFreezeStarted.run.id}`),
    (value) => ['completed', 'failed'].includes(value.data?.run?.status),
    '缺产物 run 到达终态',
  );
  assert.equal(noFreezeFinal.data.run.status, 'failed', '产物未冻结的 run 不得标记 completed');
  const noFreezeRuntime = await coordination(noFreezeStarted.run.id);
  const noFreezePro = noFreezeRuntime.steps.find((step) => step.stepId === 'debate-r1-pro');
  assert.equal(noFreezePro.status, 'failed');
  assert.ok(noFreezePro.error.includes('产物未冻结'), `错误应说明产物缺失，实际：${noFreezePro.error}`);
  assert.equal(attemptsFor(noFreezeRuntime, 'debate-r1-pro').length, 2, '产物缺失必须重试一次后终止');
  assert.equal(noFreezeRuntime.steps.find((step) => step.stepId === 'debate-judge').status, 'pending', '裁判不得启动');
  assert.ok(noFreezeRuntime.events.some((event) => event.kind === 'plan_failed'));

  // ---- AG-COORD-02：max_tokens 截断 → attempt 失败并重试，第二次产出完整产物 ----
  const truncate = await preview({
    goal: '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [truncate] [tool:fs.write]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const truncateStarted = await startDraft(truncate, { defaultReviewerId: 'reviewer' });
  const truncateDetail = await waitForRun(truncateStarted.run.id, 30_000);
  const truncateRuntime = await coordination(truncateStarted.run.id);
  const truncateAttempts = attemptsFor(truncateRuntime, 'debate-r1-pro');
  assert.equal(truncateAttempts.length, 2, '截断必须触发步骤级重试');
  assert.ok(truncateAttempts[0].error.includes('max_tokens 截断'), `首次 attempt 应记截断错误，实际：${truncateAttempts[0].error}`);
  assert.equal(truncateAttempts[1].status, 'completed');
  const truncatedContent = await readFile(path.join(sandboxDirOf(truncateDetail.run), 'debate/r1-pro.md'), 'utf8');
  assert.ok(truncatedContent.length >= 64, '重试后产物必须真实落盘');

  // ---- AG-COORD-03：外部工作区按 plan 子目录隔离，跨 run 产物不混写 ----
  const extRoot = path.join(root, 'ext-ws');
  await mkdir(extRoot, { recursive: true });
  const register = await api('/api/workspaces/register', 'POST', { path: extRoot, label: 'isolation' });
  assert.ok([200, 201].includes(register.status), JSON.stringify(register.data));
  const extId = register.data.id;
  const iso = await preview({
    goal: '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [tool:fs.write]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const isoStarted = await startDraft(iso, { defaultReviewerId: 'reviewer', workspace: `ext:${extId}` });
  const isoFinal = await approveUntilDone(isoStarted.run.id);
  assert.equal(isoFinal.data.run.status, 'completed');
  const isoRuntime = await coordination(isoStarted.run.id);
  const isoScope = isoRuntime.plan.id.slice(0, 8);
  for (const rel of ['debate/r1-pro.md', 'debate/r2-con.md', 'debate/r3-con.md']) {
    const content = await readFile(path.join(extRoot, isoScope, rel), 'utf8');
    assert.ok(content.length >= 64, `ext 产物必须落在 plan 隔离子目录：${isoScope}/${rel}`);
  }
  await assert.rejects(() => readFile(path.join(extRoot, 'debate/r1-pro.md')), '外部根目录不得直接出现产物（无隔离会跨 run 混写）');

  // ---- AG-COORD-04：审批连续超时 → 暂停待恢复；恢复复用原 attempt；取消走终态 ----
  await stopServer();
  startServer({ APPROVAL_TIMEOUT_MS: '400', APPROVAL_MAX_EXPIRIES: '1' });
  await waitForServer();
  const pause = await preview({
    goal: '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [tool:fs.write]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const pauseStarted = await startDraft(pause, { defaultReviewerId: 'reviewer', workspace: `ext:${extId}` });
  await poll(
    async () => api(`/api/runs/${pauseStarted.run.id}`),
    (value) => value.data?.run?.status === 'waiting_for_user',
    '审批超时后 run 应进入 waiting_for_user',
    10_000,
  );
  const pausedRuntime = await coordination(pauseStarted.run.id);
  assert.equal(pausedRuntime.plan.status, 'paused');
  assert.equal(pausedRuntime.steps.find((step) => step.stepId === 'debate-r1-pro').status, 'ready', '暂停的步骤应释放回 ready');
  assert.ok(pausedRuntime.attempts.some((attempt) => attempt.stepId === 'debate-r1-pro' && attempt.status === 'paused'));
  assert.ok(pausedRuntime.events.some((event) => event.kind === 'plan_paused'));
  const pendingAfterPause = ((await api('/api/approvals?status=pending')).data ?? []).filter((item) => item.runId === pauseStarted.run.id);
  assert.equal(pendingAfterPause.length, 0, '暂停后不得遗留 pending 审批卡');
  const resume = await api(`/api/runs/${pauseStarted.run.id}/coordination/resume`, 'POST');
  assert.ok([200, 201].includes(resume.status), JSON.stringify(resume.data));
  const resumedFinal = await approveUntilDone(pauseStarted.run.id);
  assert.equal(resumedFinal.data.run.status, 'completed', '恢复后应能跑完整个计划');
  const resumedRuntime = await coordination(pauseStarted.run.id);
  assert.ok(resumedRuntime.events.some((event) => event.kind === 'plan_resumed'));
  assert.equal(attemptsFor(resumedRuntime, 'debate-r1-pro').length, 1, '恢复必须复用暂停的 attempt，不得烧新 attempt');
  // 取消路径：再造一次暂停后直接取消 → run 终态 cancelled
  const cancelPrev = await preview({
    goal: '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判 [tool:fs.write]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const cancelStarted = await startDraft(cancelPrev, { defaultReviewerId: 'reviewer', workspace: `ext:${extId}` });
  await poll(
    async () => api(`/api/runs/${cancelStarted.run.id}`),
    (value) => value.data?.run?.status === 'waiting_for_user',
    '取消场景：等待暂停',
    10_000,
  );
  const cancelResult = await api(`/api/runs/${cancelStarted.run.id}/coordination/cancel`, 'POST');
  assert.ok([200, 201].includes(cancelResult.status), JSON.stringify(cancelResult.data));
  assert.equal(cancelResult.data.status, 'cancelled');
  assert.equal((await coordination(cancelStarted.run.id)).plan.status, 'cancelled');

  // ---- 信任目录：注册 trusted 外部工作区 → fs.write 免逐次审批，隔离不变 ----
  const trustedRoot = path.join(root, 'trusted-ws');
  await mkdir(trustedRoot, { recursive: true });
  const trustedReg = await api('/api/workspaces/register', 'POST', { path: trustedRoot, label: 'trusted', trusted: true });
  assert.ok([200, 201].includes(trustedReg.status), JSON.stringify(trustedReg.data));
  assert.equal(trustedReg.data.trusted, true, '注册时应持久化 trusted 标记');
  const toggleOff = await api(`/api/workspaces/register/${trustedReg.data.id}/trust`, 'POST', { trusted: false });
  assert.equal(toggleOff.data.trusted, false, '信任开关可关闭');
  await api(`/api/workspaces/register/${trustedReg.data.id}/trust`, 'POST', { trusted: true });
  const trusted = await preview({
    goal: '进行1轮辩论，正方支持方案 E，反方支持方案 F，最后由 Reviewer 裁判 [tool:fs.write]',
    agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  const trustedStarted = await startDraft(trusted, { defaultReviewerId: 'reviewer', workspace: `ext:${trustedReg.data.id}` });
  const trustedDetail = await waitForRun(trustedStarted.run.id, 30_000);
  assert.equal(trustedDetail.run.status, 'completed');
  const trustedApprovals = ((await api('/api/approvals')).data ?? []).filter((item) => item.runId === trustedStarted.run.id);
  assert.equal(trustedApprovals.length, 0, '信任目录内写入不得产生审批卡');
  const trustedRuntime = await coordination(trustedStarted.run.id);
  const trustedScope = trustedRuntime.plan.id.slice(0, 8);
  const trustedContent = await readFile(path.join(trustedRoot, trustedScope, 'debate/r1-pro.md'), 'utf8');
  assert.ok(trustedContent.length >= 64, '信任目录仍须按 plan 子目录隔离落盘');

  console.log('coordination verification passed: planning, execution, barriers, review revision, debate freeze, truncation retry, isolation, pause/resume, recovery, observability');
} finally {
  await stopServer();
  await rm(root, { recursive: true, force: true });
}
