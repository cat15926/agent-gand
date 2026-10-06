import type { ExecutionBinding, ExternalAgentExecution } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { loadResponsibilitySnapshot } from '../runtime/responsibilitySnapshot.ts';
import { ExecutionError } from './errors.ts';

const stopped = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);
interface CoordinationContext {
  plan_id: string; revision: number; step_id: string; started_at: string; status: string;
  plan_revision: number; plan_status: string; payload: string; step_status: string; attempt_no: number; current_attempt_no: number;
}
function coordinationContext(runId: string, attemptId: string): CoordinationContext | undefined {
  return get<CoordinationContext>(`SELECT a.*,p.revision plan_revision,p.status plan_status,p.payload,
    s.status step_status,s.attempt_no current_attempt_no FROM coordination_step_attempts a
    JOIN coordination_plans p ON p.id=a.plan_id AND p.run_id=a.run_id
    JOIN coordination_step_states s ON s.plan_id=a.plan_id AND s.revision=a.revision AND s.step_id=a.step_id
    WHERE a.id=? AND a.run_id=?`, attemptId, runId);
}
function runtimeAuthorized(binding: Extract<ExecutionBinding, { subjectId: string }>): boolean {
  const snapshot = loadResponsibilitySnapshot({ runId: binding.runId, attemptId: binding.attemptId });
  return !!snapshot && snapshot.subjectId === binding.subjectId && snapshot.contractRevision === binding.contractRevision
    && snapshot.subjectStatus === 'active' && snapshot.custody.state === 'owned'
    && snapshot.custody.holderAgentId === binding.agentId && snapshot.custody.pendingHolderAgentId === null
    && snapshot.custody.generation === binding.generation
    && snapshot.attempt?.id === binding.attemptId && snapshot.attempt.status === 'running'
    && snapshot.attempt.actorId === binding.agentId && snapshot.attempt.leaseValid
    && snapshot.attempt.generation === binding.generation;
}

