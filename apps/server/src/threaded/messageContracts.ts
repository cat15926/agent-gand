import type {
  ThreadedAttachmentInput, ThreadedBinding, ThreadedMessageOrigin, ThreadedMessageRecord,
  ThreadedMessageState, ThreadedMessageVisibility,
} from '@agent-gand/shared';
import type { QuiescenceProof } from './contracts.ts';

export type ThreadedMessageActor = { kind: 'owner' }
  | { kind: 'agent'; agentId: string; sourceThreadId: string }
  | { kind: 'system'; key: string };
export interface ThreadedMessageReadScope {
  ownerId: string;
  threadId: string;
  viewer: { kind: 'owner' } | { kind: 'agent'; agentId: string };
}
export interface ThreadedMessagePayload {
  body: string;
  targets?: string[];
  audience?: string[];
  visibility?: ThreadedMessageVisibility;
  state?: ThreadedMessageState;
  sourceRefs?: string[];
  attachments?: ThreadedAttachmentInput[];
}
export interface ThreadedMessageWriteAuthorization {
  ownerId: string;
  threadId: string;
  actor: ThreadedMessageActor;
  origin: ThreadedMessageOrigin;
  body: string;
  targets: string[];
  audience: string[];
  visibility: ThreadedMessageVisibility;
  state: ThreadedMessageState;
  sourceRefs: string[];
  attachments: ThreadedAttachmentInput[];
}
export interface ThreadedMessageAcl {
  authorizeWrite(input: ThreadedMessageWriteAuthorization): void;
  canRead(scope: ThreadedMessageReadScope, message: ThreadedMessageRecord): boolean;
}
export interface ThreadedUserMessageInput extends ThreadedMessagePayload {
  ownerId: string;
  threadId: string;
  clientRequestId: string;
}
export interface ThreadedAgentPostInput extends ThreadedMessagePayload {
  binding: ThreadedBinding;
  toolCallId: string;
  /** Cross-post destination; source identity always comes from the binding. */
  threadId?: string;
}
export interface ThreadedAgentResponseInput extends ThreadedMessagePayload {
  binding: ThreadedBinding;
  responseCommitKey: string;
  quiescence: QuiescenceProof;
}
export interface ThreadedSystemMessageInput extends ThreadedMessagePayload {
  ownerId: string;
  threadId: string;
  systemKey: string;
  requestId: string;
  /** Trusted durable callback lineage. Not accepted from HTTP/model payloads. */
  causalParentInvocationId?: string;
}
export class ThreadedMessageError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ThreadedMessageError'; }
}
