/** Runtime v2 领域契约；阶段 2 只定义语义，不接管现有调度。 */
export type RuntimeSubjectKind = 'root' | 'consultation' | 'review' | 'coordination_step';
export type RuntimeSubjectStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type RuntimeCompletionPolicy = 'all_required';

export interface RuntimeRunContract {
  version: 1;
  runId: string;
  objective: string;
  participantIds: string[];
  requiredSubjectKeys: string[];
  completionPolicy: RuntimeCompletionPolicy;
  partialFailurePolicy: 'needs_attention';
  /** 冻结 Run 接管语义，避免进程重启或开关变化影响历史 Run。 */
  runtimeRevision?: number;
  features?: {
    completionEngine?: boolean;
    coordinationKernel?: 'shadow' | 'execute';
  };
}

export interface RuntimeSubjectSeed {
  key: string;
  runId: string;
  kind: RuntimeSubjectKind;
  parentKey: string | null;
  objective: string;
  initialHolderAgentId: string;
}

export type RuntimeContractEvaluation =
  | { status: 'active'; pending: string[] }
  | { status: 'completed'; pending: [] }
  | { status: 'needs_attention'; pending: string[]; failed: string[] };

/** 只记录来源与冻结版本，聊天/工具输出仍需经服务端解析与授权。 */
export type RuntimeEvidenceRef =
  | { kind: 'message'; id: string }
  | { kind: 'tool_execution'; id: string }
  | { kind: 'attempt_output'; id: string }
  | { kind: 'run_event'; id: string }
  | { kind: 'workspace_file'; path: string; sha256: string; workspaceScope?: string };

export interface RuntimeHandoffCapsule {
  version: number;
  runId: string;
  dispatchId: string;
  sourceDispatchId: string;
  sourceAttemptId: string;
  objective: string;
  summary: string;
  completedWork: string[];
  pendingQuestions: string[];
  expectedOutput: string;
  successorObligations: string[];
  evidenceRefs: RuntimeEvidenceRef[];
}

export interface RuntimeCompletionSubject {
  key: string;
  required: boolean;
  status: RuntimeSubjectStatus;
  custodyState: string;
  holderAgentId: string | null;
  pendingHolderAgentId: string | null;
  generation: number;
  hasOutput: boolean;
  evidenceValid: boolean;
}

export interface RuntimeCompletionDispatch {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled';
  error: string | null;
}

export interface RuntimeCompletionInput {
  contract: RuntimeRunContract;
  subjects: RuntimeCompletionSubject[];
  dispatches: RuntimeCompletionDispatch[];
  pendingDecisions: number;
  batchStatuses: string[];
  hasAnyOutput: boolean;
  dependenciesSatisfied: boolean;
  requiredArtifactsSatisfied: boolean;
  reviewAccepted: boolean;
  protocolTerminal: boolean;
  disposition?: 'normal' | 'partial_user_accepted' | 'delegated';
}

export type RuntimeCompletionEvaluation =
  | { status: 'accepted'; reasons: string[]; disposition: 'normal' | 'partial_user_accepted' | 'delegated' }
  | { status: 'waiting' | 'rejected' | 'failed'; reasons: string[] };
