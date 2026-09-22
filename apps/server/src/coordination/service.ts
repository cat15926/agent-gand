import type {
  AgentDefinition,
  CoordinationDraft,
  CoordinationPlan,
  CoordinationPreview,
  CoordinationPreviewInput,
  CoordinationRevisionInput,
  CoordinationValidationIssue,
} from '@agent-gand/shared';
import { createCapabilitySnapshot } from './capabilities.ts';
import { buildCoordinationPlan } from './compiler.ts';
import { createCoordinationDraft, normalizeTask, participantNotices } from './planner.ts';
import { planCoordinationWithModel } from './modelPlanner.ts';
import {
  activateCoordinationPlan,
  applyCoordinationPlanRevision,
  getCapabilitySnapshot,
  getCoordinationDraft,
  getDraftCoordinationPlan,
  getRunCoordinationPlan,
  savePlanningResult,
} from './store.ts';
import { validateCoordinationPlan } from './validator.ts';
import { getCoordinationCalibration, recordPlannerFeedback } from './calibration.ts';
import { saveCheckpoint } from '../runs/checkpoints.ts';

export class CoordinationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function errorIssues(issues: CoordinationValidationIssue[]): CoordinationValidationIssue[] {
  return issues.filter((item) => item.severity === 'error');
}

export async function prepareCoordination(input: CoordinationPreviewInput): Promise<CoordinationPreview> {
  if (!input.goal.trim()) throw new CoordinationError(400, 'goal 必填');
  if (input.agentIds.length === 0) throw new CoordinationError(400, 'agentIds 必须是非空数组');
  if (new Set(input.agentIds).size !== input.agentIds.length) throw new CoordinationError(400, 'agentIds 不能包含重复成员');
  const snapshot = createCapabilitySnapshot(input.agentIds);
  if (snapshot.agents.length !== input.agentIds.length) throw new CoordinationError(400, 'agentIds 包含未知或已停用成员');
  if (input.defaultReviewerId && !input.agentIds.includes(input.defaultReviewerId)) throw new CoordinationError(400, 'defaultReviewerId 必须属于当前团队');
  const modelResult = input.requestedProtocol || input.deterministicOnly
    ? { proposal: null, model: null, attempts: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fallbackReason: null }
    : await planCoordinationWithModel(normalizeTask(input, snapshot), snapshot);
  const planning: CoordinationDraft['planning'] = {
    source: modelResult.proposal ? (modelResult.attempts > 1 ? 'model_repaired' : 'model')
      : modelResult.fallbackReason ? 'deterministic_fallback' : 'deterministic',
    model: modelResult.model,
    attempts: modelResult.attempts,
    tokensIn: modelResult.tokensIn,
    tokensOut: modelResult.tokensOut,
    costUsd: modelResult.costUsd,
    fallbackReason: modelResult.fallbackReason,
  };
  const draft = createCoordinationDraft(input, snapshot, modelResult.proposal, planning, getCoordinationCalibration().threshold);
  const plan = buildCoordinationPlan(draft, snapshot);
  const planErrors = errorIssues(plan.validationIssues);
  if (planErrors.length > 0) {
    const existing = new Set(draft.validationIssues.map((item) => `${item.code}:${item.path ?? ''}`));
    for (const issue of planErrors) if (!existing.has(`${issue.code}:${issue.path ?? ''}`)) draft.validationIssues.push(issue);
    draft.validationErrors = [...new Set(draft.validationIssues.filter((item) => item.severity === 'error').map((item) => item.code))];
    draft.decision = 'unavailable';
    draft.platformConfidence = Math.max(0, draft.platformConfidence - planErrors.length * 0.08);
  }
  // AG-COORD-07：参与者指称与所选团队不一致时在计划卡显著提示，不做静默替换
  const notices = participantNotices(input.goal, snapshot);
  if (draft.planning.source === 'deterministic_fallback') notices.push('智能规划模型本次不可用或候选未通过校验，已安全回退到确定性规划。');
  return notices.length > 0 ? { snapshot, draft, plan, notices } : { snapshot, draft, plan };
}

export async function previewCoordination(input: CoordinationPreviewInput): Promise<CoordinationPreview> {
  const result = await prepareCoordination(input);
  savePlanningResult(result.snapshot, result.draft, result.plan);
  if (input.replacesDraftId) {
    const original = getCoordinationDraft(input.replacesDraftId);
    if (original) {
      const originalProtocols = original.protocols.map((item) => `${item.protocol}@${item.version}`);
      const chosenProtocols = result.draft.protocols.map((item) => `${item.protocol}@${item.version}`);
      recordPlannerFeedback({
        originalDraftId: original.id,
        chosenProtocols: result.draft.protocols,
        originalConfidence: original.platformConfidence,
        corrected: originalProtocols.join(',') !== chosenProtocols.join(','),
        source: 'alternative_selected',
      });
    }
  }
  return result;
}

