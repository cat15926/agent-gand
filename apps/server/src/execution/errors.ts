import type { ExecutionErrorCode } from '@agent-gand/shared';
import { redactSecrets } from '../accounts/secrets.ts';

export class ExecutionError extends Error {
  constructor(public code: ExecutionErrorCode, message: string) { super(message); }
}

/** Diagnostics are bounded and never retain auth tokens printed by a CLI. */
export function diagnostic(value: string, limit = 4_000): string {
  return redactSecrets(value).slice(-limit);
}

export function exitError(message: string): ExecutionError {
  const safe = diagnostic(message);
  return new ExecutionError(/not logged in|login required|authentication|unauthorized|invalid.*(?:key|token)|401|please.*log.?in/i.test(safe)
    ? 'auth_required' : 'nonzero_exit', safe || '外部 CLI 非零退出');
}
