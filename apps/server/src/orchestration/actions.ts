import type { Run, Task } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { createRun, getRun, setRunStatus } from '../runs/trace.ts';
import { nextTurnNo } from '../conversations/service.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import { wakeRun, recoverDurableHolds } from '../runs/recovery.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { cancelCoordinationRun, requestCoordinationPause, assertCoordinationRecoveryReady, requestCoordinationResume, resumeCoordinationRun } from '../coordination/runtime.ts';
import { cancelCollaborationRun } from '../collaboration/store.ts';
import { closeCollaborationTrace, settleCollaborationRun } from '../collaboration/scheduler.ts';
import { stopExternalRun, stopExternalAttempt } from '../execution/runner.ts';
import { expirePendingApprovalsForRun } from '../hitl/approvals.ts';
import { commitRunTerminal } from '../runtime/terminal.ts';
import { requestAdapterPause } from '../runtime/runControls.ts';
import { admitTaskAdapter, admitTaskSubject, closeTaskAdapter, isAdapterTurnTask } from '../runtime/taskAdapter.ts';
import { cancelTask, claimTask, completeTask, createTask, getTask, listTasks, retryTask } from '../messaging/tasks.ts';
import { completeAttempt, createAttempt, failAttempt, listAttempts } from '../tasks/attempts.ts';
import { listReviews, createReview } from '../tasks/reviews.ts';
import { resumeSupervisorRun } from './supervisor.ts';
import { prepareAdapterTurns } from './admittedTurn.ts';
import { config } from '../config.ts';
import { post } from '../messaging/inbox.ts';

const terminal = (item: Run) => ['completed','failed','cancelled'].includes(item.status);
const reject = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };

/** Task-scoped actions: compatibility endpoints and the common API share this boundary. */
export async function applyRunAction(runId: string, action: 'cancel' | 'pause' | 'resume'): Promise<Run> {
  const item = getRun(runId); if (!item) return reject('Run 不存在', 404);
  const plan = getRunCoordinationPlan(runId);
  if (action === 'cancel') {
    if (plan) cancelCoordinationRun(runId);
    else commitRunTerminal({ runId, status: 'cancelled', disposition: 'cancelled', source: 'task_action:cancel',
      userMessageStatus: 'failed', closeExecution: () => {
        cancelCollaborationRun(runId); closeTaskAdapter(runId, 'cancelled');
        run("UPDATE execution_member_tickets SET status='cancelled' WHERE run_id=? AND status='waiting'", runId);
        expirePendingApprovalsForRun(runId, 'system:cancelled');
      }, prepare: () => ({ reasonCodes: ['USER_STOPPED'] }) });
    if (getRun(runId)?.status === 'cancelled') closeCollaborationTrace(runId, 'cancelled');
    await stopExternalRun(runId);
    return getRun(runId)!;
  }
  if (terminal(item)) return reject('终态任务不可暂停或恢复；重试应创建新的执行');
  if (action === 'pause') {
    if (plan) requestCoordinationPause(runId);
    else { requestAdapterPause(runId); if (item.mode === 'collaboration') settleCollaborationRun(runId); }
    return getRun(runId)!;
  }
  const control = get<{ pause_requested: number; recovery_attention: number; reason: string | null }>('SELECT * FROM orchestration_run_controls WHERE run_id=?', runId);
  if (control?.recovery_attention) return reject(control.reason ?? '执行结果未知，不能直接恢复');
  if (plan) {
    if (item.status !== 'waiting_for_user' || plan.status !== 'paused') return reject('只有已暂停的计划可恢复');
    assertCoordinationRecoveryReady(runId);
    if (requestCoordinationResume(runId)) recoverDurableHolds(runId);
    else void resumeCoordinationRun(runId).catch(() => {});
  } else {
    if (item.status !== 'waiting_for_user' || !control?.pause_requested) return reject('只有用户暂停的任务可恢复；待回答的问题需由原决定入口处理');
    run('UPDATE orchestration_run_controls SET pause_requested=0 WHERE run_id=?', runId);
    const started = get('SELECT id FROM run_checkpoints WHERE run_id=? LIMIT 1', runId);
    setRunStatus(runId, started ? 'running' : 'pending');
    if (!started) enqueueConversationRun(runId);
    else if (item.mode === 'collaboration') settleCollaborationRun(runId);
    else wakeRun(runId);
  }
  return getRun(runId)!;
}

export async function cancelTaskExecution(taskId: string): Promise<Task> {
  const result = tx(() => {
    const task = getTask(taskId); if (!task) return reject('Task 不存在', 404);
    const attempts = all<{ id: string }>("SELECT id FROM task_attempts WHERE task_id=? AND status='running'", taskId);
    for (const attempt of attempts) {
      try { failAttempt(attempt.id, '用户取消任务'); } catch { /* Already fenced. */ }
    }
    return { task: cancelTask(taskId), attempts };
  });
  await Promise.all(result.attempts.map(attempt => stopExternalAttempt(attempt.id)));
  return result.task;
}

