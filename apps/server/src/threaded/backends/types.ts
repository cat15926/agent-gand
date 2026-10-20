import type { ThreadedBinding } from '@agent-gand/shared';
import type { InvocationExecutionPort, ThreadedUsageEvidence } from '../contracts.ts';
import type { ProcessRegistration } from '../../execution/ownedProcess.ts';
import type { ResourceEvidence } from '../../execution/resources/types.ts';
import type { QuiescenceProof } from '../contracts.ts';
import type { createThreadedBackendEvidence } from './evidence.ts';
import type { ThreadedSessionAnchorEvidence, ThreadedSessionCompactionEvidence } from '../sessionContextTypes.ts';

export type BackendKind = 'api' | 'claude-sdk';
export interface BackendRequestDescription {
  model: string;
  maxOutputTokens: number;
  inputBytes: number;
}
export interface BackendRequestAuthorization { id: string; maxOutputTokens: number }
/** Synchronous DB callbacks; begin must reserve/start before the transport can send bytes. */
export interface BackendRequestsPort {
  begin(requestKey: string, request: BackendRequestDescription): BackendRequestAuthorization;
  settle(authorizationId: string, usage: ThreadedUsageEvidence): void;
  unknown(authorizationId: string): void;
}
export interface BackendTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface BackendPreparedInput {
  kind: BackendKind;
  model: string;
  instructions: string;
  /** Exact context-service serialized payload; never rebuilt from a caller's messages. */
  serializedContext: string;
  contextManifestId: string;
  maxOutputTokens: number;
  maxRequests?: number;
  requests: BackendRequestsPort;
  tools?: BackendTool[];
  executeTool?: (name: string, input: unknown, requestId: string) => Promise<string>;
  /** Trusted server-selected endpoint and credentials; never persisted in a receipt. */
  connection: { baseUrl: string; headers: Record<string, string>; timeoutMs: number };
  price?: { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number; cacheWritePerMillion?: number };
  apiProtocol?: 'openai-chat-completions' | 'anthropic-messages';
  session: {
    bindingId: string; nativeId: string | null; version: number; backendVersion: string;
    cwd: string; configDir: string; projectDir?: string; resume: boolean;
    /** Exact boundary from the current server-validated resume anchor; cold sessions ignore it. */
    compactionBoundary?: string;
  };
  assertCurrent(): void;
  delivery(status: 'delivered' | 'unknown' | 'not_sent', evidenceReference: string): void;
  nativeEvent?(event: BackendNativeEvent): void;
}
export type BackendNativeEvent =
  | { type:'tool';name:string;id:string }
  | { type: 'bound'; nativeId: string }
  | { type: 'compact'; nativeId: string; evidence: ThreadedSessionCompactionEvidence }
  | { type: 'anchor'; nativeId: string; evidence: ThreadedSessionAnchorEvidence; quiescence: QuiescenceProof };
export type BackendExecuteInput = Parameters<InvocationExecutionPort['execute']>[0];
export interface BackendLoadInput {
  (input: BackendExecuteInput): BackendPreparedInput | Promise<BackendPreparedInput>;
}
/** HTTP requests never retry internally. SDK retry/compaction crosses this same per-request port. */
export type BackendFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface BackendSdkProcessInput {
  cwd: string; configDir: string; projectDir?: string; nativeId: string; resume: boolean;
  model: string; instructions: string; prompt: string; maxOutputTokens: number;
  environment: NodeJS.ProcessEnv; signal: AbortSignal; timeoutMs: number;
  onRecord(record: Record<string, unknown>): void;
  onProcess(owner: ProcessRegistration): void;
  onProcessStopped(token: string): void;
  tools?: BackendTool[];
  executeTool?: (name:string,input:unknown,requestId:string)=>Promise<string>;
}
export type BackendSdkProcess = (input: BackendSdkProcessInput) => Promise<void>;
export interface BackendAdapterOptions {
  loadInput: BackendLoadInput;
  evidence: ReturnType<typeof createThreadedBackendEvidence>;
  recordQuiescence(binding: ThreadedBinding, evidence: ResourceEvidence): QuiescenceProof;
  fetch?: BackendFetch;
}
