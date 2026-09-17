import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.LLM_PRICING_JSON = JSON.stringify({
  'openai:exact': { inputPerMillion: 2, outputPerMillion: 6 },
  'anthropic:*': { inputPerMillion: 3, outputPerMillion: 9 },
});
const { calculateCostUsd } = await import('../apps/server/src/llm/provider.ts');
assert.equal(calculateCostUsd('openai:exact', 1_000, 500), 0.005);
assert.equal(calculateCostUsd('anthropic:any', 2_000, 1_000), 0.015);
assert.equal(calculateCostUsd('openai:unknown', 10_000, 10_000), 0);

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-p0-tools-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);
await writeFile(path.join(agentsDir, 'mcp-agent.agent.md'), `---
name: MCP Agent
description: MCP permission and trace verification
model: mock:mcp
capabilities: [execute]
tools: []
permissionMode: confirm
color: '#3366aa'
---
Call the requested MCP tool and report its result.`);

const port = 42000 + Math.floor(Math.random() * 1000);
const fixture = path.join(repo, 'scripts/fixtures/mcp-test-server.mjs');
const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
  cwd: repo,
  env: {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(root, 'test.sqlite'),
    AGENTS_DIR: agentsDir,
    LOG_LEVEL: 'error',
    MCP_SERVER_CMD: process.execPath,
    MCP_SERVER_ARGS: fixture,
    MCP_HEARTBEAT_MS: '5000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise((resolve) => child.once('exit', resolve));
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}
async function poll(read, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`poll timeout\n${logs}`);
}

try {
  const health = await poll(async () => {
    try { const result = await api('/api/health'); return result.status === 200 ? result.data : null; } catch { return null; }
  });
  assert.equal(health.mcp.connected, true);
  assert.deepEqual(health.mcp.tools, ['mcp.echo']);
  assert.equal(typeof health.mcp.serverPid, 'number');

  const options = await api('/api/agent-options');
  assert.equal(options.status, 200);
  assert.equal(options.data.tools.find((tool) => tool.name === 'mcp.echo')?.source, 'mcp');
  const valid = await api('/api/agents/validate', 'POST', {
    id: 'mcp-copy', name: 'MCP Copy', description: 'validation', capabilities: ['execute'],
    systemPrompt: 'Use MCP.', model: 'mock:mcp', tools: ['mcp.echo'], disallowedTools: [],
    permissionMode: 'auto', color: '#3366aa',
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.data));

  const started = await api('/api/runs', 'POST', {
    goal: 'Please call [tool:mcp.echo]', mode: 'pipeline', agentIds: ['mcp-agent'],
  });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const runId = started.data.run.id;
  await poll(async () => (await api(`/api/runs/${runId}`)).data?.run?.status === 'awaiting_approval');
  const pending = (await api('/api/approvals?status=pending')).data.filter((item) => item.runId === runId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].toolName, 'mcp.echo');
  assert.equal((await api(`/api/approvals/${pending[0].id}/decide`, 'POST', { decision: 'approve', by: 'p0-verifier' })).status, 200);
  const detail = await poll(async () => {
    const result = (await api(`/api/runs/${runId}`)).data;
    return result?.run?.status === 'completed' ? result : null;
  }, 30_000);
  const toolSpan = detail.events.find((event) => event.name === 'tool:mcp.echo');
  assert.equal(toolSpan?.status, 'ok');
  assert.match(toolSpan?.output ?? '', /mcp echo:/);
  assert.ok(detail.messages.some((message) => message.kind === 'tool' && message.body.includes('mcp echo:')));

  const oldPid = health.mcp.serverPid;
  process.kill(oldPid, 'SIGTERM');
  await poll(async () => (await api('/api/tools/mcp/status')).data?.connected === false);
  const reconnected = await api('/api/tools/mcp/refresh', 'POST');
  assert.equal(reconnected.status, 200, JSON.stringify(reconnected.data));
  assert.equal(reconnected.data.connected, true);
  assert.notEqual(reconnected.data.serverPid, oldPid);
  assert.deepEqual(reconnected.data.tools, ['mcp.echo']);

  console.log('P0 toolchain verification passed: MCP discovery, approval, trace, reconnect, pricing');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await childExit;
  await rm(root, { recursive: true, force: true });
}
