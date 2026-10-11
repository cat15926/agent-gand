import type { BusinessReworkInput } from '@agent-gand/shared';
import { get, run, tx } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { cancelCoordinationRun } from '../coordination/runtime.ts';
import { buildBusinessCheckpoint } from './businessCheckpoint.ts';
import { checkpointDigest, checkpointSummary, saveBusinessCheckpoint } from './businessCheckpointStore.ts';
import { businessCheckpointInput, carryTokenCharges } from './continuation.ts';
import { previewExecutionOrchestration, submitExecutionOrchestration } from './entry.ts';
import { objectInput, OrchestrationError, stableDigest } from './normalize.ts';

function requireOwner(owner: boolean): void {
  if (!owner) throw new OrchestrationError(403, 'OWNER_REQUIRED', '阶段返工需通过所有者账户管理入口预览和确认');
}
function parseInput(value: unknown, confirmation = false): BusinessReworkInput {
  const body = objectInput(value);
  if (Object.keys(body).some(k => !['stageId', 'reportId', 'expectedVersion', 'instruction', ...(confirmation ? ['previewId', 'orchestrationFingerprint'] : [])].includes(k))
    || typeof body.stageId !== 'string' || !body.stageId || body.stageId.length > 100
    || typeof body.reportId !== 'string' || !body.reportId || body.reportId.length > 100
    || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0
    || typeof body.instruction !== 'string' || !body.instruction.trim() || body.instruction.length > 2000) {
    throw new OrchestrationError(400, 'INVALID_REWORK_INPUT', '返工需指定当前阶段、被拒绝候选和验收版本，并填写不超过 2000 字的修订要求');
  }
  return { stageId: body.stageId, reportId: body.reportId, expectedVersion: body.expectedVersion as number, instruction: body.instruction.trim() };
}

/** No model calls or source changes. Rejected work is never added to the completed-worker whitelist. */
export async function previewBusinessRework(runId: string, value: unknown, owner = false) {
  requireOwner(owner);
  const input = parseInput(value);
  const checkpoint = buildBusinessCheckpoint(runId, input);
  const request = businessCheckpointInput(runId, `business-rework:${runId}`);
  const preview = await previewExecutionOrchestration(request, 'unified_preview', checkpoint);
  const stage = checkpoint.contract.stages.find(s => s.id === input.stageId)!;
  return { input, preview, checkpoint: { ...checkpointSummary(checkpoint),
    acceptedStages: checkpoint.accepted.map(a => ({ id: a.stageId, title: checkpoint.contract.stages.find(s => s.id === a.stageId)!.title })),
    carriedRunTokens: checkpoint.runTokens, carriedStageTokens: checkpoint.stageTokens },
    stage: { id: stage.id, title: stage.title, assignments: stage.execution!.assignments },
    closesWaitingSource: getRun(runId)!.status === 'waiting_for_user' };
}

/** All-or-nothing admission + archive + source closure, with one successor per source Run. */
export function submitBusinessRework(runId: string, value: unknown, owner = false) {
  requireOwner(owner);
  const input = parseInput(value, true), body = objectInput(value);
  if (typeof body.previewId !== 'string' || !body.previewId || typeof body.orchestrationFingerprint !== 'string' || !body.orchestrationFingerprint) {
    throw new OrchestrationError(400, 'REWORK_CONFIRMATION_REQUIRED', '请提交返工预览及其 fingerprint');
  }
  const confirmation = stableDigest({ ...input, previewId: body.previewId, orchestrationFingerprint: body.orchestrationFingerprint });
  return tx(() => {
    const existing = get<{ target_run_id: string; manifest: string }>('SELECT target_run_id,manifest FROM orchestration_run_continuations WHERE source_run_id=?', runId);
    if (existing) {
      const manifest = JSON.parse(existing.manifest);
      if (manifest.kind !== 'business_stage_rework' || manifest.confirmation !== confirmation) throw new OrchestrationError(409, 'IDEMPOTENCY_CONFLICT', '原任务已确认另一份后续计划，请查看既有任务');
      return { run: getRun(existing.target_run_id)!, deduplicated: true };
    }
    const checkpoint = buildBusinessCheckpoint(runId, input);
    const request = businessCheckpointInput(runId, `business-rework:${runId}`);
    const result = submitExecutionOrchestration({ ...request, entryVersion: 1, previewId: body.previewId, orchestrationFingerprint: body.orchestrationFingerprint }, request.conversationId!, 'conversation_message', checkpoint);
    saveBusinessCheckpoint(result.run.id, checkpoint);
    carryTokenCharges(result.run.id, checkpoint);
    const manifest = { version: 2, kind: 'business_stage_rework', sourceRunId: runId, stageId: input.stageId,
      checkpointDigest: checkpointDigest(checkpoint), confirmation,
      outputs: checkpoint.outputs.map(o => ({ agentId: o.agentId, objective: o.objective, actionKind: 'answer' })) };
    run('INSERT INTO orchestration_run_continuations(source_run_id,target_run_id,source_dispatch_id,manifest,created_at) VALUES (?,?,?,?,?)',
      runId, result.run.id, 'business-stage-rework', JSON.stringify(manifest), new Date().toISOString());
    if (getRun(runId)!.status === 'waiting_for_user') {
      const closed = cancelCoordinationRun(runId, 'business_stage_rework');
      if (closed?.status !== 'cancelled') throw new OrchestrationError(409, 'REWORK_SOURCE_NOT_CLOSED', '原执行未能关闭，本次返工准入已回滚');
    }
    return { run: result.run, deduplicated: result.deduplicated };
  });
}
