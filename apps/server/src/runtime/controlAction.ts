import type {
  CollaborationStoredControlAction,
  LegacyCollaborationControlAction,
  RuntimeControlAction,
  RuntimeControlActionVersion,
  RuntimeRunContract,
  SupervisorTaskProposal,
} from '@agent-gand/shared';
import { get, run } from '../db/database.ts';

export type RuntimeActionSource = 'native_v2' | 'legacy_v1' | 'answer_candidate';

export type RuntimeActionNormalization =
  | { ok: true; action: RuntimeControlAction; storedAction: CollaborationStoredControlAction; source: RuntimeActionSource }
  | { ok: false; code: 'INVALID_CONTROL_ACTION' | 'ACTION_VERSION_MISMATCH'; reason: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function proposal(value: Record<string, unknown>): SupervisorTaskProposal | null {
  if (!nonEmpty(value.title) || !nonEmpty(value.goal) || !stringArray(value.acceptanceCriteria)
    || !stringArray(value.suggestedAssigneeIds) || !nonEmpty(value.reason)) return null;
  if (value.suggestedReviewerId !== undefined && !nonEmpty(value.suggestedReviewerId)) return null;
  return {
    title: value.title.trim(), goal: value.goal.trim(), acceptanceCriteria: value.acceptanceCriteria.map((item) => item.trim()),
    suggestedAssigneeIds: value.suggestedAssigneeIds.map((item) => item.trim()),
    ...(nonEmpty(value.suggestedReviewerId) ? { suggestedReviewerId: value.suggestedReviewerId.trim() } : {}),
    reason: value.reason.trim(),
  };
}

function normalizeV2(value: Record<string, unknown>): RuntimeControlAction | null {
  if (value.version !== 2 || !nonEmpty(value.type)) return null;
  if (value.type === 'complete') {
    if (value.summary !== undefined && !nonEmpty(value.summary)) return null;
    return { version: 2, type: 'complete', ...(nonEmpty(value.summary) ? { summary: value.summary.trim() } : {}) };
  }
  if (value.type === 'answer_candidate') return { version: 2, type: 'answer_candidate' };
  if (value.type === 'handoff') {
    if (!nonEmpty(value.targetAgentId) || !nonEmpty(value.objective) || !nonEmpty(value.reason)) return null;
    return { version: 2, type: 'handoff', targetAgentId: value.targetAgentId.trim(), objective: value.objective.trim(), reason: value.reason.trim() };
  }
  if (value.type === 'consult') {
    if (!stringArray(value.targetAgentIds) || !nonEmpty(value.objective) || !nonEmpty(value.reason)
      || (value.join !== 'all' && value.join !== 'any')) return null;
    return { version: 2, type: 'consult', targetAgentIds: [...new Set(value.targetAgentIds.map((item) => item.trim()))],
      objective: value.objective.trim(), reason: value.reason.trim(), join: value.join };
  }
  if (value.type === 'hold') {
    const wake = object(value.wake);
    if (!wake || wake.kind !== 'user_decision' || !nonEmpty(value.reason)) return null;
    if (wake.decisionKind === 'agent_question' && nonEmpty(wake.prompt)) {
      return { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'agent_question', prompt: wake.prompt.trim() }, reason: value.reason.trim() };
    }
    if (wake.decisionKind === 'supervisor_task_proposal') {
      const normalized = object(wake.proposal); const parsed = normalized ? proposal(normalized) : null;
      if (parsed) return { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'supervisor_task_proposal', proposal: parsed }, reason: value.reason.trim() };
    }
    return null;
  }
  if (value.type === 'cancel' && nonEmpty(value.reason)) return { version: 2, type: 'cancel', reason: value.reason.trim() };
  return null;
}

