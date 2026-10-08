import { randomUUID } from 'node:crypto';
import { intersectMessageAccess, isMessageWithinScope } from '@agent-gand/shared';
import type {
  RuntimeHandoffCapsule,
  RuntimeHandoffCapsuleV1,
  RuntimeHandoffCapsuleV2,
} from '@agent-gand/shared';
import { get, run, tx } from '../db/database.ts';
import { assertMessageAccess, attemptAccess, messageAccess } from '../messaging/access.ts';
import { createEvidenceBundle, evidenceAccess, resolveEvidence, runtimeEvidenceBundleVersion } from './evidence.ts';

interface CapsuleRow { version: number; payload: string; }
interface ObligationRefRow {
  id: string;
  run_id: string;
  generation: number;
  kind: string;
  target_subject_id: string | null;
  source_action_id: string;
  stable_key: string;
  payload: string;
}

function parseHandoffCapsule(payload: string): RuntimeHandoffCapsule {
  const parsed = JSON.parse(payload) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Capsule payload 不是对象');
  const value = parsed as Record<string, unknown>;
  if (!Number.isInteger(value.version) || Number(value.version) < 1) throw new Error('Capsule 内容版本无效');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error(`Capsule schemaVersion=${String(value.schemaVersion)} 不受支持`);
  }
  if (value.schemaVersion === 2) {
    const refs = value.successorObligationRefs;
    if (!Array.isArray(refs) || refs.some((ref) => !ref || typeof ref !== 'object' || Array.isArray(ref)
      || typeof (ref as Record<string, unknown>).obligationId !== 'string'
      || !Number.isInteger((ref as Record<string, unknown>).generation)
      || Number((ref as Record<string, unknown>).generation) < 1)) {
      throw new Error('Capsule v2 的后继义务引用结构无效');
    }
  } else if (value.successorObligationRefs !== undefined) {
    throw new Error('Capsule v1 不得携带机器后继义务引用');
  }
  return parsed as RuntimeHandoffCapsule;
}

export function latestHandoffCapsule(dispatchId: string, runId: string, viewerId = 'user'): RuntimeHandoffCapsule | null {
  const row = get<CapsuleRow>('SELECT version,payload FROM runtime_handoff_capsules WHERE dispatch_id=? AND run_id=? ORDER BY version DESC LIMIT 1', dispatchId, runId);
  if (!row) return null;
  const capsule = parseHandoffCapsule(row.payload);
  assertMessageAccess(intersectMessageAccess([attemptAccess(capsule.sourceAttemptId),
    ...capsule.evidenceRefs.map(ref => evidenceAccess(ref, runId))]), viewerId, '交接 Capsule');
  validateSuccessorObligationRefs(capsule);
  return capsule;
}

function validateSuccessorObligationRefs(capsule: RuntimeHandoffCapsule): void {
  if (capsule.schemaVersion !== 2) return;
  if (!Array.isArray(capsule.successorObligationRefs) || capsule.successorObligationRefs.length !== 1) {
    throw new Error('Capsule v2 handoff 必须引用且只引用一个接球义务');
  }
  const childSubject = get<{ subject_id: string }>('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', capsule.dispatchId);
  if (!childSubject) throw new Error('Capsule v2 的目标 Dispatch 缺少 Subject 映射');
  const ref = capsule.successorObligationRefs[0]!;
  const obligation = get<ObligationRefRow>('SELECT * FROM runtime_successor_obligations WHERE id=? AND generation=?',
    ref.obligationId, ref.generation);
  if (!obligation || obligation.run_id !== capsule.runId || obligation.kind !== 'handoff_acquire'
    || obligation.target_subject_id !== childSubject.subject_id
    || obligation.source_action_id !== `action:${capsule.sourceAttemptId}`
    || obligation.stable_key !== `handoff-acquire:${capsule.dispatchId}`) {
    throw new Error('Capsule v2 含伪造、跨 Run、过期或不匹配的后继义务引用');
  }
  const payload = JSON.parse(obligation.payload) as { dispatchId?: unknown };
  if (payload.dispatchId !== capsule.dispatchId) throw new Error('Capsule v2 的义务引用未绑定目标 Dispatch');
}

