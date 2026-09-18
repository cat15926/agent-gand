import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-durable-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);
await writeFile(path.join(agentsDir, 'writer.agent.md'), `---
name: Durable Writer
description: crash recovery fixture
model: mock:coder
capabilities: [execute]
tools: []
permissionMode: confirm
color: '#3366aa'
---
Write the requested file.`);

const port = 43000 + Math.floor(Math.random() * 1000);
const dbPath = path.join(root, 'test.sqlite');
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let logs = '';
let child;

function startServer() {
  const next = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error', APPROVAL_TIMEOUT_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  next.stdout.on('data', (chunk) => { logs += chunk; });
  next.stderr.on('data', (chunk) => { logs += chunk; });
  child = next;
  return next;
}
async function stopServer(server) {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
}
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await response.json(); } catch {}
  return { status: response.status, data };
}
async function poll(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const value = await read(); if (value) return value; } catch {}
    await sleep(100);
  }
  throw new Error(`poll timeout\n${logs}`);
}

try {
  const first = startServer();
  await poll(async () => (await api('/api/health')).status === 200);
  const started = await api('/api/runs', 'POST', { goal: '请调用 [tool:fs.write] 写入文件', mode: 'pipeline', agentIds: ['writer'] });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const runId = started.data.run.id;
  const approval = await poll(async () => {
    const list = (await api('/api/approvals?status=pending')).data ?? [];
    return list.find((item) => item.runId === runId);
  });

  // 在审批等待点终止整个进程，模拟宿主崩溃。
  await stopServer(first);
  const second = startServer();
  await poll(async () => (await api('/api/health')).status === 200);
  const pendingAfterRestart = (await api('/api/approvals?status=pending')).data.filter((item) => item.runId === runId);
  assert.equal(pendingAfterRestart.length, 1, '重启不得创建重复审批');
  assert.equal(pendingAfterRestart[0].id, approval.id);
  assert.equal((await api(`/api/approvals/${approval.id}/decide`, 'POST', { decision: 'approve', by: 'durable-verifier' })).status, 200);
  await poll(async () => (await api(`/api/runs/${runId}`)).data?.run?.status === 'completed', 30_000);

  const executions = (await api(`/api/runs/${runId}/tool-executions`)).data;
  assert.equal(executions.length, 1, '同一逻辑工具调用只能有一条执行账本');
  assert.equal(executions[0].status, 'completed');
  const checkpoints = (await api(`/api/runs/${runId}/checkpoints`)).data;
  assert.ok(checkpoints.some((item) => item.phase === 'waiting_tool_approval'));
  assert.equal(checkpoints.at(-1)?.phase, 'completed');
  const output = await readFile(path.join(repo, 'apps/server/data/sandbox/runs', runId, 'mock-demo.txt'), 'utf8');
  assert.equal(output, 'mock 写入演示内容');
  console.log('Durable execution verification passed: restart, approval wake, checkpoint resume, exactly-once ledger');
  await stopServer(second);
} finally {
  if (child?.exitCode === null) await stopServer(child);
  await rm(root, { recursive: true, force: true });
}