function normalizeLegacy(value: Record<string, unknown>): RuntimeControlAction | null {
  if (value.type === 'finish') return { version: 2, type: 'complete' };
  if (value.type === 'implicit_complete') return { version: 2, type: 'answer_candidate' };
  if (value.type === 'handoff' && nonEmpty(value.targetAgentId) && nonEmpty(value.message) && nonEmpty(value.reason)) {
    return { version: 2, type: 'handoff', targetAgentId: value.targetAgentId.trim(), objective: value.message.trim(), reason: value.reason.trim() };
  }
  if (value.type === 'ask_many' && stringArray(value.targetAgentIds) && nonEmpty(value.question) && nonEmpty(value.reason)) {
    return { version: 2, type: 'consult', targetAgentIds: [...new Set(value.targetAgentIds.map((item) => item.trim()))],
      objective: value.question.trim(), reason: value.reason.trim(), join: 'all' };
  }
  if (value.type === 'wait_user' && nonEmpty(value.question) && nonEmpty(value.reason)) {
    return { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'agent_question', prompt: value.question.trim() }, reason: value.reason.trim() };
  }
  if (value.type === 'propose_task') {
    const parsed = proposal(value);
    if (parsed) return { version: 2, type: 'hold', wake: { kind: 'user_decision', decisionKind: 'supervisor_task_proposal', proposal: parsed }, reason: parsed.reason };
  }
  return null;
}

/** 把数据库存量或模型动作归一化；未知动作永不降级为 complete。 */
export function normalizeRuntimeControlAction(
  value: unknown,
  options: { expectedVersion?: RuntimeControlActionVersion } = {},
): RuntimeActionNormalization {
  const parsed = object(value);
  if (!parsed) return { ok: false, code: 'INVALID_CONTROL_ACTION', reason: '控制动作必须是对象' };
  if (parsed.version === 2) {
    if (options.expectedVersion === 1) {
      return { ok: false, code: 'ACTION_VERSION_MISMATCH', reason: '历史 Run 只接受 v1 控制动作' };
    }
    const action = normalizeV2(parsed);
    return action
      ? { ok: true, action, storedAction: action, source: 'native_v2' }
      : { ok: false, code: 'INVALID_CONTROL_ACTION', reason: `v2 控制动作结构无效：${String(parsed.type ?? 'unknown')}` };
  }
  const action = normalizeLegacy(parsed);
  return action
    ? { ok: true, action, storedAction: parsed as LegacyCollaborationControlAction, source: parsed.type === 'implicit_complete' ? 'answer_candidate' : 'legacy_v1' }
    : { ok: false, code: 'INVALID_CONTROL_ACTION', reason: `未知或无效的 v1 控制动作：${String(parsed.type ?? 'unknown')}` };
}

export function answerCandidateControlAction(version: RuntimeControlActionVersion): RuntimeActionNormalization & { ok: true } {
  if (version === 1) {
    return { ok: true, action: { version: 2, type: 'answer_candidate' },
      storedAction: { type: 'implicit_complete' }, source: 'answer_candidate' };
  }
  const action: RuntimeControlAction = { version: 2, type: 'answer_candidate' };
  return { ok: true, action, storedAction: action, source: 'answer_candidate' };
}

/** 无冻结标记的历史 Run 固定解释为 v1；不受部署后默认值变化影响。 */
export function runtimeControlActionVersion(runId: string): RuntimeControlActionVersion {
  const row = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', runId);
  if (!row) return 1;
  try {
    return (JSON.parse(row.payload) as RuntimeRunContract).features?.controlActionVersion === 2 ? 2 : 1;
  } catch { return 1; }
}

/** 只插入不覆盖，确保 Run 入场时选定的动作版本永久冻结。 */
export function freezeRuntimeContract(contract: RuntimeRunContract): RuntimeRunContract {
  run('INSERT OR IGNORE INTO runtime_contracts (run_id,version,payload,created_at) VALUES (?,?,?,?)',
    contract.runId, contract.version, JSON.stringify(contract), new Date().toISOString());
  const frozen = get<{ payload: string }>('SELECT payload FROM runtime_contracts WHERE run_id=?', contract.runId);
  if (!frozen) throw new Error(`Run ${contract.runId} 的 Runtime Contract 冻结失败`);
  return JSON.parse(frozen.payload) as RuntimeRunContract;
}
