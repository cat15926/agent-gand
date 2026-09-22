import { randomUUID } from 'node:crypto';
import type {
  CapabilitySnapshot,
  CoordinationAlternative,
  CoordinationDraft,
  CoordinationPreviewInput,
  CoordinationProtocolId,
  CoordinationProtocolSelection,
  CoordinationRisk,
  CoordinationValidationIssue,
  RunMode,
  TaskBrief,
} from '@agent-gand/shared';
import { config } from '../config.ts';
import * as registry from '../agents/registry.ts';
import type { CoordinationModelProposal } from './modelPlanner.ts';
import { validateProtocolComposition } from './protocols.ts';

const includes = (text: string, pattern: RegExp): boolean => pattern.test(text);

function extractRounds(goal: string): number | null {
  const match = goal.match(/(?:限制|进行|共|开展)?\s*(\d+)\s*轮/u);
  return match?.[1] ? Number(match[1]) : null;
}

function extractMaximumSteps(goal: string): number | null {
  const match = goal.match(/(?:不超过|最多|限制)\s*(\d+)\s*(?:个)?步骤/u);
  return match?.[1] ? Number(match[1]) : null;
}

function riskOf(goal: string): CoordinationRisk {
  if (includes(goal, /(?:部署|发布|上线|删除|清空|付款|购买|推送到远程|发送给客户)/iu)) return 'high';
  if (includes(goal, /(?:修改|实现|修复|写入|创建|提交|上传)/iu)) return 'medium';
  return 'low';
}

function isDebate(goal: string): boolean {
  return includes(goal, /(?:辩论|正方.{0,20}反方|观点交锋)/u);
}

export function normalizeTask(input: CoordinationPreviewInput, snapshot: CapabilitySnapshot): TaskBrief {
  const goal = input.goal.trim();
  const rounds = extractRounds(goal);
  const maximumSteps = extractMaximumSteps(goal);
  const debate = isDebate(goal);
  const reviewer = input.defaultReviewerId
    ?? snapshot.agents.find((agent) => agent.capabilities.includes('review'))?.id
    ?? null;
  const hardConstraints: TaskBrief['hardConstraints'] = { participantIds: [...input.agentIds] };
  const inferredConstraints: TaskBrief['inferredConstraints'] = {};
  const constraintEvidence: TaskBrief['constraintEvidence'] = [
    { constraint: 'participantIds', source: 'team_selection', value: [...input.agentIds], excerpt: '用户当前选择的团队成员' },
  ];
  if (rounds !== null) {
    hardConstraints.rounds = rounds;
    constraintEvidence.push({ constraint: 'rounds', source: 'user_input', value: rounds, excerpt: `${rounds}轮` });
  } else if (debate) {
    inferredConstraints.rounds = 3;
    constraintEvidence.push({ constraint: 'rounds', source: 'platform_default', value: 3, excerpt: '辩论默认三轮' });
  }
  if (maximumSteps !== null) {
    hardConstraints.maximumSteps = maximumSteps;
    constraintEvidence.push({ constraint: 'maximumSteps', source: 'user_input', value: maximumSteps, excerpt: `最多${maximumSteps}步骤` });
  }
  // 末位审查硬约束：必须"成员词 + 审查/裁决类动词"同现（真机会话 31ec5657 seq30 实证：
  // "最后由 @reviewer 进行汇总"是点名聚合而非终审——仅"最后+reviewer"同现会误设约束，
  // 导致 parallel 编译因无 review 步骤被 HARD_CONSTRAINT_DROPPED 拒绝）
  if (includes(goal, /(?:最后|最终).{0,16}(?:reviewer|评审员?|裁判).{0,8}(?:裁决|审查|评审|裁定|判定|裁判|结论)/iu)) {
    hardConstraints.reviewAfterCompletion = true;
    constraintEvidence.push({ constraint: 'reviewAfterCompletion', source: 'user_input', value: true, excerpt: '最终由评审或裁判检查' });
  }
  if (includes(goal, /(?:正方|反方|固定立场)/u)) {
    hardConstraints.positionsFixed = true;
    constraintEvidence.push({ constraint: 'positionsFixed', source: 'user_input', value: true, excerpt: '正反方或固定立场' });
  } else if (debate) {
    inferredConstraints.positionsFixed = true;
  }
  if (reviewer) inferredConstraints.reviewerIsolation = true;
  const qualityRequirements: string[] = [];
  if (includes(goal, /(?:审查|评审|review)/iu)) qualityRequirements.push('结果必须经过独立检查');
  if (includes(goal, /(?:证据|事实|引用|来源)/u)) qualityRequirements.push('事实结论需要关联证据');
  return {
    objective: goal,
    deliverable: includes(goal, /(?:报告|方案|文档)/u) ? '结构化文档' : includes(goal, /(?:实现|修复|代码)/u) ? '可验证的实现结果' : null,
    participantIds: [...input.agentIds], reviewerId: reviewer, hardConstraints, inferredConstraints, constraintEvidence,
    qualityRequirements, risk: riskOf(goal), missingInformation: [],
  };
}

