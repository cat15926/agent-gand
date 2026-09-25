import { randomUUID } from 'node:crypto';
import type {
  RuntimeCompletionCandidate,
  RuntimeControlAction,
  RuntimeEvidenceRef,
  RuntimeRunContract,
  RuntimeSubjectCompletionEvaluation,
  RuntimeSubjectCompletionInput,
} from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { resolveEvidence } from './evidence.ts';
import { observeCompletionCandidateDecision } from './shadow.ts';

interface CandidateRow {
  id: string; run_id: string; subject_id: string; subject_key: string; attempt_id: string; generation: number;
  agent_id: string; action: string; summary: string; evidence_refs: string; exit_guard_status: string;
  exit_guard_reasons: string; status: RuntimeCompletionCandidate['status']; reasons: string; retryable: number;
  feedback: string | null; idempotency_key: string; created_at: string; decided_at: string | null;
}

interface CandidateContextRow {
  subject_id: string; subject_key: string; subject_status: RuntimeSubjectCompletionInput['subjectStatus'];
  custody_state: string; holder_agent_id: string | null; pending_holder_agent_id: string | null; generation: number;
  attempt_status: RuntimeSubjectCompletionInput['attemptStatus']; attempt_agent_id: string; attempt_error: string | null;
  lease_expires_at: string | null; dispatch_id: string; attempt_generation: number | null;
}

function rejected(reasons: string[], retryable: boolean, feedback: string): RuntimeSubjectCompletionEvaluation {
  return { status: 'rejected', reasons, retryable, feedback };
}

/** 无数据库、无副作用的 Subject 完成候选判定。 */
export function evaluateSubjectCompletion(input: RuntimeSubjectCompletionInput): RuntimeSubjectCompletionEvaluation {
  if (input.candidate.subjectId !== input.currentSubjectId) {
    return { status: 'superseded', reasons: ['CANDIDATE_SUBJECT_MISMATCH'], retryable: false,
      feedback: '候选对应的工作项已经变化，旧结果不能提交。' };
  }
  if (input.candidate.generation !== input.currentGeneration) {
    return { status: 'superseded', reasons: ['CANDIDATE_GENERATION_STALE'], retryable: false,
      feedback: '责任代际已经推进，旧候选已失效。' };
  }
  if (input.attemptStatus === 'failed' || input.attemptStatus === 'interrupted' || input.attemptStatus === 'cancelled'
    || !input.leaseValid || input.attemptError?.startsWith('AGENT_TURN_')) {
    return rejected(['ATTEMPT_NOT_COMMITTABLE'], false, '本次执行已经失败、中断、取消或失去租约，不能提交完成结果。');
  }
  if (input.attemptAgentId !== input.candidate.agentId) {
    return rejected(['ATTEMPT_AGENT_MISMATCH'], false, 'Candidate 提交者与 Attempt 执行者不一致。');
  }
  if (input.subjectStatus !== 'active' || input.custodyState !== 'owned') {
    return rejected(['SUBJECT_NOT_OWNED'], false, '当前工作项不处于可提交的持有状态。');
  }
  if (input.holderAgentId !== input.candidate.agentId || input.pendingHolderAgentId) {
    return rejected(['CUSTODY_HOLDER_MISMATCH'], false, '当前责任持有者或待接球状态与 Candidate 不一致。');
  }
  if (input.candidate.exitGuard.status !== 'allow_candidate') {
    return rejected(['EXIT_GUARD_NOT_ALLOWED'], false, '本轮尚未通过退出门禁，不能提交完成候选。');
  }
  if (input.candidate.action.type !== 'complete' && input.candidate.action.type !== 'answer_candidate') {
    return rejected(['ACTION_NOT_COMPLETION_CANDIDATE'], false, '当前控制动作不是完成候选。');
  }
  if (input.durableHoldOpen || input.pendingHolderAgentId) {
    return rejected(['OPEN_HOLD_OR_TRANSFER'], true, '当前仍在等待用户或责任转移，请先解除等待状态。');
  }
  if (input.openSuccessorObligations > 0) {
    return rejected(['OPEN_SUCCESSOR_OBLIGATION'], true,
      `仍有 ${input.openSuccessorObligations} 个后继义务未完成，请先处理后再提交。`);
  }
  if (!input.outputPresent) return rejected(['MISSING_OUTPUT'], true, '完成候选缺少可交付结果，请补充完整摘要。');
  if (!input.evidenceValid || input.candidate.evidenceRefs.length === 0) {
    return rejected(['INVALID_EVIDENCE'], true, '完成候选缺少可信证据，请补充可验证的 Attempt 输出或产物引用。');
  }
  const protocolReasons: string[] = [];
  if (!input.dependenciesSatisfied) protocolReasons.push('DEPENDENCIES_NOT_SATISFIED');
  if (!input.requiredArtifactsSatisfied) protocolReasons.push('REQUIRED_ARTIFACTS_MISSING');
  if (!input.reviewAccepted) protocolReasons.push('REVIEW_NOT_ACCEPTED');
  if (!input.protocolTerminal) protocolReasons.push('PROTOCOL_NOT_TERMINAL');
  if (protocolReasons.length > 0) {
    return rejected(protocolReasons, true, '完成契约尚未满足，请完成依赖、产物、审查或协议终局后重试。');
  }
  return { status: 'accepted', reasons: [], retryable: false, feedback: null };
}

