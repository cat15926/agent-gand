import type { ExternalAgentExecution } from '@agent-gand/shared';
import { get } from '../db/database.ts';
import { loadResponsibilitySnapshot } from '../runtime/responsibilitySnapshot.ts';

/** Shared by native approvals, bridge callbacks and the execution lifetime fence. */
export function executionAuthorized(execution: ExternalAgentExecution): boolean {
  const current = get<{ status: string }>('SELECT status FROM external_agent_executions WHERE id=?', execution.id);
  const run = get<{ status: string; mode: string }>('SELECT status,mode FROM runs WHERE id=?', execution.runId);
  if (current?.status !== 'running' || !run || ['completed', 'failed', 'cancelled'].includes(run.status)) return false;
  if (run.mode === 'collaboration') {
    if (!execution.attemptId || !execution.runtimeBinding) return false;
    const snapshot = loadResponsibilitySnapshot({ runId: execution.runId, attemptId: execution.attemptId });
    return !!snapshot && snapshot.subjectId === execution.runtimeBinding.subjectId
      && snapshot.contractRevision === execution.runtimeBinding.contractRevision
      && snapshot.subjectStatus === 'active' && snapshot.custody.state === 'owned'
      && snapshot.custody.holderAgentId === execution.agentId && snapshot.custody.pendingHolderAgentId === null
      && snapshot.custody.generation === execution.runtimeBinding.generation
      && snapshot.attempt?.id === execution.attemptId && snapshot.attempt.status === 'running'
      && snapshot.attempt.actorId === execution.agentId && snapshot.attempt.leaseValid
      && snapshot.attempt.generation === snapshot.custody.generation;
  }
  if (!execution.attemptId) return true;
  const attempt = get<{ status: string; task_status: string }>('SELECT a.status,t.status AS task_status FROM task_attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=? AND a.run_id=? AND a.agent_id=?', execution.attemptId, execution.runId, execution.agentId);
  return attempt?.status === 'running' && !['completed', 'failed', 'cancelled'].includes(attempt.task_status);
}
