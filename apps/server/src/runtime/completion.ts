import type { RuntimeCompletionEvaluation, RuntimeCompletionInput } from '@agent-gand/shared';

/** 无数据库或副作用的完成判定；Agent 的 finish 只产生候选，不在此处提交 Run 终态。 */
export function evaluateCompletion(input: RuntimeCompletionInput): RuntimeCompletionEvaluation {
  const reasons: string[] = [];
  const disposition = input.disposition ?? 'normal';
  if (input.pendingDecisions > 0) return { status: 'waiting', reasons: ['PENDING_USER_DECISION'] };
  if (disposition === 'delegated') return { status: 'accepted', reasons: ['USER_APPROVED_DELEGATION'], disposition };
  if (disposition === 'partial_user_accepted') {
    return input.hasAnyOutput
      ? { status: 'accepted', reasons: ['USER_ACCEPTED_PARTIAL_RESULT'], disposition }
      : { status: 'rejected', reasons: ['PARTIAL_RESULT_HAS_NO_OUTPUT'] };
  }
  if (input.dispatches.some((item) => item.status === 'failed' || item.status === 'blocked' || item.status === 'cancelled')) {
    reasons.push('FAILED_DISPATCH');
  }
  if (input.batchStatuses.some((status) => status === 'failed' || status === 'partial' || status === 'timeout')) {
    reasons.push('INCOMPLETE_BATCH');
  }
  const subjects = new Map(input.subjects.map((subject) => [subject.key, subject]));
  for (const key of input.contract.requiredSubjectKeys) {
    const subject = subjects.get(key);
    if (!subject) { reasons.push(`MISSING_REQUIRED_SUBJECT:${key}`); continue; }
    if (subject.status === 'failed' || subject.status === 'cancelled') reasons.push(`FAILED_REQUIRED_SUBJECT:${key}`);
  }
  if (reasons.length > 0) {
    for (const blocker of input.completionBlockers ?? []) {
      if (!reasons.includes(blocker.code)) reasons.push(blocker.code);
    }
    return { status: 'failed', reasons };
  }
  if (input.dispatches.some((item) => item.status === 'queued' || item.status === 'running')) {
    return { status: 'waiting', reasons: ['OPEN_DISPATCH'] };
  }
  if (input.batchStatuses.some((status) => status === 'running' || status === 'pending')) {
    return { status: 'waiting', reasons: ['OPEN_BATCH'] };
  }
  for (const key of input.contract.requiredSubjectKeys) {
    const subject = subjects.get(key)!;
    if (subject.status !== 'completed' || subject.custodyState !== 'completed') reasons.push(`SUBJECT_NOT_COMPLETED:${key}`);
    if (!subject.holderAgentId || subject.pendingHolderAgentId || subject.generation < 1) reasons.push(`INVALID_CUSTODY:${key}`);
    if (!subject.hasOutput) reasons.push(`MISSING_OUTPUT:${key}`);
    if (!subject.evidenceValid) reasons.push(`INVALID_EVIDENCE:${key}`);
  }
  if (!input.dependenciesSatisfied) reasons.push('DEPENDENCIES_NOT_SATISFIED');
  if (!input.requiredArtifactsSatisfied) reasons.push('REQUIRED_ARTIFACTS_MISSING');
  if (!input.reviewAccepted) reasons.push('REVIEW_NOT_ACCEPTED');
  if (!input.protocolTerminal) reasons.push('PROTOCOL_NOT_TERMINAL');
  if (input.completionBlockers) {
    for (const blocker of input.completionBlockers) {
      if (!reasons.includes(blocker.code)) reasons.push(blocker.code);
    }
  } else if (!input.successorObligationsSatisfied) reasons.push('SUCCESSOR_OBLIGATIONS_NOT_SATISFIED');
  if (reasons.length > 0) return { status: 'rejected', reasons };
  return { status: 'accepted', reasons: [], disposition };
}

export function describeCompletionReason(reason: string): string {
  const fixed: Record<string, string> = {
    PENDING_USER_DECISION: '仍有用户决策待处理', OPEN_DISPATCH: '仍有任务正在排队或执行', OPEN_BATCH: '仍有并行批次未汇合',
    FAILED_DISPATCH: '至少一个任务失败、被阻断或取消', INCOMPLETE_BATCH: '并行批次未全部成功',
    REVIEW_NOT_ACCEPTED: '审查尚未通过', PROTOCOL_NOT_TERMINAL: '协作协议尚未到达终局',
    DEPENDENCIES_NOT_SATISFIED: '依赖步骤尚未满足', REQUIRED_ARTIFACTS_MISSING: '必要产物缺失',
    SUCCESSOR_OBLIGATIONS_NOT_SATISFIED: '仍有必需的后继义务未满足',
    REQUIRED_OBLIGATION_PENDING: '仍有必需义务等待完成',
    REQUIRED_OBLIGATION_FAILED: '必需义务已经失败，需要明确处置',
    REQUIRED_OBLIGATION_CANCELLED: '必需义务已经取消，需要明确处置',
    EXTERNAL_CONDITION_PENDING: '正在等待外部条件或人工决定',
    SUBJECT_NOT_ACTIVE: '工作项当前不能提交完成',
    RESPONSIBILITY_NOT_OWNED: '工作项当前没有有效持有者',
    RESPONSIBILITY_TRANSFER_PENDING: '责任正在转移',
    ATTEMPT_MISSING: '缺少可提交的执行尝试',
    ATTEMPT_NOT_COMMITTABLE: '执行尝试当前不可提交',
    ATTEMPT_LEASE_EXPIRED: '执行尝试租约已失效',
    ATTEMPT_GENERATION_STALE: '执行尝试责任代际已失效',
    ATTEMPT_AGENT_MISMATCH: '执行尝试与提交者不一致',
    CUSTODY_HOLDER_MISMATCH: '执行者与责任持有者不一致',
    PARTIAL_RESULT_HAS_NO_OUTPUT: '没有可供用户接受的部分结果',
  };
  if (fixed[reason]) return fixed[reason];
  const [code, key] = reason.split(':', 2);
  const subject: Record<string, string> = {
    MISSING_REQUIRED_SUBJECT: '缺少必需工作项', FAILED_REQUIRED_SUBJECT: '必需工作项失败', FAILED_SUBJECT: '工作项失败',
    SUBJECT_NOT_COMPLETED: '工作项尚未完成', INVALID_CUSTODY: '责任状态无效', MISSING_OUTPUT: '工作项缺少输出',
    INVALID_EVIDENCE: '工作项证据无效', OPEN_SUCCESSOR_OBLIGATION: '后继义务尚未完成',
  };
  return subject[code ?? ''] ? `${subject[code!]}${key ? `（${key}）` : ''}` : reason;
}
