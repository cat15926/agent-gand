import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const Database = require('../apps/server/node_modules/better-sqlite3');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-observability-'));
const agentsDir = path.join(root, 'agents'); await mkdir(agentsDir);
const agent = ({ name, model, capabilities }) => `---\nname: ${name}\ndescription: ${name} observability fixture\nmodel: mock:${model}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: []\npermissionMode: readonly\ncolor: '#7c5cff'\n---\n${name} fixture`;
await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agent({ name: 'Planner', model: 'planner', capabilities: ['coordinate', 'execute'] })),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agent({ name: 'Coder', model: 'coder', capabilities: ['execute'] })),
  writeFile(path.join(agentsDir, 'reviewer.agent.md'), agent({ name: 'Reviewer', model: 'reviewer', capabilities: ['review'] })),
]);

const dbPath = path.join(root, 'test.sqlite');
const port = 41000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
  cwd: repo, env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'pipe'],
});
const childExit = new Promise((resolve) => child.once('exit', resolve));
let logs = ''; child.stdout.on('data', (chunk) => { logs += chunk; }); child.stderr.on('data', (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;

async function api(url, method = 'GET', body) {
  const response = await fetch(base + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(data)}\n${logs}`);
  return data;
}

async function waitRun(runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const detail = await api(`/api/runs/${runId}`);
    if (['completed', 'failed'].includes(detail.run.status)) return detail;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} 未完成\n${logs}`);
}

function flatten(roots) {
  return roots.flatMap((node) => [node, ...flatten(node.children)]);
}

try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    if (i === 99) throw new Error(`server 启动超时\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const pipelineStart = await api('/api/conversations', 'POST', { goal: '验证流水线观测', mode: 'pipeline', agentIds: ['coder', 'reviewer'] });
  const pipelineDetail = await waitRun(pipelineStart.run.id);
  assert.equal(pipelineDetail.run.status, 'completed');
  const pipelineObs = await api(`/api/runs/${pipelineStart.run.id}/observability`);
  assert.equal(pipelineObs.protocolVersion, 1);
  assert.ok(pipelineObs.graph.edges.some((item) => item.kind === 'next' && item.from === 'agent:coder' && item.to === 'agent:reviewer'));
  const pipelineSpans = flatten(pipelineObs.trace.roots);
  assert.equal(pipelineSpans.length, pipelineObs.trace.totalSpans);
  assert.ok(pipelineSpans.some((node) => node.depth > 0 && node.span.spanKind === 'llm'));
  assert.ok(pipelineSpans.every((node) => node.span.attributes['run.id'] === pipelineStart.run.id));
  assert.ok(pipelineSpans.filter((node) => node.span.spanKind === 'agent').every((node) => node.span.attributes['agent.role'] === 'pipeline'));
  assert.equal(pipelineObs.groups.filter((group) => group.kind === 'pipeline_step').length, 2);
  const payloadDb = new Database(dbPath);
  const payloadAt = new Date().toISOString();
  payloadDb.prepare(`INSERT INTO run_events (id,run_id,parent_id,span_kind,name,input,output,status,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('payload-heavy', pipelineStart.run.id, null, 'message', 'message:large-fixture', 'I'.repeat(12_000), 'O'.repeat(12_000), 'ok', payloadAt, payloadAt);
  payloadDb.close();
  const pipelineFullWithPayload = await api(`/api/runs/${pipelineStart.run.id}/observability`);
  const summaryResponse = await fetch(`${base}/api/runs/${pipelineStart.run.id}/observability?payload=summary`);
  const summaryText = await summaryResponse.text();
  assert.equal(summaryResponse.status, 200);
  const pipelineSummary = JSON.parse(summaryText);
  const summarySpans = flatten(pipelineSummary.trace.roots);
  assert.ok(summarySpans.every((node) => !('input' in node.span) && !('output' in node.span)));
  assert.ok(summarySpans.some((node) => node.span.inputPreview || node.span.outputPreview));
  assert.ok(summaryText.length < JSON.stringify(pipelineFullWithPayload).length * 0.4, '摘要响应未减少至少 60%');
  const detailSpanId = pipelineSpans.find((node) => node.span.spanKind === 'llm').span.id;
  const spanDetail = await api(`/api/runs/${pipelineStart.run.id}/spans/${detailSpanId}`);
  assert.equal(spanDetail.id, detailSpanId);
  assert.equal(typeof spanDetail.input, 'string');
  assert.ok('firstTokenAt' in spanDetail);

  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO run_events (id,run_id,parent_id,span_kind,name,status,started_at,ended_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('legacy-orphan', pipelineStart.run.id, 'missing-parent', 'tool', 'tool:legacy.read', 'ok', now, now);
  db.close();
  const legacyObs = await api(`/api/runs/${pipelineStart.run.id}/observability`);
  const legacy = flatten(legacyObs.trace.roots).find((node) => node.span.id === 'legacy-orphan');
  assert.equal(legacy.orphaned, true);
  assert.equal(legacy.span.attributes['tool.name'], 'legacy.read');

  const scaleDb = new Database(dbPath);
  const insertScale = scaleDb.prepare(`INSERT INTO run_events (id,run_id,parent_id,span_kind,name,status,started_at,ended_at,attributes) VALUES (?,?,?,?,?,?,?,?,?)`);
  const insertMany = scaleDb.transaction(() => {
    for (let index = 0; index < 1_000; index += 1) {
      const timestamp = new Date(Date.now() + index).toISOString();
      insertScale.run(`scale-${index}`, pipelineStart.run.id, null, index % 5 === 0 ? 'tool' : 'message', `scale:event:${index}`, 'ok', timestamp, timestamp, JSON.stringify({ 'run.id': pipelineStart.run.id, 'scale.index': index }));
    }
  });
  insertMany(); scaleDb.close();
  const scaleStarted = performance.now();
  const scaleObs = await api(`/api/runs/${pipelineStart.run.id}/observability?payload=summary`);
  const scaleElapsed = performance.now() - scaleStarted;
  assert.ok(scaleObs.trace.totalSpans >= 1_000, '千 Span 摘要缺少事件');
  assert.ok(scaleElapsed < 4_000, `千 Span 摘要耗时过长: ${Math.round(scaleElapsed)}ms`);

  const supervisorStart = await api('/api/conversations', 'POST', { goal: '验证主管拓扑', mode: 'supervisor', supervisorId: 'planner', agentIds: ['planner', 'coder', 'reviewer'], defaultReviewerId: 'reviewer' });
  const supervisorDetail = await waitRun(supervisorStart.run.id);
  assert.equal(supervisorDetail.run.status, 'completed', logs);
  const supervisorObs = await api(`/api/runs/${supervisorStart.run.id}/observability`);
  assert.ok(supervisorObs.graph.edges.some((item) => item.kind === 'coordinates' && item.from === 'agent:planner' && item.to === 'agent:coder'));
  for (const kind of ['creates', 'assigned_to', 'reviewed_by', 'depends_on']) {
    assert.ok(supervisorObs.graph.edges.some((item) => item.kind === kind), `缺少 ${kind} 边`);
  }
  const supervisorSpans = flatten(supervisorObs.trace.roots);
  assert.ok(supervisorSpans.some((node) => node.span.attributes['agent.role'] === 'worker' && node.span.attributes['task.id']));
  assert.ok(supervisorSpans.some((node) => node.span.attributes['agent.role'] === 'reviewer' && node.span.attributes['task.attempt.id']));
  assert.ok(supervisorSpans.filter((node) => node.span.spanKind === 'llm').every((node) => typeof node.span.attributes['llm.model'] === 'string'));
  assert.ok(supervisorSpans.filter((node) => node.span.spanKind === 'llm' && node.span.status !== 'running').every((node) => 'llm.stop_reason' in node.span.attributes));
  assert.ok(supervisorObs.groups.some((group) => group.kind === 'task_attempt' && group.taskId && group.attemptId));
  assert.ok(supervisorObs.groups.some((group) => group.kind === 'review_attempt' && group.taskId && group.attemptId));
  console.log('observability verification passed');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await childExit;
  await rm(root, { recursive: true, force: true });
}