export function compileCoordinationPlan(draftId: string, runId: string, goal: string, agents: AgentDefinition[]): CoordinationPlan {
  const draft = getCoordinationDraft(draftId);
  if (!draft) throw new CoordinationError(404, `Coordination Draft 不存在: ${draftId}`);
  const snapshot = getCapabilitySnapshot(draft.capabilitySnapshotId);
  if (!snapshot) throw new CoordinationError(409, '能力快照不存在，无法安全启动计划');
  const plan = getDraftCoordinationPlan(draftId);
  if (!plan) throw new CoordinationError(409, '草案没有已编译的 Coordination Plan');
  if (draft.validationErrors.length > 0 || errorIssues(plan.validationIssues).length > 0) {
    const codes = [...new Set([...draft.validationErrors, ...errorIssues(plan.validationIssues).map((item) => item.code)])];
    throw new CoordinationError(409, `当前方案未通过校验: ${codes.join(', ')}`);
  }
  if (!draft.runtimeMode || !plan.runtimeMode) throw new CoordinationError(409, '当前协议尚未接入统一协调运行时');
  if (draft.taskBrief.objective !== goal.trim()) throw new CoordinationError(409, '任务内容与规划预览不一致，请重新生成建议');
  const expected = new Set(draft.taskBrief.participantIds);
  if (agents.length !== expected.size || agents.some((agent) => !expected.has(agent.id))) throw new CoordinationError(409, '聊天室成员与规划预览不一致，请重新生成建议');
  for (const agent of agents) {
    const captured = snapshot.agents.find((item) => item.id === agent.id);
    if (!captured || captured.version !== agent.version || !agent.enabled) throw new CoordinationError(409, `成员 ${agent.id} 的能力版本已变化，请重新生成建议`);
  }
  const freshIssues = validateCoordinationPlan(plan, draft, snapshot);
  if (errorIssues(freshIssues).length > 0) throw new CoordinationError(409, `计划重新校验失败: ${errorIssues(freshIssues).map((item) => item.code).join(', ')}`);
  const activated = activateCoordinationPlan(plan.id, runId);
  if (!activated) throw new CoordinationError(409, '该 Coordination Plan 已启动或状态已变化');
  return activated;
}

export async function reviseCoordinationPlan(runId: string, input: CoordinationRevisionInput): Promise<{ plan: CoordinationPlan; draft: CoordinationDraft }> {
  const instruction = input.instruction.trim();
  if (!instruction) throw new CoordinationError(400, 'instruction 必填');
  const current = getRunCoordinationPlan(runId);
  if (!current) throw new CoordinationError(404, '该 Run 没有关联 Coordination Plan');
  if (current.status !== 'paused') throw new CoordinationError(409, '只有已暂停的 Coordination Plan 可以调整');
  const originalDraft = getCoordinationDraft(current.draftId);
  const originalSnapshot = getCapabilitySnapshot(current.capabilitySnapshotId);
  if (!originalDraft || !originalSnapshot) throw new CoordinationError(409, '当前计划缺少 Draft 或能力快照');
  const goal = `用户最新调整要求：${instruction}\n\n原始目标：${originalDraft.taskBrief.objective}`;
  const prepared = await prepareCoordination({
    goal,
    agentIds: originalSnapshot.agents.map((agent) => agent.id),
    ...(originalDraft.taskBrief.reviewerId ? { defaultReviewerId: originalDraft.taskBrief.reviewerId } : {}),
    ...(input.requestedProtocol ? { requestedProtocol: input.requestedProtocol } : {}),
  });
  const errors = [...prepared.draft.validationErrors, ...prepared.plan.validationIssues.filter((item) => item.severity === 'error').map((item) => item.code)];
  if (errors.length > 0 || !prepared.plan.runtimeMode) throw new CoordinationError(409, `调整后的计划不可执行: ${[...new Set(errors)].join(', ') || 'RUNTIME_UNAVAILABLE'}`);
  let revised: CoordinationPlan;
  try {
    revised = applyCoordinationPlanRevision({ current, snapshot: prepared.snapshot, draft: prepared.draft, candidate: prepared.plan, instruction });
  } catch (error) {
    throw new CoordinationError(409, error instanceof Error ? error.message : String(error));
  }
  recordPlannerFeedback({
    originalDraftId: originalDraft.id,
    chosenProtocols: revised.protocols,
    originalConfidence: originalDraft.platformConfidence,
    corrected: originalDraft.protocols.map((item) => item.protocol).join(',') !== revised.protocols.map((item) => item.protocol).join(','),
    source: 'plan_revision',
  });
  saveCheckpoint({ runId, kind: 'coordination', phase: 'waiting_for_user', status: 'waiting', state: { planId: revised.id, revision: revised.revision, contextGoal: goal, reason: 'plan_revised' } });
  return { plan: revised, draft: prepared.draft };
}
