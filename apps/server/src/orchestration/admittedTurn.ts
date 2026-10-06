import { get, run, tx } from '../db/database.ts';
import { claimTask, completeTask, createTask, failTask, getTask } from '../messaging/tasks.ts';
import { completeAttempt, createAttempt, failAttempt } from '../tasks/attempts.ts';
import { config } from '../config.ts';
import { admitTaskAdapter, admitTaskSubject } from '../runtime/taskAdapter.ts';
import { taskAdapterEnabled } from '../runtime/taskAdapter.ts';
import { getRun, setRunStatus } from '../runs/trace.ts';
import { runAgentTurn, type AgentTurnOptions, type AgentTurnResult } from './agentStep.ts';
import type { Run } from '@agent-gand/shared';

export class RunPausedError extends Error { constructor() { super('任务已在安全边界暂停'); } }
export function adapterRecoveryReady(runId: string): boolean {
  if (taskAdapterEnabled(runId)) return true;
  run(`INSERT INTO orchestration_run_controls(run_id,recovery_attention,reason) VALUES (?,1,?)
    ON CONFLICT(run_id) DO UPDATE SET recovery_attention=1,reason=excluded.reason`, runId,
  '历史运行缺少当前执行契约，需核对已知结果；本阶段不自动迁移或重复调用');
  setRunStatus(runId, 'waiting_for_user');
  return false;
}
export function adapterSafeBoundary(runId: string): void {
  const state = get<{ pause_requested: number; recovery_attention: number; reason: string | null }>('SELECT * FROM orchestration_run_controls WHERE run_id=?', runId);
  if (state?.recovery_attention) throw new RunPausedError();
  if (state?.pause_requested) { setRunStatus(runId, 'waiting_for_user'); throw new RunPausedError(); }
}
export function prepareAdapterTurns(item: Run, turns: Array<{ scope: string; agentId: string }>): void {
  admitTaskAdapter(item);
  tx(() => {
    for (const turn of turns) {
      if (get('SELECT task_id FROM orchestration_turn_tasks WHERE run_id=? AND scope=?', item.id, turn.scope)) continue;
      const name = get<{ name: string }>("SELECT json_extract(definition,'$.name') name FROM run_agent_snapshots WHERE run_id=? AND agent_id=?", item.id, turn.agentId)?.name ?? turn.agentId;
      const title = turn.scope === 'supervisor:planning' ? '主管拆解' : turn.scope === 'supervisor:summary' ? '主管汇总'
        : turn.scope.startsWith('pipeline:') ? `顺序接力：${name}` : `本轮回应：${name}`;
      const task = createTask({ runId: item.id, title, body: item.goal, createdBy: 'system',
        assignee: turn.agentId, maxAttempts: 1, acceptanceCriteria: ['提供完整结果，不能仅确认收到'] });
      run('INSERT INTO orchestration_turn_tasks(run_id,scope,task_id) VALUES (?,?,?)', item.id, turn.scope, task.id);
      admitTaskSubject(task.id, 'work');
    }
  });
}
export async function runAdmittedTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  adapterSafeBoundary(opts.run.id);
  const scope = opts.executionScopeId; if (!scope) throw new Error('兼容入口必须提供稳定执行范围');
  prepareAdapterTurns(opts.run, [{ scope, agentId: opts.agent.id }]);
  const link = get<{ task_id: string }>('SELECT task_id FROM orchestration_turn_tasks WHERE run_id=? AND scope=?', opts.run.id, scope)!;
  const task = getTask(link.task_id)!;
  if (task.status === 'completed') return { content: task.result ?? '', toolRounds: 0, emptyResponse: false, controlAction: null };
  if (task.status !== 'pending') throw new Error('该步骤已有执行或失败结果，不能重复调用');
  const claimed = claimTask(task.id, opts.agent.id);
  const attempt = createAttempt({ taskId: task.id, runId: opts.run.id, agentId: opts.agent.id,
    kind: 'work', attemptNo: claimed.attempt, inputContext: JSON.stringify(opts.messages), leaseMs: config.taskLeaseMs });
  try {
    const result = await runAgentTurn({ ...opts, taskId: task.id, attemptId: attempt.id });
    if (['completed','failed','cancelled'].includes(getRun(opts.run.id)?.status ?? 'cancelled')) throw new Error('运行已终止，丢弃迟到结果');
    if (result.emptyResponse || result.truncated || result.approvalStarved) throw new Error('步骤没有完整结果，不能提交完成');
    tx(() => { completeAttempt(attempt.id, result.content); completeTask(task.id, opts.agent.id, result.content); });
    return result;
  } catch (error) {
    try { failAttempt(attempt.id, error instanceof Error ? error.message : String(error)); } catch { /* Terminal CAS closed the attempt. */ }
    if (!['completed','failed','cancelled'].includes(getTask(task.id)?.status ?? 'cancelled')) failTask(task.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