export function selectDeterministicProtocols(goal: string, agentCount: number, requested?: CoordinationProtocolId): CoordinationProtocolId[] {
  if (requested) return [requested];
  if (isDebate(goal)) return ['debate'];
  const review = includes(goal, /(?:审查|评审|reviewer|review)/iu);
  const revise = includes(goal, /(?:返工|修改|修复|直到通过|有问题.{0,12}(?:改|修))/u);
  const parallel = includes(goal, /(?:分别|各自|并行|独立分析|多(?:人|个).{0,8}(?:分析|方案))/u);
  const aggregate = includes(goal, /(?:汇总|总结|整合|统一结论)/u);
  const implementation = includes(goal, /(?:实现|开发|编码|修复|代码)/u);
  if (parallel && aggregate && review && implementation) return ['parallel_fanout', 'supervisor_aggregation', 'review_revision'];
  if (review && (revise || implementation)) return ['review_revision'];
  if (includes(goal, /(?:投票|表决|票选)/u)) return ['vote'];
  if (includes(goal, /(?:达成共识|共同结论|形成共识)/u)) return ['consensus'];
  if (includes(goal, /(?:主管|委派|拆解任务|依赖关系|任务分解)/u)) return ['supervisor_dag'];
  if (parallel) return aggregate ? ['parallel_fanout', 'supervisor_aggregation'] : ['parallel_fanout'];
  if (includes(goal, /(?:先.{1,30}再|然后|依次|按顺序|流水线)/u)) return ['sequential_pipeline'];
  if (includes(goal, /(?:自由讨论|自由协作|开放探索)/u)) return ['dynamic_collaboration'];
  return agentCount === 1 ? ['single_agent'] : ['dynamic_collaboration'];
}

/**
 * 追问路由判定（docs/plans/followup-routing-plan.md）：消息是否指向结构化协作任务。
 * 只有明确命中协议关键词才算结构化（辩论/审查/并行/投票/共识/主管/顺序…）；
 * single_agent 与 dynamic_collaboration（一般对话/开放交流）都算"简单"——
 * 误判成本不对称：误轻可 @ 升级补救，误重要白等一整轮编排。
 */
export function isStructuredFollowupGoal(goal: string): boolean {
  const selected = selectDeterministicProtocols(goal, 2); // agentCount=2 避免单人房间误判 single_agent
  return selected.some((id) => id !== 'single_agent' && id !== 'dynamic_collaboration');
}

function runtimeFor(protocols: CoordinationProtocolId[], snapshot: CapabilitySnapshot): RunMode | null {
  const coordinationNative = new Set<CoordinationProtocolId>(['single_agent', 'parallel_fanout', 'supervisor_aggregation', 'review_revision', 'debate']);
  if (protocols.length > 0 && protocols.every((id) => coordinationNative.has(id))) {
    // Run.mode 仅作为聊天室兼容载体；Dispatcher 会按已绑定 Plan 路由到 Coordination Runtime。
    return protocols.length === 1 && protocols[0] === 'single_agent' ? 'collaboration' : 'pipeline';
  }
  const definitions = protocols.map((id) => snapshot.protocols.find((item) => item.id === id));
  if (definitions.some((item) => !item?.runtimeMode)) return null;
  const modes = [...new Set(definitions.map((item) => item!.runtimeMode!))];
  return modes.length === 1 ? modes[0]! : null;
}

