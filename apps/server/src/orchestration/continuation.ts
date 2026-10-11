import type { OrchestrationPreviewInput } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { get, run, tx } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { getConversation } from '../conversations/service.ts';
import { listByRun } from '../messaging/inbox.ts';
import { getDispatch, listAttempts, listDispatches } from '../collaboration/store.ts';
import { assessRunRecovery } from '../runtime/recovery.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { objectInput, OrchestrationError, stableDigest } from './normalize.ts';
import { previewExecutionOrchestration, submitExecutionOrchestration } from './entry.ts';
import { buildBusinessCheckpoint } from './businessCheckpoint.ts';
import { checkpointDigest, checkpointSummary, saveBusinessCheckpoint, type BusinessCheckpoint } from './businessCheckpointStore.ts';
import { redactSensitive } from '../runtime/evidence.ts';
import { runSourceAccess } from '../messaging/access.ts';
import { costCarry, carryCosts, costBudgetState } from './costBudget.ts';

function continuationInput(runId: string): OrchestrationPreviewInput {
  const assessment = assessRunRecovery(runId);
  if (!assessment.continuationAllowed) throw new OrchestrationError(409, assessment.reasonCodes[0]!, assessment.explanation);
  const source = getRun(runId)!;
  const room = getConversation(source.conversationId);
  if (!room || room.archivedAt) throw new OrchestrationError(409, 'CONTINUATION_ROOM_UNAVAILABLE', '原聊天室不存在或已归档');
  if (source.agentIds.some(id => !room.agentIds.includes(id))) throw new OrchestrationError(409, 'CONTINUATION_TEAM_CHANGED', '原成员已不在聊天室，请准备新任务并选择团队');
  const snapshot = getRunOrchestrationSnapshot(runId);
  if (assessment.continuationKind === 'business_stages') return businessCheckpointInput(runId, `continuation:${source.id}`);
  const failed = listDispatches(runId).find(item => item.status === 'failed')!;
  const pendingMessage = listByRun(runId).find(message => message.id === failed.sourceMessageId);
  if (!pendingMessage) throw new OrchestrationError(409, 'CONTINUATION_SOURCE_MISSING', '待续事项的来源消息不存在');
  return { conversationId: source.conversationId, goal: `继续未交付事项：\n${pendingMessage.body}`, agentIds: source.agentIds,
    recipientIds: [assessment.targetAgentId!], strategy: 'auto', workflow: 'routine', workspace: source.workspace ?? null,
    wholeTeam: false, supervisorId: null, defaultReviewerId: null, aggregatorId: null, replyTo: null, taskId: null,
    constraints: { ...snapshot?.request.constraints, readonly: true, ...(snapshot?.request.constraints.deadlineMs ? { deadlineMs: snapshot.request.constraints.deadlineMs } : {}),
      ...(snapshot?.request.constraints.firstResponseTimeoutMs ? { firstResponseTimeoutMs: snapshot.request.constraints.firstResponseTimeoutMs } : {}),
      ...(snapshot?.request.constraints.idleTimeoutMs ? { idleTimeoutMs: snapshot.request.constraints.idleTimeoutMs } : {}) },
    clientRequestId: `continuation:${source.id}` };
}

/** Internal owner stage input; public requests cannot supply an archive or replace the frozen contract. */
export function businessCheckpointInput(runId: string, clientRequestId: string): OrchestrationPreviewInput {
  const source = getRun(runId)!;
  const room = getConversation(source.conversationId);
  if (!room || room.archivedAt) throw new OrchestrationError(409, 'CONTINUATION_ROOM_UNAVAILABLE', '原聊天室不存在或已归档');
  if (source.agentIds.some(id => !room.agentIds.includes(id))) throw new OrchestrationError(409, 'CONTINUATION_TEAM_CHANGED', '原成员已不在聊天室，请准备新任务并选择团队');
  const snapshot = getRunOrchestrationSnapshot(runId)!;
  return { conversationId: source.conversationId, goal: source.goal, agentIds: room.agentIds, recipientIds: [], strategy: 'serial', workflow: 'routine',
    workspace: room.workspace, wholeTeam: false, supervisorId: null, defaultReviewerId: null, aggregatorId: null, replyTo: null, taskId: null,
    ...runSourceAccess(runId),businessContract: snapshot.request.businessContract, constraints: { ...snapshot.request.constraints, readonly: snapshot.execution?.readonly!==false }, clientRequestId };
}

