/**
 * 运行（Run）与可观测性事件（RunEvent = span）（P0-2 / P0-6 / P0-7）
 */

export type RunMode = 'pipeline' | 'supervisor' | 'collaboration';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'waiting_for_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Run {
  id: string;
  /** 所属聊天室；旧数据启动时自动回填。 */
  conversationId: string;
  /** 聊天室内从 1 开始的执行轮次。 */
  turnNo: number;
  goal: string;
  mode: RunMode;
  status: RunStatus;
  agentIds: string[];
  /** 主管委派模式的显式主管；旧数据可为 null。 */
  supervisorId?: string | null;
  defaultReviewerId?: string | null;
  /** 命名工作区（§10.2）：非空时无前缀路径解析到 sandbox/workspaces/<name>/；null = runId 专属（默认） */
  workspace?: string | null;
  /** 会话标题（§13.2）：缺省=目标前 24 字；可 PATCH（非空 ≤80）；null=用目标 */
  title?: string | null;
  createdAt: string;
  /** 软删时间（§13.3）：非空=已从列表移除（物理零删除，证据链保留）；null=在册 */
  deletedAt?: string | null;
  finishedAt: string | null;
}

export type RunCheckpointKind = 'pipeline' | 'supervisor' | 'collaboration' | 'coordination' | 'agent_turn' | 'approval';
export type RunCheckpointStatus = 'active' | 'waiting' | 'completed' | 'superseded';

/** Durable execution 的恢复边界。state 是编排器可重放的最小状态，不保存模型内部状态。 */
export interface RunCheckpoint {
  id: string;
  runId: string;
  seq: number;
  kind: RunCheckpointKind;
  status: RunCheckpointStatus;
  phase: string;
  state: Record<string, unknown>;
  waitingOn: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ToolReplayPolicy = 'safe' | 'idempotent' | 'manual';
export type ToolExecutionStatus = 'running' | 'completed' | 'failed' | 'needs_attention';

/** 一次逻辑工具调用的执行账本；idempotencyKey 跨进程保持稳定。 */
export interface ToolExecution {
  id: string;
  runId: string;
  agentId: string;
  taskId: string | null;
  attemptId: string | null;
  toolName: string;
  idempotencyKey: string;
  input: string;
  replayPolicy: ToolReplayPolicy;
  status: ToolExecutionStatus;
  output: string | null;
  error: string | null;
  spanId: string | null;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
}

/** span 分类：llm 调用 / 工具调用 / agent 步骤 / 消息 / 审批 / 编排动作 */
export type SpanKind =
  | 'llm'
  | 'tool'
  | 'agent'
  | 'message'
  | 'approval'
  | 'orchestration';

export type SpanStatus = 'running' | 'ok' | 'error';

/** 统一观测协议版本。新增字段必须保持向后兼容，破坏性变更才递增主版本。 */
export const OBSERVABILITY_PROTOCOL_VERSION = 1 as const;

export type SpanAttributePrimitive = string | number | boolean | null;
export type SpanAttributeValue = SpanAttributePrimitive | SpanAttributePrimitive[];

/**
 * Span 语义属性。标准键使用小写点分命名；扩展键应带业务前缀。
 * 属性只承载可检索元数据，完整请求与响应仍放在 input/output。
 */
export interface SpanAttributes {
  'observability.version'?: number;
  'run.id'?: string;
  'run.mode'?: RunMode;
  'agent.id'?: string;
  'agent.role'?: 'pipeline' | 'supervisor' | 'worker' | 'reviewer' | 'collaborator';
  'task.id'?: string;
  'task.attempt.id'?: string;
  'task.attempt.no'?: number;
  'llm.model'?: string;
  'llm.round'?: number;
  'llm.stop_reason'?: string | null;
  'tool.name'?: string;
  'approval.id'?: string;
  'collaboration.dispatch.id'?: string;
  'collaboration.batch.id'?: string;
  'coordination.plan.id'?: string;
  'coordination.step.id'?: string;
  'coordination.attempt.id'?: string;
  'coordination.attempt.no'?: number;
  'orchestration.phase'?: string;
  [key: string]: SpanAttributeValue | undefined;
}

export interface RunEvent {
  id: string;
  runId: string;
  /** 嵌套 span 的父节点；顶层为 null */
  parentId: string | null;
  spanKind: SpanKind;
  name: string;
  input: string | null;
  output: string | null;
  status: SpanStatus;
  /** 可检索的稳定语义属性；旧数据读取时为空对象并按名称尽力回填。 */
  attributes: SpanAttributes;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: string;
  /** LLM 首个正文增量到达时间；非 LLM、未流式或尚未产出时为 null。 */
  firstTokenAt: string | null;
  endedAt: string | null;
}

/** 轨迹首屏使用的轻量 Span，不携带完整 input/output。 */
export interface SpanSummary extends Omit<RunEvent, 'input' | 'output'> {
  hasInput: boolean;
  hasOutput: boolean;
  inputBytes: number;
  outputBytes: number;
  inputPreview: string | null;
  outputPreview: string | null;
}

export type SpanDetail = RunEvent;

export type RunGraphNodeKind = 'run' | 'agent' | 'task' | 'coordination_step' | 'approval';
export type RunGraphEdgeKind =
  | 'contains'
  | 'next'
  | 'coordinates'
  | 'creates'
  | 'assigned_to'
  | 'reviewed_by'
  | 'executes'
  | 'depends_on';

export interface RunGraphNode {
  id: string;
  kind: RunGraphNodeKind;
  label: string;
  status: string | null;
  entityId: string;
  attributes: SpanAttributes;
}

export interface RunGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: RunGraphEdgeKind;
  label: string | null;
}

