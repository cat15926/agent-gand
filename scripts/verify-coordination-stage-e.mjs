import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-coordination-e-'));
const agentsDir = path.join(root, 'agents');
await mkdir(agentsDir);
const dbPath = path.join(root, 'stage-e.sqlite');
process.env.DB_PATH = dbPath;
process.env.AGENTS_DIR = agentsDir;
process.env.COORDINATION_PLANNER_MODEL = '';

function agent(name, capabilities) {
  return `---\nname: ${name}\ndescription: ${name} stage E fixture\nmodel: mock:${name.toLowerCase()}\ncapabilities: ${JSON.stringify(capabilities)}\ntools: []\npermissionMode: readonly\ncolor: '#6677aa'\n---\n${name} fixture`;
}

await Promise.all([
  writeFile(path.join(agentsDir, 'planner.agent.md'), agent('Planner', ['coordinate', 'execute'])),
  writeFile(path.join(agentsDir, 'coder.agent.md'), agent('Coder', ['execute'])),
]);

const registry = await import('../apps/server/src/agents/registry.ts');
const { all } = await import('../apps/server/src/db/database.ts');
const { callCapabilityRegistryTool, capabilityRegistryTools } = await import('../apps/server/src/coordination/mcpServer.ts');
const { getCoordinationCalibration, recordPlannerFeedback } = await import('../apps/server/src/coordination/calibration.ts');
registry.syncFromFiles();

// Capability Registry 的估算调用必须保持只读，并返回协议连接契约和模板展开映射。
assert.equal(capabilityRegistryTools.length, 7);
const draftCountBefore = all('SELECT id FROM coordination_drafts').length;
const protocols = await callCapabilityRegistryTool('list_coordination_protocols', {});
assert.ok(protocols.every((item) => item.inputTypes.length > 0 && Array.isArray(item.allowedSuccessors)));
const estimate = await callCapabilityRegistryTool('estimate_coordination_plan', {
  goal: '让两位成员分别分析并汇总', agentIds: ['planner', 'coder'], requestedProtocol: 'parallel_fanout',
});
assert.deepEqual(estimate.plan.protocolComposition.map((item) => item.protocol), ['parallel_fanout']);
assert.equal(estimate.plan.templateExpansions.length, 1);
assert.ok(estimate.plan.templateExpansions[0].stepIds.includes('parallel-aggregate'));
assert.equal(all('SELECT id FROM coordination_drafts').length, draftCountBefore, '只读估算不得保存 Draft');
const invalidInitial = await callCapabilityRegistryTool('estimate_coordination_plan', {
  goal: '汇总现有分支', agentIds: ['planner', 'coder'], requestedProtocol: 'supervisor_aggregation',
});
assert.ok(invalidInitial.plan.validationIssues.some((item) => item.code === 'PROTOCOL_INITIAL_INPUT_MISMATCH'));

