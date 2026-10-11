import { AsyncLocalStorage } from 'node:async_hooks';
import type { BusinessStage } from '@agent-gand/shared';
import { get, run } from '../db/database.ts';
import { ExecutionError } from '../execution/errors.ts';

export interface BusinessStageContext { runId: string; stageId: string; maxTokens?: number; deadlineAt?: number; signal: AbortSignal }
const current = new AsyncLocalStorage<BusinessStageContext>();
export const businessStageContext = () => current.getStore();
export function assertBusinessStageDeadline(): void {
  const context = current.getStore();
  if (context?.signal.aborted) throw context.signal.reason;
  if (context?.deadlineAt && Date.now() >= context.deadlineAt) throw new ExecutionError('timeout', '当前阶段执行时限已耗尽', { phase: 'deadline', timeoutKind: 'total' });
}
/** Start once from a persisted worker claim; waiting for owner acceptance never starts another clock. */
export async function withBusinessStageExecution<T>(runId: string, stage: BusinessStage, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  run('INSERT OR IGNORE INTO business_stage_executions(run_id,stage_id,started_at) VALUES (?,?,?)', runId, stage.id, new Date().toISOString());
  const timing = get<{ started_at: string }>('SELECT started_at FROM business_stage_executions WHERE run_id=? AND stage_id=?', runId, stage.id)!;
  const deadlineAt = stage.execution?.timeoutMs ? Date.parse(timing.started_at) + stage.execution.timeoutMs : undefined;
  const controller = new AbortController();
  const expire = () => controller.abort(new ExecutionError('timeout', `阶段「${stage.title}」执行时限已耗尽`, { phase: 'deadline', timeoutKind: 'total', limitMs: stage.execution!.timeoutMs }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineAt) { if (deadlineAt <= Date.now()) expire(); else timer = setTimeout(expire, deadlineAt - Date.now()); }
  try {
    return await current.run({ runId, stageId: stage.id, maxTokens: stage.execution?.maxTokens, deadlineAt, signal: controller.signal }, async () => {
      assertBusinessStageDeadline();
      return operation(controller.signal);
    });
  } finally { clearTimeout(timer); controller.abort(); }
}
