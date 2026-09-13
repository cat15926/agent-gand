/**
 * 共享任务列表（P0-2 / P0-3）
 * 三态 + 依赖（blockedBy 未完成不可认领）+ 认领/指派
 */

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_review'
  | 'needs_revision'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskKind = 'work' | 'review';

export interface Task {
  id: string;
  /** 所属运行；手工创建的任务可为 null */
  runId: string | null;
  title: string;
  body?: string | null;
  status: TaskStatus;
  /** 认领者 / 被指派者（agent id） */
  assignee: string | null;
  createdBy: string; // agent id | 'user'
  /** 依赖的任务 id 列表（JSON 数组落库） */
  blockedBy: string[];
  kind: TaskKind;
  reviewerId: string | null;
  acceptanceCriteria: string[];
  result: string | null;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TaskAttemptKind = 'work' | 'review';
export type TaskAttemptStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskAttempt {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  kind: TaskAttemptKind;
  attemptNo: number;
  status: TaskAttemptStatus;
  inputContext: string | null;
  output: string | null;
  error: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
