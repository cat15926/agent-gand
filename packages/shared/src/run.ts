/**
 * 运行（Run）与可观测性事件（RunEvent = span）（P0-2 / P0-6 / P0-7）
 */

export type RunMode = 'pipeline' | 'supervisor';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

export interface Run {
  id: string;
  goal: string;
  mode: RunMode;
  status: RunStatus;
  agentIds: string[];
  /** 命名工作区（§10.2）：非空时无前缀路径解析到 sandbox/workspaces/<name>/；null = runId 专属（默认） */
  workspace?: string | null;
  /** 会话标题（§13.2）：缺省=目标前 24 字；可 PATCH（非空 ≤80）；null=用目标 */
  title?: string | null;
  createdAt: string;
  /** 软删时间（§13.3）：非空=已从列表移除（物理零删除，证据链保留）；null=在册 */
  deletedAt?: string | null;
  finishedAt: string | null;
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
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
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
