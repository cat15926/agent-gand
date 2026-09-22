import { randomUUID } from 'node:crypto';
import type { AgentDefinition, CollaborationControlAction, CollaborationDispatch, Conversation, Run } from '@agent-gand/shared';
import { config } from '../config.ts';
import { afterCommit, tx } from '../db/database.ts';
import { listByConversation, listByRun, post, postSystem, updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { endSpan, finishRun, getRun, listEvents, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
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
  createDispatchDetailed,
  finishAttempt,
  getBatch,
  getCompletedDispatchOutput,
  expireBatch,
  getDispatch,
  hasOpenDispatches,
  hasPendingDecision,
  listConversationDispatches,
  listDispatches,
  setAttemptInputContext,
  updateBatch,
  listRecoverableConversationIds,
  listRunningCollaborationRunIds,
  listOpenBatches,
} from './store.ts';
import { emit } from '../messaging/bus.ts';

const leaseOwner = `server:${process.pid}:${randomUUID()}`;
const activeConversations = new Set<string>();
const dirtyConversations = new Set<string>();
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class CollaborationGuardError extends Error {
  constructor(message: string, readonly code: 'depth' | 'targets' | 'ping_pong') { super(message); }
}

function collaborationSpan(runId: string) {
  return listEvents(runId).find((event) => event.spanKind === 'orchestration' && event.name === `collaboration:${runId}`);
}

function ensureCollaborationSpan(run: Run) {
  return collaborationSpan(run.id) ?? startSpan(run.id, {
    spanKind: 'orchestration', name: `collaboration:${run.id}`, input: run.goal,
    attributes: { 'orchestration.phase': 'collaboration.run' },
  });
}

export function closeCollaborationTrace(runId: string, outcome: 'completed' | 'failed' | 'cancelled'): void {
  const root = collaborationSpan(runId);
  if (root?.status === 'running') endSpan(root, { output: outcome, status: outcome === 'completed' ? 'ok' : 'error' });
}

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
    message.id !== sourceMessageId && message.kind === 'agent' && message.messageType !== 'collaboration_contribution' && run.agentIds.includes(message.from));
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
  ensureCollaborationSpan(run);
  for (const target of targets) createDispatch({
    runId: run.id, conversationId: conversation.id, sourceMessageId: userMessage.id,
    kind: 'initial', from: 'user', targetAgentId: target, reason: '用户发起协作', depth: 0,
    idempotencyKey: `initial:${userMessage.id}:${target}`, dedupeText: userMessage.body,
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
  // fanout 发言已独立展示给用户；模型上下文仍只从 batch 聚合消息读取它，避免重复注入全文。
  const transcript = messages.filter((message) => message.id !== dispatch.sourceMessageId && message.messageType !== 'collaboration_contribution').slice(-19)
    .map((message) => `[${message.from} → ${message.to}] ${message.body.replace(/\[(?:collab|tool):[^\]]+\]/g, '').slice(0, 2_000)}`).join('\n\n');
  const members = listRunAgentSnapshots(run.id).map((item) => `${item.id}（${item.name}）：${item.description ?? item.capabilities.join('/')}`).join('\n');
  const currentItem = source?.body ?? run.goal;
  const fanoutRule = dispatch.kind === 'fanout'
    ? '\n- 这是并行征询的内部子任务。直接给出结果即可；结果会由系统汇总，不要把结果再次交接回发送者，也不要把它当作面向用户的最终报告。'
    : '';
  const mockContext = JSON.stringify({ agentId: agent.id, agentName: agent.name, memberIds: run.agentIds, message: currentItem });
  return `你正在 agent-gand 的自由协作聊天室中工作。\n\n成员：\n${members}\n\n当前执行信息：\n- 发送者：${dispatch.from}\n- 原因：${dispatch.reason ?? '未说明'}\n- 深度：${dispatch.depth}/${config.collaboration.maxDepth}\n\n规则：\n- 可以直接回答并结束；如确需队友行动，调用一个协作控制工具。\n- 直接回答“当前事项”，不要把本段调度说明复述给用户。\n- 不要在正文中伪造工具调用、Run ID 或路由状态。\n- 不要无理由转交或在两位 Agent 间来回推诿。\n- 正式实施任务可用 agent.propose_supervisor_task 提议，必须等待用户批准。${fanoutRule}\n\n最近聊天室消息：\n${transcript || '（暂无）'}\n\n当前事项：\n${currentItem}\n\n请处理发给 ${agent.name} 的当前事项。\n__AGENT_GAND_CURRENT__=${mockContext}`;
}

function terminalRunStatus(status: Run['status']): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

function internalFanoutOutput(dispatch: CollaborationDispatch, content: string, action: CollaborationControlAction): string | null {
  if (dispatch.kind !== 'fanout') return null;
  if (action.type === 'finish') return content.trim() || '已完成并行征询子任务。';
  if (action.type !== 'handoff' || !dispatch.batchId) return null;
  const batch = getBatch(dispatch.batchId);
  if (batch?.initiatorAgentId !== action.targetAgentId) return null;
  return action.message.trim();
}

interface ActionApplicationResult {
  outputMessageId: string | null;
  childDispatchIds: string[];
  batchId: string | null;
  decisionId: string | null;
  deduplicatedTo: string | null;
}

const emptyActionResult = (): ActionApplicationResult => ({
  outputMessageId: null, childDispatchIds: [], batchId: null, decisionId: null, deduplicatedTo: null,
});

async function executeDispatch(dispatch: CollaborationDispatch, attemptId: string): Promise<void> {
  const run = getRun(dispatch.runId);
  const agent = listRunAgentSnapshots(dispatch.runId).find((item) => item.id === dispatch.targetAgentId);
  if (!run || !agent) {
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', error: 'Run 或 Agent 快照不存在' });
    if (run) finalizeRun(run.id);
    return;
  }
  if (terminalRunStatus(run.status)) {
    finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'cancelled', error: `Run 已进入终态：${run.status}` });
    return;
  }
  const inputContext = buildContext(run, dispatch, agent);
  setAttemptInputContext(attemptId, inputContext);
  const rootSpan = ensureCollaborationSpan(run);
  const dispatchSpan = startSpan(run.id, { parentId: rootSpan.id, spanKind: 'orchestration', name: `dispatch:${dispatch.id}`,
    input: JSON.stringify({ dispatchId: dispatch.id, sourceMessageId: dispatch.sourceMessageId, parentDispatchId: dispatch.parentDispatchId, targetAgentId: agent.id, depth: dispatch.depth, budget: budgetSnapshot(run.id) }),
    attributes: { 'agent.id': agent.id, 'collaboration.dispatch.id': dispatch.id, ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  const agentSpan = startSpan(run.id, { parentId: dispatchSpan.id, spanKind: 'agent', name: `agent:${agent.id}`, input: JSON.stringify({ dispatchId: dispatch.id, sourceMessageId: dispatch.sourceMessageId, depth: dispatch.depth, budget: budgetSnapshot(run.id) }),
    attributes: { 'agent.id': agent.id, 'agent.role': 'collaborator', 'collaboration.dispatch.id': dispatch.id,
      ...(dispatch.batchId ? { 'collaboration.batch.id': dispatch.batchId } : {}), 'orchestration.phase': 'collaboration.dispatch' } });
  let controlSpan: ReturnType<typeof startSpan> | null = null;
  try {
    const turn = await runAgentTurn({ run, agent, parentSpanId: agentSpan.id, agentId: agent.id, attemptId,
      executionScopeId: `collaboration:${dispatch.id}`,
      messages: [{ role: 'system', content: agent.systemPrompt }, { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE }, { role: 'user', content: inputContext }],
      controlTools: COLLABORATION_CONTROL_TOOLS,
      handleControlCalls: (calls) => parseControlCall(calls[0]!, run.agentIds, agent.id),
    });
    if (getDispatch(dispatch.id)?.status === 'cancelled') {
      endSpan(agentSpan, { output: '用户已停止该 Agent，本次结果已丢弃', status: 'error' });
      endSpan(dispatchSpan, { output: 'cancelled', status: 'error' });
      finalizeRun(run.id);
      return;
    }
    const currentRun = getRun(run.id);
    if (!currentRun || terminalRunStatus(currentRun.status)) {
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'cancelled', error: `Run 已进入终态：${currentRun?.status ?? 'missing'}` });
      endSpan(agentSpan, { output: 'Run 已结束，本次迟到结果已丢弃', status: 'error' });
      endSpan(dispatchSpan, { output: 'late_result_cancelled', status: 'error' });
      return;
    }
    if (turn.emptyResponse) throw new Error('Agent 未生成有效回复或控制动作');
    const action = turn.controlAction ?? { type: 'finish' } satisfies CollaborationControlAction;
    controlSpan = startSpan(run.id, { parentId: agentSpan.id, spanKind: 'orchestration', name: `control:${action.type}`,
      input: JSON.stringify(action), attributes: { 'agent.id': agent.id, 'collaboration.dispatch.id': dispatch.id, 'orchestration.phase': 'collaboration.control' } });
    const fanoutOutput = internalFanoutOutput(dispatch, turn.content, action);
    let applied = emptyActionResult();
    const output = fanoutOutput ?? turn.content;
    tx(() => {
      if (fanoutOutput !== null) {
        // 辩手原文作为可恢复的发言保留在聊天室，但不是面向用户的最终报告。
        // 稳定 clientMessageId 使重试或重连不会复制同一 dispatch 的发言。
        const contribution = post({
          runId: run.id, from: agent.id, to: dispatch.from, kind: 'agent', messageType: 'collaboration_contribution',
          body: output, replyTo: dispatch.sourceMessageId,
          meta: { dispatchId: dispatch.id, batchId: dispatch.batchId, attemptId },
          clientMessageId: `collaboration:fanout:${dispatch.id}:contribution`,
        });
        applied.outputMessageId = contribution.id;
      } else applied = applyAction(run, dispatch, agent, turn.content, action);
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'completed', output, action,
        deduplicatedTo: applied.deduplicatedTo, outputMessageId: applied.outputMessageId });
      if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
      finalizeRun(run.id);
    });
    endSpan(controlSpan, { output: JSON.stringify(applied), status: 'ok', attributes: {
      ...(applied.deduplicatedTo ? { 'collaboration.deduplicated_to': applied.deduplicatedTo } : {}),
    } });
    endSpan(agentSpan, { output: JSON.stringify({ dispatchId: dispatch.id, outputMessageId: applied.outputMessageId, controlAction: action }), status: 'ok' });
    endSpan(dispatchSpan, { output: JSON.stringify(applied), status: 'ok' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blocked = err instanceof CollaborationGuardError;
    tx(() => {
      finishAttempt({ attemptId, dispatchId: dispatch.id, status: 'failed', dispatchStatus: blocked ? 'blocked' : 'failed', error: message });
      postSystem(run.id, agent.id, `${blocked ? '协作路由已阻断' : '协作执行失败'}：${message}`);
      if (dispatch.batchId) maybeCompleteBatch(dispatch.batchId);
      finalizeRun(run.id);
    });
    if (controlSpan) endSpan(controlSpan, { output: message, status: 'error', attributes: blocked ? { 'collaboration.guard': err.code } : {} });
    endSpan(agentSpan, { output: message, status: 'error' });
    endSpan(dispatchSpan, { output: message, status: 'error', attributes: blocked ? { 'collaboration.guard': err.code } : {} });
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
  if (dispatch.depth + 1 > depthLimit) throw new CollaborationGuardError(`已达到最大路由深度 ${depthLimit}`, 'depth');
  if (targets.length === 0 || targets.length > config.collaboration.maxTargets) throw new CollaborationGuardError(`一次最多路由给 ${config.collaboration.maxTargets} 位 Agent`, 'targets');
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

function applyAction(run: Run, dispatch: CollaborationDispatch, agent: AgentDefinition, content: string, action: CollaborationControlAction): ActionApplicationResult {
  if (action.type === 'finish') {
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_result',
      body: content.trim() || '已完成当前协作事项。', meta: { dispatchId: dispatch.id, routeFrom: dispatch.from } });
    return { ...emptyActionResult(), outputMessageId: message.id };
  }
  if (action.type === 'handoff') {
    if (!guardRoute(run, dispatch, [action.targetAgentId], action.message)) return emptyActionResult();
    const streak = pingPongCount(run.id, agent.id, action.targetAgentId);
    const debateRounds = requestedDebateRounds(run, action.message);
    const pingPongBlock = debateRounds === null ? config.collaboration.pingPongBlock : Math.max(config.collaboration.pingPongBlock, debateRounds * 2 + 3);
    const pingPongWarn = debateRounds === null ? config.collaboration.pingPongWarn : Math.max(config.collaboration.pingPongWarn, debateRounds * 2 + 1);
    if (streak >= pingPongBlock) throw new CollaborationGuardError(`检测到 ${agent.id} 与 ${action.targetAgentId} 连续往返，已阻止继续交接`, 'ping_pong');
    if (streak >= pingPongWarn) postSystem(run.id, action.targetAgentId, '提示：检测到多次连续交接，请确认是否已有足够信息完成当前事项。');
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentId, kind: 'agent', messageType: 'collaboration_handoff',
      body: action.message, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: [action.targetAgentId], reason: action.reason } });
    const created = createDispatchDetailed({ runId: run.id, conversationId: run.conversationId, sourceMessageId: message.id, parentDispatchId: dispatch.id,
      kind: 'handoff', from: agent.id, targetAgentId: action.targetAgentId, reason: action.reason, depth: dispatch.depth + 1,
      idempotencyKey: `handoff:${dispatch.id}:${action.targetAgentId}:${hashText(action.message)}`, dedupeText: action.message });
    return { ...emptyActionResult(), outputMessageId: message.id, childDispatchIds: [created.dispatch.id], deduplicatedTo: created.deduplicatedTo };
  }
  if (action.type === 'ask_many') {
    if (!guardRoute(run, dispatch, action.targetAgentIds, action.question)) return emptyActionResult();
    const message = post({ runId: run.id, from: agent.id, to: action.targetAgentIds.join(','), kind: 'agent', messageType: 'collaboration_question',
      body: action.question, meta: { dispatchId: dispatch.id, routeFrom: agent.id, routeTo: action.targetAgentIds, reason: action.reason } });
    const batch = createBatch({ runId: run.id, conversationId: run.conversationId, initiatorAgentId: agent.id,
      sourceDispatchId: dispatch.id, question: action.question, targetAgentIds: action.targetAgentIds });
    afterCommit(() => scheduleBatchTimeout(batch.id, batch.timeoutAt));
    const children = action.targetAgentIds.map((target) => createDispatchDetailed({ runId: run.id, conversationId: run.conversationId,
      sourceMessageId: message.id, parentDispatchId: dispatch.id, batchId: batch.id, kind: 'fanout', from: agent.id,
      targetAgentId: target, reason: action.reason, depth: dispatch.depth + 1, idempotencyKey: `fanout:${batch.id}:${target}`, dedupeText: action.question }));
    return { ...emptyActionResult(), outputMessageId: message.id, childDispatchIds: children.map((item) => item.dispatch.id),
      batchId: batch.id, deduplicatedTo: children.find((item) => item.deduplicatedTo)?.deduplicatedTo ?? null };
  }
  if (action.type === 'wait_user') {
    const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_wait_user',
      body: action.question, meta: { dispatchId: dispatch.id, reason: action.reason }, payload: { decisionKind: 'agent_question' } });
    const decision = createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
      idempotencyKey: `question:${dispatch.id}`, kind: 'agent_question', promptMessageId: message.id,
      payload: { question: action.question, reason: action.reason, agentId: agent.id } });
    setRunStatus(run.id, 'waiting_for_user');
    return { ...emptyActionResult(), outputMessageId: message.id, decisionId: decision.id };
  }
  const message = post({ runId: run.id, from: agent.id, to: 'user', kind: 'agent', messageType: 'collaboration_task_proposal',
    body: `${action.title}\n\n${action.goal}`, meta: { dispatchId: dispatch.id, reason: action.reason },
    payload: { decisionKind: 'supervisor_task_proposal', proposal: action } });
  const decision = createDecision({ runId: run.id, conversationId: run.conversationId, dispatchId: dispatch.id,
    idempotencyKey: `proposal:${dispatch.id}`, kind: 'supervisor_task_proposal', promptMessageId: message.id, payload: { proposal: action, agentId: agent.id } });
  setRunStatus(run.id, 'waiting_for_user');
  return { ...emptyActionResult(), outputMessageId: message.id, decisionId: decision.id };
}

