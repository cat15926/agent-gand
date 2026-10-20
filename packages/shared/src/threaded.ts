/** Protocol versions are independent from deployment feature flags. */
export const THREADED_HTTP_VERSION = 'threaded-http-v1' as const;
export const THREADED_TOOL_VERSION = 'threaded-tools-v1' as const;
export const THREADED_SCHEMA_VERSION = 1 as const;

export type ThreadedAdmissionMode = 'closed' | 'observe' | 'execute';
export type ThreadedThreadState = 'open' | 'paused' | 'closed' | 'archived';

export interface ThreadedFeatureCapabilities {
  readSnapshots: boolean;
  authenticatedWs: boolean;
  messageReads: boolean;
  messagePersistence: boolean;
  outbox: boolean;
  admission: boolean;
  execution: boolean;
  tools: boolean;
}

export interface ThreadedCapabilities {
  httpVersion: typeof THREADED_HTTP_VERSION;
  toolVersion: typeof THREADED_TOOL_VERSION;
  schemaVersion: typeof THREADED_SCHEMA_VERSION;
  implemented: ThreadedFeatureCapabilities;
  configured: { mode: ThreadedAdmissionMode };
  verified: ThreadedFeatureCapabilities;
}

export interface ThreadedThreadRecord {
  schemaVersion: 1;
  id: string;
  conversationId: string;
  ownerId: string;
  mode: 'threaded';
  state: ThreadedThreadState;
  title: string;
  version: number;
  policyVersion: number;
  authorityEpoch: number;
  createdAt: string;
  updatedAt: string;
}

export interface ThreadedMemberRecord {
  schemaVersion: 1;
  threadId: string;
  ownerId: string;
  agentId: string;
  handle: string;
  roleVersion: number;
  accountVersion: number | null;
  permissionVersion: number;
  status: 'joined' | 'left';
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Serialized identity only; the dedicated authority port rechecks its persisted scope and fences. */
export interface ThreadedBinding {
  schemaVersion: 1;
  id: string;
  origin: 'threaded_invocation_attempt';
  threadId: string;
  invocationId: string;
  runId: string;
  attemptId: string;
  ownerId: string;
  agentId: string;
  authorityEpoch: number;
  claimId: string;
  generation: number;
  fencingToken: string;
  workspaceSnapshot?: { commit: string; path: string };
}

export type ThreadedMessageVisibility = 'public' | 'private';
export type ThreadedMessageState = 'published' | 'draft';
export type ThreadedMessageOrigin = 'user' | 'agent_post' | 'agent_response' | 'system';
export interface ThreadedAttachmentInput {
  name: string;
  mediaType: string;
  contentBase64: string;
}
export interface ThreadedAttachmentRecord {
  id: string;
  name: string;
  mediaType: string;
  byteLength: number;
  contentHash: string;
}
export interface ThreadedMessageRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  threadId: string;
  seq: number;
  origin: ThreadedMessageOrigin;
  state: ThreadedMessageState;
  visibility: ThreadedMessageVisibility;
  sender: { kind: 'user' | 'agent' | 'system'; agentId?: string; systemKey?: string };
  body: string;
  bodyHash: string;
  targets: string[];
  audience: string[];
  sourceRefs: string[];
  sourceThreadId: string | null;
  sourceInvocationId: string | null;
  sourceAttemptId: string | null;
  sourceBindingId: string | null;
  causalRootId: string;
  waveId: string | null;
  inputMaxSeq: number;
  authorityEpoch: number;
  attachments: ThreadedAttachmentRecord[];
  createdAt: string;
}
export interface ThreadedDeliveryRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  threadId: string;
  messageId: string;
  targetAgentId: string;
  purpose: 'message';
  routingRevision: 1;
  waveId: string;
  inputMaxSeq: number;
  createdAt: string;
}
export interface ThreadedWakeRecord {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  threadId: string;
  sourceMessageId: string;
  deliveryId: string;
  targetAgentId: string;
  purpose: 'message';
  routingRevision: 1;
  waveId: string;
  inputMaxSeq: number;
  causalRootId: string;
  authorityEpoch: number;
  targetMemberVersion: number;
  targetPermissionVersion: number;
  status: 'pending' | 'blocked' | 'cancelled';
  version: number;
  createdAt: string;
  updatedAt: string;
}
/** A frozen acceptance receipt. Delivery/seen/execution are separate later facts. */
export interface ThreadedMessageReceipt {
  message: ThreadedMessageRecord;
  deliveries: ThreadedDeliveryRecord[];
  wakes: ThreadedWakeRecord[];
  outboxIds: string[];
}
