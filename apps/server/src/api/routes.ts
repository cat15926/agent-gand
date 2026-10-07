import { applyRunAction, cancelTaskExecution, retryTaskExecution } from '../orchestration/actions.ts';
import { get } from '../db/database.ts';
import { createEmptyRoom, validateRoomPreferences } from '../conversations/entry.ts';
import { memberQueue } from '../execution/memberAdmission.ts';
/**
 * REST API（规格 §4.3 全部端点）
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentSaveInput, AgentMessageType, CoordinationPreviewInput, FollowupPreview, MessageKind, ResolveCollaborationDecision } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { AgentValidationError, validateAgentInput } from '../agents/validation.ts';
import { preflightAgent } from '../agents/preflight.ts';
import { prepareOrchestration, submitLegacyOrchestration } from '../orchestration/service.ts';
import { assertLegacyAdmission, entryStatistics, recordEntryStatistics } from '../orchestration/rollout.ts';
import { OrchestrationError } from '../orchestration/normalize.ts';
import { getRunOrchestrationSnapshot } from '../orchestration/store.ts';
import { previewExecutionOrchestration, submitExecutionOrchestration, reviseExecutionOrchestration, usesExecutionEntry } from '../orchestration/entry.ts';
import { listTools } from '../tools/builtin/index.ts';
import { getMcpStatus, refreshMcpTools } from '../tools/mcp/client.ts';
import { READONLY_TOOLS } from '../tools/types.ts';
import { config } from '../config.ts';
import { AccountError } from '../accounts/errors.ts';
import { redactSecrets } from '../accounts/secrets.ts';
import { listDrivers } from '../execution/drivers.ts';
import { listExecutions } from '../execution/store.ts';
import { stopExternalRun } from '../execution/runner.ts';
import { getIsolatedWorkspace, exportWorkspacePatch } from '../workspaces/isolated.ts';
import { ApprovalError, decide as decideApproval, listApprovals } from '../hitl/approvals.ts';
import { post as postMessage, listMessages } from '../messaging/inbox.ts';
import { conversationHistoryPage, searchConversationMessages, HistoryInputError, historyRunIds } from '../messaging/history.ts';
import { listByConversation } from '../messaging/inbox.ts';
import { cancelTask, claimTask, completeTask, createTask, getTask, listTasks, retryTask, TaskError } from '../messaging/tasks.ts';
import { listAttempts } from '../tasks/attempts.ts';
import { listReviews } from '../tasks/reviews.ts';
import { resumeSupervisorRun } from '../orchestration/supervisor.ts';
import { archiveConversation, getConversation, listConversations, renameConversation, updateConversationMembers, updateRoomPreferences } from '../conversations/service.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import { resolveCollaborationDecision, CollaborationDecisionError } from '../collaboration/decisions.ts';
import { closeCollaborationTrace, settleCollaborationRun } from '../collaboration/scheduler.ts';
import { listCompletionEvaluations } from '../runtime/completionStore.ts';
import { listCompletionCandidates } from '../runtime/subjectCompletion.ts';
import { listSuccessorObligations } from '../runtime/obligations.ts';
import { listEvidenceBundles } from '../runtime/evidence.ts';
import { listRouteGuardEvents } from '../runtime/loopGuard.ts';
import { listDurableHolds, listRuntimeHoldRecoveryAudits, listRuntimeWakeEvents } from '../runtime/holds.ts';
import { getCoordinationKernelStatus } from '../runtime/coordinationAdapter.ts';
import { listResponsibilitySnapshots } from '../runtime/responsibilitySnapshot.ts';
import { commitRunTerminal, getRunTerminal } from '../runtime/terminal.ts';
import { listRuntimeActionCommands } from '../runtime/actionCommands.ts';
import { listRuntimeShadowComparisons } from '../runtime/shadowComparison.ts';
import { budgetSnapshot, cancelAgentWork, cancelCollaborationRun, cancelDispatch, getDispatch, listAttempts as listCollaborationAttempts, listBatches as listCollaborationBatches, listConversationDispatches as listCollaborationDispatchesForConversation, listDecisions as listCollaborationDecisions, listDispatches as listCollaborationDispatches } from '../collaboration/store.ts';
import {
  countRuns,
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
import { recoverDurableHolds, wakeRun } from '../runs/recovery.ts';
import { CoordinationError, prepareCoordination, previewCoordination, reviseCoordinationPlan } from '../coordination/service.ts';
import { assertCoordinationRecoveryReady, cancelCoordinationRun, requestCoordinationPause, requestCoordinationResume, resumeCoordinationRun } from '../coordination/runtime.ts';
import { getCapabilitySnapshot, getCoordinationDraft, getCoordinationPlan, getRunCoordinationPlan, listCoordinationEvents, listCoordinationPlanRevisions, listCoordinationStepAttempts, listCoordinationStepStates, savePlanningResult } from '../coordination/store.ts';
import { isStructuredFollowupGoal } from '../coordination/planner.ts';
import { isProtocolId, listProtocols } from '../coordination/protocols.ts';
import { getCoordinationCalibration } from '../coordination/calibration.ts';
import {
  externalId,
  getExternal,
  isExternalWorkspace,
  listExternal,
  registerExternal,
  revealExternal,
  setExternalTrusted,
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
const MESSAGE_TYPES: readonly AgentMessageType[] = ['assignment', 'result', 'review_request', 'review_result', 'revision_request', 'handoff', 'collaboration_result', 'collaboration_contribution', 'collaboration_handoff', 'collaboration_question', 'collaboration_wait_user', 'collaboration_routing', 'collaboration_task_proposal', 'informational'];
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
  const entryEndpoints = new Set(['/api/conversations','/api/conversations/empty','/api/conversations/:id/messages','/api/conversations/:id/requests','/api/runs','/api/orchestration/preview','/api/coordination/preview','/api/conversations/:id/followup-preview']);
  const format = (endpoint: string, body: unknown): 'legacy' | 'unified' => ['/api/coordination/preview','/api/conversations/:id/followup-preview'].includes(endpoint)
    || ['/api/conversations','/api/conversations/:id/messages','/api/runs'].includes(endpoint) && !usesExecutionEntry(body && typeof body === 'object' ? body as Record<string,unknown> : {}) ? 'legacy' : 'unified';
  app.addHook('onSend', async (req,reply,payload) => {
    const endpoint = req.routeOptions.url ?? '';
    if (req.method === 'POST' && entryEndpoints.has(endpoint) && format(endpoint,req.body) === 'legacy') {
      reply.header('Deprecation','true'); reply.header('Link','</api/orchestration/preview>; rel="successor-version"');
    }
    return payload;
  });
  app.addHook('onResponse', async (req,reply) => {
    const endpoint = req.routeOptions.url ?? '';
    if (req.method === 'POST' && entryEndpoints.has(endpoint)) recordEntryStatistics(endpoint,format(endpoint,req.body),reply.statusCode);
  });
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { status?: number }).status;
    const code = typeof status === 'number' ? status : 500;
    if (code >= 500) req.log.error({ message: redactSecrets(err instanceof Error ? err.message : String(err)) });
    reply.code(code).send({ error: redactSecrets(err instanceof Error ? err.message : String(err)), ...(
      (err instanceof AgentValidationError || err instanceof AccountError) ? { fieldErrors: err.fieldErrors } : {}),
      ...(err instanceof OrchestrationError ? { code: err.code } : {}) });
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
    executionDrivers: await listDrivers(),
    tools: listTools().map((tool) => ({ name: tool.name, description: tool.description, readonly: READONLY_TOOLS.has(tool.name), source: tool.source ?? 'builtin' })),
    capabilities: [{ value: 'execute', label: '执行' }, { value: 'review', label: '审查' }, { value: 'coordinate', label: '协调' }],
    providers: [
      { value: 'mock', label: 'Mock（本地演示）', configured: true },
      { value: 'openai', label: 'OpenAI', configured: Boolean(config.llm.openaiApiKey) },
      { value: 'anthropic', label: 'Anthropic', configured: Boolean(config.llm.anthropicApiKey) },
    ],
    templates: [
      { id: 'blank', name: '自定义角色', description: '从最小配置开始', input: { description: '自定义团队角色', capabilities: ['execute'], systemPrompt: '你是团队中的专业执行者。请根据目标完成任务，并清楚说明结果。', model: 'mock:agent', tools: [], disallowedTools: [], permissionMode: 'confirm', color: '#7c5cff', avatar: '🤖' } },
      { id: 'assistant', name: '通用助手', description: '分析信息并协助完成任务', input: { description: '负责分析信息和解答问题', capabilities: ['execute'], systemPrompt: '你是团队中的通用助手。请准确分析信息，说明依据，并在需要时协助其他成员。', model: 'mock:agent', tools: [], disallowedTools: [], permissionMode: 'readonly', color: '#5385db', avatar: '🧠' } },
      { id: 'planner', name: '规划主管', description: '拆解目标并协调成员', input: { description: '负责拆解目标和协调团队', capabilities: ['coordinate', 'execute'], systemPrompt: '你负责理解目标、拆解任务、分配成员并汇总最终结果。', model: 'mock:planner', tools: [], disallowedTools: [], permissionMode: 'confirm', color: '#7c5cff', avatar: '🧭' } },
      { id: 'executor', name: '编码执行者', description: '实现任务并交付产物', input: { description: '负责实现任务并交付可验证产物', capabilities: ['execute'], systemPrompt: '你负责按任务要求完成实现，报告产物位置和验证结果。', model: 'mock:coder', tools: ['fs.read', 'search.files'], disallowedTools: [], permissionMode: 'confirm', color: '#2f9e6e', avatar: '🧑‍💻' } },
      { id: 'reviewer', name: '代码评审者', description: '检查结果并推动返工', input: { description: '负责审查产出并给出明确结论', capabilities: ['review'], systemPrompt: '你负责对照验收标准审查产出。发现问题时给出具体、可执行的修改建议。', model: 'mock:reviewer', tools: ['fs.read', 'search.files'], disallowedTools: [], permissionMode: 'readonly', color: '#e0a13c', avatar: '🔍' } },
    ],
  }));
  app.post('/api/agents/preflight', async (req) => {
    return preflightAgent(validateAgentInput(req.body, { allowUnavailableAccount: true }));
  });
  app.get('/api/tools/mcp/status', async () => getMcpStatus());
  app.get('/api/execution/drivers', async () => listDrivers(true));
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/executions', async (req) => {
    if (!getRun(req.params.runId)) throw httpError(404, 'Run 不存在');
    return listExecutions(req.params.runId);
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/workspace', async (req) => {
    if (!getRun(req.params.runId)) throw httpError(404, 'Run 不存在'); return getIsolatedWorkspace(req.params.runId);
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/workspace/patch', async (req, reply) => {
    if (!getRun(req.params.runId)) throw httpError(404, 'Run 不存在');
    try { return reply.type('text/plain; charset=utf-8').header('content-disposition', `attachment; filename="agent-gand-${req.params.runId}.patch"`).send(await exportWorkspacePatch(req.params.runId)); }
    catch (error) { throw httpError(409, error instanceof Error ? error.message : String(error)); }
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/queue', async req => {
    if (!getRun(req.params.runId)) throw httpError(404, 'Run 不存在');
    return { reservations: memberQueue(req.params.runId) };
  });
  app.post<{ Params: { runId: string }; Body: { action?: string; taskId?: string } }>('/api/runs/:runId/actions', async req => {
    const action = req.body?.action;
    if (action === 'retry') {
      const task = typeof req.body.taskId === 'string' ? getTask(req.body.taskId) : null;
      if (!task || task.runId !== req.params.runId) throw httpError(400, '重试必须指定该 Run 的 taskId');
      return retryTaskExecution(task.id);
    }
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') throw httpError(400, 'action 必须是 pause、resume、cancel 或 retry');
    return applyRunAction(req.params.runId, action);
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/stop', async req => applyRunAction(req.params.runId, 'cancel'));
  app.post('/api/tools/mcp/refresh', async (_req, reply) => {
    const status = await refreshMcpTools();
    if (status.configured && !status.connected) reply.code(503);
    return status;
  });

  // ---- 通用协作规划器：能力目录、任务预览与已编译计划 ----

  app.get('/api/coordination/protocols', async () => listProtocols().filter(p => !['consensus','vote','supervisor_dag'].includes(p.id)));
  app.post<{ Body: unknown }>('/api/orchestration/preview', async (req) => previewExecutionOrchestration(req.body));
  app.get('/api/orchestration/options', async () => ({ version: 'o4-workflows-v1', templateVersion: 'o4-workflows-v1', resolverVersion: 'o4-rules-v1',
    strategies: ['auto','parallel','serial'], workflows: ['routine','analysis_summary','development_review','supervisor_decomposition','bounded_debate'],
    admission: config.orchestrationRollout,
    verificationEnvironment: { fixture: process.env.NODE_ENV === 'test', claudeSdkWorker: config.externalAgents.sdkWorkerCommand ? 'custom' : 'bundled' },
    detailedPlanning: { explicitOnly: true, consumesQuota: true, maximumTasks: 5 }, maximumDebateRounds: 10 }));
  app.get('/api/orchestration/entry-statistics', async () => ({ statistics: entryStatistics(), containsRequestContent: false }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/conversations/:id/requests', async (req, reply) => {
    const result = submitExecutionOrchestration(req.body, req.params.id);
    if (!result.deduplicated) enqueueConversationRun(result.run.id);
    reply.code(result.deduplicated ? 200 : 202);
    return { ...result, snapshot: getRunOrchestrationSnapshot(result.run.id) };
  });
  app.post<{ Params: { runId: string }; Body: unknown }>('/api/runs/:runId/orchestration/revisions', async (req, reply) => {
    const result = reviseExecutionOrchestration(req.params.runId,req.body); reply.code(201); return result;
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/orchestration', async (req) => {
    if (!getRun(req.params.runId)) throw httpError(404, 'Run 不存在');
    const snapshot = getRunOrchestrationSnapshot(req.params.runId);
    return { snapshot, comparisonOnly: snapshot?.comparisonOnly ?? true };
  });
  app.post<{ Body: Partial<CoordinationPreviewInput> }>('/api/coordination/preview', async (req, reply) => {
    assertLegacyAdmission();
    const { goal, agentIds, defaultReviewerId, requestedProtocol, replacesDraftId } = req.body ?? {};
    if (typeof goal !== 'string' || goal.trim().length === 0) throw httpError(400, 'goal 必填');
    if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((id) => typeof id === 'string')) throw httpError(400, 'agentIds 必须是非空字符串数组');
    if (requestedProtocol !== undefined && !isProtocolId(requestedProtocol)) throw httpError(400, 'requestedProtocol 不受支持');
    const normalized = prepareOrchestration({ goal, agentIds, ...(typeof defaultReviewerId === 'string' && defaultReviewerId ? { defaultReviewerId } : {}) }, 'coordination_preview', { requestedProtocol });
    try {
      const result = await previewCoordination({ goal: normalized.request.goal, agentIds: normalized.request.agentIds, ...(typeof defaultReviewerId === 'string' && defaultReviewerId ? { defaultReviewerId } : {}), ...(requestedProtocol ? { requestedProtocol } : {}), ...(typeof replacesDraftId === 'string' && replacesDraftId ? { replacesDraftId } : {}) });
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
  app.get('/api/coordination/calibration', async () => getCoordinationCalibration());
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
      completionEvaluations: listCompletionEvaluations(req.params.runId),
      completionCandidates: listCompletionCandidates(req.params.runId),
      successorObligations: listSuccessorObligations(req.params.runId),
      evidenceBundles: listEvidenceBundles(req.params.runId),
      routeGuardEvents: listRouteGuardEvents(req.params.runId),
      durableHolds: listDurableHolds(req.params.runId),
      wakeEvents: listRuntimeWakeEvents(req.params.runId),
      holdRecoveryAudits: listRuntimeHoldRecoveryAudits(req.params.runId),
      responsibilitySnapshots: listResponsibilitySnapshots(req.params.runId),
      actionCommands: listRuntimeActionCommands(req.params.runId),
      shadowComparisons: listRuntimeShadowComparisons(req.params.runId),
      terminal: getRunTerminal(req.params.runId),
      runtimeKernel: getCoordinationKernelStatus(req.params.runId),
    };
  });
  // AG-COORD-04：恢复/取消审批暂停中的 Coordination run（后台续跑，不阻塞响应；失败已落库）
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/coordination/resume', async req => {
    if (!getRunCoordinationPlan(req.params.runId)) throw httpError(404, '该 Run 没有关联 Coordination Plan');
    return applyRunAction(req.params.runId, 'resume');
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/coordination/pause', async (req, reply) => {
    if (!getRunCoordinationPlan(req.params.runId)) throw httpError(404, '该 Run 没有关联 Coordination Plan');
    const result = await applyRunAction(req.params.runId, 'pause');
    if (result.status !== 'waiting_for_user') reply.code(202);
    return result;
  });
  app.post<{ Params: { runId: string }; Body: { instruction?: string; requestedProtocol?: string } }>('/api/runs/:runId/coordination/revisions', async (req, reply) => {
    const { instruction, requestedProtocol } = req.body ?? {};
    if (typeof instruction !== 'string' || !instruction.trim()) throw httpError(400, 'instruction 必填');
    if (requestedProtocol !== undefined && !isProtocolId(requestedProtocol)) throw httpError(400, 'requestedProtocol 不受支持');
    try {
      const result = await reviseCoordinationPlan(req.params.runId, { instruction, ...(requestedProtocol ? { requestedProtocol } : {}) });
      reply.code(201);
      return result;
    } catch (error) {
      if (error instanceof CoordinationError) throw httpError(error.status, error.message);
      throw error;
    }
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/coordination/cancel', async req => {
    if (!getRunCoordinationPlan(req.params.runId)) throw httpError(404, '该 Run 没有关联 Coordination Plan');
    return applyRunAction(req.params.runId, 'cancel');
  });

  app.post<{ Body: unknown }>('/api/agents/validate', async (req) => ({ valid: true, normalized: validateAgentInput(req.body) }));
  app.post<{ Body: AgentSaveInput }>('/api/agents', async (req, reply) => {
    if (req.body?.enabled !== false && (req.body?.accountRef || req.body?.enabled === true)) {
      const result = await preflightAgent(validateAgentInput(req.body));
      if (!result.ok) throw new AccountError(409, '请修复连接，或保存为停用草稿', result.issues);
    }
    const agent = registry.createAgent(req.body); reply.code(201); return agent;
  });
  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req) => { const agent = registry.getAnyAgent(req.params.id); if (!agent) throw httpError(404, `角色不存在: ${req.params.id}`); return agent; });
  app.get<{ Params: { id: string } }>('/api/agents/:id/versions', async (req) => { if (!registry.getAnyAgent(req.params.id)) throw httpError(404, `角色不存在: ${req.params.id}`); return registry.listVersions(req.params.id); });
  app.patch<{ Params: { id: string }; Body: AgentSaveInput & { expectedVersion?: number } }>('/api/agents/:id', async (req) => {
    if (!Number.isInteger(req.body?.expectedVersion)) throw httpError(400, 'expectedVersion 必填');
    const current = registry.getAnyAgent(req.params.id);
    if ((req.body.enabled ?? current?.enabled) && (req.body.accountRef || req.body.enabled === true)) {
      const result = await preflightAgent(validateAgentInput({ ...req.body, id: req.params.id }));
      if (!result.ok) throw new AccountError(409, '请修复连接，或保存为停用草稿', result.issues);
    }
    return registry.updateAgent(req.params.id, req.body, req.body.expectedVersion!);
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; expectedVersion?: number } }>('/api/agents/:id/status', async (req) => {
    if (typeof req.body?.enabled !== 'boolean') throw httpError(400, 'enabled 必填');
    if (req.body.enabled) {
      const current = registry.getAnyAgent(req.params.id);
      if (!current) throw httpError(404, '角色不存在');
      const result = await preflightAgent(validateAgentInput(current));
      if (!result.ok) throw new AccountError(409, '连接尚不可用，请编辑角色或修复账户', result.issues);
    }
    return registry.setEnabled(req.params.id, req.body.enabled, req.body.expectedVersion);
  });

  // ---- 聊天室：一个房间包含多轮 Run ----

  app.post<{ Body: unknown }>('/api/conversations/empty', async (req,reply) => { reply.code(201); return { conversation: createEmptyRoom(req.body) }; });
  app.get('/api/orchestration/members', async () => ({ reservations: memberQueue() }));
  app.get<{ Params: { id: string }; Querystring: { runIds?: string } }>('/api/conversations/:id/task-state', async req => {
    if (!getConversation(req.params.id)) throw httpError(404,'聊天室不存在');
    const ids = parseHistory(() => historyRunIds(req.query.runIds));
    return { tasks: listRunsByConversation(req.params.id).filter(item => !ids || ids.has(item.id)).map(item => {
      const plan = getRunCoordinationPlan(item.id);
      const control = get<{ pause_requested: number; recovery_attention: number; reason: string | null }>('SELECT * FROM orchestration_run_controls WHERE run_id=?', item.id);
      const unknown = Boolean(control?.recovery_attention || get("SELECT id FROM external_agent_executions WHERE run_id=? AND status='interrupted' LIMIT 1",item.id));
      const snapshot = getRunOrchestrationSnapshot(item.id);
      const writeStarted = snapshot?.execution?.readonly === false && Boolean(get('SELECT id FROM coordination_step_attempts WHERE run_id=? LIMIT 1',item.id));
      const latestPreview = plan && plan.revision > 1 ? get<{ payload: string }>("SELECT p.payload FROM orchestration_previews p JOIN coordination_plan_revisions r ON p.id=json_extract(r.payload,'$.confirmationPreviewId') WHERE r.plan_id=? AND r.revision=?",plan.id,plan.revision) : null;
      return { runId: item.id, revisedGoal: latestPreview ? JSON.parse(latestPreview.payload).preview.request.goal as string : null, revisionBlockedReason: writeStarted ? '写入任务已经开始，不能重建图；请检查变更后创建新任务。' : null, snapshot, planStatus: plan?.status ?? null,
        revision: plan?.revision ?? null, pauseRequested: Boolean(control?.pause_requested || plan?.status === 'pause_requested'),
        paused: item.status === 'waiting_for_user' && (plan?.status === 'paused' || Boolean(control?.pause_requested)),
        attention: unknown, reason: control?.reason ?? (unknown ? '原生执行结果未知，请核对工作区后创建新任务' : null),
        reservations: memberQueue(item.id) };
    }) };
  });
  app.patch<{ Params: { id: string }; Body: { preferences?: unknown; expectedMembersVersion?: number } }>('/api/conversations/:id/preferences', async req => {
    const room = getConversation(req.params.id); if (!room || room.archivedAt) throw httpError(404,'聊天室不存在或已归档');
    if (!Number.isInteger(req.body?.expectedMembersVersion)) throw httpError(400,'expectedMembersVersion 必填');
    const preferences = validateRoomPreferences(req.body.preferences,room.agentIds);
    const updated = updateRoomPreferences(room.id,preferences,req.body.expectedMembersVersion!);
    if (!updated) throw httpError(409,'房间设置已改变，请刷新后重试'); return updated;
  });
  app.get('/api/conversations', async () => listConversations());
  app.post<{ Body: Record<string, unknown> }>('/api/conversations', async (req, reply) => {
    const result = usesExecutionEntry(req.body ?? {}) ? submitExecutionOrchestration(req.body) : submitLegacyOrchestration('room_create', req.body);
    if (!result.deduplicated) enqueueConversationRun(result.run.id);
    reply.code(result.deduplicated ? 200 : 201);
    return { run: result.run, conversation: result.conversation, plan: result.plan };
  });
  app.get<{ Params: { id: string }; Querystring: { includeMessages?: string } }>('/api/conversations/:id', async (req) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    return { conversation, runs: listRunsByConversation(conversation.id), messages: req.query.includeMessages === 'false' ? [] : listByConversation(conversation.id) };
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string; before?: string; after?: string; around?: string } }>('/api/conversations/:id/history', async req => {
    if (!getConversation(req.params.id)) throw httpError(404,'聊天室不存在');
    return parseHistory(() => conversationHistoryPage(req.params.id,req.query));
  });
  app.get<{ Params: { id: string }; Querystring: { q?: string; after?: string; limit?: string; scope?: string } }>('/api/conversations/:id/history/search', async req => {
    if (!getConversation(req.params.id)) throw httpError(404,'聊天室不存在');
    return parseHistory(() => searchConversationMessages(req.params.id,req.query));
  });
  app.get<{ Params: { id: string }; Querystring: { runIds?: string } }>('/api/conversations/:id/collaboration', async (req) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    const ids = parseHistory(() => historyRunIds(req.query.runIds));
    const runs = listRunsByConversation(conversation.id).filter((item) => item.mode === 'collaboration' && (!ids || ids.has(item.id)));
    return { runs: runs.map((item) => ({ run: item, dispatches: listCollaborationDispatches(item.id), attempts: listCollaborationAttempts(item.id), batches: listCollaborationBatches(item.id), decisions: listCollaborationDecisions(item.id),
      completionCandidates: listCompletionCandidates(item.id), successorObligations: listSuccessorObligations(item.id),
      evidenceBundles: listEvidenceBundles(item.id), routeGuardEvents: listRouteGuardEvents(item.id),
      durableHolds: listDurableHolds(item.id), wakeEvents: listRuntimeWakeEvents(item.id),
      holdRecoveryAudits: listRuntimeHoldRecoveryAudits(item.id),
      responsibilitySnapshots: listResponsibilitySnapshots(item.id),
      actionCommands: listRuntimeActionCommands(item.id),
      shadowComparisons: listRuntimeShadowComparisons(item.id),
      terminal: getRunTerminal(item.id),
      budget: budgetSnapshot(item.id) })) };
  });
  app.patch<{ Params: { id: string }; Body: { title?: string; agentIds?: string[]; supervisorId?: string; defaultReviewerId?: string; expectedMembersVersion?: number } }>('/api/conversations/:id', async (req) => {
    if (req.body?.agentIds) {
      const current = getConversation(req.params.id); if (!current) throw httpError(404, `聊天室不存在: ${req.params.id}`);
      if (!Number.isInteger(req.body.expectedMembersVersion)) throw httpError(400, 'expectedMembersVersion 必填');
      if (!Array.isArray(req.body.agentIds) || req.body.agentIds.length === 0 || !req.body.agentIds.every((id) => typeof id === 'string')) throw httpError(400, 'agentIds 必须是非空字符串数组');
      // A room is a candidate team, independent of its historical mode. Validate default roles
      // only as future preferences; removing them requires reconfiguration of a later task.
      const ids = req.body.agentIds;
      if (new Set(ids).size !== ids.length || ids.some(id => !registry.getAgent(id))) throw httpError(400,'候选团队包含重复、未知或停用的成员');
      const supervisorId = req.body.supervisorId !== undefined ? req.body.supervisorId : current.preferences?.supervisorId ?? current.supervisorId;
      const reviewerId = req.body.defaultReviewerId !== undefined ? req.body.defaultReviewerId : current.preferences?.defaultReviewerId ?? current.defaultReviewerId;
      const supervisor = supervisorId && ids.includes(supervisorId) ? registry.getAgent(supervisorId) : null;
      const reviewer = reviewerId && ids.includes(reviewerId) ? registry.getAgent(reviewerId) : null;
      if (req.body.supervisorId && (!supervisor?.capabilities.includes('coordinate') || supervisor.execution?.kind === 'external')) throw httpError(400,'默认主管必须属于团队且具备模型 API 协调能力');
      if (req.body.defaultReviewerId && !reviewer?.capabilities.includes('review')) throw httpError(400,'默认评审者必须属于团队且具备审查能力');
      const updated = updateConversationMembers(current.id, { agentIds: ids, supervisorId: supervisor?.id ?? null, defaultReviewerId: reviewer?.id ?? null, expectedMembersVersion: req.body.expectedMembersVersion! });
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
  app.post<{ Params: { id: string }; Body: { body?: string; recipientIds?: string[]; replyTo?: string | null; wholeTeam?: boolean } }>('/api/conversations/:id/followup-preview', async (req): Promise<FollowupPreview> => {
    assertLegacyAdmission();
    const conversation = getConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    const goal = req.body?.body?.trim();
    if (!goal) throw httpError(400, 'body 必填');
    const recipientIds = req.body?.recipientIds ?? [];
    if (!Array.isArray(recipientIds) || !recipientIds.every((id) => typeof id === 'string' && conversation.agentIds.includes(id))) throw httpError(400, 'recipientIds 必须属于当前聊天室');
    if (req.body?.wholeTeam !== undefined && typeof req.body.wholeTeam !== 'boolean') throw httpError(400, 'wholeTeam 无效');
    const wholeTeam = req.body?.wholeTeam === true;
    prepareOrchestration({ goal, conversationId: conversation.id, recipientIds, replyTo: req.body?.replyTo, wholeTeam }, 'followup_preview', { conversation });
    const reply = req.body?.replyTo ? listByConversation(conversation.id).find((message) => message.id === req.body?.replyTo) : undefined;
    if (req.body?.replyTo && !reply) throw httpError(400, 'replyTo 不属于当前聊天室');
    const directed = recipientIds.length > 0 || Boolean(reply && reply.kind === 'agent');
    if (wholeTeam && directed) throw httpError(400, '全队处理不能同时定向单个成员');
    if (conversation.mode === 'collaboration' && !wholeTeam) return { kind: 'none', roomMode: conversation.mode, preview: null };
    const explicitOpenCollaboration = /(?:自由协作|自由讨论|开放探索|开放式讨论)/u.test(goal);
    const structured = isStructuredFollowupGoal(goal);
    if (directed && !structured) return { kind: 'none', roomMode: conversation.mode, preview: null };
    const prepared = await prepareCoordination({ goal, agentIds: conversation.agentIds,
      ...(conversation.defaultReviewerId ? { defaultReviewerId: conversation.defaultReviewerId } : {}),
      ...(explicitOpenCollaboration ? { requestedProtocol: 'dynamic_collaboration' as const }
        : wholeTeam && !structured ? { requestedProtocol: 'sequential_pipeline' as const } : {}),
      deterministicOnly: structured || explicitOpenCollaboration || wholeTeam || directed });
    const expectedProtocol = conversation.mode === 'pipeline' ? 'sequential_pipeline'
      : conversation.mode === 'supervisor' ? 'supervisor_dag' : 'dynamic_collaboration';
    const mismatch = (structured || explicitOpenCollaboration)
      && (prepared.draft.protocols.length !== 1 || prepared.draft.protocols[0]?.protocol !== expectedProtocol);
    const modelStructured = !structured && !wholeTeam && ['model', 'model_repaired'].includes(prepared.draft.planning.source)
      && prepared.draft.protocols.some((item) => !['single_agent', 'dynamic_collaboration'].includes(item.protocol));
    const safeToStart = prepared.draft.decision === 'auto_start' && prepared.draft.runtimeMode !== null
      && prepared.draft.validationErrors.length === 0 && prepared.plan.validationIssues.every((item) => item.severity !== 'error');
    const coversWholeTeam = !wholeTeam || conversation.agentIds.every((id) => prepared.plan.steps.some((step) => step.agentId === id));
    const kind: FollowupPreview['kind'] = explicitOpenCollaboration && mismatch ? 'mode_mismatch'
      : prepared.draft.decision === 'clarify' ? 'ambiguous'
      : (wholeTeam || modelStructured) && safeToStart && coversWholeTeam ? 'auto_plan'
      : mismatch ? 'mode_mismatch'
        : wholeTeam || modelStructured ? 'needs_confirmation'
        : structured && prepared.draft.decision !== 'auto_start' ? 'needs_confirmation' : 'none';
    if (kind === 'none') return { kind, roomMode: conversation.mode, preview: null };
    savePlanningResult(prepared.snapshot, prepared.draft, prepared.plan);
    return { kind, roomMode: conversation.mode, preview: prepared };
  });
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/conversations/:id/messages', async (req, reply) => {
    const result = usesExecutionEntry(req.body ?? {}) ? submitExecutionOrchestration(req.body, req.params.id) : submitLegacyOrchestration('conversation_message', req.body, req.params.id);
    if (!result.deduplicated) enqueueConversationRun(result.run.id);
    reply.code(result.deduplicated ? 200 : 202);
    return { run: result.run, message: result.message };
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/collaboration', async (req) => {
    const item = getRun(req.params.runId);
    if (!item) throw httpError(404, `Run 不存在: ${req.params.runId}`);
    if (item.mode !== 'collaboration') throw httpError(409, 'Run 不是 collaboration 模式');
    const attempts = listCollaborationAttempts(item.id);
    return { dispatches: listCollaborationDispatches(item.id), attempts, batches: listCollaborationBatches(item.id), decisions: listCollaborationDecisions(item.id),
      completionCandidates: listCompletionCandidates(item.id),
      successorObligations: listSuccessorObligations(item.id),
      evidenceBundles: listEvidenceBundles(item.id), routeGuardEvents: listRouteGuardEvents(item.id),
      durableHolds: listDurableHolds(item.id), wakeEvents: listRuntimeWakeEvents(item.id),
      holdRecoveryAudits: listRuntimeHoldRecoveryAudits(item.id),
      responsibilitySnapshots: listResponsibilitySnapshots(item.id),
      actionCommands: listRuntimeActionCommands(item.id),
      shadowComparisons: listRuntimeShadowComparisons(item.id),
      terminal: getRunTerminal(item.id),
      completionEvaluations: listCompletionEvaluations(item.id),
      activeAgents: attempts.filter((attempt) => attempt.status === 'running').map((attempt) => ({ agentId: attempt.agentId, dispatchId: attempt.dispatchId, startedAt: attempt.startedAt ?? attempt.createdAt })),
      budget: budgetSnapshot(item.id) };
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/responsibility', async (req) => {
    if (!getRun(req.params.runId)) throw httpError(404, `Run 不存在: ${req.params.runId}`);
    return { snapshots: listResponsibilitySnapshots(req.params.runId) };
  });
  app.get<{ Params: { id: string } }>('/api/collaboration/dispatches/:id', async (req) => {
    const item = getDispatch(req.params.id); if (!item) throw httpError(404, 'Dispatch 不存在'); return item;
  });
  app.post<{ Params: { id: string } }>('/api/collaboration/dispatches/:id/cancel', async (req) => {
    const item = cancelDispatch(req.params.id); if (!item) throw httpError(404, 'Dispatch 不存在'); settleCollaborationRun(item.runId); await stopExternalRun(item.runId, item.targetAgentId); return item;
  });
  app.post<{ Params: { runId: string } }>('/api/collaboration/runs/:runId/stop', async req => applyRunAction(req.params.runId, 'cancel'));
  app.post<{ Params: { agentId: string }; Body: { conversationId?: string; runId?: string } }>('/api/collaboration/agents/:agentId/stop', async req => {
    const runId = req.body?.runId;
    if (typeof runId !== 'string') throw httpError(409, '停止成员必须指定 runId，避免取消同聊天室的其他任务');
    const item = getRun(runId);
    if (!item) throw httpError(404, 'Run 不存在');
    if (item.conversationId !== req.body?.conversationId || !item.agentIds.includes(req.params.agentId)) throw httpError(400, '成员或聊天室与 Run 不一致');
    const cancelled = cancelAgentWork(item.conversationId, req.params.agentId, runId);
    await stopExternalRun(runId, req.params.agentId);
    settleCollaborationRun(runId);
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
  app.post<{ Params: { id: string } }>('/api/tasks/:id/retry', async req => retryTaskExecution(req.params.id));
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async req => cancelTaskExecution(req.params.id));

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

  app.post<{ Body: Record<string, unknown> }>('/api/runs', async (req, reply) => {
    const result = usesExecutionEntry(req.body ?? {}) ? submitExecutionOrchestration(req.body, undefined, 'direct_run') : submitLegacyOrchestration('direct_run', req.body);
    if (!result.deduplicated) enqueueConversationRun(result.run.id);
    reply.code(result.deduplicated ? 200 : 201);
    return { run: result.run, conversation: result.conversation };
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
  app.post<{ Body: { path?: string; label?: string; trusted?: boolean } }>('/api/workspaces/register', async (req) => {
    const { path: p, label, trusted } = req.body ?? {};
    if (typeof p !== 'string' || p.length === 0) throw httpError(400, 'path 必填');
    try {
      return registerExternal({ path: p, label, trusted: trusted === true });
    } catch (err) {
      if (err instanceof ExternalWorkspaceError) throw httpError(err.status, err.message);
      throw err;
    }
  });
  app.post<{ Params: { id: string }; Body: { trusted?: boolean } }>('/api/workspaces/register/:id/trust', async (req) => {
    if (typeof req.body?.trusted !== 'boolean') throw httpError(400, 'trusted 必填');
    try {
      return setExternalTrusted(req.params.id, req.body.trusted);
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

  app.get<{ Params: { id: string }; Querystring: { includeMessages?: string } }>('/api/runs/:id', async (req) => {
    const detail = runDetail(req.params.id,req.query.includeMessages !== 'false');
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
        recoverDurableHolds(approval.runId);
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

function parseHistory<T>(read: () => T): T { try { return read(); } catch (reason) { if (reason instanceof HistoryInputError) throw httpError(reason.status,reason.message); throw reason; } }
