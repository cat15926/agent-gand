import type { RuntimeControlAction } from './collaboration.ts';
import type { RunTerminalDisposition } from './run.ts';

/** Runtime v2 领域契约；阶段 2 只定义语义，不接管现有调度。 */
export type RuntimeSubjectKind = 'root' | 'consultation' | 'review' | 'coordination_step';
export type RuntimeSubjectStatus = 'active' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type RuntimeCompletionPolicy = 'all_required';

/** 新 Run 的入场配置名称；真正的执行语义由 executionPolicy 的正交字段冻结。 */
export type RuntimeAdmissionProfile = 'legacy' | 'shadow' | 'atomic_compat' | 'execute';
export type RuntimeAuthority = 'legacy' | 'runtime';
export type RuntimeStateMode = 'off' | 'shadow' | 'authoritative';
export type RuntimeAtomicity = 'legacy' | 'custody_v1' | 'commands_v1';

export interface RuntimeExecutionPolicyV1 {
  policyVersion: 1;
  profile: RuntimeAdmissionProfile;
  authority: RuntimeAuthority;
  runtimeStateMode: RuntimeStateMode;
  atomicity: RuntimeAtomicity;
  toolApiVersion: 1 | 2;
  implicitAnswerPolicy: 'initial_and_consultation' | 'explicit_only';
}

export interface RuntimeRunContract {
  version: 1;
  runId: string;
  objective: string;
  participantIds: string[];
  requiredSubjectKeys: string[];
  completionPolicy: RuntimeCompletionPolicy;
  partialFailurePolicy: 'needs_attention';
  /** 缺失表示本阶段之前创建的历史 Contract；只能按可靠特征推断或明确阻断。 */
  executionPolicy?: RuntimeExecutionPolicyV1;
  /** 冻结 Run 接管语义，避免进程重启或开关变化影响历史 Run。 */
  runtimeRevision?: number;
  features?: {
    /** Legacy entry adapter uses existing TaskAttempts and the public completion authority. */
    orchestrationAdapter?: 1;
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
    /** 1 表示消息、派生上下文及原生会话遵守显式信息可见性。 */
    messageVisibilityVersion?: 1;
    /** 缺失表示历史直接恢复路径；v2 增加超时、退避、错误分类和恢复审计。 */
    durableHoldVersion?: 1 | 2;
    /** 1 表示 Agent 可请求 timer/dependency Hold，注册事件接收器使用带代际的可信信封。 */
    externalWaitVersion?: 1;
    /** 1 表示 consult(any) 由 Batch winner CAS、显式 join resolution 和单例 aggregate 驱动。 */
    consultAnyVersion?: 1;
    /** 1 表示防循环按规范化 ProgressDigest 判断实际进展，而不是按 EvidenceRef 身份判断。 */
    progressDigestVersion?: 1;
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
  /** 历史事件缺失；存在时 repeatedCount 由规范化进展摘要而不是 EvidenceRef 身份驱动。 */
  progressDigest?: RuntimeProgressDigest;
  repeatedCount: number;
  outcome: 'allowed' | 'warned' | 'blocked';
  reason: string | null;
  createdAt: string;
}

export type RuntimeProgressEntryKind = 'tool_execution' | 'workspace_file' | 'run_event';

export interface RuntimeProgressDigestEntry {
  kind: RuntimeProgressEntryKind;
  category: 'read' | 'write' | 'event' | 'file' | 'other';
  stableResource: string;
  contentDigest: string;
}

/**
 * Subject 级进展摘要。evidenceFingerprint 继续保留完整审计身份；digest 只包含
 * 去重、去时间噪声后的实质内容，供 loop guard 判断是否真的取得了新进展。
 */
export interface RuntimeProgressDigest {
  version: 1;
  runId: string;
  subjectId: string;
  revision: number;
  digest: string;
  entries: RuntimeProgressDigestEntry[];
  evidenceRefCount: number;
  excluded: {
    duplicateReadOnlyResults: number;
    ordinaryLogs: number;
    invalidEvidence: number;
    timestampNoiseFields: number;
  };
}

export type RuntimeDurableHoldStatus = 'open' | 'claimed' | 'resumed' | 'cancelled' | 'failed';
export type RuntimeWakeEventKind = 'user_decision' | 'approval' | 'timer' | 'timeout' | 'event' | 'dependency' | 'lease_recovery';

export type RuntimeDurableHoldTimeoutPolicy =
  | { kind: 'fail'; reason?: string }
  | { kind: 'cancel'; reason?: string }
  | { kind: 'wake'; reason?: string; payload?: Record<string, unknown> };

export type RuntimeHoldRecoveryErrorKind = 'transient' | 'permanent' | 'stale' | 'terminal';
export type RuntimeHoldRecoveryReasonCode =
  | 'WAKE_EVENT_READY'
  | 'HOLD_TIMEOUT'
  | 'DEPENDENCY_FAILED'
  | 'DEPENDENCY_CANCELLED'
  | 'STALE_GENERATION'
  | 'RUN_TERMINAL'
  | 'CLAIM_LEASE_EXPIRED'
  | 'CLAIM_LOST'
  | 'SOURCE_MISSING'
  | 'POLICY_INVALID'
  | 'RECOVERY_TRANSIENT'
  | 'RETRY_SCHEDULED'
  | 'RETRY_EXHAUSTED'
  | 'RECOVERY_SUCCEEDED'
  | 'CANCELLED';

export type RuntimeDurableHoldCondition =
  | { kind: 'user_decision'; decisionId: string }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'timer'; wakeAt: string }
  | { kind: 'event'; eventKey: string; receiverId?: string; correlationId?: string; generation?: number }
  | { kind: 'dependency'; subjectIds: string[]; policy: 'all' | 'any' }
  | { kind: 'lease_recovery'; attemptId: string; leaseExpiredAt: string };

