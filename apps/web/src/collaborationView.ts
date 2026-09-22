import type { CollaborationAttempt, CollaborationBatch, CollaborationDispatch, Run } from '@agent-gand/shared';

export interface BatchProgress {
  terminal: number;
  total: number;
  percent: number;
}

const TERMINAL_DISPATCH = new Set(['completed', 'failed', 'blocked', 'cancelled']);

export function collaborationBatchProgress(batch: CollaborationBatch, dispatches: CollaborationDispatch[]): BatchProgress {
  const children = dispatches.filter((dispatch) => dispatch.batchId === batch.id && dispatch.kind === 'fanout');
  const total = children.length || batch.targetAgentIds.length;
  const terminal = children.filter((dispatch) => TERMINAL_DISPATCH.has(dispatch.status)).length;
  return { terminal, total, percent: total > 0 ? Math.round(terminal / total * 100) : 0 };
}

export function collaborationAttemptTone(attempt: CollaborationAttempt): 'success' | 'active' | 'danger' | 'muted' {
  if (attempt.status === 'completed') return 'success';
  if (attempt.status === 'running') return 'active';
  if (attempt.status === 'failed') return 'danger';
  return 'muted';
}

export function canStopCollaborationRun(run: Run | undefined): boolean {
  return Boolean(run?.mode === 'collaboration' && ['running', 'waiting_for_user', 'awaiting_approval'].includes(run.status));
}