// 验证 stdio MCP 握手和工具目录，而不只测试内部函数。
const mcp = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/coordination/mcpServer.ts'], {
  cwd: repo, env: { ...process.env, DB_PATH: dbPath, AGENTS_DIR: agentsDir }, stdio: ['pipe', 'pipe', 'pipe'],
});
let mcpBuffer = '';
const mcpReplies = new Map();
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (chunk) => {
  mcpBuffer += chunk;
  for (;;) {
    const newline = mcpBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = mcpBuffer.slice(0, newline); mcpBuffer = mcpBuffer.slice(newline + 1);
    if (!line) continue;
    const value = JSON.parse(line);
    mcpReplies.get(value.id)?.(value);
    mcpReplies.delete(value.id);
  }
});
function mcpCall(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${method} 超时`)), 5_000);
    mcpReplies.set(id, (value) => { clearTimeout(timer); resolve(value); });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const initialized = await mcpCall(1, 'initialize', { protocolVersion: '2025-06-18' });
assert.equal(initialized.result.serverInfo.name, 'agent-gand-capability-registry');
const toolList = await mcpCall(2, 'tools/list');
assert.equal(toolList.result.tools.length, 7);
mcp.kill('SIGTERM');

// 阈值只根据真实纠正反馈校准；小样本不动，达到门槛后保守抬高。
const baseline = getCoordinationCalibration();
for (let index = 0; index < 5; index += 1) {
  recordPlannerFeedback({
    originalDraftId: `fixture-${index}`, chosenProtocols: [{ protocol: 'parallel_fanout', version: 1 }],
    originalConfidence: 0.99, corrected: true, source: 'plan_revision',
  });
}
const calibrated = getCoordinationCalibration();
assert.equal(calibrated.sampleCount, 5);
assert.equal(calibrated.correctionRate, 1);
assert.ok(calibrated.threshold > baseline.threshold);

const port = 45000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let logs = '';
const server = spawn(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'apps/server/src/index.ts'], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), DB_PATH: dbPath, AGENTS_DIR: agentsDir, LOG_LEVEL: 'error' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { logs += chunk; });
server.stderr.on('data', (chunk) => { logs += chunk; });

async function api(url, method = 'GET', body) {
  try {
    const response = await fetch(base + url, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch {}
    return { status: response.status, data };
  } catch (error) {
    return { status: 0, data: null, error: error instanceof Error ? error.message : String(error) };
  }
}
async function poll(read, accept, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await read();
    if (accept(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`${label} 超时：${JSON.stringify(latest)}\n${logs}`);
}

try {
  await poll(() => api('/api/health'), (value) => value.status === 200, '服务启动');
  const preview = await api('/api/coordination/preview', 'POST', {
    goal: '先由 Planner 分析，再由 Coder 完成', agentIds: ['planner', 'coder'], requestedProtocol: 'sequential_pipeline',
  });
  assert.equal(preview.status, 201, JSON.stringify(preview.data));
  const started = await api('/api/conversations', 'POST', {
    goal: preview.data.draft.taskBrief.objective, mode: preview.data.draft.runtimeMode,
    agentIds: ['planner', 'coder'], coordinationDraftId: preview.data.draft.id,
  });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  const runId = started.data.run.id;
  const pause = await api(`/api/runs/${runId}/coordination/pause`, 'POST');
  assert.ok([200, 202].includes(pause.status), JSON.stringify(pause.data));
  await poll(
    () => Promise.all([api(`/api/runs/${runId}`), api(`/api/runs/${runId}/coordination`)]),
    ([run, coordination]) => run.data?.run?.status === 'waiting_for_user' && coordination.data?.plan?.status === 'paused',
    '安全边界暂停',
  );
  const revision = await api(`/api/runs/${runId}/coordination/revisions`, 'POST', {
    instruction: '改为两位成员并行分析后汇总',
  });
  assert.equal(revision.status, 201, JSON.stringify(revision.data));
  assert.equal(revision.data.plan.revision, 2);
  assert.deepEqual(revision.data.plan.protocols.map((item) => item.protocol), ['parallel_fanout', 'supervisor_aggregation']);
  const history = await api(`/api/coordination/plans/${revision.data.plan.id}/revisions`);
  assert.equal(history.data.length, 2);
  assert.equal(history.data[0].plan.revision, 1);
  assert.equal(history.data[1].trigger, 'user_adjustment');
  const resumed = await api(`/api/runs/${runId}/coordination/resume`, 'POST');
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  const completed = await poll(() => api(`/api/runs/${runId}/coordination`), (value) => value.data?.plan?.status === 'completed', 'Revision 恢复完成');
  assert.equal(completed.data.plan.revision, 2);
  assert.ok(completed.data.steps.every((step) => step.revision === 2 && step.status === 'completed'));
  assert.ok(completed.data.attempts.some((attempt) => attempt.revision === 1), '旧 Revision 的执行证据必须保留');
  assert.ok(completed.data.attempts.some((attempt) => attempt.revision === 2), '新 Revision 必须形成独立 Attempt');
  assert.ok(completed.data.events.some((event) => event.kind === 'plan_revision_created'));
  const calibration = await api('/api/coordination/calibration');
  assert.equal(calibration.status, 200);
  assert.equal(calibration.data.sampleCount, 6);
  console.log('coordination stage E verification passed');
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
}
