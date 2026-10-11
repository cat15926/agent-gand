import { randomUUID } from 'node:crypto';
import { get, run, tx } from '../db/database.ts';
import type { LlmRequest, LlmResponse, DeltaHandler, LLMProvider } from '../llm/provider.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { withActivityTimeout } from '../execution/activityTimeout.ts';
import { ExecutionError } from '../execution/errors.ts';
import { assertBusinessStageDeadline, businessStageContext } from './businessStageExecution.ts';

export function executionPolicy(runId: string) {
  const frozen = getRunOrchestrationSnapshot(runId);
  return frozen?.executionAuthority === 'orchestration' ? frozen : null;
}
export function assertExecutionDeadline(runId: string): void {
  const deadline = executionPolicy(runId)?.execution?.deadlineAt;
  if (deadline && Date.now() >= Date.parse(deadline)) throw new ExecutionError('timeout', '本轮任务已超过截止时间', { phase: 'deadline', timeoutKind: 'total' });
}

async function modelChat(runId: string, provider: LLMProvider, request: LlmRequest, delta?: DeltaHandler): Promise<LlmResponse> {
  const policy = executionPolicy(runId);
  const stageSignal = businessStageContext()?.signal;
  const signal = request.signal && stageSignal ? AbortSignal.any([request.signal, stageSignal]) : request.signal ?? stageSignal;
  const modelActivity: { firstResponseAt?: string; lastActivityAt?: string } = {};
  const trustedActivity = () => {
    const at = new Date().toISOString();
    modelActivity.firstResponseAt ??= at; modelActivity.lastActivityAt = at;
  };
  try { return await withActivityTimeout({ ...policy?.request.constraints, signal, deadlineAt: policy?.execution?.deadlineAt },
    (signal, activity) => provider.chat({ ...request, signal, onActivity: kind => {
      if (!signal.aborted) { trustedActivity(); activity(); request.onActivity?.(kind); }
    } }, text => { if (!signal.aborted && text) { trustedActivity(); activity(); delta?.(text); } })); }
  catch (error) {
    if (error instanceof ExecutionError) throw new ExecutionError(error.code, error.message, { ...error.details, modelActivity });
    throw error;
  }
}

/** Reserve before I/O so concurrent branches cannot spend the same allowance. Unknown calls retain their reservation. */
export async function budgetedChat(runId: string, provider: LLMProvider, request: LlmRequest, delta?: DeltaHandler): Promise<LlmResponse> {
  const limit = executionPolicy(runId)?.request.constraints.maxTokens;
  const stage = businessStageContext();
  if (stage && stage.runId !== runId) throw new Error('阶段预算与 Run 不一致');
  assertExecutionDeadline(runId); assertBusinessStageDeadline();
  const scopes = [
    ...(limit ? [{ table: 'orchestration_token_reservations', limit, where: 'run_id=?', params: [runId], label: '本轮' }] : []),
    ...(stage?.maxTokens ? [{ table: 'business_stage_token_reservations', limit: stage.maxTokens, where: 'run_id=? AND stage_id=?', params: [runId, stage.stageId], label: '当前阶段' }] : []),
  ];
  if (!scopes.length) return modelChat(runId, provider, request, delta);
  const desired = Math.max(1, Math.min(...scopes.map(s => s.limit), request.maxTokens ?? 4000));
  let reservation: { id: string; tokens: number } | undefined;
  while (!reservation) {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('执行已停止');
    assertExecutionDeadline(runId); assertBusinessStageDeadline();
    reservation = tx(() => {
      let available = desired;
      let waiting = false;
      for (const scope of scopes) {
        const budget = get<{ charged: number; pending: number; unknown: number }>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) unknown
          FROM ${scope.table} WHERE ${scope.where}`, ...scope.params)!;
        if (budget.unknown) throw new Error(`${scope.label}模型调用消耗未知，预算已保留；不能自动重发`);
        const remaining = scope.limit - budget.charged;
        if (remaining <= 0) { if (budget.pending) waiting = true; else throw new Error(`${scope.label}输出 Token 预算已耗尽`); }
        available = Math.min(available, remaining);
      }
      if (waiting) return undefined;
      const id = randomUUID(), tokens = available, now = new Date().toISOString();
      for (const scope of scopes) {
        if (scope.table === 'business_stage_token_reservations') run('INSERT INTO business_stage_token_reservations(id,run_id,stage_id,reserved,status,created_at) VALUES (?,?,?,?,?,?)', id, runId, stage!.stageId, tokens, 'pending', now);
        else run('INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,?,?,?)', id, runId, tokens, 'pending', now);
      }
      return { id, tokens };
    });
    if (!reservation) await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    const response = await modelChat(runId, provider, { ...request, maxTokens: reservation.tokens }, delta);
    const count = response.usage?.tokensOut;
    // Missing usage conservatively consumes the whole reservation.
    const used = Number.isFinite(count) && count > 0 ? Math.ceil(count) : reservation.tokens;
    tx(() => { for (const scope of scopes) run(`UPDATE ${scope.table} SET used=?,status='settled' WHERE id=? AND status='pending'`, used, reservation!.id); });
    if (used > reservation.tokens) throw new Error('模型服务超过所请求的输出预算，停止后续调用');
    return response;
  } catch (error) {
    tx(() => { for (const scope of scopes) run(`UPDATE ${scope.table} SET status='unknown' WHERE id=? AND status='pending'`, reservation!.id); });
    throw error;
  }
}
