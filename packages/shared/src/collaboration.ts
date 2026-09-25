export type CollaborationDispatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type CollaborationDispatchKind = 'initial' | 'handoff' | 'fanout' | 'aggregate' | 'resume';

export interface CollaborationDispatch {
  id: string;
  runId: string;
  conversationId: string;
  sourceMessageId: string;
  parentDispatchId: string | null;
  batchId: string | null;
  kind: CollaborationDispatchKind;
  from: string;
  targetAgentId: string;
  reason: string | null;
  status: CollaborationDispatchStatus;
  priority: 'urgent' | 'normal';
  depth: number;
  idempotencyKey: string;
  outputMessageId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type CollaborationAttemptStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export interface CollaborationAttempt {
  id: string;
  dispatchId: string;
  runId: string;
  conversationId: string;
  agentId: string;
  attemptNo: number;
  status: CollaborationAttemptStatus;
  inputContext: string | null;
  output: string | null;
  controlAction: CollaborationStoredControlAction | null;
  deduplicatedTo: string | null;
  error: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export type CollaborationBatchStatus = 'pending' | 'running' | 'partial' | 'completed' | 'timeout' | 'failed';

export interface CollaborationBatch {
  id: string;
  runId: string;
  conversationId: string;
  initiatorAgentId: string;
  sourceDispatchId: string;
  question: string;
  targetAgentIds: string[];
  resultDispatchId: string | null;
  status: CollaborationBatchStatus;
  timeoutAt: string;
  createdAt: string;
  completedAt: string | null;
}

export interface SupervisorTaskProposal {
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  suggestedAssigneeIds: string[];
  suggestedReviewerId?: string;
  reason: string;
}

/** Runtime v2 之前持久化的控制动作；仅供历史 Run 和 Legacy Adapter 使用。 */
export type LegacyCollaborationControlAction =
  | { type: 'finish' }
  | { type: 'implicit_complete' }
  | { type: 'handoff'; targetAgentId: string; message: string; reason: string }
  | { type: 'ask_many'; targetAgentIds: string[]; question: string; reason: string }
  | { type: 'wait_user'; question: string; reason: string }
  | ({ type: 'propose_task' } & SupervisorTaskProposal);

/** @deprecated 新执行路径请使用 RuntimeControlAction。 */
export type CollaborationControlAction = LegacyCollaborationControlAction;

export type RuntimeControlActionVersion = 1 | 2;

export type RuntimeWakeCondition =
  | { kind: 'user_decision'; decisionKind: 'agent_question'; prompt: string }
  | { kind: 'user_decision'; decisionKind: 'supervisor_task_proposal'; proposal: SupervisorTaskProposal };

/** Runtime 内部唯一消费的规范动作；Agent 只能提出动作，不能直接提交 Subject/Run 终态。 */
export type RuntimeControlAction =
  | { version: 2; type: 'complete'; summary?: string }
  | { version: 2; type: 'answer_candidate' }
  | { version: 2; type: 'handoff'; targetAgentId: string; objective: string; reason: string }
  | { version: 2; type: 'consult'; targetAgentIds: string[]; objective: string; reason: string; join: 'all' | 'any' }
  | { version: 2; type: 'hold'; wake: RuntimeWakeCondition; reason: string }
  | { version: 2; type: 'cancel'; reason: string };

/** 数据库存量允许 v1/v2 并存；执行前必须经过 Legacy Adapter 归一化。 */
export type CollaborationStoredControlAction = LegacyCollaborationControlAction | RuntimeControlAction;

export type CollaborationDecisionKind = 'agent_question' | 'budget_exhausted' | 'supervisor_task_proposal';
export type CollaborationDecisionStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';

export interface CollaborationUserDecision {
  id: string;
  runId: string;
  conversationId: string;
  dispatchId: string | null;
  idempotencyKey: string;
  kind: CollaborationDecisionKind;
  status: CollaborationDecisionStatus;
  promptMessageId: string;
  payload: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  linkedRunId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CollaborationBudgetLimits {
  maxDispatches: number;
  maxTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
}

export interface CollaborationBudgetRevision {
  id: string;
  runId: string;
  decisionId: string;
  increasePercent: number;
  previousLimits: CollaborationBudgetLimits;
  newLimits: CollaborationBudgetLimits;
  createdAt: string;
}

export interface CollaborationBudgetSnapshot {
  dispatches: { used: number; initialLimit: number; currentLimit: number };
  tokens: { used: number; initialLimit: number; currentLimit: number };
  costUsd: { used: number; initialLimit: number; currentLimit: number };
  durationMs: { used: number; initialLimit: number; currentLimit: number };
  cumulativeMultiplier: number;
  maxMultiplier: number;
  revisions: CollaborationBudgetRevision[];
}

export interface CollaborationDetail {
  dispatches: CollaborationDispatch[];
  attempts: CollaborationAttempt[];
  batches: CollaborationBatch[];
  decisions: CollaborationUserDecision[];
  activeAgents: Array<{ agentId: string; dispatchId: string; startedAt: string }>;
  budget: CollaborationBudgetSnapshot;
}

export type ResolveCollaborationDecision =
  | { action: 'answer'; message: string }
  | { action: 'terminate_at_budget' }
  | { action: 'increase_budget'; increasePercent: number }
  | { action: 'approve_task'; supervisorId: string; agentIds: string[]; defaultReviewerId?: string }
  | { action: 'reject_task'; reason?: string };
