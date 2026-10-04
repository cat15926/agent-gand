import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { ExternalAgentExecution, CollaborationStoredControlAction } from '@agent-gand/shared';
import type { AgentTurnOptions } from '../orchestration/agentStep.ts';
import { getTool } from '../tools/builtin/index.ts';
import { checkPermission } from '../tools/types.ts';
import { executeToolOnce } from '../tools/executions.ts';
import { startSpan, endSpan } from '../runs/trace.ts';
import { executionAuthorized } from './authority.ts';
import { nativeApprovalGate } from './approvals.ts';
import { ExecutionError, diagnostic } from './errors.ts';

export const BRIDGE_NAME = 'agent_gand';
export interface BridgeLaunch { command: string; args: string[]; env: Record<string, string>; toolNames: string[] }
export interface ExecutionBridge {
  launch: BridgeLaunch;
  candidate: Promise<void>;
  action(): CollaborationStoredControlAction | null;
  sealed(): boolean;
  close(): Promise<void>;
}

/** Only prepares a candidate. The owning scheduler commits after native cleanup. */
export async function createExecutionBridge(opts: AgentTurnOptions, execution: ExternalAgentExecution,
  signal: AbortSignal, controlOnly: boolean): Promise<ExecutionBridge> {
  const lifetime = new AbortController();
  signal = AbortSignal.any([signal, lifetime.signal]);
  const agent = { ...opts.agent, permissionMode: execution.permissionMode ?? opts.agent.permissionMode };
  const validator = new AjvJsonSchemaValidator();
  const control = (opts.controlTools ?? []).map((tool) => ({ name: tool.name.replace('.', '_'), original: tool.name,
    description: tool.description, inputSchema: tool.parameters, control: true }));
  const exposed = !controlOnly && opts.agent.execution?.kind === 'external' ? opts.agent.execution.platformTools ?? [] : [];
  const ordinary = exposed.flatMap((name) => {
    const tool = getTool(name);
    return tool && checkPermission(agent, name) !== 'deny' ? [{ name: 'platform_' + Buffer.from(name).toString('hex'), original: name,
      description: `${name}: ${tool.description}`, inputSchema: tool.inputSchema, control: false }] : [];
  });
  const tools = [...control, ...ordinary];
  const entries = new Map(tools.map((tool) => [tool.name, { ...tool, validate: validator.getValidator(tool.inputSchema) }]));
  const token = randomBytes(32).toString('hex');
  let closed = false; let action: CollaborationStoredControlAction | null = null;
  let resolveCandidate!: () => void;
  const candidate = new Promise<void>((resolve) => { resolveCandidate = resolve; });
  const requests = new Map<string, { hash: string; result: Promise<unknown> }>();
  let ordinaryActive = false;
  const approval = nativeApprovalGate(execution, signal);
  const valid = () => !closed && !signal.aborted && executionAuthorized(execution);
  const assertValid = () => { if (!valid()) throw new ExecutionError('cancelled', '执行凭据或责任代际已失效'); };
  const invoke = async (body: Record<string, unknown>) => {
    assertValid();
    if (Object.keys(body).some((key) => !['requestId', 'name', 'arguments'].includes(key)) || typeof body.requestId !== 'string' || body.requestId.length > 256 || typeof body.name !== 'string') throw new Error('回调封装无效');
    const hash = createHash('sha256').update(JSON.stringify([body.name, body.arguments])).digest('hex');
    const existing = requests.get(body.requestId);
    if (existing) { if (existing.hash !== hash) throw new Error('同一请求 ID 不能替换操作'); return existing.result; }
    if (action) throw new Error('本回合已提交动作候选，不能继续调用工具');
    if (requests.size >= 128) throw new Error('执行桥请求次数超限');
    if (controlOnly && Buffer.byteLength(JSON.stringify(body.arguments ?? {})) > (opts.exitCorrectionMaxTokens ?? 2048)) throw new Error('纠偏参数超过平台输出限制');
    const tool = entries.get(body.name);
    if (!tool) throw new Error('工具未在当前执行中开放');
    const checked = tool.validate(body.arguments);
    if (!checked.valid) throw new Error('工具参数不符合冻结 schema：' + checked.errorMessage);
    // Explicitly reject authority-looking fields even for a permissive business schema.
    if (body.arguments && typeof body.arguments === 'object' && ['runId', 'agentId', 'attemptId', 'subjectId', 'generation', 'claimToken', 'commandKey', 'executionId', 'workspace', 'policy'].some((key) => Object.hasOwn(body.arguments as object, key) && !Object.hasOwn((tool.inputSchema.properties ?? {}) as object, key))) throw new Error('工具参数不能携带执行权威字段');
    const result = (async () => {
      const span = startSpan(execution.runId, { parentId: opts.parentSpanId, spanKind: tool.control ? 'orchestration' : 'tool', name: `bridge:${tool.original}`,
        input: diagnostic(JSON.stringify(body.arguments), 128 * 1024), attributes: { 'agent.id': execution.agentId, 'execution.id': execution.id, 'tool.bridge': true, 'execution.control_only': controlOnly } });
      try {
        if (tool.control) {
          if (ordinaryActive) throw new Error('业务工具尚未收敛，暂不能提交控制动作');
          if (!opts.handleControlCalls) throw new Error('当前回合未开放 Runtime 控制');
          // parseControlCall is the existing domain parser; no state mutation here.
          const parsed = opts.handleControlCalls([{ name: tool.original, input: JSON.stringify(body.arguments) }]);
          assertValid(); action = parsed;
          endSpan(span, { output: JSON.stringify({ status: 'candidate', action: parsed.type }) });
          return { content: [{ type: 'text', text: '动作候选已接收。当前原生回合将结束；平台会在进程收敛后校验并提交。' }] };
        }
        if (ordinaryActive) throw new Error('执行桥业务工具串行执行，请等待当前工具完成');
        ordinaryActive = true;
        try {
          const nativeTool = getTool(tool.original);
          const decision = checkPermission(agent, tool.original);
          if (!nativeTool || decision === 'deny') throw new Error('业务工具权限已拒绝');
          if (decision === 'need_approval' && !await approval('bridge:' + body.requestId, tool.original, body.arguments)) throw new Error('用户拒绝业务工具');
          assertValid();
          const value = await executeToolOnce({ runId: execution.runId, agentId: execution.agentId, attemptId: opts.attemptId, taskId: opts.taskId,
            toolName: tool.original, input: JSON.stringify(body.arguments), idempotencyKey: `external:${execution.id}:${body.requestId}`,
            replayPolicy: nativeTool.replayPolicy ?? 'manual', spanId: span.id,
            execute: () => { assertValid(); return nativeTool.run(body.arguments, { runId: execution.runId, agentId: execution.agentId, workspace: opts.run.workspace, workspaceScope: opts.workspaceScope, workspaceRoot: opts.workspaceRoot }); } });
          assertValid(); endSpan(span, { output: value.output });
          return { content: [{ type: 'text', text: value.output }] };
        } finally { ordinaryActive = false; }
      } catch (error) {
        const message = diagnostic(error instanceof Error ? error.message : String(error));
        endSpan(span, { status: 'error', output: message });
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    })();
    requests.set(body.requestId, { hash, result }); return result;
  };
  const server = createServer((request, response) => { void (async () => {
    try {
      const credential = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from('Bearer ' + token);
      if (credential.length !== expected.length || !timingSafeEqual(credential, expected) || request.headers.origin || !valid()) { response.writeHead(403).end(); return; }
      if (request.method === 'GET' && request.url === '/tools') {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })); return;
      }
      if (request.method !== 'POST' || request.url !== '/call') { response.writeHead(404).end(); return; }
      let encoded = ''; for await (const chunk of request) { encoded += chunk.toString(); if (Buffer.byteLength(encoded) > 128 * 1024) { response.writeHead(413).end(); return; } }
      const body: unknown = JSON.parse(encoded);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须为对象');
      const result = await invoke(body as Record<string, unknown>);
      response.setHeader('content-type', 'application/json');
      if (action) response.once('finish', resolveCandidate);
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: diagnostic(error instanceof Error ? error.message : String(error)) })); }
  })(); });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('执行桥无法监听');
  return {
    launch: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./bridgeWorker.ts', import.meta.url))],
      env: { AGENT_GAND_BRIDGE_URL: `http://127.0.0.1:${address.port}/`, AGENT_GAND_BRIDGE_TOKEN: token }, toolNames: tools.map((tool) => tool.name) },
    candidate, action: () => action, sealed: () => !!action || !valid(),
    async close() {
      closed = true; lifetime.abort();
      // Native process has already been reaped by the caller. Settle any owned business operation too.
      await Promise.allSettled([...requests.values()].map((item) => item.result));
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
