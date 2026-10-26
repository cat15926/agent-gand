import type { ThreadedBinding } from '@agent-gand/shared';
import type { ResourceSessionReference } from '../execution/resources/types.ts';
import type { ThreadedSessionPreparation } from '../execution/resources/sessions.ts';
import type { QuiescenceProof } from './contracts.ts';
import type { ThreadedContextCanonicalPort, ThreadedContextManifest } from './contextTypes.ts';

export interface ThreadedSessionContextPreparation extends ThreadedSessionPreparation {
  /** The frozen Wake boundary. Native memory beyond it requires a new identity. */
  inputMaxSeq: number;
  /** Explicit authorized message provenance for a context boundary; never a transcript. */
  boundarySources?: string[];
}
export interface ThreadedSessionContextDecision {
  session: ResourceSessionReference;
  sessionKind: 'native' | 'reconstructed';
  mode: 'cold' | 'resume' | 'reconstructed';
  reason: string;
  anchorId: string | null;
  boundaryVersion: number;
  policyHash: string;
}
export interface ThreadedSessionInputIntent {
  id: string;
  manifestId: string;
  session: ResourceSessionReference;
  /** Possible exposure only. Backend delivery/seen/mention ACK stay separate facts. */
  sourceMessageIds: string[];
}
export interface ThreadedSessionAnchorEvidence {
  reference: string;
  nativeId: string;
  backendVersion: string;
  requestReceiptId: string;
  terminalRecordUuid: string;
  /** A bounded opaque backend checkpoint, not transcript text or a file path to read. */
  resumeToken: string;
  inputUserUuid?: string;
  compactionBoundary?: string;
}
export interface ThreadedSessionAnchor {
  id: string;
  ownerId: string;
  threadId: string;
  agentId: string;
  manifestId: string;
  payloadHash: string;
  session: ResourceSessionReference;
  boundaryVersion: number;
  policyHash: string;
  sourceMessageIds: string[];
  evidence: ThreadedSessionAnchorEvidence;
  createdAt: string;
}
export interface ThreadedSessionCompactionEvidence {
  reference: string;
  nativeId: string;
  backendVersion: string;
  boundary: string;
  /** SDK-observed facts only. Legacy records may omit this; absence never proves automatic compaction. */
  metadata?: {
    trigger: 'auto' | 'manual' | 'unknown';
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  };
}
export interface ThreadedSessionSummary {
  text: string;
  sourceMessageIds: string[];
}
export interface ThreadedSessionContextPort {
  prepare(input: ThreadedSessionContextPreparation): ThreadedSessionContextDecision;
  assertForManifest(binding: ThreadedBinding, manifestId: string,
    decision: ThreadedSessionContextDecision): ThreadedContextManifest;
  recordInputIntent(binding: ThreadedBinding, input: { manifestId: string;
    decision: ThreadedSessionContextDecision; requestId: string }): ThreadedSessionInputIntent;
  recordAnchor(binding: ThreadedBinding, input: { manifestId: string;
    decision: ThreadedSessionContextDecision; requestId: string; evidence: ThreadedSessionAnchorEvidence;
    quiescence: QuiescenceProof }): ThreadedSessionAnchor;
  recordCompaction(binding: ThreadedBinding, input: { manifestId: string;
    decision: ThreadedSessionContextDecision; requestId: string; evidence: ThreadedSessionCompactionEvidence;
    summary?: ThreadedSessionSummary }): { id: string; boundary: string };
  seal(binding: ThreadedBinding, input: { manifestId: string;
    decision: ThreadedSessionContextDecision; requestId: string; reason: string }): { id: string };
  getAnchor(scope: { ownerId: string; threadId: string; agentId: string }, anchorId: string): ThreadedSessionAnchor | null;
}
export interface ThreadedSessionContextOptions {
  authority: {
    assertAuthorized(binding: ThreadedBinding, options?: { quiescence?: QuiescenceProof }): void;
  };
  context: ThreadedContextCanonicalPort;
  verifyAnchor?: (binding: ThreadedBinding, manifest: ThreadedContextManifest,
    decision: ThreadedSessionContextDecision, evidence: ThreadedSessionAnchorEvidence,
    quiescence: QuiescenceProof) => boolean;
  verifyCompaction?: (binding: ThreadedBinding, manifest: ThreadedContextManifest,
    decision: ThreadedSessionContextDecision, evidence: ThreadedSessionCompactionEvidence,
    summary?: ThreadedSessionSummary) => boolean;
  now?: () => number;
}
export class ThreadedSessionContextError extends Error {
  readonly status = 409;
  constructor(readonly code: string) { super(code); this.name = 'ThreadedSessionContextError'; }
}
