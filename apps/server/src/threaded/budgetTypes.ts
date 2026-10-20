import type { ThreadedBinding } from '@agent-gand/shared';
import type { ExecutionOutcome, ThreadedClaimIdentity } from './contracts.ts';

export interface ThreadedBudgetPolicy {
  maxOutputTokens: number;
  maxOutputTokensPerRequest: number;
  maxInvocations: number;
  maxAttemptsPerInvocation: number;
  maxActivityMs: number;
  maxCostMicrousd: number;
  maxA2ADepth: number;
  activityAllowanceMs: number;
  unknownCost: 'stop' | 'reserve';
  unknownCostReserveMicrousd: number | null;
  deadlineAt: number | null;
}
export interface BudgetQuote {
  maxOutputTokens?: number;
  estimatedCostMicrousd?: number;
  pricingReference?: string;
}
export interface BudgetAuthorization {
  id: string;
  rootId: string;
  ownerId: string;
  threadId: string;
  invocationId: string;
  attemptId: string;
  requestKey: string;
  policyVersion: number;
  maxOutputTokens: number;
  reservedCostMicrousd: number;
  activityValidUntil: number | null;
  executionState: 'reserved' | 'started' | 'quiescent' | 'unknown' | 'not_started';
  usageState: 'reserved' | 'settled' | 'unknown';
}
export interface BudgetAdmissionInput {
  invocationId: string;
  attemptId: string;
  sourceMessageId: string;
  requestKey?: string;
  quote: BudgetQuote;
}
export interface BudgetAdmissionReservation extends BudgetAdmissionInput { claim: ThreadedClaimIdentity }
export interface BudgetUsageEvidence {
  outputTokens?: number;
  costMicrousd?: number;
  evidenceReference: string;
}
export interface BudgetRoot {
  id: string;
  ownerId: string;
  homeThreadId: string;
  version: number;
  state: 'open' | 'paused';
  policy: ThreadedBudgetPolicy;
}
export interface BudgetUsage {
  invocations: number;
  attempts: number;
  actualRequests: number;
  outputTokens: number;
  costMicrousd: number;
  activityMs: number;
  activityReservedMs: number;
  unknownRequests: number;
}
export interface OwnerBudgetWindowPolicy {
  maxOutputTokens?: number;
  maxCostMicrousd?: number;
  maxActivityMs?: number;
  maxInvocations?: number;
}
export interface ThreadedBudgetLifecyclePort {
  assertAuthorized(authorizationId: string, binding: ThreadedBinding): BudgetAuthorization;
  markStartedWithinTransaction(binding: ThreadedBinding, authorizationId: string): { validUntil: number };
  settleOutcomeWithinTransaction(binding: ThreadedBinding, authorizationId: string, outcome: ExecutionOutcome): 'settled' | 'unknown';
  checkpoint(binding: ThreadedBinding, authorizationId: string): { validUntil: number };
  maxAttemptsForInvocation(invocationId: string): number;
}
