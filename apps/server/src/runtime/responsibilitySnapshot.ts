import type {
  RuntimeCompletionBlocker,
  RuntimeResponsibilitySnapshot,
  RuntimeSubjectStatus,
  RuntimeSuccessorObligationKind,
  RuntimeSuccessorObligationStatus,
} from '@agent-gand/shared';
import { all, get } from '../db/database.ts';
import { loadRuntimeContract } from './runPolicy.ts';

interface SubjectRow {
  id: string;
  run_id: string;
  subject_key: string;
  status: RuntimeSubjectStatus;
  state: string;
  holder_agent_id: string | null;
  pending_holder_agent_id: string | null;
  generation: number;
  version: number;
}

interface ObligationRow {
  id: string;
  generation: number;
  kind: RuntimeSuccessorObligationKind;
  status: RuntimeSuccessorObligationStatus;
}

type AttemptStatus = RuntimeResponsibilitySnapshot['attempt'] extends infer T
  ? T extends { status: infer S } ? S : never
  : never;

interface AttemptProjection {
  id: string;
  actorId: string;
  generation: number;
  status: AttemptStatus;
  leaseValid: boolean;
}

function subjectByInput(input: {
  runId: string;
  subjectId?: string;
  dispatchId?: string;
  attemptId?: string;
}): SubjectRow | undefined {
  if (input.subjectId) {
    return get<SubjectRow>(`SELECT s.id,s.run_id,s.subject_key,s.status,c.state,c.holder_agent_id,
      c.pending_holder_agent_id,c.generation,c.version FROM runtime_subjects s
      JOIN runtime_custody c ON c.subject_id=s.id WHERE s.id=? AND s.run_id=?`, input.subjectId, input.runId);
  }
  const collaborationDispatchId = input.dispatchId ?? (input.attemptId
    ? get<{ dispatch_id: string }>('SELECT dispatch_id FROM collaboration_attempts WHERE id=? AND run_id=?', input.attemptId, input.runId)?.dispatch_id
    : undefined);
  if (collaborationDispatchId) {
    const row = get<SubjectRow>(`SELECT s.id,s.run_id,s.subject_key,s.status,c.state,c.holder_agent_id,
      c.pending_holder_agent_id,c.generation,c.version FROM runtime_dispatch_subjects m
      JOIN runtime_subjects s ON s.id=m.subject_id JOIN runtime_custody c ON c.subject_id=s.id
      WHERE m.dispatch_id=? AND s.run_id=?`, collaborationDispatchId, input.runId);
    if (row) return row;
  }
  if (!input.attemptId) return undefined;
  return get<SubjectRow>(`SELECT s.id,s.run_id,s.subject_key,s.status,c.state,c.holder_agent_id,
    c.pending_holder_agent_id,c.generation,c.version FROM coordination_step_attempts a
    JOIN runtime_coordination_subjects m ON m.plan_id=a.plan_id AND m.revision=a.revision AND m.step_id=a.step_id
    JOIN runtime_subjects s ON s.id=m.subject_id JOIN runtime_custody c ON c.subject_id=s.id
    WHERE a.id=? AND a.run_id=?`, input.attemptId, input.runId);
}

function coordinationActor(planPayload: string, stepId: string): string | null {
  try {
    const plan = JSON.parse(planPayload) as { steps?: Array<{ id?: string; agentId?: string | null }> };
    return plan.steps?.find((step) => step.id === stepId)?.agentId ?? null;
  } catch {
    return null;
  }
}

