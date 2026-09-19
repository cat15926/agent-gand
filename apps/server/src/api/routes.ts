/**
 * REST API（规格 §4.3 全部端点）
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDefinition, AgentInput, AgentMessageType, CoordinationPreviewInput, MessageKind, ResolveCollaborationDecision, RunMode } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { AgentValidationError, validateAgentInput } from '../agents/validation.ts';
import { listTools } from '../tools/builtin/index.ts';
import { getMcpStatus, refreshMcpTools } from '../tools/mcp/client.ts';
import { READONLY_TOOLS } from '../tools/types.ts';
import { config } from '../config.ts';
import { ApprovalError, decide as decideApproval, listApprovals } from '../hitl/approvals.ts';
import { post as postMessage, listMessages } from '../messaging/inbox.ts';
import { listByConversation } from '../messaging/inbox.ts';
import { cancelTask, claimTask, completeTask, createTask, getTask, listTasks, retryTask, TaskError } from '../messaging/tasks.ts';
import { listAttempts } from '../tasks/attempts.ts';
import { listReviews } from '../tasks/reviews.ts';
import { resumeSupervisorRun } from '../orchestration/supervisor.ts';
import { archiveConversation, createConversation, getConversation, listConversations, nextTurnNo, renameConversation, touchConversation, updateConversationMembers } from '../conversations/service.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import { resolveCollaborationDecision, CollaborationDecisionError } from '../collaboration/decisions.ts';
import { settleCollaborationRun } from '../collaboration/scheduler.ts';
import { budgetSnapshot, cancelAgentWork, cancelCollaborationRun, cancelDispatch, getDispatch, listAttempts as listCollaborationAttempts, listBatches as listCollaborationBatches, listConversationDispatches as listCollaborationDispatchesForConversation, listDecisions as listCollaborationDecisions, listDispatches as listCollaborationDispatches } from '../collaboration/store.ts';
import {
  countRuns,
  createRun,
  finishRun,
  getRun,
  listRunsByConversation,
  listRuns,
  renameRun,
  runDetail,
  softDeleteRun,
  usageSummary,
} from '../runs/trace.ts';
import { getRunObservability, getRunObservabilitySummary, getSpanDetail } from '../runs/observability.ts';
import { listCheckpoints } from '../runs/checkpoints.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { wakeRun } from '../runs/recovery.ts';
import { compileCoordinationPlan, CoordinationError, previewCoordination } from '../coordination/service.ts';
import { getCapabilitySnapshot, getCoordinationDraft, getCoordinationPlan, getRunCoordinationPlan, listCoordinationEvents, listCoordinationPlanRevisions, listCoordinationStepAttempts, listCoordinationStepStates } from '../coordination/store.ts';
import { isProtocolId, listProtocols } from '../coordination/protocols.ts';
import { tx } from '../db/database.ts';
import {
  externalId,
  getExternal,
  isExternalWorkspace,
  listExternal,
  registerExternal,
  revealExternal,
  unregisterExternal,
  updateExternalLabel,
  ExternalWorkspaceError,
} from '../workspaces/external.ts';
import {
  browseDirs,
  deleteWorkspace,
  duplicateWorkspace,
  listWorkspaceMetas,
  mkdirInBrowser,
  renameWorkspace,
  suggestWorkspaceName,
  WorkspaceManageError,
} from '../workspaces/manager.ts';

const MESSAGE_KINDS: readonly MessageKind[] = ['user', 'agent', 'system', 'tool'];
const MESSAGE_TYPES: readonly AgentMessageType[] = ['assignment', 'result', 'review_request', 'review_result', 'revision_request', 'handoff', 'collaboration_result', 'collaboration_handoff', 'collaboration_question', 'collaboration_wait_user', 'collaboration_routing', 'collaboration_task_proposal', 'informational'];
const RUN_MODES: readonly RunMode[] = ['pipeline', 'supervisor', 'collaboration'];
/** 命名工作区名（§10.2）：与 resolver 侧同规 */
const WORKSPACE_RE = /^[\w-]{1,32}$/;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function matchesImageSignature(content: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mimeType === 'image/webp') return content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString('ascii'));
  return false;
}

/** 带状态码的错误（errorHandler 统一映射） */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

function validateTeam(mode: RunMode, agentIds: string[], supervisorId?: string, defaultReviewerId?: string) {
  const agents = agentIds.map((id) => registry.getAgent(id));
  if (agents.some((agent) => !agent)) throw httpError(400, 'agentIds 包含未知或已停用成员');
  const active = agents as AgentDefinition[];
  const effectiveSupervisorId = mode === 'supervisor' ? (supervisorId ?? active.find((agent) => agent.capabilities.includes('coordinate'))?.id ?? null) : null;
  if (mode === 'supervisor' && (!effectiveSupervisorId || !agentIds.includes(effectiveSupervisorId))) throw httpError(400, 'supervisorId 必须属于 agentIds');
  if (effectiveSupervisorId && !active.find((agent) => agent.id === effectiveSupervisorId)?.capabilities.includes('coordinate')) throw httpError(400, '主管必须具备协调能力');
  const effectiveReviewerId = defaultReviewerId ?? active.find((agent) => agent.capabilities.includes('review'))?.id ?? null;
  if (effectiveReviewerId && (!agentIds.includes(effectiveReviewerId) || !active.find((agent) => agent.id === effectiveReviewerId)?.capabilities.includes('review'))) throw httpError(400, '默认评审者必须属于聊天室且具备审查能力');
  if (mode === 'supervisor' && !active.some((agent) => agent.capabilities.includes('execute'))) throw httpError(400, '主管委派至少需要一名具备执行能力的成员');
  return { effectiveSupervisorId, effectiveReviewerId };
}

