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
  createdAt: string;
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
