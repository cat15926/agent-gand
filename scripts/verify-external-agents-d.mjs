import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-d-'));
const source = path.join(root, 'repo'); await mkdir(source); await writeFile(path.join(source, 'README.md'), 'baseline\n');
execFileSync('git', ['init', '-q', source]); execFileSync('git', ['-C', source, 'add', '.']);
execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'baseline']);
await writeFile(path.join(source, 'README.md'), 'user dirty change\n'); await writeFile(path.join(source, 'preexisting.txt'), 'user untracked\n');
const cli = path.join(root, 'native'); await copyFile(new URL('./fixtures/external-agent-d.mjs', import.meta.url), cli); await chmod(cli, 0o755);
const logPath = path.join(root, 'native.jsonl'); await writeFile(logPath, '');
const nativeHome = path.join(root, 'codex'); await mkdir(nativeHome); await writeFile(path.join(nativeHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'fixture-account' } }));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'agents'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '',
  EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: cli, EXTERNAL_CODEX_COMMAND: cli, EXTERNAL_CODEX_HOME: nativeHome, EXTERNAL_CLAUDE_HOME: path.join(root, 'claude'),
  EXTERNAL_WORKSPACE_MODE: 'isolated', EXTERNAL_AGENT_TIMEOUT_MS: '12000', ANTHROPIC_API_KEY: 'fixture-no-inference', FAKE_D_LOG: logPath });
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { db, closeDatabase } = await import('../apps/server/src/db/database.ts');
const { registerExternal } = await import('../apps/server/src/workspaces/external.ts');
const { getIsolatedWorkspace, exportWorkspacePatch } = await import('../apps/server/src/workspaces/isolated.ts');
const { createConversation } = await import('../apps/server/src/conversations/service.ts');
const { createRun, startSpan, finishRun, setRunStatus, listRunAgentSnapshots } = await import('../apps/server/src/runs/trace.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { listExecutions, createExecution, updateExecution } = await import('../apps/server/src/execution/store.ts');
const { createTask, getTask, recoverInterruptedTasks } = await import('../apps/server/src/messaging/tasks.ts');
const { createAttempt } = await import('../apps/server/src/tasks/attempts.ts');
const { resolveSandboxPath } = await import('../apps/server/src/tools/builtin/index.ts');
const { decide } = await import('../apps/server/src/hitl/approvals.ts');
const { containedPath } = await import('../apps/server/src/execution/policy.ts');
const { recoverExternalExecutions } = await import('../apps/server/src/execution/recovery.ts');
const { claimRuntimeHost, releaseRuntimeHost, processIdentity } = await import('../apps/server/src/execution/host.ts');
const { acquireDurableLease } = await import('../apps/server/src/execution/leases.ts');
const { shutdownExternalAgents } = await import('../apps/server/src/execution/runner.ts');
const app = Fastify(); await registerRoutes(app); const registered = registerExternal({ path: source });
const logs = async () => (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const api = async (url, method = 'GET', body) => { const response = await app.inject({ url, method, ...(body ? { payload: body } : {}) }); return { status: response.statusCode, data: response.json() }; };
async function waitFor(fn, label, timeout = 15000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error('Timeout: ' + label); }
async function agent(id, driver, model, more = {}) {
  const result = await api('/api/agents', 'POST', { id, name: id, description: 'D fixture', systemPrompt: 'Execute the current task.', model, execution: { kind: 'external', driver }, capabilities: ['execute'], permissionMode: 'readonly', tools: [], disallowedTools: [], color: '#7755aa', avatar: '', ...more }); assert.equal(result.status, 201, JSON.stringify(result.data));
}
function seed(ids, conversation) {
  const room = conversation ?? createConversation({ title: 'D fixture', mode: 'pipeline', agentIds: ids, workspace: 'ext:' + registered.id });
  const run = createRun('D fixture', 'pipeline', ids, room.workspace, null, room.id, (room.runCount ?? 0) + 1); setRunStatus(run.id, 'running'); return { room, run };
}
function opts(run, content, scope = 'd', more = {}) { return { run, agent: listRunAgentSnapshots(run.id)[0], parentSpanId: startSpan(run.id, { spanKind: 'agent', name: 'D' }).id,
  executionScopeId: scope, messages: [{ role: 'system', content: 'Execute the current task.' }, { role: 'user', content }], ...more }; }
const loader = fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url));
const helper = fileURLToPath(new URL('./helpers/external-fault-child.mjs', import.meta.url)); const children = [];
function child(mode, extra = {}) { const instance = spawn(process.execPath, ['--import', loader, helper, mode], { cwd: process.cwd(), env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(instance); let out = ''; let err = ''; instance.stdout.on('data', (chunk) => { out += chunk; }); instance.stderr.on('data', (chunk) => { err += chunk; }); const done = new Promise((resolve) => instance.once('close', (code, signal) => resolve({ code, signal, out, err }))); return { instance, done, output: () => out }; }

try {
  await agent('sdk-write', 'claude-sdk', 'fixture-write', { permissionMode: 'auto', execution: { kind: 'external', driver: 'claude-sdk', nativeTools: ['Write'] } });
  await agent('sdk-review', 'claude-sdk', 'fixture-review');
  const alpha = seed(['sdk-write']); const beta = seed(['sdk-write']);
  await Promise.all([runAgentTurn(opts(alpha.run, 'D_CONTENT=alpha')), runAgentTurn(opts(beta.run, 'D_CONTENT=beta'))]);
  const a = listExecutions(alpha.run.id)[0]; const b = listExecutions(beta.run.id)[0];
  assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.cwd, source);
  assert.equal(await readFile(path.join(a.cwd, 'work.txt'), 'utf8'), 'alpha'); assert.equal(await readFile(path.join(b.cwd, 'work.txt'), 'utf8'), 'beta');
  assert.equal(await readFile(path.join(a.cwd, 'README.md'), 'utf8'), 'user dirty change\n'); assert.equal(await readFile(path.join(a.cwd, 'preexisting.txt'), 'utf8'), 'user untracked\n');
  await assert.rejects(() => readFile(path.join(source, 'work.txt')));
  assert.equal(await readFile(path.join(source, 'README.md'), 'utf8'), 'user dirty change\n');
  await writeFile(path.join(a.cwd, 'work.txt'), 'later mutation');
  const review = await runAgentTurn(opts(alpha.run, 'Review the fixed snapshot.', 'review', { agent: (await api('/api/agents')).data.find((item) => item.id === 'sdk-review'), displayKind: 'review_protocol', reviewSourceExecutionId: a.id }));
  assert.equal(JSON.parse(review.content).summary, 'alpha'); assert.equal(listExecutions(alpha.run.id).at(-1).cwd, a.snapshot.path);
  const patch = await exportWorkspacePatch(alpha.run.id); assert.ok(patch.includes('+alpha')); assert.ok(!patch.includes('later mutation'));
  execFileSync('git', ['-C', source, 'apply', '--check', '-'], { input: patch });
  assert.equal((await app.inject({ url: `/api/runs/${alpha.run.id}/workspace/patch` })).statusCode, 200);
  assert.equal(resolveSandboxPath('.git', { runId: alpha.run.id, workspace: alpha.run.workspace }).readOnly, true);
  assert.equal(resolveSandboxPath('.GIT', { runId: alpha.run.id, workspace: alpha.run.workspace }).readOnly, true);
  assert.throws(() => containedPath(a.cwd, '.GIT', true));
  assert.equal(resolveSandboxPath('work.txt', { runId: alpha.run.id, workspace: alpha.run.workspace, workspaceRoot: a.snapshot.path }).readOnly, true);
  const builtinCreated = await api('/api/agents', 'POST', { id: 'builtin-write', name: 'builtin-write', description: 'Mixed team fixture', systemPrompt: 'Execute tools.', model: 'mock:coder', capabilities: ['execute'], permissionMode: 'auto', tools: ['fs.write', 'fs.read'], disallowedTools: [], color: '#7755aa', avatar: '' });
  assert.equal(builtinCreated.status, 201);
  const mixedTurn = runAgentTurn(opts(alpha.run, '[tool:fs.write]', 'mixed-write', { agent: builtinCreated.data }));
  void mixedTurn.catch(() => {});
  const mixedApproval = await waitFor(() => db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(alpha.run.id), 'mixed builtin approval');
  // This fixture calls AgentTurn directly; the REST decision also wakes a full Pipeline.
  decide(mixedApproval.id, { decision: 'approve', by: 'fixture' });
  await mixedTurn;
  assert.equal(await readFile(path.join(a.cwd, 'mock-demo.txt'), 'utf8'), 'mock 写入演示内容');
  await assert.rejects(() => readFile(path.join(source, 'mock-demo.txt')));
  finishRun(alpha.run.id, 'completed'); finishRun(beta.run.id, 'completed');

  for (const driver of ['claude-sdk', 'codex-app-server']) {
    const id = driver === 'claude-sdk' ? 'sdk-session' : 'codex-session';
    await agent(id, driver, 'fixture-session', { execution: { kind: 'external', driver, sessionPolicy: 'conversation' } });
    const first = seed([id]); await runAgentTurn(opts(first.run, 'OLD_HISTORY_MARKER\nFirst task')); finishRun(first.run.id, 'completed');
    const previous = listExecutions(first.run.id)[0]; const second = seed([id], first.room);
    await runAgentTurn(opts(second.run, 'OLD_HISTORY_MARKER\nSecond task')); finishRun(second.run.id, 'completed');
    const resumed = listExecutions(second.run.id)[0]; assert.equal(resumed.sessionMode, 'resume'); assert.equal(resumed.sessionId, previous.sessionId); assert.equal(resumed.cwd, previous.cwd);
    const sent = (await logs()).filter((item) => item.kind === 'turn' && item.thread === previous.sessionId).at(-1).prompt;
    assert.ok(!sent.includes('OLD_HISTORY_MARKER')); assert.ok(sent.includes('Second task'));
    if (driver === 'codex-app-server') { assert.equal(resumed.tokensIn, 10); assert.equal(resumed.tokensOut, 5); } else { assert.equal(resumed.tokensIn, null); assert.equal(resumed.costUsd, null); }
    // Restart with only completed executions leaves reusable bindings intact.
    await recoverExternalExecutions(); const third = seed([id], first.room);
    await runAgentTurn(opts(third.run, 'OLD_HISTORY_MARKER\nThird task')); finishRun(third.run.id, 'completed'); assert.equal(listExecutions(third.run.id)[0].sessionMode, 'resume');
    if (driver === 'claude-sdk') {
      await writeFile(path.join(previous.cwd, 'reject-resume'), 'fixture');
      const fourth = seed([id], first.room); await runAgentTurn(opts(fourth.run, 'Fourth task')); finishRun(fourth.run.id, 'completed');
      const cold = listExecutions(fourth.run.id)[0]; assert.equal(cold.sessionMode, 'cold'); assert.notEqual(cold.sessionId, previous.sessionId); assert.match(cold.sessionReason, /预检失败/);
      await rm(path.join(previous.cwd, 'reject-resume'));
      const persisted = JSON.parse(db.prepare("SELECT record FROM external_agent_sessions WHERE id=?").get(cold.sessionBindingId).record);
      await rm(path.join(persisted.configDir, 'projects', persisted.projectDir, persisted.nativeId + '.jsonl'));
      const fifth = seed([id], first.room); await runAgentTurn(opts(fifth.run, 'Fifth task')); finishRun(fifth.run.id, 'completed');
      assert.equal(listExecutions(fifth.run.id)[0].sessionMode, 'cold'); assert.match(listExecutions(fifth.run.id)[0].sessionReason, /文件缺失/);
      process.env.ANTHROPIC_API_KEY = 'fixture-other-account';
      const sixth = seed([id], first.room); await runAgentTurn(opts(sixth.run, 'Sixth task')); finishRun(sixth.run.id, 'completed');
      assert.equal(listExecutions(sixth.run.id)[0].sessionMode, 'cold'); process.env.ANTHROPIC_API_KEY = 'fixture-no-inference';
    }
    const cross = seed([id], first.room); const continued = await child('resume', { TEST_D_RUN: cross.run.id }).done;
    assert.equal(continued.code, 0, continued.err); assert.equal(listExecutions(cross.run.id)[0].sessionMode, 'resume');
  }
  await agent('sdk-run-session', 'claude-sdk', 'fixture-session', { execution: { kind: 'external', driver: 'claude-sdk', sessionPolicy: 'run' } });
  const single = seed(['sdk-run-session']); await runAgentTurn(opts(single.run, 'Stable history\nOne', 'one')); await runAgentTurn(opts(single.run, 'Stable history\nTwo', 'two'));
  assert.equal(listExecutions(single.run.id)[1].sessionMode, 'resume'); finishRun(single.run.id, 'completed');

  // Expiry cannot steal a resource while the identity of its owning process is still live.
  const leasing = child('lease', { TEST_D_RESOURCE: 'fixture-resource' }); await waitFor(() => leasing.output().includes('held'), 'cross-process lease');
  db.prepare("UPDATE external_workspace_leases SET expires_at='2000-01-01T00:00:00.000Z' WHERE resource='fixture-resource'").run();
  assert.throws(() => acquireDurableLease('fixture-resource', 'parent-holder', false)); leasing.instance.kill('SIGKILL'); await leasing.done;
  const release = acquireDurableLease('fixture-resource', 'parent-holder', false); release();
  claimRuntimeHost(); const duplicate = await child('host').done; assert.equal(duplicate.out.trim(), 'blocked'); releaseRuntimeHost();

  for (const [id, model, permission] of [['sdk-startup', 'fixture-session', 'readonly'], ['sdk-orphan', 'fixture-wait', 'readonly'], ['sdk-crash-write', 'fixture-crash-write', 'auto'], ['sdk-approval', 'fixture-write', 'confirm'], ['sdk-terminal', 'fixture-write', 'auto']]) {
    await agent(id, 'claude-sdk', model, { permissionMode: permission, execution: { kind: 'external', driver: 'claude-sdk', sessionPolicy: 'run', ...(permission === 'auto' ? { nativeTools: ['Write'] } : {}) } });
    const test = seed([id]); const fault = child(id === 'sdk-startup' ? 'startup' : 'execute', { TEST_D_RUN: test.run.id });
    if (id === 'sdk-terminal' || id === 'sdk-startup') { const ended = await fault.done; assert.equal(ended.signal, 'SIGKILL', ended.err); }
    else {
      await waitFor(async () => {
        const execution = listExecutions(test.run.id)[0]; if (!execution) return false;
        if (id === 'sdk-approval') return db.prepare("SELECT id FROM approvals WHERE run_id=? AND status='pending'").get(test.run.id);
        return (await logs()).some((item) => item.cwd === execution.cwd && item.kind === (id === 'sdk-orphan' ? 'child-ready' : 'write'));
      }, id + ' fault boundary');
      fault.instance.kill('SIGKILL'); await fault.done;
    }
    claimRuntimeHost(); const before = listExecutions(test.run.id)[0]; const invocations = (await logs()).filter((item) => item.kind === 'turn' && item.cwd === before.cwd).length;
    await recoverExternalExecutions(); await recoverExternalExecutions();
    const after = listExecutions(test.run.id)[0];
    assert.equal((await logs()).filter((item) => item.kind === 'turn' && item.cwd === before.cwd).length, invocations, 'Recovery must not replay inference or writes');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id=? AND status='active'").get(after.id).n, 0);
    if (id === 'sdk-terminal') { assert.equal(after.status, 'completed'); await runAgentTurn(opts(test.run, 'D_CONTENT=crash evidence', 'fault')); assert.equal((await logs()).filter((item) => item.kind === 'turn' && item.cwd === before.cwd).length, invocations); }
    else { assert.equal(after.status, 'interrupted'); assert.equal(after.recovery.state, 'quiesced'); assert.ok(after.evidence); await assert.rejects(() => runAgentTurn(opts(test.run, 'Do not replay', 'fault'))); }
    if (id === 'sdk-crash-write') assert.equal(await readFile(path.join(after.cwd, 'work.txt'), 'utf8'), 'crash evidence');
    if (id === 'sdk-approval') { await assert.rejects(() => readFile(path.join(after.cwd, 'work.txt'))); assert.equal(db.prepare("SELECT COUNT(*) n FROM approvals WHERE run_id=? AND status='pending'").get(test.run.id).n, 0); }
    if (id === 'sdk-orphan') { const owned = (await logs()).find((item) => item.cwd === after.cwd && item.kind === 'child-ready'); assert.equal(processIdentity(owned.pid), null); assert.equal(processIdentity(owned.childPid), null); await assert.rejects(() => readFile(path.join(after.cwd, 'late-orphan.txt'))); }
    finishRun(test.run.id, 'failed'); releaseRuntimeHost();
  }
  // Older executions have no provable guardian ownership; PID reuse cannot authorize a kill.
  const legacy = createExecution({ runId: single.run.id, agentId: 'sdk-run-session', agentVersion: 1, scopeId: 'legacy', driver: 'claude-sdk', cwd: path.join(root, 'legacy-cwd') });
  const record = { ...legacy }; delete record.processOwnership;
  db.prepare('UPDATE external_agent_executions SET record=? WHERE id=?').run(JSON.stringify(record), legacy.id);
  await recoverExternalExecutions(); assert.equal(listExecutions(single.run.id).at(-1).recovery.state, 'attention');
  assert.throws(() => acquireDurableLease('workspace:' + legacy.cwd, 'legacy-new', false));
  const mismatch = createExecution({ runId: single.run.id, agentId: 'sdk-run-session', agentVersion: 1, scopeId: 'mismatch', driver: 'claude-sdk', cwd: path.join(root, 'mismatch-cwd') });
  db.prepare('INSERT INTO external_native_processes (token,execution_id,host,pid,status,created_at) VALUES (?,?,?,?,?,?)').run('foreign-owner-token', mismatch.id, mismatch.host, process.pid, 'active', new Date().toISOString());
  await recoverExternalExecutions(); assert.equal(listExecutions(single.run.id).at(-1).recovery.state, 'attention'); assert.ok(processIdentity(process.pid));
  const recoveryRun = seed(['sdk-run-session']).run;
  function taskExecution(task, attemptNo, status) {
    const attempt = createAttempt({ taskId: task.id, runId: recoveryRun.id, agentId: 'sdk-run-session', kind: 'work', attemptNo, inputContext: 'fixture', leaseMs: 10000 });
    const execution = createExecution({ runId: recoveryRun.id, agentId: 'sdk-run-session', agentVersion: 1, scopeId: attempt.id, driver: 'claude-sdk', cwd: root });
    updateExecution(execution.id, { attemptId: attempt.id, status });
  }
  const revised = createTask({ runId: recoveryRun.id, title: 'Successful later revision', createdBy: 'fixture' });
  taskExecution(revised, 1, 'failed'); taskExecution(revised, 2, 'completed');
  db.prepare("UPDATE tasks SET status='awaiting_review',attempt=2 WHERE id=?").run(revised.id);
  const uncertainTask = createTask({ runId: recoveryRun.id, title: 'Uncertain current attempt', createdBy: 'fixture' });
  taskExecution(uncertainTask, 1, 'interrupted'); db.prepare("UPDATE tasks SET status='in_progress',attempt=1 WHERE id=?").run(uncertainTask.id);
  recoverInterruptedTasks(); assert.notEqual(getTask(revised.id).status, 'failed'); assert.equal(getTask(uncertainTask.id).status, 'failed'); assert.equal(getTask(uncertainTask.id).attempt, 1);
  finishRun(recoveryRun.id, 'failed');
  console.log('Phase D verified: isolated dirty-baseline worktrees, immutable review/patch, guarded SIGKILL recovery, durable process/resource fences, safe cache replay, session resume and context delivery without duplicate history');
} catch (error) { console.error((await logs()).filter((item) => item.kind === 'error').slice(-6)); throw error; }
finally { for (const instance of children) if (instance.exitCode === null && instance.signalCode === null) instance.kill('SIGKILL'); await shutdownExternalAgents(); releaseRuntimeHost(); await app.close(); closeDatabase(); await rm(root, { recursive: true, force: true }); }