/** 编排拓扑：表达谁协调、谁执行、任务依赖；不承载时间顺序。 */
export interface RunGraph {
  protocolVersion: typeof OBSERVABILITY_PROTOCOL_VERSION;
  runId: string;
  mode: RunMode;
  nodes: RunGraphNode[];
  edges: RunGraphEdge[];
}

export interface TraceTreeNode {
  span: RunEvent;
  children: TraceTreeNode[];
  depth: number;
  durationMs: number | null;
  selfDurationMs: number | null;
  /** parentId 指向不存在的 span 时为 true，节点仍作为根节点返回。 */
  orphaned: boolean;
}

/** 调用树：表达 span 的父子关系与耗时；异常父链不会导致整棵树丢失。 */
export interface TraceTree {
  protocolVersion: typeof OBSERVABILITY_PROTOCOL_VERSION;
  runId: string;
  roots: TraceTreeNode[];
  totalSpans: number;
  maxDepth: number;
}

export interface TraceTreeSummaryNode {
  span: SpanSummary;
  children: TraceTreeSummaryNode[];
  depth: number;
  durationMs: number | null;
  selfDurationMs: number | null;
  orphaned: boolean;
}

export interface TraceTreeSummary {
  protocolVersion: typeof OBSERVABILITY_PROTOCOL_VERSION;
  runId: string;
  roots: TraceTreeSummaryNode[];
  totalSpans: number;
  maxDepth: number;
}

export type TrajectoryGroupKind =
  | 'pipeline_step'
  | 'task_attempt'
  | 'review_attempt'
  | 'dispatch'
  | 'coordination_step'
  | 'system';

export interface TrajectoryGroup {
  id: string;
  kind: TrajectoryGroupKind;
  label: string;
  status: string;
  agentId?: string;
  taskId?: string;
  attemptId?: string;
  dispatchId?: string;
  coordinationStepId?: string;
  spanIds: string[];
}

export interface RunObservability {
  protocolVersion: typeof OBSERVABILITY_PROTOCOL_VERSION;
  graph: RunGraph;
  trace: TraceTree;
  groups: TrajectoryGroup[];
}

export interface RunObservabilitySummary {
  protocolVersion: typeof OBSERVABILITY_PROTOCOL_VERSION;
  graph: RunGraph;
  trace: TraceTreeSummary;
  groups: TrajectoryGroup[];
}

/** 用量汇总（P0-6：基础 token/成本统计） */
export interface UsageSummary {
  runId: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  llmCalls: number;
  toolCalls: number;
}