function describe(protocols: CoordinationProtocolId[], snapshot: CapabilitySnapshot): string {
  return protocols.map((id) => snapshot.protocols.find((item) => item.id === id)?.displayName ?? id).join(' → ');
}

function selection(id: CoordinationProtocolId, snapshot: CapabilitySnapshot): CoordinationProtocolSelection {
  return { protocol: id, version: snapshot.protocols.find((item) => item.id === id)?.version ?? 1 };
}

function alternativesFor(selected: CoordinationProtocolId[], count: number, snapshot: CapabilitySnapshot): CoordinationAlternative[] {
  const alternatives: CoordinationAlternative[] = [];
  if (!selected.includes('dynamic_collaboration')) alternatives.push({ protocols: [selection('dynamic_collaboration', snapshot)], displayName: '开放式自由协作', suitableWhen: '任务边界尚不清晰，希望 Agent 在对话中逐步探索' });
  if (count > 1 && !selected.includes('parallel_fanout')) alternatives.push({ protocols: [selection('parallel_fanout', snapshot)], displayName: '多人分别分析', suitableWhen: '多个参与者可以独立给出观点或方案' });
  if (count > 1 && !selected.includes('sequential_pipeline')) alternatives.push({ protocols: [selection('sequential_pipeline', snapshot)], displayName: '按顺序接力完成', suitableWhen: '参与者需要依次加工前序产物' });
  return alternatives.slice(0, 2);
}

function error(code: string, message: string, path: string | null = null): CoordinationValidationIssue {
  return { code, message, path, severity: 'error' };
}

function validateDraft(taskBrief: TaskBrief, selected: CoordinationProtocolId[], snapshot: CapabilitySnapshot): CoordinationValidationIssue[] {
  const issues: CoordinationValidationIssue[] = [];
  if (snapshot.agents.length > snapshot.policy.maximumAgents) issues.push(error('AGENT_COUNT_ABOVE_PLATFORM_MAXIMUM', '参与成员超过平台上限', 'taskBrief.participantIds'));
  for (const id of selected) {
    const protocol = snapshot.protocols.find((item) => item.id === id);
    if (!protocol) { issues.push(error('PROTOCOL_NOT_FOUND', `能力快照中不存在协议 ${id}`, 'protocols')); continue; }
    if (snapshot.agents.length < protocol.minimumAgents) issues.push(error('AGENT_COUNT_BELOW_MINIMUM', `${protocol.displayName} 至少需要 ${protocol.minimumAgents} 位成员`, 'taskBrief.participantIds'));
    if (protocol.maximumAgents !== null && snapshot.agents.length > protocol.maximumAgents) issues.push(error('AGENT_COUNT_ABOVE_MAXIMUM', `${protocol.displayName} 最多允许 ${protocol.maximumAgents} 位成员`, 'taskBrief.participantIds'));
    for (const capability of protocol.requiredCapabilities) {
      if (!snapshot.agents.some((agent) => agent.enabled && agent.capabilities.includes(capability))) issues.push(error('AGENT_CAPABILITY_MISSING', `${protocol.displayName} 缺少 ${capability} 能力`, `protocols.${id}`));
    }
    for (const slot of protocol.roleSlots) {
      const available = snapshot.agents.filter((agent) => agent.enabled && agent.capabilities.includes(slot.capability)).length;
      if (available < slot.minimum) issues.push(error('ROLE_SLOT_UNFILLED', `${protocol.displayName} 的 ${slot.id} 角色至少需要 ${slot.minimum} 位具备 ${slot.capability} 能力的成员`, `protocols.${id}.roleSlots.${slot.id}`));
    }
  }
  if (selected.length > 1) {
    for (const id of selected) {
      const protocol = snapshot.protocols.find((item) => item.id === id);
      if (protocol && !protocol.composable) issues.push(error('PROTOCOL_NOT_COMPOSABLE', `${protocol.displayName} 不允许参与协议组合`, `protocols.${id}`));
    }
  }
  for (const compositionIssue of validateProtocolComposition(selected)) {
    issues.push(error(compositionIssue.split(':', 1)[0]!, `协议组合连接不合法：${compositionIssue}`, 'protocols'));
  }
  if (selected.includes('review_revision') || selected.includes('debate')) {
    const reviewer = taskBrief.reviewerId ? snapshot.agents.find((agent) => agent.id === taskBrief.reviewerId) : null;
    if (!reviewer?.capabilities.includes('review')) issues.push(error('REVIEWER_REQUIRED', '该协议需要具备 review 能力的 Reviewer', 'taskBrief.reviewerId'));
    const independentExecutors = snapshot.agents.filter((agent) => agent.id !== reviewer?.id && agent.capabilities.includes('execute'));
    const requiredExecutors = selected.includes('debate') ? 2 : 1;
    if (independentExecutors.length < requiredExecutors) issues.push(error('REVIEWER_ISOLATION_VIOLATION', `Reviewer 必须独立于 ${requiredExecutors} 位执行成员`, 'taskBrief.reviewerId'));
  }
  const rounds = taskBrief.hardConstraints.rounds ?? taskBrief.inferredConstraints.rounds;
  if (selected.includes('debate') && (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 1 || rounds > 10)) issues.push(error('INVALID_DEBATE_ROUNDS', '辩论轮次必须是 1～10 的整数', 'taskBrief.hardConstraints.rounds'));
  return issues;
}

