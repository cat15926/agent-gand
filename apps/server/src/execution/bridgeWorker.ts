import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';

// This process has no database access and cannot choose a Run, Agent or Attempt.
const url = process.env.AGENT_GAND_BRIDGE_URL;
const token = process.env.AGENT_GAND_BRIDGE_TOKEN;
if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(url) || !token) throw new Error('执行桥启动凭据缺失');
async function callback(path: string, body?: unknown) {
  const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error' });
  if (!response.ok) throw new Error(`执行桥已拒绝请求 (${response.status})`);
  return response.json();
}
const server = new Server({ name: 'agent-gand-runtime', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ListToolsResultSchema.parse(await callback('tools')));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    // Native MCP request identity is bound to this stdio connection, never an LLM argument.
    return CallToolResultSchema.parse(await callback('call', { requestId: `${connection}:${extra.requestId}`, name: request.params.name, arguments: request.params.arguments ?? {} }));
  } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '执行桥请求失败' }] }; }
});
const connection = randomUUID();
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void server.close(); });
