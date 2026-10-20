import type { ThreadedBinding } from '@agent-gand/shared';

/** The resource coordinator owns these values; HTTP/model input must never mint them. */
export interface ThreadedClaimIdentity {
  claimId: string;
  generation: number;
  fencingToken: string;
  claimOwner: string;
  ownerId: string;
  threadId: string;
  invocationId: string;
  runId: string;
  attemptId: string;
  agentId: string;
}

/** A reference to evidence checked by the resource coordinator, not a client assertion. */
export interface QuiescenceProof {
  schemaVersion: 1;
  id: string;
  attemptId: string;
  claimId: string;
  generation: number;
  fencingToken: string;
  reason: 'not_started' | 'process_exited' | 'reconciled';
  sideEffects: 'none' | 'reconciled';
}

/** Durable claims; lifecycle transitions and resource transitions share the same DB transaction. */
export interface ExecutionResourcesPort {
  assertCurrent(claim: ThreadedClaimIdentity): void;
  assertExecutable?(claim: ThreadedClaimIdentity): void;
  markStarted?(claim: ThreadedClaimIdentity): void;
  markUnknown?(claim: ThreadedClaimIdentity): void;
  verifyQuiescence(claim: ThreadedClaimIdentity, proof: QuiescenceProof): void;
  /** Verify evidence and release this exact identity only. Repeating a completed release is a no-op;
   * an old claim/proof must never release a successor, including after a receipt-write failure. */
  release(claim: ThreadedClaimIdentity, proof: QuiescenceProof): void;
}

export class ThreadedAuthorityError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message = code) { super(message); this.name = 'ThreadedAuthorityError'; }
}

const unavailable = (): never => { throw new ThreadedAuthorityError('THREADED_RESOURCES_UNAVAILABLE'); };
export const unavailableThreadedResources: ExecutionResourcesPort = {
  assertCurrent: unavailable, verifyQuiescence: unavailable, release: unavailable,
};

export interface ThreadedAuthority {
  capture(attemptId: string): ThreadedBinding;
  assertAuthorized(binding: ThreadedBinding, options?: { allowApproval?: boolean; quiescence?: QuiescenceProof }): void;
  authorized(binding: ThreadedBinding, options?: { quiescence?: QuiescenceProof }): boolean;
  /** Scope/current-claim check for lifecycle reconciliation; this grants no external effects. */
  assertCurrent(binding: ThreadedBinding): void;
  /** Canonical durable identity only, including released claims; grants no execution authority. */
  claim(binding: ThreadedBinding): ThreadedClaimIdentity;
}

export type ThreadedBudgetState = 'settled' | 'unknown';
export interface ThreadedUsageEvidence {
  outputTokens?: number;
  costMicrousd?: number;
  evidenceReference: string;
}
/** Structured addressing only; text mention/fallback interpretation belongs to T08. */
export interface ThreadedResponseRouting {
  targets?: string[];
  audience?: string[];
  visibility?: 'public' | 'private';
  state?: 'published' | 'draft';
  sourceRefs?: string[];
}
export type ExecutionOutcome =
  | { kind: 'completed'; content: string; budgetState: ThreadedBudgetState; quiescence: QuiescenceProof; budgetUsage?: ThreadedUsageEvidence; response?: ThreadedResponseRouting }
  | { kind: 'failed'; reason: string; retryable: boolean; budgetState: ThreadedBudgetState; quiescence: QuiescenceProof; budgetUsage?: ThreadedUsageEvidence }
  | { kind: 'cancelled'; reason: string; budgetState: ThreadedBudgetState; quiescence: QuiescenceProof; budgetUsage?: ThreadedUsageEvidence }
  | { kind: 'not_started'; reason: string; quiescence: QuiescenceProof }
  | { kind: 'unknown'; reason: string };

export interface ScopedExecutionEvent {
  type: 'text' | 'tool' | 'usage';
  value: string;
}

export interface InvocationExecutionPort {
  execute(input: {
    binding: ThreadedBinding;
    contextManifestId: string;
    sessionBindingId: string;
    budgetAuthorizationId: string;
    signal: AbortSignal;
    assertAuthorized: () => void;
    onEvent: (event: ScopedExecutionEvent) => void;
    /** Trusted adapter switches only after reserving the exact next actual request. */
    setBudgetAuthorization?: (authorizationId: string | null) => void;
  }): Promise<ExecutionOutcome>;
}