/** 同一 Dispatch 的修订只能追加版本；重试同版本必须内容相同。 */
export function saveHandoffCapsule(capsule: RuntimeHandoffCapsule): RuntimeHandoffCapsule {
  return tx(() => {
    const dispatch = get<{ run_id: string; parent_dispatch_id: string | null; kind: string; target_agent_id: string; source_message_id: string }>(
      'SELECT run_id,parent_dispatch_id,kind,target_agent_id,source_message_id FROM collaboration_dispatches WHERE id=?', capsule.dispatchId);
    const source = get<{ run_id: string; dispatch_id: string; status: string }>(
      'SELECT run_id,dispatch_id,status FROM collaboration_attempts WHERE id=?', capsule.sourceAttemptId);
    if (!dispatch || dispatch.run_id !== capsule.runId || dispatch.kind !== 'handoff' || dispatch.parent_dispatch_id !== capsule.sourceDispatchId
      || !source || source.run_id !== capsule.runId || source.dispatch_id !== capsule.sourceDispatchId || source.status !== 'completed') {
      throw new Error('Capsule 来源 Dispatch/Attempt 无效或尚未完成');
    }
    assertMessageAccess(attemptAccess(capsule.sourceAttemptId), dispatch.target_agent_id, '交接 Capsule');
    if (capsule.evidenceRefs.length > 12 || capsule.evidenceRefs.some((ref) => !resolveEvidence(capsule.runId, ref, dispatch.target_agent_id).trusted)) {
      throw new Error('Capsule 含无效、跨 Run 或未完成的证据引用');
    }
    const capsuleAccess = intersectMessageAccess([attemptAccess(capsule.sourceAttemptId),
      ...capsule.evidenceRefs.map(ref => evidenceAccess(ref, capsule.runId))]);
    if (!isMessageWithinScope(capsuleAccess, messageAccess(dispatch.source_message_id))) {
      throw new Error('Capsule 可见范围与交接任务不匹配；私密来源不能带入公开或更广范围的任务');
    }
    validateSuccessorObligationRefs(capsule);
    const subject = get<{ subject_id: string }>('SELECT subject_id FROM runtime_dispatch_subjects WHERE dispatch_id=?', capsule.dispatchId);
    const bundle = runtimeEvidenceBundleVersion(capsule.runId) === 1
      ? createEvidenceBundle({ runId: capsule.runId, subjectId: subject?.subject_id ?? null,
        ownerType: 'handoff_capsule', ownerId: `${capsule.dispatchId}:v${capsule.version}`,
        refs: capsule.evidenceRefs, idempotencyKey: `capsule-evidence:${capsule.dispatchId}:v${capsule.version}` })
      : null;
    const storedCapsule: RuntimeHandoffCapsule = bundle ? { ...capsule, evidenceBundleId: bundle.id } : capsule;
    const latest = get<CapsuleRow>('SELECT version,payload FROM runtime_handoff_capsules WHERE dispatch_id=? ORDER BY version DESC LIMIT 1', capsule.dispatchId);
    if (latest?.version === capsule.version) {
      if (latest.payload !== JSON.stringify(storedCapsule)) throw new Error('Capsule 同版本内容冲突');
      return storedCapsule;
    }
    if (capsule.version !== (latest?.version ?? 0) + 1) throw new Error('Capsule 版本不连续');
    run('INSERT INTO runtime_handoff_capsules (id,run_id,dispatch_id,version,source_attempt_id,payload,created_at) VALUES (?,?,?,?,?,?,?)',
      randomUUID(), capsule.runId, capsule.dispatchId, capsule.version, capsule.sourceAttemptId, JSON.stringify(storedCapsule), new Date().toISOString());
    return storedCapsule;
  });
}

/** 旧控制工具只传 message/reason 时，由 Runtime 生成最小、可验证的 Capsule。 */
export function minimalHandoffCapsule(input: {
  runId: string; dispatchId: string; sourceDispatchId: string; sourceAttemptId: string;
  objective: string; message: string; reason: string; sourceMessageId: string; completedWork: string;
  successorObligationRefs?: Array<{ obligationId: string; generation: number }>;
}): RuntimeHandoffCapsule {
  const base: Omit<RuntimeHandoffCapsuleV1, 'schemaVersion' | 'successorObligationRefs'> = {
    version: 1, runId: input.runId, dispatchId: input.dispatchId,
    sourceDispatchId: input.sourceDispatchId, sourceAttemptId: input.sourceAttemptId,
    objective: input.objective, summary: input.message.trim().slice(0, 4_000),
    completedWork: input.completedWork.trim() ? [input.completedWork.trim().slice(0, 2_000)] : [],
    pendingQuestions: input.reason.trim() ? [input.reason.trim().slice(0, 1_000)] : [],
    expectedOutput: '处理交接事项，并将结果返回当前协作流程。',
    successorObligations: ['先核对交接内容和证据，再继续处理；不可把未验证的聊天内容当作事实。'],
    evidenceRefs: [
      { kind: 'message', id: input.sourceMessageId },
      ...(input.completedWork.trim() ? [{ kind: 'attempt_output' as const, id: input.sourceAttemptId }] : []),
    ],
  };
  if (input.successorObligationRefs) {
    const capsule: RuntimeHandoffCapsuleV2 = {
      ...base,
      schemaVersion: 2,
      successorObligationRefs: input.successorObligationRefs,
    };
    return capsule;
  }
  return base;
}