function attemptForSubject(runId: string, subjectId: string, attemptId?: string): AttemptProjection | null {
  const collaboration = get<{
    id: string; agent_id: string; status: AttemptStatus; lease_expires_at: string | null; generation: number | null;
  }>(`SELECT a.id,a.agent_id,a.status,a.lease_expires_at,
    (SELECT ce.generation FROM runtime_custody_events ce WHERE ce.subject_id=m.subject_id
      AND ce.source_event_id='claim:' || a.id ORDER BY ce.generation DESC LIMIT 1) generation
    FROM collaboration_attempts a JOIN runtime_dispatch_subjects m ON m.dispatch_id=a.dispatch_id
    WHERE a.run_id=? AND m.subject_id=? ${attemptId ? 'AND a.id=?' : ''}
    ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`, runId, subjectId, ...(attemptId ? [attemptId] : []));
  if (collaboration) {
    return {
      id: collaboration.id,
      actorId: collaboration.agent_id,
      generation: collaboration.generation ?? -1,
      status: collaboration.status,
      leaseValid: collaboration.status === 'completed' || (collaboration.status === 'running'
        && collaboration.lease_expires_at !== null
        && new Date(collaboration.lease_expires_at).getTime() > Date.now()),
    };
  }
  const coordination = get<{
    id: string; step_id: string; status: AttemptStatus; plan_payload: string | null;
    generation: number | null; claim_actor_id: string | null;
  }>(`SELECT a.id,a.step_id,a.status,p.payload plan_payload,
    (SELECT ce.generation FROM runtime_custody_events ce WHERE ce.subject_id=m.subject_id
      AND (ce.source_event_id='coord:claim:' || a.id OR ce.source_event_id LIKE 'coord:reclaim:' || a.id || ':%')
      ORDER BY ce.generation DESC LIMIT 1) generation,
    (SELECT ce.holder_agent_id FROM runtime_custody_events ce WHERE ce.subject_id=m.subject_id
      AND (ce.source_event_id='coord:claim:' || a.id OR ce.source_event_id LIKE 'coord:reclaim:' || a.id || ':%')
      ORDER BY ce.generation DESC LIMIT 1) claim_actor_id
    FROM coordination_step_attempts a
    JOIN runtime_coordination_subjects m ON m.plan_id=a.plan_id AND m.revision=a.revision AND m.step_id=a.step_id
    LEFT JOIN coordination_plans p ON p.id=a.plan_id
    WHERE a.run_id=? AND m.subject_id=? ${attemptId ? 'AND a.id=?' : ''}
    ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`, runId, subjectId, ...(attemptId ? [attemptId] : []));
  if (!coordination) return null;
  return {
    id: coordination.id,
    actorId: coordination.claim_actor_id
      ?? (coordination.plan_payload ? coordinationActor(coordination.plan_payload, coordination.step_id) : null)
      ?? '',
    generation: coordination.generation ?? -1,
    status: coordination.status,
    leaseValid: coordination.status === 'running' || coordination.status === 'completed',
  };
}

function blocker(input: Omit<RuntimeCompletionBlocker, 'message'> & { message: string }): RuntimeCompletionBlocker {
  return input;
}

function projectBlockers(input: {
  subject: SubjectRow;
  attempt: AttemptProjection | null;
  obligations: ObligationRow[];
  holdIds: string[];
}): RuntimeCompletionBlocker[] {
  const result: RuntimeCompletionBlocker[] = [];
  for (const obligation of input.obligations) {
    if (obligation.status === 'satisfied') continue;
    const code = obligation.status === 'open' ? 'REQUIRED_OBLIGATION_PENDING'
      : obligation.status === 'failed' ? 'REQUIRED_OBLIGATION_FAILED' : 'REQUIRED_OBLIGATION_CANCELLED';
    result.push(blocker({ code, category: 'work', refType: 'obligation', refId: obligation.id,
      message: obligation.status === 'open'
        ? `必需的 ${obligation.kind} 义务仍未完成`
        : `必需的 ${obligation.kind} 义务已${obligation.status === 'failed' ? '失败' : '取消'}，需要明确处置` }));
  }
  for (const holdId of input.holdIds) {
    result.push(blocker({ code: 'EXTERNAL_CONDITION_PENDING', category: 'external', refType: 'hold', refId: holdId,
      message: '责任正在等待外部条件或人工决定' }));
  }
  const { subject, attempt } = input;
  if (subject.status === 'completed') return result;
  if (subject.pending_holder_agent_id || subject.state === 'transferring') {
    result.push(blocker({ code: 'RESPONSIBILITY_TRANSFER_PENDING', category: 'stale_responsibility',
      refType: 'subject', refId: subject.id, message: '责任正在转移，当前持有者不能提交终局' }));
  } else if (subject.status === 'failed' || subject.status === 'cancelled'
    || (subject.status === 'waiting' && input.holdIds.length === 0)
    || (subject.status === 'active' && subject.state !== 'owned')) {
    result.push(blocker({ code: subject.status === 'active' ? 'RESPONSIBILITY_NOT_OWNED' : 'SUBJECT_NOT_ACTIVE',
      category: 'stale_responsibility', refType: 'subject', refId: subject.id,
      message: subject.status === 'active' ? '工作项当前没有有效持有者' : `工作项状态为 ${subject.status}，不能提交完成` }));
  }
  if (subject.status !== 'active' || subject.state !== 'owned') return result;
  if (!attempt) {
    result.push(blocker({ code: 'ATTEMPT_MISSING', category: 'stale_responsibility', refType: 'subject',
      refId: subject.id, message: '当前责任没有可提交的执行尝试' }));
    return result;
  }
  if (attempt.status !== 'running' && attempt.status !== 'completed') {
    result.push(blocker({ code: 'ATTEMPT_NOT_COMMITTABLE', category: 'stale_responsibility', refType: 'attempt',
      refId: attempt.id, message: `执行尝试状态为 ${attempt.status}，不能提交` }));
  }
  if (!attempt.leaseValid) {
    result.push(blocker({ code: 'ATTEMPT_LEASE_EXPIRED', category: 'stale_responsibility', refType: 'attempt',
      refId: attempt.id, message: '执行尝试的租约已失效' }));
  }
  if (attempt.generation !== subject.generation) {
    result.push(blocker({ code: 'ATTEMPT_GENERATION_STALE', category: 'stale_responsibility', refType: 'attempt',
      refId: attempt.id, message: `执行尝试属于 generation ${attempt.generation}，当前责任为 ${subject.generation}` }));
  }
  if (!attempt.actorId || attempt.actorId !== subject.holder_agent_id) {
    result.push(blocker({ code: 'CUSTODY_HOLDER_MISMATCH', category: 'stale_responsibility', refType: 'attempt',
      refId: attempt.id, message: '执行者与当前责任持有者不一致' }));
  }
  return result;
}

