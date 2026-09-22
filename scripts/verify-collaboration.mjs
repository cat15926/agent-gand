import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  while (Date.now() < end) {
    const result = await api(`/api/runs/${runId}`);
    if (statuses.includes(result.data.run.status)) return result.data.run;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`等待 Run ${runId} 状态 ${statuses.join('/')} 超时\n${logs}`);
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
  assert.ok(handoffDetail.data.dispatches.every((item) => item.status === 'completed'));
  assert.ok(handoffDetail.data.attempts.every((item) => typeof item.inputContext === 'string' && item.inputContext.includes('当前执行信息')));
  const handoffRunDetail = await api(`/api/runs/${handoff.data.run.id}`);
  const traceEvents = handoffRunDetail.data.events;
  const collaborationRoot = traceEvents.find((event) => event.name === `collaboration:${handoff.data.run.id}`);
  assert.equal(collaborationRoot?.status, 'ok');
  const dispatchSpans = traceEvents.filter((event) => event.name.startsWith('dispatch:'));
  assert.equal(dispatchSpans.length, 2);
  assert.ok(dispatchSpans.every((event) => event.parentId === collaborationRoot.id));
  assert.ok(traceEvents.filter((event) => event.name.startsWith('control:')).every((event) => traceEvents.some((parent) => parent.id === event.parentId && parent.spanKind === 'agent')));

  const statusQuestion = await api('/api/conversations', 'POST', {
    goal: '你好，鸡腿，你现在状态如何？', mode: 'collaboration', agentIds: ['coder-jitui'], recipientIds: ['coder-jitui'],
  });
  assert.equal(statusQuestion.status, 201, JSON.stringify(statusQuestion.data));
  await waitRun(statusQuestion.data.run.id, ['completed']);
  const statusRoom = await api(`/api/conversations/${statusQuestion.data.conversation.id}`);
  const statusReply = statusRoom.data.messages.find((message) => message.kind === 'agent');
  assert.match(statusReply?.body ?? '', /鸡腿.*当前在线/u);
  assert.doesNotMatch(statusReply?.body ?? '', /你正在 agent-gand/u);

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
  assert.deepEqual(fanoutDetail.data.dispatches.map((item) => item.kind), ['initial', 'resume', 'fanout', 'fanout', 'aggregate']);
  assert.ok(fanoutDetail.data.attempts.filter((item) => fanoutDetail.data.dispatches.some((dispatch) => dispatch.id === item.dispatchId && dispatch.kind === 'fanout')).every((item) => item.output?.includes('请继续处理')));
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
  await waitRun(blockedRouting.data.run.id, ['completed'], 12_000);
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
  assert.ok(new Date(multiAttempts[0].startedAt).getTime() < new Date(multiAttempts[1].endedAt).getTime()
    && new Date(multiAttempts[1].startedAt).getTime() < new Date(multiAttempts[0].endedAt).getTime(), '不同 Agent 应并发执行');

  const room = await api(`/api/conversations/${multi.data.conversation.id}`);
  const lastAgent = [...room.data.messages].reverse().find((message) => message.kind === 'agent').from;
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
  const answered = await api(`/api/collaboration/decisions/${question.id}/resolve`, 'POST', { action: 'answer', message: '请按兼容方案继续' });
  assert.equal(answered.status, 200, JSON.stringify(answered.data));
  await waitRun(waiting.data.run.id, ['completed']);
  waitingDetail = await api(`/api/runs/${waiting.data.run.id}/collaboration`);
  assert.equal(waitingDetail.data.decisions.find((item) => item.id === question.id).status, 'accepted');
  assert.ok(waitingDetail.data.dispatches.some((item) => item.kind === 'resume'));

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
  assert.ok(stoppedDetail.data.dispatches.every((item) => !['queued', 'running'].includes(item.status)));

  console.log('collaboration verification passed');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await childExit;
  await rm(root, { recursive: true, force: true });
}
