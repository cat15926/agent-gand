import assert from 'node:assert/strict';
process.env.EXTERNAL_WORKSPACE_MODE = 'registered'; // Retain the phase B direct-workspace compatibility contract.
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-b-'));
const workspace = path.join(root, 'repo with spaces'); await mkdir(workspace);
await writeFile(path.join(workspace, 'sum.mjs'), 'export const sum = () => 0;\n');
await writeFile(path.join(workspace, 'sum.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.mjs'; test('sum', () => assert.equal(sum(2, 3), 5));\n");
execFileSync('git', ['init', '-q', workspace]); execFileSync('git', ['-C', workspace, 'add', '.']);
execFileSync('git', ['-C', workspace, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
const cli = path.join(root, 'fake native'); await copyFile(new URL('./fixtures/external-agent-b.mjs', import.meta.url), cli); await chmod(cli, 0o755);
const log = path.join(root, 'native.jsonl'); await writeFile(log, '');
const sourceHome = path.join(root, 'codex-home'); await mkdir(sourceHome); await writeFile(path.join(sourceHome, 'config.toml'), 'untrusted fixture user configuration');
const executionHome = path.join(root, 'dedicated-home'); await mkdir(executionHome, { mode: 0o700 }); await writeFile(path.join(executionHome, 'auth.json'), '{"fixture":"not-a-credential"}', { mode: 0o600 });
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '', EXTERNAL_CODEX_COMMAND: cli, EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: cli, EXTERNAL_CODEX_HOME: executionHome, EXTERNAL_AGENT_TIMEOUT_MS: '4000', ANTHROPIC_API_KEY: 'fixture-not-used', FAKE_B_LOG: log, CODEX_HOME: sourceHome });
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { db, closeDatabase } = await import('../apps/server/src/db/database.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { getRun, createRun, startSpan, finishRun, listRunAgentSnapshots } = await import('../apps/server/src/runs/trace.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const { sdkOptions } = await import('../apps/server/src/execution/sdkOptions.ts');
const { sdkPermission } = await import('../apps/server/src/execution/policy.ts');
const { runTaskSchedule } = await import('../apps/server/src/orchestration/scheduler.ts');
const { createTask, listTasks } = await import('../apps/server/src/messaging/tasks.ts');
const { createConversation } = await import('../apps/server/src/conversations/service.ts');
const { listReviews } = await import('../apps/server/src/tasks/reviews.ts');
const app = Fastify(); await registerRoutes(app); const registered = registerExternal({ path: workspace });
const api = async (url, method = 'GET', body) => { const response = await app.inject({ url, method, ...(body ? { payload: body } : {}) }); return { status: response.statusCode, data: response.json() }; };
const reset = () => execFileSync('git', ['-C', workspace, 'checkout', '--', 'sum.mjs']);
const source = () => readFile(path.join(workspace, 'sum.mjs'), 'utf8');
const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
async function waitFor(fn, description, ms = 10000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('Timeout: ' + description); }
const input = (id, driver, mode = 'confirm', extra = {}) => ({ id, name: id, description: '双向验收', systemPrompt: '按任务实现并测试。', model: 'default', execution: { kind: 'external', driver }, tools: [], disallowedTools: [], permissionMode: mode, capabilities: ['execute'], color: '#3366aa', avatar: '', ...extra });
async function room(id, scenario = 'write') { const response = await api('/api/conversations', 'POST', { goal: 'SCENARIO:' + scenario, mode: 'pipeline', agentIds: [id], workspace: 'ext:' + registered.id }); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data.run; }
async function pending(runId) { return (await api('/api/approvals?status=pending')).data.filter((item) => item.runId === runId); }
const decide = (id, decision) => api(`/api/approvals/${id}/decide`, 'POST', { decision });
async function approveAll(runId) { for (const approval of await pending(runId)) assert.equal((await decide(approval.id, 'approve')).status, 200); }
async function finished(runId) { await waitFor(() => ['completed', 'failed', 'cancelled'].includes(getRun(runId)?.status), 'run completed'); await waitFor(async () => (await api(`/api/runs/${runId}/executions`)).data.every((record) => record.status !== 'running'), 'executions settled'); return (await api(`/api/runs/${runId}/executions`)).data; }
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

try {
  // SDK hook seam uses the actual options builder; permission modes never bypass PreToolUse.
  const opts = sdkOptions({ cwd: workspace, prompt: '', instructions: '', model: 'default', permissionMode: 'confirm', nativeTools: [] }, async () => false);
  assert.deepEqual(opts.settingSources, []); assert.deepEqual(opts.allowedTools, []); assert.equal(opts.sandbox.allowUnsandboxedCommands, false); assert.equal(opts.sandbox.failIfUnavailable, true);
  const hook = opts.hooks.PreToolUse[0].hooks[0];
  assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'sum.mjs' } }, 'one', {})).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(sdkPermission({ permissionMode: 'auto', execution: { kind: 'external', driver: 'claude-sdk', nativeTools: ['Read'] } }, workspace, 'Write', { file_path: 'sum.mjs' }), 'deny');
  await symlink(root, path.join(workspace, 'outside'));
  assert.equal(sdkPermission({ permissionMode: 'confirm', execution: { kind: 'external', driver: 'claude-sdk' } }, workspace, 'Write', { file_path: 'outside/escape.mjs' }), 'deny');
  await rm(path.join(workspace, 'outside'));
  for (const [id, driver] of [['sdk-coder', 'claude-sdk'], ['app-coder', 'codex-app-server']]) {
    assert.equal((await api('/api/agents', 'POST', input(id, driver))).status, 201);
    assert.equal((await api('/api/agents/validate', 'POST', input(id, driver, 'confirm', { capabilities: ['coordinate'] }))).status, 400);
    assert.equal((await api('/api/conversations', 'POST', { goal: 'read', mode: 'supervisor', supervisorId: id, agentIds: [id] })).status, 400);
    reset(); const run = await room(id, 'duplicate'); const card = await waitFor(async () => (await pending(run.id))[0], 'file approval');
    assert.equal(await source(), 'export const sum = () => 0;\n', 'Approval must precede writing');
    assert.ok(card.native.executionId); assert.equal(card.native.editable, false);
    assert.equal((await decide(card.id, 'edit')).status, 400);
    assert.equal((await decide(card.id, 'approve')).status, 200);
    const command = await waitFor(async () => (await pending(run.id))[0], 'test command approval');
    const beforeTest = await calls();
    assert.ok(!beforeTest.some((call) => call.kind === 'test' && call.pid === beforeTest.filter((x) => x.kind === 'start').at(-1).pid));
    assert.equal((await decide(command.id, 'approve')).status, 200);
    const [execution] = await finished(run.id); assert.equal(execution.status, 'completed'); assert.match(execution.evidence.afterDiff, /a \+ b/); assert.ok(execution.evidence.commands.some((command) => command.output.includes('pass 1')));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM external_agent_approvals WHERE execution_id=?').get(execution.id).n, 2, 'Duplicate requests must reuse approval cards');
    assert.ok(!alive((await calls()).filter((x) => x.kind === 'start').at(-1).pid));
    reset(); const rejected = await room(id); const rejectCard = await waitFor(async () => (await pending(rejected.id))[0], 'reject card');
    assert.equal((await decide(rejectCard.id, 'reject')).status, 200); await finished(rejected.id); assert.equal(await source(), 'export const sum = () => 0;\n');
    reset(); const escape = await room(id, 'escape'); await finished(escape.id); assert.equal((await pending(escape.id)).length, 0); await assert.rejects(() => readFile(path.join(root, 'escape.mjs')));
    reset(); const stopped = await room(id, 'stall'); const oldCard = await waitFor(async () => (await pending(stopped.id))[0], 'stop card');
    assert.equal((await api(`/api/runs/${stopped.id}/stop`, 'POST')).status, 200); await finished(stopped.id); assert.equal((await decide(oldCard.id, 'approve')).status, 409); assert.equal(await source(), 'export const sum = () => 0;\n');
    // A stubborn native child starts after an accepted request; timeout must kill the group.
    const timeout = await room(id, 'timeout'); const timeoutCard = await waitFor(async () => (await pending(timeout.id))[0], 'timeout card'); await decide(timeoutCard.id, 'approve');
    const child = await waitFor(async () => (await calls()).filter((x) => x.kind === 'child').at(-1), 'stubborn child');
    const [failure] = await finished(timeout.id); assert.equal(failure.errorCode, 'timeout'); await waitFor(() => !alive(child.pid) && !alive(child.childPid), 'no orphan processes');
    assert.equal((await pending(timeout.id)).length, 0);
  }
  assert.equal((await api('/api/agents/validate', 'POST', input('auto-app', 'codex-app-server', 'auto'))).status, 400);
  assert.equal((await api('/api/agents', 'POST', input('auto-sdk', 'claude-sdk', 'auto', { execution: { kind: 'external', driver: 'claude-sdk', nativeTools: ['Write', 'Bash'] } }))).status, 201);
  reset(); const automatic = await room('auto-sdk'); assert.equal((await finished(automatic.id))[0].status, 'completed'); assert.equal((await pending(automatic.id)).length, 0);
  assert.equal((await api('/api/agents/validate', 'POST', input('list-app', 'codex-app-server', 'confirm', { execution: { kind: 'external', driver: 'codex-app-server', nativeTools: ['Write'] } }))).status, 400);
  assert.equal((await api('/api/agents', 'POST', input('unsafe-app', 'codex-app-server', 'confirm', { model: 'unsafe-policy' }))).status, 201);
  assert.equal((await finished((await room('unsafe-app')).id))[0].errorCode, 'policy_rejected');
  const foreign = await room('app-coder', 'foreign'); assert.equal((await finished(foreign.id))[0].errorCode, 'protocol_error');
  // Real scheduler, existing structured review contract: FAIL -> revision -> PASS.
  assert.equal((await api('/api/agents', 'POST', input('app-reviewer', 'codex-app-server', 'readonly', { capabilities: ['review'] }))).status, 201);
  assert.equal((await api('/api/agents', 'POST', { ...input('builtin-manager', 'claude-sdk'), execution: { kind: 'builtin-llm' }, model: 'mock:manager', capabilities: ['coordinate'], permissionMode: 'readonly' })).status, 201);
  reset(); const conversation = createConversation({ title: '返工验收', mode: 'supervisor', agentIds: ['builtin-manager', 'sdk-coder', 'app-reviewer'], workspace: 'ext:' + registered.id, supervisorId: 'builtin-manager', defaultReviewerId: 'app-reviewer' });
  const run = createRun('SCENARIO:revision', 'supervisor', conversation.agentIds, conversation.workspace, 'builtin-manager', conversation.id, 1, 'app-reviewer');
  const task = createTask({ runId: run.id, title: '求和', body: '实现 sum 并测试', createdBy: 'builtin-manager', assignee: 'sdk-coder', reviewerId: 'app-reviewer', acceptanceCriteria: ['sum(2,3)=5'] });
  const scheduling = runTaskSchedule({ run, agents: listRunAgentSnapshots(run.id), parentSpanId: startSpan(run.id, { spanKind: 'run', name: 'test' }).id });
  let scheduled = false; scheduling.then(() => { scheduled = true; }, () => { scheduled = true; });
  await waitFor(async () => { await approveAll(run.id); return scheduled; }, 'FAIL then PASS scheduling', 15000);
  const result = await scheduling; assert.equal(result.failed, false); assert.equal(listTasks(run.id)[0].attempt, 2); assert.deepEqual(listReviews(task.id).map((review) => review.verdict), ['FAIL', 'PASS']);
  const records = (await api(`/api/runs/${run.id}/executions`)).data; assert.equal(records.length, 4); assert.ok(records.filter((record) => record.agentId === 'app-reviewer').every((record) => record.permissionMode === 'readonly'));
  assert.ok((await calls()).filter((call) => call.kind === 'start' && call.prompt.includes('__AGENT_GAND_REVIEW_JSON__')).every((call) => call.prompt.includes('平台采集的 Git HEAD') && call.prompt.includes('pass')));
  finishRun(run.id, 'completed');
  assert.equal((await api('/api/agents', 'POST', input('sdk-reviewer', 'claude-sdk', 'readonly', { capabilities: ['review'] }))).status, 201);
  reset(); const actualRoom = await api('/api/conversations', 'POST', { goal: 'SCENARIO:write', mode: 'supervisor', agentIds: ['builtin-manager', 'app-coder', 'sdk-reviewer'], supervisorId: 'builtin-manager', defaultReviewerId: 'sdk-reviewer', workspace: 'ext:' + registered.id });
  assert.equal(actualRoom.status, 201, JSON.stringify(actualRoom.data));
  await waitFor(async () => { await approveAll(actualRoom.data.run.id); return ['completed', 'failed'].includes(getRun(actualRoom.data.run.id)?.status); }, 'full Supervisor API orchestration', 15000);
  assert.equal(getRun(actualRoom.data.run.id).status, 'completed');
  assert.equal(listReviews(listTasks(actualRoom.data.run.id)[0].id)[0].verdict, 'PASS');
  const codexCalls = (await calls()).filter((call) => call.kind === 'start' && !call.sdk);
  assert.ok(codexCalls.every((call) => call.nativeHome !== sourceHome && call.inheritedConfig === false));
  assert.ok(codexCalls.every((call) => call.nativeHome === executionHome));
  assert.equal(await readFile(path.join(executionHome, 'auth.json'), 'utf8'), '{"fixture":"not-a-credential"}');
  await writeFile(path.join(executionHome, 'config.toml'), 'approval_policy="never"');
  const contaminated = await room('app-coder'); assert.equal((await finished(contaminated.id))[0].errorCode, 'policy_rejected'); await rm(path.join(executionHome, 'config.toml'));
  console.log('Phase B verification passed: approval before writes/tests, rejection, deduplication, fences, policy admission, timeout cleanup, actual Git/test evidence, FAIL -> revision -> PASS');
} catch (error) {
  console.error(db.prepare('SELECT record FROM external_agent_executions').all().map((row) => { const record = JSON.parse(row.record); return { driver: record.driver, scopeId: record.scopeId, status: record.status, error: record.error }; }));
  throw error;
} finally { await shutdownExternalAgents(); await app.close(); closeDatabase(); await rm(root, { recursive: true, force: true }); }
