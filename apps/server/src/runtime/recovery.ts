import type { RunRecoveryAssessment } from '@agent-gand/shared';
import { get } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { listByRun } from '../messaging/inbox.ts';
import { listAttempts, listDispatches } from '../collaboration/store.ts';
import { listExecutions } from '../execution/store.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { getRunOrchestrationSnapshot } from '../orchestration/store.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { loadRuntimeContract } from './runPolicy.ts';
import { attemptAccess } from '../messaging/access.ts';

/** Common, read-only recovery eligibility. Never quiesces a process or replays work. */
export function assessRunRecovery(runId: string): RunRecoveryAssessment {
  const source = getRun(runId);
  if (!source) throw Object.assign(new Error('Run 不存在'), { status: 404 });
  const next = get<{ target_run_id: string }>('SELECT target_run_id FROM orchestration_run_continuations WHERE source_run_id=?', runId);
  const previous = get<{ source_run_id: string }>('SELECT source_run_id FROM orchestration_run_continuations WHERE target_run_id=?', runId);
  const dispatches = listDispatches(runId), attempts = listAttempts(runId);
  const failed = dispatches.filter(item => item.status === 'failed');
  const executions = listExecutions(runId), tools = listToolExecutions(runId);
  const lastExecution = executions.at(-1);
  const result: RunRecoveryAssessment = { runId, category: 'unclassified_failure', continuationAllowed: false,
    reasonCodes: [], explanation: '', confirmedOutputs: attempts.filter(item => item.status === 'completed' && item.output?.trim()).length,
    targetAgentId: failed.length === 1 ? failed[0]!.targetAgentId : null,
    continuationRunId: next?.target_run_id ?? null, sourceRunId: previous?.source_run_id ?? null };
  const blocked = (code: string, message: string, category = result.category): RunRecoveryAssessment =>
    ({ ...result, category, reasonCodes: [code], explanation: message });
  if (next) return blocked('CONTINUATION_EXISTS', '已创建关联续跑，请查看后续任务。');
  if (source.status === 'cancelled') return blocked('USER_CANCELLED', '用户已取消；如需继续，请重新明确目标。', 'user_cancelled');
  if (source.status === 'completed') return blocked('ALREADY_COMPLETED', '本轮已结束；补充工作请创建新任务。', 'completed');
  if (source.status !== 'failed') return blocked('RUN_NOT_TERMINAL', '本轮尚未失败；暂停、回答问题或恢复应使用原任务入口。', 'active');
  if (getRunOrchestrationSnapshot(runId)?.request.businessContract) return blocked('BUSINESS_CHECKPOINT_UNSUPPORTED', '本轮包含阶段验收清单，尚不支持跨 Run 迁移阶段账本；请核对已验收结果后新建明确剩余目标的任务。');
  const control = get<{ recovery_attention: number }>('SELECT recovery_attention FROM orchestration_run_controls WHERE run_id=?', runId);
  if (control?.recovery_attention || executions.some(item => item.status === 'running' || item.recovery?.state === 'attention'
      || item.status === 'interrupted' && item.recovery?.state !== 'quiesced')
    || get("SELECT p.token FROM external_native_processes p JOIN external_agent_executions e ON e.id=p.execution_id WHERE e.run_id=? AND p.status='active' LIMIT 1", runId)
    || get("SELECT id FROM collaboration_attempts WHERE run_id=? AND status='running' LIMIT 1", runId)
    || get("SELECT id FROM task_attempts WHERE run_id=? AND status='running' LIMIT 1", runId)
    || get("SELECT id FROM coordination_step_attempts WHERE run_id=? AND status='running' LIMIT 1", runId)
    || tools.some(item => ['running', 'needs_attention'].includes(item.status)
      || item.replayPolicy === 'manual' && ['failed','interrupted'].includes(item.status))) {
    return blocked('RESULT_UNKNOWN', '存在未收敛进程或未知工具结果，需先核对实际状态，不能自动续跑。', 'result_unknown');
  }
  if (executions.some(item => item.permissionMode !== 'readonly')
    || tools.some(item => item.replayPolicy !== 'safe')
    || getRunOrchestrationSnapshot(runId)?.execution?.readonly === false) {
    return blocked('WRITE_RECONCILIATION_REQUIRED', '本轮包含写入或幂等操作，需核对产物与账本；仅复制文字不足以安全续跑。', 'result_unknown');
  }
  if (lastExecution?.errorCode === 'auth_required' || lastExecution?.errorCode === 'missing_binary') {
    result.category = 'external_condition';
  } else if ((lastExecution && ['timeout','interrupted'].includes(lastExecution.errorCode ?? ''))
    || failed.some(item => attempts.filter(attempt => attempt.dispatchId === item.id).at(-1)?.status === 'interrupted')) {
    result.category = 'temporary_failure';
  }
  if (source.mode !== 'collaboration' || getRunCoordinationPlan(runId)) {
    return blocked('ENGINE_CONTINUATION_UNSUPPORTED', '此入口当前支持只读自由协作；其他工作流请使用原有分支重试或新任务入口。');
  }
  if (loadRuntimeContract(runId)?.features?.messageVisibilityVersion !== 1) {
    return blocked('LEGACY_CONTEXT_UNVERIFIED', '历史 Run 未冻结信息可见性边界，请核对信息后准备新任务。');
  }
  if (listByRun(runId).some(message => message.visibility === 'private')
    || attempts.some(attempt => attemptAccess(attempt.id).visibility === 'private')) {
    return blocked('PRIVATE_CHECKPOINT_UNSUPPORTED', '私密状态尚无跨 Run 恢复契约，不能自动汇入续跑；请由所有者提供经授权摘要。');
  }
  if (failed.length !== 1 || failed[0]!.kind === 'fanout'
    || dispatches.some(item => item.status === 'queued' || item.status === 'running')) {
    return blocked('AMBIGUOUS_PENDING_WORK', '无法唯一确定待续事项或还有未结束分支，请准备新任务并明确剩余目标。');
  }
  if (result.category === 'unclassified_failure') return blocked('FAILURE_NOT_CLASSIFIED', '尚不能确认这是可继续的暂时性执行错误，请先检查失败原因。');
  return { ...result, continuationAllowed: true, explanation: '可预览只读关联续跑，携带已确认输出并只派发待续事项；新任务会重新冻结当前账户与角色。' };
}

/** Reject exact re-dispatch of confirmed work in a linked continuation. Natural-language intent remains a business contract concern. */
export function continuationRouteBlock(runId: string, targets: string[], objective: string): string | null {
  const row = get<{ manifest: string }>('SELECT manifest FROM orchestration_run_continuations WHERE target_run_id=?', runId);
  if (!row) return null;
  const manifest = JSON.parse(row.manifest) as { outputs: Array<{ agentId: string; actionKind: string; objective: string }> };
  const normalized = (text: string) => text.trim().replace(/\s+/gu, ' ');
  const duplicate = manifest.outputs.find(item => ['answer','complete','finish'].includes(item.actionKind)
    && targets.includes(item.agentId) && normalized(item.objective) === normalized(objective));
  return duplicate ? `成员 ${duplicate.agentId} 对该事项已有确认输出，请复用续跑进度，不能重复派发。` : null;
}
