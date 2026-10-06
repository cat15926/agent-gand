import { randomUUID } from 'node:crypto';
import { get, run, tx } from '../db/database.ts';
import type { LlmRequest, LlmResponse, DeltaHandler, LLMProvider } from '../llm/provider.ts';
import { getRunOrchestrationSnapshot } from './store.ts';

export function executionPolicy(runId: string) {
  const frozen = getRunOrchestrationSnapshot(runId);
  return frozen?.executionAuthority === 'orchestration' ? frozen : null;
}
export function assertExecutionDeadline(runId: string): void {
  const deadline = executionPolicy(runId)?.execution?.deadlineAt;
  if (deadline && Date.now() >= Date.parse(deadline)) throw new Error('本轮任务已超过截止时间');
}

/** Reserve before I/O so concurrent branches cannot spend the same allowance. Unknown calls retain their reservation. */
export async function budgetedChat(runId: string, provider: LLMProvider, request: LlmRequest, delta?: DeltaHandler): Promise<LlmResponse> {
  const limit = executionPolicy(runId)?.request.constraints.maxTokens;
  assertExecutionDeadline(runId);
  if (!limit) return provider.chat(request, delta);
  const desired = Math.max(1, Math.min(limit, request.maxTokens ?? 4000));
  let reservation: { id: string; tokens: number } | undefined;
  while (!reservation) {
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('执行已停止');
    assertExecutionDeadline(runId);
    reservation = tx(() => {
      const budget = get<{ charged: number; pending: number; unknown: number }>(`SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending, SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) unknown
        FROM orchestration_token_reservations WHERE run_id=?`, runId)!;
      if (budget.unknown) throw new Error('模型调用消耗未知，预算已保留；不能自动重发');
      const available = limit - budget.charged;
      if (available <= 0) { if (budget.pending) return undefined; throw new Error('本轮输出 Token 预算已耗尽'); }
      const id = randomUUID(), tokens = Math.min(desired, available);
      run('INSERT INTO orchestration_token_reservations(id,run_id,reserved,status,created_at) VALUES (?,?,?,?,?)', id, runId, tokens, 'pending', new Date().toISOString());
      return { id, tokens };
    });
    if (!reservation) await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    const response = await provider.chat({ ...request, maxTokens: reservation.tokens }, delta);
    const count = response.usage?.tokensOut;
    // Missing usage conservatively consumes the whole reservation.
    const used = Number.isFinite(count) && count > 0 ? Math.ceil(count) : reservation.tokens;
    run("UPDATE orchestration_token_reservations SET used=?,status='settled' WHERE id=? AND status='pending'", used, reservation.id);
    if (used > reservation.tokens) throw new Error('模型服务超过所请求的输出预算，停止后续调用');
    return response;
  } catch (error) {
    run("UPDATE orchestration_token_reservations SET status='unknown' WHERE id=? AND status='pending'", reservation.id);
    throw error;
  }
}
