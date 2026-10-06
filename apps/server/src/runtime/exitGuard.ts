import type { RuntimeCompletionBlocker, RuntimeControlAction } from '@agent-gand/shared';
import { loadRuntimeContract } from './runPolicy.ts';

export interface RuntimeExitGuardPolicy {
  version: 1;
  maxCorrections: number;
  correctionMaxTokens: number;
}

export type RuntimeExitStopReason = 'normal' | 'truncated' | 'approval_wait' | 'empty' | 'cancelled' | 'error';

export interface RuntimeExitGuardInput {
  stopReason: RuntimeExitStopReason;
  action: RuntimeControlAction | null;
  output: string;
  hasActiveCustody: boolean;
  holderMatches: boolean;
  completionBlockers?: RuntimeCompletionBlocker[];
  /** 历史纯函数调用兼容；新执行路径必须传 completionBlockers。 */
  openSuccessorObligations?: number;
  allowImplicitAnswer: boolean;
  protocolRequiresExplicit: boolean;
  evidenceCount: number;
  correctionAttempt: number;
  correctionBudgetAvailable: boolean;
  policy: RuntimeExitGuardPolicy;
}

export type RuntimeExitGuardEvaluation =
  | { status: 'allow_candidate'; reasons: string[] }
  | { status: 'continue_same_turn'; reasons: string[]; feedback: string }
  | { status: 'wait'; reasons: string[] }
  | { status: 'fail_attempt'; reasons: string[] }
  | { status: 'needs_attention'; reasons: string[] };

function blockers(input: RuntimeExitGuardInput): RuntimeCompletionBlocker[] {
  if (input.completionBlockers) return input.completionBlockers;
  return (input.openSuccessorObligations ?? 0) > 0
    ? [{ code: 'REQUIRED_OBLIGATION_PENDING', category: 'work', message: '仍有必需后继义务未完成' }]
    : [];
}

function blockerFeedback(items: RuntimeCompletionBlocker[]): string {
  return items.map((item) => `${item.code}${item.refId ? `(${item.refId})` : ''}`).join('、');
}
export function isAcknowledgementOutput(output: string): boolean {
  return /^(?:ack|ok|okay|收到|好的|明白|已收到|了解|开始处理|正在处理|我会处理|马上处理)[。.!！\s]*$/iu.test(output.trim());
}

function correction(input: RuntimeExitGuardInput, reasons: string[], feedback: string,
  exhausted: 'fail_attempt' | 'needs_attention' = 'needs_attention'): RuntimeExitGuardEvaluation {
  if (input.correctionBudgetAvailable && input.correctionAttempt < input.policy.maxCorrections) {
    return { status: 'continue_same_turn', reasons, feedback };
  }
  return { status: exhausted, reasons: [...reasons, 'EXIT_CORRECTION_EXHAUSTED'] };
}

/** 无数据库、无副作用的回合退出判定。 */
export function evaluateExitGuard(input: RuntimeExitGuardInput): RuntimeExitGuardEvaluation {
  if (input.stopReason === 'truncated') return { status: 'fail_attempt', reasons: ['TECHNICAL_TRUNCATION'] };
  if (input.stopReason === 'approval_wait') return { status: 'wait', reasons: ['APPROVAL_WAIT'] };
  if (input.stopReason === 'empty') return { status: 'fail_attempt', reasons: ['EMPTY_RESPONSE'] };
  if (input.stopReason === 'cancelled') return { status: 'fail_attempt', reasons: ['CANCELLED'] };
  if (input.stopReason === 'error') return { status: 'fail_attempt', reasons: ['AGENT_ERROR'] };
  if (!input.hasActiveCustody || !input.holderMatches) {
    return { status: 'needs_attention', reasons: [!input.hasActiveCustody ? 'MISSING_ACTIVE_CUSTODY' : 'CUSTODY_HOLDER_MISMATCH'] };
  }
  if (!input.action) {
    return correction(input, ['MISSING_CONTROL_DISPOSITION'],
      '当前事项仍由你负责。请明确选择完成、交接、征询或等待用户，不要直接结束回合。', 'fail_attempt');
  }
  if (input.action.type === 'hold') return { status: 'wait', reasons: ['DURABLE_HOLD_REQUESTED'] };
  if (input.action.type === 'cancel') return { status: 'needs_attention', reasons: ['AGENT_CANCEL_NOT_AUTHORIZED'] };
  if (input.action.type === 'handoff' || input.action.type === 'consult') {
    return { status: 'allow_candidate', reasons: ['VALID_CONTROL_TRANSITION'] };
  }
  const hasOutput = input.output.trim().length > 0;
  if (hasOutput && isAcknowledgementOutput(input.output)) return correction(input, ['ACK_ONLY_OUTPUT'],
    '确认收到不等于完成，请提交实际结果。', 'fail_attempt');
  if (input.action.type === 'complete') {
    const completionBlockers = blockers(input);
    if (completionBlockers.length > 0) {
      return correction(input, completionBlockers.map((item) => item.code),
        `当前责任仍有完成阻断：${blockerFeedback(completionBlockers)}。请先处理实际工作、外部等待或失效责任。`);
    }
    if (!hasOutput && input.evidenceCount === 0) {
      return correction(input, ['MISSING_COMPLETION_OUTPUT'],
        '完成申请缺少可交付结果。请调用 agent.complete，并在 summary 中给出完整最终结果。', 'fail_attempt');
    }
    return { status: 'allow_candidate', reasons: ['EXPLICIT_COMPLETE'] };
  }
  if (!hasOutput) {
    return correction(input, ['EMPTY_ANSWER_CANDIDATE'], '请给出完整结果；如已完成，请调用 agent.complete 提交结果。', 'fail_attempt');
  }
  const completionBlockers = blockers(input);
  if (completionBlockers.length > 0) {
    return correction(input, completionBlockers.map((item) => item.code),
      `当前回答不能关闭责任：${blockerFeedback(completionBlockers)}。请继续处理或选择等待。`);
  }
  if (input.allowImplicitAnswer && !input.protocolRequiresExplicit) {
    return { status: 'allow_candidate', reasons: ['IMPLICIT_ANSWER_FASTPATH'] };
  }
  return correction(input, ['EXPLICIT_DISPOSITION_REQUIRED'],
    '当前是动态协作步骤，普通正文只是答案候选，不能静默结束责任。若结果已完整，请调用 agent.complete 并提交完整 summary；否则请选择交接、征询或等待用户。');
}

/** 缺失配置表示阶段 2 之前入场的历史 Run，继续沿用旧退出语义。 */
export function runtimeExitGuardPolicy(runId: string): RuntimeExitGuardPolicy | null {
  const policy = loadRuntimeContract(runId)?.features?.exitGuard;
  if (!policy) return null;
  if (policy.version !== 1 || !Number.isInteger(policy.maxCorrections) || policy.maxCorrections < 0
    || !Number.isFinite(policy.correctionMaxTokens) || policy.correctionMaxTokens < 1) return null;
  return policy;
}
