import type { ExternalAgentExecution } from '@agent-gand/shared';

/** A sibling cancellation must not replace the failure that ended useful execution. */
export function executionFailureForRun(executions: ExternalAgentExecution[], runId: string): ExternalAgentExecution | undefined {
  const errors = executions.filter(item => item.runId === runId && item.error);
  return errors.filter(item => item.status === 'failed' && item.errorCode !== 'cancelled').at(-1) ?? errors.at(-1);
}
