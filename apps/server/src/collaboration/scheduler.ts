import { randomUUID } from 'node:crypto';
import type { AgentDefinition, CollaborationControlAction, CollaborationDispatch, Conversation, Run } from '@agent-gand/shared';
import { config } from '../config.ts';
import { listByConversation, listByRun, post, postSystem, updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { endSpan, finishRun, getRun, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from '../orchestration/agentStep.ts';
import { COLLABORATION_CONTROL_TOOLS, parseControlCall } from './controlTools.ts';
import {
  activeConversationState,
  budgetExceeded,
  budgetSnapshot,
  claimNextDispatch,
  createBatch,
  createDecision,
  createDispatch,
  finishAttempt,
  getBatch,
  expireBatch,
  getDispatch,
  hasOpenDispatches,
  hasPendingDecision,
  listBatches,
  listConversationDispatches,
  listDecisions,
  listDispatches,
  updateBatch,
  listRecoverableConversationIds,
  listRunningCollaborationRunIds,
  listOpenBatches,
} from './store.ts';
import { emit } from '../messaging/bus.ts';

const leaseOwner = `server:${process.pid}:${randomUUID()}`;
const activeConversations = new Set<string>();
const dirtyConversations = new Set<string>();

export interface CollaborationAdmissionInput {
  recipientIds?: string[];
  replyTo?: string | null;
  taskId?: string | null;
  clientMessageId?: string;
}

function emitScheduler(conversationId: string): void {
  const state = activeConversationState(conversationId);
  emit({ type: 'collaboration.scheduler.updated', conversationId, ...state });
}

function initialTargets(run: Run, conversation: Conversation, input: CollaborationAdmissionInput, sourceMessageId: string): string[] {
  if (input.recipientIds?.length) return [...new Set(input.recipientIds)].slice(0, config.collaboration.maxTargets);
  if (input.replyTo) {
    const replied = listByConversation(conversation.id).find((message) => message.id === input.replyTo);
    if (replied?.kind === 'agent' && run.agentIds.includes(replied.from)) return [replied.from];
  }
  const recent = [...listByConversation(conversation.id)].reverse().find((message) =>
    message.id !== sourceMessageId && message.kind === 'agent' && run.agentIds.includes(message.from));
  return recent ? [recent.from] : run.agentIds.slice(0, 1);
}

export function admitCollaborationRun(run: Run, conversation: Conversation, input: CollaborationAdmissionInput = {}): void {
  let userMessage = listByRun(run.id).find((message) => message.kind === 'user');
  if (!userMessage) {
    userMessage = post({ runId: run.id, from: 'user', to: input.recipientIds?.join(',') || 'all', kind: 'user', body: run.goal,
      replyTo: input.replyTo ?? null, taskId: input.taskId ?? null, clientMessageId: input.clientMessageId, deliveryStatus: 'processing' });
  }
  const targets = initialTargets(run, conversation, input, userMessage.id);
  if (targets.length === 0) {
    postSystem(run.id, 'user', '当前聊天室没有可用 Agent');
    finishRun(run.id, 'failed');
    updateRunUserMessageStatus(run.id, 'failed');
    return;
  }
  setRunStatus(run.id, 'running');
  for (const target of targets) createDispatch({
    runId: run.id, conversationId: conversation.id, sourceMessageId: userMessage.id,
    kind: 'initial', from: 'user', targetAgentId: target, reason: '用户发起协作', depth: 0,
    idempotencyKey: `initial:${userMessage.id}:${target}`,
  });
  updateRunUserMessageStatus(run.id, 'processing');
  kickCollaboration(conversation.id);
}

export function kickCollaboration(conversationId: string): void {
  if (activeConversations.has(conversationId)) { dirtyConversations.add(conversationId); return; }
  activeConversations.add(conversationId);
  queueMicrotask(() => void drain(conversationId));
}

async function drain(conversationId: string): Promise<void> {
  try {
    do {
      dirtyConversations.delete(conversationId);
      await pauseExceededRuns(conversationId);
      for (;;) {
        const claimed = claimNextDispatch(conversationId, leaseOwner);
        if (!claimed) break;
        void executeDispatch(claimed.dispatch, claimed.attempt.id).finally(() => kickCollaboration(conversationId));
      }
      emitScheduler(conversationId);
    } while (dirtyConversations.has(conversationId));
  } finally {
    activeConversations.delete(conversationId);
    if (dirtyConversations.delete(conversationId)) kickCollaboration(conversationId);
  }
}

async function pauseExceededRuns(conversationId: string): Promise<void> {
  const runIds = [...new Set(listConversationDispatches(conversationId).filter((d) => d.status === 'queued').map((d) => d.runId))];
  for (const runId of runIds) {
    const item = getRun(runId);
    if (!item || item.status !== 'running' || hasPendingDecision(runId)) continue;
    const dimension = budgetExceeded(runId);
    if (!dimension) continue;
    const snapshot = budgetSnapshot(runId);
    const message = post({ runId, from: 'system', to: 'user', kind: 'system', messageType: 'collaboration_wait_user',
      body: `协作预算已达到上限（${dimension}）。请选择按当前结果终止，或按比例增加预算后继续。`,
      payload: { decisionKind: 'budget_exhausted', dimension, budget: snapshot } });
    createDecision({ runId, conversationId, idempotencyKey: `budget:${runId}:${snapshot.revisions.length}`,
      kind: 'budget_exhausted', promptMessageId: message.id, payload: { dimension, budget: snapshot } });
    setRunStatus(runId, 'waiting_for_user');
  }
}

function buildContext(run: Run, dispatch: CollaborationDispatch, agent: AgentDefinition): string {
  const messages = listByConversation(run.conversationId).filter((message) => message.seq > 0);
  const source = messages.find((message) => message.id === dispatch.sourceMessageId);
  const transcript = messages.filter((message) => message.id !== dispatch.sourceMessageId).slice(-19)
    .map((message) => `[${message.from} → ${message.to}] ${message.body.replace(/\[(?:collab|tool):[^\]]+\]/g, '').slice(0, 2_000)}`).join('\n\n');
  const members = listRunAgentSnapshots(run.id).map((item) => `${item.id}（${item.name}）：${item.description ?? item.capabilities.join('/')}`).join('\n');
  const currentItem = source?.body ?? run.goal;
  const mockContext = JSON.stringify({ agentId: agent.id, agentName: agent.name, memberIds: run.agentIds, message: currentItem });
  return `你正在 agent-gand 的自由协作聊天室中工作。\n\n成员：\n${members}\n\n当前执行信息：\n- 发送者：${dispatch.from}\n- 原因：${dispatch.reason ?? '未说明'}\n- 深度：${dispatch.depth}/${config.collaboration.maxDepth}\n\n规则：\n- 可以直接回答并结束；如确需队友行动，调用一个协作控制工具。\n- 直接回答“当前事项”，不要把本段调度说明复述给用户。\n- 不要在正文中伪造工具调用、Run ID 或路由状态。\n- 不要无理由转交或在两位 Agent 间来回推诿。\n- 正式实施任务可用 agent.propose_supervisor_task 提议，必须等待用户批准。\n\n最近聊天室消息：\n${transcript || '（暂无）'}\n\n当前事项：\n${currentItem}\n\n请处理发给 ${agent.name} 的当前事项。\n__AGENT_GAND_CURRENT__=${mockContext}`;
}

async function executeDispatch(dispatch: CollaborationDispatch, attemptId: string): Promise<void> {
  const run = getRun(dispatch.runId);
  const agent = listRunAgentSnapshots(dispatch.runId).find((item) => item.id === dispatch.targetAgentId);
  if (!run || !agent) {
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', error: 'Run 或 Agent 快照不存在' });
    if (run) finalizeRun(run.id);
    return;
  }
  const span = startSpan(run.id, { spanKind: 'agent', name: `agent:${agent.id}`, input: JSON.stringify({ dispatchId: dispatch.id, sourceMessageId: dispatch.sourceMessageId, depth: dispatch.depth, budget: budgetSnapshot(run.id) }),
    attributes: { 'agent.id': agent.id, 'agent.role': 'collaborator', 'collaboration.dispatch.id': dispatch.id,
      ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  try {
    const turn = await runAgentTurn({ run, agent, parentSpanId: span.id, agentId: agent.id, attemptId,
      executionScopeId: `collaboration:${dispatch.id}`,
      messages: [{ role: 'system', content: agent.systemPrompt }, { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE }, { role: 'user', content: buildContext(run, dispatch, agent) }],
      controlTools: COLLABORATION_CONTROL_TOOLS,
      handleControlCalls: (calls) => parseControlCall(calls[0]!, run.agentIds, agent.id),
    });
    if (getDispatch(dispatch.id)?.status === 'cancelled') {
      endSpan(span, { output: '用户已停止该 Agent，本次结果已丢弃', status: 'error' });
      finalizeRun(run.id);
      return;
    }
    if (turn.emptyResponse) throw new Error('Agent 未生成有效回复或控制动作');
    const action = turn.controlAction ?? { type: 'finish' } satisfies CollaborationControlAction;
    const outputMessageId = await applyAction(run, dispatch, agent, turn.content, action);
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'completed', output: turn.content, action, outputMessageId });
    endSpan(span, { output: JSON.stringify({ dispatchId: dispatch.id, outputMessageId, controlAction: action }), status: 'ok' });
    if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
    finalizeRun(run.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', error: message });
    endSpan(span, { output: message, status: 'error' });
    postSystem(run.id, agent.id, `协作执行失败：${message}`);
    if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
    finalizeRun(run.id);
  }
}

function requestedDebateRounds(run: Run, routeText = ''): number | null {
  const currentRunText = listByRun(run.id).map((message) => message.body).join('\n');
  const text = `${run.goal}\n${routeText}\n${currentRunText}`;
  if (!text.includes('辩论')) return null;
  const rounds = [...text.matchAll(/(\d{1,2})\s*轮/gu)]
    .map((match) => Number.parseInt(match[1] ?? '', 10))
    .find((value) => Number.isInteger(value) && value >= 2 && value <= 20);
  return rounds ?? null;
}

function guardRoute(run: Run, dispatch: CollaborationDispatch, targets: string[], routeText = ''): boolean {
  const debateRounds = requestedDebateRounds(run, routeText);
  const depthLimit = debateRounds === null ? config.collaboration.maxDepth : Math.max(config.collaboration.maxDepth, debateRounds * 2 + 4);
  if (dispatch.depth + 1 > depthLimit) throw new Error(`已达到最大路由深度 ${depthLimit}`);
  if (targets.length === 0 || targets.length > config.collaboration.maxTargets) throw new Error(`一次最多路由给 ${config.collaboration.maxTargets} 位 Agent`);
  const budget = budgetSnapshot(run.id);
  if (budget.dispatches.used + targets.length > budget.dispatches.currentLimit) {
    const message = post({ runId: run.id, from: 'system', to: 'user', kind: 'system', messageType: 'collaboration_wait_user',
      body: '创建后续路由会超过 Dispatch 预算。请选择按当前结果终止，或增加预算后继续。',
      payload: { decisionKind: 'budget_exhausted', dimension: 'dispatches', budget } });
    createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
      idempotencyKey: `budget-route:${dispatch.id}`, kind: 'budget_exhausted', promptMessageId: message.id,
      payload: { dimension: 'dispatches', budget, agentId: dispatch.targetAgentId, resumeSourceMessageId: dispatch.sourceMessageId, parentDispatchId: dispatch.id, depth: dispatch.depth } });
    setRunStatus(run.id, 'waiting_for_user');
    return false;
  }
  return true;
}

function pingPongCount(runId: string, from: string, to: string): number {
  const handoffs = listDispatches(runId).filter((item) => item.kind === 'handoff' && item.status !== 'cancelled').slice(-config.collaboration.pingPongBlock);
  let count = 0; let expectedFrom = from; let expectedTo = to;
  for (const item of handoffs.reverse()) {
    if (item.from !== expectedTo || item.targetAgentId !== expectedFrom) break;
    count += 1; [expectedFrom, expectedTo] = [expectedTo, expectedFrom];
  }
  return count + 1;
}

async function applyAction(run: Run, dispatch: CollaborationDispatch, agent: AgentDefinition, content: string, action: CollaborationControlAction): Promise<string | null> {
  if (action.type === 'finish') {
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_result',
      body: content.trim() || '已完成当前协作事项。', meta: { dispatchId: dispatch.id, routeFrom: dispatch.from } });
    return message.id;
  }
  if (action.type === 'handoff') {
    if (!guardRoute(run, dispatch, [action.targetAgentId], action.message)) return null;
    const streak = pingPongCount(run.id, agent.id, action.targetAgentId);
    const debateRounds = requestedDebateRounds(run, action.message);
    const pingPongBlock = debateRounds === null ? config.collaboration.pingPongBlock : Math.max(config.collaboration.pingPongBlock, debateRounds * 2 + 3);
    const pingPongWarn = debateRounds === null ? config.collaboration.pingPongWarn : Math.max(config.collaboration.pingPongWarn, debateRounds * 2 + 1);
    if (streak >= pingPongBlock) throw new Error(`检测到 ${agent.id} 与 ${action.targetAgentId} 连续往返，已阻止继续交接`);
    if (streak >= pingPongWarn) postSystem(run.id, action.targetAgentId, '提示：已接近约定的辩论轮次，请完成收尾并交给评审者。');
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentId, kind: 'agent', messageType: 'collaboration_handoff',
      body: action.message, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: [action.targetAgentId], reason: action.reason } });
    createDispatch({ runId: run.id, conversationId: run.conversationId, sourceMessageId: message.id, parentDispatchId: dispatch.id,
      kind: 'handoff', from: agent.id, targetAgentId: action.targetAgentId, reason: action.reason, depth: dispatch.depth + 1,
      idempotencyKey: `handoff:${dispatch.id}:${action.targetAgentId}:${hashText(action.message)}` });
    return message.id;
  }
  if (action.type === 'ask_many') {
    if (!guardRoute(run, dispatch, action.targetAgentIds, action.question)) return null;
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentIds.join(','), kind: 'agent', messageType: 'collaboration_question',
      body: action.question, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: action.targetAgentIds, reason: action.reason } });
    const batch = createBatch({ runId: run.id, conversationId: run.conversationId, initiatorAgentId: agent.id,
      sourceDispatchId: dispatch.id, question: action.question, targetAgentIds: action.targetAgentIds });
    scheduleBatchTimeout(batch.id, batch.timeoutAt);
    for (const target of action.targetAgentIds) createDispatch({ runId: run.id, conversationId: run.conversationId,
      sourceMessageId: message.id, parentDispatchId: dispatch.id, batchId: batch.id, kind: 'fanout', from: agent.id,
      targetAgentId: target, reason: action.reason, depth: dispatch.depth + 1, idempotencyKey: `fanout:${batch.id}:${target}` });
    return message.id;
  }
  if (action.type === 'wait_user') {
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_wait_user',
      body: action.question, meta: { dispatchId: dispatch.id, reason: action.reason }, payload: { decisionKind: 'agent_question' } });
    createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
      idempotencyKey: `question:${dispatch.id}`, kind: 'agent_question', promptMessageId: message.id,
      payload: { question: action.question, reason: action.reason, agentId: agent.id } });
    setRunStatus(run.id, 'waiting_for_user');
    return message.id;
  }
  const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_task_proposal',
    body: `${action.title}\n\n${action.goal}`, meta: { dispatchId: dispatch.id, reason: action.reason },
    payload: { decisionKind: 'supervisor_task_proposal', proposal: action } });
  createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
    idempotencyKey: `proposal:${dispatch.id}`, kind: 'supervisor_task_proposal', promptMessageId: message.id, payload: { proposal: action, agentId: agent.id } });
  setRunStatus(run.id, 'waiting_for_user');
  return message.id;
}

