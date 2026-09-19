import type { AgentCapability, PermissionMode } from './agent.ts';
import type { RunMode } from './run.ts';

export type CoordinationProtocolId =
  | 'single_agent'
  | 'sequential_pipeline'
  | 'parallel_fanout'
  | 'supervisor_aggregation'
  | 'supervisor_dag'
  | 'review_revision'
  | 'debate'
  | 'consensus'
  | 'vote'
  | 'dynamic_collaboration';

export type CoordinationRisk = 'low' | 'medium' | 'high';
export type CoordinationDecision = 'auto_start' | 'recommend' | 'clarify' | 'unavailable';
export type CoordinationPlanStatus = 'draft' | 'validated' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'superseded';
export type CoordinationStepStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed';
export type CoordinationAttemptStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'paused';
export type CoordinationConstraintValue = string | number | boolean | string[];

export interface CoordinationConstraintEvidence {
  constraint: string;
  source: 'user_input' | 'team_selection' | 'platform_default';
  value: CoordinationConstraintValue;
  excerpt: string;
}

export interface TaskBrief {
  objective: string;
  deliverable: string | null;
  participantIds: string[];
  reviewerId: string | null;
  hardConstraints: Record<string, CoordinationConstraintValue>;
  inferredConstraints: Record<string, CoordinationConstraintValue>;
  constraintEvidence: CoordinationConstraintEvidence[];
  qualityRequirements: string[];
  risk: CoordinationRisk;
  missingInformation: string[];
}

export interface CoordinationRoleSlot {
  id: string;
  capability: AgentCapability;
  minimum: number;
  maximum: number | null;
  independentFrom?: string[];
}

export interface CoordinationProtocolDefinition {
  id: CoordinationProtocolId;
  version: number;
  displayName: string;
  description: string;
  requiredCapabilities: AgentCapability[];
  roleSlots: CoordinationRoleSlot[];
  parameterSchema: Record<string, { type: 'integer' | 'boolean' | 'string'; required: boolean; minimum?: number; maximum?: number }>;
  completionCondition: string;
  minimumAgents: number;
  maximumAgents: number | null;
  composable: boolean;
  runtimeMode: RunMode | null;
  risk: CoordinationRisk;
}

export interface CoordinationAgentCapability {
  id: string;
  name: string;
  version: number;
  capabilities: AgentCapability[];
  tools: string[];
  permissionMode: PermissionMode;
  model: string;
  enabled: boolean;
}

export interface CoordinationToolCapability {
  name: string;
  source: 'builtin' | 'mcp';
  readonly: boolean;
  risk: CoordinationRisk;
  requiresApproval: boolean;
}

export interface CapabilitySnapshot {
  id: string;
  schemaVersion: 1;
  createdAt: string;
  protocols: CoordinationProtocolDefinition[];
  agents: CoordinationAgentCapability[];
  tools: CoordinationToolCapability[];
  policy: {
    maximumAgents: number;
    maximumSteps: number;
    maximumAttemptsPerStep: number;
    maximumTokensPerStep: number;
    reviewerIsolationRequired: boolean;
    externalWritesRequireApproval: boolean;
  };
}

export interface CoordinationProtocolSelection {
  protocol: CoordinationProtocolId;
  version: number;
}

export interface CoordinationAlternative {
  protocols: CoordinationProtocolSelection[];
  displayName: string;
  suitableWhen: string;
}

export type CoordinationValidationSeverity = 'error' | 'warning';
export interface CoordinationValidationIssue {
  code: string;
  message: string;
  path: string | null;
  severity: CoordinationValidationSeverity;
}

export interface CoordinationDraft {
  id: string;
  capabilitySnapshotId: string;
  taskBrief: TaskBrief;
  protocols: CoordinationProtocolSelection[];
  displayName: string;
  summary: string;
  reasonCodes: string[];
  evidence: Array<{ source: 'user_constraint' | 'task_semantics' | 'capability'; field: string }>;
  alternatives: CoordinationAlternative[];
  modelConfidence: number | null;
  platformConfidence: number;
  risk: CoordinationRisk;
  decision: CoordinationDecision;
  clarificationQuestion: string | null;
  clarificationOptions: string[];
  validationIssues: CoordinationValidationIssue[];
  /** 兼容现有 API；内容为 error 级别 issue 的稳定错误码。 */
  validationErrors: string[];
  runtimeMode: RunMode | null;
  createdAt: string;
}

