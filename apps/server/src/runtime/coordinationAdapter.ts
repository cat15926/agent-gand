import { randomUUID } from 'node:crypto';
import type {
  CoordinationPlan, CoordinationPlanStep, CoordinationStepState, Run, RuntimeCompletionInput,
  RuntimeCompletionSubject, RuntimeEvidenceRef, RuntimeRunContract,
} from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, get, run, tx } from '../db/database.ts';
import { createWorkspaceFileEvidence, redactSensitive, resolveEvidence } from './evidence.ts';
import { MAX_CONTEXT_CHARS, persistRuntimeContextAssembly, type ContextSegment } from './context.ts';
import { describeCompletionReason, evaluateCompletion } from './completion.ts';
import { recordCompletionEvaluation } from './completionStore.ts';

type KernelMode = 'shadow' | 'execute';
type CustodyState = 'unassigned' | 'owned' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface SubjectLink { subject_id: string; }
interface SubjectRow {
  id: string; subject_key: string; status: RuntimeCompletionSubject['status']; state: CustodyState;
  holder_agent_id: string | null; pending_holder_agent_id: string | null; generation: number;
}

function subjectKey(plan: CoordinationPlan, stepId: string): string {
  return `coord:r${plan.revision}:${stepId}`;
}

function selectedMode(plan: CoordinationPlan): KernelMode | null {
  if (config.coordinationRuntime.kernelMode === 'off') return null;
  if (config.coordinationRuntime.kernelMode === 'shadow') return 'shadow';
  const allowed = new Set(config.coordinationRuntime.executeProtocols);
  return plan.protocols.every((item) => allowed.has(item.protocol)) ? 'execute' : 'shadow';
}

function contractFor(plan: CoordinationPlan, mode: KernelMode): RuntimeRunContract {
  if (!plan.runId) throw new Error('Coordination Plan 尚未绑定 Run');
  const steps = plan.steps.filter((step) => step.type !== 'completion_gate');
  return {
    version: 1, runtimeRevision: plan.revision, runId: plan.runId,
    objective: `Coordination Plan ${plan.id} revision ${plan.revision}`,
    participantIds: [...new Set(steps.flatMap((step) => step.agentId ? [step.agentId] : []))],
    requiredSubjectKeys: steps.map((step) => subjectKey(plan, step.id)),
    completionPolicy: 'all_required', partialFailurePolicy: 'needs_attention',
    features: { completionEngine: mode === 'execute', coordinationKernel: mode },
  };
}

export function coordinationKernelMode(runId: string): KernelMode | null {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  try { return (JSON.parse(row.payload) as RuntimeRunContract).features?.coordinationKernel ?? null; }
  catch { return null; }
}

export function getCoordinationKernelStatus(runId: string): {
  mode: KernelMode | null; runtimeRevision: number | null;
  subjects: Array<{ stepId: string; status: string; custodyState: string; holderAgentId: string | null; generation: number; evidenceCount: number }>;
  contextCount: number;
} {
  const contractRow = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  let contract: RuntimeRunContract | null = null;
  try { contract = contractRow ? JSON.parse(contractRow.payload) as RuntimeRunContract : null; } catch { /* invalid */ }
  const subjects = all<{ step_id: string; status: string; state: string; holder_agent_id: string | null; generation: number; evidence_count: number }>(
    `SELECT m.step_id,s.status,c.state,c.holder_agent_id,c.generation,
      (SELECT COUNT(*) FROM runtime_coordination_evidence e WHERE e.subject_id=s.id) evidence_count
    FROM runtime_coordination_subjects m JOIN runtime_subjects s ON s.id=m.subject_id
    JOIN runtime_custody c ON c.subject_id=s.id WHERE s.run_id=? AND m.revision=? ORDER BY m.rowid`,
  runId, contract?.runtimeRevision ?? -1);
  return {
    mode: contract?.features?.coordinationKernel ?? null,
    runtimeRevision: contract?.runtimeRevision ?? null,
    subjects: subjects.map((item) => ({ stepId: item.step_id, status: item.status, custodyState: item.state,
      holderAgentId: item.holder_agent_id, generation: item.generation, evidenceCount: item.evidence_count })),
    contextCount: get<{ n: number }>("SELECT COUNT(*) n FROM runtime_context_assemblies WHERE run_id=? AND dispatch_id LIKE 'coordination:%'", runId)?.n ?? 0,
  };
}

