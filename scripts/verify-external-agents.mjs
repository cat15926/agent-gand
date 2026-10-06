import assert from 'node:assert/strict';
import { copyFile, chmod, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-external-'));
const workspace = path.join(root, 'repo with spaces');
await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), '# Fixture repository\n');
const log = path.join(root, 'calls.jsonl'); await writeFile(log, '');
for (const name of ['claude', 'codex']) {
  const file = path.join(root, `fake ${name}`);
  await copyFile(new URL('./fixtures/external-agent-cli.mjs', import.meta.url), file); await chmod(file, 0o755);
}
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: root, EXTERNAL_CLAUDE_COMMAND: path.join(root, 'fake claude'), EXTERNAL_CODEX_COMMAND: path.join(root, 'fake codex'), EXTERNAL_AGENT_TIMEOUT_MS: '1000', FAKE_AGENT_LOG: log, MCP_SERVER_CMD: '', LOG_LEVEL: 'silent' });
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { db, closeDatabase } = await import('../apps/server/src/db/database.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { subscribe } = await import('../apps/server/src/messaging/bus.ts');
const { listDrivers } = await import('../apps/server/src/execution/drivers.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const { NativeEventParser } = await import('../apps/server/src/execution/parsers.ts');
const { interruptStaleExecutions, createExecution, getExecution } = await import('../apps/server/src/execution/store.ts');
const { parseAgentMarkdown } = await import('../apps/server/src/agents/loader.ts');
const { getRun, startSpan, usageForRun } = await import('../apps/server/src/runs/trace.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const app = Fastify(); await registerRoutes(app);
const wsEvents = []; const unsubscribe = subscribe((event) => wsEvents.push(event));
const registered = registerExternal({ path: workspace });
async function api(url, method = 'GET', body) {
  const response = await app.inject({ url, method, ...(body ? { payload: body } : {}) });
  return { status: response.statusCode, data: response.json() };
}
async function waitFor(fn, description, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error(`Timeout: ${description}`);
}
const input = (id, driver) => ({ id, name: id, description: '只读测试', systemPrompt: '分析仓库结构。', model: 'default', execution: { kind: 'external', driver }, tools: [], disallowedTools: [], permissionMode: 'readonly', capabilities: ['execute'], color: '#3366aa', avatar: '' });
async function room(id, scenario = 'normal', extra = {}) {
  const created = await api('/api/conversations', 'POST', { goal: `SCENARIO:${scenario}`, mode: 'pipeline', agentIds: [id], workspace: `ext:${registered.id}`, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.data)); return created.data;
}
async function finished(runId) {
  await waitFor(() => ['completed', 'failed', 'cancelled'].includes(getRun(runId)?.status), `run ${runId}`);
  const executions = (await api(`/api/runs/${runId}/executions`)).data;
  await waitFor(() => db.prepare('SELECT ended_at FROM run_events WHERE run_id=? AND span_kind=\'llm\'').get(runId)?.ended_at, 'span closed');
  return executions[0];
}
async function calls() { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

try {
  const options = await api('/api/agent-options');
  assert.equal(options.status, 200); assert.ok(options.data.executionDrivers.filter((item) => ['claude-cli', 'codex-exec'].includes(item.id)).every((item) => item.available));
  for (const [id, driver] of [['claude-reader', 'claude-cli'], ['codex-reader', 'codex-exec']]) {
    assert.equal((await api('/api/agents', 'POST', input(id, driver))).status, 201);
    const bad = await api('/api/agents/validate', 'POST', { ...input(id, driver), permissionMode: 'auto' }); assert.equal(bad.status, 400);
    assert.equal((await api('/api/agents/validate', 'POST', { ...input(id, driver), tools: ['fs.write'] })).status, 400);
    assert.equal((await api('/api/agents/validate', 'POST', { ...input(id, driver), execution: { kind: 'external', driver, args: ['--dangerously-skip-permissions'] } })).status, 400);
    assert.equal((await api('/api/conversations', 'POST', { goal: 'read', mode: 'collaboration', agentIds: [id] })).status, 400);
    assert.equal((await api('/api/coordination/preview', 'POST', { goal: 'read', agentIds: [id] })).status, 400);
    const created = await room(id);
    const execution = await finished(created.run.id);
    assert.equal(execution.status, 'completed'); assert.equal(execution.content, '分析：# Fixture repository'); assert.ok(execution.sessionId);
    assert.equal(execution.tokensIn, 8); assert.equal(execution.tokensOut, 2);
    assert.equal(execution.costUsd, driver === 'claude-cli' ? 0.01 : null);
    assert.equal(usageForRun(created.run.id).hasUnknownCost, driver === 'codex-exec' ? true : undefined);
    const messages = db.prepare("SELECT body FROM messages WHERE run_id=? AND kind='agent'").all(created.run.id);
    assert.deepEqual(messages.map((message) => message.body), ['分析：# Fixture repository']);
    assert.equal(wsEvents.filter((event) => event.type === 'llm.snapshot' && event.runId === created.run.id).at(-1).text, '分析：# Fixture repository');
    assert.ok(wsEvents.some((event) => event.type === 'execution.native' && event.runId === created.run.id && event.event.type === 'tool.started'));
    const call = (await calls()).find((item) => item.session === execution.sessionId);
    assert.equal(call.cwd, registered.absPath); assert.ok(call.args.includes(driver === 'claude-cli' ? 'Read,Grep,Glob' : 'read-only'));
    assert.ok(!call.args.some((arg) => /dangerously|bypassPermissions/.test(arg)));
    if (driver === 'claude-cli') assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
    else { assert.ok(call.args.includes('approval_policy="never"')); assert.ok(call.args.includes('features.hooks=false')); assert.ok(call.args.includes('mcp_servers.fixture_mcp.enabled=false')); assert.ok(call.args.some((arg) => arg.startsWith('projects=') && arg.includes('trust_level="untrusted"'))); }
    for (const [scenario, code] of [['auth', 'auth_required'], ['invalid', 'invalid_json'], ['half', 'invalid_json'], ['nonzero', 'nonzero_exit'], ['no-terminal', 'protocol_error'], ['policy', 'policy_rejected'], ['late-nonzero', 'nonzero_exit']]) {
      const failure = await room(id, scenario); const record = await finished(failure.run.id);
      assert.equal(getRun(failure.run.id).status, 'failed'); assert.equal(record.status, 'failed'); assert.equal(record.errorCode, code, `${driver}/${scenario}: ${record.error}`);
      assert.ok(!record.error.includes('fixtureSecret')); assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE run_id=? AND kind='agent'").get(failure.run.id).count, 0);
      assert.ok(!wsEvents.some((event) => event.type === 'llm.snapshot' && event.runId === failure.run.id && event.text.includes('fixtureSecret')));
      if (scenario === 'late-nonzero') assert.equal(usageForRun(failure.run.id).tokensIn, 8, 'A failed exit must retain reported usage');
    }
    const unreported = await room(id, 'no-usage'); const unknown = await finished(unreported.run.id);
    assert.equal(unknown.status, 'completed'); assert.equal(unknown.tokensIn, null); assert.equal(unknown.costUsd, null);
    assert.equal(usageForRun(unreported.run.id).hasUnknownTokens, true); assert.equal(usageForRun(unreported.run.id).hasUnknownCost, true);
  }
  const concurrent = await Promise.all([room('claude-reader'), room('claude-reader'), room('codex-reader'), room('codex-reader')]);
  const executions = await Promise.all(concurrent.map((item) => finished(item.run.id)));
  assert.equal(new Set(executions.map((item) => item.sessionId)).size, 4);
  assert.equal(new Set(executions.map((item) => item.runId)).size, 4);
  // Cancellation must revoke late stdout and kill both the CLI and its stubborn child.
  for (const id of ['claude-reader', 'codex-reader']) {
    const beforeStopCalls = (await calls()).length;
    const stalled = await room(id, 'stall', { agentIds: [id, id === 'claude-reader' ? 'codex-reader' : 'claude-reader'] });
    const call = await waitFor(async () => (await calls()).find((item) => item.prompt.includes('SCENARIO:stall') && item.driver === (id.startsWith('claude') ? 'claude' : 'codex')), 'stalled process');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stopped = await api(`/api/runs/${stalled.run.id}/stop`, 'POST'); assert.equal(stopped.status, 200); assert.equal(stopped.data.status, 'cancelled');
    const record = await finished(stalled.run.id); assert.equal(record.status, 'cancelled'); assert.equal(record.errorCode, 'cancelled');
    await waitFor(() => !alive(call.pid) && !alive(call.childPid), 'process group gone');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE run_id=? AND kind='agent'").get(stalled.run.id).count, 0);
    assert.equal((await api(`/api/runs/${stalled.run.id}/stop`, 'POST')).data.status, 'cancelled');
    assert.equal((await calls()).length, beforeStopCalls + 1, 'Stop must prevent the next pipeline member from launching');
  }
  const timed = await room('codex-reader', 'timeout'); assert.equal((await finished(timed.run.id)).errorCode, 'timeout');
  const timeoutCall = (await calls()).find((item) => item.scenario === 'timeout'); await waitFor(() => !alive(timeoutCall.pid) && !alive(timeoutCall.childPid), 'timeout tree gone');
  await rename(process.env.EXTERNAL_CLAUDE_COMMAND, process.env.EXTERNAL_CLAUDE_COMMAND + '.hidden');
  assert.equal((await listDrivers(true)).find((item) => item.id === 'claude-cli').errorCode, 'missing_binary');
  const missing = await room('claude-reader'); assert.equal((await finished(missing.run.id)).errorCode, 'missing_binary');
  await rename(process.env.EXTERNAL_CLAUDE_COMMAND + '.hidden', process.env.EXTERNAL_CLAUDE_COMMAND); await listDrivers(true);
  for (const envKey of ['FAKE_MCP_LOCKED', 'FAKE_MCP_INVALID']) {
    process.env[envKey] = '1'; const before = (await calls()).length;
    const denied = await room('codex-reader'); assert.equal((await finished(denied.run.id)).errorCode, 'policy_rejected');
    assert.equal((await calls()).length, before, 'MCP policy rejection must happen before CLI inference starts');
    delete process.env[envKey];
  }
  process.env.FAKE_CLI_UNSUPPORTED = '1'; await listDrivers(true);
  const unsupported = await room('claude-reader'); assert.equal((await finished(unsupported.run.id)).errorCode, 'unsupported_cli');
  delete process.env.FAKE_CLI_UNSUPPORTED; await listDrivers(true);
  // A completed scope can be consumed twice inside its run without spawning twice.
  const { createRun } = await import('../apps/server/src/runs/trace.ts');
  const { getAgent } = await import('../apps/server/src/agents/registry.ts');
  const testRun = createRun('SCENARIO:normal', 'pipeline', ['claude-reader'], `ext:${registered.id}`);
  const parent = startSpan(testRun.id, { spanKind: 'agent', name: 'dedupe' });
  const turnInput = { run: testRun, agent: getAgent('claude-reader'), parentSpanId: parent.id, messages: [{ role: 'user', content: testRun.goal }], executionScopeId: 'dedupe' };
  const before = (await calls()).length;
  const turns = await Promise.all([runAgentTurn(turnInput), runAgentTurn(turnInput)]); assert.equal(turns[0].content, turns[1].content);
  await runAgentTurn(turnInput); assert.equal((await calls()).length, before + 1);
  const stale = createExecution({ runId: testRun.id, agentId: 'claude-reader', scopeId: 'crashed', driver: 'claude-cli', agentVersion: 1, cwd: workspace });
  interruptStaleExecutions(); assert.equal(getExecution(stale.id).status, 'interrupted');
  await assert.rejects(() => runAgentTurn({ ...turnInput, executionScopeId: 'crashed' }), (error) => error.code === 'interrupted');
  assert.throws(() => parseAgentMarkdown('bad.agent.md', '---\nmodel: default\nexecution: {kind: external, driver: claude-cli}\npermissionMode: auto\n---\nread'), /只读/);
  const parser = new NativeEventParser('claude-cli', () => {});
  parser.accept({ type: 'system', subtype: 'init', session_id: 'one' }); assert.throws(() => parser.accept({ type: 'system', subtype: 'init', session_id: 'two' }), /不同会话/);
  assert.deepEqual(await readdir(workspace), ['README.md']); assert.equal(await readFile(path.join(workspace, 'README.md'), 'utf8'), '# Fixture repository\n');
  console.log('external agent verification passed: readonly analysis, framing, failures, sessions, cancellation, timeout, replay guard');
} finally {
  unsubscribe(); await shutdownExternalAgents(); await app.close(); closeDatabase(); await rm(root, { recursive: true, force: true });
}
