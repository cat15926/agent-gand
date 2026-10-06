import { get, run } from '../db/database.ts';
import { getRun, setRunStatus } from '../runs/trace.ts';

export function settleRequestedPause(runId: string): boolean {
  const control = get<{ pause_requested: number; recovery_attention: number }>('SELECT pause_requested,recovery_attention FROM orchestration_run_controls WHERE run_id=?', runId);
  if (!control?.pause_requested && !control?.recovery_attention) return false;
  const item = getRun(runId);
  if (!item || ['completed','failed','cancelled'].includes(item.status)) return false;
  if (control.recovery_attention) { setRunStatus(runId, 'waiting_for_user'); return true; }
  const active = get<{ n: number }>(`SELECT
    (SELECT COUNT(*) FROM task_attempts WHERE run_id=? AND status='running') +
    (SELECT COUNT(*) FROM collaboration_attempts WHERE run_id=? AND status='running') n`, runId, runId)?.n ?? 0;
  if (!active) setRunStatus(runId, 'waiting_for_user');
  return true;
}
export function requestAdapterPause(runId: string): void {
  run(`INSERT INTO orchestration_run_controls(run_id,pause_requested) VALUES (?,1)
    ON CONFLICT(run_id) DO UPDATE SET pause_requested=1`, runId);
  settleRequestedPause(runId);
}