export interface CoordinationStepToolPolicy {
  allowedTools: string[];
  requiresApproval: boolean;
}

export interface CoordinationPlanStep {
  id: string;
  protocol: CoordinationProtocolId;
  type: 'agent_turn' | 'fanout' | 'aggregate' | 'review' | 'completion_gate';
  actorRole: string;
  actorCapability: AgentCapability;
  agentId: string | null;
  dependsOn: string[];
  completion: string;
  maxAttempts: number;
  tokenBudget: number;
  timeoutMs: number;
  onFailure: 'fail_plan' | 'retry' | 'request_user' | 'retry_dependencies';
  toolPolicy: CoordinationStepToolPolicy;
  /**
   * AG-COORD-01：本步骤承诺冻结的产物路径（相对 run 工作区，含 workspaceScope 时先经 scope 映射）。
   * Runtime 在步骤完成前校验存在且非 stub；review/aggregate 步骤启动前校验全部祖先产物。
   */
  expectedArtifacts?: string[];
  metadata: Record<string, string | number | boolean | string[]>;
}

export interface CoordinationConstraintBinding {
  constraint: string;
  value: CoordinationConstraintValue;
  planPaths: string[];
}

export interface CoordinationPlanCompletion {
  requiredSteps: string[];
  terminalSteps: string[];
}

export interface CoordinationPlanBudget {
  maximumSteps: number;
  maximumAttemptsPerStep: number;
  maximumTokensPerStep: number;
}

export interface CoordinationPlan {
  id: string;
  runId: string | null;
  draftId: string;
  capabilitySnapshotId: string;
  revision: number;
  status: CoordinationPlanStatus;
  protocols: CoordinationProtocolSelection[];
  runtimeMode: RunMode | null;
  actorBindings: Record<string, string>;
  hardConstraintBindings: CoordinationConstraintBinding[];
  steps: CoordinationPlanStep[];
  completion: CoordinationPlanCompletion;
  budget: CoordinationPlanBudget;
  validationIssues: CoordinationValidationIssue[];
  createdAt: string;
  updatedAt: string;
}

/** 阶段 A 先固定版本契约；版本切换和自然语言重规划在阶段 E 启用。 */
export interface CoordinationPlanRevision {
  planId: string;
  revision: number;
  trigger: 'initial' | 'user_adjustment' | 'runtime_replan';
  previousRevision: number | null;
  diffSummary: string;
  plan: CoordinationPlan;
  createdAt: string;
}

export interface CoordinationStepState {
  planId: string;
  runId: string;
  revision: number;
  stepId: string;
  status: CoordinationStepStatus;
  attemptNo: number;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface CoordinationStepAttempt {
  id: string;
  planId: string;
  runId: string;
  revision: number;
  stepId: string;
  attemptNo: number;
  status: CoordinationAttemptStatus;
  idempotencyKey: string;
  input: string | null;
  output: string | null;
  error: string | null;
  spanId: string | null;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
}

export type CoordinationEventKind =
  | 'snapshot_created'
  | 'draft_created'
  | 'draft_validated'
  | 'draft_rejected'
  | 'plan_compiled'
  | 'plan_validated'
  | 'plan_rejected'
  | 'plan_activated'
  | 'step_ready'
  | 'step_started'
  | 'step_completed'
  | 'step_retry_scheduled'
  | 'step_failed'
  | 'step_paused'
  | 'plan_paused'
  | 'plan_resumed'
  | 'plan_cancelled'
  | 'plan_completed'
  | 'plan_failed';

export interface CoordinationEvent {
  id: string;
  kind: CoordinationEventKind;
  draftId: string | null;
  planId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CoordinationPreviewInput {
  goal: string;
  agentIds: string[];
  defaultReviewerId?: string;
  requestedProtocol?: CoordinationProtocolId;
}

export interface CoordinationPreview {
  snapshot: CapabilitySnapshot;
  draft: CoordinationDraft;
  plan: CoordinationPlan;
  /** AG-COORD-07：用户可见提示（如目标提到的参与者不在所选团队），计划卡原样展示 */
  notices?: string[];
}
