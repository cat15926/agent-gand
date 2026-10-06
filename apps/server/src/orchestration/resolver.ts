import type { OrchestrationCapabilitySnapshot, OrchestrationDecision, OrchestrationIssue, OrchestrationRequest } from '@agent-gand/shared';

export function resolveOrchestration(request: OrchestrationRequest, snapshot: OrchestrationCapabilitySnapshot, replyAgentId?: string | null): OrchestrationDecision {
  const issues: OrchestrationIssue[] = [];
  const error = (code: string, message: string, agentId?: string) => issues.push({ code, severity: 'error', message, ...(agentId ? { agentId } : {}) });
  const team = snapshot.agents;
  const mentions: string[] = [];
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Exact ID/name tokens only. Plain mentions in prose are not assignments.
  for (const agent of team) if ([agent.id, agent.name].some(name => new RegExp(`(?:^|[\\s，,；;])@${escape(name)}(?=$|[\\s，,。！？!?:：；;])`, 'u').test(request.goal))) mentions.push(agent.id);
  for (const match of request.goal.matchAll(/(?:^|[\s，,；;])@([^\s，,。！？!?:：；;]+)/gu)) {
    const matches = team.filter(agent => agent.id === match[1] || agent.name === match[1]);
    if (!matches.length) error('UNRESOLVED_MENTION', '正文 @ 的成员不在候选团队或无法识别，请明确加入团队');
    if (matches.length > 1) error('AMBIGUOUS_MENTION', '正文 @ 对应多位同名成员，请使用唯一角色 ID');
  }
  let targetIds = [...request.recipientIds];
  let targetSource: OrchestrationDecision['targetSource'] = targetIds.length ? 'explicit' : 'automatic';
  if (targetIds.length && mentions.length && (targetIds.length !== mentions.length || mentions.some(id => !targetIds.includes(id)))) error('TARGET_CONFLICT', '正文 @ 与明确目标不一致，请调整后重新预览');
  if (!targetIds.length && mentions.length) { targetIds = mentions; targetSource = 'mention'; }
  if (request.wholeTeam) {
    if (targetIds.length || request.replyTo) error('WHOLE_TEAM_CONFLICT', '全队处理不能同时定向成员或回复单个成员');
    targetIds = [...request.agentIds]; targetSource = 'whole_team';
  } else if (!targetIds.length && replyAgentId && request.agentIds.includes(replyAgentId)) { targetIds = [replyAgentId]; targetSource = 'reply'; }
  if (!targetIds.length) {
    const usable = team.filter(agent => agent.enabled && agent.capabilities.includes('execute') && !['missing', 'unavailable'].includes(agent.account.configuration)
      && (agent.driver === 'builtin-llm' || agent.supports.control || (request.strategy === 'serial' && request.workflow === 'routine' && request.constraints.readonly === true)));
    targetIds = usable.length ? [usable[0]!.id] : [];
  }
  if (!targetIds.length) error('NO_EXECUTOR', '候选团队中没有配置可用的执行成员');
  if (targetIds.length > snapshot.maximumTargets) error('TOO_MANY_TARGETS', `本轮最多 ${snapshot.maximumTargets} 位目标成员`);
  const selected = team.filter(agent => targetIds.includes(agent.id));
  for (const agent of selected) {
    if (!agent.enabled) error('AGENT_DISABLED', '该成员已停用', agent.id);
    if (!agent.capabilities.includes('execute')) error('EXECUTE_CAPABILITY_REQUIRED', '目标成员缺少执行能力', agent.id);
    if (['missing', 'unavailable'].includes(agent.account.configuration)) error('ACCOUNT_UNAVAILABLE', '成员账户未配置或不可用，请到账户模块修复', agent.id);
    if (request.constraints.maxTokens && !agent.supports.hardTokenLimit) error('HARD_TOKEN_LIMIT_UNSUPPORTED', '此后端不能落实严格 token 上限，请更换成员或显式调整限制', agent.id);
  }
  const effectiveStrategy = targetIds.length < 2 ? 'single' : request.strategy === 'parallel' || (request.strategy === 'auto' && request.constraints.readonly === true) ? 'parallel' : 'serial';
  if (request.strategy === 'parallel' && request.constraints.readonly === false) error('PARALLEL_WRITE_CONFLICT', '并行分析只接受只读任务；写入请使用接力或受管理的独立工作树');
  if (request.workflow === 'development_review') {
    const reviewer = team.find(agent => agent.id === request.defaultReviewerId);
    if (targetIds.length !== 1) error('IMPLEMENTER_REQUIRED', '开发评审需要明确一位实现者');
    if (!reviewer?.enabled || !reviewer.capabilities.includes('review')) error('REVIEWER_REQUIRED', '请选择团队内具备评审能力的成员');
    else {
      if (targetIds.includes(reviewer.id)) error('REVIEWER_ISOLATION_REQUIRED', '实现者与评审者必须不同');
      if (['missing', 'unavailable'].includes(reviewer.account.configuration)) error('ACCOUNT_UNAVAILABLE', '评审者账户不可用', reviewer.id);
    }
    if (request.strategy === 'parallel') error('WORKFLOW_STRATEGY_CONFLICT', '开发评审需要先实现后评审，不能取消依赖');
  }
  if (request.workflow === 'analysis_summary') {
    if (targetIds.length < 2) error('ANALYSTS_REQUIRED', '分析与汇总至少需要两位分析成员');
    const aggregator = team.find(agent => agent.id === request.aggregatorId);
    if (!aggregator?.enabled || !aggregator.capabilities.includes('execute') || ['missing', 'unavailable'].includes(aggregator.account.configuration)) error('AGGREGATOR_REQUIRED', '请选择具备执行能力且配置可用的汇总者');
  }
  if (request.workflow === 'supervisor_decomposition') {
    const supervisor = team.find(agent => agent.id === request.supervisorId);
    if (!supervisor?.enabled || supervisor.driver !== 'builtin-llm' || !supervisor.capabilities.includes('coordinate') || ['missing', 'unavailable'].includes(supervisor.account.configuration)) error('SUPERVISOR_REQUIRED', '主管拆解需要团队内具备协调能力的模型 API 成员');
    issues.push({ code: 'FULL_DAG_PENDING', severity: 'warning', message: '完整主管步骤图在 O4 接入；本轮建议仅用于比较', requiredStage: 'O4' });
  }
  if (request.workflow === 'bounded_debate' && (targetIds.length < 2 || !request.constraints.rounds)) error('BOUNDED_DEBATE_REQUIRED', '辩论需要至少两位参与者及明确轮次');
  const protocol = request.legacy.requestedProtocol ?? (request.workflow === 'development_review' ? 'review_revision'
    : request.workflow === 'analysis_summary' ? 'supervisor_aggregation'
    : request.workflow === 'supervisor_decomposition' ? 'supervisor_dag'
    : request.workflow === 'bounded_debate' ? 'debate'
    : effectiveStrategy === 'single' ? 'single_agent' : effectiveStrategy === 'parallel' ? 'parallel_fanout' : 'sequential_pipeline');
  if (['consensus', 'vote'].includes(protocol)) error('PROTOCOL_NOT_EXECUTABLE', '该协议尚无可执行运行时');
  const participants = [...selected];
  for (const id of [request.workflow === 'development_review' ? request.defaultReviewerId : null, request.workflow === 'analysis_summary' ? request.aggregatorId : null]) {
    const agent = team.find(item => item.id === id); if (agent && !participants.includes(agent)) participants.push(agent);
  }
  for (const agent of participants) {
    if (!agent.supports.control && agent.driver !== 'builtin-llm' && (request.workflow !== 'routine' || request.strategy !== 'serial' || request.constraints.readonly !== true)) error('READONLY_CLI_RESTRICTED', '只读 CLI 首批仅支持明确的简单只读接力任务', agent.id);
    if (!agent.supports.coordinationSteps && protocol !== 'dynamic_collaboration') issues.push({ code: 'READONLY_CLI_COORDINATION_UNSUPPORTED', severity: 'warning', message: '只读 CLI 尚未开放 Coordination 步骤，请使用手动流水线', agentId: agent.id });
  }
  return { schemaVersion: 1, resolverVersion: 'o1-rules-v1', templateVersion: 'o1-templates-v1', effectiveStrategy,
    workflow: request.workflow, protocol, targetIds, targetSource,
    reason: targetSource === 'explicit' ? '采用你明确选择的目标成员' : targetSource === 'mention' ? '采用正文中的有效 @ 指派' : targetSource === 'reply' ? '采用被回复的成员' : targetSource === 'whole_team' ? '本轮明确要求全队参与' : '从候选团队中选择具备执行能力且配置可用的成员',
    requiresConfirmation: request.workflow !== 'routine', issues, comparisonOnly: true };
}
