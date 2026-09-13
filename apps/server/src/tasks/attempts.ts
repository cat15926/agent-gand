import type { TaskAttempt, TaskAttemptKind, TaskAttemptStatus } from '@agent-gand/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';

interface AttemptRow {
  id: string;
  task_id: string;
  run_id: string;
  agent_id: string;
  kind: string;
  attempt_no: number;
  status: string;
  input_context: string | null;
  output: string | null;
  error: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

function rowToAttempt(row: AttemptRow): TaskAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    agentId: row.agent_id,
    kind: row.kind as TaskAttemptKind,
    attemptNo: row.attempt_no,
    status: row.status as TaskAttemptStatus,
    inputContext: row.input_context,
    output: row.output,
    error: row.error,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function getAttempt(id: string): TaskAttempt | undefined {
  const row = get<AttemptRow>('SELECT * FROM task_attempts WHERE id = ?', id);
  return row ? rowToAttempt(row) : undefined;
}

export function listAttempts(taskId: string): TaskAttempt[] {
  return all<AttemptRow>(
    'SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_no ASC, created_at ASC, rowid ASC',
    taskId,
  ).map(rowToAttempt);
}

export function createAttempt(input: {
  taskId: string;
  runId: string;
  agentId: string;
  kind: TaskAttemptKind;
  attemptNo: number;
  inputContext: string;
  leaseMs: number;
}): TaskAttempt {
  const now = new Date();
  const attempt: TaskAttempt = {
    id: randomUUID(),
    taskId: input.taskId,
    runId: input.runId,
    agentId: input.agentId,
    kind: input.kind,
    attemptNo: input.attemptNo,
    status: 'running',
    inputContext: input.inputContext,
    output: null,
    error: null,
    leaseOwner: `${process.pid}`,
    leaseExpiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    endedAt: null,
  };
  run(
    `INSERT INTO task_attempts (
       id, task_id, run_id, agent_id, kind, attempt_no, status, input_context,
       output, error, lease_owner, lease_expires_at, created_at, started_at, ended_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
    attempt.id,
    attempt.taskId,
    attempt.runId,
    attempt.agentId,
    attempt.kind,
    attempt.attemptNo,
    attempt.status,
    attempt.inputContext,
    attempt.leaseOwner,
    attempt.leaseExpiresAt,
    attempt.createdAt,
    attempt.startedAt,
  );
  emit({ type: 'task.attempt.updated', attempt });
  return attempt;
}

function finishAttempt(id: string, status: 'completed' | 'failed', output: string | null, error: string | null): TaskAttempt {
  return tx(() => {
    const now = new Date().toISOString();
    const changes = run(
      `UPDATE task_attempts
       SET status = ?, output = ?, error = ?, lease_owner = NULL, lease_expires_at = NULL, ended_at = ?
       WHERE id = ? AND status = 'running'`,
      status,
      output,
      error,
      now,
      id,
    );
    if (changes === 0) throw new Error(`attempt 不存在或已结束: ${id}`);
    const attempt = getAttempt(id);
    if (!attempt) throw new Error(`attempt 不存在: ${id}`);
    emit({ type: 'task.attempt.updated', attempt });
    return attempt;
  });
}

export function completeAttempt(id: string, output: string): TaskAttempt {
  return finishAttempt(id, 'completed', output, null);
}

export function failAttempt(id: string, error: string): TaskAttempt {
  return finishAttempt(id, 'failed', null, error);
}

/** 启动恢复：关闭遗留租约，任务是否重排由 scheduler 决定。 */
export function expireLeases(now = new Date().toISOString()): TaskAttempt[] {
  const rows = all<AttemptRow>(
    `SELECT * FROM task_attempts
     WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`,
    now,
  );
  const expired: TaskAttempt[] = [];
  for (const row of rows) {
    try {
      expired.push(failAttempt(row.id, '执行进程中断或租约超时'));
    } catch {
      // 其他恢复器已处理。
    }
  }
  return expired;
}

/** 新进程启动时，所有 running attempt 都属于已中断的旧执行。 */
export function interruptRunningAttempts(): TaskAttempt[] {
  const rows = all<AttemptRow>("SELECT * FROM task_attempts WHERE status = 'running'");
  const interrupted: TaskAttempt[] = [];
  for (const row of rows) {
    try {
      interrupted.push(failAttempt(row.id, '服务进程重启，执行中断'));
    } catch {
      // 已由其他恢复路径处理。
    }
  }
  return interrupted;
}