/** Model-free preview; admission freezes the current role/account configuration again. */
export async function previewRunContinuation(runId: string, owner = false) {
  if ((getRunOrchestrationSnapshot(runId)?.request.businessContract || getRunOrchestrationSnapshot(runId)?.request.constraints.costPolicy) && !owner) throw new OrchestrationError(403, 'OWNER_REQUIRED', '阶段或费用续跑需通过所有者账户管理入口预览和确认');
  const input = continuationInput(runId);
  const checkpoint = input.businessContract ? buildBusinessCheckpoint(runId) : undefined;
  const preview = await previewExecutionOrchestration(input, 'unified_preview', checkpoint);
  if (checkpoint) return { assessment: assessRunRecovery(runId), preview, checkpoint: {
    pendingObjective: checkpoint.contract.stages.filter(s => !checkpoint.accepted.some(a => a.stageId === s.id)).map(s => `${s.title}：${s.execution!.assignments.filter((_, i) => !checkpoint.outputs.some(o => o.stepId === `stage-${checkpoint.contract.stages.indexOf(s) + 1}-work-${i + 1}`)).map(a => a.objective).join('；') || '成员步骤已完成，等待验收'}`).join('\n'),
    confirmedOutputs: checkpoint.outputs.map(o => ({ attemptId: o.attemptId, agentId: o.agentId, origin:o.origin, excerpt: redactSensitive(o.output).slice(0,800), truncated: o.output.length > 800 })),
    business: { ...checkpointSummary(checkpoint), acceptedStages: checkpoint.accepted.map(a => ({ id: a.stageId, title: checkpoint.contract.stages.find(s => s.id === a.stageId)!.title })),
      carriedRunTokens: checkpoint.runTokens, carriedStageTokens: checkpoint.stageTokens, workspace: 'fresh_run' as const, timeLimitsReset: true } } };
  const outputs = listAttempts(runId).filter(attempt => attempt.status === 'completed' && attempt.output?.trim());
  const costs = costCarry(runId), fees = costBudgetState(runId);
  return { assessment: assessRunRecovery(runId), preview, ...(fees ? { costCarryDigest: stableDigest(costs), costBudget: fees } : {}), checkpoint: {
    pendingObjective: input.goal,
    confirmedOutputs: outputs.map(attempt => ({ attemptId: attempt.id, agentId: attempt.agentId,
      excerpt: attempt.output!.slice(0, 800), truncated: attempt.output!.length > 800 })) } };
}

