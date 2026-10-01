import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-collaboration-'));
const agentsDir = path.join(root, 'agents'); await mkdir(agentsDir);
const definitions = [
  ['planner', 'Planner', 'mock:planner', '[coordinate, execute]', '负责规划与协调。'],
  ['coder', 'Coder', 'mock:coder', '[execute]', '负责实现。'],
  ['reviewer', 'Reviewer', 'mock:reviewer', '[review]', '负责审查。'],
  ['coder-jitui', '鸡腿🍗', 'mock:coder', '[execute]', '你的名字叫鸡腿🍗，负责实现与技术答疑。'],
];
for (const [id, name, model, capabilities, prompt] of definitions) await writeFile(path.join(agentsDir, `${id}.agent.md`), `---\nname: ${name}\ndescription: ${prompt}\nmodel: ${model}\ncapabilities: ${capabilities}\ntools: []\npermissionMode: readonly\ncolor: '#6677aa'\n---\n${prompt}`);

const dbPath = path.join(root, 'test.sqlite');
const admissionProfile = process.env.COLLAB_RUNTIME_MODE
  ?? (process.env.COLLAB_COMPLETION_ENGINE === 'true' ? 'execute'
    : process.env.COLLAB_RUNTIME_ATOMIC === 'true' ? 'atomic_compat'
      : process.env.COLLAB_RUNTIME_SHADOW === 'true' ? 'shadow' : 'execute');
