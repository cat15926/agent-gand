import type { OrchestrationCapabilitySnapshot, OrchestrationDecision, OrchestrationIssue, OrchestrationRequest } from '@agent-gand/shared';

export function resolveOrchestration(request: OrchestrationRequest, snapshot: OrchestrationCapabilitySnapshot, replyAgentId?: string | null): OrchestrationDecision {
  const issues: OrchestrationIssue[] = [];
  const error = (code: string, message: string, agentId?: string) => issues.push({ code, severity: 'error', message, ...(agentId ? { agentId } : {}) });
  const team = snapshot.agents;
  const mentions: string[] = [];
  // Longest exact ID/name wins, including names containing spaces. Preserve mention order.
  for (const match of request.goal.matchAll(/(?:^|[\s，,；;、])@/gu)) {
    const remaining = request.goal.slice(match.index! + match[0].length);
    const matching = team.flatMap(agent => [agent.id,agent.name].filter(name => remaining.startsWith(name)
      && (!remaining[name.length] || /[\s，,。！？!?:：；;、]/u.test(remaining[name.length]!))).map(name => ({id:agent.id,length:name.length})))
      .sort((a,b) => b.length-a.length);
    const ids = [...new Set(matching.filter(item => item.length === matching[0]?.length).map(item => item.id))];
    if (!ids.length) error('UNRESOLVED_MENTION', '正文 @ 的成员不在候选团队或无法识别，请明确加入团队');
    else if (ids.length > 1) error('AMBIGUOUS_MENTION', '正文 @ 对应多位同名成员，请使用唯一角色 ID');
    else if (!mentions.includes(ids[0]!)) mentions.push(ids[0]!);
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

/** O4 decisions are execution authority. Candidate teams never imply unconditional fanout. */
export function resolveExecutableOrchestration(request: OrchestrationRequest, snapshot: OrchestrationCapabilitySnapshot,
  replyAgentId?: string | null, explicitWorkflow = false): OrchestrationDecision {
  const team = snapshot.agents;
  const ready = (id: string | null) => team.find(a => a.id === id && a.enabled && a.account.compatible
    && !['missing', 'unavailable'].includes(a.account.configuration));
  const executor = (id: string) => ready(id)?.capabilities.includes('execute');
  const inferredWrite = /写入|修改|修复|实现|重构|开发|提交代码|implement|fix\b|write\b/iu.test(request.goal);
  const readIntent = /分析|调研|研究|比较|评估|解释|总结|analyse|analyze|compare/iu.test(request.goal);
  const namedRole = (words: string) => team.find(a => [a.id, a.name].some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@${escaped}(?=$|[\\s，,。！？!?:：；;]).{0,12}(?:${words})`, 'u').test(request.goal);
  }))?.id ?? null;
  if (!explicitWorkflow) {
    if (/辩论|debate/iu.test(request.goal) && /\d+\s*轮/.test(request.goal)) request.workflow = 'bounded_debate';
    else if (/DAG|任务图|主管拆解|拆解并委派/iu.test(request.goal)) request.workflow = 'supervisor_decomposition';
    else if (/评审|审查|返工|review/iu.test(request.goal) && inferredWrite) request.workflow = 'development_review';
    else if (/分别|各自|独立|并行/.test(request.goal) && /汇总|整合|统一结论/.test(request.goal)) request.workflow = 'analysis_summary';
  }
  if (request.workflow === 'analysis_summary') request.aggregatorId ??= namedRole('汇总|整合|总结|统一结论')
    ?? team.find(a => ready(a.id) && a.capabilities.includes('coordinate'))?.id ?? null;
  if (request.workflow === 'development_review') request.defaultReviewerId ??= namedRole('评审|审查|review')
    ?? team.find(a => ready(a.id) && a.capabilities.includes('review'))?.id ?? null;
  if (request.workflow === 'supervisor_decomposition') request.supervisorId ??= team.find(a => ready(a.id)
    && a.driver === 'builtin-llm' && a.capabilities.includes('coordinate'))?.id ?? null;
  if (request.workflow === 'bounded_debate') request.constraints.rounds ??= Number(/(\d+)\s*轮/.exec(request.goal)?.[1]) || undefined;
  const readonly = request.constraints.readonly ?? (['analysis_summary','bounded_debate'].includes(request.workflow)
    || request.workflow !== 'development_review' && (!inferredWrite || readIntent && /仅分析|只读|不修改/.test(request.goal)));
  const base = resolveOrchestration({ ...request, workflow: 'routine', legacy: { ...request.legacy, requestedProtocol: null } }, snapshot, replyAgentId);
  const issues = base.issues.filter(i => ['UNRESOLVED_MENTION','AMBIGUOUS_MENTION','WHOLE_TEAM_CONFLICT'].includes(i.code));
  const error = (code: string, message: string, agentId?: string) => issues.push({ code, severity: 'error', message, ...(agentId ? { agentId } : {}) });
  if (['analysis_summary','bounded_debate'].includes(request.workflow) && !readonly) error('WORKFLOW_READONLY_CONFLICT', '分析汇总和辩论必须只读；写入请使用常规接力或开发评审');
  const mentionedRounds = Number(/(\d+)\s*轮/.exec(request.goal)?.[1]);
  if (request.workflow === 'bounded_debate' && mentionedRounds && request.constraints.rounds !== mentionedRounds) error('ROUND_CONFLICT', '正文轮次与明确轮次不一致');
  if (request.strategy === 'auto' && request.recipientIds.length > 1 && request.constraints.readonly === undefined && !readIntent && !inferredWrite && request.workflow === 'routine') error('TASK_INTENT_REQUIRED', '请明确多成员任务是只读分析还是顺序写入，或选择明确策略');
  const auxiliary = request.workflow === 'analysis_summary' ? request.aggregatorId
    : request.workflow === 'development_review' || request.workflow === 'bounded_debate' ? request.defaultReviewerId : null;
  let targetIds = [...base.targetIds], targetSource = base.targetSource;
  if (targetSource === 'automatic') {
    const eligible = team.filter(a => executor(a.id) && a.supports.control && (!request.constraints.maxTokens || a.supports.hardTokenLimit));
    if (eligible.length) targetIds = [eligible[0]!.id];
  }
  if (targetSource === 'mention' && auxiliary) targetIds = targetIds.filter(id => id !== auxiliary);
  if (request.recipientIds.length) {
    const mentionOnly = resolveOrchestration({ ...request, recipientIds: [], workflow: 'routine', wholeTeam: false }, snapshot);
    const mentionedWorkers = mentionOnly.targetSource === 'mention' ? mentionOnly.targetIds.filter(id => id !== auxiliary) : [];
    if (mentionedWorkers.length && (mentionedWorkers.length !== targetIds.length || mentionedWorkers.some(id => !targetIds.includes(id)))) error('TARGET_CONFLICT', '正文 @ 与本轮目标不一致，请重新选择');
  }
  if (targetSource === 'automatic' && (request.strategy !== 'auto' || ['analysis_summary','bounded_debate','supervisor_decomposition'].includes(request.workflow)
    || readonly && /分别|各自|独立|并行/.test(request.goal))) {
    targetIds = team.filter(a => executor(a.id) && a.id !== auxiliary && (request.workflow !== 'supervisor_decomposition' || a.id !== request.supervisorId)
      && (a.supports.control || request.strategy === 'serial' && request.constraints.readonly === true)
      && (!request.constraints.maxTokens || a.supports.hardTokenLimit)).map(a => a.id);
    if (request.workflow === 'bounded_debate') targetIds = targetIds.slice(0, 2);
  }
  if (request.workflow === 'development_review' && targetSource === 'automatic') targetIds = team.filter(a => executor(a.id) && a.id !== auxiliary && a.supports.control && (!request.constraints.maxTokens || a.supports.hardTokenLimit)).slice(0, 1).map(a => a.id);
  if (!targetIds.length) error('NO_EXECUTOR', '没有配置可用的执行成员，请选择成员或修复账户');
  if (targetIds.length > snapshot.maximumTargets) error('TOO_MANY_TARGETS', `最多 ${snapshot.maximumTargets} 位目标成员`);
  let effectiveStrategy: OrchestrationDecision['effectiveStrategy'] = targetIds.length < 2 ? 'single'
    : request.strategy === 'serial' ? 'serial' : request.strategy === 'parallel' || readonly ? 'parallel' : 'serial';
  if (request.strategy === 'parallel' && (!readonly || request.constraints.readonly === undefined && inferredWrite && !readIntent)) error('PARALLEL_WRITE_CONFLICT', '并行分析只接受只读任务，写入请使用顺序接力');
  if (request.workflow === 'development_review' || request.workflow === 'bounded_debate') {
    if (request.strategy === 'parallel') error('WORKFLOW_STRATEGY_CONFLICT', '该工作流必须保留实现/评审或轮次依赖，请使用自动或顺序策略');
    effectiveStrategy = targetIds.length < 2 ? 'single' : 'serial';
  }
  if (request.workflow === 'development_review') {
    if (targetIds.length !== 1) error('IMPLEMENTER_REQUIRED', '开发评审必须明确一位实现者');
    if (!ready(request.defaultReviewerId)?.capabilities.includes('review')) error('REVIEWER_REQUIRED', '请选择可用且具备 review 能力的独立评审者');
    if (targetIds.includes(request.defaultReviewerId ?? '')) error('REVIEWER_ISOLATION_REQUIRED', '实现者与评审者不能相同');
  }
  if (request.workflow === 'analysis_summary') {
    if (targetIds.length < 2) error('ANALYSTS_REQUIRED', '至少选择两位分析成员');
    if (!request.aggregatorId || !executor(request.aggregatorId)) error('AGGREGATOR_REQUIRED', '请明确选择可用的汇总者');
  }
  if (request.workflow === 'supervisor_decomposition' && (!ready(request.supervisorId)?.capabilities.includes('coordinate')
    || ready(request.supervisorId)?.driver !== 'builtin-llm')) error('SUPERVISOR_REQUIRED', '主管必须是具备 coordinate 能力且账户可用的模型 API 成员');
  if (request.workflow === 'bounded_debate') {
    if (targetIds.length !== 2 || !request.constraints.rounds || request.constraints.rounds > 10) error('BOUNDED_DEBATE_REQUIRED', '请明确两位辩手及 1～10 轮；可以选择独立裁判或汇总者');
    if (request.defaultReviewerId && (!ready(request.defaultReviewerId)?.capabilities.includes('review') || targetIds.includes(request.defaultReviewerId))) error('REVIEWER_ISOLATION_REQUIRED', '裁判需要具备 review 能力，并独立于两位辩手');
    if (request.aggregatorId && !executor(request.aggregatorId)) error('AGGREGATOR_REQUIRED', '汇总者必须是配置可用的执行成员');
    if (request.defaultReviewerId && request.aggregatorId) error('DEBATE_TERMINAL_CONFLICT', '本期辩论终局请选择独立裁判或汇总者之一');
  }
  const protocol = request.workflow === 'development_review' ? 'review_revision' : request.workflow === 'analysis_summary' ? 'supervisor_aggregation'
    : request.workflow === 'supervisor_decomposition' ? 'supervisor_dag' : request.workflow === 'bounded_debate' ? 'debate'
    : effectiveStrategy === 'parallel' ? 'parallel_fanout' : effectiveStrategy === 'serial' ? 'sequential_pipeline' : 'dynamic_collaboration';
  const engine = request.workflow === 'routine' && effectiveStrategy === 'single' && targetIds.every(id => ready(id)?.supports.control) ? 'collaboration'
    : request.workflow === 'routine' && targetIds.some(id => ready(id) && !ready(id)!.supports.control) ? 'pipeline' : 'coordination';
  let participantIds = [...new Set([...targetIds, request.workflow === 'supervisor_decomposition' ? request.supervisorId : auxiliary,
    request.workflow === 'supervisor_decomposition' ? request.defaultReviewerId : null,
    request.workflow === 'bounded_debate' ? request.aggregatorId : null].filter((id): id is string => !!id))];
  if (engine === 'collaboration') participantIds = team.filter(a => ready(a.id) && a.supports.control
    && (!request.constraints.maxTokens || a.supports.hardTokenLimit)).map(a => a.id);
  for (const id of [...new Set([...participantIds, ...targetIds])]) {
    const actor = ready(id);
    if (!actor) error('ACCOUNT_UNAVAILABLE', '成员已停用或账户不可用，请修复配置', id);
    if (targetIds.includes(id) && !executor(id)) error('EXECUTE_CAPABILITY_REQUIRED', '目标成员缺少执行能力', id);
    if (request.constraints.maxTokens && !actor?.supports.hardTokenLimit) error('HARD_TOKEN_LIMIT_UNSUPPORTED', '该后端不能落实严格输出 Token 上限，请更换成员或移除限制', id);
    if (actor && !actor.supports.control && !(engine === 'pipeline' && request.strategy === 'serial' && request.constraints.readonly === true)) error('READONLY_CLI_RESTRICTED', '只读 CLI 仅支持明确的简单只读接力', id);
  }
  return { schemaVersion: 1, resolverVersion: 'o4-rules-v1', templateVersion: 'o4-workflows-v1', workflow: request.workflow,
    protocol, effectiveStrategy, targetIds, targetSource, reason: `${base.reason}；${readonly ? '本轮只读' : '本轮允许按角色政策写入'}，${effectiveStrategy === 'parallel' ? '分支独立执行' : effectiveStrategy === 'serial' ? '保留顺序依赖' : '常规协作可接力或咨询'}`,
    requiresConfirmation: request.workflow !== 'routine' || !readonly, issues, comparisonOnly: false,
    execution: { engine, participantIds, readonly, plannerRequired: request.workflow === 'supervisor_decomposition' } };
}
