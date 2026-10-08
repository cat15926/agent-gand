import type { ExternalExecutionProgress, ExternalTimeoutPolicy } from '@agent-gand/shared';
import { ExecutionError } from './errors.ts';

/** Account timeout starts after member/workspace admission; absolute deadlines remain authoritative. */
export function effectiveExternalTimeout(input: {
  configuredMs: number; managed: boolean; runDeadlineAt?: string; leaseExpiresAt?: string; now?: number;
}): ExternalTimeoutPolicy {
  const now = input.now ?? Date.now();
  let deadline = now + input.configuredMs;
  let source: ExternalTimeoutPolicy['source'] = input.managed ? 'account' : 'server';
  for (const [value, kind] of [[input.runDeadlineAt, 'run_deadline'], [input.leaseExpiresAt, 'coordination_lease']] as const) {
    if (value && Date.parse(value) <= deadline) { deadline = Date.parse(value); source = kind; }
  }
  return { configuredMs: input.configuredMs, effectiveMs: Math.max(1, deadline - now), source, deadlineAt: new Date(deadline).toISOString() };
}

export function externalTimeoutError(policy: ExternalTimeoutPolicy, progress?: ExternalExecutionProgress): ExecutionError {
  const phase = policy.source === 'run_deadline' || policy.source === 'coordination_lease' ? 'deadline'
    : !progress?.nativeInvokedAt ? 'initialization'
      : progress.firstTextAt || progress.firstToolAt ? 'after_activity'
        : progress.sessionBoundAt ? 'before_first_activity' : 'before_session';
  const labels = { deadline: '到达运行截止时间或执行租约期限', initialization: '初始化阶段未完成',
    before_session: '尚未建立原生会话', before_first_activity: '会话已建立，但未收到正文或工具活动', after_activity: '收到活动后仍未完成回合' };
  return new ExecutionError('timeout', `外部 Agent 执行超时：${labels[phase]}（有效上限 ${Math.ceil(policy.effectiveMs / 1000)} 秒）`, { phase });
}
