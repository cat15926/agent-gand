import type {
  CapabilitySnapshot,
  CoordinationDraft,
  CoordinationPlan,
  CoordinationPlanStep,
  CoordinationValidationIssue,
} from '@agent-gand/shared';

function issue(code: string, message: string, path: string | null = null, severity: 'error' | 'warning' = 'error'): CoordinationValidationIssue {
  return { code, message, path, severity };
}

function hasCycle(steps: CoordinationPlanStep[]): boolean {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const step = byId.get(id);
    if (step?.dependsOn.some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

export function validateCoordinationPlan(plan: CoordinationPlan, draft: CoordinationDraft, snapshot: CapabilitySnapshot): CoordinationValidationIssue[] {
  const issues: CoordinationValidationIssue[] = [];
  if (plan.capabilitySnapshotId !== snapshot.id || draft.capabilitySnapshotId !== snapshot.id) {
    issues.push(issue('CAPABILITY_SNAPSHOT_MISMATCH', '草案、计划和能力快照不一致', 'capabilitySnapshotId'));
  }
  if (plan.protocols.length === 0) issues.push(issue('PROTOCOL_REQUIRED', '计划至少需要一个协议', 'protocols'));
  for (const selected of plan.protocols) {
    const definition = snapshot.protocols.find((item) => item.id === selected.protocol && item.version === selected.version);
    if (!definition) issues.push(issue('PROTOCOL_VERSION_NOT_IN_SNAPSHOT', `能力快照中不存在 ${selected.protocol}@${selected.version}`, 'protocols'));
  }
  if (plan.steps.length === 0) issues.push(issue('PLAN_STEPS_REQUIRED', '计划至少需要一个步骤', 'steps'));
  if (plan.steps.length > snapshot.policy.maximumSteps || plan.steps.length > plan.budget.maximumSteps) {
    issues.push(issue('PLAN_STEP_BUDGET_EXCEEDED', '计划步骤数超过预算', 'steps'));
  }
  const hardMaximumSteps = draft.taskBrief.hardConstraints.maximumSteps;
  if (typeof hardMaximumSteps === 'number' && plan.steps.length > hardMaximumSteps) {
    issues.push(issue('HARD_STEP_LIMIT_EXCEEDED', `计划包含 ${plan.steps.length} 个步骤，超过用户限制 ${hardMaximumSteps}`, 'steps'));
  }
  const ids = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    const path = `steps.${index}`;
    if (ids.has(step.id)) issues.push(issue('DUPLICATE_STEP_ID', `步骤 ID 重复：${step.id}`, `${path}.id`));
    ids.add(step.id);
    if (step.maxAttempts < 1 || step.maxAttempts > snapshot.policy.maximumAttemptsPerStep || step.maxAttempts > plan.budget.maximumAttemptsPerStep) {
      issues.push(issue('STEP_ATTEMPT_BUDGET_INVALID', `步骤 ${step.id} 的最大尝试次数无效`, `${path}.maxAttempts`));
    }
    if (step.tokenBudget < 1 || step.tokenBudget > snapshot.policy.maximumTokensPerStep || step.tokenBudget > plan.budget.maximumTokensPerStep) {
      issues.push(issue('STEP_TOKEN_BUDGET_INVALID', `步骤 ${step.id} 的 Token 预算无效`, `${path}.tokenBudget`));
    }
    if (step.type !== 'completion_gate') {
      const agent = step.agentId ? snapshot.agents.find((item) => item.id === step.agentId && item.enabled) : undefined;
      if (!agent) issues.push(issue('ACTOR_NOT_IN_SNAPSHOT', `步骤 ${step.id} 未绑定快照内的可用 Agent`, `${path}.agentId`));
      else {
        if (!agent.capabilities.includes(step.actorCapability)) issues.push(issue('AGENT_CAPABILITY_MISSING', `${agent.id} 不具备 ${step.actorCapability} 能力`, `${path}.actorCapability`));
        for (const toolName of step.toolPolicy.allowedTools) {
          const tool = snapshot.tools.find((item) => item.name === toolName);
          if (!tool || !agent.tools.includes(toolName)) issues.push(issue('TOOL_NOT_AVAILABLE_TO_ACTOR', `${agent.id} 不可使用工具 ${toolName}`, `${path}.toolPolicy.allowedTools`));
          if (tool && !tool.readonly && snapshot.policy.externalWritesRequireApproval && !step.toolPolicy.requiresApproval) issues.push(issue('TOOL_APPROVAL_REQUIRED', `${toolName} 需要审批点`, `${path}.toolPolicy.requiresApproval`));
        }
      }
    }
  }
  for (const [index, step] of plan.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) issues.push(issue('STEP_DEPENDENCY_NOT_FOUND', `步骤 ${step.id} 引用了不存在的依赖 ${dependency}`, `steps.${index}.dependsOn`));
      if (dependency === step.id) issues.push(issue('STEP_SELF_DEPENDENCY', `步骤 ${step.id} 不能依赖自身`, `steps.${index}.dependsOn`));
    }
  }
  if (hasCycle(plan.steps)) issues.push(issue('PLAN_DAG_CYCLE', '计划步骤依赖存在环', 'steps'));

  const successors = new Map<string, number>();
  for (const step of plan.steps) for (const dependency of step.dependsOn) successors.set(dependency, (successors.get(dependency) ?? 0) + 1);
  for (const id of plan.completion.requiredSteps) if (!ids.has(id)) issues.push(issue('COMPLETION_STEP_NOT_FOUND', `完成条件引用了不存在的步骤 ${id}`, 'completion.requiredSteps'));
  for (const id of plan.completion.terminalSteps) {
    if (!ids.has(id)) issues.push(issue('TERMINAL_STEP_NOT_FOUND', `终局引用了不存在的步骤 ${id}`, 'completion.terminalSteps'));
    else if ((successors.get(id) ?? 0) > 0) issues.push(issue('TERMINAL_STEP_HAS_SUCCESSOR', `终局步骤 ${id} 仍有后继步骤`, 'completion.terminalSteps'));
  }
  if (plan.completion.terminalSteps.length === 0) issues.push(issue('TERMINAL_STEP_REQUIRED', '计划必须声明终局步骤', 'completion.terminalSteps'));

  const bindings = new Map(plan.hardConstraintBindings.map((binding) => [binding.constraint, binding]));
  for (const constraint of Object.keys(draft.taskBrief.hardConstraints)) {
    const binding = bindings.get(constraint);
    if (!binding || binding.planPaths.length === 0) issues.push(issue('HARD_CONSTRAINT_DROPPED', `硬约束 ${constraint} 未映射到计划`, 'hardConstraintBindings'));
  }
  const expectedParticipants = draft.taskBrief.hardConstraints.participantIds;
  if (Array.isArray(expectedParticipants)) {
    const boundAgents = new Set(Object.values(plan.actorBindings));
    if (expectedParticipants.some((agentId) => !boundAgents.has(agentId))) issues.push(issue('HARD_CONSTRAINT_DROPPED', '计划没有保留全部用户指定参与者', 'actorBindings'));
  }

  if (snapshot.policy.reviewerIsolationRequired) {
    for (const [index, step] of plan.steps.entries()) {
      if (step.type !== 'review' || !step.agentId) continue;
      const targets = Array.isArray(step.metadata.reviewTargetStepIds) ? step.metadata.reviewTargetStepIds : step.dependsOn;
      for (const targetId of targets) {
        const target = plan.steps.find((item) => item.id === targetId);
        if (target?.agentId === step.agentId) issues.push(issue('REVIEWER_ISOLATION_VIOLATION', `Reviewer ${step.agentId} 不能评审自己的步骤 ${targetId}`, `steps.${index}.agentId`));
      }
    }
  }
  return issues;
}
