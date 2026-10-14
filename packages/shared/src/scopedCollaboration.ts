import type { MessageAccess } from './message.ts';

export type CollaborationCapabilityPackage = 'scoped-control-v1' | 'scoped-release-v1';
export interface ScopedCollaborationContract {
  boundaryVersion: 2;
  manifestVersion: 1;
  provenanceVersion: 1;
  policyRevision: number;
  capabilityPackage: CollaborationCapabilityPackage;
}
/** material only delivers bytes; acknowledged only satisfies receipt; result requires completion acceptance. */
export type DeliveryExpectation = 'material' | 'acknowledged' | 'result';
export type ScopedControlActionV3 =
  | { version: 3; type: 'consult_batch'; items: Array<{ key: string; target: string; payloadRef: string; expectation: DeliveryExpectation }>; join: 'all'; returnProfile: string }
  | { version: 3; type: 'acknowledge'; envelopeId: string };

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
