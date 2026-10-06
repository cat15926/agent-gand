import { randomUUID } from 'node:crypto';
import { get } from '../db/database.ts';
import { recoverCollaborationRuns } from '../collaboration/scheduler.ts';
import { createDispatch } from '../collaboration/store.ts';
import { resumePipelineRun } from '../orchestration/pipeline.ts';
import { resumeSupervisorRun } from '../orchestration/supervisor.ts';
import { getRun, listRuns, setRunStatus } from './trace.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { resumeCoordinationRun } from '../coordination/runtime.ts';
import { resumeFastPathRun } from '../conversations/dispatcher.ts';
import { latestCheckpoint } from './checkpoints.ts';
import {
  assertDurableHoldClaim,
  cancelDurableHolds,
  claimReadyDurableHolds,
  completeDurableHoldClaim,
  getRuntimeWakeEvent,
  releaseDurableHoldClaim,
  RuntimeHoldRecoveryError,
} from '../runtime/holds.ts';
import { observeWakeLink } from '../runtime/shadow.ts';
import { commitWakeActionCommand } from '../runtime/actionCommands.ts';

const durableWakeOwner = `wake:${process.pid}:${randomUUID()}`;

/** 从编排器的持久化边界唤醒；各编排器内部有进程内去重锁。 */
export function wakeRun(runId: string): void {
  const run = getRun(runId);
  if (!run || !['running', 'awaiting_approval'].includes(run.status)) return;
  if (get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND recovery_attention=1', runId)) return;
  if (getRunCoordinationPlan(runId)) void resumeCoordinationRun(runId).catch(() => { /* execute 已持久化失败；避免恢复任务变成未处理拒绝 */ });
  else if (latestCheckpoint(runId, 'fastpath')) void resumeFastPathRun(runId).catch(() => {});
  else if (run.mode === 'pipeline') void resumePipelineRun(runId).catch(() => {});
  else if (run.mode === 'supervisor') void resumeSupervisorRun(runId).catch(() => {});
  else recoverCollaborationRuns();
}

export function recoverDurableRuns(): void {
  for (const status of ['running', 'awaiting_approval']) {
    for (const run of listRuns({ status, includeDeleted: true })) wakeRun(run.id);
  }
}

/**
 * 扫描并竞争性 claim 已满足的 Hold。Resume Dispatch 与 Hold 完成在同一事务中提交；
 * claim 进程崩溃时，30 秒租约到期后可由下一进程重新接管。
 */
export function recoverDurableHolds(runId?: string): number {
  const claims = claimReadyDurableHolds({ claimOwner: durableWakeOwner, runId });
  const wakeRunIds = new Set<string>();
  let resumed = 0;
  for (const claim of claims) {
    try {
      commitWakeActionCommand({ runId: claim.runId, commandKey: `runtime-wake:${claim.id}:g${claim.generation}`,
        attemptId: claim.sourceAttemptId, dispatchId: claim.sourceDispatchId, execute: () => {
        const hold = assertDurableHoldClaim(claim.id, claim.claimToken!);
        const wakeEvent = hold.wakeEventId ? getRuntimeWakeEvent(hold.wakeEventId) : null;
        let resumedDispatchId: string | null = null;
        if (hold.recoveryPolicy.kind === 'resume_dispatch') {
          if (!hold.sourceDispatchId) {
            throw new RuntimeHoldRecoveryError('permanent', 'SOURCE_MISSING', 'Durable Hold 缺少来源 Dispatch');
          }
          const sourceRun = getRun(hold.runId);
          if (!sourceRun) {
            throw new RuntimeHoldRecoveryError('terminal', 'RUN_TERMINAL', 'Durable Hold 所属 Run 不存在');
          }
          const sourceMessageId = typeof wakeEvent?.payload.messageId === 'string'
            ? wakeEvent.payload.messageId : hold.recoveryPolicy.sourceMessageId;
          const dispatch = createDispatch({ runId: hold.runId,
            conversationId: sourceRun.conversationId, sourceMessageId,
            parentDispatchId: hold.recoveryPolicy.parentDispatchId, kind: 'resume', from: 'system',
            targetAgentId: hold.recoveryPolicy.targetAgentId, reason: hold.recoveryPolicy.reason,
            depth: hold.recoveryPolicy.depth, priority: 'urgent',
            idempotencyKey: `hold:${hold.id}:resume`, dedupeText: `hold-resume:${hold.id}` });
          observeWakeLink(hold.sourceDispatchId, dispatch.id, hold.id, hold.generation);
          resumedDispatchId = dispatch.id;
          setRunStatus(hold.runId, 'running');
        } else if (hold.recoveryPolicy.kind === 'requeue_dispatch') {
          setRunStatus(hold.runId, 'running');
        } else if (hold.recoveryPolicy.kind === 'wake_run') {
          setRunStatus(hold.runId, 'running');
        }
        completeDurableHoldClaim({ id: hold.id, claimToken: hold.claimToken!, resumedDispatchId,
          resolution: { wakeEventId: wakeEvent?.id ?? null, wakeKind: wakeEvent?.kind ?? hold.condition.kind } });
        return { holdId: hold.id, resumedDispatchId, wakeEventId: wakeEvent?.id ?? null };
      } });
      wakeRunIds.add(claim.runId); resumed++;
    } catch (error) {
      const currentRun = getRun(claim.runId);
      if (!currentRun || ['completed', 'failed', 'cancelled'].includes(currentRun.status)) {
        cancelDurableHolds(claim.runId, 'run_terminal_before_wake', 'RUN_TERMINAL');
      } else {
        const recoveryError = claim.recoveryPolicy.kind === 'resume_dispatch' && !claim.sourceDispatchId
          ? { kind: 'permanent' as const, code: 'SOURCE_MISSING' as const,
            message: 'Durable Hold 缺少来源 Dispatch' }
          : error;
        releaseDurableHoldClaim(claim.id, claim.claimToken!, recoveryError);
      }
    }
  }
  for (const id of wakeRunIds) wakeRun(id);
  return resumed;
}