export type RuntimeDurableHoldRecoveryPolicy =
  | { kind: 'resume_dispatch'; targetAgentId: string; sourceMessageId: string; parentDispatchId: string; depth: number; reason: string }
  | { kind: 'wake_run' }
  | { kind: 'requeue_dispatch'; dispatchId: string };

export interface RuntimeDurableHold {
  id: string;
  version: 1 | 2;
  runId: string;
  subjectId: string;
  sourceDispatchId: string | null;
  sourceAttemptId: string | null;
  holderAgentId: string;
  generation: number;
  condition: RuntimeDurableHoldCondition;
  /** v1 的兼容排序字段；v2 调用方应使用 wakeAt/timeoutAt。 */
  deadlineAt: string | null;
  wakeAt: string | null;
  timeoutAt: string | null;
  onTimeout: RuntimeDurableHoldTimeoutPolicy | null;
  retryCount: number;
  nextRetryAt: string | null;
  maxRetries: number;
  recoveryPolicy: RuntimeDurableHoldRecoveryPolicy;
  status: RuntimeDurableHoldStatus;
  idempotencyKey: string;
  claimOwner: string | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
  wakeEventId: string | null;
  resumedDispatchId: string | null;
  resolution: Record<string, unknown> | null;
  lastError: string | null;
  lastErrorCode: RuntimeHoldRecoveryReasonCode | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface RuntimeHoldRecoveryAudit {
  id: string;
  runId: string;
  subjectId: string;
  generation: number;
  holdId: string;
  outcome: 'claimed' | 'retry_scheduled' | 'resumed' | 'failed' | 'cancelled';
  reasonCode: RuntimeHoldRecoveryReasonCode;
  reason: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface RuntimeWakeEvent {
  id: string;
  runId: string;
  kind: RuntimeWakeEventKind;
  sourceKey: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: string;
}

interface RuntimeHandoffCapsuleBase {
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

/** 历史 Capsule：schemaVersion 缺失也按 v1 读取；说明文字不产生机器义务。 */
export interface RuntimeHandoffCapsuleV1 extends RuntimeHandoffCapsuleBase {
  schemaVersion?: 1;
  successorObligationRefs?: never;
}

/** Capsule v2：内容修订 version 与结构 schemaVersion 分离。 */
export interface RuntimeHandoffCapsuleV2 extends RuntimeHandoffCapsuleBase {
  schemaVersion: 2;
  successorObligationRefs: Array<{
    obligationId: string;
    generation: number;
  }>;
}

export type RuntimeHandoffCapsule = RuntimeHandoffCapsuleV1 | RuntimeHandoffCapsuleV2;

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
  /** 阶段 2 起由 Responsibility Snapshot 生成；缺失时兼容历史调用方。 */
  completionBlockers?: RuntimeCompletionBlocker[];
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

export type RuntimeCompletionBlockerCategory =
  | 'control_action'
  | 'work'
  | 'external'
  | 'stale_responsibility';

export type RuntimeCompletionBlockerCode =
  | 'MISSING_CONTROL_DISPOSITION'
  | 'REQUIRED_OBLIGATION_PENDING'
  | 'REQUIRED_OBLIGATION_FAILED'
  | 'REQUIRED_OBLIGATION_CANCELLED'
  | 'EXTERNAL_CONDITION_PENDING'
  | 'SUBJECT_NOT_ACTIVE'
  | 'RESPONSIBILITY_NOT_OWNED'
  | 'RESPONSIBILITY_TRANSFER_PENDING'
  | 'ATTEMPT_MISSING'
  | 'ATTEMPT_NOT_COMMITTABLE'
  | 'ATTEMPT_LEASE_EXPIRED'
  | 'ATTEMPT_GENERATION_STALE'
  | 'ATTEMPT_AGENT_MISMATCH'
  | 'CUSTODY_HOLDER_MISMATCH';

export interface RuntimeCompletionBlocker {
  code: RuntimeCompletionBlockerCode;
  category: RuntimeCompletionBlockerCategory;
  refType?: 'subject' | 'attempt' | 'obligation' | 'hold';
  refId?: string;
  message: string;
}

export interface RuntimeResponsibilitySnapshot {
  runId: string;
  contractRevision: number | null;
  subjectId: string;
  subjectKey: string;
  subjectStatus: RuntimeSubjectStatus;
  custody: {
    state: string;
    holderAgentId: string | null;
    pendingHolderAgentId: string | null;
    generation: number;
    rowVersion: number;
  };
  attempt: {
    id: string;
    actorId: string;
    generation: number;
    status: 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'paused';
    leaseValid: boolean;
  } | null;
  /** 同一 stableKey 只投影最新 generation，避免已被新代际替代的记录重复阻断。 */
  requiredObligations: Array<{
    id: string;
    generation: number;
    kind: RuntimeSuccessorObligationKind;
    status: RuntimeSuccessorObligationStatus;
  }>;
  openHoldIds: string[];
  completionBlockers: RuntimeCompletionBlocker[];
}

export type RuntimeShadowComparisonClassification =
  | 'match'
  | 'runtime_stricter'
  | 'runtime_looser'
  | 'projection_only'
  | 'observer_error';

/** Shadow 对同一份 Agent 输出和判定前责任快照的审计结果。 */
export interface RuntimeShadowComparison {
  id: string;
  version: 1;
  runId: string;
  dispatchId: string;
  attemptId: string;
  subjectId: string | null;
  generation: number | null;
  actionType: RuntimeControlAction['type'];
  legacyOutcome: string;
  runtimeOutcome: string;
  classification: RuntimeShadowComparisonClassification;
  reasons: string[];
  responsibilitySnapshot: RuntimeResponsibilitySnapshot | null;
  snapshotFingerprint: string | null;
  outputSha256: string;
  createdAt: string;
}

export interface RuntimeRunTerminalRecord {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
  disposition: RunTerminalDisposition;
  completionEvaluationSeq: number | null;
  reportMessageId: string | null;
  reasonCodes: string[];
  source: string;
  committedAt: string;
}

export type RuntimeActionCommandKind = 'complete' | 'wake' | 'hold' | 'handoff' | 'consult_all' | 'consult_any';

/** Runtime 动作命令的持久化幂等账本；result 是命令提交时冻结的最小返回值。 */
export interface RuntimeActionCommandRecord {
  id: string;
  runId: string;
  kind: RuntimeActionCommandKind;
  commandKey: string;
  attemptId: string | null;
  dispatchId: string | null;
  result: unknown;
  createdAt: string;
  committedAt: string;
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
  /** 与 Context、ExitGuard 和 UI 共用的责任阻断投影。 */
  completionBlockers?: RuntimeCompletionBlocker[];
}

export type RuntimeSubjectCompletionEvaluation =
  | { status: 'accepted'; reasons: []; retryable: false; feedback: null }
  | { status: 'rejected'; reasons: string[]; retryable: boolean; feedback: string }
  | { status: 'superseded'; reasons: string[]; retryable: false; feedback: string };
