/**
 * REST API（规格 §4.3 全部端点）
 */
import type { FastifyInstance } from 'fastify';
import type { AgentDefinition, AgentMessageType, MessageKind, RunMode } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { ApprovalError, decide as decideApproval, listApprovals } from '../hitl/approvals.ts';
import { post as postMessage, listMessages } from '../messaging/inbox.ts';
import { listByConversation } from '../messaging/inbox.ts';
import { cancelTask, claimTask, completeTask, createTask, getTask, listTasks, retryTask, TaskError } from '../messaging/tasks.ts';
import { listAttempts } from '../tasks/attempts.ts';
import { listReviews } from '../tasks/reviews.ts';
import { resumeSupervisorRun } from '../orchestration/supervisor.ts';
import { archiveConversation, createConversation, getConversation, listConversations, nextTurnNo, renameConversation, touchConversation } from '../conversations/service.ts';
import { enqueueConversationRun } from '../conversations/dispatcher.ts';
import {
  countRuns,
  createRun,
  getRun,
  listRunsByConversation,
  listRuns,
  renameRun,
  runDetail,
  softDeleteRun,
  usageSummary,
} from '../runs/trace.ts';
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
const MESSAGE_TYPES: readonly AgentMessageType[] = ['assignment', 'result', 'review_request', 'review_result', 'revision_request', 'handoff', 'informational'];
const RUN_MODES: readonly RunMode[] = ['pipeline', 'supervisor'];
/** 命名工作区名（§10.2）：与 resolver 侧同规 */
const WORKSPACE_RE = /^[\w-]{1,32}$/;

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
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { status?: number }).status;
    const code = typeof status === 'number' ? status : 500;
    if (code >= 500) req.log.error(err);
    reply.code(code).send({ error: err instanceof Error ? err.message : String(err) });
  });

  app.get('/api/health', async () => ({
    ok: true,
    agents: registry.count(),
    runs: countRuns(),
  }));

  app.get('/api/agents', async () => registry.list());

  // ---- 聊天室：一个房间包含多轮 Run ----

  app.get('/api/conversations', async () => listConversations());
  app.post<{ Body: { goal?: string; mode?: string; agentIds?: string[]; supervisorId?: string; workspace?: string } }>('/api/conversations', async (req, reply) => {
    const { goal, mode, agentIds, supervisorId, workspace } = req.body ?? {};
    if (typeof goal !== 'string' || goal.trim().length === 0) throw httpError(400, 'goal 必填');
    if (mode !== 'pipeline' && mode !== 'supervisor') throw httpError(400, `mode 必须是 ${RUN_MODES.join('|')}`);
    if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((id) => typeof id === 'string' && registry.getAgent(id))) throw httpError(400, 'agentIds 包含未知成员');
    const effectiveSupervisorId = mode === 'supervisor' ? (supervisorId ?? agentIds[0] ?? null) : null;
    if (mode === 'supervisor' && (!effectiveSupervisorId || !agentIds.includes(effectiveSupervisorId))) throw httpError(400, 'supervisorId 必须属于 agentIds');
    if (workspace && (isExternalWorkspace(workspace) ? !getExternal(externalId(workspace)!) : !WORKSPACE_RE.test(workspace))) throw httpError(400, 'workspace 无效或未注册');
    const conversation = createConversation({ title: goal.trim().slice(0, 80), mode, agentIds, supervisorId: effectiveSupervisorId, workspace: workspace || null, stableWorkspace: true });
    const run = createRun(goal.trim(), mode, agentIds, conversation.workspace, effectiveSupervisorId, conversation.id, 1);
    touchConversation(conversation.id);
    enqueueConversationRun(run.id);
    reply.code(201);
    return { run, conversation: getConversation(conversation.id)! };
  });
  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (req) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) throw httpError(404, `聊天室不存在: ${req.params.id}`);
    return { conversation, runs: listRunsByConversation(conversation.id), messages: listByConversation(conversation.id) };
  });
  app.patch<{ Params: { id: string }; Body: { title?: string } }>('/api/conversations/:id', async (req) => {
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
      const existing = listByConversation(conversation.id).find((message) => message.clientMessageId === clientMessageId);
      if (existing) {
        const existingRun = getRun(existing.runId);
        reply.code(200);
        return { run: existingRun, message: existing };
      }
      if (replyTo && !listByConversation(conversation.id).some((message) => message.id === replyTo)) throw httpError(400, 'replyTo 不属于当前聊天室');
      if (taskId && !listTasks().some((task) => task.id === taskId && task.runId && getRun(task.runId)?.conversationId === conversation.id)) throw httpError(400, 'taskId 不属于当前聊天室');
      const turnNo = nextTurnNo(conversation.id);
      const run = createRun(body.trim(), conversation.mode, conversation.agentIds, conversation.workspace, conversation.supervisorId, conversation.id, turnNo);
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

  app.post<{ Body: { goal?: string; mode?: string; agentIds?: string[]; supervisorId?: string; workspace?: string } }>(
    '/api/runs',
    async (req, reply) => {
      const { goal, mode, agentIds, supervisorId, workspace } = req.body ?? {};
      if (typeof goal !== 'string' || goal.length === 0) throw httpError(400, 'goal 必填');
      if (mode !== 'pipeline' && mode !== 'supervisor') {
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
      const agents: AgentDefinition[] = [];
      const missing: string[] = [];
      for (const id of agentIds) {
        const agent = registry.getAgent(id);
        if (agent) agents.push(agent);
        else missing.push(id);
      }
      if (missing.length > 0) throw httpError(400, `未知 agent: ${missing.join(', ')}`);
      const effectiveSupervisorId = mode === 'supervisor' ? (supervisorId ?? agentIds[0] ?? null) : null;
      if (mode === 'supervisor' && (!effectiveSupervisorId || !agentIds.includes(effectiveSupervisorId))) {
        throw httpError(400, 'supervisorId 必须属于 agentIds');
      }
      const conversation = createConversation({
        title: goal.trim().slice(0, 80), mode, agentIds, supervisorId: effectiveSupervisorId, workspace: workspace || null,
      });
      const run = createRun(goal, mode, agentIds, conversation.workspace, effectiveSupervisorId, conversation.id, 1);
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
        return decideApproval(req.params.id, {
          decision,
          editedInput: typeof editedInput === 'string' ? editedInput : undefined,
          by: typeof by === 'string' && by.length > 0 ? by : 'user',
        });
      } catch (err) {
        if (err instanceof ApprovalError) throw httpError(err.status, err.message);
        throw err;
      }
    },
  );

  // ---- 用量 ----

  app.get('/api/usage', async () => usageSummary());
}
