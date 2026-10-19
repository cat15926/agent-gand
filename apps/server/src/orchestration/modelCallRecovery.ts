import { isLegacyRun } from '../runs/legacyMode.ts';
import { all, get, run, tx } from '../db/database.ts';

/** G4 shares the call ID across token and money reservations; no usage is inferred from output text. */
export function reconcileModelCallReservations(id: string): void {
  tx(() => {
    const call = get<{ run_id: string; status: string; started_at: string | null }>('SELECT run_id,status,started_at FROM orchestration_model_calls WHERE id=?', id);
    if (!call || !isLegacyRun(call.run_id)) return;
    const issued = call.started_at !== null;
    for (const table of ['orchestration_token_reservations', 'business_stage_token_reservations']) {
      if (issued) run(`UPDATE ${table} SET status='unknown' WHERE id=? AND status='pending'`, id);
      else run(`UPDATE ${table} SET status='settled',used=0 WHERE id=? AND status='pending'`, id);
    }
    if (issued) run("UPDATE execution_cost_reservations SET status='unknown',settled_at=? WHERE id=? AND status='pending'", new Date().toISOString(), id);
    else run("UPDATE execution_cost_reservations SET status='settled',known=0,settled_at=? WHERE id=? AND status='pending'", new Date().toISOString(), id);
    run("UPDATE orchestration_model_calls SET status=?,finished_at=? WHERE id=? AND status IN ('waiting','started')",
      issued ? 'unknown' : 'admission_blocked', new Date().toISOString(), id);
  });
}

/** Called in the lease-interruption transaction, never against a live sibling's reservations. */
export function recoverScopedAttemptCalls(attemptId: string): boolean {
  const calls = all<{ id: string; status: string }>('SELECT id,status FROM orchestration_model_calls WHERE attempt_id=?', attemptId);
  for (const call of calls) reconcileModelCallReservations(call.id);
  return calls.some(call => !!get(`SELECT 1 FROM orchestration_model_calls c WHERE c.id=? AND
    (c.status='unknown' OR EXISTS (SELECT 1 FROM orchestration_token_reservations t WHERE t.id=c.id AND t.status='unknown')
    OR EXISTS (SELECT 1 FROM execution_cost_reservations m WHERE m.id=c.id AND m.status='unknown'))`, call.id));
}
