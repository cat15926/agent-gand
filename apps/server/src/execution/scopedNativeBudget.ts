import { get, run, tx } from '../db/database.ts';
import { assertExecutionDeadline } from '../orchestration/executionBudget.ts';
import { modelCallWaiting } from '../orchestration/modelCalls.ts';

/** Native internal turns have no enforceable output cap. Reserve the remaining Run
 * allowance exclusively; reported usage settles it, missing usage blocks later calls.
 * This is admission accounting, never a claim about the supplier's hard limit. */
export async function reserveScopedNativeTokens(runId: string, callId: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw signal.reason;
    assertExecutionDeadline(runId);
    const acquired = tx(() => {
      const plan = get<{ max_tokens: number }>('SELECT max_tokens FROM scoped_delivery_plans WHERE run_id=?', runId);
      if (!plan) throw new Error('SCOPE_BINDING_INVALID');
      const budget = get<{ charged: number; pending: number; unknown: number }>(`SELECT
        COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,
        COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(status='unknown'),0) unknown
        FROM orchestration_token_reservations WHERE run_id=?`, runId)!;
      if (budget.unknown) throw new Error('SCOPED_NATIVE_USAGE_UNKNOWN');
      if (budget.pending) { modelCallWaiting(callId, 'tokens'); return false; }
      const remaining = plan.max_tokens - budget.charged;
      if (remaining <= 0) throw new Error('SCOPED_TOKEN_BUDGET_EXHAUSTED');
      run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,?,'pending',?)", callId, runId, remaining, new Date().toISOString());
      return true;
    });
    if (acquired) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Caller settles money in the same SQLite transaction. Never replace a recovered unknown. */
export function settleScopedNativeTokens(callId: string, tokensOut: number | null): void {
  const row = get<{ reserved: number }>("SELECT reserved FROM orchestration_token_reservations WHERE id=? AND status='pending'", callId);
  if (!row) return;
  const known = tokensOut !== null && Number.isFinite(tokensOut) && tokensOut >= 0;
  run("UPDATE orchestration_token_reservations SET status=?,used=? WHERE id=? AND status='pending'", known ? 'settled' : 'unknown', known ? Math.ceil(tokensOut!) : row.reserved, callId);
}
