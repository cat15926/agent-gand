import type { ResolveCollaborationDecision, Run } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { tx } from '../db/database.ts';
import { nextTurnNo, touchConversation } from '../conversations/service.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import { finishRun, getRun, setRunStatus, createRun } from '../runs/trace.ts';
import { post, postSystem } from '../messaging/inbox.ts';
import { cancelQueuedRun, createBudgetRevision, createDispatch, getDecision, resolveDecision } from './store.ts';
import { kickCollaboration } from './scheduler.ts';

export class CollaborationDecisionError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function assertPending(id: string) {
  const decision = getDecision(id);
  if (!decision) throw new CollaborationDecisionError(`协作决策不存在: ${id}`, 404);
  return decision;
}

function validateSupervisorTeam(sourceRun: Run, input: Extract<ResolveCollaborationDecision, { action: 'approve_task' }>): void {
  if (input.agentIds.length === 0 || input.agentIds.some((id) => !sourceRun.agentIds.includes(id))) throw new CollaborationDecisionError('正式任务成员必须来自当前 Collaboration Run');
  const agents = input.agentIds.map((id) => registry.getAgent(id));
  if (agents.some((agent) => !agent)) throw new CollaborationDecisionError('正式任务包含不存在或已停用的 Agent');
  const supervisor = registry.getAgent(input.supervisorId);
  if (!supervisor || !input.agentIds.includes(input.supervisorId) || !supervisor.capabilities.includes('coordinate')) throw new CollaborationDecisionError('主管必须属于任务成员并具备 coordinate 能力');
  if (!agents.some((agent) => agent?.capabilities.includes('execute'))) throw new CollaborationDecisionError('正式任务至少需要一位具备 execute 能力的成员');
  if (input.defaultReviewerId) {
    const reviewer = registry.getAgent(input.defaultReviewerId);
    if (!reviewer || !input.agentIds.includes(input.defaultReviewerId) || !reviewer.capabilities.includes('review')) throw new CollaborationDecisionError('Reviewer 必须属于任务成员并具备 review 能力');
  }
}

