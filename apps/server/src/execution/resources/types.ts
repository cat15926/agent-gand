import type { QuiescenceProof, ThreadedClaimIdentity } from '../../threaded/contracts.ts';

/** These are server-owned values. No HTTP/model payload is a resource request. */
export interface ResourceSessionReference {
  id: string;
  version: number;
  nativeId: string | null;
  /** Actual backend/account identity/host/native ID key, never a policy binding key. */
  resourceKey: string | null;
}
export interface TrustedResourceRequest {
  requestKey: string;
  /** Stable identity of one actual call; repeated enqueue cannot charge it twice. */
  operationId: string;
  mode: 'legacy' | 'threaded';
  ownerId: string;
  agentId: string;
  runId: string;
  attemptId: string;
  threadId?: string;
  invocationId?: string;
  accountId?: string;
  accountIdentityGeneration?: number;
  providerKey?: string;
  /** Exact legacy native execution provenance for a call and its late Session promotion. */
  legacyExecutionId?: string;
  session?: ResourceSessionReference;
  workspaces?: Array<{ path: string; access: 'read' | 'write' }>;
  /** A preparation reservation does not consume model-call capacity. */
  capacity?: boolean;
  /** Trusted registered command workload; independent from the Invocation execution slot. */
  threadedCommand?: { commandId: string; registrationId: string };
  /** Optional parent reservation: its exact fence must remain current. */
  parentClaim?: ResourceClaimIdentity;
  eligible?: boolean;
}
/** Legacy claims use empty threadId/invocationId; threaded claims retain T03's exact identity. */
export type ResourceClaimIdentity = ThreadedClaimIdentity;
export interface ResourceTicket {
  id: string;
  seq: number;
  status: 'waiting' | 'active' | 'released' | 'cancelled';
  eligible: boolean;
  request: TrustedResourceRequest;
}
export interface ResourceEvidence {
  reason: QuiescenceProof['reason'];
  sideEffects: QuiescenceProof['sideEffects'];
  /** Opaque reference resolved by the trusted process/side-effect verifier. */
  reference?: string;
}
export interface ResourcePolicy {
  version: number;
  globalLimit: number;
  threadLimit: number;
  accountLimit: number;
  accountLimits: Record<string, number>;
  providerLimits: Record<string, number>;
}
export interface ResourceAvailability {
  seq: number;
  reason: string;
  agentId: string;
}
export interface ResourceClaimRecord {
  identity: ResourceClaimIdentity;
  ticketId: string;
  state: 'reserved' | 'started' | 'unknown' | 'quiescent' | 'released';
  expiresAt: number;
  request: TrustedResourceRequest;
}
