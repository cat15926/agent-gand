import { createHash, randomUUID } from 'node:crypto';
import type {
  RuntimeControlAction,
  RuntimeResponsibilitySnapshot,
  RuntimeShadowComparison,
  RuntimeShadowComparisonClassification,
  RuntimeSubjectCompletionEvaluation,
} from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import type { RuntimeShadowObservationResult } from './shadow.ts';

interface ShadowComparisonRow {
  id: string;
  version: number;
  run_id: string;
  dispatch_id: string;
  attempt_id: string;
  subject_id: string | null;
  generation: number | null;
  action_type: RuntimeControlAction['type'];
  legacy_outcome: string;
  runtime_outcome: string;
  classification: RuntimeShadowComparisonClassification;
  reasons: string;
  responsibility_snapshot: string | null;
  snapshot_fingerprint: string | null;
  output_sha256: string;
  created_at: string;
}

export interface RuntimeShadowComparisonInput {
  runId: string;
  dispatchId: string;
  attemptId: string;
  actionType: RuntimeControlAction['type'];
  legacyOutcome: 'applied' | 'deferred' | 'blocked';
  output: string;
  responsibilitySnapshot: RuntimeResponsibilitySnapshot | null;
  observation: RuntimeShadowObservationResult;
  runtimeEvaluation?: RuntimeSubjectCompletionEvaluation | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toComparison(row: ShadowComparisonRow): RuntimeShadowComparison {
  return {
    id: row.id,
    version: 1,
    runId: row.run_id,
    dispatchId: row.dispatch_id,
    attemptId: row.attempt_id,
    subjectId: row.subject_id,
    generation: row.generation,
    actionType: row.action_type,
    legacyOutcome: row.legacy_outcome,
    runtimeOutcome: row.runtime_outcome,
    classification: row.classification,
    reasons: JSON.parse(row.reasons) as string[],
    responsibilitySnapshot: row.responsibility_snapshot
      ? JSON.parse(row.responsibility_snapshot) as RuntimeResponsibilitySnapshot
      : null,
    snapshotFingerprint: row.snapshot_fingerprint,
    outputSha256: row.output_sha256,
    createdAt: row.created_at,
  };
}

export function classifyRuntimeShadowComparison(input: Pick<RuntimeShadowComparisonInput,
  'legacyOutcome' | 'actionType' | 'observation' | 'runtimeEvaluation'>): {
    runtimeOutcome: string;
    classification: RuntimeShadowComparisonClassification;
    reasons: string[];
  } {
  if (!input.observation.ok) {
    return { runtimeOutcome: 'observer_error', classification: 'observer_error', reasons: [input.observation.error] };
  }
  const evaluation = input.runtimeEvaluation;
  if (evaluation) {
    const runtimeOutcome = `completion_${evaluation.status}`;
    if (input.legacyOutcome === 'blocked' && evaluation.status === 'accepted') {
      return { runtimeOutcome, classification: 'runtime_looser', reasons: evaluation.reasons.length > 0 ? evaluation.reasons : ['RUNTIME_ACCEPTED_LEGACY_BLOCKED'] };
    }
    if (evaluation.status === 'accepted') {
      return { runtimeOutcome, classification: 'match', reasons: ['BOTH_ACCEPT_OUTPUT'] };
    }
    return { runtimeOutcome, classification: 'runtime_stricter', reasons: evaluation.reasons.length > 0 ? evaluation.reasons : [`RUNTIME_${evaluation.status.toUpperCase()}`] };
  }
  return {
    runtimeOutcome: `projected_${input.actionType}`,
    classification: 'projection_only',
    reasons: [input.legacyOutcome === 'deferred' ? 'LEGACY_ACTION_DEFERRED' : 'NON_TERMINAL_ACTION_PROJECTED'],
  };
}

/** 每个 Attempt 只记录一次；审计重放不能制造第二条 Shadow 结论。 */
export function recordRuntimeShadowComparison(input: RuntimeShadowComparisonInput): RuntimeShadowComparison {
  const outputSha256 = sha256(input.output);
  const snapshotJson = input.responsibilitySnapshot ? JSON.stringify(input.responsibilitySnapshot) : null;
  const snapshotFingerprint = snapshotJson ? sha256(snapshotJson) : null;
  const classified = classifyRuntimeShadowComparison(input);
  return tx(() => {
    const existing = get<ShadowComparisonRow>('SELECT * FROM runtime_shadow_comparisons WHERE attempt_id=?', input.attemptId);
    if (existing) {
      if (existing.run_id !== input.runId || existing.dispatch_id !== input.dispatchId
        || existing.action_type !== input.actionType || existing.output_sha256 !== outputSha256) {
        throw new Error(`Shadow Comparison ${input.attemptId} 幂等键冲突`);
      }
      return toComparison(existing);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    run(`INSERT INTO runtime_shadow_comparisons
      (id,version,run_id,dispatch_id,attempt_id,subject_id,generation,action_type,
       legacy_outcome,runtime_outcome,classification,reasons,responsibility_snapshot,
       snapshot_fingerprint,output_sha256,created_at)
      VALUES (?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, input.runId, input.dispatchId, input.attemptId,
    input.responsibilitySnapshot?.subjectId ?? null,
    input.responsibilitySnapshot?.custody.generation ?? null,
    input.actionType, input.legacyOutcome, classified.runtimeOutcome, classified.classification,
    JSON.stringify(classified.reasons), snapshotJson, snapshotFingerprint, outputSha256, createdAt);
    const comparison = toComparison(get<ShadowComparisonRow>('SELECT * FROM runtime_shadow_comparisons WHERE id=?', id)!);
    afterCommit(() => emit({ type: 'runtime.shadow_comparison.recorded', comparison }));
    return comparison;
  });
}

export function listRuntimeShadowComparisons(runId: string): RuntimeShadowComparison[] {
  return all<ShadowComparisonRow>('SELECT * FROM runtime_shadow_comparisons WHERE run_id=? ORDER BY created_at,rowid', runId)
    .map(toComparison);
}
