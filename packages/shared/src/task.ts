/**
 * 共享任务列表（P0-2 / P0-3）
 * 三态 + 依赖（blockedBy 未完成不可认领）+ 认领/指派
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

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
  createdAt: string;
  updatedAt: string;
}
