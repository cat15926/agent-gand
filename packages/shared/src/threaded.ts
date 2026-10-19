/** Protocol versions are independent from deployment feature flags. */
export const THREADED_HTTP_VERSION = 'threaded-http-v1' as const;
export const THREADED_TOOL_VERSION = 'threaded-tools-v1' as const;
export const THREADED_SCHEMA_VERSION = 1 as const;

export type ThreadedAdmissionMode = 'closed' | 'observe' | 'execute';
export type ThreadedThreadState = 'open' | 'paused' | 'closed' | 'archived';

export interface ThreadedFeatureCapabilities {
  readSnapshots: boolean;
  authenticatedWs: boolean;
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

/** Data contract only. T02 does not mint or authorize threaded execution bindings. */
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
