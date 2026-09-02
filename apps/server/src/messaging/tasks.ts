/**
 * 共享任务列表（规格 §6：P0-3 收件箱 + 共享任务列表 + 锁 → messaging/*）
 * 三态流转 pending → in_progress → completed；
 * claim 在 BEGIN IMMEDIATE 事务内完成「读-判-写」，防并发竞态（跨进程同样互斥）
 */
import type { Task, TaskStatus } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from './bus.ts';

interface TaskRow {
  id: string;
  run_id: string | null;
  title: string;
  body: string | null;
  status: string;
  assignee: string | null;
  created_by: string | null;
  blocked_by: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    assignee: row.assignee,
    createdBy: row.created_by ?? 'user',
    blockedBy: JSON.parse(row.blocked_by) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 带 HTTP 状态码的业务错误（routes 统一映射） */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

export interface CreateTaskInput {
  runId?: string | null;
  title: string;
  body?: string | null;
  createdBy: string; // agent id | 'user'
  blockedBy?: string[];
}

export function createTask(input: CreateTaskInput): Task {
  const task: Task = {
    id: randomUUID(),
    runId: input.runId ?? null,
    title: input.title,
    body: input.body ?? null,
    status: 'pending',
    assignee: null,
    createdBy: input.createdBy,
    blockedBy: input.blockedBy ?? [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO tasks (id, run_id, title, body, status, assignee, created_by, blocked_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    task.id,
    task.runId,
    task.title,
    task.body,
    task.status,
    task.assignee,
    task.createdBy,
    JSON.stringify(task.blockedBy),
    task.createdAt,
    task.updatedAt,
  );
  emit({ type: 'task.updated', task });
  return task;
}

export function listTasks(runId?: string): Task[] {
  const rows =
    runId === undefined
      ? all<TaskRow>('SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC')
      : all<TaskRow>(
          'SELECT * FROM tasks WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
          runId,
        );
  return rows.map(rowToTask);
}

export function getTask(id: string): Task | undefined {
  const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
  return row ? rowToTask(row) : undefined;
}

/** 依赖未完成则不可认领 */
function assertBlockersResolved(row: TaskRow): void {
  const blockedBy = JSON.parse(row.blocked_by) as string[];
  if (blockedBy.length === 0) return;
  const placeholders = blockedBy.map(() => '?').join(',');
  const unfinished = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM tasks WHERE id IN (${placeholders}) AND status != 'completed'`,
    ...blockedBy,
  );
  if ((unfinished?.n ?? 0) > 0) {
    throw new TaskError(`任务被未完成的前置任务阻塞（blockedBy 未全部 completed）`, 409);
  }
}

/**
 * 认领任务：BEGIN IMMEDIATE 事务内仅 pending 可领 → 置 in_progress + assignee。
 * 两次并发 claim 只有一次成功（后到者拿到 409）。
 */
export function claimTask(id: string, agentId: string): Task {
  return tx(() => {
    const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) throw new TaskError(`task 不存在: ${id}`, 404);
    if (row.status !== 'pending') {
      throw new TaskError(
        `task 已被认领或已完成（当前状态 ${row.status}，assignee ${row.assignee ?? '-' }）`,
        409,
      );
    }
    assertBlockersResolved(row);
    const now = new Date().toISOString();
    run(
      `UPDATE tasks SET status = 'in_progress', assignee = ?, updated_at = ? WHERE id = ?`,
      agentId,
      now,
      id,
    );
    const task = getTask(id);
    if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
    emit({ type: 'task.updated', task });
    return task;
  });
}

/** 完成任务：仅 assignee 本人在 in_progress 状态可完成 */
export function completeTask(id: string, agentId: string): Task {
  return tx(() => {
    const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) throw new TaskError(`task 不存在: ${id}`, 404);
    if (row.status !== 'in_progress') {
      throw new TaskError(`task 不在 in_progress 状态（当前 ${row.status}）`, 409);
    }
    if (row.assignee !== agentId) {
      throw new TaskError(`仅 assignee 可完成该任务（当前 assignee ${row.assignee ?? '-'}）`, 409);
    }
    const now = new Date().toISOString();
    run(`UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?`, now, id);
    const task = getTask(id);
    if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
    emit({ type: 'task.updated', task });
    return task;
  });
}