/**
 * 同步读取 Responsibility 真相；不维护第二份投影表。调用方若位于写事务中，
 * 会自然读取该事务内的最新状态。
 */
export function loadResponsibilitySnapshot(input: {
  runId: string;
  subjectId?: string;
  dispatchId?: string;
  attemptId?: string;
}): RuntimeResponsibilitySnapshot | null {
  const subject = subjectByInput(input);
  if (!subject) return null;
  const attempt = attemptForSubject(input.runId, subject.id, input.attemptId);
  const obligations = all<ObligationRow>(`SELECT o.id,o.generation,o.kind,o.status
    FROM runtime_successor_obligations o
    WHERE o.run_id=? AND o.parent_subject_id=? AND o.required=1
      AND NOT EXISTS (SELECT 1 FROM runtime_successor_obligations newer
        WHERE newer.run_id=o.run_id AND newer.stable_key=o.stable_key AND newer.generation>o.generation)
    ORDER BY o.created_at,o.rowid`, input.runId, subject.id);
  const holdIds = all<{ id: string }>(`SELECT id FROM runtime_holds
    WHERE run_id=? AND subject_id=? AND generation=? AND status IN ('open','claimed') ORDER BY created_at,rowid`,
  input.runId, subject.id, subject.generation).map((row) => row.id);
  const completionBlockers = projectBlockers({ subject, attempt, obligations, holdIds });
  return {
    runId: input.runId,
    contractRevision: loadRuntimeContract(input.runId)?.runtimeRevision ?? null,
    subjectId: subject.id,
    subjectKey: subject.subject_key,
    subjectStatus: subject.status,
    custody: {
      state: subject.state,
      holderAgentId: subject.holder_agent_id,
      pendingHolderAgentId: subject.pending_holder_agent_id,
      generation: subject.generation,
      rowVersion: subject.version,
    },
    attempt,
    requiredObligations: obligations.map((item) => ({
      id: item.id, generation: item.generation, kind: item.kind, status: item.status,
    })),
    openHoldIds: holdIds,
    completionBlockers,
  };
}

export function listResponsibilitySnapshots(runId: string): RuntimeResponsibilitySnapshot[] {
  return all<{ id: string }>('SELECT id FROM runtime_subjects WHERE run_id=? ORDER BY created_at,rowid', runId)
    .flatMap((subject) => {
      const snapshot = loadResponsibilitySnapshot({ runId, subjectId: subject.id });
      return snapshot ? [snapshot] : [];
    });
}

export function formatCompletionBlockers(blockers: RuntimeCompletionBlocker[]): string {
  if (blockers.length === 0) return '完成阻断：无';
  return `完成阻断：\n${blockers.map((item) => `- [${item.category}] ${item.code}${item.refId ? ` (${item.refType}:${item.refId})` : ''}：${item.message}`).join('\n')}`;
}
