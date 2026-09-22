import type { AgentDefinition, Conversation, Run } from '@agent-gand/shared';
import { conversationHistory, getConversation, listConversations, touchConversation } from './service.ts';
import { listByConversation, post, updateRunUserMessageStatus } from '../messaging/inbox.ts';
import { pipelineOrchestrator } from '../orchestration/pipeline.ts';
import { runAgentTurn, SESSION_BOUNDARY_DIRECTIVE } from '../orchestration/agentStep.ts';
import { supervisorOrchestrator } from '../orchestration/supervisor.ts';
import { endSpan, finishRun, getRun, listPendingRunsByConversation, listRunAgentSnapshots, setRunStatus, startSpan } from '../runs/trace.ts';
import { latestCheckpoint, saveCheckpoint } from '../runs/checkpoints.ts';
import { admitCollaborationRun } from '../collaboration/scheduler.ts';
import { conversationHasCoordinationPlan, getRunCoordinationPlan } from '../coordination/store.ts';
import { runCoordinationPlan } from '../coordination/runtime.ts';
import { compileCoordinationPlan, previewCoordination } from '../coordination/service.ts';
import { isStructuredFollowupGoal } from '../coordination/planner.ts';
import { config } from '../config.ts';

const active = new Set<string>();
const inputs = new Map<string, RuntimeMessageInput>();

export function enqueueConversationRun(runId: string, input?: RuntimeMessageInput): void {
  if (input) inputs.set(runId, input);
  const item = getRun(runId);
  if (!item) return;
  void drain(item.conversationId);
}

// ---- Follow-up Router（docs/plans/followup-routing-plan.md）----
// 追问不再无条件重跑房间编排：显式定向走单/多 Agent 快速路径；
// 无定向时按确定性判定分"简单（最近回复者快速路径）"与"结构化（协调房间重新规划 / 房间模式编排）"。

interface RuntimeMessageInput {
  recipientIds?: string[];
  replyTo?: string | null;
  taskId?: string | null;
  clientMessageId?: string;
  followupRouting?: 'room_mode';
}

function persistedMessageInput(conversationId: string, runId: string): RuntimeMessageInput | undefined {
  const message = listByConversation(conversationId).find((item) => item.runId === runId && item.kind === 'user');
  if (!message) return undefined;
  return {
    recipientIds: message.to === 'all' ? [] : message.to.split(',').filter(Boolean),
    replyTo: message.replyTo, taskId: message.taskId, clientMessageId: message.clientMessageId ?? undefined,
    ...(message.meta?.followupRouting === 'room_mode' ? { followupRouting: 'room_mode' as const } : {}),
  };
}

/** 显式定向目标：recipientIds 优先；为空时从 replyTo 推导被回复 Agent（覆盖 API 调用方） */
function directedAgentIds(conversation: Conversation, messageInput: RuntimeMessageInput | undefined, members: AgentDefinition[]): AgentDefinition[] {
  const ids = new Set<string>(messageInput?.recipientIds ?? []);
  if (ids.size === 0 && messageInput?.replyTo) {
    const replied = listByConversation(conversation.id).find((message) => message.id === messageInput.replyTo);
    if (replied && replied.from !== 'user' && replied.from !== 'system') ids.add(replied.from);
  }
  return [...ids].slice(0, config.collaboration.maxTargets)
    .map((id) => members.find((agent) => agent.id === id))
    .filter((agent): agent is AgentDefinition => Boolean(agent));
}

/** 本房间最近成功回复者：最后一条 kind=agent 且所属 run 已完成的发送者 */
function lastSuccessfulResponder(conversationId: string, members: AgentDefinition[]): AgentDefinition | undefined {
  const messages = listByConversation(conversationId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.kind !== 'agent' || message.messageType === 'collaboration_contribution') continue;
    const agent = members.find((item) => item.id === message.from);
    if (!agent) continue;
    if (getRun(message.runId)?.status === 'completed') return agent;
  }
  return undefined;
}

