import type { RuntimeControlAction } from './collaboration.ts';

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
    /** 1 表示历史 Collaboration 动作，2 表示规范 RuntimeControlAction。 */
    controlActionVersion?: 1 | 2;
    /** 缺失表示历史兼容路径；存在时冻结 ExitGuard 行为和纠偏预算。 */
    exitGuard?: { version: 1; maxCorrections: number; correctionMaxTokens: number };
    /** 缺失表示历史 Attempt 推断路径；1 表示必须经持久化 Candidate 验收。 */
    completionCandidateVersion?: 1;
    /** 缺失表示历史派生义务；1 表示完成判定只读取类型化后继义务投影。 */
    successorObligationVersion?: 1;
    /** 缺失表示直接重新解析 EvidenceRef；1 表示使用冻结 Bundle 及漂移校验。 */
    evidenceBundleVersion?: 1;
    /** 缺失表示次数型 ping-pong；1 表示按 Subject/目标/证据指纹防循环。 */
    evidenceLoopGuardVersion?: 1;
    /** 1 表示 Context 由带来源和敏感信息策略的 Contributor Pipeline 组装。 */
    contextContributorVersion?: 1;
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

export type RuntimeEvidenceBundleStatus = 'valid' | 'invalid' | 'drifted';
export type RuntimeEvidenceBundleOwnerType = 'completion_candidate' | 'handoff_capsule' | 'coordination_step';

export interface RuntimeEvidenceResolution {
  ref: RuntimeEvidenceRef;
  trusted: boolean;
  source: string;
  excerpt: string | null;
  contentSha256: string | null;
  reason: string | null;
}

export interface RuntimeEvidenceBundle {
  id: string;
  version: 1;
  runId: string;
  subjectId: string | null;
  ownerType: RuntimeEvidenceBundleOwnerType;
  ownerId: string;
  refs: RuntimeEvidenceRef[];
  resolutions: RuntimeEvidenceResolution[];
  fingerprint: string;
  status: RuntimeEvidenceBundleStatus;
  idempotencyKey: string;
  createdAt: string;
  validatedAt: string;
}

export interface RuntimeRouteGuardEvent {
  id: string;
  runId: string;
  subjectId: string;
  sourceDispatchId: string;
  fromAgentId: string;
  targetAgentId: string;
  objectiveHash: string;
  evidenceFingerprint: string;
  repeatedCount: number;
  outcome: 'allowed' | 'warned' | 'blocked';
  reason: string | null;
  createdAt: string;
}

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
  evidenceBundleId?: string;
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
  successorObligationsSatisfied: boolean;
  disposition?: 'normal' | 'partial_user_accepted' | 'delegated';
}

export type RuntimeCompletionEvaluation =
  | { status: 'accepted'; reasons: string[]; disposition: 'normal' | 'partial_user_accepted' | 'delegated' }
  | { status: 'waiting' | 'rejected' | 'failed'; reasons: string[] };

export type RuntimeCompletionCandidateStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export type RuntimeSuccessorObligationKind =
  | 'handoff_acquire'
  | 'consult_result'
  | 'review_revision'
  | 'artifact_commit'
  | 'user_decision';
export type RuntimeSuccessorObligationStatus = 'open' | 'satisfied' | 'failed' | 'cancelled';

export interface RuntimeSuccessorObligation {
  id: string;
  runId: string;
  parentSubjectId: string;
  kind: RuntimeSuccessorObligationKind;
  targetSubjectId: string | null;
  sourceActionId: string;
  stableKey: string;
  status: RuntimeSuccessorObligationStatus;
  required: boolean;
  generation: number;
  payload: Record<string, unknown>;
  resolutionSourceId: string | null;
  resolution: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RuntimeCompletionCandidate {
  id: string;
  runId: string;
  subjectId: string;
  subjectKey: string;
  attemptId: string;
  generation: number;
  agentId: string;
  action: RuntimeControlAction;
  summary: string;
  evidenceRefs: RuntimeEvidenceRef[];
  evidenceBundleId: string | null;
  exitGuard: { status: string; reasons: string[] };
  status: RuntimeCompletionCandidateStatus;
  reasons: string[];
  retryable: boolean;
  feedback: string | null;
  idempotencyKey: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface RuntimeSubjectCompletionInput {
  candidate: Pick<RuntimeCompletionCandidate,
    'subjectId' | 'attemptId' | 'generation' | 'agentId' | 'action' | 'summary' | 'evidenceRefs' | 'exitGuard'>;
  currentSubjectId: string;
  subjectStatus: RuntimeSubjectStatus;
  custodyState: string;
  holderAgentId: string | null;
  pendingHolderAgentId: string | null;
  currentGeneration: number;
  attemptStatus: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  attemptAgentId: string;
  attemptError: string | null;
  leaseValid: boolean;
  outputPresent: boolean;
  evidenceValid: boolean;
  openSuccessorObligations: number;
  durableHoldOpen: boolean;
  dependenciesSatisfied: boolean;
  requiredArtifactsSatisfied: boolean;
  reviewAccepted: boolean;
  protocolTerminal: boolean;
}

export type RuntimeSubjectCompletionEvaluation =
  | { status: 'accepted'; reasons: []; retryable: false; feedback: null }
  | { status: 'rejected'; reasons: string[]; retryable: boolean; feedback: string }
  | { status: 'superseded'; reasons: string[]; retryable: false; feedback: string };
