import { assertLegacyRun } from '../runs/legacyMode.ts';
import {loadRuntimeContract} from '../runtime/runPolicy.ts';
import {settleAutonomousRun} from '../collaboration/autonomousRunner.ts';
import {kickCollaboration} from '../collaboration/scheduler.ts';
import { assertReadonlyRecovery } from './graphCheckpoint.ts';
import { businessQuiescent } from './businessGates.ts';
import { taskAdapterEnabled } from '../runtime/taskAdapter.ts';
import type { Run, Task } from '@agent-gand/shared';
import { getRunOrchestrationSnapshot } from './store.ts';
import { all, get, run, tx } from '../db/database.ts';
import { getRun, setRunStatus } from '../runs/trace.ts';
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
import { closeTaskAdapter, isAdapterTurnTask } from '../runtime/taskAdapter.ts';
import { cancelTask, getTask, retryTask } from '../messaging/tasks.ts';
import { failAttempt } from '../tasks/attempts.ts';
import { resumeSupervisorRun } from './supervisor.ts';

const terminal = (item: Run) => ['completed','failed','cancelled'].includes(item.status);
const reject = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };

/** Task-scoped actions: compatibility endpoints and the common API share this boundary. */
export async function applyRunAction(runId: string, action: 'cancel' | 'pause' | 'resume'): Promise<Run> {
  assertLegacyRun(runId);
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
  if(get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?',runId)||!businessQuiescent(runId,true))return reject('原任务已承接或执行/工具/用量尚未收敛，不能直接恢复。');
  if(!plan&&item.mode!=='collaboration'&&!taskAdapterEnabled(runId))return reject('检查点缺少兼容适配器契约，不能静默全量重跑。');
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
    if(loadRuntimeContract(runId)?.features?.autonomousCollaboration?.entryVersion===1){setRunStatus(runId,'running');settleAutonomousRun(runId);kickCollaboration(item.conversationId);return getRun(runId)!;}
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
    if (task.runId) assertLegacyRun(task.runId);
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
  assertReadonlyRecovery(source.id);
  if(!taskAdapterEnabled(source.id))return reject('旧主管缺少当前适配器契约，不能直接重试。');
  if(get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?',source.id))return reject('原任务已有后继，不能再次重试。');
  if (!terminal(source)) { const retried = retryTask(taskId); void resumeSupervisorRun(source.id).catch(() => {}); return retried; }
  if (getRunOrchestrationSnapshot(source.id)?.request.businessContract) return reject('阶段验收账本尚不可跨 Run 迁移，请核对已验收结果后创建新任务');
  return reject('原任务已经失败，请在任务卡预览并确认依赖图承接；预算、完成证据和独立审查将一并保留。');
}
