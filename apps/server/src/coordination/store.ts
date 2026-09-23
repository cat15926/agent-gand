import { randomUUID } from 'node:crypto';
import type {
  CapabilitySnapshot,
  CoordinationDraft,
  CoordinationEvent,
  CoordinationEventKind,
  CoordinationPlan,
  CoordinationPlanRevision,
  CoordinationPlanStep,
  CoordinationStepAttempt,
  CoordinationStepState,
} from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import {
  admitCoordinationKernelPlan,
  observeCoordinationClaim,
  observeCoordinationComplete,
  observeCoordinationFailure,
  observeCoordinationPause,
  observeCoordinationRevision,
} from '../runtime/coordinationAdapter.ts';

interface PayloadRow { payload: string }
interface EventRow {
  id: string;
  kind: CoordinationEventKind;
  draft_id: string | null;
  plan_id: string | null;
  run_id: string | null;
  payload: string;
  created_at: string;
}
interface StepStateRow { plan_id: string; run_id: string; revision: number; step_id: string; status: CoordinationStepState['status']; attempt_no: number; output: string | null; error: string | null; started_at: string | null; completed_at: string | null; updated_at: string }
interface StepAttemptRow { id: string; plan_id: string; run_id: string; revision: number; step_id: string; attempt_no: number; status: CoordinationStepAttempt['status']; idempotency_key: string; input: string | null; output: string | null; error: string | null; span_id: string | null; created_at: string; started_at: string; ended_at: string | null }

function parse<T>(row: PayloadRow | undefined): T | undefined {
  return row ? JSON.parse(row.payload) as T : undefined;
}

export function recordCoordinationEvent(input: Omit<CoordinationEvent, 'id' | 'createdAt'>): CoordinationEvent {
  const event: CoordinationEvent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  run('INSERT INTO coordination_events (id,kind,draft_id,plan_id,run_id,payload,created_at) VALUES (?,?,?,?,?,?,?)',
    event.id, event.kind, event.draftId, event.planId, event.runId, JSON.stringify(event.payload), event.createdAt);
  return event;
}

const mapStepState = (row: StepStateRow): CoordinationStepState => ({
  planId: row.plan_id, runId: row.run_id, revision: row.revision, stepId: row.step_id, status: row.status,
  attemptNo: row.attempt_no, output: row.output, error: row.error, startedAt: row.started_at,
  completedAt: row.completed_at, updatedAt: row.updated_at,
});

const mapStepAttempt = (row: StepAttemptRow): CoordinationStepAttempt => ({
  id: row.id, planId: row.plan_id, runId: row.run_id, revision: row.revision, stepId: row.step_id,
  attemptNo: row.attempt_no, status: row.status, idempotencyKey: row.idempotency_key, input: row.input,
  output: row.output, error: row.error, spanId: row.span_id, createdAt: row.created_at,
  startedAt: row.started_at, endedAt: row.ended_at,
});

function emitStep(row: StepStateRow): CoordinationStepState {
  const step = mapStepState(row);
  emit({ type: 'coordination.step.updated', step });
  return step;
}