function isAmbiguousComplexGoal(goal: string, selected: CoordinationProtocolId[], requested?: CoordinationProtocolId): boolean {
  if (requested || selected[0] !== 'dynamic_collaboration') return false;
  return includes(goal, /(?:分析|研究|比较|方案|设计|实现|修复|决策|评估|规划)/u);
}

/**
 * AG-COORD-07：目标文本点名了不在所选团队里的成员时生成提示（真机会话 f33007c5：
 * 指令说"coder和🍗"，团队却是 coder-jitui+planner，静默按选择顺序绑定）。
 * 子串匹配（如 coder 命中 coder-jitui 的提及）只多不少提示，不作为错误。
 */
export function participantNotices(goal: string, snapshot: CapabilitySnapshot): string[] {
  const selected = new Set(snapshot.agents.map((agent) => agent.id));
  const mentioned = registry.list().filter((agent) => {
    if (selected.has(agent.id) || !agent.enabled) return false;
    return [agent.id, agent.name].some((name) => name.length >= 2 && goal.includes(name));
  });
  if (mentioned.length === 0) return [];
  const teamNames = snapshot.agents.map((agent) => agent.name).join('、');
  return [`目标提到 ${mentioned.map((agent) => `「${agent.name}」`).join('、')}，但当前团队为 ${teamNames}；实际角色绑定以所选团队为准，如需调整请先修改团队成员`];
}

