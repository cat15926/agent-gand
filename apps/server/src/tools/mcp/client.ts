/**
 * MCP stdio client 骨架（规格 §4.2 tools/mcp/client.ts）
 * 可连接配置的 MCP server、列出工具、薄封装调用；
 * 未配置时返回 null（调用方按"无外部工具"处理）。
 * TODO: 连接保活/断线重连、把 MCP 工具并入权限门控与 pipeline 工具注册表、stderr 日志采集
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { config } from '../../config.ts';

export interface McpToolInfo {
  name: string;
  description?: string;
}

export interface McpClient {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, input: unknown): Promise<string>;
  close(): Promise<void>;
}

/** MCP 调用结果 → 文本（取 text 块，其余 JSON 化） */
function stringifyResult(result: CallToolResult): string {
  if (result.isError) throw new Error(`MCP 工具返回错误: ${JSON.stringify(result.content).slice(0, 300)}`);
  const texts = (result.content ?? [])
    .map((block) => (block.type === 'text' ? block.text : null))
    .filter((t): t is string => t !== null);
  const out = texts.length > 0 ? texts.join('\n') : JSON.stringify(result).slice(0, 2000);
  return out.slice(0, 10_000);
}

export async function connectMcp(cfg: { command: string; args: string[] }): Promise<McpClient> {
  const client = new Client({ name: 'agent-gand', version: '0.1.0' }, {});
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args });
  await client.connect(transport);
  return {
    async listTools(): Promise<McpToolInfo[]> {
      const res: ListToolsResult = await client.listTools();
      return (res.tools ?? []).map((t) => ({ name: t.name, description: t.description }));
    },
    async callTool(name: string, input: unknown): Promise<string> {
      const args =
        input !== null && typeof input === 'object' && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const res = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return stringifyResult(res);
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

/** 按环境变量配置返回 MCP client；未配置（MCP_SERVER_CMD 为空）返回 null */
export async function getMcpClient(): Promise<McpClient | null> {
  if (!config.mcp.command) return null; // 未配置：骨架阶段按"无外部工具"处理
  // TODO: 失败重试与懒连接（当前为一次性连接）
  return connectMcp({ command: config.mcp.command, args: config.mcp.args });
}