/** One boundary for model calls, tools, approvals, sessions and late results. */
export function bindingAuthorized(binding: ExecutionBinding): boolean {
  try { return checkBinding(binding); } catch { return false; }
}
/** Only the owning scheduler may close an expired attempt as failed; never permits effects. */
export function bindingCanFailAttempt(binding: ExecutionBinding): boolean {
  try { return checkBinding(binding, true); } catch { return false; }
}
function checkBinding(binding: ExecutionBinding, closeExpired = false): boolean {
  if (binding.schemaVersion !== 1) return false;
  const owner = get<{ status: string }>('SELECT status FROM runs WHERE id=?', binding.runId);
  if (!owner || stopped(owner.status)) return false;
  if (get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND recovery_attention=1', binding.runId)) return false;
  switch (binding.origin) {
    case 'collaboration_attempt':
      return !!get('SELECT 1 FROM collaboration_attempts WHERE id=? AND run_id=? AND agent_id=?', binding.attemptId, binding.runId, binding.agentId)
        && runtimeAuthorized(binding);
    case 'coordination_step_attempt': {
      const context = coordinationContext(binding.runId, binding.attemptId);
      if (!context || context.plan_id !== binding.planId || context.revision !== binding.planRevision
        || context.plan_revision !== binding.planRevision || !['active', 'pause_requested'].includes(context.plan_status)
        || !['running', 'awaiting_approval'].includes(owner.status)
        || context.step_id !== binding.stepId || context.started_at !== binding.startedAt
        || context.status !== 'running' || context.step_status !== 'running' || context.attempt_no !== context.current_attempt_no) return false;
      const step = (JSON.parse(context.payload) as { steps: Array<{ id: string; agentId: string; timeoutMs: number }> }).steps.find(item => item.id === binding.stepId);
      if (!step || step.agentId !== binding.agentId || !Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) return false;
      const deadline = new Date(new Date(context.started_at).getTime() + step.timeoutMs).toISOString();
      if (binding.leaseExpiresAt !== deadline || (!closeExpired && Date.now() >= new Date(deadline).getTime()) || !runtimeAuthorized(binding)) return false;
      return closeExpired || (binding.reviewTargets ?? []).every(target => {
        const snapshot = loadResponsibilitySnapshot({ runId: binding.runId, attemptId: target.attemptId });
        const attempt = coordinationContext(binding.runId, target.attemptId);
        return snapshot?.subjectId === target.subjectId && snapshot.custody.generation === target.generation
          && snapshot.subjectStatus === 'completed' && snapshot.custody.state === 'completed'
          && attempt?.status === 'completed' && attempt.step_status === 'completed'
          && attempt.revision === binding.planRevision && attempt.attempt_no === attempt.current_attempt_no;
      });
    }
    case 'task_attempt': {
      const attempt = get<{ status: string; task_status: string; task_id: string; attempt_no: number; started_at: string; lease_owner: string; lease_expires_at: string | null }>(
        `SELECT a.*,t.status task_status FROM task_attempts a JOIN tasks t ON t.id=a.task_id
         WHERE a.id=? AND a.run_id=? AND a.agent_id=?`, binding.attemptId, binding.runId, binding.agentId);
      const responsibility = binding.responsibility ? loadResponsibilitySnapshot({ runId: binding.runId, attemptId: binding.attemptId }) : null;
      if (binding.responsibility && (!responsibility || responsibility.subjectId !== binding.responsibility.subjectId
        || responsibility.contractRevision !== binding.responsibility.contractRevision
        || responsibility.subjectStatus !== 'active' || responsibility.custody.state !== 'owned'
        || responsibility.custody.generation !== binding.responsibility.generation
        || responsibility.custody.holderAgentId !== binding.agentId
        || responsibility.attempt?.generation !== binding.responsibility.generation)) return false;
      if (!binding.responsibility && get("SELECT 1 FROM runtime_contracts WHERE run_id=? AND json_extract(payload,'$.features.orchestrationAdapter')=1", binding.runId)) return false;
      return !!attempt && attempt.status === 'running' && !stopped(attempt.task_status)
        && attempt.task_id === binding.taskId && attempt.attempt_no === binding.generation
        && attempt.started_at === binding.startedAt && attempt.lease_owner === binding.leaseOwner
        && !!attempt.lease_expires_at && new Date(attempt.lease_expires_at).getTime() > Date.now();
    }
    default: return false;
  }
}
export function assertBindingAuthorized(binding?: ExecutionBinding): void {
  if (binding && !bindingAuthorized(binding)) throw new ExecutionError('cancelled', '执行绑定已失效（attempt、责任代际、租约或计划版本已变化）');
}

/** Captured from trusted scheduler rows before invocation; persisted metadata has no authority. */
export function captureExecutionBinding(runId: string, agentId: string, attemptId: string): ExecutionBinding {
  return tx(() => {
    const snapshot = loadResponsibilitySnapshot({ runId, attemptId });
    const common = { schemaVersion: 1 as const, runId, agentId, attemptId };
    let binding: ExecutionBinding;
    if (get('SELECT 1 FROM collaboration_attempts WHERE id=? AND run_id=?', attemptId, runId)) {
      if (!snapshot) throw new ExecutionError('policy_rejected', 'Collaboration attempt 缺少 Runtime 责任绑定');
      binding = { ...common, origin: 'collaboration_attempt', id: `collaboration:${attemptId}:g${snapshot.custody.generation}`,
        subjectId: snapshot.subjectId, generation: snapshot.custody.generation, contractRevision: snapshot.contractRevision };
    } else {
      const context = coordinationContext(runId, attemptId);
      if (context) {
        if (!snapshot) throw new ExecutionError('policy_rejected', 'Coordination attempt 缺少 execute Runtime 责任绑定');
        const plan = JSON.parse(context.payload) as { steps: Array<{ id: string; timeoutMs: number; type: string; dependsOn: string[]; metadata: { reviewTargetStepIds?: string[] } }> };
        const step = plan.steps.find(item => item.id === context.step_id);
        if (!step || !Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0) throw new ExecutionError('policy_rejected', 'Coordination 步骤执行期限无效');
        const reviewTargets = step.type === 'review' ? (step.metadata.reviewTargetStepIds ?? step.dependsOn).map(stepId => {
          const row = get<{ id: string }>(`SELECT a.id FROM coordination_step_attempts a JOIN coordination_step_states s
            ON s.plan_id=a.plan_id AND s.revision=a.revision AND s.step_id=a.step_id AND s.attempt_no=a.attempt_no
            WHERE a.plan_id=? AND a.revision=? AND a.step_id=? AND a.status='completed' AND s.status='completed'`, context.plan_id, context.revision, stepId);
          const target = row ? loadResponsibilitySnapshot({ runId, attemptId: row.id }) : null;
          if (!row || !target) throw new ExecutionError('policy_rejected', `评审目标 ${stepId} 缺少冻结的责任结果`);
          return { attemptId: row.id, subjectId: target.subjectId, generation: target.custody.generation };
        }) : undefined;
        binding = { ...common, origin: 'coordination_step_attempt', id: `coordination:${attemptId}:g${snapshot.custody.generation}`,
          subjectId: snapshot.subjectId, generation: snapshot.custody.generation, contractRevision: snapshot.contractRevision,
          planId: context.plan_id, planRevision: context.revision, stepId: context.step_id, startedAt: context.started_at,
          leaseExpiresAt: new Date(new Date(context.started_at).getTime() + step.timeoutMs).toISOString(), ...(reviewTargets ? { reviewTargets } : {}) };
      } else {
        const attempt = get<{ task_id: string; attempt_no: number; started_at: string; lease_owner: string }>(
          'SELECT * FROM task_attempts WHERE id=? AND run_id=? AND agent_id=?', attemptId, runId, agentId);
        if (!attempt) throw new ExecutionError('policy_rejected', '未知的执行 attempt，拒绝按 Run 模式猜测权限');
        binding = { ...common, origin: 'task_attempt', id: `task:${attemptId}:g${attempt.attempt_no}`,
          taskId: attempt.task_id, generation: attempt.attempt_no, startedAt: attempt.started_at, leaseOwner: attempt.lease_owner,
          ...(snapshot ? { responsibility: { subjectId: snapshot.subjectId, generation: snapshot.custody.generation,
            contractRevision: snapshot.contractRevision } } : {}) };
      }
    }
    assertBindingAuthorized(binding);
    const existing = get<{ record: string }>('SELECT record FROM execution_bindings WHERE id=?', binding.id);
    if (existing) { const stored = JSON.parse(existing.record) as ExecutionBinding; assertBindingAuthorized(stored); return stored; }
    run('INSERT INTO execution_bindings (id,run_id,origin,attempt_id,generation,record) VALUES (?,?,?,?,?,?)',
      binding.id, runId, binding.origin, attemptId, binding.generation, JSON.stringify(binding));
    return binding;
  });
}
export function saveBindingSnapshot(binding: ExecutionBinding, snapshot: ExecutionBinding['workspaceSnapshot']): void {
  assertBindingAuthorized(binding);
  run('UPDATE execution_bindings SET record=?,completed_at=? WHERE id=?', JSON.stringify({ ...binding, workspaceSnapshot: snapshot }), new Date().toISOString(), binding.id);
}
export function coordinationReviewSnapshot(binding: ExecutionBinding): ExecutionBinding['workspaceSnapshot'] {
  if (binding.origin !== 'coordination_step_attempt' || !binding.reviewTargets?.length) return undefined;
  const ids = new Set(binding.reviewTargets.map(target => target.attemptId));
  return all<{ record: string }>('SELECT record FROM execution_bindings WHERE run_id=? AND completed_at IS NOT NULL ORDER BY completed_at DESC,rowid DESC', binding.runId)
    .map(row => JSON.parse(row.record) as ExecutionBinding).find(item => ids.has(item.attemptId) && item.workspaceSnapshot)?.workspaceSnapshot;
}

/** Shared by native approvals, bridge callbacks and the execution lifetime fence. */
export function executionAuthorized(execution: ExternalAgentExecution): boolean {
  const current = get<{ status: string }>('SELECT status FROM external_agent_executions WHERE id=?', execution.id);
  const run = get<{ status: string; mode: string }>('SELECT status,mode FROM runs WHERE id=?', execution.runId);
  if (current?.status !== 'running' || !run || ['completed', 'failed', 'cancelled'].includes(run.status)) return false;
  if (execution.executionBinding) return execution.executionBinding.runId === execution.runId
    && execution.executionBinding.agentId === execution.agentId && execution.executionBinding.attemptId === execution.attemptId
    && bindingAuthorized(execution.executionBinding);
  if (get('SELECT 1 FROM coordination_plans WHERE run_id=?', execution.runId)) return false;
  if (run.mode === 'collaboration') {
    if (!execution.attemptId || !execution.runtimeBinding) return false;
    const snapshot = loadResponsibilitySnapshot({ runId: execution.runId, attemptId: execution.attemptId });
    return !!snapshot && snapshot.subjectId === execution.runtimeBinding.subjectId
      && snapshot.contractRevision === execution.runtimeBinding.contractRevision
      && snapshot.subjectStatus === 'active' && snapshot.custody.state === 'owned'
      && snapshot.custody.holderAgentId === execution.agentId && snapshot.custody.pendingHolderAgentId === null
      && snapshot.custody.generation === execution.runtimeBinding.generation
      && snapshot.attempt?.id === execution.attemptId && snapshot.attempt.status === 'running'
      && snapshot.attempt.actorId === execution.agentId && snapshot.attempt.leaseValid
      && snapshot.attempt.generation === snapshot.custody.generation;
  }
  if (!execution.attemptId) return true;
  const attempt = get<{ status: string; task_status: string; lease_expires_at: string | null }>('SELECT a.status,t.status AS task_status,a.lease_expires_at FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND a.run_id=? AND a.agent_id=?', execution.attemptId, execution.runId, execution.agentId);
  return attempt?.status === 'running' && !stopped(attempt.task_status)
    && !!attempt.lease_expires_at && new Date(attempt.lease_expires_at).getTime() > Date.now();
}
