import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-scheduler-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);

const agentFile = (name, model, tools, permissionMode, prompt) => `---
name: ${name}
description: ${prompt}
model: mock:${model}
tools: ${JSON.stringify(tools)}
permissionMode: ${permissionMode}
color: '#7c5cff'
---

${prompt}
`;

await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agentFile('Planner', 'planner', [], 'confirm', '拆解目标并汇总结果')),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agentFile('Coder', 'coder', ['fs.read', 'fs.write'], 'auto', '实现任务并根据反馈返工')),
  writeFile(path.join(agentsDir, 'reviewer.agent.md'), agentFile('Reviewer', 'reviewer', ['fs.read'], 'readonly', '按协议审查任务')),
]);

const port = 39000 + Math.floor(Math.random() * 1000);
// 直接用 Node loader 启动，避免 tsx CLI 为父子进程控制创建额外 IPC socket；受限 CI 也可运行。
const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    PORT: String(port),
    DB_PATH: path.join(root, 'test.sqlite'),
    AGENTS_DIR: agentsDir,
    LOG_LEVEL: 'error',
    ORCHESTRATOR_CONCURRENCY: '2',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise((resolve) => child.once('exit', resolve));

let logs = '';
child.stdout.on('data', (chunk) => { logs += String(chunk); });
child.stderr.on('data', (chunk) => { logs += String(chunk); });
const base = `http://127.0.0.1:${port}`;

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server 启动超时\n${logs}`);
}

try {
  await waitForHealth();
  const started = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      goal: '__MOCK_REVIEW_FAIL_ONCE__ 验证审查返工闭环',
      mode: 'supervisor',
      supervisorId: 'planner',
      agentIds: ['planner', 'coder', 'reviewer'],
    }),
  });
  assert.equal(started.status, 201);
  const { run, conversation } = await started.json();
  const deadline = Date.now() + 20_000;
  let detail;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/runs/${run.id}`);
    detail = await response.json();
    if (detail.run.status === 'completed' || detail.run.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(detail.run.status, 'completed', logs);
  assert.equal(detail.run.supervisorId, 'planner');
  assert.equal(detail.tasks.length, 3);
  assert.ok(detail.tasks.every((task) => task.status === 'completed' && task.attempt === 2));
  assert.equal(detail.reviews.filter((review) => review.verdict === 'FAIL').length, 3);
  assert.equal(detail.reviews.filter((review) => review.verdict === 'PASS').length, 3);
  assert.equal(detail.attempts.filter((attempt) => attempt.kind === 'work').length, 6);
  assert.equal(detail.attempts.filter((attempt) => attempt.kind === 'review').length, 6);
  const messageTypes = detail.messages.map((message) => message.messageType);
  assert.ok(messageTypes.includes('assignment'));
  assert.ok(messageTypes.includes('revision_request'));
  assert.ok(messageTypes.includes('review_result'));
  assert.equal(run.conversationId, conversation.id);
  assert.equal(run.turnNo, 1);
  assert.match(run.workspace, /^room-[0-9a-f]{8}$/);
  assert.equal(run.workspace, conversation.workspace);

  const replyTo = detail.messages.findLast((message) => message.messageType === 'result')?.id;
  assert.ok(replyTo);
  const clientMessageId = `verify-${crypto.randomUUID()}`;
  const followupBody = '@coder 请基于上一轮结果补充说明边界情况';
  const followupRequest = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: followupBody, recipientIds: ['coder'], replyTo, clientMessageId }),
  };
  const followup = await fetch(`${base}/api/conversations/${conversation.id}/messages`, followupRequest);
  assert.equal(followup.status, 202);
  const followupPayload = await followup.json();
  assert.equal(followupPayload.run.turnNo, 2);
  assert.equal(followupPayload.message.deliveryStatus, 'queued');
  assert.equal(followupPayload.message.to, 'coder');
  assert.equal(followupPayload.message.replyTo, replyTo);

  const duplicate = await fetch(`${base}/api/conversations/${conversation.id}/messages`, followupRequest);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).run.id, followupPayload.run.id);

  let secondDetail;
  const followupDeadline = Date.now() + 20_000;
  while (Date.now() < followupDeadline) {
    const response = await fetch(`${base}/api/runs/${followupPayload.run.id}`);
    secondDetail = await response.json();
    if (secondDetail.run.status === 'completed' || secondDetail.run.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(secondDetail.run.status, 'completed', logs);
  assert.deepEqual(secondDetail.run.agentIds, ['planner', 'coder', 'reviewer']);
  const roomResponse = await fetch(`${base}/api/conversations/${conversation.id}`);
  assert.equal(roomResponse.status, 200);
  const room = await roomResponse.json();
  assert.equal(room.runs.length, 2);
  assert.equal(room.messages.filter((message) => message.clientMessageId === clientMessageId).length, 1);
  assert.equal(room.messages.find((message) => message.clientMessageId === clientMessageId)?.deliveryStatus, 'responded');
  assert.ok(room.messages.every((message, index) => index === 0 || message.seq > room.messages[index - 1].seq));
  console.log(`scheduler verification passed: run=${run.id} attempts=${detail.attempts.length} reviews=${detail.reviews.length}`);
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await childExit;
  await rm(root, { recursive: true, force: true });
}
