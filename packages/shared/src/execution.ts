export type ExternalDriverId = 'claude-cli' | 'codex-exec' | 'claude-sdk' | 'codex-app-server';

/** Omission preserves the provider/tool loop; nativeTools is an SDK-only exemption list. */
export type AgentExecutionConfig =
  | { kind: 'builtin-llm' }
  | { kind: 'external'; driver: ExternalDriverId; nativeTools?: string[]; platformTools?: string[]; sessionPolicy?: 'turn' | 'run' | 'conversation' };

export interface ExecutionDriverInfo {
  id: ExternalDriverId;
  available: boolean;
  version: string | null;
  error: string | null;
  errorCode?: ExecutionErrorCode;
  readonly: true;
  permissionModes?: Array<'readonly' | 'confirm' | 'auto'>;
  nativeApprovals?: boolean;
  runtimeControl?: boolean;
}

export type ExecutionErrorCode = 'missing_binary' | 'unsupported_cli' | 'auth_required' | 'invalid_json'
  | 'protocol_error' | 'nonzero_exit' | 'timeout' | 'cancelled' | 'interrupted' | 'policy_rejected';

export type NativeAgentEvent =
  | { type: 'session.bound'; sessionId: string }
  | { type: 'text.delta'; itemId: string; text: string }
  | { type: 'text.snapshot'; itemId: string; text: string }
  | { type: 'tool.started' | 'tool.completed'; itemId: string; name: string; output?: string; exitCode?: number | null; failed?: boolean }
  | { type: 'usage'; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; cumulative?: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } }
  | { type: 'terminal'; status: 'completed' | 'failed'; message?: string };

export interface ExternalAgentExecution {
  id: string;
  runId: string;
  agentId: string;
  scopeId: string;
  driver: ExternalDriverId;
  driverVersion: string | null;
  agentVersion: number;
  cwd: string;
  host: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  sessionId: string | null;
  errorCode: ExecutionErrorCode | null;
  error: string | null;
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  attemptId?: string | null;
  permissionMode?: 'readonly' | 'confirm' | 'auto';
  runtimeBinding?: { subjectId: string; generation: number; contractRevision: number | null };
  controlAction?: import('./collaboration.ts').CollaborationStoredControlAction | null;
  exitCorrectionAttempts?: number;
  sessionBindingId?: string | null;
  sessionMode?: 'cold' | 'resume';
  sessionReason?: string;
  sourceCwd?: string;
  processOwnership?: 'guardian-v1';
  snapshot?: { commit: string; path: string };
  recovery?: { state: 'quiesced' | 'attention'; reason: string; recoveredAt: string };
  evidence?: { head: string | null; beforeDiff: string; afterDiff: string; truncated: boolean; commands: Array<{ itemId: string; name: string; output: string; exitCode: number | null }> };
}

export interface ExternalWorkspaceBinding {
  id: string; runId: string; sourceRoot: string; sourceHead: string;
  cwd: string; baseCommit: string | null; sourceFingerprint: string;
  status: 'preparing' | 'ready' | 'attention'; createdAt: string; error: string | null;
  latestSnapshot?: { commit: string; path: string };
}
