export type ExternalDriverId = 'claude-cli' | 'codex-exec' | 'claude-sdk' | 'codex-app-server';

/** References an existing scheduler attempt; never creates another execution queue. */
export type ExecutionBinding = {
  schemaVersion: 1; id: string; runId: string; agentId: string; attemptId: string;
  workspaceSnapshot?: { commit: string; path: string };
} & (
  | { origin: 'collaboration_attempt'; subjectId: string; generation: number; contractRevision: number | null }
  | { origin: 'coordination_step_attempt'; subjectId: string; generation: number; contractRevision: number | null;
      planId: string; planRevision: number; stepId: string; startedAt: string; leaseExpiresAt: string;
      reviewTargets?: Array<{ attemptId: string; subjectId: string; generation: number }> }
  | { origin: 'task_attempt'; taskId: string; generation: number; startedAt: string; leaseOwner: string;
      responsibility?: { subjectId: string; generation: number; contractRevision: number | null } }
);

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

export interface ExecutionFailureDetails {
  phase?: 'queue' | 'initialization' | 'before_session' | 'before_first_activity' | 'after_activity' | 'deadline';
  stderr?: string;
}
export interface ExternalExecutionProgress {
  queuedAt?: string; memberAcquiredAt?: string; workspaceReadyAt?: string;
  nativeInvokedAt?: string; sessionBoundAt?: string; firstTextAt?: string; firstToolAt?: string; lastEventAt?: string;
}
export interface ExternalTimeoutPolicy {
  configuredMs: number; effectiveMs: number;
  source: 'account' | 'server' | 'coordination_lease' | 'run_deadline';
  deadlineAt: string;
}

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
  failureDetails?: ExecutionFailureDetails;
  progress?: ExternalExecutionProgress;
  timeoutPolicy?: ExternalTimeoutPolicy;
  content: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  startedAt: string;
  finishedAt: string | null;
  attemptId?: string | null;
  permissionMode?: 'readonly' | 'confirm' | 'auto';
  runtimeBinding?: { subjectId: string; generation: number; contractRevision: number | null };
  executionBinding?: ExecutionBinding;
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