export function savePlanningResult(snapshot: CapabilitySnapshot, draft: CoordinationDraft, plan: CoordinationPlan): void {
  tx(() => {
    run('INSERT INTO capability_snapshots (id,payload,created_at) VALUES (?,?,?)', snapshot.id, JSON.stringify(snapshot), snapshot.createdAt);
    run('INSERT INTO coordination_drafts (id,capability_snapshot_id,payload,created_at) VALUES (?,?,?,?)', draft.id, snapshot.id, JSON.stringify(draft), draft.createdAt);
    run(`INSERT INTO coordination_plans (id,run_id,draft_id,capability_snapshot_id,revision,status,payload,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, plan.id, plan.runId, plan.draftId, plan.capabilitySnapshotId, plan.revision, plan.status, JSON.stringify(plan), plan.createdAt, plan.updatedAt);
    const revision: CoordinationPlanRevision = {
      planId: plan.id, revision: 1, trigger: 'initial', previousRevision: null,
      diffSummary: `Initial ${draft.planning.source} compilation`, plan, createdAt: plan.createdAt,
    };
    run('INSERT INTO coordination_plan_revisions (plan_id,revision,trigger_kind,payload,created_at) VALUES (?,?,?,?,?)',
      plan.id, revision.revision, revision.trigger, JSON.stringify(revision), revision.createdAt);
    recordCoordinationEvent({ kind: 'snapshot_created', draftId: draft.id, planId: plan.id, runId: null, payload: { snapshotId: snapshot.id } });
    recordCoordinationEvent({ kind: 'draft_created', draftId: draft.id, planId: plan.id, runId: null, payload: { protocols: draft.protocols, decision: draft.decision, planning: draft.planning } });
    recordCoordinationEvent({ kind: draft.validationErrors.length === 0 ? 'draft_validated' : 'draft_rejected', draftId: draft.id, planId: plan.id, runId: null, payload: { issues: draft.validationIssues } });
    recordCoordinationEvent({ kind: 'plan_compiled', draftId: draft.id, planId: plan.id, runId: null, payload: { stepCount: plan.steps.length, revision: plan.revision } });
    recordCoordinationEvent({ kind: plan.validationIssues.some((item) => item.severity === 'error') ? 'plan_rejected' : 'plan_validated', draftId: draft.id, planId: plan.id, runId: null, payload: { issues: plan.validationIssues } });
  });
}

export function getCapabilitySnapshot(id: string): CapabilitySnapshot | undefined {
  return parse<CapabilitySnapshot>(get<PayloadRow>('SELECT payload FROM capability_snapshots WHERE id=?', id));
}

export function getCoordinationDraft(id: string): CoordinationDraft | undefined {
  return parse<CoordinationDraft>(get<PayloadRow>('SELECT payload FROM coordination_drafts WHERE id=?', id));
}

export function getCoordinationPlan(id: string): CoordinationPlan | undefined {
  return parse<CoordinationPlan>(get<PayloadRow>('SELECT payload FROM coordination_plans WHERE id=?', id));
}

export function getDraftCoordinationPlan(draftId: string): CoordinationPlan | undefined {
  return parse<CoordinationPlan>(get<PayloadRow>('SELECT payload FROM coordination_plans WHERE draft_id=?', draftId));
}

export function getRunCoordinationPlan(runId: string): CoordinationPlan | undefined {
  return parse<CoordinationPlan>(get<PayloadRow>('SELECT payload FROM coordination_plans WHERE run_id=?', runId));
}

/** Follow-up Router 用：该聊天室是否有过 Coordination Plan（结构化追问值得重新规划的历史信号） */
export function conversationHasCoordinationPlan(conversationId: string): boolean {
  const row = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM coordination_plans p JOIN runs r ON r.id = p.run_id WHERE r.conversation_id = ?',
    conversationId,
  );
  return (row?.n ?? 0) > 0;
}

export function activateCoordinationPlan(planId: string, runId: string): CoordinationPlan | undefined {
  return tx(() => {
    const plan = getCoordinationPlan(planId);
    if (!plan || plan.runId !== null || plan.status !== 'draft') return undefined;
    const updated: CoordinationPlan = { ...plan, runId, status: 'validated', updatedAt: new Date().toISOString() };
    run('UPDATE coordination_plans SET run_id=?,status=?,payload=?,updated_at=? WHERE id=? AND run_id IS NULL AND status=?',
      runId, updated.status, JSON.stringify(updated), updated.updatedAt, planId, 'draft');
    for (const step of plan.steps) run(`INSERT INTO coordination_step_states
      (plan_id,run_id,revision,step_id,status,attempt_no,output,error,started_at,completed_at,updated_at)
      VALUES (?,?,?,?,?,0,NULL,NULL,NULL,NULL,?)`, planId, runId, plan.revision, step.id, step.dependsOn.length === 0 ? 'ready' : 'pending', updated.updatedAt);
    admitCoordinationKernelPlan(updated);
    recordCoordinationEvent({ kind: 'plan_activated', draftId: plan.draftId, planId, runId, payload: { revision: plan.revision } });
    return updated;
  });
}

export function setCoordinationPlanStatus(planId: string, status: CoordinationPlan['status']): CoordinationPlan | undefined {
  const plan = getCoordinationPlan(planId);
  if (!plan) return undefined;
  const updated = { ...plan, status, updatedAt: new Date().toISOString() };
  run('UPDATE coordination_plans SET status=?,payload=?,updated_at=? WHERE id=?', status, JSON.stringify(updated), updated.updatedAt, planId);
  return updated;
}

export function listCoordinationStepStates(planId: string): CoordinationStepState[] {
  const revision = getCoordinationPlan(planId)?.revision;
  return (revision === undefined
    ? all<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? ORDER BY rowid', planId)
    : all<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? ORDER BY rowid', planId, revision)).map(mapStepState);
}

export function listCoordinationStepAttempts(planId: string): CoordinationStepAttempt[] {
  return all<StepAttemptRow>('SELECT * FROM coordination_step_attempts WHERE plan_id=? ORDER BY created_at,rowid', planId).map(mapStepAttempt);
}

export function prepareCoordinationReadySteps(plan: CoordinationPlan): CoordinationStepState[] {
  const changed: StepStateRow[] = [];
  tx(() => {
    const states = all<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? ORDER BY rowid', plan.id, plan.revision);
    const byId = new Map(states.map((state) => [state.step_id, state]));
    const now = new Date().toISOString();
    for (const step of plan.steps) {
      const state = byId.get(step.id);
      if (!state || state.status !== 'pending') continue;
      if (step.dependsOn.every((id) => byId.get(id)?.status === 'completed')) {
        run("UPDATE coordination_step_states SET status='ready',updated_at=? WHERE plan_id=? AND revision=? AND step_id=? AND status='pending'", now, plan.id, plan.revision, step.id);
        const row = get<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, step.id);
        if (row) changed.push(row);
      }
    }
  });
  for (const row of changed) {
    emitStep(row);
    recordCoordinationEvent({ kind: 'step_ready', draftId: plan.draftId, planId: plan.id, runId: plan.runId, payload: { stepId: row.step_id } });
  }
  return listCoordinationStepStates(plan.id).filter((state) => state.status === 'ready');
}

export function claimCoordinationStep(plan: CoordinationPlan, step: CoordinationPlanStep, input: string): { state: CoordinationStepState; attempt: CoordinationStepAttempt } | null {
  const result = tx(() => {
    const state = get<StepStateRow>("SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=? AND status='ready'", plan.id, plan.revision, step.id);
    if (!state || !plan.runId) return null;
    // interrupted（进程重启）/ paused（审批暂停，AG-COORD-04）复用同一 attempt 行，不额外烧 attempt 号
    const reusable = state.attempt_no > 0 ? get<StepAttemptRow>("SELECT * FROM coordination_step_attempts WHERE plan_id=? AND revision=? AND step_id=? AND attempt_no=? AND status IN ('interrupted','paused')", plan.id, plan.revision, step.id, state.attempt_no) : undefined;
    const attemptNo = reusable ? state.attempt_no : state.attempt_no + 1;
    const now = new Date().toISOString();
    let attempt: StepAttemptRow;
    if (reusable) {
      run("UPDATE coordination_step_attempts SET status='running',output=NULL,error=NULL,span_id=NULL,started_at=?,ended_at=NULL WHERE id=?", now, reusable.id);
      attempt = get<StepAttemptRow>('SELECT * FROM coordination_step_attempts WHERE id=?', reusable.id)!;
    } else {
      const id = randomUUID();
      const key = `coordination:${plan.id}:${plan.revision}:${step.id}:${attemptNo}`;
      run(`INSERT INTO coordination_step_attempts (id,plan_id,run_id,revision,step_id,attempt_no,status,idempotency_key,input,output,error,span_id,created_at,started_at,ended_at)
        VALUES (?,?,?,?,?,?,'running',?,?,NULL,NULL,NULL,?,?,NULL)`, id, plan.id, plan.runId, plan.revision, step.id, attemptNo, key, input, now, now);
      attempt = get<StepAttemptRow>('SELECT * FROM coordination_step_attempts WHERE id=?', id)!;
    }
    run("UPDATE coordination_step_states SET status='running',attempt_no=?,error=NULL,started_at=COALESCE(started_at,?),updated_at=? WHERE plan_id=? AND revision=? AND step_id=?", attemptNo, now, now, plan.id, plan.revision, step.id);
    observeCoordinationClaim(plan, step, attempt.id);
    return { state: get<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, step.id)!, attempt };
  });
  if (!result) return null;
  const state = emitStep(result.state);
  recordCoordinationEvent({ kind: 'step_started', draftId: plan.draftId, planId: plan.id, runId: plan.runId, payload: { stepId: step.id, attemptNo: result.attempt.attempt_no } });
  return { state, attempt: mapStepAttempt(result.attempt) };
}

export function setCoordinationAttemptSpan(attemptId: string, spanId: string): void {
  run('UPDATE coordination_step_attempts SET span_id=? WHERE id=?', spanId, attemptId);
}

export function setCoordinationAttemptInput(attemptId: string, input: string): void {
  run('UPDATE coordination_step_attempts SET input=? WHERE id=?', input, attemptId);
}

export function completeCoordinationStep(plan: CoordinationPlan, stepId: string, attemptId: string, output: string): CoordinationStepState {
  const row = tx(() => {
    const now = new Date().toISOString();
    run("UPDATE coordination_step_attempts SET status='completed',output=?,error=NULL,ended_at=? WHERE id=?", output, now, attemptId);
    const step = plan.steps.find((item) => item.id === stepId);
    if (step) observeCoordinationComplete(plan, step, attemptId);
    run("UPDATE coordination_step_states SET status='completed',output=?,error=NULL,completed_at=?,updated_at=? WHERE plan_id=? AND revision=? AND step_id=?", output, now, now, plan.id, plan.revision, stepId);
    return get<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, stepId)!;
  });
  const state = emitStep(row);
  recordCoordinationEvent({ kind: 'step_completed', draftId: plan.draftId, planId: plan.id, runId: plan.runId, payload: { stepId, attemptNo: state.attemptNo } });
  return state;
}

export function failCoordinationStep(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string, message: string, retry: boolean): CoordinationStepState {
  const row = tx(() => {
    const now = new Date().toISOString();
    run("UPDATE coordination_step_attempts SET status='failed',error=?,ended_at=? WHERE id=?", message, now, attemptId);
    observeCoordinationFailure(plan, step, attemptId, retry);
    run('UPDATE coordination_step_states SET status=?,error=?,updated_at=? WHERE plan_id=? AND revision=? AND step_id=?', retry ? 'ready' : 'failed', message, now, plan.id, plan.revision, step.id);
    return get<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, step.id)!;
  });
  const state = emitStep(row);
  recordCoordinationEvent({ kind: retry ? 'step_retry_scheduled' : 'step_failed', draftId: plan.draftId, planId: plan.id, runId: plan.runId, payload: { stepId: step.id, attemptNo: state.attemptNo, error: message } });
  return state;
}

/**
 * AG-COORD-04：暂停时释放步骤——attempt 置 paused、状态回 ready，
 * 不烧 attempt 失败、不占 maxAttempts；恢复时 claimCoordinationStep 复用原 attempt 行。
 */
export function releaseCoordinationStep(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string, reason: string): CoordinationStepState {
  const row = tx(() => {
    const now = new Date().toISOString();
    run("UPDATE coordination_step_attempts SET status='paused',error=?,ended_at=? WHERE id=?", reason, now, attemptId);
    observeCoordinationPause(plan, step, attemptId);
    run("UPDATE coordination_step_states SET status='ready',error=?,updated_at=? WHERE plan_id=? AND revision=? AND step_id=?", reason, now, plan.id, plan.revision, step.id);
    return get<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, step.id)!;
  });
  const state = emitStep(row);
  recordCoordinationEvent({ kind: 'step_paused', draftId: plan.draftId, planId: plan.id, runId: plan.runId, payload: { stepId: step.id, attemptNo: state.attemptNo, reason } });
  return state;
}

export function scheduleCoordinationRevision(plan: CoordinationPlan, reviewStep: CoordinationPlanStep, attemptId: string, targetStepIds: string[], feedback: string): void {
  const changed: StepStateRow[] = [];
  tx(() => {
    const now = new Date().toISOString();
    run("UPDATE coordination_step_attempts SET status='completed',output=?,error=NULL,ended_at=? WHERE id=?", feedback, now, attemptId);
    observeCoordinationRevision(plan, reviewStep, attemptId, targetStepIds);
    run("UPDATE coordination_step_states SET status='pending',output=?,error=NULL,completed_at=NULL,updated_at=? WHERE plan_id=? AND revision=? AND step_id=?", feedback, now, plan.id, plan.revision, reviewStep.id);
    for (const targetId of targetStepIds) run("UPDATE coordination_step_states SET status='ready',output=NULL,error=?,completed_at=NULL,updated_at=? WHERE plan_id=? AND revision=? AND step_id=?", feedback, now, plan.id, plan.revision, targetId);
    for (const stepId of [...targetStepIds, reviewStep.id]) {
      const row = get<StepStateRow>('SELECT * FROM coordination_step_states WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, stepId);
      if (row) changed.push(row);
    }
  });
  changed.forEach(emitStep);
  recordCoordinationEvent({ kind: 'step_retry_scheduled', draftId: plan.draftId, planId: plan.id, runId: plan.runId, payload: { stepId: reviewStep.id, targetStepIds, feedback } });
}

export function recoverInterruptedCoordinationSteps(): string[] {
  return tx(() => {
    const activePlans = all<{ id: string; run_id: string; status: CoordinationPlan['status']; payload: string }>("SELECT id,run_id,status,payload FROM coordination_plans WHERE status IN ('active','pause_requested') AND run_id IS NOT NULL");
    const now = new Date().toISOString();
    for (const plan of activePlans) {
      run("UPDATE coordination_step_attempts SET status='interrupted',error='process_restarted',ended_at=? WHERE plan_id=? AND status='running'", now, plan.id);
      run("UPDATE coordination_step_states SET status='ready',error='process_restarted',updated_at=? WHERE plan_id=? AND status='running'", now, plan.id);
      run("UPDATE run_events SET status='error',output=COALESCE(output,'process_restarted'),ended_at=? WHERE run_id=? AND status='running'", now, plan.run_id);
      if (plan.status === 'pause_requested') {
        const payload = JSON.parse(plan.payload) as CoordinationPlan;
        const paused = { ...payload, status: 'paused' as const, updatedAt: now };
        run("UPDATE coordination_plans SET status='paused',payload=?,updated_at=? WHERE id=?", JSON.stringify(paused), now, plan.id);
        run("UPDATE runs SET status='waiting_for_user',updated_at=? WHERE id=?", now, plan.run_id);
      }
    }
    return activePlans.filter((plan) => plan.status === 'active').map((plan) => plan.run_id);
  });
}

export function applyCoordinationPlanRevision(input: {
  current: CoordinationPlan;
  snapshot: CapabilitySnapshot;
  draft: CoordinationDraft;
  candidate: CoordinationPlan;
  instruction: string;
}): CoordinationPlan {
  return tx(() => {
    const stored = getCoordinationPlan(input.current.id);
    if (!stored || stored.status !== 'paused' || !stored.runId || stored.revision !== input.current.revision) throw new Error('计划状态已变化，无法创建 Revision');
    const now = new Date().toISOString();
    const revised: CoordinationPlan = {
      ...input.candidate,
      id: stored.id,
      runId: stored.runId,
      revision: stored.revision + 1,
      status: 'paused',
      createdAt: stored.createdAt,
      updatedAt: now,
    };
    run('INSERT INTO capability_snapshots (id,payload,created_at) VALUES (?,?,?)', input.snapshot.id, JSON.stringify(input.snapshot), input.snapshot.createdAt);
    run('INSERT INTO coordination_drafts (id,capability_snapshot_id,payload,created_at) VALUES (?,?,?,?)', input.draft.id, input.snapshot.id, JSON.stringify(input.draft), input.draft.createdAt);
    run('UPDATE coordination_plans SET draft_id=?,capability_snapshot_id=?,revision=?,status=?,payload=?,updated_at=? WHERE id=?',
      input.draft.id, input.snapshot.id, revised.revision, revised.status, JSON.stringify(revised), now, stored.id);
    for (const step of revised.steps) run(`INSERT INTO coordination_step_states
      (plan_id,run_id,revision,step_id,status,attempt_no,output,error,started_at,completed_at,updated_at)
      VALUES (?,?,?,?,?,0,NULL,NULL,NULL,NULL,?)`, revised.id, revised.runId, revised.revision, step.id, step.dependsOn.length === 0 ? 'ready' : 'pending', now);
    admitCoordinationKernelPlan(revised);
    const revision: CoordinationPlanRevision = {
      planId: revised.id, revision: revised.revision, trigger: 'user_adjustment', previousRevision: stored.revision,
      diffSummary: input.instruction.slice(0, 500), plan: revised, createdAt: now,
    };
    run('INSERT INTO coordination_plan_revisions (plan_id,revision,trigger_kind,payload,created_at) VALUES (?,?,?,?,?)',
      revised.id, revised.revision, revision.trigger, JSON.stringify(revision), now);
    recordCoordinationEvent({ kind: 'plan_revision_created', draftId: input.draft.id, planId: revised.id, runId: revised.runId, payload: { revision: revised.revision, previousRevision: stored.revision, instruction: input.instruction.slice(0, 500), protocols: revised.protocols } });
    return revised;
  });
}

export function listCoordinationEvents(filter: { draftId?: string; planId?: string; runId?: string }): CoordinationEvent[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.draftId) { clauses.push('draft_id=?'); params.push(filter.draftId); }
  if (filter.planId) { clauses.push('plan_id=?'); params.push(filter.planId); }
  if (filter.runId) { clauses.push('run_id=?'); params.push(filter.runId); }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return all<EventRow>(`SELECT * FROM coordination_events ${where} ORDER BY rowid`, ...params).map((row) => ({
    id: row.id, kind: row.kind, draftId: row.draft_id, planId: row.plan_id, runId: row.run_id,
    payload: JSON.parse(row.payload) as Record<string, unknown>, createdAt: row.created_at,
  }));
}

export function listCoordinationPlanRevisions(planId: string): CoordinationPlanRevision[] {
  return all<PayloadRow>('SELECT payload FROM coordination_plan_revisions WHERE plan_id=? ORDER BY revision', planId)
    .map((row) => JSON.parse(row.payload) as CoordinationPlanRevision);
}