function toCandidate(row: CandidateRow): RuntimeCompletionCandidate {
  return {
    id: row.id, runId: row.run_id, subjectId: row.subject_id, subjectKey: row.subject_key,
    attemptId: row.attempt_id, generation: row.generation, agentId: row.agent_id,
    action: JSON.parse(row.action) as RuntimeControlAction, summary: row.summary,
    evidenceRefs: JSON.parse(row.evidence_refs) as RuntimeEvidenceRef[],
    exitGuard: { status: row.exit_guard_status, reasons: JSON.parse(row.exit_guard_reasons) as string[] },
    status: row.status, reasons: JSON.parse(row.reasons) as string[], retryable: row.retryable === 1,
    feedback: row.feedback, idempotencyKey: row.idempotency_key, createdAt: row.created_at, decidedAt: row.decided_at,
  };
}

export function runtimeCompletionCandidateVersion(runId: string): 1 | null {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  try { return (JSON.parse(row.payload) as RuntimeRunContract).features?.completionCandidateVersion === 1 ? 1 : null; }
  catch { return null; }
}

export interface SubmitCompletionCandidateInput {
  runId: string;
  dispatchId: string;
  attemptId: string;
  agentId: string;
  action: RuntimeControlAction;
  summary: string;
  evidenceRefs: RuntimeEvidenceRef[];
  exitGuard: { status: string; reasons: string[] };
  idempotencyKey?: string;
  /** false 时仍保留“可纠正”判定，但 Custody 进入 failed，避免超过 Attempt 上限后悬空。 */
  retryAllowed?: boolean;
}

