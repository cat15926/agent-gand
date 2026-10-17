import { get, run, tx } from '../db/database.ts';
import { assertExecutionDeadline,executionPolicy,ModelAdmissionPausedError } from '../orchestration/executionBudget.ts';
import { modelCallWaiting } from '../orchestration/modelCalls.ts';
import {businessStageContext,assertBusinessStageDeadline} from '../orchestration/businessStageExecution.ts';
import {config} from '../config.ts';
import {assertAutonomousModelAdmission} from '../runtime/autonomousExecution.ts';

/** Native internal turns have no enforceable output cap. Reserve the remaining Run
 * allowance exclusively; reported usage settles it, missing usage blocks later calls.
 * This is admission accounting, never a claim about the supplier's hard limit. */
export async function reserveScopedNativeTokens(runId: string, callId: string, signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw signal.reason;
    assertExecutionDeadline(runId);
    const call=get<{agent_id:string;attempt_id:string|null;model:string;backend:string}>('SELECT agent_id,attempt_id,model,backend FROM orchestration_model_calls WHERE id=? AND run_id=?',callId,runId);
    const autonomous=assertAutonomousModelAdmission(runId,call?.agent_id??'',call?.attempt_id??undefined,call?.model,call?.backend);
    assertBusinessStageDeadline();
    const stage=businessStageContext();if(stage&&stage.runId!==runId)throw new Error('SCOPE_BINDING_INVALID');
    if(get("SELECT 1 FROM coordination_plans WHERE run_id=? AND status='pause_requested'",runId))throw new ModelAdmissionPausedError();
    const acquired = tx(() => {
      const plan = get<{ max_tokens: number }>('SELECT max_tokens FROM scoped_delivery_plans WHERE run_id=?', runId);
      const limit=autonomous?.budget.maxOutputTokens??plan?.max_tokens??executionPolicy(runId)?.request.constraints.maxTokens??config.collaboration.maxTokens;
      const scopes=[{table:'orchestration_token_reservations',limit,where:'run_id=?',params:[runId]},...(stage?.maxTokens?[{table:'business_stage_token_reservations',limit:stage.maxTokens,where:'run_id=? AND stage_id=?',params:[runId,stage.stageId]}]:[])];
      let remaining=limit;
      for(const scope of scopes) {
        const budget=get<{charged:number;pending:number;unknown:number}>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,COALESCE(SUM(status='pending'),0) pending,COALESCE(SUM(status='unknown'),0) unknown FROM ${scope.table} WHERE ${scope.where}`,...scope.params)!;
        if(budget.unknown)throw new Error('SCOPED_NATIVE_USAGE_UNKNOWN');
        if(budget.pending){modelCallWaiting(callId,'tokens');return false;}
        remaining=Math.min(remaining,scope.limit-budget.charged);
      }
      if(remaining<=0)throw new Error('SCOPED_TOKEN_BUDGET_EXHAUSTED');
      for(const scope of scopes) {
        const now=new Date().toISOString();
        if(scope.table==='business_stage_token_reservations')run("INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES (?,?,?,?,'pending',?)",callId,runId,stage!.stageId,remaining,now);
        else run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,?,'pending',?)",callId,runId,remaining,now);
      }
      return true;
    });
    if (acquired) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/** Caller settles money in the same SQLite transaction. Never replace a recovered unknown. */
export function settleScopedNativeTokens(callId: string, tokensOut: number | null): boolean {
  const row = get<{ reserved: number }>("SELECT reserved FROM orchestration_token_reservations WHERE id=? AND status='pending'", callId);
  if (!row) return true;
  const known = tokensOut !== null && Number.isFinite(tokensOut) && tokensOut >= 0;
  run("UPDATE orchestration_token_reservations SET status=?,used=? WHERE id=? AND status='pending'", known ? 'settled' : 'unknown', known ? Math.ceil(tokensOut!) : row.reserved, callId);
  run("UPDATE business_stage_token_reservations SET status=?,used=? WHERE id=? AND status='pending'",known?'settled':'unknown',known?Math.ceil(tokensOut!):row.reserved,callId);
  return !known||tokensOut!<=row.reserved;
}