export function admitCoordinationKernelPlan(plan: CoordinationPlan): void {
  if (!plan.runId) return;
  const mode = coordinationKernelMode(plan.runId) ?? selectedMode(plan);
  if (!mode) return;
  const contract = contractFor(plan, mode);
  const now = new Date().toISOString();
  const superseded = all<{ subject_id: string; state: CustodyState; holder_agent_id: string | null; generation: number; revision: number; step_id: string }>(
    `SELECT m.subject_id,c.state,c.holder_agent_id,c.generation,m.revision,m.step_id
      FROM runtime_coordination_subjects m JOIN runtime_custody c ON c.subject_id=m.subject_id
      WHERE m.plan_id=? AND m.revision<? AND c.state NOT IN ('completed','failed','cancelled')`, plan.id, plan.revision);
  for (const item of superseded) {
    const sourceEventId = `coord:superseded:${plan.id}:r${plan.revision}:${item.subject_id}`;
    const generation = item.generation + 1;
    run(`INSERT OR IGNORE INTO runtime_custody_events
      (id,run_id,subject_id,source_event_id,kind,holder_agent_id,pending_holder_agent_id,generation,payload,created_at)
      VALUES (?,?,?,?,?,?,NULL,?,?,?)`, randomUUID(), plan.runId, item.subject_id, sourceEventId, 'custody.superseded',
    item.holder_agent_id, generation, JSON.stringify({ state: 'cancelled', supersededByRevision: plan.revision }), now);
    run("UPDATE runtime_custody SET state='cancelled',pending_holder_agent_id=NULL,generation=?,version=version+1,updated_at=? WHERE subject_id=?",
      generation, now, item.subject_id);
    run("UPDATE runtime_subjects SET status='cancelled',updated_at=? WHERE id=?", now, item.subject_id);
  }
  run(`INSERT OR REPLACE INTO runtime_contract_revisions (run_id,runtime_revision,payload,created_at)
    VALUES (?,?,?,?)`, plan.runId, plan.revision, JSON.stringify(contract), now);
  run(`INSERT INTO runtime_contracts (run_id,version,payload,created_at) VALUES (?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET version=excluded.version,payload=excluded.payload`,
  plan.runId, contract.version, JSON.stringify(contract), now);
  for (const step of plan.steps) {
    if (step.type === 'completion_gate') continue;
    const existing = get<SubjectLink>(
      'SELECT subject_id FROM runtime_coordination_subjects WHERE plan_id=? AND revision=? AND step_id=?', plan.id, plan.revision, step.id);
    if (existing) continue;
    const subjectId = randomUUID();
    run(`INSERT INTO runtime_subjects (id,run_id,subject_key,kind,parent_subject_id,status,objective,created_at,updated_at)
      VALUES (?,?,?,'coordination_step',NULL,'active',?,?,?)`, subjectId, plan.runId, subjectKey(plan, step.id), step.completion, now, now);
    run("INSERT INTO runtime_custody (subject_id,state,holder_agent_id,pending_holder_agent_id,generation,version,updated_at) VALUES (?,'unassigned',NULL,NULL,0,0,?)", subjectId, now);
    run('INSERT INTO runtime_coordination_subjects (plan_id,revision,step_id,subject_id) VALUES (?,?,?,?)', plan.id, plan.revision, step.id, subjectId);
  }
}

function linkFor(plan: CoordinationPlan, stepId: string): SubjectLink | undefined {
  return get<SubjectLink>('SELECT subject_id FROM runtime_coordination_subjects WHERE plan_id=? AND revision=? AND step_id=?',
    plan.id, plan.revision, stepId);
}