function maybeCompleteBatch(batchId: string): void {
  const batch = getBatch(batchId);
  if (!batch || batch.resultDispatchId) return;
  const children = listDispatches(batch.runId).filter((item) => item.batchId === batch.id && item.kind === 'fanout');
  if (children.length === 0 || children.some((item) => item.status === 'queued' || item.status === 'running')) return;
  const run = getRun(batch.runId); if (!run) return;
  const results = children.map((item) => {
    const output = item.outputMessageId ? listByRun(run.id).find((message) => message.id === item.outputMessageId)?.body : null;
    return `${item.targetAgentId}（${item.status}）：${output ?? item.error ?? '无结果'}`;
  }).join('\n\n');
  const source = post({ runId: run.id, from: 'system', to: batch.initiatorAgentId, kind: 'system', messageType: 'collaboration_routing',
    body: `并行征询结果已汇总：\n\n${results}`, meta: { batchId: batch.id } });
  const result = createDispatch({ runId: run.id, conversationId: run.conversationId, sourceMessageId: source.id,
    parentDispatchId: batch.sourceDispatchId, batchId: batch.id, kind: 'aggregate', from: 'system', targetAgentId: batch.initiatorAgentId,
    reason: '并行征询结果回流', depth: Math.max(0, ...children.map((item) => item.depth)), idempotencyKey: `aggregate:${batch.id}` });
  updateBatch(batch.id, batch.status === 'timeout' ? 'timeout' : children.every((item) => item.status === 'completed') ? 'completed' : 'partial', result.id);
}