/** 快速路径：目标 Agent 并行回应；等所有分支结束后按成功分支数收敛 Run。 */
async function runFastPathTurn(run: Run, targets: AgentDefinition[], contextGoal: string, messageInput: RuntimeMessageInput | undefined, reason: 'directed' | 'simple'): Promise<void> {
  if (activeFastPath.has(run.id)) return;
  activeFastPath.add(run.id);
  const root = startSpan(run.id, {
    spanKind: 'orchestration', name: `fastpath:${reason}`, input: run.goal,
    attributes: { 'orchestration.phase': `fastpath.${reason}`, 'fastpath.agents': targets.map((agent) => agent.id).join(',') },
  });
  try {
    setRunStatus(run.id, 'running');
    // 恢复锚点：重启后 wakeRun 按 checkpoint 原样重建（同 targets → 同 executionScope → 审批/工具幂等键一致）
    saveCheckpoint({ runId: run.id, kind: 'fastpath', phase: 'running', state: {
      agentIds: targets.map((agent) => agent.id), reason, contextGoal,
      replyTo: messageInput?.replyTo ?? null, taskId: messageInput?.taskId ?? null, clientMessageId: messageInput?.clientMessageId ?? null,
    } });
    // 用户消息可能已由 routes 落库（clientMessageId 幂等，重复 post 返回既有行）
    await post({
      runId: run.id, from: 'user', to: 'all', kind: 'user', body: run.goal,
      replyTo: messageInput?.replyTo, taskId: messageInput?.taskId,
      clientMessageId: messageInput?.clientMessageId ?? `fastpath:${run.id}:user`, deliveryStatus: 'processing',
    });
    const outcomes = await Promise.all(targets.map(async (agent, index) => {
      const agentSpan = startSpan(run.id, {
        spanKind: 'agent', name: `agent:${agent.id}`, input: JSON.stringify({ goal: contextGoal }),
        attributes: { 'agent.id': agent.id, 'agent.role': 'collaborator', 'orchestration.phase': 'fastpath.step' },
      });
      try {
        const turn = await runAgentTurn({
          run, agent, parentSpanId: agentSpan.id,
          messages: [
            { role: 'system', content: agent.systemPrompt },
            { role: 'system', content: SESSION_BOUNDARY_DIRECTIVE },
            { role: 'user', content: contextGoal },
          ],
          executionScopeId: `fastpath:${run.id}:${index}:${agent.id}`,
        });
        if (turn.content.trim().length > 0) {
          await post({
            runId: run.id, from: agent.id, to: 'all', kind: 'agent', body: turn.content,
            meta: { toolRounds: turn.toolRounds }, clientMessageId: `fastpath:${run.id}:${index}:${agent.id}`,
          });
        }
        endSpan(agentSpan, { output: turn.content, status: turn.emptyResponse ? 'error' : 'ok' });
        return { agent, index, failed: false, answered: turn.content.trim().length > 0 };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        endSpan(agentSpan, { output: message, status: 'error' });
        return { agent, index, failed: true, answered: false };
      }
    }));
    const failed = outcomes.filter((outcome) => outcome.failed);
    const succeeded = outcomes.filter((outcome) => outcome.answered).length;
    for (const outcome of failed) {
      await post({
        runId: run.id, from: 'system', to: 'all', kind: 'system',
        body: `${outcome.agent.name} 本轮回复失败，详细原因请查看运行轨迹。`,
        clientMessageId: `fastpath:${run.id}:${outcome.index}:${outcome.agent.id}:error`,
      });
    }
    // 全部空回复时与 pipeline 契约对齐：run 仍 completed（agentStep 已发 system 空正文说明、
    // agent span 记 error），不把"模型空回复"升级为运行失败
    const allFailed = failed.length === targets.length;
    finishRun(run.id, allFailed ? 'failed' : 'completed');
    updateRunUserMessageStatus(run.id, allFailed ? 'failed' : 'responded');
    endSpan(root, { output: `fastpath 完成（${succeeded}/${targets.length} 回复，${failed.length} 失败）`, status: allFailed || succeeded === 0 ? 'error' : 'ok' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishRun(run.id, 'failed');
    try { updateRunUserMessageStatus(run.id, 'failed'); } catch { /* 用户消息可能不存在 */ }
    endSpan(root, { output: message, status: 'error' });
  } finally {
    activeFastPath.delete(run.id);
    touchConversation(run.conversationId);
  }
}

const activeFastPath = new Set<string>();

/** 重启恢复：按 fastpath checkpoint 原样重建（同 targets → 同 executionScope → 审批与工具账本幂等） */
export async function resumeFastPathRun(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run || run.status === 'completed' || run.status === 'failed') return;
  const checkpoint = latestCheckpoint(runId, 'fastpath');
  const agentIds = Array.isArray(checkpoint?.state.agentIds) ? checkpoint.state.agentIds : [];
  const contextGoal = typeof checkpoint?.state.contextGoal === 'string' ? checkpoint.state.contextGoal : run.goal;
  const snapshots = listRunAgentSnapshots(runId);
  const targets = agentIds
    .map((id) => (typeof id === 'string' ? snapshots.find((agent) => agent.id === id) : undefined))
    .filter((agent): agent is AgentDefinition => Boolean(agent));
  if (targets.length === 0) return;
  const messageInput: RuntimeMessageInput = {
    replyTo: typeof checkpoint?.state.replyTo === 'string' ? checkpoint.state.replyTo : null,
    taskId: typeof checkpoint?.state.taskId === 'string' ? checkpoint.state.taskId : null,
    clientMessageId: typeof checkpoint?.state.clientMessageId === 'string' ? checkpoint.state.clientMessageId : undefined,
  };
  await runFastPathTurn(run, targets, contextGoal, messageInput, checkpoint?.state.reason === 'directed' ? 'directed' : 'simple');
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
      const messageInput = inputs.get(current.id) ?? persistedMessageInput(conversationId, current.id);
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
      // ---- Follow-up Router（仅作用于追问：turn>1 或带消息输入；collaboration 语义已是本方案子集）----
      // 决策顺序：结构化 > 定向 > 简单。"@A @B 分别调研，最后由 @C 汇总"是定向 + 结构化的复合诉求，
      // 必须走编排（汇总步骤等待全部分支），@提及转为 recipientHint 供角色参考——
      // 真机会话 31ec5657 seq30 实证：定向短路吞掉了编排诉求，reviewer 从未被调度。
      const isFollowup = messageInput !== undefined || current.turnNo > 1;
      const structured = isFollowup && isStructuredFollowupGoal(current.goal);
      const directed = isFollowup && !structured ? directedAgentIds(conversation, messageInput, members) : [];
      const history = conversationHistory(conversationId, current.turnNo);
      if (directed.length > 0) {
        // 显式定向（回复/@）且无编排诉求：仅目标 Agent 回应，不重跑编排
        const hint = `本轮用户定向${directed.length > 1 ? `（并行征询 ${directed.map((agent) => agent.name).join('、')}）` : `给${directed[0]!.name}`}，请直接回应；如需团队协作请明确说明。直接在回复中给出完整内容，除非用户明确要求，不要用 fs.write 落盘存档。`;
        const contextGoal = history ? `聊天室「${conversation.title}」历史上下文：\n${history}\n\n${hint}\n\n本轮用户消息：\n${current.goal}` : `${hint}\n\n本轮用户消息：\n${current.goal}`;
        await runFastPathTurn(current, directed, contextGoal, messageInput, 'directed');
        inputs.delete(current.id);
        continue;
      }
      if (isFollowup && !structured) {
        // 简单追问：最近成功回复者快速回应（默认偏轻，误判可 @ 升级补救）
        const target = lastSuccessfulResponder(conversationId, members)
          ?? members.find((agent) => agent.capabilities.includes('execute'))
          ?? members[0];
        if (target) {
          const hint = '本轮为简单追问，直接在回复中给出完整内容即可；除非用户明确要求，不要用 fs.write 落盘存档。';
          const contextGoal = history ? `聊天室「${conversation.title}」历史上下文：\n${history}\n\n${hint}\n\n本轮用户消息：\n${current.goal}` : `${hint}\n\n本轮用户消息：\n${current.goal}`;
          await runFastPathTurn(current, [target], contextGoal, messageInput, 'simple');
          inputs.delete(current.id);
          continue;
        }
      }
      if (structured && messageInput?.followupRouting !== 'room_mode' && conversationHasCoordinationPlan(conversationId)) {
        // 结构化追问 + 协调房间：服务端重新规划编译新 Plan（校验通过且 auto_start 才激活）
        try {
          const previewResult = await previewCoordination({
            goal: current.goal, agentIds: current.agentIds,
            ...(current.defaultReviewerId && current.agentIds.includes(current.defaultReviewerId) ? { defaultReviewerId: current.defaultReviewerId } : {}),
          });
          const draft = previewResult.draft;
          if (draft.validationErrors.length === 0 && draft.runtimeMode && draft.decision === 'auto_start') {
            compileCoordinationPlan(draft.id, current.id, current.goal, members);
            continue; // 已绑定新 Plan：回到循环顶部走 coordination 分支执行
          }
        } catch {
          // 规划失败也走下方轻量快速路径，不重跑旧房间的完整编排。
        }
        const fallbackTargets = directedAgentIds(conversation, messageInput, members);
        const target = lastSuccessfulResponder(conversationId, members)
          ?? members.find((agent) => agent.capabilities.includes('execute'))
          ?? members[0];
        const targets = fallbackTargets.length > 0 ? fallbackTargets : target ? [target] : [];
        if (targets.length > 0) {
          const hint = `本轮协作规划未能安全自动开始，改由${targets.map((agent) => agent.name).join('、')}直接回应。请说明无法完整执行原协作要求的部分，不要声称已完成辩论、审查或其他未执行的步骤。`;
          const contextGoal = history ? `聊天室「${conversation.title}」历史上下文：\n${history}\n\n${hint}\n\n本轮用户消息：\n${current.goal}` : `${hint}\n\n本轮用户消息：\n${current.goal}`;
          await runFastPathTurn(current, targets, contextGoal, messageInput, fallbackTargets.length > 0 ? 'directed' : 'simple');
          inputs.delete(current.id);
          continue;
        }
      }
      // @ 只记录公开接收者，不改变房间成员或既定 Reviewer；编排层仍拿到完整团队。
      let agents = members;
      if (messageInput?.recipientIds?.length) {
        // 定向成员优先参与（编排兜底时保证被点名者先回应，未被点名者殿后）
        const directedSet = new Set(messageInput.recipientIds);
        agents = [...members.filter((agent) => directedSet.has(agent.id)), ...members.filter((agent) => !directedSet.has(agent.id))];
      }
      if (current.mode === 'supervisor') {
        const supervisor = members.find((agent) => agent.id === current.supervisorId) ?? members[0];
        if (supervisor) agents = [supervisor, ...agents.filter((agent) => agent.id !== supervisor.id)];
      }
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