function transition(plan: CoordinationPlan, stepId: string, sourceEventId: string, kind: string,
  state: CustodyState, holder: string | null, payload: Record<string, unknown> = {}): void {
  if (!plan.runId) return;
  const link = linkFor(plan, stepId); if (!link) return;
  const duplicate = get<{ subject_id: string }>('SELECT subject_id FROM runtime_custody_events WHERE source_event_id=?', sourceEventId);
  if (duplicate) {
    if (duplicate.subject_id !== link.subject_id) throw new Error(`Runtime 事件 ${sourceEventId} 的 Subject 冲突`);
    return;
  }
  const current = get<{ generation: number }>('SELECT generation FROM runtime_custody WHERE subject_id=?', link.subject_id);
  if (!current) throw new Error(`Coordination Subject ${link.subject_id} 缺少 Custody`);
  const generation = current.generation + 1; const now = new Date().toISOString();
  run(`INSERT INTO runtime_custody_events
    (id,run_id,subject_id,source_event_id,kind,holder_agent_id,pending_holder_agent_id,generation,payload,created_at)
    VALUES (?,?,?,?,?,?,NULL,?,?,?)`, randomUUID(), plan.runId, link.subject_id, sourceEventId, kind, holder, generation,
  JSON.stringify({ state, planId: plan.id, revision: plan.revision, stepId, ...payload }), now);
  run(`UPDATE runtime_custody SET state=?,holder_agent_id=?,pending_holder_agent_id=NULL,generation=?,version=version+1,updated_at=? WHERE subject_id=?`,
    state, holder, generation, now, link.subject_id);
  const status = state === 'completed' ? 'completed' : state === 'failed' ? 'failed'
    : state === 'cancelled' ? 'cancelled' : state === 'waiting' ? 'waiting' : 'active';
  run('UPDATE runtime_subjects SET status=?,updated_at=? WHERE id=?', status, now, link.subject_id);
}

