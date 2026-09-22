/** 阶段 E：只读 Capability Registry MCP Server（stdio）。 */
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { CoordinationDraft, CoordinationPreviewInput } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { listTools } from '../tools/builtin/index.ts';
import { createCapabilitySnapshot } from './capabilities.ts';
import { buildCoordinationPlan } from './compiler.ts';
import { createCoordinationDraft } from './planner.ts';
import { getCapabilitySnapshot } from './store.ts';
import { getProtocol, isProtocolId, listProtocols } from './protocols.ts';
import { validateCoordinationPlan } from './validator.ts';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const capabilityRegistryTools: ToolDefinition[] = [
  { name: 'list_coordination_protocols', description: '列出当前注册的协作协议、版本和输入输出契约。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'get_coordination_protocol', description: '读取一个协作协议的完整定义。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'list_available_agents', description: '列出当前可用 Agent 的稳定 ID、能力和版本。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_agent_capabilities', description: '读取指定 Agent 的能力、工具和权限模式。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
  { name: 'list_available_tools', description: '列出服务端当前工具目录；不执行任何工具。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'estimate_coordination_plan', description: '使用只读能力快照确定性估算 Draft 与 Plan；不持久化也不启动 Run。', inputSchema: { type: 'object', properties: { goal: { type: 'string' }, agentIds: { type: 'array', items: { type: 'string' } }, defaultReviewerId: { type: 'string' }, requestedProtocol: { type: 'string' } }, required: ['goal', 'agentIds'], additionalProperties: false } },
  { name: 'validate_coordination_draft', description: '针对已保存能力快照校验 Draft 并返回编译后的 Plan 与问题；不写数据库。', inputSchema: { type: 'object', properties: { snapshotId: { type: 'string' }, draft: { type: 'object' } }, required: ['snapshotId', 'draft'], additionalProperties: false } },
];

function object(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

export async function callCapabilityRegistryTool(name: string, input: unknown): Promise<unknown> {
  const args = object(input);
  if (name === 'list_coordination_protocols') return listProtocols();
  if (name === 'get_coordination_protocol') {
    const protocol = isProtocolId(args.id) ? getProtocol(args.id) : undefined;
    if (!protocol) throw new Error(`协议不存在: ${String(args.id)}`);
    return protocol;
  }
  if (name === 'list_available_agents') return registry.list().map((agent) => ({ id: agent.id, name: agent.name, version: agent.version, capabilities: agent.capabilities, enabled: agent.enabled }));
  if (name === 'list_agent_capabilities') {
    const agent = typeof args.id === 'string' ? registry.getAnyAgent(args.id) : undefined;
    if (!agent) throw new Error(`Agent 不存在: ${String(args.id)}`);
    return { id: agent.id, name: agent.name, version: agent.version, capabilities: agent.capabilities, tools: agent.tools, permissionMode: agent.permissionMode, enabled: agent.enabled };
  }
  if (name === 'list_available_tools') return listTools().map((tool) => ({ name: tool.name, source: tool.source ?? 'builtin', description: tool.description }));
  if (name === 'estimate_coordination_plan') {
    if (typeof args.goal !== 'string' || !Array.isArray(args.agentIds) || !args.agentIds.every((item) => typeof item === 'string')) throw new Error('goal 和 agentIds 必填');
    if (args.requestedProtocol !== undefined && !isProtocolId(args.requestedProtocol)) throw new Error(`协议不存在: ${String(args.requestedProtocol)}`);
    const inputValue: CoordinationPreviewInput = {
      goal: args.goal,
      agentIds: args.agentIds as string[],
      ...(typeof args.defaultReviewerId === 'string' ? { defaultReviewerId: args.defaultReviewerId } : {}),
      ...(isProtocolId(args.requestedProtocol) ? { requestedProtocol: args.requestedProtocol } : {}),
    };
    const snapshot = createCapabilitySnapshot(inputValue.agentIds);
    const draft = createCoordinationDraft(inputValue, snapshot);
    const plan = buildCoordinationPlan(draft, snapshot);
    return { snapshot, draft, plan };
  }
  if (name === 'validate_coordination_draft') {
    const snapshot = typeof args.snapshotId === 'string' ? getCapabilitySnapshot(args.snapshotId) : undefined;
    if (!snapshot) throw new Error(`Capability Snapshot 不存在: ${String(args.snapshotId)}`);
    const draft = args.draft as CoordinationDraft;
    const plan = buildCoordinationPlan(draft, snapshot);
    return { valid: !validateCoordinationPlan(plan, draft, snapshot).some((item) => item.severity === 'error'), plan };
  }
  throw new Error(`未知 Capability Registry 工具: ${name}`);
}

function reply(id: unknown, result?: unknown, error?: { code: number; message: string }): void {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

async function serve(): Promise<void> {
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    void (async () => {
      let request: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try { request = JSON.parse(line) as typeof request; } catch { return; }
      if (request.id === undefined) return;
      try {
        if (request.method === 'initialize') {
          reply(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-gand-capability-registry', version: '1.0.0' } });
        } else if (request.method === 'ping') reply(request.id, {});
        else if (request.method === 'tools/list') reply(request.id, { tools: capabilityRegistryTools });
        else if (request.method === 'tools/call') {
          const name = request.params?.name;
          if (typeof name !== 'string') throw new Error('工具名必填');
          const value = await callCapabilityRegistryTool(name, request.params?.arguments);
          reply(request.id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
        } else reply(request.id, undefined, { code: -32601, message: 'Method not found' });
      } catch (error) {
        reply(request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (executedPath === fileURLToPath(import.meta.url)) await serve();
