import { randomUUID } from 'node:crypto';
import { isMessageVisibleTo, type MessageAccess, type AgentDefinition, type Conversation, type Message, type OrchestrationPreview, type OrchestrationPreviewInput, type OrchestrationSource, type Run, type RunMode, type RunOrchestrationSnapshot } from '@agent-gand/shared';
import { getAnyAgent, getAgent } from '../agents/registry.ts';
import { getConversation, createConversation, nextTurnNo, touchConversation } from '../conversations/service.ts';
import { compileCoordinationPlan } from '../coordination/service.ts';
import { getCoordinationDraft, getDraftCoordinationPlan, getRunCoordinationPlan } from '../coordination/store.ts';
import { config } from '../config.ts';
import { tx } from '../db/database.ts';
import { assertExternalAdmission } from '../execution/policy.ts';
import { listByConversation, post } from '../messaging/inbox.ts';
import { getTask } from '../messaging/tasks.ts';
import { createRun, getRun } from '../runs/trace.ts';
import { orchestrationCapabilities } from './capabilities.ts';
import { normalizeOrchestrationRequest, objectInput, OrchestrationError, semanticRequest, stableDigest, stringIds } from './normalize.ts';
import { resolveOrchestration } from './resolver.ts';
import { getSubmissionSnapshot, saveSubmissionSnapshot } from './store.ts';
import { assertLegacyAdmission } from './rollout.ts';

export function validateLegacyTeam(mode: RunMode, agentIds: string[], supervisorId?: string | null, defaultReviewerId?: string | null) {
  const active = agentIds.map(id => getAgent(id));
  if (active.some(agent => !agent)) throw new OrchestrationError(400, 'UNKNOWN_AGENT', 'agentIds 包含未知或已停用成员');
  const agents = active as AgentDefinition[];
  const effectiveSupervisorId = mode === 'supervisor' ? supervisorId ?? agents.find(agent => agent.capabilities.includes('coordinate'))?.id ?? null : null;
  assertExternalAdmission(agents, mode, effectiveSupervisorId);
  if (mode === 'supervisor' && (!effectiveSupervisorId || !agentIds.includes(effectiveSupervisorId))) throw new OrchestrationError(400, 'INVALID_SUPERVISOR', 'supervisorId 必须属于 agentIds');
  if (effectiveSupervisorId && !agents.find(agent => agent.id === effectiveSupervisorId)?.capabilities.includes('coordinate')) throw new OrchestrationError(400, 'INVALID_SUPERVISOR', '主管必须具备协调能力');
  const effectiveReviewerId = defaultReviewerId ?? agents.find(agent => agent.capabilities.includes('review'))?.id ?? null;
  if (effectiveReviewerId && (!agentIds.includes(effectiveReviewerId) || !agents.find(agent => agent.id === effectiveReviewerId)?.capabilities.includes('review'))) throw new OrchestrationError(400, 'INVALID_REVIEWER', '默认评审者必须属于聊天室且具备审查能力');
  if (mode === 'supervisor' && !agents.some(agent => agent.capabilities.includes('execute'))) throw new OrchestrationError(400, 'EXECUTOR_REQUIRED', '主管委派至少需要一名具备执行能力的成员');
  return { effectiveSupervisorId, effectiveReviewerId };
}

function roomFor(id: unknown): Conversation | undefined {
  if (id === undefined || id === null) return undefined;
  if (typeof id !== 'string' || !id) throw new OrchestrationError(400, 'INVALID_ROOM', 'conversationId 无效');
  const room = getConversation(id);
  if (!room) throw new OrchestrationError(404, 'ROOM_NOT_FOUND', '聊天室不存在');
  return room;
}

function verifyReferences(request: OrchestrationPreview['request']): string | null {
  if (!request.conversationId && (request.replyTo || request.taskId)) throw new OrchestrationError(400, 'REFERENCE_REQUIRES_ROOM', '回复或任务引用需要指定聊天室');
  const replied = request.replyTo ? listByConversation(request.conversationId!).find(message => message.id === request.replyTo) : undefined;
  if (request.replyTo && !replied) throw new OrchestrationError(400, 'INVALID_REPLY', 'replyTo 不属于当前聊天室');
  if (request.taskId) {
    const task = getTask(request.taskId);
    if (!task?.runId || getRun(task.runId)?.conversationId !== request.conversationId) throw new OrchestrationError(400, 'INVALID_TASK', 'taskId 不属于当前聊天室');
  }
  return replied?.kind === 'agent' ? replied.from : null;
}

