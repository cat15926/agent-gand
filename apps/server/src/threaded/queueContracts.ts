import type { ThreadedBinding, ThreadedQueueDispatch, ThreadedQueueRecord } from '@agent-gand/shared';
import type { ResourceSessionReference } from '../execution/resources/types.ts';
import type { BudgetAuthorization, BudgetQuote } from './budgetTypes.ts';

export interface ThreadedQueuePreparationContext {
  queue: ThreadedQueueRecord;
  invocationId: string;
  reservedRunId: string;
  attemptId: string;
}
export interface ThreadedQueueResourcePreparation {
  session: ResourceSessionReference;
  workspaces: Array<{ path: string; access: 'read' | 'write' }>;
  providerKey?: string;
  accountId?: string;
  accountIdentityGeneration?: number;
  quote: BudgetQuote;
}
export interface ThreadedQueueClaim {
  queue: ThreadedQueueRecord;
  dispatch: ThreadedQueueDispatch;
  binding: ThreadedBinding;
  budgetAuthorization: BudgetAuthorization;
  sourceMessageId: string;
  waveId: string;
  inputMaxSeq: number;
  sessionBindingId: string;
}
export interface ThreadedQueueRecoveryPlan {
  queueId: string;
  invocationId: string;
  dispatch: ThreadedQueueDispatch;
  binding: ThreadedBinding;
  action: 'not_started' | 'unknown' | 'release_pending' | 'none';
}
export interface ThreadedQueueEvent { seq: number; queueId: string; reason: string }
export class ThreadedQueueError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ThreadedQueueError'; }
}
