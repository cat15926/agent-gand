import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-followup-stage3-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);
function agent(name, capabilities) {
  return `---\nname: ${name}\ndescription: ${name} followup fixture\nmodel: mock:${name.toLowerCase()}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: []\npermissionMode: readonly\ncolor: '#6677aa'\n---\n${name} fixture`;
}
await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agent('Planner', ['coordinate', 'execute'])),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agent('Coder', ['execute'])),
  writeFile(path.join(agentsDir, 'reviewer.agent.md'), agent('Reviewer', ['review'])),
]);
const port = 47000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: agentsDir,
    COORDINATION_PLANNER_MODEL: 'mock:coordination-planner', LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise((resolve) => child.once('exit', resolve));
let logs = '';
child.stdout.on('data', (chunk) => { logs += chunk; });
child.stderr.on('data', (chunk) => { logs += chunk; });
async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await response.json(); } catch {}
  return { status: response.status, data };
}
async function poll(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} 超时：${JSON.stringify(latest)}\n${logs}`);
}
try {
  await poll(async () => {
    try { return await api('/api/health'); } catch { return { status: 0 }; }
  }, (result) => result.status === 200, '服务启动');
  const created = await api('/api/conversations', 'POST', {
    goal: '建立追问房间', mode: 'pipeline', agentIds: ['planner', 'coder', 'reviewer'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const roomId = created.data.conversation.id;
  await poll(() => api(`/api/runs/${created.data.run.id}`), (result) => result.data?.run?.status === 'completed', '首轮完成');
  const collaborationRoom = await api('/api/conversations', 'POST', {
    goal: '建立自由协作房间', mode: 'collaboration', agentIds: ['planner', 'coder'], recipientIds: ['planner'],
  });
  assert.equal(collaborationRoom.status, 201, JSON.stringify(collaborationRoom.data));
  const unchangedCollaboration = await api(`/api/conversations/${collaborationRoom.data.conversation.id}/followup-preview`, 'POST', {
    body: '请把登录问题处理到可交付状态 [model:review]',
  });
  assert.equal(unchangedCollaboration.status, 200);
  assert.equal(unchangedCollaboration.data.kind, 'none', '普通 Collaboration 追问不得被模型预览改道');
  const roomDetail = await api(`/api/conversations/${roomId}`);
  const previousReply = roomDetail.data.messages.findLast((message) => message.kind === 'agent');
  assert.ok(previousReply);

  // 定向追问先于模型判定：即使正文含模型测试标记，也不创建规划 Draft。
  const directed = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', {
    body: '请直接回答 [model:review]', replyTo: previousReply.id,
  });
  assert.equal(directed.status, 200);
  assert.equal(directed.data.kind, 'none');
  assert.equal(directed.data.preview, null);

  // 关键词选择器看不出的实现+审查意图由模型识别；平台置信度允许自动开始。
  const modeledGoal = '请把登录问题处理到可交付状态 [model:review]';
  const modeled = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', { body: modeledGoal });
  assert.equal(modeled.status, 200, JSON.stringify(modeled.data));
  assert.equal(modeled.data.kind, 'auto_plan');
  assert.equal(modeled.data.preview.draft.planning.source, 'model');
  assert.deepEqual(modeled.data.preview.draft.protocols.map((item) => item.protocol), ['review_revision']);
  assert.equal(modeled.data.preview.draft.decision, 'auto_start');
  const modeledStart = await api(`/api/conversations/${roomId}/messages`, 'POST', {
    body: modeledGoal, clientMessageId: randomUUID(), coordinationDraftId: modeled.data.preview.draft.id,
  });
  assert.equal(modeledStart.status, 202, JSON.stringify(modeledStart.data));
  await poll(() => api(`/api/runs/${modeledStart.data.run.id}`), (result) => result.data?.run?.status === 'completed', '模型规划追问完成');
  assert.equal((await api(`/api/runs/${modeledStart.data.run.id}/coordination-plan`)).status, 200);

  const riskyModel = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', {
    body: '请把登录问题处理到可交付状态并部署生产 [model:review]',
  });
  assert.equal(riskyModel.status, 200);
  assert.equal(riskyModel.data.kind, 'needs_confirmation', '高风险模型建议不得自动启动');
  assert.equal(riskyModel.data.preview.draft.planning.source, 'model');
  assert.equal(riskyModel.data.preview.draft.decision, 'recommend');

  // 显式辩论约束优先于模型，且模型故障无关键词时回退轻量路径。
  const explicit = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', {
    body: '进行1轮辩论，正方支持 A，反方支持 B，最后由 Reviewer 裁判 [model:review]',
  });
  assert.equal(explicit.status, 200);
  assert.deepEqual(explicit.data.preview.draft.protocols.map((item) => item.protocol), ['debate']);
  assert.equal(explicit.data.preview.draft.planning.source, 'deterministic');
  const failure = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', {
    body: '请给出你的看法 [planner-fail]',
  });
  assert.equal(failure.status, 200);
  assert.equal(failure.data.kind, 'none');

  // 全队处理是本轮显式指令：生成覆盖全部成员的 Plan，并拒绝与定向同时使用。
  const team = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', {
    body: '请团队给我一个简短建议', wholeTeam: true,
  });
  assert.equal(team.status, 200, JSON.stringify(team.data));
  assert.equal(team.data.kind, 'auto_plan');
  assert.equal(team.data.preview.draft.planning.source, 'deterministic');
  assert.deepEqual(team.data.preview.draft.protocols.map((item) => item.protocol), ['sequential_pipeline']);
  assert.deepEqual(new Set(team.data.preview.plan.steps.map((step) => step.agentId).filter(Boolean)), new Set(['planner', 'coder', 'reviewer']));
  const conflict = await api(`/api/conversations/${roomId}/followup-preview`, 'POST', {
    body: '请回答', recipientIds: ['coder'], wholeTeam: true,
  });
  assert.equal(conflict.status, 400);
  const missingPlan = await api(`/api/conversations/${roomId}/messages`, 'POST', {
    body: '请团队给我一个简短建议', clientMessageId: randomUUID(), wholeTeam: true,
  });
  assert.equal(missingPlan.status, 400);
  const teamStart = await api(`/api/conversations/${roomId}/messages`, 'POST', {
    body: '请团队给我一个简短建议', clientMessageId: randomUUID(), wholeTeam: true,
    coordinationDraftId: team.data.preview.draft.id,
  });
  assert.equal(teamStart.status, 202, JSON.stringify(teamStart.data));
  await poll(() => api(`/api/runs/${teamStart.data.run.id}`), (result) => result.data?.run?.status === 'completed', '全队计划完成');
  assert.equal((await api(`/api/conversations/${roomId}`)).data.conversation.mode, 'pipeline');
  assert.equal((await api(`/api/runs/${teamStart.data.run.id}/coordination-plan`)).status, 200);
  console.log('follow-up stage 3 verification passed: model selection, explicit priority, fallback, whole-team plan');
} finally {
  child.kill('SIGTERM');
  await childExit;
  await rm(root, { recursive: true, force: true });
}
