// Real Codex + real execution stdio MCP transport. No account, no model turns.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withRpcProcess } from '../apps/server/src/execution/rpc.ts';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-mcp-protocol-'));
const nativeHome = path.join(root, 'home'); await mkdir(nativeHome, { mode: 0o700 });
const token = randomBytes(32).toString('hex'); let discoveries = 0;
const server = createServer((request, response) => {
  assert.equal(request.headers.authorization, 'Bearer ' + token);
  assert.equal(request.url, '/tools', 'This probe must never execute a tool'); discoveries++;
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ tools: [{ name: 'agent_complete', description: 'Request platform completion', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false } }] }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { CODEX_HOME: nativeHome, AGENT_GAND_BRIDGE_URL: `http://127.0.0.1:${server.address().port}/`, AGENT_GAND_BRIDGE_TOKEN: token };
const bridge = { command: process.execPath, args: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../apps/server/src/execution/bridgeWorker.ts', import.meta.url))],
  env_vars: ['AGENT_GAND_BRIDGE_URL', 'AGENT_GAND_BRIDGE_TOKEN'], enabled: true, required: true, enabled_tools: ['agent_complete'], default_tools_approval_mode: 'approve' };
try {
  await withRpcProcess({ command: process.env.EXTERNAL_CODEX_COMMAND ?? 'codex', args: ['app-server', '--listen', 'stdio://', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.shell_tool=false'], cwd: root, env, signal: new AbortController().signal, timeoutMs: 20000 }, async (peer) => {
    await peer.request('initialize', { clientInfo: { name: 'agent_gand', title: 'Agent Gand', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    peer.send({ method: 'initialized', params: {} });
    const response = await peer.request('thread/start', { cwd: root, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', config: { mcp_servers: { agent_gand: bridge } } });
    assert.equal(response.sandbox.type, 'readOnly');
    const status = await peer.request('mcpServerStatus/list', { threadId: response.thread.id, serverName: 'agent_gand', detail: 'full' });
    const connected = status.data.find((item) => item.name === 'agent_gand');
    assert.ok(connected, JSON.stringify(status)); assert.equal(connected.toolsError, null);
    assert.ok(Object.values(connected.tools).some((tool) => tool.name === 'agent_complete'), JSON.stringify(connected));
    assert.ok(discoveries > 0);
    console.log('Real Codex MCP verified: thread configuration, credential environment forwarding, stdio initialize/tools-list; model turns = 0');
  });
} finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); }
