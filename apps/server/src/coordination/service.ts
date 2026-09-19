import type {
  AgentDefinition,
  CoordinationPlan,
  CoordinationPreview,
  CoordinationPreviewInput,
  CoordinationValidationIssue,
} from '@agent-gand/shared';
import { createCapabilitySnapshot } from './capabilities.ts';
import { buildCoordinationPlan } from './compiler.ts';
import { createCoordinationDraft } from './planner.ts';
import {
  activateCoordinationPlan,
  getCapabilitySnapshot,
  getCoordinationDraft,
  getDraftCoordinationPlan,
  savePlanningResult,
} from './store.ts';
import { validateCoordinationPlan } from './validator.ts';

export class CoordinationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function errorIssues(issues: CoordinationValidationIssue[]): CoordinationValidationIssue[] {
  return issues.filter((item) => item.severity === 'error');
}

export function previewCoordination(input: CoordinationPreviewInput): CoordinationPreview {
  if (!input.goal.trim()) throw new CoordinationError(400, 'goal 必填');
  if (input.agentIds.length === 0) throw new CoordinationError(400, 'agentIds 必须是非空数组');
  if (new Set(input.agentIds).size !== input.agentIds.length) throw new CoordinationError(400, 'agentIds 不能包含重复成员');
  const snapshot = createCapabilitySnapshot(input.agentIds);
  if (snapshot.agents.length !== input.agentIds.length) throw new CoordinationError(400, 'agentIds 包含未知或已停用成员');
  if (input.defaultReviewerId && !input.agentIds.includes(input.defaultReviewerId)) throw new CoordinationError(400, 'defaultReviewerId 必须属于当前团队');
  const draft = createCoordinationDraft(input, snapshot);
  const plan = buildCoordinationPlan(draft, snapshot);
  const planErrors = errorIssues(plan.validationIssues);
  if (planErrors.length > 0) {
    const existing = new Set(draft.validationIssues.map((item) => `${item.code}:${item.path ?? ''}`));
    for (const issue of planErrors) if (!existing.has(`${issue.code}:${issue.path ?? ''}`)) draft.validationIssues.push(issue);
    draft.validationErrors = [...new Set(draft.validationIssues.filter((item) => item.severity === 'error').map((item) => item.code))];
    draft.decision = 'unavailable';
    draft.platformConfidence = Math.max(0, draft.platformConfidence - planErrors.length * 0.08);
  }
  savePlanningResult(snapshot, draft, plan);
  return { snapshot, draft, plan };
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