export function submitCompletionCandidate(input: SubmitCompletionCandidateInput): {
  candidate: RuntimeCompletionCandidate;
  evaluation: RuntimeSubjectCompletionEvaluation;
} {
  return tx(() => {
    const idempotencyKey = input.idempotencyKey ?? `completion:${input.attemptId}`;
    const existing = get<CandidateRow>('SELECT * FROM runtime_completion_candidates WHERE idempotency_key=?', idempotencyKey);
    if (existing) {
      const candidate = toCandidate(existing);
      const evaluation: RuntimeSubjectCompletionEvaluation = candidate.status === 'accepted'
        ? { status: 'accepted', reasons: [], retryable: false, feedback: null }
        : candidate.status === 'superseded'
          ? { status: 'superseded', reasons: candidate.reasons, retryable: false, feedback: candidate.feedback ?? '旧候选已失效。' }
          : { status: 'rejected', reasons: candidate.reasons, retryable: candidate.retryable,
            feedback: candidate.feedback ?? '完成候选未通过验收。' };
      return { candidate, evaluation };
    }
    const context = get<CandidateContextRow>(`SELECT s.id subject_id,s.subject_key,s.status subject_status,
      c.state custody_state,c.holder_agent_id,c.pending_holder_agent_id,c.generation,
      a.status attempt_status,a.agent_id attempt_agent_id,a.error attempt_error,a.lease_expires_at,a.dispatch_id,
      (SELECT ce.generation FROM runtime_custody_events ce WHERE ce.source_event_id='claim:' || a.id) attempt_generation
      FROM collaboration_attempts a
      JOIN runtime_dispatch_subjects m ON m.dispatch_id=a.dispatch_id
      JOIN runtime_subjects s ON s.id=m.subject_id
      JOIN runtime_custody c ON c.subject_id=s.id
      WHERE a.id=? AND a.run_id=? AND a.dispatch_id=?`, input.attemptId, input.runId, input.dispatchId);
    if (!context) throw new Error('CompletionCandidate 缺少 Attempt/Subject/Custody 上下文');
    const id = randomUUID(); const now = new Date().toISOString();
    run(`INSERT INTO runtime_completion_candidates
      (id,run_id,subject_id,subject_key,attempt_id,generation,agent_id,action,summary,evidence_refs,
       exit_guard_status,exit_guard_reasons,status,reasons,retryable,feedback,idempotency_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending','[]',0,NULL,?,?)`,
    id, input.runId, context.subject_id, context.subject_key, input.attemptId,
    context.attempt_generation ?? context.generation, input.agentId,
    JSON.stringify(input.action), input.summary.trim(), JSON.stringify(input.evidenceRefs), input.exitGuard.status,
    JSON.stringify(input.exitGuard.reasons), idempotencyKey, now);
    const candidate = toCandidate(get<CandidateRow>('SELECT * FROM runtime_completion_candidates WHERE id=?', id)!);
    const openSuccessors = get<{ n: number }>(`SELECT COUNT(*) n FROM runtime_subjects
      WHERE parent_subject_id=? AND status<>'completed'`, context.subject_id)?.n ?? 0;
    const durableHoldOpen = Boolean(get(`SELECT 1 FROM collaboration_user_decisions
      WHERE run_id=? AND status='pending' AND (dispatch_id=? OR dispatch_id IS NULL) LIMIT 1`, input.runId, input.dispatchId));
    const evidenceValid = candidate.evidenceRefs.length > 0 && candidate.evidenceRefs.every((ref) => {
      if (ref.kind === 'attempt_output' && ref.id === input.attemptId && context.attempt_status === 'running') {
        return candidate.summary.trim().length > 0;
      }
      return resolveEvidence(input.runId, ref).trusted;
    });
    const leaseValid = context.attempt_status === 'completed' || (context.lease_expires_at !== null
      && new Date(context.lease_expires_at).getTime() > Date.now());
    const evaluation = evaluateSubjectCompletion({
      candidate: { subjectId: candidate.subjectId, attemptId: candidate.attemptId, generation: candidate.generation,
        agentId: candidate.agentId, action: candidate.action, summary: candidate.summary,
        evidenceRefs: candidate.evidenceRefs, exitGuard: candidate.exitGuard },
      currentSubjectId: context.subject_id, subjectStatus: context.subject_status, custodyState: context.custody_state,
      holderAgentId: context.holder_agent_id, pendingHolderAgentId: context.pending_holder_agent_id,
      currentGeneration: context.generation, attemptStatus: context.attempt_status, attemptAgentId: context.attempt_agent_id,
      attemptError: context.attempt_error, leaseValid, outputPresent: candidate.summary.trim().length > 0, evidenceValid,
      openSuccessorObligations: openSuccessors, durableHoldOpen,
      dependenciesSatisfied: true, requiredArtifactsSatisfied: true, reviewAccepted: true, protocolTerminal: true,
    });
    observeCompletionCandidateDecision({ candidateId: candidate.id, dispatchId: input.dispatchId,
      attemptId: input.attemptId, subjectId: candidate.subjectId, generation: candidate.generation,
      agentId: input.agentId, status: evaluation.status,
      retryable: evaluation.retryable && input.retryAllowed !== false, reasons: evaluation.reasons });
    const decidedAt = new Date().toISOString();
    run(`UPDATE runtime_completion_candidates SET status=?,reasons=?,retryable=?,feedback=?,decided_at=? WHERE id=? AND status='pending'`,
      evaluation.status, JSON.stringify(evaluation.reasons), evaluation.retryable ? 1 : 0, evaluation.feedback, decidedAt, candidate.id);
    const decided = toCandidate(get<CandidateRow>('SELECT * FROM runtime_completion_candidates WHERE id=?', candidate.id)!);
    afterCommit(() => emit({ type: 'runtime.completion_candidate.updated', candidate: decided }));
    return { candidate: decided, evaluation };
  });
}

export function listCompletionCandidates(runId: string): RuntimeCompletionCandidate[] {
  return all<CandidateRow>('SELECT * FROM runtime_completion_candidates WHERE run_id=? ORDER BY created_at,rowid', runId).map(toCandidate);
}
