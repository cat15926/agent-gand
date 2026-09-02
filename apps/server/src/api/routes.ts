/**
 * REST API（规格 §4.3 全部端点）
 */
import type { FastifyInstance } from 'fastify';
import type { AgentDefinition, MessageKind, RunMode } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { ApprovalError, decide as decideApproval, listApprovals } from '../hitl/approvals.ts';
import { post as postMessage, listByRun } from '../messaging/inbox.ts';
import { claimTask, completeTask, createTask, listTasks, TaskError } from '../messaging/tasks.ts';
import { pipelineOrchestrator } from '../orchestration/pipeline.ts';
import { supervisorOrchestrator } from '../orchestration/supervisor.ts';
import type { Orchestrator } from '../orchestration/types.ts';
import {
  countRuns,
  createRun,
  listRuns,
  runDetail,
  usageSummary,
} from '../runs/trace.ts';

const MESSAGE_KINDS: readonly MessageKind[] = ['user', 'agent', 'system', 'tool'];
const RUN_MODES: readonly RunMode[] = ['pipeline', 'supervisor'];

/** 带状态码的错误（errorHandler 统一映射） */
function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
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

  app.post<{ Params: { id: string }; Body: { agentId?: string } }>(
    '/api/tasks/:id/complete',
    async (req) => {
      const agentId = req.body?.agentId;
      if (typeof agentId !== 'string' || agentId.length === 0) throw httpError(400, 'agentId 必填');
      return completeTask(req.params.id, agentId);
    },
  );

  // ---- 消息 ----

  app.get<{ Querystring: { runId?: string } }>('/api/messages', async (req) => {
    if (!req.query.runId) throw httpError(400, 'runId 必填');
    return listByRun(req.query.runId);
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

  app.post<{ Body: { goal?: string; mode?: string; agentIds?: string[] } }>('/api/runs', async (req, reply) => {
    const { goal, mode, agentIds } = req.body ?? {};
    if (typeof goal !== 'string' || goal.length === 0) throw httpError(400, 'goal 必填');
    if (mode !== 'pipeline' && mode !== 'supervisor') {
      throw httpError(400, `mode 必须是 ${RUN_MODES.join('|')}`);
    }
    if (!Array.isArray(agentIds) || agentIds.length === 0 || !agentIds.every((a) => typeof a === 'string')) {
      throw httpError(400, 'agentIds 必须是非空字符串数组');
    }
    const agents: AgentDefinition[] = [];
    const missing: string[] = [];
    for (const id of agentIds) {
      const agent = registry.getAgent(id);
      if (agent) agents.push(agent);
      else missing.push(id);
    }
    if (missing.length > 0) throw httpError(400, `未知 agent: ${missing.join(', ')}`);
    const run = createRun(goal, mode, agentIds);
    const orchestrator: Orchestrator = mode === 'supervisor' ? supervisorOrchestrator : pipelineOrchestrator;
    // 异步执行：进度经 WS / GET 获取；失败由编排器置 failed
    void orchestrator.start(run, agents, goal).catch((err: unknown) => {
      req.log.error(`run ${run.id} 执行异常: ${err instanceof Error ? err.message : String(err)}`);
    });
    reply.code(201);
    return { run };
  });

  app.get('/api/runs', async () => listRuns());

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