function scheduleBatchTimeout(batchId: string, timeoutAt: string): void {
  const timer = setTimeout(() => {
    const batch = expireBatch(batchId);
    if (!batch) return;
    maybeCompleteBatch(batchId);
    kickCollaboration(batch.conversationId);
  }, Math.max(0, new Date(timeoutAt).getTime() - Date.now()));
  timer.unref();
}

function finalizeRun(runId: string): void {
  const run = getRun(runId); if (!run || run.status === 'waiting_for_user' || run.status === 'awaiting_approval' || run.status === 'completed' || run.status === 'failed') return;
  if (hasOpenDispatches(runId) || hasPendingDecision(runId)) return;
  const dispatches = listDispatches(runId);
  const succeeded = dispatches.some((item) => item.status === 'completed');
  finishRun(runId, succeeded ? 'completed' : 'failed');
  try { updateRunUserMessageStatus(runId, succeeded ? 'responded' : 'failed'); } catch { /* legacy */ }
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function recoverCollaborationRuns(): void {
  for (const runId of listRunningCollaborationRunIds()) {
    if (hasPendingDecision(runId)) setRunStatus(runId, 'waiting_for_user');
    else finalizeRun(runId);
  }
  for (const conversationId of listRecoverableConversationIds()) kickCollaboration(conversationId);
  for (const batch of listOpenBatches()) scheduleBatchTimeout(batch.id, batch.timeoutAt);
}

export function resumeCollaborationConversation(conversationId: string): void { kickCollaboration(conversationId); }
export function settleCollaborationRun(runId: string): void {
  const item = getRun(runId); if (!item) return;
  finalizeRun(runId); kickCollaboration(item.conversationId);
}
