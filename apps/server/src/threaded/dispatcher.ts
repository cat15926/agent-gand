/** Hints trigger scans of durable facts. They never carry work or grant ownership. */
export function createThreadedDispatcher<T extends { binding: { attemptId: string } }>(options: {
  claimNext: () => T | null;
  execute: (claim: T) => Promise<unknown>;
  onAvailable?: (listener: () => void) => () => void;
  onWake?: (listener: () => void) => () => void;
  repairIntervalMs?: number;
}) {
  const active = new Map<string, Promise<unknown>>();
  const idleWaiters = new Set<() => void>();
  let closed = false, requested = false, scheduled = false, draining = false;
  let lastError: string | null = null;
  const resolveIdle = () => {
    if (draining || scheduled || requested || active.size) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  function schedule(): void {
    if (closed) return;
    requested = true;
    if (scheduled || draining) return;
    scheduled = true;
    queueMicrotask(drain);
  }
  function drain(): void {
    scheduled = false;
    if (closed) { requested = false; resolveIdle(); return; }
    if (draining) { requested = true; return; }
    draining = true;
    try {
      // A hint received during claim, including its last empty scan, forces another pass.
      // Bound each turn so a continuous stream cannot starve I/O or cancellation.
      let scanned = 0;
      do {
        requested = false;
        for (;;) {
          if (++scanned > 100) { requested = true; break; }
          const claim = options.claimNext();
          if (!claim || closed) break;
          const id = claim.binding.attemptId;
          if (active.has(id)) throw new Error('THREADED_DISPATCH_DUPLICATE_ATTEMPT');
          const execution = Promise.resolve().then(() => options.execute(claim));
          active.set(id, execution);
          void execution.catch(error => {
            lastError = error instanceof Error ? error.message : 'THREADED_DISPATCH_FAILED';
          }).finally(() => { active.delete(id); schedule(); resolveIdle(); });
          if (scanned >= 100) { requested = true; break; }
        }
      } while (requested && scanned < 100 && !closed);
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'THREADED_DISPATCH_FAILED';
      // Retry needs a new hint or repair scan; never spin on a persistent storage error.
      requested = false;
    } finally {
      draining = false;
      if (requested && !closed) { scheduled = true; setImmediate(drain); }
      resolveIdle();
    }
  }
  const unwatchAvailable = options.onAvailable?.(schedule);
  const unwatchWake = options.onWake?.(schedule);
  const interval = options.repairIntervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > 60_000) throw new Error('THREADED_REPAIR_INTERVAL_INVALID');
  const timer = interval ? setInterval(schedule, interval) : undefined;
  timer?.unref();
  return {
    wakeup: schedule,
    whenIdle(): Promise<void> {
      if (!draining && !scheduled && !requested && !active.size) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },
    diagnostics: () => ({ closed, scheduled, draining, requested, active: active.size, lastError }),
    close() {
      closed = true; requested = false;
      if (timer) clearInterval(timer);
      unwatchAvailable?.(); unwatchWake?.(); resolveIdle();
    },
  };
}
