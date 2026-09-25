import { randomUUID } from 'node:crypto';
import type {
  RuntimeRunContract,
  RuntimeSuccessorObligation,
  RuntimeSuccessorObligationKind,
  RuntimeSuccessorObligationStatus,
} from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface ObligationRow {
  id: string;
  run_id: string;
  parent_subject_id: string;
  kind: RuntimeSuccessorObligationKind;
  target_subject_id: string | null;
  source_action_id: string;
  stable_key: string;
  status: RuntimeSuccessorObligationStatus;
  required: number;
  generation: number;
  payload: string;
  resolution_source_id: string | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

function toObligation(row: ObligationRow): RuntimeSuccessorObligation {
  return {
    id: row.id,
    runId: row.run_id,
    parentSubjectId: row.parent_subject_id,
    kind: row.kind,
    targetSubjectId: row.target_subject_id,
    sourceActionId: row.source_action_id,
    stableKey: row.stable_key,
    status: row.status,
    required: row.required === 1,
    generation: row.generation,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    resolutionSourceId: row.resolution_source_id,
    resolution: row.resolution ? JSON.parse(row.resolution) as Record<string, unknown> : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function emitAfterCommit(obligation: RuntimeSuccessorObligation): void {
  afterCommit(() => emit({ type: 'runtime.successor_obligation.updated', obligation }));
}

export function successorObligationVersion(runId: string): 1 | null {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  try { return (JSON.parse(row.payload) as RuntimeRunContract).features?.successorObligationVersion === 1 ? 1 : null; }
  catch { return null; }
}

export interface OpenSuccessorObligationInput {
  runId: string;
  parentSubjectId: string;
  kind: RuntimeSuccessorObligationKind;
  targetSubjectId?: string | null;
  sourceActionId: string;
  stableKey: string;
  required?: boolean;
  payload?: Record<string, unknown>;
  /** Review FAIL 等新一轮义务会取消上一 open generation 并推进代际。 */
  advance?: boolean;
}

export function openSuccessorObligation(input: OpenSuccessorObligationInput): RuntimeSuccessorObligation | null {
  if (successorObligationVersion(input.runId) !== 1) return null;
  return tx(() => {
    const parent = get<{ run_id: string }>('SELECT run_id FROM runtime_subjects WHERE id=?', input.parentSubjectId);
    if (!parent || parent.run_id !== input.runId) throw new Error('后继义务的 parent Subject 不属于当前 Run');
    if (input.targetSubjectId) {
      const target = get<{ run_id: string }>('SELECT run_id FROM runtime_subjects WHERE id=?', input.targetSubjectId);
      if (!target || target.run_id !== input.runId) throw new Error('后继义务的 target Subject 不属于当前 Run');
    }
    const duplicate = get<ObligationRow>(`SELECT * FROM runtime_successor_obligations
      WHERE run_id=? AND kind=? AND source_action_id=? AND stable_key=?`,
    input.runId, input.kind, input.sourceActionId, input.stableKey);
    if (duplicate) {
      if (duplicate.parent_subject_id !== input.parentSubjectId
        || duplicate.target_subject_id !== (input.targetSubjectId ?? null)) {
        throw new Error(`后继义务幂等来源冲突：${input.sourceActionId}`);
      }
      return toObligation(duplicate);
    }
    const latest = get<ObligationRow>(`SELECT * FROM runtime_successor_obligations
      WHERE run_id=? AND stable_key=? ORDER BY generation DESC LIMIT 1`, input.runId, input.stableKey);
    if (latest?.status === 'open' && !input.advance) {
      throw new Error(`后继义务 ${input.stableKey} 已存在未完成 generation`);
    }
    if (latest?.status === 'open') {
      const now = new Date().toISOString();
      run(`UPDATE runtime_successor_obligations SET status='cancelled',resolution_source_id=?,resolution=?,resolved_at=?
        WHERE id=? AND generation=? AND status='open'`, input.sourceActionId,
      JSON.stringify({ reason: 'superseded_by_new_generation', nextSourceActionId: input.sourceActionId }), now,
      latest.id, latest.generation);
      const cancelled = toObligation(get<ObligationRow>('SELECT * FROM runtime_successor_obligations WHERE id=?', latest.id)!);
      emitAfterCommit(cancelled);
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    run(`INSERT INTO runtime_successor_obligations
      (id,run_id,parent_subject_id,kind,target_subject_id,source_action_id,stable_key,status,required,generation,payload,created_at)
      VALUES (?,?,?,?,?,?,?,'open',?,?,?,?)`, id, input.runId, input.parentSubjectId, input.kind,
    input.targetSubjectId ?? null, input.sourceActionId, input.stableKey, input.required === false ? 0 : 1,
    (latest?.generation ?? 0) + 1, JSON.stringify(input.payload ?? {}), now);
    const obligation = toObligation(get<ObligationRow>('SELECT * FROM runtime_successor_obligations WHERE id=?', id)!);
    emitAfterCommit(obligation);
    return obligation;
  });
}

export function settleSuccessorObligation(input: {
  id: string;
  expectedGeneration: number;
  status: Exclude<RuntimeSuccessorObligationStatus, 'open'>;
  resolutionSourceId: string;
  resolution?: Record<string, unknown>;
}): { obligation: RuntimeSuccessorObligation | null; changed: boolean } {
  return tx(() => {
    const now = new Date().toISOString();
    const changed = run(`UPDATE runtime_successor_obligations SET status=?,resolution_source_id=?,resolution=?,resolved_at=?
      WHERE id=? AND generation=? AND status='open'`, input.status, input.resolutionSourceId,
    JSON.stringify(input.resolution ?? {}), now, input.id, input.expectedGeneration) > 0;
    const row = get<ObligationRow>('SELECT * FROM runtime_successor_obligations WHERE id=?', input.id);
    const obligation = row ? toObligation(row) : null;
    if (changed && obligation) emitAfterCommit(obligation);
    return { obligation, changed };
  });
}

export function listSuccessorObligations(runId: string): RuntimeSuccessorObligation[] {
  return all<ObligationRow>(`SELECT * FROM runtime_successor_obligations
    WHERE run_id=? ORDER BY created_at,rowid`, runId).map(toObligation);
}

export function listOpenSuccessorObligations(input: {
  runId?: string;
  parentSubjectId?: string;
  targetSubjectId?: string;
  kind?: RuntimeSuccessorObligationKind;
}): RuntimeSuccessorObligation[] {
  const where = ["status='open'"]; const params: unknown[] = [];
  if (input.runId) { where.push('run_id=?'); params.push(input.runId); }
  if (input.parentSubjectId) { where.push('parent_subject_id=?'); params.push(input.parentSubjectId); }
  if (input.targetSubjectId) { where.push('target_subject_id=?'); params.push(input.targetSubjectId); }
  if (input.kind) { where.push('kind=?'); params.push(input.kind); }
  return all<ObligationRow>(`SELECT * FROM runtime_successor_obligations WHERE ${where.join(' AND ')} ORDER BY created_at,rowid`, ...params)
    .map(toObligation);
}

export function countUnsatisfiedRequiredObligations(parentSubjectId: string): number {
  return get<{ n: number }>(`SELECT COUNT(*) n FROM runtime_successor_obligations
    WHERE parent_subject_id=? AND required=1 AND status<>'satisfied'`, parentSubjectId)?.n ?? 0;
}

export function requiredSuccessorObligationsSatisfied(runId: string, parentSubjectIds?: string[]): boolean {
  if (successorObligationVersion(runId) !== 1) return true;
  if (parentSubjectIds && parentSubjectIds.length === 0) return true;
  const placeholders = parentSubjectIds?.map(() => '?').join(',');
  const row = parentSubjectIds
    ? get(`SELECT 1 FROM runtime_successor_obligations WHERE run_id=? AND required=1 AND status<>'satisfied'
        AND parent_subject_id IN (${placeholders}) LIMIT 1`, runId, ...parentSubjectIds)
    : get("SELECT 1 FROM runtime_successor_obligations WHERE run_id=? AND required=1 AND status<>'satisfied' LIMIT 1", runId);
  return !row;
}

export function settleTargetObligations(input: {
  targetSubjectId: string;
  status: 'satisfied' | 'failed' | 'cancelled';
  resolutionSourceId: string;
  kinds?: RuntimeSuccessorObligationKind[];
  resolution?: Record<string, unknown>;
}): number {
  const allowed = input.kinds ?? ['consult_result'];
  let changed = 0;
  for (const obligation of listOpenSuccessorObligations({ targetSubjectId: input.targetSubjectId })) {
    if (!allowed.includes(obligation.kind)) continue;
    const settled = settleSuccessorObligation({ id: obligation.id, expectedGeneration: obligation.generation,
      status: input.status, resolutionSourceId: input.resolutionSourceId, resolution: input.resolution }).changed;
    if (settled) changed++;
    if (!settled || obligation.kind !== 'consult_result' || obligation.payload.join !== 'any'
      || input.status !== 'satisfied') continue;
    for (const group of listOpenSuccessorObligations({ parentSubjectId: obligation.parentSubjectId, kind: 'consult_result' })) {
      if (group.targetSubjectId !== null || group.payload.join !== 'any'
        || group.payload.batchId !== obligation.payload.batchId) continue;
      if (settleSuccessorObligation({ id: group.id, expectedGeneration: group.generation, status: 'satisfied',
        resolutionSourceId: input.resolutionSourceId,
        resolution: { ...(input.resolution ?? {}), join: 'any', satisfiedBySubjectId: input.targetSubjectId } }).changed) changed++;
    }
  }
  return changed;
}

export function settleSubjectObligations(input: {
  subjectId: string;
  status: 'failed' | 'cancelled';
  resolutionSourceId: string;
  resolution?: Record<string, unknown>;
}): number {
  const obligations = new Map<string, RuntimeSuccessorObligation>();
  for (const item of listOpenSuccessorObligations({ parentSubjectId: input.subjectId })) obligations.set(item.id, item);
  for (const item of listOpenSuccessorObligations({ targetSubjectId: input.subjectId })) obligations.set(item.id, item);
  let changed = 0;
  for (const obligation of obligations.values()) {
    if (settleSuccessorObligation({ id: obligation.id, expectedGeneration: obligation.generation,
      status: input.status, resolutionSourceId: input.resolutionSourceId, resolution: input.resolution }).changed) changed++;
  }
  return changed;
}

export function openUserDecisionObligations(runId: string, decisionId: string, dispatchId: string | null,
  payload: Record<string, unknown> = {}): RuntimeSuccessorObligation[] {
  if (successorObligationVersion(runId) !== 1) return [];
  const subjectIds = dispatchId
    ? all<{ id: string }>(`SELECT s.id FROM runtime_dispatch_subjects m
        JOIN runtime_subjects s ON s.id=m.subject_id WHERE m.dispatch_id=?`, dispatchId).map((item) => item.id)
    : all<{ id: string }>(`SELECT s.id FROM runtime_subjects s
        WHERE s.run_id=? AND s.parent_subject_id IS NULL AND s.status NOT IN ('failed','cancelled')`, runId).map((item) => item.id);
  return subjectIds.flatMap((subjectId) => {
    const obligation = openSuccessorObligation({ runId, parentSubjectId: subjectId, targetSubjectId: subjectId,
      kind: 'user_decision', sourceActionId: decisionId, stableKey: `user-decision:${decisionId}:${subjectId}`,
      payload: { decisionId, dispatchId, ...payload } });
    return obligation ? [obligation] : [];
  });
}

export function resolveUserDecisionObligations(runId: string, decisionId: string,
  resolutionSourceId: string, resolution: Record<string, unknown>): number {
  let changed = 0;
  const rows = all<ObligationRow>(`SELECT * FROM runtime_successor_obligations
    WHERE run_id=? AND kind='user_decision' AND source_action_id=? AND status='open'`, runId, decisionId);
  for (const row of rows) {
    if (settleSuccessorObligation({ id: row.id, expectedGeneration: row.generation, status: 'satisfied',
      resolutionSourceId, resolution }).changed) changed++;
  }
  return changed;
}

export function cancelRunObligations(runId: string, resolutionSourceId: string): number {
  let changed = 0;
  for (const obligation of listOpenSuccessorObligations({ runId })) {
    if (settleSuccessorObligation({ id: obligation.id, expectedGeneration: obligation.generation,
      status: 'cancelled', resolutionSourceId, resolution: { reason: 'run_cancelled' } }).changed) changed++;
  }
  return changed;
}