export function resolveCollaborationDecision(id: string, input: ResolveCollaborationDecision) {
  const initial = assertPending(id);
  if (initial.status !== 'pending') return { decision: initial, linkedRun: initial.linkedRunId ? getRun(initial.linkedRunId) : null };
  const sourceRun = getRun(initial.runId);
  if (!sourceRun) throw new CollaborationDecisionError('关联 Run 不存在', 404);

  if (initial.kind === 'agent_question' && input.action === 'answer') {
    const message = input.message.trim(); if (!message) throw new CollaborationDecisionError('回复内容不能为空');
    const agentId = typeof initial.payload.agentId === 'string' ? initial.payload.agentId : null;
    if (!agentId || !sourceRun.agentIds.includes(agentId)) throw new CollaborationDecisionError('提问 Agent 不可用', 409);
    const result = tx(() => {
      const current = assertPending(id); if (current.status !== 'pending') return current;
      const userMessage = post({ runId: sourceRun.id, from: 'user', to: agentId, kind: 'user', body: message,
        replyTo: current.promptMessageId, messageType: 'informational', deliveryStatus: 'processing' });
      createDispatch({ runId: sourceRun.id, conversationId: sourceRun.conversationId, sourceMessageId: userMessage.id,
        parentDispatchId: current.dispatchId, kind: 'resume', from: 'user', targetAgentId: agentId,
        reason: '用户回答协作问题', depth: 0, priority: 'urgent', idempotencyKey: `decision:${current.id}:answer` });
      const resolved = resolveDecision(current.id, 'accepted', { action: input.action, messageId: userMessage.id })!;
      setRunStatus(sourceRun.id, 'running'); return resolved;
    });
    touchConversation(sourceRun.conversationId); kickCollaboration(sourceRun.conversationId);
    return { decision: result, linkedRun: null };
  }

  if (initial.kind === 'budget_exhausted' && input.action === 'increase_budget') {
    if (!Number.isInteger(input.increasePercent) || input.increasePercent < 10 || input.increasePercent > 200) throw new CollaborationDecisionError('increasePercent 必须是 10～200 的整数');
    const resolved = tx(() => {
      const current = assertPending(id); if (current.status !== 'pending') return current;
      const revision = createBudgetRevision(sourceRun.id, current.id, input.increasePercent);
      if (JSON.stringify(revision.previousLimits) === JSON.stringify(revision.newLimits)) throw new CollaborationDecisionError('已达到平台允许的最大预算倍数', 409);
      const agentId = typeof current.payload.agentId === 'string' ? current.payload.agentId : null;
      const sourceMessageId = typeof current.payload.resumeSourceMessageId === 'string' ? current.payload.resumeSourceMessageId : null;
      if (agentId && sourceMessageId) createDispatch({ runId: sourceRun.id, conversationId: sourceRun.conversationId,
        sourceMessageId, parentDispatchId: typeof current.payload.parentDispatchId === 'string' ? current.payload.parentDispatchId : null,
        kind: 'resume', from: 'system', targetAgentId: agentId, reason: '用户增加预算后重试被阻止的路由',
        depth: typeof current.payload.depth === 'number' ? current.payload.depth : 0, priority: 'urgent', idempotencyKey: `decision:${current.id}:budget-resume` });
      const done = resolveDecision(current.id, 'accepted', { action: input.action, increasePercent: input.increasePercent, revisionId: revision.id, newLimits: revision.newLimits })!;
      setRunStatus(sourceRun.id, 'running'); return done;
    });
    postSystem(sourceRun.id, 'user', `预算已增加 ${input.increasePercent}%，协作继续执行。`);
    touchConversation(sourceRun.conversationId); kickCollaboration(sourceRun.conversationId);
    return { decision: resolved, linkedRun: null };
  }

  if (initial.kind === 'budget_exhausted' && input.action === 'terminate_at_budget') {
    const resolved = tx(() => {
      const current = assertPending(id); if (current.status !== 'pending') return current;
      cancelQueuedRun(sourceRun.id);
      const done = resolveDecision(current.id, 'accepted', { action: input.action, outcome: 'partial_accepted' })!;
      finishRun(sourceRun.id, 'completed'); return done;
    });
    postSystem(sourceRun.id, 'user', '用户选择在预算边界按当前部分结果终止。'); touchConversation(sourceRun.conversationId);
    return { decision: resolved, linkedRun: null };
  }

  if (initial.kind === 'supervisor_task_proposal' && input.action === 'reject_task') {
    const agentId = typeof initial.payload.agentId === 'string' ? initial.payload.agentId : null;
    if (!agentId) throw new CollaborationDecisionError('提议 Agent 不可用', 409);
    const reason = input.reason?.trim() || '用户暂不创建正式任务';
    const resolved = tx(() => {
      const current = assertPending(id); if (current.status !== 'pending') return current;
      const userMessage = post({ runId: sourceRun.id, from: 'user', to: agentId, kind: 'user', body: reason,
        replyTo: current.promptMessageId, deliveryStatus: 'processing' });
      createDispatch({ runId: sourceRun.id, conversationId: sourceRun.conversationId, sourceMessageId: userMessage.id,
        parentDispatchId: current.dispatchId, kind: 'resume', from: 'user', targetAgentId: agentId,
        reason: '用户拒绝正式任务提议', depth: 0, priority: 'urgent', idempotencyKey: `decision:${current.id}:reject` });
      const done = resolveDecision(current.id, 'rejected', { action: input.action, reason, messageId: userMessage.id })!;
      setRunStatus(sourceRun.id, 'running'); return done;
    });
    touchConversation(sourceRun.conversationId); kickCollaboration(sourceRun.conversationId);
    return { decision: resolved, linkedRun: null };
  }

  if (initial.kind === 'supervisor_task_proposal' && input.action === 'approve_task') {
    validateSupervisorTeam(sourceRun, input);
    const proposal = initial.payload.proposal as { title?: unknown; goal?: unknown; acceptanceCriteria?: unknown } | undefined;
    const baseGoal = typeof proposal?.goal === 'string' && proposal.goal.trim() ? proposal.goal.trim() : sourceRun.goal;
    const criteria = Array.isArray(proposal?.acceptanceCriteria) ? proposal.acceptanceCriteria.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
    const goal = criteria.length > 0 ? `${baseGoal}\n\n验收标准：\n${criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : baseGoal;
    const linked = tx(() => {
      const current = assertPending(id);
      if (current.status !== 'pending') return current.linkedRunId ? getRun(current.linkedRunId)! : null;
      const created = createRun(goal, 'supervisor', input.agentIds, sourceRun.workspace ?? null, input.supervisorId,
        sourceRun.conversationId, nextTurnNo(sourceRun.conversationId), input.defaultReviewerId ?? null);
      resolveDecision(current.id, 'accepted', { action: input.action, supervisorId: input.supervisorId, agentIds: input.agentIds }, created.id);
      finishRun(sourceRun.id, 'completed'); return created;
    });
    if (!linked) throw new CollaborationDecisionError('关联 Supervisor Run 创建失败', 409);
    enqueueConversationRun(linked.id); touchConversation(sourceRun.conversationId);
    return { decision: getDecision(id)!, linkedRun: linked };
  }

  throw new CollaborationDecisionError(`决策 ${initial.kind} 不支持动作 ${input.action}`, 409);
}
