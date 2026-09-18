import type { RunCheckpoint, RunCheckpointKind, RunCheckpointStatus } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';

interface Row { id: string; run_id: string; seq: number; kind: string; status: string; phase: string; state: string; waiting_on: string | null; created_at: string; updated_at: string }
const map = (row: Row): RunCheckpoint => ({ id: row.id, runId: row.run_id, seq: row.seq, kind: row.kind as RunCheckpointKind,
  status: row.status as RunCheckpointStatus, phase: row.phase, state: JSON.parse(row.state) as Record<string, unknown>,
  waitingOn: row.waiting_on, createdAt: row.created_at, updatedAt: row.updated_at });

export function latestCheckpoint(runId: string, kind?: RunCheckpointKind): RunCheckpoint | undefined {
  const row = kind
    ? get<Row>('SELECT * FROM run_checkpoints WHERE run_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1', runId, kind)
    : get<Row>('SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1', runId);
  return row ? map(row) : undefined;
}

export function listCheckpoints(runId: string): RunCheckpoint[] {
  return all<Row>('SELECT * FROM run_checkpoints WHERE run_id = ? ORDER BY seq ASC', runId).map(map);
}

export function saveCheckpoint(input: { runId: string; kind: RunCheckpointKind; phase: string; state?: Record<string, unknown>; status?: RunCheckpointStatus; waitingOn?: string | null }): RunCheckpoint {
  return tx(() => {
    const previous = get<{ seq: number }>('SELECT seq FROM run_checkpoints WHERE run_id = ? ORDER BY seq DESC LIMIT 1', input.runId);
    const now = new Date().toISOString();
    run("UPDATE run_checkpoints SET status = 'superseded', updated_at = ? WHERE run_id = ? AND status IN ('active','waiting')", now, input.runId);
    const id = randomUUID();
    run(`INSERT INTO run_checkpoints (id, run_id, seq, kind, status, phase, state, waiting_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.runId, (previous?.seq ?? 0) + 1, input.kind,
      input.status ?? 'active', input.phase, JSON.stringify(input.state ?? {}), input.waitingOn ?? null, now, now);
    return map(get<Row>('SELECT * FROM run_checkpoints WHERE id = ?', id)!);
  });
}