export function createCoordinationDraft(
  input: CoordinationPreviewInput,
  snapshot: CapabilitySnapshot,
  modelProposal: CoordinationModelProposal | null = null,
  planning: CoordinationDraft['planning'] = {
    source: 'deterministic', model: null, attempts: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, fallbackReason: null,
  },
  autoStartThreshold = config.coordinationPlanner.autoStartThreshold,
): CoordinationDraft {
  const taskBrief = normalizeTask(input, snapshot);
  const deterministic = selectDeterministicProtocols(taskBrief.objective, snapshot.agents.length, input.requestedProtocol);
  const selected = input.requestedProtocol ? deterministic : modelProposal?.protocols.map((item) => item.protocol) ?? deterministic;
  if (modelProposal) taskBrief.missingInformation.push(...modelProposal.missingInformation.filter((item) => !taskBrief.missingInformation.includes(item)));
  if (!modelProposal && isAmbiguousComplexGoal(taskBrief.objective, selected, input.requestedProtocol)) taskBrief.missingInformation.push('collaborationStyle');
  const selections = selected.map((protocol) => selection(protocol, snapshot));
  const validationIssues = validateDraft(taskBrief, selected, snapshot);
  const explicit = Boolean(input.requestedProtocol) || taskBrief.constraintEvidence.some((item) => item.source === 'user_input');
  const exactAgreement = selected.length === deterministic.length && selected.every((item, index) => deterministic[index] === item);
  const semanticStrength = modelProposal
    ? 0.74 + modelProposal.confidence * 0.14 + (exactAgreement ? 0.08 : selected[0] === deterministic[0] ? 0.04 : 0) - Math.max(0, selected.length - 1) * 0.02
    : selected[0] === 'dynamic_collaboration' ? 0.68 : explicit ? 0.94 : 0.84;
  const platformConfidence = Math.max(0, Math.min(1, semanticStrength - validationIssues.length * 0.18 - taskBrief.missingInformation.length * 0.2));
  const decision = validationIssues.some((item) => item.severity === 'error') ? 'unavailable'
    : taskBrief.missingInformation.length > 0 ? 'clarify'
      : taskBrief.risk === 'high' || platformConfidence < autoStartThreshold ? 'recommend' : 'auto_start';
  const deterministicReasonCodes = input.requestedProtocol ? ['USER_SELECTED_PROTOCOL']
    : selected.includes('debate') ? ['EXPLICIT_DEBATE_REQUEST', 'FIXED_ROUNDS', 'INDEPENDENT_REVIEW_REQUIRED']
      : selected.includes('review_revision') ? ['USER_REQUESTS_DELIVERABLE', 'OUTPUT_REQUIRES_REVIEW', 'DEFECTS_MAY_REQUIRE_REWORK']
        : selected.includes('parallel_fanout') ? ['INDEPENDENT_WORKSTREAMS_DETECTED']
          : selected.includes('supervisor_dag') ? ['TASK_DECOMPOSITION_REQUIRED']
            : selected.includes('sequential_pipeline') ? ['ORDERED_DEPENDENCIES_DETECTED']
              : selected.includes('single_agent') ? ['SINGLE_PARTICIPANT_SUFFICIENT'] : ['OPEN_ENDED_COLLABORATION'];
  const reasonCodes = modelProposal?.reasonCodes.length ? modelProposal.reasonCodes : deterministicReasonCodes;
  const displayName = describe(selected, snapshot);
  const clarificationQuestion = modelProposal?.clarificationQuestion ?? (taskBrief.missingInformation.includes('collaborationStyle')
    ? '你希望团队成员各自独立给出方案，还是互相讨论后形成共同结果？' : null);
  const modelEvidence = modelProposal?.evidence ?? [];
  return {
    id: randomUUID(), capabilitySnapshotId: snapshot.id, taskBrief, protocols: selections, displayName,
    summary: selected.length > 1 ? `建议按“${displayName}”分阶段协作。` : `建议采用“${displayName}”。`, reasonCodes,
    evidence: [
      { source: 'task_semantics', field: 'objective' },
      ...modelEvidence,
      ...taskBrief.constraintEvidence.map((item) => ({ source: item.source === 'platform_default' ? 'capability' as const : 'user_constraint' as const, field: item.constraint })),
    ],
    alternatives: modelProposal?.alternatives.length ? modelProposal.alternatives : alternativesFor(selected, snapshot.agents.length, snapshot),
    planning, modelConfidence: modelProposal?.confidence ?? null, platformConfidence,
    risk: taskBrief.risk, decision, clarificationQuestion,
    clarificationOptions: clarificationQuestion ? ['多人分别分析后汇总', '开放式自由协作'] : [],
    validationIssues, validationErrors: validationIssues.filter((item) => item.severity === 'error').map((item) => item.code),
    runtimeMode: runtimeFor(selected, snapshot), createdAt: new Date().toISOString(),
  };
}
