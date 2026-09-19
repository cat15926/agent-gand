import type { AgentDefinition } from '@agent-gand/shared';
import { conversationHistory, getConversation, listConversations, touchConversation } from './service.ts';
import { updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { pipelineOrchestrator } from '../orchestration/pipeline.ts';
import { supervisorOrchestrator } from '../orchestration/supervisor.ts';
import { finishRun, getRun, listPendingRunsByConversation, listRunAgentSnapshots } from '../runs/trace.ts';
import { admitCollaborationRun } from '../collaboration/scheduler.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { runCoordinationPlan } from '../coordination/runtime.ts';

const active = new Set<string>();
const inputs = new Map<string, { recipientIds?: string[]; replyTo?: string | null; taskId?: string | null; clientMessageId?: string }>();

export function enqueueConversationRun(runId: string, input?: { recipientIds?: string[]; replyTo?: string | null; taskId?: string | null; clientMessageId?: string }): void {
  if (input) inputs.set(runId, input);
  const item = getRun(runId);
  if (!item) return;
  void drain(item.conversationId);
}

async function drain(conversationId: string): Promise<void> {
  if (active.has(conversationId)) return;
  active.add(conversationId);
  try {
    for (;;) {
      const current = listPendingRunsByConversation(conversationId)[0];
      if (!current) break;
      const conversation = getConversation(conversationId);
      if (!conversation) break;
      const snapshots = listRunAgentSnapshots(current.id);
      const members = current.agentIds.map((id) => snapshots.find((agent) => agent.id === id))
        .filter((agent): agent is AgentDefinition => agent !== undefined);
      if (members.length !== current.agentIds.length) {
        finishRun(current.id, 'failed');
        try { updateRunUserMessageStatus(current.id, 'failed'); } catch { /* 旧 Run 可能没有用户消息 */ }
        touchConversation(conversationId);
        continue;
      }
      const messageInput = inputs.get(current.id);
      const coordinationPlan = getRunCoordinationPlan(current.id);
      if (coordinationPlan) {
        const history = conversationHistory(conversationId, current.turnNo);
        const recipientHint = messageInput?.recipientIds?.length
          ? `本轮用户公开定向给：${messageInput.recipientIds.join('、')}。保持完整团队与既定审查关系，由被提及成员优先回应。\n\n`
          : '';
        const contextGoal = history
          ? `聊天室「${conversation.title}」历史上下文：\n${history}\n\n${recipientHint}本轮用户消息：\n${current.goal}`
          : `${recipientHint}${current.goal}`;
        try {
          await runCoordinationPlan(current, contextGoal, current.goal, messageInput);
        } catch {
          try { updateRunUserMessageStatus(current.id, 'failed'); } catch { /* runtime 已尽力留痕 */ }
        } finally {
          inputs.delete(current.id);
          touchConversation(conversationId);
        }
        continue;
      }
      if (current.mode === 'collaboration') {
        try {
          admitCollaborationRun(current, conversation, messageInput);
        } catch {
          finishRun(current.id, 'failed');
          try { updateRunUserMessageStatus(current.id, 'failed'); } catch { /* 用户消息可能尚未落库 */ }
        } finally {
          inputs.delete(current.id);
          touchConversation(conversationId);
        }
        continue;
      }
      // @ 只记录公开接收者，不改变房间成员或既定 Reviewer；编排层仍拿到完整团队。
      let agents = members;
      if (current.mode === 'supervisor') {
        const supervisor = members.find((agent) => agent.id === current.supervisorId) ?? members[0];
        if (supervisor) agents = [supervisor, ...agents.filter((agent) => agent.id !== supervisor.id)];
      }
      const history = conversationHistory(conversationId, current.turnNo);
      const recipientHint = messageInput?.recipientIds?.length
        ? `本轮用户公开定向给：${messageInput.recipientIds.join('、')}。保持完整团队与既定审查关系，由被提及成员优先回应。\n\n`
        : '';
      const contextGoal = history
        ? `聊天室「${conversation.title}」历史上下文：\n${history}\n\n${recipientHint}本轮用户消息：\n${current.goal}`
        : `${recipientHint}${current.goal}`;
      const orchestrator = current.mode === 'supervisor' ? supervisorOrchestrator : pipelineOrchestrator;
      try {
        await orchestrator.start(current, agents, contextGoal, current.goal, messageInput);
        updateRunUserMessageStatus(current.id, 'responded');
      } catch {
        try { updateRunUserMessageStatus(current.id, 'failed'); } catch { /* 用户消息可能在启动前失败 */ }
      } finally {
        inputs.delete(current.id);
        touchConversation(conversationId);
      }
    }
  } finally {
    active.delete(conversationId);
    if (listPendingRunsByConversation(conversationId).length > 0) void drain(conversationId);
  }
}

export function recoverPendingConversationRuns(): void {
  for (const conversation of listConversations()) void drain(conversation.id);
}
