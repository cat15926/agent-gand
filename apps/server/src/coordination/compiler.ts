import { randomUUID } from 'node:crypto';
import type {
  CapabilitySnapshot,
  CoordinationDraft,
  CoordinationPlan,
  CoordinationPlanStep,
  CoordinationProtocolId,
} from '@agent-gand/shared';
import { validateCoordinationPlan } from './validator.ts';

interface BuildState {
  steps: CoordinationPlanStep[];
  actorBindings: Record<string, string>;
  tail: string[];
}

function actorTools(agentId: string | null, snapshot: CapabilitySnapshot): CoordinationPlanStep['toolPolicy'] {
  const agent = agentId ? snapshot.agents.find((item) => item.id === agentId) : undefined;
  const allowedTools = agent?.tools.filter((name) => snapshot.tools.some((tool) => tool.name === name)) ?? [];
  return {
    allowedTools,
    requiresApproval: allowedTools.some((name) => snapshot.tools.some((tool) => tool.name === name && !tool.readonly && tool.requiresApproval)),
  };
}

function makeStep(
  snapshot: CapabilitySnapshot,
  protocol: CoordinationProtocolId,
  id: string,
  type: CoordinationPlanStep['type'],
  actorRole: string,
  capability: CoordinationPlanStep['actorCapability'],
  agentId: string | null,
  dependsOn: string[],
  completion: string,
  options: Partial<Pick<CoordinationPlanStep, 'maxAttempts' | 'onFailure' | 'metadata'>> = {},
): CoordinationPlanStep {
  return {
    id, protocol, type, actorRole, actorCapability: capability, agentId, dependsOn, completion,
    maxAttempts: options.maxAttempts ?? 1,
    tokenBudget: Math.min(4_000, snapshot.policy.maximumTokensPerStep),
    timeoutMs: 300_000,
    onFailure: options.onFailure ?? 'fail_plan',
    toolPolicy: actorTools(agentId, snapshot),
    metadata: options.metadata ?? {},
  };
}

function bind(state: BuildState, role: string, agentId: string | undefined): string | null {
  if (!agentId) return null;
  state.actorBindings[role] = agentId;
  return agentId;
}

function compileSingle(state: BuildState, snapshot: CapabilitySnapshot): void {
  const worker = snapshot.agents.find((agent) => agent.capabilities.includes('execute'));
  const id = 'single-response';
  state.steps.push(makeStep(snapshot, 'single_agent', id, 'agent_turn', 'worker', 'execute', bind(state, 'worker', worker?.id), state.tail, '结果已提交'));
  state.tail = [id];
}

function compileParallel(state: BuildState, snapshot: CapabilitySnapshot): void {
  const workers = snapshot.agents.filter((agent) => agent.capabilities.includes('execute'));
  const branchIds: string[] = [];
  for (const [index, worker] of workers.entries()) {
    const role = `worker-${index + 1}`;
    const id = `parallel-branch-${index + 1}`;
    branchIds.push(id);
    state.steps.push(makeStep(snapshot, 'parallel_fanout', id, 'fanout', role, 'execute', bind(state, role, worker.id), [...state.tail], '独立分支产物已提交', { metadata: { independent: true } }));
  }
  const coordinator = snapshot.agents.find((agent) => agent.capabilities.includes('coordinate')) ?? workers[0];
  const aggregateId = 'parallel-aggregate';
  state.steps.push(makeStep(snapshot, 'parallel_fanout', aggregateId, 'aggregate', 'aggregator', coordinator?.capabilities.includes('coordinate') ? 'coordinate' : 'execute', bind(state, 'aggregator', coordinator?.id), branchIds, '所有必需分支已形成统一结果'));
  state.tail = [aggregateId];
}

