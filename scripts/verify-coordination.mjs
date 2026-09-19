import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-coordination-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);

function agent(name, capabilities) {
  return `---\nname: ${name}\ndescription: ${name} coordination fixture\nmodel: mock:${name.toLowerCase()}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: []\npermissionMode: readonly\ncolor: '#6677aa'\n---\n${name} fixture`;
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

function startServer() {
  assert.equal(child, null, 'server already running');
  child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error' },
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

  const debateGoal = '进行三轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判';
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
  const debateMessages = debateDetail.messages.filter((message) => message.kind === 'agent');
  assert.equal(debateMessages.length, 7, '三轮辩论必须形成六次独立发言和一次裁决');
  assert.deepEqual(debateMessages.map((message) => message.payload.coordinationStepId), [
    'debate-r1-pro', 'debate-r1-con', 'debate-r2-pro', 'debate-r2-con', 'debate-r3-pro', 'debate-r3-con', 'debate-judge',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const settledDebate = await api(`/api/runs/${debateStarted.run.id}`);
  assert.equal(settledDebate.data.messages.filter((message) => message.kind === 'agent').length, 7, '完成后不得出现迟到输出');
  const observed = await api(`/api/runs/${debateStarted.run.id}/observability`);
  assert.equal(observed.status, 200);
  assert.equal(observed.data.graph.nodes.filter((node) => node.kind === 'coordination_step').length, debate.plan.steps.length);
  assert.equal(observed.data.groups.filter((group) => group.kind === 'coordination_step').length, 7);

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
    goal: '进行10轮辩论，正方支持方案 A，反方支持方案 B，最后由 Reviewer 裁判',
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
  const recoveredMessages = recoveredDetail.messages.filter((message) => message.kind === 'agent');
  assert.equal(recoveredMessages.length, 21, '十轮辩论恢复后应恰好有二十次发言和一次裁决');
  assert.equal(new Set(recoveredMessages.map((message) => message.payload.coordinationStepId)).size, 21);

  console.log('coordination verification passed: planning, execution, barriers, review revision, debate, recovery, observability');
} finally {
  await stopServer();
  await rm(root, { recursive: true, force: true });
}
