import type { MessageAccess } from './message.ts';

export type CollaborationCapabilityPackage = 'scoped-control-v1' | 'scoped-release-v1';
export interface ScopedCollaborationContract {
  boundaryVersion: 2;
  manifestVersion: 1;
  provenanceVersion: 1;
  policyRevision: number;
  capabilityPackage: CollaborationCapabilityPackage;
  /** G1 fixtures omit this; only the complete G2 delivery package is executable. */
  deliveryVersion?: 1;
  releaseVersion?: 1;
}
/** material only delivers bytes; acknowledged only satisfies receipt; result requires completion acceptance. */
export type DeliveryExpectation = 'material' | 'acknowledged' | 'result';
export type ScopedControlActionV3 =
  | { version: 3; type: 'consult_batch'; items: Array<{ key: string; target: string; payloadRef: string; expectation: DeliveryExpectation }>; join: 'all'; returnProfile: string }
  | { version: 3; type: 'acknowledge'; envelopeId: string }
  | { version: 3; type: 'complete'; summary: string }
  | { version: 3; type: 'request_release'; summary: string };

export interface ScopedDeliveryDraft {
  conversationId: string;
  coordinatorId: string;
  goal: string;
  join: 'all';
  returnProfile: 'status-only-v1';
  maxTokens: number;
  items: Array<{ key: string; target: string; batch: number; material: string; expectation: DeliveryExpectation }>;
}
export interface ScopedDeliveryPreview {
  id: string; fingerprint: string; expiresAt: string; draft: ScopedDeliveryDraft;
  maxBatchItems: number; maxDispatches: number; costPolicy: import('./cost.ts').CostPolicy | null;
  disclosure: string;
}
export interface ScopedDeliveryStatus {
  runId: string; goal: string; status: string; maxTokens: number; chargedTokens: number; unknownCalls: number;
  costBudget: import('./cost.ts').CostBudgetState | null;
  items: Array<{ key: string; target: string; batch: number; expectation: DeliveryExpectation; status: string; output: string | null }>;
}

export interface ScopedSourceRef {
  kind: 'message' | 'artifact' | 'tool_execution';
  id: string;
  version: number;
  sha256: string;
}
export interface ContextManifestV1 {
  version: 1; id: string; runId: string; scopeId: string; revision: 1;
  objective: ScopedSourceRef;
  inputs: ScopedSourceRef[];
  dynamicInputs: ScopedSourceRef[];
  allowedTools: string[];
  policyRevision: number;
  capabilityPackage: CollaborationCapabilityPackage;
  sha256: string;
}
export interface ExecutionScopeV1 {
  version: 1; id: string; runId: string; subjectId: string; agentId: string;
  kind: 'control' | 'content'; contextManifestId: string; contextManifestRevision: 1;
  defaultOutputAccess: MessageAccess; policyRevision: number;
  sessionBoundaryId: string; recoveryGeneration: number;
}
export interface InputProvenanceV1 {
  version: 1; attemptId: string; sequence: number; scopeId: string;
  source: ScopedSourceRef;
  channel: 'prompt' | 'file_read' | 'tool_result' | 'mcp_result' | 'supplement' | 'session';
  accessDecision: 'allowed'; exposure: 'possibly_exposed'; createdAt: string;
}
export type ScopedCollaborationErrorCode = 'SCOPE_NOT_READABLE' | 'SCOPE_BINDING_INVALID'
  | 'SOURCE_VERSION_CHANGED' | 'CONTEXT_MANIFEST_DRIFT' | 'INPUT_LEDGER_STALE'
  | 'PRIVATE_OUTPUT_REQUIRES_RELEASE' | 'SESSION_SCOPE_MISMATCH' | 'BACKEND_SCOPE_UNSUPPORTED';
export interface ScopedCollaborationCapability {
  package: CollaborationCapabilityPackage; boundaryVersion: 2; toolApiVersion: 3;
  foundationImplemented: boolean; implementationSupported: boolean; configuredAvailable: boolean;
  connectionVerified: boolean; verifiedAt: string | null; reason: string;
}

/** G3 publishes text only. Source references and input ledgers are resolved by the server. */
export interface PrivateAggregateDraft {
  sourceRunId: string; itemKeys: string[]; aggregatorId: string; instruction: string; maxTokens: number;
}
export interface PrivateAggregatePreview {
  id: string; fingerprint: string; expiresAt: string; draft: PrivateAggregateDraft;
  sources: Array<{ key: string; body: string }>; disclosure: string;
  costPolicy: import('./cost.ts').CostPolicy | null;
}
export type InformationReleaseMode = 'exact_content' | 'deterministic_projection';
export interface InformationReleasePreview {
  id: string; policyId: string; fingerprint: string; expiresAt: string;
  runId: string; draftRevision: number; body: string; access: MessageAccess;
  mode: InformationReleaseMode; projectionId: 'status-receipts-v1' | null; sourceCount: number; inputCount: number; maxUses: 1;
  sourceSummary: Array<{ key: string; ref: ScopedSourceRef; inputCount: number }>;
}
export interface InformationReleaseState {
  runId: string; sourceRunId: string; aggregatorId: string;
  sourceSummary: Array<{ key: string; ref: ScopedSourceRef; inputCount: number }>;
  draft: { revision: number; body: string } | null;
  policies: Array<{ id: string; version: number; status: string; expiresAt: string }>;
  grants: Array<{ id: string; policyId: string; status: string; draftRevision: number; body: string; access: MessageAccess }>;
  records: Array<{ id: string; grantId: string; messageId: string; body: string; access: MessageAccess }>;
}
