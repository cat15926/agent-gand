import { ExecutionError } from './errors.ts';

export interface ActivityLimits { firstResponseTimeoutMs?: number; idleTimeoutMs?: number }

/** Model activity only. Session/usage/transport heartbeats do not extend these clocks. */
export class ActivityTimeout {
  private first?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private running = false;
  private responded = false;
  private pauses = new Set<string>();
  constructor(private limits: ActivityLimits, private expire: (error: ExecutionError) => void) {}
  start(): void {
    this.stop(); this.running = true;
    if (this.limits.firstResponseTimeoutMs) this.first = setTimeout(() => this.timeout('first_response', this.limits.firstResponseTimeoutMs!), this.limits.firstResponseTimeoutMs);
  }
  activity(): void {
    if (!this.running) return;
    this.responded = true; clearTimeout(this.first); this.first = undefined;
    this.armIdle();
  }
  pause(key: string): void {
    if (!this.running) return;
    this.pauses.add(key); clearTimeout(this.idle); this.idle = undefined;
  }
  resume(key: string): void {
    if (this.pauses.delete(key) && !this.pauses.size && this.responded) this.armIdle();
  }
  stop(): void {
    this.running = false; this.responded = false;
    clearTimeout(this.first); clearTimeout(this.idle);
    this.first = undefined; this.idle = undefined; this.pauses.clear();
  }
  private armIdle(): void {
    clearTimeout(this.idle);
    if (this.running && !this.pauses.size && this.limits.idleTimeoutMs) this.idle = setTimeout(() => this.timeout('idle', this.limits.idleTimeoutMs!), this.limits.idleTimeoutMs);
  }
  private timeout(kind: 'first_response' | 'idle', limitMs: number): void {
    if (!this.running) return;
    this.stop();
    this.expire(new ExecutionError('timeout', kind === 'first_response'
      ? `模型首响应超时（${limitMs / 1000} 秒内未收到正文、思考或工具请求活动）`
      : `模型响应停滞（${limitMs / 1000} 秒内无新模型活动；工具执行和审批等待不计入）`,
    { phase: kind === 'first_response' ? 'before_first_activity' : 'after_activity', timeoutKind: kind, limitMs }));
  }
}

/** Abort wins even when a provider ignores its signal; late callbacks must be fenced by the caller. */
export async function withActivityTimeout<T>(input: ActivityLimits & { signal?: AbortSignal; deadlineAt?: string | null },
  operation: (signal: AbortSignal, activity: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const forward = () => controller.abort(input.signal?.reason ?? new ExecutionError('cancelled', '本轮执行已停止'));
  if (input.signal?.aborted) forward(); else input.signal?.addEventListener('abort', forward, { once: true });
  const guard = new ActivityTimeout(input, error => controller.abort(error));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  if (input.deadlineAt) {
    const remaining = Date.parse(input.deadlineAt) - Date.now();
    const expire = () => controller.abort(new ExecutionError('timeout', '本轮已到达冻结的运行截止时间', { phase: 'deadline', timeoutKind: 'total' }));
    if (remaining <= 0) expire(); else deadline = setTimeout(expire, remaining);
  }
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', abort, { once: true });
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    guard.start();
    return await Promise.race([Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return operation(controller.signal, () => { if (!controller.signal.aborted) guard.activity(); });
    }), aborted]);
  } catch (error) { throw controller.signal.aborted ? controller.signal.reason : error; }
  finally {
    guard.stop(); clearTimeout(deadline);
    controller.signal.removeEventListener('abort', abort);
    // Fence providers that resolve or emit after our timeout.
    controller.abort();
    input.signal?.removeEventListener('abort', forward);
  }
}