const completionEngine = admissionProfile === 'execute';
const runtimeStateEnabled = admissionProfile !== 'legacy';
const port = 41000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error', COLLAB_MAX_DISPATCHES: '2' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise((resolve) => child.once('exit', resolve));
let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  return { status: response.status, data };
}
async function waitRun(runId, statuses, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < end) {
    const result = await api(`/api/runs/${runId}`);
    latest = result.data.run;
    if (statuses.includes(result.data.run.status)) return result.data.run;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待 Run ${runId} 状态 ${statuses.join('/')} 超时，当前状态 ${latest?.status ?? 'unknown'}\n${logs}`);
}
function assertShadowComparisons(detail, label) {
  if (admissionProfile !== 'shadow') return;
  const completed = detail.attempts.filter((attempt) => attempt.status === 'completed' && attempt.controlAction);
  assert.equal(detail.shadowComparisons.length, completed.length,
    `${label}: 每个已完成 Attempt 应有且只有一条 Shadow Comparison`);
  assert.equal(new Set(detail.shadowComparisons.map((item) => item.attemptId)).size, detail.shadowComparisons.length,
    `${label}: Shadow Comparison 不得重复`);
  assert.ok(detail.shadowComparisons.every((item) => item.classification !== 'observer_error'),
    `${label}: Shadow 差异必须可解释，不能静默观察失败`);
  for (const comparison of detail.shadowComparisons) {
    const attempt = completed.find((item) => item.id === comparison.attemptId);
    assert.ok(attempt, `${label}: Comparison 必须关联已完成 Attempt`);
    assert.equal(comparison.outputSha256, createHash('sha256').update(attempt.output ?? '').digest('hex'),
      `${label}: Shadow 必须消费同一份已持久化输出`);
    assert.ok(comparison.responsibilitySnapshot && comparison.snapshotFingerprint,
      `${label}: Shadow 必须冻结判定前责任快照`);
  }
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 99) throw new Error(logs);
  }

  const handoff = await api('/api/conversations', 'POST', {
    goal: '[collab:send:coder] 请实现登录修复', agentIds: ['planner', 'coder', 'reviewer'], recipientIds: ['planner'],
  });
  assert.equal(handoff.status, 201, JSON.stringify(handoff.data));
  assert.equal(handoff.data.conversation.mode, 'collaboration');
  await waitRun(handoff.data.run.id, ['completed']);
  const handoffDetail = await api(`/api/runs/${handoff.data.run.id}/collaboration`);
  assert.equal(handoffDetail.status, 200);
  assert.deepEqual(handoffDetail.data.dispatches.map((item) => [item.kind, item.targetAgentId]), [['initial', 'planner'], ['handoff', 'coder']]);
  assert.ok(handoffDetail.data.dispatches.every((item) => item.status === 'completed'),
    JSON.stringify(handoffDetail.data.dispatches.map((item) => ({ id: item.id, kind: item.kind, status: item.status, error: item.error }))));
  assert.ok(handoffDetail.data.attempts.every((item) => item.controlAction?.version === 2),
    '新 Run 的 Attempt 必须持久化规范 ControlAction v2');
  assert.equal(handoffDetail.data.attempts[0]?.controlAction?.type, 'handoff');
  assert.equal(handoffDetail.data.attempts[1]?.controlAction?.type, 'complete',
    '动态 handoff 接手者必须经同轮纠偏提交显式 complete');
  assert.deepEqual(handoffDetail.data.actionCommands.map((item) => item.kind), ['handoff', 'complete'],
    '真实 Scheduler 必须通过公共 handoff/complete 命令提交动作');
  assert.equal(new Set(handoffDetail.data.actionCommands.map((item) => item.commandKey)).size,
    handoffDetail.data.actionCommands.length, '每个 Attempt 只能提交一个稳定动作命令');
  assertShadowComparisons(handoffDetail.data, 'handoff');
  if (runtimeStateEnabled) {
    assert.equal(handoffDetail.data.completionCandidates.length, 1);
    assert.equal(handoffDetail.data.completionCandidates[0]?.status, 'accepted');
    assert.equal(handoffDetail.data.completionCandidates[0]?.agentId, 'coder');
    assert.deepEqual(handoffDetail.data.successorObligations.map((item) => [item.kind, item.status]),
      [['handoff_acquire', 'satisfied']], 'handoff 必须在目标 claim 后满足类型化接球义务');
    assert.deepEqual([...new Set(handoffDetail.data.evidenceBundles.map((item) => item.ownerType))].sort(),
      ['completion_candidate', 'handoff_capsule']);
    assert.ok(handoffDetail.data.evidenceBundles.every((item) => item.status === 'valid'));
    assert.ok(handoffDetail.data.completionCandidates[0]?.evidenceBundleId,
      '新版 CompletionCandidate 必须引用冻结 EvidenceBundle');
  }
  if (completionEngine) {
    assert.equal(handoffDetail.data.terminal?.status, 'completed');
    assert.equal(handoffDetail.data.terminal?.disposition, 'accepted');
  }
  assert.ok(handoffDetail.data.attempts.every((item) => typeof item.inputContext === 'string' && item.inputContext.includes('当前执行信息')));
  const handoffAttempt = handoffDetail.data.attempts.find((item) => item.dispatchId === handoffDetail.data.dispatches[1].id);
  assert.match(handoffAttempt?.inputContext ?? '', /交接 Capsule/u);
  assert.match(handoffAttempt?.inputContext ?? '', /经校验的来源摘录/u);
  if (admissionProfile === 'execute' || admissionProfile === 'atomic_compat') {
    const handoffObligation = handoffDetail.data.successorObligations.find((item) => item.kind === 'handoff_acquire');
    assert.ok(handoffObligation, '真实 Scheduler handoff 必须创建类型化接球义务');
    assert.match(handoffAttempt?.inputContext ?? '', /schema 2/u);
    assert.match(handoffAttempt?.inputContext ?? '', /Capsule 后继义务引用/u);
    assert.match(handoffAttempt?.inputContext ?? '', new RegExp(handoffObligation.id),
      '接手者 Context 必须完整携带 Runtime 生成的义务 ID');
  }
  const handoffRunDetail = await api(`/api/runs/${handoff.data.run.id}`);
  const traceEvents = handoffRunDetail.data.events;
  const collaborationRoot = traceEvents.find((event) => event.name === `collaboration:${handoff.data.run.id}`);
  assert.equal(collaborationRoot?.status, 'ok');
  const dispatchSpans = traceEvents.filter((event) => event.name.startsWith('dispatch:'));
  assert.equal(dispatchSpans.length, 2);
  assert.ok(dispatchSpans.every((event) => event.parentId === collaborationRoot.id));
  assert.ok(traceEvents.filter((event) => event.name.startsWith('control:')).every((event) => traceEvents.some((parent) => parent.id === event.parentId && parent.spanKind === 'agent')));
  assert.ok(traceEvents.some((event) => event.name === 'exit_guard:continue_same_turn'));
  assert.ok(traceEvents.some((event) => event.name === 'exit_guard:allow_candidate'));
  if (runtimeStateEnabled) assert.ok(traceEvents.some((event) => event.name === 'completion_candidate:accepted'));
  const firstLlmTools = JSON.parse(traceEvents.find((event) => event.spanKind === 'llm')?.input ?? '{}').tools ?? [];
  assert.ok(['agent.complete', 'agent.handoff', 'agent.consult', 'agent.hold']
    .every((name) => firstLlmTools.includes(name)), 'toolApiVersion=2 必须只下发 Agent API v2 领域工具');
  assert.ok(['agent.send_message', 'agent.ask_many', 'agent.wait_for_user']
    .every((name) => !firstLlmTools.includes(name)), '新 Run 不得向模型暴露旧工具别名');
  const correctionLlms = traceEvents.filter((event) => event.attributes?.['orchestration.phase'] === 'agent.exit_correction');
  assert.equal(correctionLlms.length, 1, '默认策略只能发起一次同轮纠偏调用');
  const correctionLlm = correctionLlms[0];
  assert.ok(JSON.parse(correctionLlm.input).tools.every((name) => name.startsWith('agent.')),
    '同轮纠偏只能看到控制工具，不得重复普通工具');

  const statusQuestion = await api('/api/conversations', 'POST', {
    goal: '你好，鸡腿，你现在状态如何？', mode: 'collaboration', agentIds: ['coder-jitui'], recipientIds: ['coder-jitui'],
  });
  assert.equal(statusQuestion.status, 201, JSON.stringify(statusQuestion.data));
  await waitRun(statusQuestion.data.run.id, ['completed']);
  const statusRoom = await api(`/api/conversations/${statusQuestion.data.conversation.id}`);
  const statusReply = statusRoom.data.messages.find((message) => message.kind === 'agent');
  assert.match(statusReply?.body ?? '', /鸡腿.*当前在线/u);
  assert.doesNotMatch(statusReply?.body ?? '', /你正在 agent-gand/u);
  const statusDetail = await api(`/api/runs/${statusQuestion.data.run.id}/collaboration`);
  assert.equal(statusDetail.data.attempts[0]?.controlAction?.type, 'answer_candidate',
    '简单 initial 直答必须保留隐式答案快路径');
  if (runtimeStateEnabled) {
    assert.equal(statusDetail.data.completionCandidates[0]?.action.type, 'answer_candidate');
    assert.equal(statusDetail.data.completionCandidates[0]?.status, 'accepted');
  }

  const truncated = await api('/api/conversations', 'POST', {
    goal: '[truncate] 请生成不能以残缺正文交付的完整答复', mode: 'collaboration', agentIds: ['coder'], recipientIds: ['coder'],
  });
  assert.equal(truncated.status, 201, JSON.stringify(truncated.data));
  await waitRun(truncated.data.run.id, ['failed']);
  const truncatedDetail = await api(`/api/runs/${truncated.data.run.id}/collaboration`);
  assert.equal(truncatedDetail.data.dispatches[0]?.status, 'blocked');
  assert.match(truncatedDetail.data.dispatches[0]?.error ?? '', /^AGENT_TURN_TRUNCATED/u);
  const truncatedRoom = await api(`/api/conversations/${truncated.data.conversation.id}`);
  assert.equal(truncatedRoom.data.messages.filter((message) => message.runId === truncated.data.run.id && message.messageType === 'collaboration_result').length, 0);

  const unsupportedChat = await api('/api/conversations', 'POST', {
    goal: '请围绕一个开放话题进行深入辩论', mode: 'collaboration', agentIds: ['coder-jitui'], recipientIds: ['coder-jitui'],
  });
  assert.equal(unsupportedChat.status, 201, JSON.stringify(unsupportedChat.data));
  await waitRun(unsupportedChat.data.run.id, ['completed']);
  const unsupportedRoom = await api(`/api/conversations/${unsupportedChat.data.conversation.id}`);
  const unsupportedReply = unsupportedRoom.data.messages.find((message) => message.kind === 'agent');
  assert.match(unsupportedReply?.body ?? '', /Mock 演示模型/u);
  assert.doesNotMatch(unsupportedReply?.body ?? '', /【实现】/u);

  const teamCheck = await api('/api/conversations', 'POST', {
    goal: '帮忙检查团队其他成员的情况', mode: 'collaboration',
    agentIds: ['coder-jitui', 'planner', 'coder', 'reviewer'], recipientIds: ['coder-jitui'],
  });
  assert.equal(teamCheck.status, 201, JSON.stringify(teamCheck.data));
  await waitRun(teamCheck.data.run.id, ['waiting_for_user']);
  const teamCheckPaused = await api(`/api/runs/${teamCheck.data.run.id}/collaboration`);
  const teamBudget = teamCheckPaused.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
  assert.ok(teamBudget);
  const teamExtended = await api(`/api/collaboration/decisions/${teamBudget.id}/resolve`, 'POST', { action: 'increase_budget', increasePercent: 200 });
  assert.equal(teamExtended.status, 200, JSON.stringify(teamExtended.data));
  await waitRun(teamCheck.data.run.id, ['completed'], 12_000);
  const teamCheckDetail = await api(`/api/runs/${teamCheck.data.run.id}/collaboration`);
  assert.deepEqual(teamCheckDetail.data.dispatches.map((item) => item.kind), ['initial', 'resume', 'fanout', 'fanout', 'fanout', 'aggregate']);
  const teamRoom = await api(`/api/conversations/${teamCheck.data.conversation.id}`);
  const teamReply = [...teamRoom.data.messages].reverse().find((message) => message.kind === 'agent' && message.from === 'coder-jitui');
  assert.match(teamReply?.body ?? '', /已经检查完团队其他成员的情况/u);
  assert.match(teamReply?.body ?? '', /Planner/u);
  assert.match(teamReply?.body ?? '', /Coder/u);
  assert.match(teamReply?.body ?? '', /Reviewer/u);
  assert.equal(teamRoom.data.messages.filter((message) => message.runId === teamCheck.data.run.id && message.messageType === 'collaboration_result').length, 1);
  const teamContributions = teamRoom.data.messages.filter((message) => message.runId === teamCheck.data.run.id && message.messageType === 'collaboration_contribution');
  assert.equal(teamContributions.length, 3, '每个并行成员必须留下独立的可见发言');
  assert.deepEqual(new Set(teamContributions.map((message) => message.from)), new Set(['planner', 'coder', 'reviewer']));
  assert.ok(teamContributions.every((message) => message.body && message.replyTo && message.meta?.dispatchId && message.meta?.batchId));

  const fanoutReturn = await api('/api/conversations', 'POST', {
    goal: '[collab:ask-return:planner:coder,reviewer] 请分别调研后回报',
    mode: 'collaboration', agentIds: ['planner', 'coder', 'reviewer'], recipientIds: ['planner'],
  });
  assert.equal(fanoutReturn.status, 201, JSON.stringify(fanoutReturn.data));
  await waitRun(fanoutReturn.data.run.id, ['waiting_for_user']);
  const fanoutPaused = await api(`/api/runs/${fanoutReturn.data.run.id}/collaboration`);
  const fanoutBudget = fanoutPaused.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
  assert.ok(fanoutBudget);
  const fanoutExtended = await api(`/api/collaboration/decisions/${fanoutBudget.id}/resolve`, 'POST', { action: 'increase_budget', increasePercent: 200 });
  assert.equal(fanoutExtended.status, 200, JSON.stringify(fanoutExtended.data));
  await waitRun(fanoutReturn.data.run.id, ['completed'], 12_000);
  const fanoutDetail = await api(`/api/runs/${fanoutReturn.data.run.id}/collaboration`);
  assertShadowComparisons(fanoutDetail.data, 'consult(all)');
  assert.deepEqual(fanoutDetail.data.dispatches.map((item) => item.kind), ['initial', 'resume', 'fanout', 'fanout', 'aggregate']);
  assert.ok(fanoutDetail.data.attempts.filter((item) => fanoutDetail.data.dispatches.some((dispatch) => dispatch.id === item.dispatchId && dispatch.kind === 'fanout')).every((item) => item.output?.includes('请继续处理')));
  if (runtimeStateEnabled) {
    const consultObligations = fanoutDetail.data.successorObligations.filter((item) => item.kind === 'consult_result');
    assert.equal(consultObligations.length, 2);
    assert.ok(consultObligations.every((item) => item.status === 'satisfied'));
    assert.ok(fanoutDetail.data.successorObligations.filter((item) => item.kind === 'user_decision')
      .every((item) => item.status === 'satisfied'));
  }
  const fanoutRoom = await api(`/api/conversations/${fanoutReturn.data.conversation.id}`);
  assert.equal(fanoutRoom.data.messages.filter((message) => message.runId === fanoutReturn.data.run.id && message.messageType === 'collaboration_result').length, 1);
  const fanoutContributions = fanoutRoom.data.messages.filter((message) => message.runId === fanoutReturn.data.run.id && message.messageType === 'collaboration_contribution');
  assert.equal(fanoutContributions.length, 2, '回发发起者的 fanout 结果也必须作为两条发言保留');
  assert.deepEqual(new Set(fanoutContributions.map((message) => message.from)), new Set(['coder', 'reviewer']));
  assert.ok(fanoutContributions.every((message) => message.body.includes('请继续处理')));
  const refreshedFanoutRoom = await api(`/api/conversations/${fanoutReturn.data.conversation.id}`);
  assert.deepEqual(refreshedFanoutRoom.data.messages.filter((message) => message.messageType === 'collaboration_contribution').map((message) => message.id), fanoutContributions.map((message) => message.id), '刷新后发言必须保留且不重复');

  const debateRouting = await api('/api/conversations', 'POST', {
    goal: '[collab:send:coder][collab:send:planner][collab:send:coder][collab:send:planner] 10轮辩论路由验证',
    mode: 'collaboration', agentIds: ['planner', 'coder'], recipientIds: ['planner'],
  });
  assert.equal(debateRouting.status, 201, JSON.stringify(debateRouting.data));
  await waitRun(debateRouting.data.run.id, ['waiting_for_user']);
  const debatePaused = await api(`/api/runs/${debateRouting.data.run.id}/collaboration`);
  const debateBudget = debatePaused.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
  assert.ok(debateBudget);
  const debateExtended = await api(`/api/collaboration/decisions/${debateBudget.id}/resolve`, 'POST', { action: 'increase_budget', increasePercent: 200 });
  assert.equal(debateExtended.status, 200, JSON.stringify(debateExtended.data));
  await waitRun(debateRouting.data.run.id, ['completed'], 12_000);
  const debateDetail = await api(`/api/runs/${debateRouting.data.run.id}/collaboration`);
  assert.equal(debateDetail.data.dispatches.filter((item) => item.kind === 'handoff').length, 4);
  assert.ok(debateDetail.data.dispatches.every((item) => item.status === 'completed'));

  const blockedRouting = await api('/api/conversations', 'POST', {
    goal: '[collab:send:coder][collab:send:planner][collab:send:coder][collab:send:planner] 交接熔断验证',
    mode: 'collaboration', agentIds: ['planner', 'coder'], recipientIds: ['planner'],
  });
  await waitRun(blockedRouting.data.run.id, ['waiting_for_user']);
  const blockedPaused = await api(`/api/runs/${blockedRouting.data.run.id}/collaboration`);
  const blockedBudget = blockedPaused.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
  assert.ok(blockedBudget);
  await api(`/api/collaboration/decisions/${blockedBudget.id}/resolve`, 'POST', { action: 'increase_budget', increasePercent: 200 });
  await waitRun(blockedRouting.data.run.id, [completionEngine ? 'failed' : 'completed'], 12_000);
  const blockedDetail = await api(`/api/runs/${blockedRouting.data.run.id}/collaboration`);
  assert.equal(blockedDetail.data.dispatches.filter((item) => item.status === 'blocked').length, 1);
  assert.match(blockedDetail.data.dispatches.find((item) => item.status === 'blocked')?.error ?? '', /连续往返/u);

  const multi = await api('/api/conversations', 'POST', {
    goal: '分别给出意见', mode: 'collaboration', agentIds: ['planner', 'coder', 'reviewer'], recipientIds: ['coder', 'reviewer'],
  });
  assert.equal(multi.status, 201, JSON.stringify(multi.data));
  await waitRun(multi.data.run.id, ['completed']);
  const multiDetail = await api(`/api/runs/${multi.data.run.id}/collaboration`);
  assert.deepEqual(new Set(multiDetail.data.dispatches.map((item) => item.targetAgentId)), new Set(['coder', 'reviewer']));
  const multiAttempts = multiDetail.data.attempts.filter((item) => item.status === 'completed');
  assert.equal(multiAttempts.length, 2);
  if (completionEngine) {
    const multiRoom = await api(`/api/conversations/${multi.data.conversation.id}`);
    assert.equal(multiRoom.data.messages.filter((message) => message.runId === multi.data.run.id && message.messageType === 'collaboration_result').length, 1,
      'Completion Engine 必须只发布一次最终报告');
  }
  assert.ok(new Date(multiAttempts[0].startedAt).getTime() < new Date(multiAttempts[1].endedAt).getTime()
    && new Date(multiAttempts[1].startedAt).getTime() < new Date(multiAttempts[0].endedAt).getTime(), '不同 Agent 应并发执行');

  const room = await api(`/api/conversations/${multi.data.conversation.id}`);
  const lastAgent = completionEngine ? multi.data.run.agentIds[0]
    : [...room.data.messages].reverse().find((message) => message.kind === 'agent' && multi.data.run.agentIds.includes(message.from)).from;
  const follow = await api(`/api/conversations/${multi.data.conversation.id}/messages`, 'POST', { body: '继续补充', clientMessageId: crypto.randomUUID() });
  assert.equal(follow.status, 202, JSON.stringify(follow.data));
  await waitRun(follow.data.run.id, ['completed']);
  const followDetail = await api(`/api/runs/${follow.data.run.id}/collaboration`);
  assert.equal(followDetail.data.dispatches[0].targetAgentId, lastAgent);

  const waiting = await api(`/api/conversations/${multi.data.conversation.id}/messages`, 'POST', {
    body: '[collab:wait] 需要用户判断', recipientIds: ['planner'], clientMessageId: crypto.randomUUID(),
  });
  await waitRun(waiting.data.run.id, ['waiting_for_user']);
  let waitingDetail = await api(`/api/runs/${waiting.data.run.id}/collaboration`);
  const question = waitingDetail.data.decisions.find((item) => item.kind === 'agent_question' && item.status === 'pending');
  assert.ok(question);
  if (completionEngine) assert.ok(waitingDetail.data.durableHolds.some((item) => item.condition.kind === 'user_decision'
    && item.condition.decisionId === question.id && item.status === 'open'), '用户问题必须形成持久化 Hold');
  const answered = await api(`/api/collaboration/decisions/${question.id}/resolve`, 'POST', { action: 'answer', message: '请按兼容方案继续' });
  assert.equal(answered.status, 200, JSON.stringify(answered.data));
  await waitRun(waiting.data.run.id, ['completed']);
  waitingDetail = await api(`/api/runs/${waiting.data.run.id}/collaboration`);
  assertShadowComparisons(waitingDetail.data, 'hold/wake');
  assert.equal(waitingDetail.data.decisions.find((item) => item.id === question.id).status, 'accepted');
  assert.ok(waitingDetail.data.dispatches.some((item) => item.kind === 'resume'));
  if (completionEngine) {
    assert.ok(waitingDetail.data.durableHolds.some((item) => item.condition.kind === 'user_decision'
      && item.condition.decisionId === question.id && item.status === 'resumed'));
    assert.ok(waitingDetail.data.wakeEvents.some((item) => item.kind === 'user_decision' && item.sourceKey === question.id));
  }

  if (admissionProfile === 'execute' || admissionProfile === 'atomic_compat') {
    const timerWaiting = await api(`/api/conversations/${multi.data.conversation.id}/messages`, 'POST', {
      body: '[collab:hold-timer:1] 一秒后自动继续', recipientIds: ['planner'], clientMessageId: crypto.randomUUID(),
    });
    assert.equal(timerWaiting.status, 202, JSON.stringify(timerWaiting.data));
    const timerTerminal = await waitRun(timerWaiting.data.run.id, ['completed', 'failed'], 12_000);
    const timerDetail = await api(`/api/runs/${timerWaiting.data.run.id}/collaboration`);
    assert.equal(timerTerminal.status, 'completed', JSON.stringify({ dispatches: timerDetail.data.dispatches,
      attempts: timerDetail.data.attempts, holds: timerDetail.data.durableHolds,
      candidates: timerDetail.data.completionCandidates }, null, 2));
    assert.ok(timerDetail.data.durableHolds.some((item) => item.condition.kind === 'timer' && item.status === 'resumed'),
      'Agent timer Hold 必须经公共恢复路径结案');
    assert.ok(timerDetail.data.wakeEvents.some((item) => item.kind === 'timer'));
    assert.ok(timerDetail.data.dispatches.some((item) => item.kind === 'resume'));
    assert.ok(['hold', 'wake'].every((kind) => timerDetail.data.actionCommands.some((item) => item.kind === kind)),
      'timer Hold 与恢复必须经过公共动作命令');

    const consultAny = await api('/api/conversations', 'POST', {
      goal: '[collab:ask-any:coder,reviewer] 请返回首个通过验收的独立意见', mode: 'collaboration',
      agentIds: ['planner', 'coder', 'reviewer'], recipientIds: ['planner'],
    });
    assert.equal(consultAny.status, 201, JSON.stringify(consultAny.data));
    await waitRun(consultAny.data.run.id, ['waiting_for_user']);
    const consultAnyPaused = await api(`/api/runs/${consultAny.data.run.id}/collaboration`);
    const consultAnyBudget = consultAnyPaused.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
    assert.ok(consultAnyBudget);
    await api(`/api/collaboration/decisions/${consultAnyBudget.id}/resolve`, 'POST', { action: 'increase_budget', increasePercent: 200 });
    const consultAnyTerminal = await waitRun(consultAny.data.run.id, ['completed', 'failed'], 12_000);
    const consultAnyDetail = await api(`/api/runs/${consultAny.data.run.id}/collaboration`);
    assert.equal(consultAnyTerminal.status, 'completed', JSON.stringify({
      dispatches: consultAnyDetail.data.dispatches, attempts: consultAnyDetail.data.attempts,
      batches: consultAnyDetail.data.batches, obligations: consultAnyDetail.data.successorObligations,
      candidates: consultAnyDetail.data.completionCandidates,
      evaluations: consultAnyDetail.data.completionEvaluations,
    }, null, 2));
    const anyBatch = consultAnyDetail.data.batches[0];
    assert.equal(anyBatch.joinPolicy, 'any');
    assert.equal(anyBatch.status, 'completed');
    assert.equal(anyBatch.generation, 1);
    assert.ok(anyBatch.winnerDispatchId && anyBatch.settledAt);
    const anyFanout = consultAnyDetail.data.dispatches.filter((item) => item.kind === 'fanout');
    assert.equal(anyFanout.filter((item) => item.status === 'completed').length, 1);
    assert.equal(anyFanout.filter((item) => item.status === 'cancelled'
      && item.error?.startsWith('CONSULT_ANY_NOT_SELECTED:')).length, 1);
    assert.equal(consultAnyDetail.data.dispatches.filter((item) => item.kind === 'aggregate').length, 1,
      'consult(any) 父级只能生成一个 aggregate');
    assert.ok(consultAnyDetail.data.actionCommands.some((item) => item.kind === 'consult_any'));
    assert.equal(consultAnyDetail.data.completionCandidates.filter((item) => item.status === 'accepted'
      && anyFanout.some((dispatch) => dispatch.id === consultAnyDetail.data.attempts
        .find((attempt) => attempt.id === item.attemptId)?.dispatchId)).length, 1,
    '只有首个通过 SubjectCompletion 的 fanout 候选可以成为 winner');
    const anyGroup = consultAnyDetail.data.successorObligations.find((item) => item.required
      && item.kind === 'consult_result' && item.payload?.join === 'any');
    assert.equal(anyGroup?.status, 'satisfied');
    const consultAnyRoom = await api(`/api/conversations/${consultAny.data.conversation.id}`);
    assert.equal(consultAnyRoom.data.messages.filter((message) => message.runId === consultAny.data.run.id
      && message.messageType === 'collaboration_contribution').length, 1,
    '未胜出分支不能发布迟到贡献');
    assert.equal(consultAnyRoom.data.messages.filter((message) => message.runId === consultAny.data.run.id
      && message.messageType === 'collaboration_result').length, 1);
  }

  const budgetRun = await api(`/api/conversations/${multi.data.conversation.id}/messages`, 'POST', {
    body: '[collab:ask:coder,reviewer] 请并行检查', recipientIds: ['planner'], clientMessageId: crypto.randomUUID(),
  });
  await waitRun(budgetRun.data.run.id, ['waiting_for_user']);
  let budgetDetail = await api(`/api/runs/${budgetRun.data.run.id}/collaboration`);
  const budgetDecision = budgetDetail.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
  assert.ok(budgetDecision);
  const extended = await api(`/api/collaboration/decisions/${budgetDecision.id}/resolve`, 'POST', { action: 'increase_budget', increasePercent: 200 });
  assert.equal(extended.status, 200, JSON.stringify(extended.data));
  await waitRun(budgetRun.data.run.id, ['completed'], 12_000);
  budgetDetail = await api(`/api/runs/${budgetRun.data.run.id}/collaboration`);
  assert.equal(budgetDetail.data.budget.revisions.length, 1);
  assert.ok(budgetDetail.data.dispatches.some((item) => item.kind === 'aggregate'));
  assert.equal(budgetDetail.data.batches[0].status, 'completed');

  const terminateRun = await api(`/api/conversations/${multi.data.conversation.id}/messages`, 'POST', {
    body: '[collab:ask:coder,reviewer] 这轮在预算边界终止', recipientIds: ['planner'], clientMessageId: crypto.randomUUID(),
  });
  await waitRun(terminateRun.data.run.id, ['waiting_for_user']);
  const terminateDetail = await api(`/api/runs/${terminateRun.data.run.id}/collaboration`);
  const terminateDecision = terminateDetail.data.decisions.find((item) => item.kind === 'budget_exhausted' && item.status === 'pending');
  assert.ok(terminateDecision);
  const terminated = await api(`/api/collaboration/decisions/${terminateDecision.id}/resolve`, 'POST', { action: 'terminate_at_budget' });
  assert.equal(terminated.status, 200, JSON.stringify(terminated.data));
  await waitRun(terminateRun.data.run.id, ['completed']);

  const proposalRun = await api(`/api/conversations/${multi.data.conversation.id}/messages`, 'POST', {
    body: '[collab:propose:coder] 实施正式功能', recipientIds: ['planner'], clientMessageId: crypto.randomUUID(),
  });
  await waitRun(proposalRun.data.run.id, ['waiting_for_user']);
  const proposalDetail = await api(`/api/runs/${proposalRun.data.run.id}/collaboration`);
  const proposal = proposalDetail.data.decisions.find((item) => item.kind === 'supervisor_task_proposal' && item.status === 'pending');
  assert.ok(proposal);
  const approved = await api(`/api/collaboration/decisions/${proposal.id}/resolve`, 'POST', {
    action: 'approve_task', supervisorId: 'planner', agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.linkedRun.mode, 'supervisor');
  await waitRun(approved.data.linkedRun.id, ['completed', 'failed'], 12_000);
  const repeated = await api(`/api/collaboration/decisions/${proposal.id}/resolve`, 'POST', {
    action: 'approve_task', supervisorId: 'planner', agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer',
  });
  assert.equal(repeated.data.linkedRun.id, approved.data.linkedRun.id);

  const stoppable = await api('/api/conversations', 'POST', {
    goal: '[collab:wait] 等待后停止', mode: 'collaboration', agentIds: ['planner'], recipientIds: ['planner'],
  });
  await waitRun(stoppable.data.run.id, ['waiting_for_user']);
  const stopped = await api(`/api/collaboration/runs/${stoppable.data.run.id}/stop`, 'POST');
  assert.equal(stopped.data.status, 'cancelled');
  const stoppedDetail = await api(`/api/runs/${stoppable.data.run.id}/collaboration`);
  assertShadowComparisons(stoppedDetail.data, 'stop');
  assert.ok(stoppedDetail.data.dispatches.every((item) => !['queued', 'running'].includes(item.status)));
  if (completionEngine) assert.ok(stoppedDetail.data.durableHolds.every((item) => item.status === 'cancelled'),
    'Stop 必须关闭全部开放 Hold');

  console.log('collaboration verification passed');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await childExit;
  await rm(root, { recursive: true, force: true });
}
