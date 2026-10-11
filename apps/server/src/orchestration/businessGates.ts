import type { BusinessStage, CoordinationPlanStep, RuntimeEvidenceRef } from '@agent-gand/shared';
import { all, get } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { getRunCoordinationPlan, listCoordinationStepStates } from '../coordination/store.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { OrchestrationError } from './normalize.ts';
import { checkpointOutput, readBusinessCheckpoint } from './businessCheckpointStore.ts';
import { getManagedArtifact } from '../artifacts/store.ts';

export function stageForStep(runId: string, step: CoordinationPlanStep): BusinessStage | undefined {
  const contract = getRunOrchestrationSnapshot(runId)?.request.businessContract;
  return contract?.executionMode === 'stage_gated' ? contract.stages.find(s => s.id === step.metadata.businessStageId) : undefined;
}
export function isBusinessGate(step: CoordinationPlanStep): boolean {
  return step.type === 'completion_gate' && step.metadata.businessAcceptanceGate === true;
}
export function stageAccepted(runId: string, stageId: string): boolean {
  return Boolean(readBusinessCheckpoint(runId)?.accepted.some(item => item.stageId === stageId) || get(`SELECT 1 FROM business_acceptance_events WHERE run_id=? AND json_extract(payload,'$.stageId')=?
    AND json_extract(payload,'$.decision.verdict')='accept' LIMIT 1`, runId, stageId));
}
/** Quiescence is stricter than an empty ready queue; unknown effects cannot be accepted. */
export function businessProcessesQuiescent(runId: string): boolean {
  return !get(`SELECT 1 FROM external_agent_executions WHERE run_id=? AND
    (status='running' OR json_extract(record,'$.recovery.state')='attention' OR (status='interrupted' AND COALESCE(json_extract(record,'$.recovery.state'),'')!='quiesced')) LIMIT 1`, runId)
    && !get("SELECT 1 FROM external_native_processes p JOIN external_agent_executions e ON p.execution_id=e.id WHERE e.run_id=? AND p.status='active' LIMIT 1", runId)
    && !['collaboration_attempts', 'coordination_step_attempts', 'task_attempts'].some(table => get(`SELECT 1 FROM ${table} WHERE run_id=? AND status='running' LIMIT 1`, runId))
    && !get("SELECT 1 FROM tool_executions WHERE run_id=? AND status='running' LIMIT 1",runId);
}
export function businessQuiescent(runId: string, includeUsage = false): boolean {
  return businessProcessesQuiescent(runId)
    && !get("SELECT 1 FROM tool_executions WHERE run_id=? AND (status IN ('running','needs_attention') OR (replay_policy='manual' AND status IN ('failed','interrupted'))) LIMIT 1", runId)
    && (!includeUsage || !['orchestration_token_reservations', 'business_stage_token_reservations'].some(table => get(`SELECT 1 FROM ${table} WHERE run_id=? AND status IN ('pending','unknown') LIMIT 1`, runId)))
    && !get("SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND recovery_attention=1", runId);
}
export function waitingBusinessGate(runId: string): CoordinationPlanStep | undefined {
  const plan = getRunCoordinationPlan(runId);
  if (!plan || getRunOrchestrationSnapshot(runId)?.request.businessContract?.executionMode !== 'stage_gated') return undefined;
  const states = listCoordinationStepStates(plan.id);
  return plan.steps.find(step => isBusinessGate(step) && states.find(s => s.stepId === step.id)?.status !== 'completed'
    && step.dependsOn.every(id => states.find(s => s.stepId === id)?.status === 'completed'));
}
export function canAcceptStage(runId: string, stageId: string): boolean {
  const status = getRun(runId)?.status ?? '';
  return (status === 'waiting_for_user' && getRunCoordinationPlan(runId)?.status === 'paused' || ['completed', 'failed', 'cancelled'].includes(status))
    && waitingBusinessGate(runId)?.metadata.businessStageId === stageId && businessQuiescent(runId, true);
}
export function assertBusinessGateResume(runId: string): void {
  const gate = waitingBusinessGate(runId);
  if (gate && !stageAccepted(runId, String(gate.metadata.businessStageId))) {
    throw new OrchestrationError(409, 'BUSINESS_STAGE_ACCEPTANCE_REQUIRED', '本阶段等待业务验收；请关联交付证据并逐项验收，普通恢复不能跳过阶段门禁');
  }
  if (gate && !businessQuiescent(runId, true)) throw new OrchestrationError(409, 'BUSINESS_STAGE_NOT_QUIESCENT', '已验收阶段存在尚未收敛的执行或未知调用消耗，不能继续派发');
}
/** Gated text evidence must be an actual completed worker attempt in this frozen stage. */
export function assertStageEvidence(runId: string, stageId: string, ref: RuntimeEvidenceRef): void {
  const plan = getRunCoordinationPlan(runId);
  const invalid = () => { throw new OrchestrationError(409, 'STAGE_EVIDENCE_MISMATCH', '交付证据必须属于当前阶段已完成的成员步骤或当前计划工作区'); };
  if (!plan) return invalid();
  if (ref.kind === 'workspace_file') {
    if (ref.artifactId) {
      const file=getManagedArtifact(ref.artifactId);
      if (file.runId!==runId || file.stageId!==stageId || file.version!==ref.artifactVersion || file.sha256!==ref.sha256) invalid();
      return;
    }
    if (ref.workspaceScope !== plan.id.slice(0, 8)) invalid();
    return;
  }
  if (ref.kind !== 'attempt_output') return invalid();
  const imported = checkpointOutput(runId, ref.id);
  if (imported) { if (imported.stageId !== stageId) invalid(); return; }
  const attempt = get<{ step_id: string }>("SELECT step_id FROM coordination_step_attempts WHERE id=? AND run_id=? AND plan_id=? AND revision=? AND status='completed'", ref.id, runId, plan.id, plan.revision);
  if (!attempt || !plan.steps.some(s => s.id === attempt.step_id && s.agentId && s.metadata.businessStageId === stageId)) invalid();
}
export function stageExecutionState(runId: string, stage: BusinessStage) {
  const plan = getRunCoordinationPlan(runId);
  const states = plan ? listCoordinationStepStates(plan.id) : [];
  const workers = plan?.steps.filter(s => s.agentId && s.metadata.businessStageId === stage.id) ?? [];
  const selected = workers.flatMap(s => states.filter(state => state.stepId === s.id));
  const timing = get<{ started_at: string; completed_at: string | null }>('SELECT * FROM business_stage_executions WHERE run_id=? AND stage_id=?', runId, stage.id);
  const budget = get<{ charged: number; unknown: number }>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,
    COALESCE(SUM(CASE WHEN status IN ('unknown','carried_unknown') THEN 1 ELSE 0 END),0) unknown FROM business_stage_token_reservations WHERE run_id=? AND stage_id=?`, runId, stage.id)!;
  const status = stageAccepted(runId, stage.id) ? 'accepted' : selected.some(s => s.status === 'failed') ? 'failed'
    : selected.length === workers.length && workers.length > 0 && selected.every(s => s.status === 'completed')
      || !workers.length && waitingBusinessGate(runId)?.metadata.businessStageId === stage.id ? 'waiting_acceptance'
    : timing ? 'running' : 'pending';
  return { status: status as 'accepted' | 'failed' | 'waiting_acceptance' | 'running' | 'pending', startedAt: timing?.started_at ?? null,
    completedAt: timing?.completed_at ?? null, canAccept: canAcceptStage(runId, stage.id), chargedTokens: budget.charged, unknownCalls: budget.unknown };
}
/** Accepted ledger entries are durable wake authorization, including a crash before HTTP wake. */
export function acceptedBusinessGateRuns(): string[] {
  return all<{ run_id: string }>("SELECT p.run_id FROM coordination_plans p JOIN runs r ON r.id=p.run_id WHERE p.status='paused' AND r.status='waiting_for_user'")
    .flatMap(row => { const gate = waitingBusinessGate(row.run_id); return gate && stageAccepted(row.run_id, String(gate.metadata.businessStageId)) && businessQuiescent(row.run_id, true) ? [row.run_id] : []; });
}