function compileReview(state: BuildState, snapshot: CapabilitySnapshot, standalone: boolean): void {
  const reviewerId = snapshot.agents.find((agent) => agent.id === state.actorBindings.reviewer && agent.capabilities.includes('review'))?.id
    ?? snapshot.agents.find((agent) => agent.capabilities.includes('review'))?.id;
  const implementer = snapshot.agents.find((agent) => agent.id !== reviewerId && agent.capabilities.includes('execute'));
  if (standalone) {
    const implementId = 'review-implement';
    state.steps.push(makeStep(snapshot, 'review_revision', implementId, 'agent_turn', 'implementer', 'execute', bind(state, 'implementer', implementer?.id), state.tail, '实现产物已提交', { maxAttempts: 3, onFailure: 'retry' }));
    state.tail = [implementId];
  } else if (implementer) {
    bind(state, 'implementer', implementer.id);
  }
  const reviewId = 'review-independent';
  state.steps.push(makeStep(snapshot, 'review_revision', reviewId, 'review', 'reviewer', 'review', bind(state, 'reviewer', reviewerId), [...state.tail], 'Reviewer 通过或提出结构化返工问题', {
    maxAttempts: 3,
    onFailure: 'retry_dependencies',
    metadata: { reviewTargetStepIds: [...state.tail], independent: true },
  }));
  state.tail = [reviewId];
}

function compileDebate(state: BuildState, draft: CoordinationDraft, snapshot: CapabilitySnapshot): void {
  const reviewerId = draft.taskBrief.reviewerId ?? snapshot.agents.find((agent) => agent.capabilities.includes('review'))?.id;
  const debaters = snapshot.agents.filter((agent) => agent.id !== reviewerId && agent.capabilities.includes('execute')).slice(0, 2);
  const pro = bind(state, 'pro', debaters[0]?.id);
  const con = bind(state, 'con', debaters[1]?.id);
  const judge = bind(state, 'judge', reviewerId);
  const roundsValue = draft.taskBrief.hardConstraints.rounds ?? draft.taskBrief.inferredConstraints.rounds ?? 3;
  // 无效输入仍会由 Validator 拒绝；编译器先夹紧，避免异常轮次数造成无界步骤展开。
  const rounds = Math.max(1, Math.min(10, typeof roundsValue === 'number' && Number.isFinite(roundsValue) ? Math.trunc(roundsValue) : 3));
  let tail = [...state.tail];
  const allDebateSteps: string[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const proId = `debate-r${round}-pro`;
    state.steps.push(makeStep(snapshot, 'debate', proId, 'agent_turn', 'pro', 'execute', pro, tail, `正方第 ${round} 轮发言已冻结`, { metadata: { round, position: 'pro', positionsFixed: true, independent: true } }));
    const conId = `debate-r${round}-con`;
    state.steps.push(makeStep(snapshot, 'debate', conId, 'agent_turn', 'con', 'execute', con, [proId], `反方第 ${round} 轮发言已冻结`, { metadata: { round, position: 'con', positionsFixed: true, independent: true } }));
    allDebateSteps.push(proId, conId);
    tail = [conId];
  }
  const judgeId = 'debate-judge';
  state.steps.push(makeStep(snapshot, 'debate', judgeId, 'review', 'judge', 'review', judge, allDebateSteps, '独立裁判已在全部发言冻结后裁决', {
    metadata: { reviewTargetStepIds: allDebateSteps, independent: true, afterAllRounds: true },
  }));
  state.tail = [judgeId];
}

function compileSequential(state: BuildState, snapshot: CapabilitySnapshot): void {
  for (const [index, agent] of snapshot.agents.entries()) {
    const role = `stage-${index + 1}`;
    const id = `pipeline-stage-${index + 1}`;
    const capability = agent.capabilities.includes('execute') ? 'execute' : agent.capabilities[0] ?? 'execute';
    state.steps.push(makeStep(snapshot, 'sequential_pipeline', id, 'agent_turn', role, capability, bind(state, role, agent.id), [...state.tail], '本阶段产物已提交'));
    state.tail = [id];
  }
}

function compileSupervisor(state: BuildState, snapshot: CapabilitySnapshot): void {
  const supervisor = snapshot.agents.find((agent) => agent.capabilities.includes('coordinate'));
  const worker = snapshot.agents.find((agent) => agent.capabilities.includes('execute'));
  const planId = 'supervisor-plan';
  state.steps.push(makeStep(snapshot, 'supervisor_dag', planId, 'agent_turn', 'supervisor', 'coordinate', bind(state, 'supervisor', supervisor?.id), [...state.tail], '任务 DAG 已拆解'));
  const workId = 'supervisor-execute';
  state.steps.push(makeStep(snapshot, 'supervisor_dag', workId, 'agent_turn', 'worker', 'execute', bind(state, 'worker', worker?.id), [planId], '执行产物已提交'));
  state.tail = [workId];
}

