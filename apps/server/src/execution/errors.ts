import type { ExecutionErrorCode } from '@agent-gand/shared';

export class ExecutionError extends Error {
  constructor(public code: ExecutionErrorCode, message: string) { super(message); }
}

/** Diagnostics are bounded and never retain auth tokens printed by a CLI. */
export function diagnostic(value: string, limit = 4_000): string {
  return value.replace(/\b(?:sk|sess)-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,}]+/gi, '$1[redacted]')
    .slice(-limit);
}

export function exitError(message: string): ExecutionError {
  const safe = diagnostic(message);
  return new ExecutionError(/not logged in|login required|authentication|unauthorized|invalid.*(?:key|token)|401|please.*log.?in/i.test(safe)
    ? 'auth_required' : 'nonzero_exit', safe || '外部 CLI 非零退出');
}