/** 私密追问只进入具备逐成员上下文隔离的执行入口。 */
export function replyMessageAccess(request: OrchestrationPreview['request'], engine: string, targets: string[]): MessageAccess {
  const reply = request.replyTo && request.conversationId
    ? listByConversation(request.conversationId).find(message => message.id === request.replyTo) : undefined;
  if (reply?.visibility !== 'private') return { visibility: 'public', audience: [] };
  if (engine !== 'collaboration') throw new OrchestrationError(400, 'PRIVATE_REPLY_UNSUPPORTED', '私密追问请使用开放协作入口；当前工作流使用团队共享上下文');
  if (!targets.length || targets.some(id => !isMessageVisibleTo(reply, id))) {
    throw new OrchestrationError(400, 'PRIVATE_REPLY_TARGET', '追问成员不在原私密消息的可见范围内，请选择已授权成员');
  }
  return { visibility: 'private', audience: (reply.audience ?? []).filter(id => id === 'user' || request.agentIds.includes(id)) };
}

/** Recomputed under the submission transaction. No planner, driver or dispatch is called. */
export function prepareOrchestration(input: OrchestrationPreviewInput, source: OrchestrationSource = 'unified_preview', context: Parameters<typeof normalizeOrchestrationRequest>[2] = {}): OrchestrationPreview {
  const conversation = context.conversation ?? roomFor(input.conversationId);
  const request = normalizeOrchestrationRequest(input, source, { ...context, conversation });
  const replyAgentId = verifyReferences(request);
  const capabilities = orchestrationCapabilities(request.agentIds, request.workspace);
  const decision = resolveOrchestration(request, capabilities, replyAgentId);
  const fingerprint = stableDigest({ request: semanticRequest(request), capabilities,
    resolverVersion: decision.resolverVersion, templateVersion: decision.templateVersion, decision });
  return { request, capabilities, decision, fingerprint, comparisonOnly: true, testedModel: false, dispatchCreated: false };
}