/** 工作区管理操作包装：领域错误（带 status）映射为 HTTP 错误 */
function manage<T>(op: 'rename' | 'duplicate' | 'delete', name: string, arg?: unknown): T {
  const invoke = () => {
    if (op === 'rename') return renameWorkspace(name, String(arg));
    if (op === 'duplicate') return duplicateWorkspace(name);
    return deleteWorkspace(name, arg === true);
  };
  try {
    return invoke() as T;
  } catch (err) {
    if (err instanceof WorkspaceManageError) throw httpError(err.status, err.message);
    throw err;
  }
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { status?: number }).status;
    const code = typeof status === 'number' ? status : 500;
    if (code >= 500) req.log.error(err);
    reply.code(code).send({ error: err instanceof Error ? err.message : String(err), ...(
      err instanceof AgentValidationError ? { fieldErrors: err.fieldErrors } : {}) });
  });

  app.get('/api/health', async () => ({
    ok: true,
    agents: registry.count(),
    runs: countRuns(),
    mcp: getMcpStatus(),
  }));

  app.get<{ Querystring: { includeDisabled?: string } }>('/api/agents', async (req) => registry.list(req.query.includeDisabled === '1'));
  app.post<{ Body: { mimeType?: string; data?: string } }>('/api/agent-avatars', { bodyLimit: 7_500_000 }, async (req, reply) => {
    const mimeType = req.body?.mimeType ?? '';
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[mimeType];
    if (!extension) throw httpError(400, '头像仅支持 PNG、JPEG、WebP 或 GIF');
    const encoded = req.body?.data ?? '';
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw httpError(400, '头像数据格式无效');
    const content = Buffer.from(encoded, 'base64');
    if (content.length === 0 || content.length > MAX_AVATAR_BYTES) throw httpError(400, '头像文件必须小于 5 MB');
    if (!matchesImageSignature(content, mimeType)) throw httpError(400, '头像文件内容与图片类型不匹配');
    const fileName = `${randomUUID()}.${extension}`;
    const avatarDir = path.join(path.dirname(config.dbPath), 'avatars');
    await mkdir(avatarDir, { recursive: true });
    await writeFile(path.join(avatarDir, fileName), content, { flag: 'wx' });
    reply.code(201);
    return { avatar: `/api/agent-avatars/${fileName}` };
  });
  app.get<{ Params: { fileName: string } }>('/api/agent-avatars/:fileName', async (req, reply) => {
    if (!/^[0-9a-f-]+\.(?:png|jpg|webp|gif)$/i.test(req.params.fileName)) throw httpError(404, '头像不存在');
    const extension = path.extname(req.params.fileName).slice(1).toLowerCase();
    const mimeType = ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[extension];
    try {
      const content = await readFile(path.join(path.dirname(config.dbPath), 'avatars', req.params.fileName));
      return reply.type(mimeType ?? 'application/octet-stream').header('cache-control', 'public, max-age=31536000, immutable').send(content);
    } catch {
      throw httpError(404, '头像不存在');
    }
  });
  app.get('/api/agent-options', async () => ({
    tools: listTools().map((tool) => ({ name: tool.name, description: tool.description, readonly: READONLY_TOOLS.has(tool.name), source: tool.source ?? 'builtin' })),
    capabilities: [{ value: 'execute', label: '执行' }, { value: 'review', label: '审查' }, { value: 'coordinate', label: '协调' }],
    providers: [
      { value: 'mock', label: 'Mock（本地演示）', configured: true },
      { value: 'openai', label: 'OpenAI', configured: Boolean(config.llm.openaiApiKey) },
      { value: 'anthropic', label: 'Anthropic', configured: Boolean(config.llm.anthropicApiKey) },
    ],
    templates: [
      { id: 'blank', name: '空白角色', description: '从最小配置开始', input: { description: '自定义团队角色', capabilities: ['execute'], systemPrompt: '你是团队中的专业执行者。请根据目标完成任务，并清楚说明结果。', model: 'mock:agent', tools: [], disallowedTools: [], permissionMode: 'confirm', color: '#7c5cff', avatar: '🤖' } },
      { id: 'planner', name: '规划主管', description: '拆解目标并协调成员', input: { description: '负责拆解目标和协调团队', capabilities: ['coordinate', 'execute'], systemPrompt: '你负责理解目标、拆解任务、分配成员并汇总最终结果。', model: 'mock:planner', tools: [], disallowedTools: [], permissionMode: 'confirm', color: '#7c5cff', avatar: '🧭' } },
      { id: 'executor', name: '执行者', description: '实现任务并交付产物', input: { description: '负责实现任务并交付可验证产物', capabilities: ['execute'], systemPrompt: '你负责按任务要求完成实现，报告产物位置和验证结果。', model: 'mock:coder', tools: ['fs.read', 'fs.write', 'shell.run'], disallowedTools: [], permissionMode: 'auto', color: '#2f9e6e', avatar: '🧑‍💻' } },
      { id: 'reviewer', name: '评审者', description: '检查结果并推动返工', input: { description: '负责审查产出并给出明确结论', capabilities: ['review'], systemPrompt: '你负责对照验收标准审查产出。发现问题时给出具体、可执行的修改建议。', model: 'mock:reviewer', tools: ['fs.read', 'search.files'], disallowedTools: [], permissionMode: 'readonly', color: '#e0a13c', avatar: '🔍' } },
    ],
  }));
  app.get('/api/tools/mcp/status', async () => getMcpStatus());
  app.post('/api/tools/mcp/refresh', async (_req, reply) => {
    const status = await refreshMcpTools();
    if (status.configured && !status.connected) reply.code(503);
    return status;
  });

  // ---- 通用协作规划器：能力目录、任务预览与已编译计划 ----

  app.get('/api/coordination/protocols', async () => listProtocols());
  app.post<{ Body: Partial<CoordinationPreviewInput> }>('/api/coordination/preview', async (req, reply) => {
    const { goal, agentIds, defaultReviewerId, requestedProtocol } = req.body ?? {};
    if (typeof goal !== 'string' || goal.trim().length === 0) throw httpError(400, 'goal 必填');
    if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((id) => typeof id === 'string')) throw httpError(400, 'agentIds 必须是非空字符串数组');
    if (requestedProtocol !== undefined && !isProtocolId(requestedProtocol)) throw httpError(400, 'requestedProtocol 不受支持');
    try {
      const result = previewCoordination({ goal, agentIds, ...(typeof defaultReviewerId === 'string' && defaultReviewerId ? { defaultReviewerId } : {}), ...(requestedProtocol ? { requestedProtocol } : {}) });
      reply.code(201);
      return result;
    } catch (error) {
      if (error instanceof CoordinationError) throw httpError(error.status, error.message);
      throw error;
    }
  });
  app.get<{ Params: { id: string } }>('/api/coordination/drafts/:id', async (req) => {
    const draft = getCoordinationDraft(req.params.id);
    if (!draft) throw httpError(404, `Coordination Draft 不存在: ${req.params.id}`);
    return draft;
  });
  app.get<{ Params: { id: string } }>('/api/coordination/capability-snapshots/:id', async (req) => {
    const snapshot = getCapabilitySnapshot(req.params.id);
    if (!snapshot) throw httpError(404, `Capability Snapshot 不存在: ${req.params.id}`);
    return snapshot;
  });
  app.get<{ Params: { id: string } }>('/api/coordination/plans/:id', async (req) => {
    const plan = getCoordinationPlan(req.params.id);
    if (!plan) throw httpError(404, `Coordination Plan 不存在: ${req.params.id}`);
    return plan;
  });
  app.get<{ Params: { id: string } }>('/api/coordination/plans/:id/revisions', async (req) => {
    if (!getCoordinationPlan(req.params.id)) throw httpError(404, `Coordination Plan 不存在: ${req.params.id}`);
    return listCoordinationPlanRevisions(req.params.id);
  });
  app.get<{ Params: { id: string } }>('/api/coordination/drafts/:id/events', async (req) => {
    if (!getCoordinationDraft(req.params.id)) throw httpError(404, `Coordination Draft 不存在: ${req.params.id}`);
    return listCoordinationEvents({ draftId: req.params.id });
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/coordination-plan', async (req) => {
    if (!getRun(req.params.runId)) throw httpError(404, `Run 不存在: ${req.params.runId}`);
    const plan = getRunCoordinationPlan(req.params.runId);
    if (!plan) throw httpError(404, '该 Run 没有关联 Coordination Plan');
    return plan;
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/coordination', async (req) => {
    if (!getRun(req.params.runId)) throw httpError(404, `Run 不存在: ${req.params.runId}`);
    const plan = getRunCoordinationPlan(req.params.runId);
    if (!plan) throw httpError(404, '该 Run 没有关联 Coordination Plan');
    return {
      plan,
      steps: listCoordinationStepStates(plan.id),
      attempts: listCoordinationStepAttempts(plan.id),
      events: listCoordinationEvents({ planId: plan.id }),
    };
  });

  app.post<{ Body: unknown }>('/api/agents/validate', async (req) => ({ valid: true, normalized: validateAgentInput(req.body) }));
  app.post<{ Body: AgentInput }>('/api/agents', async (req, reply) => { const agent = registry.createAgent(req.body); reply.code(201); return agent; });
  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req) => { const agent = registry.getAnyAgent(req.params.id); if (!agent) throw httpError(404, `角色不存在: ${req.params.id}`); return agent; });
  app.get<{ Params: { id: string } }>('/api/agents/:id/versions', async (req) => { if (!registry.getAnyAgent(req.params.id)) throw httpError(404, `角色不存在: ${req.params.id}`); return registry.listVersions(req.params.id); });
  app.patch<{ Params: { id: string }; Body: AgentInput & { expectedVersion?: number } }>('/api/agents/:id', async (req) => {
    if (!Number.isInteger(req.body?.expectedVersion)) throw httpError(400, 'expectedVersion 必填');
    return registry.updateAgent(req.params.id, req.body, req.body.expectedVersion!);
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; expectedVersion?: number } }>('/api/agents/:id/status', async (req) => {
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled 必填');
    return registry.setEnabled(req.params.id, req.body.enabled, req.body.expectedVersion);
  });

  // ---- 聊天室：一个房间包含多轮 Run ----

  app.get('/api/conversations', async () => listConversations());
  app.post<{ Body: { goal?: string; mode?: string; agentIds?: string[]; recipientIds?: string[]; supervisorId?: string; defaultReviewerId?: string; workspace?: string; coordinationDraftId?: string } }>('/api/conversations', async (req, reply) => {
    const { goal, agentIds, recipientIds, supervisorId, defaultReviewerId, workspace, coordinationDraftId } = req.body ?? {};
    const mode = (req.body?.mode ?? 'collaboration') as string;
    if (typeof goal !== 'string' || goal.trim().length === 0) throw httpError(400, 'goal 必填');
    if (!RUN_MODES.includes(mode as RunMode)) throw httpError(400, `mode 必须是 ${RUN_MODES.join('|')}`);
    if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((id) => typeof id === 'string')) throw httpError(400, 'agentIds 必须是非空字符串数组');
    const coordinationDraft = coordinationDraftId ? getCoordinationDraft(coordinationDraftId) : undefined;
    if (coordinationDraftId && !coordinationDraft) throw httpError(404, `Coordination Draft 不存在: ${coordinationDraftId}`);
    if (coordinationDraft) {
      if (coordinationDraft.validationErrors.length > 0) throw httpError(409, `当前协作方案未通过校验: ${coordinationDraft.validationErrors.join(', ')}`);
      if (!coordinationDraft.runtimeMode) throw httpError(409, '当前协议尚未接入统一协调运行时');
      if (coordinationDraft.runtimeMode !== mode) throw httpError(409, 'mode 与协作方案不一致');
      if (coordinationDraft.taskBrief.objective !== goal.trim()) throw httpError(409, '任务内容已改变，请重新生成协作建议');
      const planned = new Set(coordinationDraft.taskBrief.participantIds);
      if (planned.size !== new Set(agentIds).size || agentIds.some((id) => !planned.has(id))) throw httpError(409, '团队成员已改变，请重新生成协作建议');
    }
    if (recipientIds !== undefined && (!Array.isArray(recipientIds) || recipientIds.length === 0 || recipientIds.length > config.collaboration.maxTargets || !recipientIds.every((id) => typeof id === 'string' && agentIds.includes(id)))) throw httpError(400, `recipientIds 必须包含 1～${config.collaboration.maxTargets} 位聊天室成员`);
    const { effectiveSupervisorId, effectiveReviewerId } = validateTeam(mode as RunMode, agentIds, supervisorId, defaultReviewerId);
    if (workspace && (isExternalWorkspace(workspace) ? !getExternal(externalId(workspace)!) : !WORKSPACE_RE.test(workspace))) throw httpError(400, 'workspace 无效或未注册');
    const created = tx(() => {
      const conversation = createConversation({ title: goal.trim().slice(0, 80), mode: mode as RunMode, agentIds, supervisorId: effectiveSupervisorId, defaultReviewerId: effectiveReviewerId, workspace: workspace || null, stableWorkspace: true });
      const run = createRun(goal.trim(), mode as RunMode, agentIds, conversation.workspace, effectiveSupervisorId, conversation.id, 1, effectiveReviewerId);
      const plan = coordinationDraftId ? compileCoordinationPlan(coordinationDraftId, run.id, goal, agentIds.map((id) => registry.getAgent(id)!).filter(Boolean)) : null;
      touchConversation(conversation.id);
      return { conversation, run, plan };
    });
    const { conversation, run, plan } = created;
    enqueueConversationRun(run.id, { recipientIds });
    reply.code(201);
    return { run, conversation: getConversation(conversation.id)!, plan };
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    return { conversation, runs: listRunsByConversation(conversation.id), messages: listByConversation(conversation.id) };
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id/collaboration', async (req) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    const runs = listRunsByConversation(conversation.id).filter((item) => item.mode === 'collaboration');
    return { runs: runs.map((item) => ({ run: item, dispatches: listCollaborationDispatches(item.id), attempts: listCollaborationAttempts(item.id), batches: listCollaborationBatches(item.id), decisions: listCollaborationDecisions(item.id), budget: budgetSnapshot(item.id) })) };
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; agentIds?: string[]; supervisorId?: string; defaultReviewerId?: string; expectedMembersVersion?: number } }>('/api/conversations/:id', async (req) => {
    if (req.body?.agentIds) {
      const current = getConversation(req.params.id); if (!current) throw httpError(404, `聊天室不存在: ${req.params.id}`);
      if (!Number.isInteger(req.body.expectedMembersVersion)) throw httpError(400, 'expectedMembersVersion 必填');
      if (req.body.agentIds.length === 0 || !req.body.agentIds.every((id) => typeof id === 'string')) throw httpError(400, 'agentIds 必须是非空字符串数组');
      const team = validateTeam(current.mode, req.body.agentIds, req.body.supervisorId, req.body.defaultReviewerId);
      const updated = updateConversationMembers(current.id, { agentIds: req.body.agentIds, supervisorId: team.effectiveSupervisorId, defaultReviewerId: team.effectiveReviewerId, expectedMembersVersion: req.body.expectedMembersVersion! });
      if (!updated) throw httpError(409, '聊天室成员已被其他操作修改，请刷新后重试');
      return updated;
    }
    const title = req.body?.title;
    if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 80) throw httpError(400, 'title 必填且长度 ≤80');
    const conversation = renameConversation(req.params.id, title);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    return conversation;
  });
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    const conversation = archiveConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    return conversation;
  });
  app.post<{ Params: { id: string }; Body: { body?: string; recipientIds?: string[]; replyTo?: string | null; taskId?: string | null; clientMessageId?: string } }>(
    '/api/conversations/:id/messages',
    async (req, reply) => {
      const conversation = getConversation(req.params.id);
      if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
      const { body, recipientIds, replyTo, taskId, clientMessageId } = req.body ?? {};
      if (typeof body !== 'string' || body.trim().length === 0) throw httpError(400, 'body 必填');
      if (typeof clientMessageId !== 'string' || clientMessageId.length < 8 || clientMessageId.length > 100) throw httpError(400, 'clientMessageId 必填');
      if (recipientIds !== undefined && (!Array.isArray(recipientIds) || !recipientIds.every((id) => typeof id === 'string' && conversation.agentIds.includes(id)))) {
        throw httpError(400, 'recipientIds 必须全部属于当前聊天室');
      }
      if (conversation.mode === 'collaboration' && (recipientIds?.length ?? 0) > config.collaboration.maxTargets) throw httpError(400, `recipientIds 最多 ${config.collaboration.maxTargets} 个`);
      const existing = listByConversation(conversation.id).find((message) => message.clientMessageId === clientMessageId);
      if (existing) {
        const existingRun = getRun(existing.runId);
        reply.code(200);
        return { run: existingRun, message: existing };
      }
      if (replyTo && !listByConversation(conversation.id).some((message) => message.id === replyTo)) throw httpError(400, 'replyTo 不属于当前聊天室');
      if (taskId && !listTasks().some((task) => task.id === taskId && task.runId && getRun(task.runId)?.conversationId === conversation.id)) throw httpError(400, 'taskId 不属于当前聊天室');
      const turnNo = nextTurnNo(conversation.id);
      validateTeam(conversation.mode, conversation.agentIds, conversation.supervisorId ?? undefined, conversation.defaultReviewerId ?? undefined);
      const run = createRun(body.trim(), conversation.mode, conversation.agentIds, conversation.workspace, conversation.supervisorId, conversation.id, turnNo, conversation.defaultReviewerId);
      const message = postMessage({
        runId: run.id, from: 'user', to: recipientIds?.join(',') || 'all', kind: 'user', body: body.trim(),
        replyTo: replyTo ?? null, taskId: taskId ?? null, clientMessageId, deliveryStatus: 'queued',
      });
      touchConversation(conversation.id);
      enqueueConversationRun(run.id, { recipientIds, replyTo, taskId, clientMessageId });
      reply.code(202);
      return { run, message };
    },
  );

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/collaboration', async (req) => {
    const item = getRun(req.params.runId);
    if (!item) throw httpError(404, `Run 不存在: ${req.params.runId}`);
    if (item.mode !== 'collaboration') throw httpError(409, 'Run 不是 collaboration 模式');
    const attempts = listCollaborationAttempts(item.id);
    return { dispatches: listCollaborationDispatches(item.id), attempts, batches: listCollaborationBatches(item.id), decisions: listCollaborationDecisions(item.id),
      activeAgents: attempts.filter((attempt) => attempt.status === 'running').map((attempt) => ({ agentId: attempt.agentId, dispatchId: attempt.dispatchId, startedAt: attempt.startedAt ?? attempt.createdAt })),
      budget: budgetSnapshot(item.id) };
  });
  app.get<{ Params: { id: string } }>('/api/collaboration/dispatches/:id', async (req) => {
    const item = getDispatch(req.params.id); if (!item) throw httpError(404, 'Dispatch 不存在'); return item;
  });
  app.post<{ Params: { id: string } }>('/api/collaboration/dispatches/:id/cancel', async (req) => {
    const item = cancelDispatch(req.params.id); if (!item) throw httpError(404, 'Dispatch 不存在'); settleCollaborationRun(item.runId); return item;
  });
  app.post<{ Params: { runId: string } }>('/api/collaboration/runs/:runId/stop', async (req) => {
    const item = getRun(req.params.runId); if (!item) throw httpError(404, 'Run 不存在');
    cancelCollaborationRun(item.id); finishRun(item.id, 'failed'); return getRun(item.id)!;
  });
  app.post<{ Params: { agentId: string }; Body: { conversationId?: string } }>('/api/collaboration/agents/:agentId/stop', async (req) => {
    if (typeof req.body?.conversationId !== 'string') throw httpError(400, 'conversationId 必填');
    const conversation = getConversation(req.body.conversationId); if (!conversation) throw httpError(404, '聊天室不存在');
    if (!conversation.agentIds.includes(req.params.agentId)) throw httpError(400, 'Agent 不属于当前聊天室');
    const affected = listCollaborationDispatchesForConversation(conversation.id).filter((item) => item.targetAgentId === req.params.agentId && (item.status === 'queued' || item.status === 'running')).map((item) => item.runId);
    const cancelled = cancelAgentWork(conversation.id, req.params.agentId);
    for (const runId of new Set(affected)) settleCollaborationRun(runId);
    return { cancelled };
  });
  app.post<{ Params: { decisionId: string }; Body: ResolveCollaborationDecision }>('/api/collaboration/decisions/:decisionId/resolve', async (req) => {
    try { return resolveCollaborationDecision(req.params.decisionId, req.body); }
    catch (err) { if (err instanceof CollaborationDecisionError) throw httpError(err.status, err.message); throw err; }
  });

  // ---- 任务（三态 + 认领事务锁）----

  app.get<{ Querystring: { runId?: string } }>('/api/tasks', async (req) =>
    listTasks(req.query.runId),
  );

  app.post<{ Body: { title?: string; body?: string; createdBy?: string; runId?: string } }>(
    '/api/tasks',
    async (req) => {
      const { title, body, createdBy, runId } = req.body ?? {};
      if (typeof title !== 'string' || title.length === 0) throw httpError(400, 'title 必填');
      return createTask({
        title,
        body: typeof body === 'string' ? body : null,
        createdBy: typeof createdBy === 'string' && createdBy.length > 0 ? createdBy : 'user',
        runId: typeof runId === 'string' ? runId : null,
      });
    },
  );

  app.post<{ Params: { id: string }; Body: { agentId?: string } }>(
    '/api/tasks/:id/claim',
    async (req) => {
      const agentId = req.body?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) throw httpError(400, 'agentId 必填');
      return claimTask(req.params.id, agentId); // 非 pending / 有阻塞 → TaskError 409
    },
  );

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req) => {
    const task = getTask(req.params.id);
    if (!task) throw httpError(404, `task 不存在: ${req.params.id}`);
    return task;
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id/attempts', async (req) => listAttempts(req.params.id));
  app.get<{ Params: { id: string } }>('/api/tasks/:id/reviews', async (req) => listReviews(req.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async (req) => {
    const task = retryTask(req.params.id);
    if (task.runId) void resumeSupervisorRun(task.runId);
    return task;
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (req) => cancelTask(req.params.id));

  app.post<{ Params: { id: string }; Body: { agentId?: string } }>(
    '/api/tasks/:id/complete',
    async (req) => {
      const agentId = req.body?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) throw httpError(400, 'agentId 必填');
      return completeTask(req.params.id, agentId);
    },
  );

  // ---- 消息 ----

  app.get<{ Querystring: { runId?: string; agentId?: string; taskId?: string; messageType?: string } }>('/api/messages', async (req) => {
    if (!req.query.runId) throw httpError(400, 'runId 必填');
    if (req.query.messageType && !MESSAGE_TYPES.includes(req.query.messageType as AgentMessageType)) {
      throw httpError(400, `messageType 必须是 ${MESSAGE_TYPES.join('|')}`);
    }
    return listMessages({
      runId: req.query.runId,
      ...(req.query.agentId ? { agentId: req.query.agentId } : {}),
      ...(req.query.taskId ? { taskId: req.query.taskId } : {}),
      ...(req.query.messageType ? { messageType: req.query.messageType as AgentMessageType } : {}),
    });
  });

  app.post<{ Body: { runId?: string; from?: string; to?: string; kind?: string; body?: string } }>(
    '/api/messages',
    async (req) => {
      const { runId, from, to, kind, body } = req.body ?? {};
      if (typeof runId !== 'string' || !runId) throw httpError(400, 'runId 必填');
      if (typeof from !== 'string' || !from) throw httpError(400, 'from 必填');
      if (typeof to !== 'string' || !to) throw httpError(400, 'to 必填');
      if (typeof kind !== 'string' || !MESSAGE_KINDS.includes(kind as MessageKind)) {
        throw httpError(400, `kind 必须是 ${MESSAGE_KINDS.join('|')}`);
      }
      if (typeof body !== 'string' || body.length === 0) throw httpError(400, 'body 必填');
      return postMessage({ runId, from, to, kind: kind as MessageKind, body });
    },
  );

  // ---- 运行（异步执行，立即返回）----

  app.post<{ Body: { goal?: string; mode?: string; agentIds?: string[]; supervisorId?: string; defaultReviewerId?: string; workspace?: string } }>(
    '/api/runs',
    async (req, reply) => {
      const { goal, agentIds, supervisorId, defaultReviewerId, workspace } = req.body ?? {};
      const mode = (req.body?.mode ?? 'collaboration') as string;
      if (typeof goal !== 'string' || goal.length === 0) throw httpError(400, 'goal 必填');
      if (!RUN_MODES.includes(mode as RunMode)) {
        throw httpError(400, `mode 必须是 ${RUN_MODES.join('|')}`);
      }
      if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((a) => typeof a === 'string')) {
        throw httpError(400, 'agentIds 必须是非空字符串数组');
      }
      // 工作区（§10.2 内部名 [\w-]{1,32}；§11.2 外部约定 ext:<id> 须注册在案）
      if (workspace !== undefined && workspace !== null && workspace !== '') {
        if (isExternalWorkspace(workspace)) {
          if (!getExternal(externalId(workspace)!)) {
            throw httpError(400, `外部工作区未注册: ${externalId(workspace)}`);
          }
        } else if (!WORKSPACE_RE.test(workspace)) {
          throw httpError(400, 'workspace 只允许字母/数字/下划线/连字符（或外部约定 ext:<id>），长度 1-32');
        }
      }
      const { effectiveSupervisorId, effectiveReviewerId } = validateTeam(mode as RunMode, agentIds, supervisorId, defaultReviewerId);
      const conversation = createConversation({
        title: goal.trim().slice(0, 80), mode: mode as RunMode, agentIds, supervisorId: effectiveSupervisorId, defaultReviewerId: effectiveReviewerId, workspace: workspace || null,
      });
      const run = createRun(goal, mode as RunMode, agentIds, conversation.workspace, effectiveSupervisorId, conversation.id, 1, effectiveReviewerId);
      touchConversation(conversation.id);
      enqueueConversationRun(run.id);
    reply.code(201);
    return { run, conversation: getConversation(conversation.id)! };
  });

  // §13.3 列表过滤：默认排除软删；includeDeleted=1 含；q=标题/目标模糊；status=精确
  app.get<{ Querystring: { includeDeleted?: string; q?: string; status?: string } }>(
    '/api/runs',
    async (req) =>
      listRuns({
        includeDeleted: req.query.includeDeleted === '1',
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
      }),
  );

  // §13.2 会话改题（非空 ≤80）
  app.patch<{ Params: { id: string }; Body: { title?: string } }>('/api/runs/:id', async (req) => {
    const { title } = req.body ?? {};
    if (typeof title !== 'string' || title.trim().length === 0) throw httpError(400, 'title 必填且非空');
    if (title.trim().length > 80) throw httpError(400, 'title 长度 ≤80');
    const updated = renameRun(req.params.id, title);
    if (updated === null) throw httpError(404, `run 不存在: ${req.params.id}`);
    return updated;
  });

  // §13.3 软删（幂等；物理零删除：DB 行保留、沙箱产物与 span 证据不动，runId 取证链不受影响）
  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const updated = softDeleteRun(req.params.id);
    if (updated === null) throw httpError(404, `run 不存在: ${req.params.id}`);
    return updated;
  });

  // ---- 工作区管理（§11.1 M1 / §11.2 M2） ----

  // 卡片元数据列表（§11.1：名称/最后使用/文件数/关联 run 数/最近目标）
  app.get('/api/workspaces', async () => listWorkspaceMetas());

  // 自动名建议（§11.1 新建零输入路径：goal 关键词 slug 或 task-MMDD，服务端判撞名）
  app.get<{ Querystring: { goal?: string } }>('/api/workspaces/suggest', async (req) => ({
    name: suggestWorkspaceName(req.query.goal),
  }));

  app.post<{ Params: { name: string }; Body: { to?: string } }>(
    '/api/workspaces/:name/rename',
    async (req) => {
      const { to } = req.body ?? {};
      if (typeof to !== 'string' || to.length === 0) throw httpError(400, 'to 必填');
      return manage('rename', req.params.name, to);
    },
  );

  app.post<{ Params: { name: string } }>('/api/workspaces/:name/duplicate', async (req) =>
    manage('duplicate', req.params.name),
  );

  app.post<{ Params: { name: string }; Body: { confirm?: boolean } }>(
    '/api/workspaces/:name/delete',
    async (req) => manage('delete', req.params.name, req.body?.confirm === true),
  );

  // 外部目录注册表（§11.2）
  app.get('/api/workspaces/external', async () => listExternal());
  app.post<{ Body: { path?: string; label?: string } }>('/api/workspaces/register', async (req) => {
    const { path: p, label } = req.body ?? {};
    if (typeof p !== 'string' || p.length === 0) throw httpError(400, 'path 必填');
    try {
      return registerExternal({ path: p, label });
    } catch (err) {
      if (err instanceof ExternalWorkspaceError) throw httpError(err.status, err.message);
      throw err;
    }
  });
  app.delete<{ Params: { id: string } }>('/api/workspaces/register/:id', async (req) => {
    try {
      unregisterExternal(req.params.id);
      return { ok: true };
    } catch (err) {
      if (err instanceof ExternalWorkspaceError) throw httpError(err.status, err.message);
      throw err;
    }
  });

  // 本机目录浏览器（§11.2：只列目录、跳点开头；缺省=主目录）
  app.get<{ Querystring: { path?: string } }>('/api/fs/browse', async (req) =>
    browseDirs(req.query.path),
  );

  // §12.1 浏览器内新建文件夹——用户直接操作语义（同 Finder；不经 agent 权限体系，§12.5 分线）
  app.post<{ Body: { parentPath?: string; name?: string } }>('/api/fs/mkdir', async (req) => {
    const { parentPath, name } = req.body ?? {};
    if (typeof parentPath !== 'string' || parentPath.length === 0) throw httpError(400, 'parentPath 必填');
    if (typeof name !== 'string' || name.length === 0) throw httpError(400, 'name 必填');
    try {
      return mkdirInBrowser(parentPath, name);
    } catch (err) {
      if (err instanceof WorkspaceManageError) throw httpError(err.status, err.message);
      throw err;
    }
  });

  // §12.3 在 Finder 中显示（用户操作语义；仅已注册项，§12.5 分线）
  app.post<{ Params: { id: string } }>('/api/workspaces/:id/reveal', async (req) => {
    try {
      return revealExternal(req.params.id);
    } catch (err) {
      if (err instanceof ExternalWorkspaceError) throw httpError(err.status, err.message);
      throw err;
    }
  });

  // §12.3 外部工作区 label 编辑
  app.patch<{ Params: { id: string }; Body: { label?: string } }>(
    '/api/workspaces/register/:id',
    async (req) => {
      const { label } = req.body ?? {};
      if (typeof label !== 'string') throw httpError(400, 'label 必填');
      try {
        return updateExternalLabel(req.params.id, label);
      } catch (err) {
        if (err instanceof ExternalWorkspaceError) throw httpError(err.status, err.message);
        throw err;
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const detail = runDetail(req.params.id);
    if (!detail) throw httpError(404, `run 不存在: ${req.params.id}`);
    return detail;
  });

  app.get<{ Params: { id: string }; Querystring: { payload?: string } }>('/api/runs/:id/observability', async (req) => {
    if (req.query.payload !== undefined && req.query.payload !== 'summary' && req.query.payload !== 'full') {
      throw httpError(400, "payload 必须是 'summary' 或 'full'");
    }
    const observability = req.query.payload === 'summary'
      ? getRunObservabilitySummary(req.params.id)
      : getRunObservability(req.params.id);
    if (!observability) throw httpError(404, `run 不存在: ${req.params.id}`);
    return observability;
  });

  app.get<{ Params: { id: string; spanId: string } }>('/api/runs/:id/spans/:spanId', async (req) => {
    if (!getRun(req.params.id)) throw httpError(404, `run 不存在: ${req.params.id}`);
    const span = getSpanDetail(req.params.id, req.params.spanId);
    if (!span) throw httpError(404, `span 不存在: ${req.params.spanId}`);
    return span;
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/checkpoints', async (req) => {
    if (!getRun(req.params.id)) throw httpError(404, `run 不存在: ${req.params.id}`);
    return listCheckpoints(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/tool-executions', async (req) => {
    if (!getRun(req.params.id)) throw httpError(404, `run 不存在: ${req.params.id}`);
    return listToolExecutions(req.params.id);
  });

  // ---- 审批 ----

  app.get<{ Querystring: { status?: string } }>('/api/approvals', async (req) =>
    listApprovals(req.query.status),
  );

  app.post<{ Params: { id: string }; Body: { decision?: string; editedInput?: string; by?: string } }>(
    '/api/approvals/:id/decide',
    async (req) => {
      const { decision, editedInput, by } = req.body ?? {};
      if (decision !== 'approve' && decision !== 'reject' && decision !== 'edit') {
        throw httpError(400, "decision 必须是 'approve'|'reject'|'edit'");
      }
      try {
        const approval = decideApproval(req.params.id, {
          decision,
          editedInput: typeof editedInput === 'string' ? editedInput : undefined,
          by: typeof by === 'string' && by.length > 0 ? by : 'user',
        });
        wakeRun(approval.runId);
        return approval;
      } catch (err) {
        if (err instanceof ApprovalError) throw httpError(err.status, err.message);
        throw err;
      }
    },
  );

  // ---- 用量 ----

  app.get('/api/usage', async () => usageSummary());
}
