import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedAuthority } from './contracts.ts';
import { createThreadedMessageAcl } from './acl.ts';
import { createThreadedMessages } from './messages.ts';
import { createThreadedOutbox } from './outbox.ts';
import type { ThreadedInternalNotification } from './outbox.ts';

/** One local notification channel. It carries IDs; subscribers authorize any content fetch. */
export function createThreadedMessaging(db: Database.Database, options: {
  authority: ThreadedAuthority;
  repairIntervalMs?: number;
} ) {
  const outbox = createThreadedOutbox(db);
  const listeners = new Set<(hint: ThreadedInternalNotification) => void>();
  const workerId = `threaded-hints:${randomUUID()}`;
  let closed = false, scheduled = false, draining = false;
  let lastError: string | null = null;
  function drain(): void {
    if (closed || draining || !db.open || db.inTransaction || !listeners.size) return;
    draining = true;
    try {
      for (let sent = 0; sent < 100 && listeners.size; sent++) {
        const result = outbox.dispatchOne(workerId, 'threaded-local-hints-v1', hint => {
          let failed = false;
          for (const listener of [...listeners]) {
            if (closed) throw new Error('THREADED_MESSAGING_CLOSED');
            if (!listeners.has(listener)) continue;
            try {
              const value: unknown = listener(hint);
              if (value && typeof (value as { then?: unknown }).then === 'function') {
                void Promise.resolve(value).catch(() => {}); failed = true;
              }
            } catch { failed = true; }
          }
          if (closed) throw new Error('THREADED_MESSAGING_CLOSED');
          if (failed) throw new Error('THREADED_HINT_LISTENER_FAILED');
        });
        if (result.status === 'retry') { lastError = 'THREADED_HINT_LISTENER_FAILED'; return; }
        if (result.status === 'empty') { lastError = null; return; }
      }
      setImmediate(schedule);
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'THREADED_NOTIFICATION_FAILED';
      // Committed work survives notification/storage failures and is recovered by a later scan.
    } finally { draining = false; }
  }
  function schedule(): void {
    if (closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; drain(); });
  }
  const messages = createThreadedMessages(db, { authority: options.authority,
    acl: createThreadedMessageAcl(db), onCommitted: schedule });
  const repairMs = options.repairIntervalMs ?? 1000;
  if (!Number.isSafeInteger(repairMs) || repairMs < 0 || repairMs > 60_000) throw new Error('THREADED_REPAIR_INTERVAL_INVALID');
  const timer = repairMs ? setInterval(schedule, repairMs) : undefined;
  timer?.unref();
  return {
    messages, outbox,
    onNotification(listener: (hint: ThreadedInternalNotification) => void) {
      if (closed) throw new Error('THREADED_MESSAGING_CLOSED');
      listeners.add(listener); schedule();
      return () => { listeners.delete(listener); };
    },
    /** T06 can invoke this after its own outer transaction commits; it never starts execution. */
    notifyCommitted: schedule,
    recover() { schedule(); return outbox.scanPending(); },
    diagnostics() { return { lastError, subscribers: listeners.size }; },
    close() { closed = true; if (timer) clearInterval(timer); listeners.clear(); },
  };
}