function maybeCompleteBatch(batchId: string): void {
  const batch = getBatch(batchId);
  if (!batch || batch.resultDispatchId) return;
  const children = listDispatches(batch.runId).filter((item) => item.batchId === batch.id && item.kind === 'fanout');
  if (children.length === 0 || children.some((item) => item.status === 'queued' || item.status === 'running')) return;
  const run = getRun(batch.runId); if (!run) return;
  const results = children.map((item) => {
    const output = getCompletedDispatchOutput(item.id)
      ?? (item.outputMessageId ? listByRun(run.id).find((message) => message.id === item.outputMessageId)?.body : null);
    return `${item.targetAgentId}（${item.status}）：${output ?? item.error ?? '无结果'}`;
  }).join('\n\n');
  const source = post({ runId: run.id, from: 'system', to: batch.initiatorAgentId, kind: 'system', messageType: 'collaboration_routing',
    body: `并行征询结果已汇总：\n\n${results}`, meta: { batchId: batch.id } });
  const result = createDispatchDetailed({ runId: run.id, conversationId: run.conversationId, sourceMessageId: source.id,
    parentDispatchId: batch.sourceDispatchId, batchId: batch.id, kind: 'aggregate', from: 'system', targetAgentId: batch.initiatorAgentId,
    reason: '并行征询结果回流', depth: Math.max(0, ...children.map((item) => item.depth)), idempotencyKey: `aggregate:${batch.id}`, dedupeText: results });
  const batchStatus = batch.status === 'timeout' ? 'timeout'
    : children.every((item) => item.status === 'failed' || item.status === 'blocked' || item.status === 'cancelled') ? 'failed'
      : children.every((item) => item.status === 'completed') ? 'completed' : 'partial';
  updateBatch(batch.id, batchStatus, result.dispatch.id);
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
  const run = getRun(runId); if (!run || run.status === 'waiting_for_user' || run.status === 'awaiting_approval' || terminalRunStatus(run.status)) return;
  if (hasOpenDispatches(runId) || hasPendingDecision(runId)) return;
  const dispatches = listDispatches(runId);
  const succeeded = dispatches.some((item) => item.status === 'completed');
  finishRun(runId, succeeded ? 'completed' : 'failed');
  closeCollaborationTrace(runId, succeeded ? 'completed' : 'failed');
  try { updateRunUserMessageStatus(runId, succeeded ? 'responded' : 'failed'); } catch { /* legacy */ }
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function recoverCollaborationRuns(): void {
  for (const runId of listRunningCollaborationRunIds()) {
    const run = getRun(runId); if (run) ensureCollaborationSpan(run);
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