function compileFallback(state: BuildState, snapshot: CapabilitySnapshot, protocol: CoordinationProtocolId): void {
  const agent = snapshot.agents.find((item) => item.capabilities.includes('execute')) ?? snapshot.agents[0];
  const id = `${protocol}-response`;
  const capability = agent?.capabilities.includes('execute') ? 'execute' : agent?.capabilities[0] ?? 'execute';
  state.steps.push(makeStep(snapshot, protocol, id, 'agent_turn', 'participant', capability, bind(state, 'participant', agent?.id), [...state.tail], '协议结果已提交'));
  state.tail = [id];
}

export function buildCoordinationPlan(draft: CoordinationDraft, snapshot: CapabilitySnapshot): CoordinationPlan {
  const state: BuildState = {
    steps: [],
    actorBindings: Object.fromEntries(snapshot.agents.map((agent, index) => [`team-${index + 1}`, agent.id])),
    tail: [],
  };
  for (const selected of draft.protocols) {
    switch (selected.protocol) {
      case 'single_agent': compileSingle(state, snapshot); break;
      case 'parallel_fanout': compileParallel(state, snapshot); break;
      case 'review_revision': compileReview(state, snapshot, state.tail.length === 0); break;
      case 'debate': compileDebate(state, draft, snapshot); break;
      case 'sequential_pipeline': compileSequential(state, snapshot); break;
      case 'supervisor_dag': compileSupervisor(state, snapshot); break;
      case 'supervisor_aggregation':
        if (state.tail.length === 0) compileParallel(state, snapshot);
        break;
      default: compileFallback(state, snapshot, selected.protocol); break;
    }
  }
  const completionId = 'complete';
  const completionProtocol = draft.protocols.at(-1)?.protocol ?? 'dynamic_collaboration';
  state.steps.push(makeStep(snapshot, completionProtocol, completionId, 'completion_gate', 'completion', 'coordinate', null, [...state.tail], '所有必需步骤和终局条件满足'));
  const hardConstraintBindings = Object.entries(draft.taskBrief.hardConstraints).map(([constraint, value]) => {
    const planPaths = constraint === 'rounds' ? state.steps.filter((step) => step.protocol === 'debate' && step.type === 'agent_turn').map((step) => `steps.${step.id}`)
      : constraint === 'reviewAfterCompletion' ? state.steps.filter((step) => step.type === 'review').map((step) => `steps.${step.id}`)
        : constraint === 'positionsFixed' ? state.steps.filter((step) => step.protocol === 'debate').map((step) => `steps.${step.id}.metadata.positionsFixed`)
          : constraint === 'maximumSteps' ? ['budget.maximumSteps'] : ['actorBindings'];
    return { constraint, value, planPaths };
  });
  const now = new Date().toISOString();
  const hardMaximum = draft.taskBrief.hardConstraints.maximumSteps;
  const plan: CoordinationPlan = {
    id: randomUUID(), runId: null, draftId: draft.id, capabilitySnapshotId: snapshot.id, revision: 1, status: 'draft',
    protocols: draft.protocols, runtimeMode: draft.runtimeMode, actorBindings: state.actorBindings, hardConstraintBindings,
    steps: state.steps, completion: { requiredSteps: state.steps.map((step) => step.id), terminalSteps: [completionId] },
    budget: {
      maximumSteps: typeof hardMaximum === 'number' ? Math.min(hardMaximum, snapshot.policy.maximumSteps) : snapshot.policy.maximumSteps,
      maximumAttemptsPerStep: snapshot.policy.maximumAttemptsPerStep,
      maximumTokensPerStep: snapshot.policy.maximumTokensPerStep,
    },
    validationIssues: [], createdAt: now, updatedAt: now,
  };
  plan.validationIssues = validateCoordinationPlan(plan, draft, snapshot);
  return plan;
}
