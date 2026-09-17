/** MCP stdio 生命周期与统一工具注册。 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpStatus } from '@agent-gand/shared';
import { config } from '../../config.ts';
import { registerTool, unregisterTools } from '../builtin/index.ts';
import { ToolError, type Tool } from '../types.ts';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClient {
  readonly pid: number | null;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, input: unknown): Promise<string>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

let active: McpClient | null = null;
let connecting: Promise<McpClient> | null = null;
let generation = 0;
let status: McpStatus = {
  configured: Boolean(config.mcp.command), connected: false, tools: [], serverPid: null,
  lastError: null, connectedAt: null,
  lastSeenAt: null,
};
let heartbeat: ReturnType<typeof setInterval> | null = null;

function publicName(remoteName: string): string {
  const safe = remoteName.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
  if (!safe) throw new Error(`MCP 工具名无法注册: ${remoteName}`);
  return `mcp.${safe}`;
}

function stringifyResult(result: CallToolResult): string {
  if (result.isError) throw new ToolError(`MCP 工具返回错误: ${JSON.stringify(result.content).slice(0, 500)}`);
  const texts = (result.content ?? []).map((block) => block.type === 'text' ? block.text : null)
    .filter((text): text is string => text !== null);
  const out = texts.length > 0 ? texts.join('\n') : JSON.stringify(result);
  return out.slice(0, 10_000);
}

export async function connectMcp(
  cfg: { command: string; args: string[] },
  onClosed?: () => void,
): Promise<McpClient> {
  const client = new Client({ name: 'agent-gand', version: '0.1.0' }, {});
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, stderr: 'pipe' });
  transport.stderr?.on('data', (chunk) => process.stderr.write(`[mcp] ${String(chunk).slice(0, 2_000)}`));
  await client.connect(transport);
  client.onclose = () => onClosed?.();
  return {
    pid: transport.pid,
    async listTools(): Promise<McpToolInfo[]> {
      const result: ListToolsResult = await client.listTools();
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    },
    async callTool(name: string, input: unknown): Promise<string> {
      const args = input !== null && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown> : {};
      return stringifyResult(await client.callTool({ name, arguments: args }) as CallToolResult);
    },
    async ping(): Promise<void> { await client.ping(); },
    async close(): Promise<void> { await client.close(); },
  };
}

function invalidate(error?: unknown): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  generation += 1;
  active = null;
  connecting = null;
  status = { ...status, connected: false, serverPid: null, lastError: error ? (error instanceof Error ? error.message : String(error)) : status.lastError };
}

function armHeartbeat(client: McpClient, ownGeneration: number): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    void client.ping().then(() => {
      if (generation === ownGeneration) status = { ...status, lastSeenAt: new Date().toISOString() };
    }).catch((error) => {
      if (generation === ownGeneration) {
        invalidate(error);
        void client.close().catch(() => undefined);
      }
    });
  }, config.mcp.heartbeatMs);
  heartbeat.unref();
}

async function ensureClient(): Promise<McpClient> {
  if (!config.mcp.command) throw new ToolError('MCP_SERVER_CMD 未配置');
  if (active) return active;
  if (connecting) return connecting;
  const ownGeneration = generation;
  connecting = connectMcp({ command: config.mcp.command, args: config.mcp.args }, () => {
    if (generation === ownGeneration) invalidate(new Error('MCP server 连接已关闭'));
  });
  try {
    const client = await connecting;
    active = client;
    const now = new Date().toISOString();
    status = { ...status, configured: true, connected: true, serverPid: client.pid, lastError: null, connectedAt: now, lastSeenAt: now };
    armHeartbeat(client, ownGeneration);
    return client;
  } catch (error) {
    invalidate(error);
    throw error;
  } finally {
    connecting = null;
  }
}

function makeTool(info: McpToolInfo, exposedName: string): Tool {
  return {
    name: exposedName,
    description: `[MCP:${info.name}] ${info.description ?? '外部 MCP 工具'}`,
    source: 'mcp',
    inputSchema: info.inputSchema,
    async run(input) {
      const client = await ensureClient();
      try {
        return await client.callTool(info.name, input);
      } catch (error) {
        // 不自动重放有副作用的调用；连接失效后下一次调用会创建新连接。
        if (!(error instanceof ToolError)) { invalidate(error); void client.close().catch(() => undefined); }
        throw error;
      }
    },
  };
}

/** 重新发现工具。失败不阻止主服务启动，状态端点会返回错误并允许再次刷新。 */
export async function refreshMcpTools(): Promise<McpStatus> {
  unregisterTools('mcp');
  status = { ...status, configured: Boolean(config.mcp.command), tools: [] };
  if (!config.mcp.command) return status;
  try {
    const client = await ensureClient();
    const infos = await client.listTools();
    const exposed = new Set<string>();
    for (const info of infos) {
      const name = publicName(info.name);
      if (exposed.has(name)) throw new Error(`MCP 工具名规范化后冲突: ${info.name}`);
      exposed.add(name);
      registerTool(makeTool(info, name));
    }
    status = { ...status, connected: true, tools: [...exposed].sort(), lastError: null };
  } catch (error) {
    const client = active;
    invalidate(error);
    if (client) void client.close().catch(() => undefined);
  }
  return getMcpStatus();
}

export function getMcpStatus(): McpStatus { return { ...status, tools: [...status.tools] }; }

export async function closeMcp(): Promise<void> {
  const client = active;
  invalidate();
  unregisterTools('mcp');
  if (client) await client.close().catch(() => undefined);
}

/** 向后兼容的懒连接入口。 */
export async function getMcpClient(): Promise<McpClient | null> {
  return config.mcp.command ? ensureClient() : null;
}