export function previewOrchestration(value: unknown): OrchestrationPreview {
  const body = objectInput(value);
  const allowed = ['goal', 'conversationId', 'agentIds', 'recipientIds', 'strategy', 'workflow', 'workspace', 'supervisorId', 'defaultReviewerId', 'aggregatorId', 'replyTo', 'taskId', 'clientRequestId', 'constraints', 'wholeTeam'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new OrchestrationError(400, 'UNKNOWN_FIELD', '预览请求包含未知字段');
  return prepareOrchestration(body as unknown as OrchestrationPreviewInput);
}

type SubmissionSource = 'room_create' | 'direct_run' | 'conversation_message';
export interface LegacySubmissionResult {
  run: Run;
  conversation: Conversation;
  message: Message | null;
  plan: ReturnType<typeof getRunCoordinationPlan> | null;
  deduplicated: boolean;
}

function duplicateResult(snapshot: RunOrchestrationSnapshot): LegacySubmissionResult {
  const run = getRun(snapshot.runId), conversation = getConversation(snapshot.conversationId);
  if (!run || !conversation) throw new OrchestrationError(409, 'SUBMISSION_RECORD_INCOMPLETE', '既有提交记录不完整，请检查运行记录');
  const message = snapshot.request.clientRequestId ? listByConversation(conversation.id).find(message => message.clientMessageId === snapshot.request.clientRequestId && message.kind === 'user') ?? null : null;
  return { run, conversation, message, plan: getRunCoordinationPlan(run.id) ?? null, deduplicated: true };
}

/** All legacy creation APIs share admission and an atomic request/Run/message record.
 * Comparison decisions are deliberately not used for dispatch in O1.
 */
export function submitLegacyOrchestration(source: SubmissionSource, value: unknown, conversationId?: string): LegacySubmissionResult {
  const body = objectInput(value);
  if (['strategy', 'workflow', 'constraints', 'aggregatorId', 'entryVersion', 'initialRequest'].some(field => body[field] !== undefined)) throw new OrchestrationError(400, 'COMPARISON_ONLY', 'O1 的新策略仅支持预览；执行请继续使用现有 mode 与协作计划入口');
  const goal = source === 'conversation_message' ? body.body : body.goal;
  if (typeof goal !== 'string' || !goal.trim()) throw new OrchestrationError(400, 'MISSING_GOAL', source === 'conversation_message' ? 'body 必填' : 'goal 必填');
  const clientRequestId = source === 'conversation_message' ? body.clientMessageId : body.clientRequestId;
  if ((source === 'conversation_message' || clientRequestId !== undefined) && (typeof clientRequestId !== 'string' || clientRequestId.length < 8 || clientRequestId.length > 100)) throw new OrchestrationError(400, 'INVALID_IDEMPOTENCY_KEY', `${source === 'conversation_message' ? 'clientMessageId' : 'clientRequestId'} 长度必须为 8～100`);
  if (body.orchestrationFingerprint !== undefined && (typeof body.orchestrationFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.orchestrationFingerprint))) throw new OrchestrationError(400, 'INVALID_FINGERPRINT', 'orchestrationFingerprint 无效');
  const recipientIds = source === 'direct_run' ? [] : stringIds(body.recipientIds, 'recipientIds');
  const scope = source === 'conversation_message' ? `conversation:${conversationId}` : `entry:${source}`;
  // Hash caller intent, not mutable room/account versions. Exact retries survive config changes.
  const submissionIntent = { goal: goal.trim(), recipientIds, replyTo: body.replyTo ?? null, taskId: body.taskId ?? null,
    coordinationDraftId: body.coordinationDraftId ?? null, followupRouting: body.followupRouting ?? null, wholeTeam: body.wholeTeam ?? false,
    ...(source !== 'conversation_message' ? { mode: body.mode ?? 'collaboration', agentIds: body.agentIds, supervisorId: body.supervisorId ?? null, defaultReviewerId: body.defaultReviewerId ?? null, workspace: body.workspace || null } : {}) };
  const submissionDigest = stableDigest(submissionIntent);
  return tx(() => {
    const existing = getSubmissionSnapshot(scope, typeof clientRequestId === 'string' ? clientRequestId : null);
    if (existing) {
      if (existing.submissionDigest !== submissionDigest) throw new OrchestrationError(409, 'IDEMPOTENCY_CONFLICT', '同一请求 ID 已用于不同内容，请使用新的请求 ID');
      return duplicateResult(existing);
    }
    const conversation = source === 'conversation_message' ? roomFor(conversationId) : undefined;
    if (source === 'conversation_message' && !conversation) throw new OrchestrationError(404, 'ROOM_NOT_FOUND', '聊天室不存在');
    // Pre-O1 user messages have no request record. Verify reconstructable fields, never relaunch.
    if (conversation && typeof clientRequestId === 'string') {
      const old = listByConversation(conversation.id).find(message => message.clientMessageId === clientRequestId && message.kind === 'user');
      if (old) {
        const same = old.body.trim() === goal.trim() && old.to === (recipientIds.join(',') || 'all')
          && old.replyTo === (body.replyTo ?? null) && old.taskId === (body.taskId ?? null)
          && (old.meta?.followupRouting ?? null) === (body.followupRouting ?? null) && (old.meta?.wholeTeam === true) === (body.wholeTeam === true)
          && (!body.coordinationDraftId || getRunCoordinationPlan(old.runId)?.draftId === body.coordinationDraftId);
        if (!same) throw new OrchestrationError(409, 'IDEMPOTENCY_CONFLICT', '旧消息的请求 ID 已存在且载荷无法匹配，请使用新的请求 ID');
        const run = getRun(old.runId);
        if (!run) throw new OrchestrationError(409, 'SUBMISSION_RECORD_INCOMPLETE', '旧消息缺少运行记录');
        return { run, conversation, message: old, plan: getRunCoordinationPlan(run.id) ?? null, deduplicated: true };
      }
    }
    assertLegacyAdmission();
    if (body.followupRouting !== undefined && body.followupRouting !== 'room_mode') throw new OrchestrationError(400, 'INVALID_ROUTING', 'followupRouting 无效');
    if (body.coordinationDraftId !== undefined && (typeof body.coordinationDraftId !== 'string' || !body.coordinationDraftId)) throw new OrchestrationError(400, 'INVALID_DRAFT', 'coordinationDraftId 无效');
    if (body.coordinationDraftId && body.followupRouting) throw new OrchestrationError(400, 'ROUTING_CONFLICT', '不能同时选择推荐计划和房间原模式');
    const draft = typeof body.coordinationDraftId === 'string' ? getCoordinationDraft(body.coordinationDraftId) : undefined;
    if (body.coordinationDraftId && !draft) throw new OrchestrationError(404, 'DRAFT_NOT_FOUND', 'Coordination Draft 不存在');
    const prepared = prepareOrchestration({ goal, ...(conversation ? { conversationId: conversation.id } : { agentIds: body.agentIds as string[] }),
      recipientIds, workspace: conversation ? undefined : body.workspace as string | null | undefined,
      supervisorId: conversation ? undefined : body.supervisorId as string | undefined, defaultReviewerId: conversation ? undefined : body.defaultReviewerId as string | undefined,
      replyTo: body.replyTo as string | null | undefined, taskId: body.taskId as string | null | undefined, clientRequestId: clientRequestId as string | undefined, wholeTeam: body.wholeTeam as boolean | undefined,
    }, source, { conversation, mode: conversation?.mode ?? (body.mode ?? 'collaboration') as RunMode,
      coordinationDraftId: typeof body.coordinationDraftId === 'string' ? body.coordinationDraftId : null,
      requestedProtocol: draft?.protocols[0]?.protocol ?? null, followupRouting: body.followupRouting === 'room_mode' ? 'room_mode' : null });
    if (body.orchestrationFingerprint && body.orchestrationFingerprint !== prepared.fingerprint) throw new OrchestrationError(409, 'PREVIEW_STALE', '任务、成员、账户或工作区已变化，请重新预览');
    const request = prepared.request;
    replyMessageAccess(request, request.legacy.mode, prepared.decision.targetIds);
    if (request.recipientIds.length > config.collaboration.maxTargets || (source === 'room_create' && body.recipientIds !== undefined && !request.recipientIds.length)) throw new OrchestrationError(400, 'INVALID_TARGETS', `recipientIds 必须包含${source === 'room_create' ? ' 1～' : '不超过 '}${config.collaboration.maxTargets} 位聊天室成员`);
    if (request.wholeTeam && (!draft || request.legacy.followupRouting || request.recipientIds.length || request.replyTo)) throw new OrchestrationError(400, 'WHOLE_TEAM_CONFLICT', '全队处理必须绑定计划且不能定向成员');
    if (draft) {
      if (source === 'room_create') {
        if (draft.validationErrors.length) throw new OrchestrationError(409, 'DRAFT_INVALID', `当前协作方案未通过校验: ${draft.validationErrors.join(', ')}`);
        if (!draft.runtimeMode || draft.runtimeMode !== request.legacy.mode) throw new OrchestrationError(409, 'DRAFT_MODE_MISMATCH', 'mode 与协作方案不一致或协议尚未接入运行时');
      } else if (!['auto_start', 'recommend'].includes(draft.decision)) throw new OrchestrationError(409, 'DRAFT_CONFIRMATION_REQUIRED', '请先确认可执行的协作建议');
      if (request.wholeTeam) {
        const plan = getDraftCoordinationPlan(draft.id);
        if (!plan || !request.agentIds.every(id => plan.steps.some(step => step.agentId === id))) throw new OrchestrationError(409, 'WHOLE_TEAM_INCOMPLETE', '推荐计划未覆盖全队成员');
      }
    }
    const team = validateLegacyTeam(request.legacy.mode, request.agentIds, request.supervisorId, request.defaultReviewerId);
    const room = conversation ?? createConversation({ title: request.goal.slice(0, 80), mode: request.legacy.mode, agentIds: request.agentIds,
      supervisorId: team.effectiveSupervisorId, defaultReviewerId: team.effectiveReviewerId, workspace: request.workspace, stableWorkspace: source === 'room_create' });
    const run = createRun(request.goal, request.legacy.mode, request.agentIds, room.workspace, team.effectiveSupervisorId, room.id, nextTurnNo(room.id), team.effectiveReviewerId);
    const message = post({ runId: run.id, from: 'user', to: request.recipientIds.join(',') || 'all', kind: 'user', body: request.goal,
      ...replyMessageAccess(request, request.legacy.mode, prepared.decision.targetIds),
      replyTo: request.replyTo, taskId: request.taskId, clientMessageId: request.clientRequestId ?? `submission:${run.id}:user`, deliveryStatus: 'queued',
      meta: { orchestrationSource: source, ...(request.legacy.followupRouting ? { followupRouting: request.legacy.followupRouting } : {}), ...(request.wholeTeam ? { wholeTeam: true } : {}) } });
    const plan = draft ? compileCoordinationPlan(draft.id, run.id, request.goal, request.agentIds.map(id => getAnyAgent(id)!)) : null;
    const snapshot: RunOrchestrationSnapshot = { ...prepared, schemaVersion: 1, requestId: randomUUID(), runId: run.id, conversationId: room.id, createdAt: run.createdAt,
      submissionDigest, executionAuthority: 'legacy', legacyExecution: { mode: run.mode, agentIds: [...run.agentIds], workspace: run.workspace ?? null,
        supervisorId: run.supervisorId ?? null, defaultReviewerId: run.defaultReviewerId ?? null, coordinationPlanId: plan?.id ?? null } };
    saveSubmissionSnapshot(scope, snapshot);
    touchConversation(room.id);
    return { run, conversation: getConversation(room.id)!, message, plan, deduplicated: false };
  });
}