/** One linked Run per terminal source; source records and confirmed attempts are never updated. */
export function submitRunContinuation(runId: string, value: unknown, owner = false) {
  if ((getRunOrchestrationSnapshot(runId)?.request.businessContract || getRunOrchestrationSnapshot(runId)?.request.constraints.costPolicy) && !owner) throw new OrchestrationError(403, 'OWNER_REQUIRED', '阶段或费用续跑需通过所有者账户管理入口预览和确认');
  const body = objectInput(value);
  if (Object.keys(body).some(key => !['previewId','orchestrationFingerprint','costCarryDigest'].includes(key))
    || typeof body.previewId !== 'string' || typeof body.orchestrationFingerprint !== 'string') {
    throw new OrchestrationError(400, 'CONTINUATION_CONFIRMATION_REQUIRED', '请提交续跑预览及其 fingerprint');
  }
  return tx(() => {
    const existing = get<{ target_run_id: string; manifest: string }>('SELECT target_run_id,manifest FROM orchestration_run_continuations WHERE source_run_id=?', runId);
    if (existing) {
      const confirmation = JSON.parse(existing.manifest).confirmation;
      if (confirmation && confirmation !== stableDigest(body)) throw new OrchestrationError(409, 'IDEMPOTENCY_CONFLICT', '此原任务已用另一份预览创建续跑，请查看既有任务');
      return { run: getRun(existing.target_run_id)!, deduplicated: true };
    }
    const input = continuationInput(runId);
    if (input.businessContract) {
      const checkpoint = buildBusinessCheckpoint(runId);
      const result = submitExecutionOrchestration({ ...input, entryVersion: 1, previewId: body.previewId, orchestrationFingerprint: body.orchestrationFingerprint }, input.conversationId!, 'conversation_message', checkpoint);
      saveBusinessCheckpoint(result.run.id, checkpoint);
      carryTokenCharges(result.run.id, checkpoint);
      const manifest = { version: 2, kind: 'business_stages', sourceRunId: runId, checkpointDigest: checkpointDigest(checkpoint),
        confirmation: stableDigest(body), outputs: checkpoint.outputs.map(o => ({ agentId: o.agentId, objective: o.objective, actionKind: 'answer' })) };
      run('INSERT INTO orchestration_run_continuations(source_run_id,target_run_id,source_dispatch_id,manifest,created_at) VALUES (?,?,?,?,?)',
        runId, result.run.id, 'business-stages', JSON.stringify(manifest), new Date().toISOString());
      return { run: result.run, deduplicated: result.deduplicated };
    }
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
    const manifest = { version: 1, sourceRunId: runId, sourceDispatchId: failed.id, confirmation: stableDigest(body),
      originalObjective: getRun(runId)!.goal, pendingObjective: sourceMessage.body, outputs };
    const costs = costCarry(runId);
    if (input.constraints?.costPolicy && body.costCarryDigest !== stableDigest(costs)) throw new OrchestrationError(409, 'COST_CARRY_STALE', '费用账本已变化，请重新预览续跑');
    const result = submitExecutionOrchestration({ ...input, entryVersion: 1, previewId: body.previewId, orchestrationFingerprint: body.orchestrationFingerprint }, input.conversationId!);
    carryTokenCharges(result.run.id, { costs, runTokens: get<{n:number}>("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) n FROM orchestration_token_reservations WHERE run_id=?",runId)!.n, stageTokens: [] });
    run(`INSERT INTO orchestration_run_continuations(source_run_id,target_run_id,source_dispatch_id,manifest,created_at)
      VALUES (?,?,?,?,?)`, runId, result.run.id, failed.id, JSON.stringify(manifest), new Date().toISOString());
    return { run: result.run, deduplicated: result.deduplicated };
  });
}

export function carryTokenCharges(runId: string, checkpoint: Pick<BusinessCheckpoint, 'runTokens' | 'stageTokens' | 'recovery' | 'costs'>): void {
  carryCosts(runId, checkpoint.costs ?? []);
  const now = new Date().toISOString();
  const runUnknown=checkpoint.recovery?.runUnknownTokens??0;
  if (checkpoint.runTokens>runUnknown) run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,used,status,created_at) VALUES (?,?,?,?,'settled',?)", randomUUID(), runId, checkpoint.runTokens-runUnknown, checkpoint.runTokens-runUnknown, now);
  if(runUnknown)run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,?,'carried_unknown',?)",randomUUID(),runId,runUnknown,now);
  for (const item of checkpoint.stageTokens) {
    const unknown=checkpoint.recovery?.stageUnknownTokens.find(s=>s.stageId===item.stageId)?.tokens??0;
    if(item.charged>unknown)run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,used,status,created_at) VALUES (?,?,?,?,?,'settled',?)", randomUUID(), runId, item.stageId, item.charged-unknown, item.charged-unknown, now);
    if(unknown)run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES (?,?,?,?,'carried_unknown',?)",randomUUID(),runId,item.stageId,unknown,now);
  }
}
