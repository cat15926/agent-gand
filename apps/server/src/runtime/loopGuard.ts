import { createHash, randomUUID } from 'node:crypto';
import type { RuntimeEvidenceRef, RuntimeRouteGuardEvent, RuntimeRunContract } from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { evidenceFingerprint, listEvidenceBundles } from './evidence.ts';

interface GuardRow {
  id: string; run_id: string; subject_id: string; source_dispatch_id: string;
  from_agent_id: string; target_agent_id: string; objective_hash: string; evidence_fingerprint: string;
  repeated_count: number; outcome: RuntimeRouteGuardEvent['outcome']; reason: string | null; created_at: string;
}

function toEvent(row: GuardRow): RuntimeRouteGuardEvent {
  return {
    id: row.id, runId: row.run_id, subjectId: row.subject_id, sourceDispatchId: row.source_dispatch_id,
    fromAgentId: row.from_agent_id, targetAgentId: row.target_agent_id, objectiveHash: row.objective_hash,
    evidenceFingerprint: row.evidence_fingerprint, repeatedCount: row.repeated_count,
    outcome: row.outcome, reason: row.reason, createdAt: row.created_at,
  };
}

export function runtimeEvidenceLoopGuardVersion(runId: string): 1 | null {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return null;
  try { return (JSON.parse(row.payload) as RuntimeRunContract).features?.evidenceLoopGuardVersion === 1 ? 1 : null; }
  catch { return null; }
}

function substantiveSubjectEvidence(runId: string, subjectId: string): RuntimeEvidenceRef[] {
  const toolRefs = all<{ id: string }>(`SELECT te.id FROM tool_executions te
    JOIN collaboration_attempts a ON a.id=te.attempt_id
    JOIN runtime_dispatch_subjects m ON m.dispatch_id=a.dispatch_id
    WHERE te.run_id=? AND m.subject_id=? AND te.status='completed' ORDER BY te.created_at,te.rowid`, runId, subjectId)
    .map((item): RuntimeEvidenceRef => ({ kind: 'tool_execution', id: item.id }));
  const bundleRefs = listEvidenceBundles(runId).filter((bundle) => bundle.subjectId === subjectId)
    .flatMap((bundle) => bundle.status === 'valid' ? bundle.refs : [])
    .filter((ref) => ref.kind === 'tool_execution' || ref.kind === 'workspace_file' || ref.kind === 'run_event');
  return [...new Map([...toolRefs, ...bundleRefs].map((ref) => [JSON.stringify(ref), ref])).values()];
}

function objectiveHash(objective: string): string {
  const normalized = objective.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

function samePair(row: GuardRow, fromAgentId: string, targetAgentId: string): boolean {
  return [row.from_agent_id, row.target_agent_id].sort().join('\0') === [fromAgentId, targetAgentId].sort().join('\0');
}

export function recordEvidenceAwareRoute(input: {
  runId: string;
  subjectId: string;
  sourceDispatchId: string;
  fromAgentId: string;
  targetAgentId: string;
  objective: string;
  warnAt: number;
  blockAt: number;
}): RuntimeRouteGuardEvent {
  return tx(() => {
    const targetHash = objectiveHash(input.objective);
    const fingerprint = evidenceFingerprint(input.runId, substantiveSubjectEvidence(input.runId, input.subjectId));
    const history = all<GuardRow>(`SELECT * FROM runtime_route_guard_events
      WHERE run_id=? AND subject_id=? ORDER BY created_at DESC,rowid DESC`, input.runId, input.subjectId);
    let previous = 0;
    for (const item of history) {
      if (item.objective_hash !== targetHash || item.evidence_fingerprint !== fingerprint
        || !samePair(item, input.fromAgentId, input.targetAgentId)) break;
      previous += 1;
    }
    const repeatedCount = previous + 1;
    const outcome: RuntimeRouteGuardEvent['outcome'] = repeatedCount >= input.blockAt
      ? 'blocked' : repeatedCount >= input.warnAt ? 'warned' : 'allowed';
    const reason = outcome === 'blocked'
      ? `EVIDENCE_LOOP_NEEDS_ATTENTION: 同一 Subject/目标在无新证据时已连续往返 ${repeatedCount} 次`
      : outcome === 'warned'
        ? `EVIDENCE_LOOP_WARNING: 无新证据往返 ${repeatedCount} 次`
        : null;
    const now = new Date().toISOString(); const id = randomUUID();
    const event: RuntimeRouteGuardEvent = { id, runId: input.runId, subjectId: input.subjectId,
      sourceDispatchId: input.sourceDispatchId, fromAgentId: input.fromAgentId, targetAgentId: input.targetAgentId,
      objectiveHash: targetHash, evidenceFingerprint: fingerprint, repeatedCount, outcome, reason, createdAt: now };
    persistRouteGuardEvent(event);
    return event;
  });
}

export function persistRouteGuardEvent(event: RuntimeRouteGuardEvent): void {
  const changed = run(`INSERT OR IGNORE INTO runtime_route_guard_events
    (id,run_id,subject_id,source_dispatch_id,from_agent_id,target_agent_id,objective_hash,evidence_fingerprint,repeated_count,outcome,reason,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, event.id, event.runId, event.subjectId, event.sourceDispatchId,
  event.fromAgentId, event.targetAgentId, event.objectiveHash, event.evidenceFingerprint,
  event.repeatedCount, event.outcome, event.reason, event.createdAt);
  if (changed > 0) afterCommit(() => emit({ type: 'runtime.route_guard.updated', event }));
}

export function listRouteGuardEvents(runId: string): RuntimeRouteGuardEvent[] {
  return all<GuardRow>('SELECT * FROM runtime_route_guard_events WHERE run_id=? ORDER BY created_at,rowid', runId).map(toEvent);
}