/** A terminal Run is immutable. Retry keeps confirmed branches and creates a separately traceable Run. */
export function retryTaskExecution(taskId: string): Task {
  const existing = get<{ target_task_id: string }>('SELECT target_task_id FROM orchestration_task_retries WHERE source_task_id=?', taskId);
  if (existing) return getTask(existing.target_task_id)!;
  const task = getTask(taskId); if (!task) return reject('Task 不存在', 404);
  if (!task.runId) return retryTask(taskId);
  const source = getRun(task.runId); if (!source) return reject('Task 的 Run 不存在', 404);
  if (source.mode !== 'supervisor' || isAdapterTurnTask(task.id)) return reject('此重试入口仅支持主管任务分支');
  if (task.status !== 'failed' || source.status === 'cancelled') return reject('只有失败且未被取消的任务可重试');
  if (get(`SELECT id FROM external_agent_executions WHERE run_id=? AND status IN ('interrupted','running')`, source.id)
    || get("SELECT id FROM tool_executions WHERE run_id=? AND (status IN ('running','needs_attention') OR (replay_policy='manual' AND status IN ('failed','interrupted')))", source.id)) return reject('存在未确认的执行或写入，需先核对工作区并创建新任务');
  if (get("SELECT id FROM external_agent_executions WHERE run_id=? AND COALESCE(json_extract(record,'$.permissionMode'),'readonly')!='readonly'", source.id)) return reject('原生写入分支需要先核对并迁移已确认的工作区，不能只复用文字结果');
  if (!terminal(source)) { const retried = retryTask(taskId); void resumeSupervisorRun(source.id).catch(() => {}); return retried; }
  const result = tx(() => {
    const duplicate = get<{ target_task_id: string }>('SELECT target_task_id FROM orchestration_task_retries WHERE source_task_id=?', taskId);
    if (duplicate) return getTask(duplicate.target_task_id)!;
    const next = createRun(source.goal, source.mode, source.agentIds, source.workspace ?? null, source.supervisorId ?? null,
      source.conversationId, nextTurnNo(source.conversationId), source.defaultReviewerId ?? null);
    admitTaskAdapter(next);
    post({ runId: next.id, from: 'user', to: 'all', kind: 'user', body: `重试失败任务「${task.title}」`,
      clientMessageId: `retry:${next.id}`, deliveryStatus: 'processing', meta: { retryOfRunId: source.id, retryOfTaskId: task.id } });
    const originals = listTasks(source.id).filter(t => !isAdapterTurnTask(t.id));
    if (originals.some(task => task.status === 'cancelled')) return reject('该 Run 含用户取消的分支，请创建新任务明确本轮目标');
    const replacements = new Map<string, Task>();
    for (const original of originals) {
      const copy = createTask({ runId: next.id, title: original.title, body: original.body, createdBy: original.createdBy,
        assignee: original.assignee, reviewerId: original.reviewerId, acceptanceCriteria: original.acceptanceCriteria,
        maxAttempts: original.maxAttempts });
      replacements.set(original.id, copy);
      admitTaskSubject(copy.id, 'work'); if (copy.reviewerId) admitTaskSubject(copy.id, 'review');
    }
    prepareAdapterTurns(next, [{ scope: 'supervisor:summary', agentId: next.supervisorId ?? next.agentIds[0]! }]);
    for (const original of originals) {
      const copy = replacements.get(original.id)!;
      run('UPDATE tasks SET blocked_by=? WHERE id=?', JSON.stringify(original.blockedBy.map(id => replacements.get(id)!.id)), copy.id);
      if (original.status !== 'completed' || !original.result || !copy.assignee) continue;
      const confirmed = listAttempts(original.id).filter(a => a.kind === 'work' && a.status === 'completed' && a.output === original.result).at(-1);
      const acceptedReview = confirmed ? listReviews(original.id).find(review => review.attemptId === confirmed.id && review.verdict === 'PASS') : null;
      if (!confirmed || (copy.reviewerId && !acceptedReview)) return reject('已完成分支缺少可信执行或审查记录，无法自动复用');
      const claimed = claimTask(copy.id, copy.assignee);
      const attempt = createAttempt({ taskId: copy.id, runId: next.id, agentId: copy.assignee, kind: 'work', attemptNo: claimed.attempt,
        inputContext: `复用已确认的任务结果 ${original.id}；来源 Run ${source.id}`, leaseMs: config.taskLeaseMs });
      completeAttempt(attempt.id, original.result);
      if (copy.reviewerId) {
        const review = createAttempt({ taskId: copy.id, runId: next.id, agentId: copy.reviewerId, kind: 'review', attemptNo: claimed.attempt,
          inputContext: `复用已确认的审查 ${original.id}`, leaseMs: config.taskLeaseMs });
        const verdict = { verdict: acceptedReview!.verdict, summary: acceptedReview!.summary, issues: acceptedReview!.issues };
        completeAttempt(review.id, JSON.stringify(verdict));
        createReview({ taskId: copy.id, attemptId: attempt.id, reviewerId: copy.reviewerId, ...verdict });
      }
      completeTask(copy.id, copy.assignee, original.result);
    }
    setRunStatus(next.id, 'running');
    const target = replacements.get(taskId)!;
    run('INSERT INTO orchestration_task_retries(source_task_id,target_task_id,target_run_id) VALUES (?,?,?)', taskId, target.id, next.id);
    return target;
  });
  void resumeSupervisorRun(result.runId!).catch(() => {});
  return getTask(result.id)!;
}
