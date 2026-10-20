import type { ThreadedAttachmentRecord, ThreadedBinding, ThreadedMessageRecord } from '@agent-gand/shared';
import type { ResourceSessionReference } from '../execution/resources/types.ts';
import type { QuiescenceProof } from './contracts.ts';

export interface ThreadedContextBudget {
  maxInputTokens: number;
  reservedSystemTokens: number;
}
export interface ThreadedContextPrepareInput {
  session: ResourceSessionReference;
  mode: 'reconstructed' | 'native_incremental';
  budget: ThreadedContextBudget;
  requestKey: string;
}
export interface ThreadedContextAttachment extends ThreadedAttachmentRecord {
  /** Original bytes encoded as base64 text; no OCR, transcoding or hidden image token estimate. */
  encoding: 'base64';
  contentBase64: string;
}
export interface ThreadedContextMessage {
  id: string;
  seq: number;
  sender: ThreadedMessageRecord['sender'];
  origin: ThreadedMessageRecord['origin'];
  body: string;
  bodyHash: string;
  sourceRefs: string[];
  attachments: ThreadedContextAttachment[];
}
export interface ThreadedContextItem {
  messageId: string;
  seq: number;
  bodyHash: string;
  messageHash: string;
  attachmentHashes: Array<{ id: string; contentHash: string }>;
  sourceRefs: string[];
  acl: 'allowed' | 'denied';
  aclHash: string | null;
  decision: 'included' | 'deferred_budget' | 'denied_acl' | 'unpublished' | 'already_delivered';
  purpose: 'wake_source' | 'history';
  estimatedTokens: number;
  truncated: false;
}
/** Internal audit record. Do not send excluded item IDs or ACL decisions to the model. */
export interface ThreadedContextManifest {
  schemaVersion: 1;
  id: string;
  ownerId: string;
  threadId: string;
  agentId: string;
  invocationId: string;
  attemptId: string;
  bindingId: string;
  sourceMessageId: string;
  waveId: string;
  inputMaxSeq: number;
  session: ResourceSessionReference;
  mode: ThreadedContextPrepareInput['mode'];
  budget: ThreadedContextBudget;
  estimatorId: string;
  state: 'ready' | 'blocked';
  reason: string | null;
  estimatedTokens: number;
  items: ThreadedContextItem[];
  payloadHash: string;
  createdAt: string;
}
export interface ThreadedContextPayload {
  messages: ThreadedContextMessage[];
  /** Exact model-input text covered by payloadHash and the estimate, including attachment base64. */
  serialized: string;
}
export interface ThreadedPreparedContext {
  manifest: ThreadedContextManifest;
  payload: ThreadedContextPayload;
}
export interface ThreadedContextSendIntent {
  id: string;
  manifestId: string;
  bindingId: string;
  payloadHash: string;
  requestKey: string;
  status: 'sending' | 'delivered' | 'unknown' | 'not_sent';
}
export interface ThreadedContextDeliveryEvidence {
  /** A reference understood by a trusted backend verifier, never a model/client assertion. */
  key: string;
  reference: string;
  nativeId?: string | null;
  anchor?: string;
}
export interface ThreadedContextDeliveryOutcome {
  intentId: string;
  status: 'delivered' | 'unknown' | 'not_sent';
  evidence: ThreadedContextDeliveryEvidence;
}
export interface ThreadedContextCursor {
  kind: 'delivery' | 'seen' | 'mention_ack';
  maxSeq: number;
  /** Exact facts, not every message below maxSeq. */
  messageIds: string[];
}
export interface ThreadedContextCanonicalPort {
  loadManifest(manifestId: string): ThreadedContextManifest | null;
  assertManifestCurrent(binding: ThreadedBinding, manifestId: string, options?: { quiescence?: QuiescenceProof }): ThreadedContextManifest;
}
export class ThreadedContextError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ThreadedContextError'; }
}
