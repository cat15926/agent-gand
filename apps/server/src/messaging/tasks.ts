/**
 * 共享任务列表（规格 §6：P0-3 收件箱 + 共享任务列表 + 锁 → messaging/*）
 * 三态流转 pending → in_progress → completed；
 * claim 在 BEGIN IMMEDIATE 事务内完成「读-判-写」，防并发竞态（跨进程同样互斥）
 */
import type { Task, TaskKind, TaskStatus } from '@agent-gand/shared';
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
  kind: string;
  reviewer_id: string | null;
  acceptance_criteria: string;
  result: string | null;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
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
    kind: row.kind as TaskKind,
    reviewerId: row.reviewer_id,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria) as string[],
    result: row.result,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
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
  assignee?: string | null;
  kind?: TaskKind;
  reviewerId?: string | null;
  acceptanceCriteria?: string[];
  maxAttempts?: number;
}

export function createTask(input: CreateTaskInput): Task {
  const task: Task = {
    id: randomUUID(),
    runId: input.runId ?? null,
    title: input.title,
    body: input.body ?? null,
    status: 'pending',
    assignee: input.assignee ?? null,
    createdBy: input.createdBy,
    blockedBy: input.blockedBy ?? [],
    kind: input.kind ?? 'work',
    reviewerId: input.reviewerId ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    result: null,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  run(
    `INSERT INTO tasks (
       id, run_id, title, body, status, assignee, created_by, blocked_by,
       kind, reviewer_id, acceptance_criteria, result, attempt, max_attempts, last_error,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, NULL, ?, ?)`,
    task.id,
    task.runId,
    task.title,
    task.body,
    task.status,
    task.assignee,
    task.createdBy,
    JSON.stringify(task.blockedBy),
    task.kind,
    task.reviewerId,
    JSON.stringify(task.acceptanceCriteria),
    task.maxAttempts,
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
    if (row.assignee !== null && row.assignee !== agentId) {
      throw new TaskError(`任务已指派给 ${row.assignee}，${agentId} 不可认领`, 409);
    }
    if (row.attempt >= row.max_attempts) {
      throw new TaskError(`task 已达到最大执行次数 ${row.max_attempts}`, 409);
    }
    assertBlockersResolved(row);
    const now = new Date().toISOString();
    run(
      `UPDATE tasks
       SET status = 'in_progress', assignee = ?, attempt = attempt + 1, last_error = NULL, updated_at = ?
       WHERE id = ?`,
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
export function completeTask(id: string, agentId: string, result?: string | null): Task {
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
    run(
      `UPDATE tasks SET status = 'completed', result = COALESCE(?, result), last_error = NULL, updated_at = ? WHERE id = ?`,
      result ?? null,
      now,
      id,
    );
    const task = getTask(id);
    if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
    emit({ type: 'task.updated', task });
    return task;
  });
}

export interface TransitionTaskInput {
  from: TaskStatus | TaskStatus[];
  to: TaskStatus;
  result?: string | null;
  error?: string | null;
}

/** 调度状态转换：expected status 与更新在同一事务，防重复 scheduler tick。 */
export function transitionTask(id: string, input: TransitionTaskInput): Task {
  return tx(() => {
    const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) throw new TaskError(`task 不存在: ${id}`, 404);
    const allowed = Array.isArray(input.from) ? input.from : [input.from];
    if (!allowed.includes(row.status as TaskStatus)) {
      throw new TaskError(`task 状态冲突（期望 ${allowed.join('|')}，当前 ${row.status}）`, 409);
    }
    const now = new Date().toISOString();
    run(
      `UPDATE tasks SET status = ?, result = COALESCE(?, result), last_error = ?, updated_at = ? WHERE id = ?`,
      input.to,
      input.result ?? null,
      input.error ?? null,
      now,
      id,
    );
    const task = getTask(id);
    if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
    emit({ type: 'task.updated', task });
    return task;
  });
}

/** needs_revision 再次交给原 assignee，增加工作尝试次数。 */
export function claimRevision(id: string, agentId: string): Task {
  return tx(() => {
    const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) throw new TaskError(`task 不存在: ${id}`, 404);
    if (row.status !== 'needs_revision') throw new TaskError(`task 不在 needs_revision 状态`, 409);
    if (row.assignee !== agentId) throw new TaskError(`返工只能由原 assignee ${row.assignee ?? '-'} 执行`, 409);
    if (row.attempt >= row.max_attempts) throw new TaskError(`task 已达到最大执行次数 ${row.max_attempts}`, 409);
    const now = new Date().toISOString();
    run(
      `UPDATE tasks SET status = 'in_progress', attempt = attempt + 1, last_error = NULL, updated_at = ? WHERE id = ?`,
      now,
      id,
    );
    const task = getTask(id);
    if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
    emit({ type: 'task.updated', task });
    return task;
  });
}

export function failTask(id: string, error: string): Task {
  const task = getTask(id);
  if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new TaskError(`终态 task 不可失败（当前 ${task.status}）`, 409);
  }
  return transitionTask(id, { from: task.status, to: 'failed', error });
}

export function retryTask(id: string): Task {
  return tx(() => {
    const row = get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!row) throw new TaskError(`task 不存在: ${id}`, 404);
    if (row.status !== 'failed') throw new TaskError(`仅 failed task 可人工重试`, 409);
    const now = new Date().toISOString();
    run(
      `UPDATE tasks
       SET status = 'pending', max_attempts = CASE WHEN attempt >= max_attempts THEN attempt + 1 ELSE max_attempts END,
           last_error = NULL, updated_at = ?
       WHERE id = ?`,
      now,
      id,
    );
    const task = getTask(id);
    if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
    emit({ type: 'task.updated', task });
    return task;
  });
}

export function cancelTask(id: string): Task {
  const task = getTask(id);
  if (!task) throw new TaskError(`task 不存在: ${id}`, 404);
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new TaskError(`task 已是终态（当前 ${task.status}）`, 409);
  }
  return transitionTask(id, { from: task.status, to: 'cancelled' });
}

/** 进程启动恢复：回滚一次仅由 claim 增加的计数，使恢复复用同一逻辑 attempt 编号。 */
export function recoverInterruptedTasks(): Task[] {
  const rows = all<TaskRow>(
    `SELECT t.* FROM tasks t
     JOIN runs r ON r.id = t.run_id
     WHERE t.status IN ('in_progress', 'awaiting_review')
       AND r.status IN ('running', 'awaiting_approval')
     ORDER BY t.updated_at ASC`,
  );
  const recovered: Task[] = [];
  for (const row of rows) {
    const next: TaskStatus = row.attempt > 1 ? 'needs_revision' : 'pending';
    const error = '服务重启，正在从最近持久化边界恢复';
    run('UPDATE tasks SET status = ?, attempt = MAX(0, attempt - 1), last_error = ?, updated_at = ? WHERE id = ?', next, error, new Date().toISOString(), row.id);
    const task = getTask(row.id);
    if (task) {
      recovered.push(task);
      emit({ type: 'task.updated', task });
    }
  }
  return recovered;
}
