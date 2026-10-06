import { acquireDurableLease } from '../execution/leases.ts';
import { ExecutionError } from '../execution/errors.ts';

/** Competing workers observe the live owner instead of failing or replaying its Run. */
export function ownOrchestration(runId: string): (() => void) | null {
  try { return acquireDurableLease(`orchestration:${runId}`, runId, false); }
  catch (error) { if (error instanceof ExecutionError && error.code === 'policy_rejected') return null; throw error; }
}
