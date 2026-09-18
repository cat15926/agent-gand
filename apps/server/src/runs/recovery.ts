import { recoverCollaborationRuns } from '../collaboration/scheduler.ts';
import { resumePipelineRun } from '../orchestration/pipeline.ts';
import { resumeSupervisorRun } from '../orchestration/supervisor.ts';
import { getRun, listRuns } from './trace.ts';

/** 从编排器的持久化边界唤醒；各编排器内部有进程内去重锁。 */
export function wakeRun(runId: string): void {
  const run = getRun(runId);
  if (!run || !['running', 'awaiting_approval'].includes(run.status)) return;
  if (run.mode === 'pipeline') void resumePipelineRun(runId);
  else if (run.mode === 'supervisor') void resumeSupervisorRun(runId);
  else recoverCollaborationRuns();
}

export function recoverDurableRuns(): void {
  for (const status of ['running', 'awaiting_approval']) {
    for (const run of listRuns({ status, includeDeleted: true })) wakeRun(run.id);
  }
}
