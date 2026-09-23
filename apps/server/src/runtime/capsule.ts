import { randomUUID } from 'node:crypto';
import type { RuntimeHandoffCapsule } from '@agent-gand/shared';
import { get, run, tx } from '../db/database.ts';
import { resolveEvidence } from './evidence.ts';

interface CapsuleRow { version: number; payload: string; }

export function latestHandoffCapsule(dispatchId: string, runId: string): RuntimeHandoffCapsule | null {
  const row = get<CapsuleRow>('SELECT version,payload FROM runtime_handoff_capsules WHERE dispatch_id=? AND run_id=? ORDER BY version DESC LIMIT 1', dispatchId, runId);
  return row ? JSON.parse(row.payload) as RuntimeHandoffCapsule : null;
}

/** 同一 Dispatch 的修订只能追加版本；重试同版本必须内容相同。 */
export function saveHandoffCapsule(capsule: RuntimeHandoffCapsule): RuntimeHandoffCapsule {
  return tx(() => {
    const dispatch = get<{ run_id: string; parent_dispatch_id: string | null; kind: string }>(
      'SELECT run_id,parent_dispatch_id,kind FROM collaboration_dispatches WHERE id=?', capsule.dispatchId);
    const source = get<{ run_id: string; dispatch_id: string; status: string }>(
      'SELECT run_id,dispatch_id,status FROM collaboration_attempts WHERE id=?', capsule.sourceAttemptId);
    if (!dispatch || dispatch.run_id !== capsule.runId || dispatch.kind !== 'handoff' || dispatch.parent_dispatch_id !== capsule.sourceDispatchId
      || !source || source.run_id !== capsule.runId || source.dispatch_id !== capsule.sourceDispatchId || source.status !== 'completed') {
      throw new Error('Capsule 来源 Dispatch/Attempt 无效或尚未完成');
    }
    if (capsule.evidenceRefs.length > 12 || capsule.evidenceRefs.some((ref) => !resolveEvidence(capsule.runId, ref).trusted)) {
      throw new Error('Capsule 含无效、跨 Run 或未完成的证据引用');
    }
    const latest = get<CapsuleRow>('SELECT version,payload FROM runtime_handoff_capsules WHERE dispatch_id=? ORDER BY version DESC LIMIT 1', capsule.dispatchId);
    if (latest?.version === capsule.version) {
      if (latest.payload !== JSON.stringify(capsule)) throw new Error('Capsule 同版本内容冲突');
      return capsule;
    }
    if (capsule.version !== (latest?.version ?? 0) + 1) throw new Error('Capsule 版本不连续');
    run('INSERT INTO runtime_handoff_capsules (id,run_id,dispatch_id,version,source_attempt_id,payload,created_at) VALUES (?,?,?,?,?,?,?)',
      randomUUID(), capsule.runId, capsule.dispatchId, capsule.version, capsule.sourceAttemptId, JSON.stringify(capsule), new Date().toISOString());
    return capsule;
  });
}

/** 旧控制工具只传 message/reason 时，由 Runtime 生成最小、可验证的 Capsule。 */
export function minimalHandoffCapsule(input: {
  runId: string; dispatchId: string; sourceDispatchId: string; sourceAttemptId: string;
  objective: string; message: string; reason: string; sourceMessageId: string; completedWork: string;
}): RuntimeHandoffCapsule {
  return {
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
}
