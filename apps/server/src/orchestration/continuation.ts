import type { OrchestrationPreviewInput } from '@agent-gand/shared';
import { get, run, tx } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { getConversation } from '../conversations/service.ts';
import { listByRun } from '../messaging/inbox.ts';
import { getDispatch, listAttempts, listDispatches } from '../collaboration/store.ts';
import { assessRunRecovery } from '../runtime/recovery.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { objectInput, OrchestrationError } from './normalize.ts';
import { previewExecutionOrchestration, submitExecutionOrchestration } from './entry.ts';

function continuationInput(runId: string): OrchestrationPreviewInput {
  const assessment = assessRunRecovery(runId);
  if (!assessment.continuationAllowed) throw new OrchestrationError(409, assessment.reasonCodes[0]!, assessment.explanation);
  const source = getRun(runId)!;
  const room = getConversation(source.conversationId);
  if (!room || room.archivedAt) throw new OrchestrationError(409, 'CONTINUATION_ROOM_UNAVAILABLE', '原聊天室不存在或已归档');
  if (source.agentIds.some(id => !room.agentIds.includes(id))) throw new OrchestrationError(409, 'CONTINUATION_TEAM_CHANGED', '原成员已不在聊天室，请准备新任务并选择团队');
  const snapshot = getRunOrchestrationSnapshot(runId);
  const failed = listDispatches(runId).find(item => item.status === 'failed')!;
  const pendingMessage = listByRun(runId).find(message => message.id === failed.sourceMessageId);
  if (!pendingMessage) throw new OrchestrationError(409, 'CONTINUATION_SOURCE_MISSING', '待续事项的来源消息不存在');
  return { conversationId: source.conversationId, goal: `继续未交付事项：\n${pendingMessage.body}`, agentIds: source.agentIds,
    recipientIds: [assessment.targetAgentId!], strategy: 'auto', workflow: 'routine', workspace: source.workspace ?? null,
    wholeTeam: false, supervisorId: null, defaultReviewerId: null, aggregatorId: null, replyTo: null, taskId: null,
    constraints: { readonly: true, ...(snapshot?.request.constraints.deadlineMs ? { deadlineMs: snapshot.request.constraints.deadlineMs } : {}) },
    clientRequestId: `continuation:${source.id}` };
}

/** Model-free preview; admission freezes the current role/account configuration again. */
export async function previewRunContinuation(runId: string) {
  const input = continuationInput(runId);
  const preview = await previewExecutionOrchestration(input);
  const outputs = listAttempts(runId).filter(attempt => attempt.status === 'completed' && attempt.output?.trim());
  return { assessment: assessRunRecovery(runId), preview, checkpoint: {
    pendingObjective: input.goal,
    confirmedOutputs: outputs.map(attempt => ({ attemptId: attempt.id, agentId: attempt.agentId,
      excerpt: attempt.output!.slice(0, 800), truncated: attempt.output!.length > 800 })) } };
}

/** One linked Run per terminal source; source records and confirmed attempts are never updated. */
export function submitRunContinuation(runId: string, value: unknown) {
  const body = objectInput(value);
  if (Object.keys(body).some(key => !['previewId','orchestrationFingerprint'].includes(key))
    || typeof body.previewId !== 'string' || typeof body.orchestrationFingerprint !== 'string') {
    throw new OrchestrationError(400, 'CONTINUATION_CONFIRMATION_REQUIRED', '请提交续跑预览及其 fingerprint');
  }
  return tx(() => {
    const existing = get<{ target_run_id: string }>('SELECT target_run_id FROM orchestration_run_continuations WHERE source_run_id=?', runId);
    if (existing) return { run: getRun(existing.target_run_id)!, deduplicated: true };
    const input = continuationInput(runId);
    const failed = listDispatches(runId).find(item => item.status === 'failed')!;
    const sourceMessage = listByRun(runId).find(message => message.id === failed.sourceMessageId);
    if (!sourceMessage) throw new OrchestrationError(409, 'CONTINUATION_SOURCE_MISSING', '待续事项的来源消息不存在');
    const sourceMessages = new Map(listByRun(runId).map(message => [message.id, message]));
    const outputs = listAttempts(runId).filter(attempt => attempt.status === 'completed' && attempt.output?.trim()).map(attempt => {
      const dispatch = getDispatch(attempt.dispatchId)!;
      return { attemptId: attempt.id, dispatchId: dispatch.id, agentId: attempt.agentId,
        sourceMessageId: dispatch.sourceMessageId, outputMessageId: dispatch.outputMessageId,
        objective: sourceMessages.get(dispatch.sourceMessageId)?.body ?? '',
        actionKind: attempt.controlAction?.type ?? 'answer', output: attempt.output! };
    });
    const manifest = { version: 1, sourceRunId: runId, sourceDispatchId: failed.id,
      originalObjective: getRun(runId)!.goal, pendingObjective: sourceMessage.body, outputs };
    const result = submitExecutionOrchestration({ ...input, entryVersion: 1, ...body }, input.conversationId!);
    run(`INSERT INTO orchestration_run_continuations(source_run_id,target_run_id,source_dispatch_id,manifest,created_at)
      VALUES (?,?,?,?,?)`, runId, result.run.id, failed.id, JSON.stringify(manifest), new Date().toISOString());
    return { run: result.run, deduplicated: result.deduplicated };
  });
}