function observe(plan: CoordinationPlan, label: string, action: () => void): void {
  const mode = plan.runId ? coordinationKernelMode(plan.runId) : null;
  if (!mode) return;
  if (mode === 'execute') action();
  else {
    try { action(); } catch (error) { console.warn(`[coordination-runtime-shadow] ${label}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

export function observeCoordinationClaim(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string): void {
  if (!step.agentId) return;
  observe(plan, 'claim', () => transition(plan, step.id, `coord:claim:${attemptId}`, 'custody.acquired', 'owned', step.agentId, { attemptId }));
}

function saveEvidence(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string): void {
  if (!plan.runId) return;
  const link = linkFor(plan, step.id); if (!link) return;
  const refs: RuntimeEvidenceRef[] = [{ kind: 'attempt_output', id: attemptId }];
  for (const artifactPath of step.expectedArtifacts ?? []) {
    refs.push(createWorkspaceFileEvidence(plan.runId, artifactPath, plan.id.slice(0, 8)));
  }
  if (refs.some((ref) => !resolveEvidence(plan.runId!, ref).trusted)) throw new Error(`步骤 ${step.id} 的 Runtime Evidence 无效`);
  const encoded = JSON.stringify(refs);
  const existing = get<{ refs: string }>('SELECT refs FROM runtime_coordination_evidence WHERE attempt_id=?', attemptId);
  if (existing && existing.refs !== encoded) throw new Error(`Attempt ${attemptId} 的 Evidence 发生漂移`);
  if (!existing) run('INSERT INTO runtime_coordination_evidence (subject_id,attempt_id,refs,created_at) VALUES (?,?,?,?)',
    link.subject_id, attemptId, encoded, new Date().toISOString());
}

export function observeCoordinationComplete(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string): void {
  if (!step.agentId) return;
  observe(plan, 'complete', () => {
    saveEvidence(plan, step, attemptId);
    transition(plan, step.id, `coord:complete:${attemptId}`, 'custody.completed', 'completed', step.agentId!, { attemptId });
  });
}

export function observeCoordinationFailure(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string, retry: boolean): void {
  if (!step.agentId) return;
  observe(plan, retry ? 'retry' : 'failure', () => transition(plan, step.id, `coord:${retry ? 'retry' : 'fail'}:${attemptId}`,
    retry ? 'custody.waiting_retry' : 'custody.failed', retry ? 'waiting' : 'failed', step.agentId, { attemptId }));
}

export function observeCoordinationPause(plan: CoordinationPlan, step: CoordinationPlanStep, attemptId: string): void {
  if (!step.agentId) return;
  observe(plan, 'pause', () => transition(plan, step.id, `coord:pause:${attemptId}`, 'custody.waiting_user', 'waiting', step.agentId, { attemptId }));
}

export function observeCoordinationRevision(plan: CoordinationPlan, reviewStep: CoordinationPlanStep,
  attemptId: string, targetStepIds: string[]): void {
  observe(plan, 'review_revision', () => {
    for (const stepId of [...targetStepIds, reviewStep.id]) {
      const step = plan.steps.find((item) => item.id === stepId);
      if (step?.agentId) transition(plan, step.id, `coord:revision:${attemptId}:${step.id}`, 'custody.revision_requested', 'waiting', step.agentId, { attemptId });
    }
  });
}

export function closeCoordinationKernelPlan(plan: CoordinationPlan, states: CoordinationStepState[], cancelled: boolean): void {
  observe(plan, cancelled ? 'plan_cancelled' : 'plan_failed', () => {
    for (const step of plan.steps) {
      if (!step.agentId) continue;
      const state = states.find((item) => item.stepId === step.id);
      if (state?.status === 'completed') continue;
      transition(plan, step.id, `coord:plan-close:${plan.id}:${cancelled ? 'cancelled' : 'failed'}:${plan.revision}:${step.id}`,
        cancelled ? 'custody.cancelled' : 'custody.plan_failed', cancelled ? 'cancelled' : 'failed', step.agentId,
        { stepStatus: state?.status ?? 'missing' });
    }
  });
}

export function assembleCoordinationKernelContext(input: {
  run: Run; plan: CoordinationPlan; step: CoordinationPlanStep; attemptId: string; baseInput: string;
}): string {
  if (!coordinationKernelMode(input.run.id) || !input.step.agentId) return input.baseInput;
  const contract = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', input.run.id);
  const custody = get<{ state: string; holder_agent_id: string | null; generation: number }>(`SELECT c.state,c.holder_agent_id,c.generation
    FROM runtime_coordination_subjects m JOIN runtime_custody c ON c.subject_id=m.subject_id
    WHERE m.plan_id=? AND m.revision=? AND m.step_id=?`, input.plan.id, input.plan.revision, input.step.id);
  const dependencyEvidence = input.step.dependsOn.flatMap((stepId) => {
    const row = get<{ refs: string }>(`SELECT e.refs FROM runtime_coordination_subjects m
      JOIN runtime_coordination_evidence e ON e.subject_id=m.subject_id
      WHERE m.plan_id=? AND m.revision=? AND m.step_id=? ORDER BY e.created_at DESC LIMIT 1`, input.plan.id, input.plan.revision, stepId);
    if (!row) return [];
    try { return (JSON.parse(row.refs) as RuntimeEvidenceRef[]).map((ref) => resolveEvidence(input.run.id, ref)); } catch { return []; }
  });
  const parts = [
    { source: 'contract', text: contract ? `公共完成契约：${redactSensitive(contract.payload)}` : '', cap: 2_000 },
    { source: 'custody', text: custody ? `公共责任状态：holder=${custody.holder_agent_id ?? '无'}；state=${custody.state}；generation=${custody.generation}` : '', cap: 500 },
    { source: 'evidence', text: dependencyEvidence.length > 0 ? `已校验的依赖证据：\n${dependencyEvidence.map((item) => item.trusted ? `[${item.source}] ${item.excerpt}` : `[${item.source}] 不可用：${item.reason}`).join('\n')}` : '', cap: 5_000 },
    { source: 'current', text: input.baseInput, cap: 16_000 },
  ];
  const rendered: string[] = []; const segments: ContextSegment[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const available = Math.max(0, MAX_CONTEXT_CHARS - rendered.join('\n\n').length - 4);
    const length = Math.min(part.text.length, part.cap, available);
    if (length === 0) continue;
    const clipped = part.text.slice(0, length); rendered.push(clipped);
    segments.push({ source: part.source, chars: clipped.length, tokenEstimate: Math.ceil(clipped.length / 4), truncated: length < part.text.length });
  }
  const context = rendered.join('\n\n');
  persistRuntimeContextAssembly({ runId: input.run.id, workItemId: `coordination:${input.plan.id}:${input.plan.revision}:${input.step.id}`,
    attemptId: input.attemptId, segments, context });
  return context;
}

function reviewPassed(plan: CoordinationPlan, states: CoordinationStepState[]): boolean {
  return plan.steps.filter((step) => step.protocol === 'review_revision' && step.type === 'review').every((step) => {
    const output = states.find((state) => state.stepId === step.id)?.output;
    if (!output) return false;
    try {
      const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(output.trim());
      return (JSON.parse((fenced?.[1] ?? output).trim()) as { verdict?: string }).verdict === 'PASS';
    } catch { return false; }
  });
}

export function evaluateCoordinationKernel(plan: CoordinationPlan, states: CoordinationStepState[]) {
  if (!plan.runId) return null;
  const mode = coordinationKernelMode(plan.runId); if (!mode) return null;
  const contractRow = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', plan.runId);
  if (!contractRow) return null;
  const contract = JSON.parse(contractRow.payload) as RuntimeRunContract;
  const rows = all<SubjectRow>(`SELECT s.id,s.subject_key,s.status,c.state,c.holder_agent_id,c.pending_holder_agent_id,c.generation
    FROM runtime_coordination_subjects m JOIN runtime_subjects s ON s.id=m.subject_id
    JOIN runtime_custody c ON c.subject_id=s.id WHERE m.plan_id=? AND m.revision=? ORDER BY m.rowid`, plan.id, plan.revision);
  const subjects = rows.map((row): RuntimeCompletionSubject => {
    const evidence = get<{ refs: string }>('SELECT refs FROM runtime_coordination_evidence WHERE subject_id=? ORDER BY created_at DESC LIMIT 1', row.id);
    let evidenceValid = false;
    try { evidenceValid = Boolean(evidence) && (JSON.parse(evidence!.refs) as RuntimeEvidenceRef[]).every((ref) => resolveEvidence(plan.runId!, ref).trusted); } catch { /* invalid */ }
    const stepId = row.subject_key.replace(/^coord:r\d+:/u, '');
    return { key: row.subject_key, required: contract.requiredSubjectKeys.includes(row.subject_key), status: row.status,
      custodyState: row.state, holderAgentId: row.holder_agent_id, pendingHolderAgentId: row.pending_holder_agent_id,
      generation: row.generation, hasOutput: Boolean(states.find((state) => state.stepId === stepId)?.output?.trim()), evidenceValid };
  });
  const dispatches: RuntimeCompletionInput['dispatches'] = plan.steps.filter((step) => step.type !== 'completion_gate').map((step) => {
    const state = states.find((item) => item.stepId === step.id);
    const subject = subjects.find((item) => item.key === subjectKey(plan, step.id));
    const status = subject?.status === 'cancelled' ? 'cancelled' : subject?.status === 'failed' ? 'failed'
      : state?.status === 'completed' ? 'completed' : state?.status === 'failed' ? 'failed'
      : state?.status === 'running' ? 'running' : 'queued';
    return { id: `${plan.id}:${plan.revision}:${step.id}`, status, error: state?.error ?? null };
  });
  const dependenciesSatisfied = plan.steps.every((step) => step.dependsOn.every((id) => states.find((state) => state.stepId === id)?.status === 'completed'));
  const requiredArtifactsSatisfied = plan.steps.every((step) => (step.expectedArtifacts ?? []).length === 0
    || subjects.find((subject) => subject.key === subjectKey(plan, step.id))?.evidenceValid === true);
  const protocolTerminal = plan.completion.terminalSteps.every((id) => states.find((state) => state.stepId === id)?.status === 'completed');
  const completionInput: RuntimeCompletionInput = { contract, subjects, dispatches, pendingDecisions: 0, batchStatuses: [],
    hasAnyOutput: states.some((state) => Boolean(state.output?.trim())), dependenciesSatisfied, requiredArtifactsSatisfied,
    reviewAccepted: reviewPassed(plan, states), protocolTerminal };
  const evaluation = evaluateCompletion(completionInput);
  recordCompletionEvaluation(plan.runId, evaluation, completionInput);
  return { mode, evaluation, input: completionInput };
}

export function assertCoordinationKernelCompletion(plan: CoordinationPlan, states: CoordinationStepState[]): void {
  const result = evaluateCoordinationKernel(plan, states);
  if (!result || result.mode === 'shadow') return;
  if (result.evaluation.status !== 'accepted') {
    throw new Error(`Completion Engine 拒绝 Coordination 终局：${result.evaluation.reasons.map(describeCompletionReason).join('；')}`);
  }
}
