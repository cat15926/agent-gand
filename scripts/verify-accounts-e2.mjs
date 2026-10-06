import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-accounts-e2-'));
const cli = path.join(root, 'codex-fixture'); const claude = path.join(root, 'claude-fixture'); const sdk = path.join(root, 'sdk-fixture');
for (const file of [cli, claude, sdk]) { await copyFile(new URL('./fixtures/account-native-e2.mjs', import.meta.url), file); await chmod(file, 0o755); }
const log = path.join(root, 'calls.jsonl'); await writeFile(log, '');
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), LOG_LEVEL: 'silent', MCP_SERVER_CMD: '', HOST: '127.0.0.1', PORT: '3010', ACCOUNT_TRUSTED_ORIGINS: 'http://127.0.0.1:3010', ACCOUNT_MASTER_KEY: '', ACCOUNT_ADMIN_TOKEN: '', LLM_OPENAI_API_KEY: 'fixture-parent-secret-openai', LLM_ANTHROPIC_API_KEY: 'fixture-parent-secret-anthropic', ANTHROPIC_API_KEY: 'fixture-parent-secret-sdk', UNRELATED_SECRET: 'fixture-parent-unrelated-secret', EXTERNAL_CODEX_COMMAND: cli, EXTERNAL_CLAUDE_COMMAND: claude, EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: sdk, EXTERNAL_AGENT_TIMEOUT_MS: '10000', COORDINATION_PLANNER_MODEL: '', COORDINATION_PLANNER_ACCOUNT_REF: '', FAKE_E2_LOG: log });
const calls = []; const inflight = new Set(); const upstream = createServer(async (req, res) => {
  try {
    let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text);
    const key = req.headers['x-api-key'] ?? req.headers.authorization?.replace('Bearer ', ''); calls.push({ key, path: req.url, body });
    if (body.model === 'stall') { inflight.add(res); res.on('close', () => inflight.delete(res)); return; }
    if (body.model === 'error') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid key: ' + key } })); return; }
    let content = body.model === 'echo-secret' ? 'echo ' + key : key?.slice(-4) ?? 'OK';
    if (body.messages?.some((item) => typeof item.content === 'string' && item.content.includes('__AGENT_GAND_COORDINATION_PLANNER__'))) content = JSON.stringify({ taskType: 'fixture', protocols: [{ protocol: 'sequential_pipeline', version: 1 }], reasonCodes: ['FIXTURE'], evidence: [], alternatives: [], missingInformation: [], confidence: 0.9, clarificationQuestion: null });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/messages')) res.end(JSON.stringify({ content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    else if (req.url.endsWith('/responses')) res.end(JSON.stringify({ output_text: content }));
    else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  } catch { res.writeHead(500).end(); }
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve)); const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts'); const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
const db = await import('../apps/server/src/db/database.ts'); const store = await import('../apps/server/src/accounts/store.ts');
const resolver = await import('../apps/server/src/accounts/resolver.ts'); const { providerForAgent } = await import('../apps/server/src/llm/router.ts');
const { createRun, finishRun, listRunAgentSnapshots, getRun, startSpan, runDetail } = await import('../apps/server/src/runs/trace.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { prepareNativeSession } = await import('../apps/server/src/execution/sessions.ts'); const { createExecution } = await import('../apps/server/src/execution/store.ts');
const { recoverAccountLogins, shutdownAccountLogins } = await import('../apps/server/src/accounts/login.ts');
const { recoverAccountTests, shutdownAccountTests } = await import('../apps/server/src/accounts/actions.ts');
const { releaseRuntimeHost, claimRuntimeHost } = await import('../apps/server/src/execution/host.ts');
const { rememberSecret, redactSecrets, redactSnapshot, secretSafeDelta } = await import('../apps/server/src/accounts/secrets.ts');
claimRuntimeHost(); const app = Fastify(); await app.register(registerRoutes); await registerAccountRoutes(app);
let cookie = ''; let csrf = ''; const secrets = ['fixture-supplier-one-A123', 'fixture-supplier-two-B456', 'fixture-supplier-rotate-C789'];
const api = async (url, method = 'GET', payload, override = {}) => {
  const response = await app.inject({ url, method, headers: { host: '127.0.0.1:3010', cookie, 'x-gand-csrf': csrf, ...override }, ...(payload === undefined ? {} : { payload }) });
  for (const key of secrets) assert.ok(!response.body.includes(key), 'public API must not leak supplier key');
  return { status: response.statusCode, data: response.json(), headers: response.headers };
};
async function connect() { const response = await api('/api/accounts/session', 'POST', undefined, { 'x-gand-bootstrap': '1', cookie: '' }); assert.equal(response.status, 200); cookie = response.headers['set-cookie'].split(';')[0]; csrf = response.data.csrfToken; }
async function account(name, key, protocols, url = baseUrl) { const response = await api('/api/accounts', 'POST', { displayName: name, provider: 'custom', apiKey: key, protocols, baseUrl: url, models: ['fixture-model'], defaultModel: 'fixture-model', timeoutMs: 5000 }); assert.equal(response.status, 201); return response.data; }
const input = (id, account, backend = 'builtin-openai', extra = {}) => ({ id, name: id, description: 'E2 fixture', systemPrompt: 'Reply text', model: backend.startsWith('builtin-') ? `${backend === 'builtin-anthropic' ? 'anthropic' : 'openai'}:fixture-model` : 'fixture-model', accountRef: account.id, ...(backend.startsWith('builtin-') ? {} : { execution: { kind: 'external', driver: backend } }), tools: [], disallowedTools: [], permissionMode: 'readonly', capabilities: ['execute'], color: '#3366aa', avatar: '', ...extra });
async function role(id, account, backend, extra) { const response = await api('/api/agents', 'POST', input(id, account, backend, extra)); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; }
const request = (agent) => ({ model: agent.model, messages: [{ role: 'user', content: 'OK' }], maxTokens: 32 });
async function waitFor(fn, description, ms = 10000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 30)); } throw new Error('Timeout: ' + description); }
try {
  await connect();
  const one = await account('One', secrets[0], ['openai-chat-completions', 'openai-responses'], baseUrl + '/v1');
  const two = await account('Two', secrets[1], ['openai-chat-completions'], baseUrl + '/v1'); const anth = await account('Anthropic', secrets[1], ['anthropic-messages'], baseUrl + '/v1');
  const a = await role('role-one', one); const b = await role('role-two', two); const c = await role('role-anth', anth, 'builtin-anthropic');
  const run = createRun('frozen', 'pipeline', [a.id, b.id, c.id]); assert.equal(resolver.listRunAccountBindings(run.id).length, 3); assert.equal(runDetail(run.id).accountBindings.length, 3);
  const responses = await Promise.all([a,b,c].map((agent) => providerForAgent(agent, run.id).chat(request(agent)))); assert.deepEqual(responses.map((res) => res.content), ['A123', 'B456', 'B456']); assert.ok(calls.some((call) => call.path === '/v1/messages'));
  let rotated = (await api(`/api/accounts/${one.id}/credentials`, 'POST', { apiKey: secrets[2], expectedVersion: 1 })).data;
  rotated = (await api(`/api/accounts/${one.id}`, 'PATCH', { expectedVersion: rotated.version, baseUrl: baseUrl + '/other', models: ['fixture-model'] })).data;
  const current = createRun('new version', 'pipeline', [a.id]); assert.equal((await providerForAgent(a, run.id).chat(request(a))).content, 'A123'); assert.equal((await providerForAgent(a, current.id).chat(request(a))).content, 'C789'); assert.equal(calls.at(-1).path, '/other/chat/completions');
  const paused = (await api(`/api/accounts/${one.id}`, 'PATCH', { expectedVersion: rotated.version, enabled: false })).data;
  assert.throws(() => createRun('must reject', 'pipeline', [a.id]), /停用/); assert.equal((await providerForAgent(a, run.id).chat(request(a))).content, 'A123'); assert.throws(() => resolver.resolveAccount(a, 'missing'), /禁止回退/);
  const incompatiblePreview = await api('/api/agents/preflight', 'POST', input('bad', two, 'codex-app-server')); assert.equal(incompatiblePreview.status, 200); assert.equal(incompatiblePreview.data.ok, false); assert.ok(incompatiblePreview.data.issues.accountRef); assert.equal((await api('/api/agents/preflight', 'POST', input('good', two))).data.ok, true);
  const planner = await role('account-planner', two, 'builtin-openai', { capabilities: ['coordinate', 'execute'] });
  const { previewCoordination } = await import('../apps/server/src/coordination/service.ts'); const planned = await previewCoordination({ goal: '给出一份简短的解释', agentIds: [planner.id, b.id] });
  assert.ok(['model', 'model_repaired'].includes(planned.draft.planning.source)); assert.equal(calls.at(-1).key, secrets[1]);
  const sdkRole = await role('sdk-account', anth, 'claude-sdk'); await api(`/api/accounts/${one.id}`, 'PATCH', { expectedVersion: paused.version, enabled: true }); const appRole = await role('codex-account', one, 'codex-app-server');
  for (const agent of [sdkRole, appRole]) {
    const nativeRun = createRun('managed execution', 'pipeline', [agent.id]); const result = await runAgentTurn({ run: nativeRun, agent: listRunAgentSnapshots(nativeRun.id)[0], messages: [{ role: 'user', content: 'Reply only OK.' }], parentSpanId: startSpan(nativeRun.id, { spanKind: 'run', name: 'E2' }).id });
    assert.equal(result.content, agent.id === 'sdk-account' ? 'B456' : 'C789'); finishRun(nativeRun.id, 'completed');
  }
  const { getDriver } = await import('../apps/server/src/execution/drivers.ts'); await mkdir(path.join(root, 'managed-approval')); const approvalCwd = await realpath(path.join(root, 'managed-approval')); const requested = [];
  const approved = await getDriver('codex-app-server').invoke({ account: resolver.resolveAccount(appRole), cwd: approvalCwd, model: 'managed-approval-fence', instructions: 'fixture approval', prompt: 'fixture', signal: new AbortController().signal, timeoutMs: 5000, permissionMode: 'confirm', onEvent: () => {}, requestApproval: async (_id, tool) => { requested.push(tool); return true; } });
  assert.equal(approved, 'OK'); assert.deepEqual(requested, ['fileChange']); assert.equal(await readFile(path.join(approvalCwd, 'edited.txt'), 'utf8'), 'fixture change');
  for (const [accountId, backend] of [[anth.id, 'claude-sdk'], [anth.id, 'claude-cli'], [one.id, 'codex-app-server'], [one.id, 'codex-exec'], [two.id, 'builtin-openai']]) {
    const response = await api(`/api/accounts/${accountId}/test`, 'POST', { expectedVersion: store.getAccount(accountId).version, backend, model: 'fixture-model' }); assert.equal(response.status, 200, JSON.stringify(response.data)); assert.equal(response.data.status, 'passed', JSON.stringify(response.data));
  }
  assert.equal(store.getAccount(two.id).lastTest.backend, 'builtin-openai'); const testVersion = store.getAccount(two.id).version;
  await api(`/api/accounts/${two.id}`, 'PATCH', { expectedVersion: testVersion, displayName: 'rename only' }); assert.equal(store.getAccount(two.id).testStatus, 'passed'); await api(`/api/accounts/${two.id}/credentials`, 'POST', { expectedVersion: testVersion + 1, apiKey: secrets[0] }); assert.equal(store.getAccount(two.id).testStatus, 'stale');
  assert.equal((await api(`/api/accounts/${two.id}/test`, 'POST', { expectedVersion: store.getAccount(two.id).version, backend: 'builtin-openai', model: 'error' })).data.status, 'failed');
  const echo = { ...a, model: 'openai:echo-secret' }; assert.ok(!(await providerForAgent(echo, current.id).chat(request(echo))).content.includes(secrets[2]));
  assert.equal(JSON.parse(redactSecrets(JSON.stringify({ access_token: 'unknown-oauth-fixture', authorization: 'Bearer unknown-bearer-fixture' }))).access_token, '[redacted]');
  rememberSecret(secrets[0]); const deltas = []; const safe = secretSafeDelta((text) => deltas.push(text)); for (const char of 'prefix ' + secrets[0] + ' suffix') safe.push(char); safe.finish(); assert.equal(deltas.join(''), 'prefix [redacted] suffix');
  for (let length = 1; length < secrets[0].length; length++) assert.ok(!redactSnapshot('prefix ' + secrets[0].slice(0, length)).endsWith(secrets[0].slice(0, length)));
  const native = (await api('/api/accounts', 'POST', { displayName: 'Native Codex', authType: 'native_login', nativeClient: 'codex' })).data;
  assert.equal(native.authentication, 'pending'); assert.equal((await api(`/api/accounts/${native.id}/test`, 'POST', { expectedVersion: 1, backend: 'codex-app-server', model: 'default' })).status, 409);
  const login = (await api(`/api/accounts/${native.id}/login`, 'POST', { expectedVersion: 1 })).data;
  const ownerCookie = cookie; const ownerCsrf = csrf; await connect(); assert.equal((await api(`/api/accounts/logins/${login.id}`)).status, 404); cookie = ownerCookie; csrf = ownerCsrf;
  await waitFor(() => store.getAccount(native.id).authentication === 'authenticated', 'Codex device login'); assert.equal((await api(`/api/accounts/logins/${login.id}`)).data.userCode, null); assert.equal(store.getAccount(native.id).identityGeneration, 1);
  const nativeRole = await role('native-codex', store.getAccount(native.id), 'codex-app-server', { model: 'default', execution: { kind: 'external', driver: 'codex-app-server', sessionPolicy: 'run' } });
  const frozenNative = createRun('native freeze', 'pipeline', [nativeRole.id]); const firstConnection = resolver.resolveAccount(nativeRole, frozenNative.id);
  await api(`/api/accounts/${native.id}/login`, 'POST', { expectedVersion: store.getAccount(native.id).version }); await waitFor(() => store.getAccount(native.id).identityGeneration === 2, 'Codex new generation');
  const freshNative = createRun('native fresh', 'pipeline', [nativeRole.id]); const newConnection = resolver.resolveAccount(nativeRole, freshNative.id); assert.notEqual(firstConnection.runtimeHome, newConnection.runtimeHome); assert.equal(resolver.resolveAccount(nativeRole, frozenNative.id).binding.identityGeneration, 1);
  const sessionExecution = createExecution({ runId: frozenNative.id, agentId: nativeRole.id, driver: 'codex-app-server', scopeId: 'session-test', cwd: root, agentVersion: 1 }); const sessionOpts = { agent: nativeRole, run: frozenNative, messages: [{ role: 'user', content: 'hi' }] };
  const h1 = await prepareNativeSession(sessionOpts, sessionExecution, new AbortController().signal, false, firstConnection); h1.bind('11111111-1111-4111-8111-111111111111'); h1.finish(true); h1.release();
  const h2 = await prepareNativeSession(sessionOpts, { ...sessionExecution, id: 'next' }, new AbortController().signal, false, newConnection); assert.equal(h2.resume, false); assert.notEqual(h1.record.bindingKey, h2.record.bindingKey); h2.finish(false); h2.release();
  await rm(path.join(newConnection.runtimeHome, 'auth.json')); assert.equal((await api(`/api/accounts/${native.id}/check`, 'POST')).data.authentication, 'expired'); assert.throws(() => createRun('expired reject', 'pipeline', [nativeRole.id]), /认证/);
  assert.equal((await api(`/api/accounts/${native.id}/test`, 'POST', { expectedVersion: store.getAccount(native.id).version, backend: 'claude-sdk', model: 'x' })).status, 400);
  const cancelled = (await api(`/api/accounts/${native.id}/login`, 'POST', { expectedVersion: store.getAccount(native.id).version })).data; await waitFor(async () => (await api(`/api/accounts/logins/${cancelled.id}`)).data.userCode, 'device code'); assert.equal((await api(`/api/accounts/logins/${cancelled.id}`, 'DELETE')).data.status, 'cancelled'); await new Promise((resolve) => setTimeout(resolve, 800)); assert.equal(store.getAccount(native.id).identityGeneration, 2);
  const nativeClaude = (await api('/api/accounts', 'POST', { displayName: 'Native Claude', authType: 'native_login', nativeClient: 'claude' })).data;
  const claudeOp = (await api(`/api/accounts/${nativeClaude.id}/login`, 'POST', { expectedVersion: 1 })).data; assert.match(claudeOp.terminalCommand, /pnpm accounts:login/);
  execFileSync(process.execPath, ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'scripts/login-account.mjs', claudeOp.id], { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, stdio: 'pipe' });
  assert.equal(store.getAccount(nativeClaude.id).authentication, 'authenticated'); assert.deepEqual(store.getAccount(nativeClaude.id).compatibleBackends, ['claude-cli']); assert.equal((await api(`/api/accounts/${nativeClaude.id}/test`, 'POST', { expectedVersion: store.getAccount(nativeClaude.id).version, backend: 'claude-cli', model: 'default' })).data.status, 'passed');
  const duplicateOp = (await api(`/api/accounts/${nativeClaude.id}/login`, 'POST', { expectedVersion: store.getAccount(nativeClaude.id).version })).data;
  const helperArgs = ['--import', './apps/server/node_modules/tsx/dist/loader.mjs', 'scripts/login-account.mjs', duplicateOp.id];
  const helper = spawn(process.execPath, helperArgs, { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, FAKE_E2_LOGIN_DELAY_MS: '2000' }, stdio: 'pipe' });
  let helperError = ''; helper.stdout.resume(); helper.stderr.on('data', (chunk) => { helperError += chunk; }); const helperDone = new Promise((resolve) => helper.once('close', resolve));
  await waitFor(() => db.get("SELECT token FROM external_native_processes WHERE execution_id=? AND status='active'", 'login:' + duplicateOp.id), 'Claude helper ownership');
  assert.throws(() => execFileSync(process.execPath, helperArgs, { cwd: path.resolve(import.meta.dirname, '..'), env: process.env, stdio: 'pipe' }), /此登录已由另一个终端持有/);
  assert.equal((await api(`/api/accounts/logins/${duplicateOp.id}`)).data.status, 'pending', 'duplicate helper must not fail the owner login');
  assert.equal(await helperDone, 0, helperError); assert.equal((await api(`/api/accounts/logins/${duplicateOp.id}`)).data.status, 'completed');
  const failedOp = (await api(`/api/accounts/${nativeClaude.id}/login`, 'POST', { expectedVersion: store.getAccount(nativeClaude.id).version })).data;
  assert.throws(() => execFileSync(process.execPath, [...helperArgs.slice(0, -1), failedOp.id], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, FAKE_E2_LOGIN_FAIL: '1' }, stdio: 'pipe' }), /Claude 登录未完成/);
  assert.equal((await api(`/api/accounts/logins/${failedOp.id}`)).data.status, 'failed');
  assert.equal(db.get("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id=? AND status='active'", 'login:' + failedOp.id).n, 0);
  const interrupted = (await api(`/api/accounts/${nativeClaude.id}/login`, 'POST', { expectedVersion: store.getAccount(nativeClaude.id).version })).data; await recoverAccountLogins(); assert.equal((await api(`/api/accounts/logins/${interrupted.id}`)).data.status, 'interrupted');
  db.run("INSERT INTO account_checks (id,account_id,backend,model,config_version,status,tested_at) VALUES ('interrupted-test',?,'claude-cli','default',1,'running',?)", nativeClaude.id, new Date().toISOString()); await recoverAccountTests(); assert.equal(db.get("SELECT status FROM account_checks WHERE id='interrupted-test'").status, 'failed');
  const stallRun = createRun('stall', 'pipeline', [b.id]); const stalled = { ...b, model: 'openai:stall' }; const waiting = providerForAgent(stalled, stallRun.id).chat(request(stalled)); void waiting.catch(() => {}); await waitFor(() => calls.some((call) => call.body.model === 'stall'), 'pending supplier request');
  const revocation = await api(`/api/accounts/${two.id}/revoke`, 'POST', { expectedVersion: store.getAccount(two.id).version }); assert.equal(revocation.status, 200); assert.ok(revocation.data.cancelledRunIds.includes(stallRun.id)); await assert.rejects(waiting); assert.equal(getRun(stallRun.id).status, 'cancelled'); assert.throws(() => resolver.resolveAccount(b, run.id), /撤销/);
  const stoppedRole = await role('native-stall', store.getAccount(one.id), 'codex-app-server', { model: 'stall' });
  const nativeStall = createRun('native revoke', 'pipeline', [stoppedRole.id]); const collaboration = createRun('queued collaboration revoke', 'collaboration', [appRole.id]);
  const beforeStall = calls.filter((call) => call.body.model === 'stall').length;
  const nativeWaiting = runAgentTurn({ run: nativeStall, agent: listRunAgentSnapshots(nativeStall.id)[0], messages: [{ role: 'user', content: 'Wait' }], parentSpanId: startSpan(nativeStall.id, { spanKind: 'run', name: 'native-stop' }).id }); void nativeWaiting.catch(() => {});
  await waitFor(() => calls.filter((call) => call.body.model === 'stall').length > beforeStall, 'native inference pending');
  assert.equal((await api(`/api/accounts/${one.id}/revoke`, 'POST', { expectedVersion: store.getAccount(one.id).version })).status, 200); await assert.rejects(nativeWaiting); assert.equal(getRun(nativeStall.id).status, 'cancelled'); assert.equal(getRun(collaboration.id).status, 'cancelled');
  assert.equal(db.get('SELECT source FROM runtime_run_terminals WHERE run_id=?', collaboration.id).source, 'account_revoked');
  assert.equal(db.get("SELECT COUNT(*) n FROM external_native_processes WHERE execution_id IN (SELECT id FROM external_agent_executions WHERE run_id=?) AND status='active'", nativeStall.id).n, 0);
  const nativeCalls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse); assert.ok(nativeCalls.some((row) => row.kind === 'managed-command' && row.allowed === false)); assert.ok(nativeCalls.every((row) => !row.supplierSecret && !row.keyIsSupplier));
  const managed = nativeCalls.filter((row) => row.kind === 'thread' && row.args.some((arg) => arg.includes('model_providers.gand_account'))); assert.ok(managed.length); assert.ok(managed.every((row) => row.params.sandbox === undefined && row.args.some((arg) => arg.includes('wire_api="responses"')) && row.args.some((arg) => arg.includes('permissions.gand_accounts.filesystem=')) && row.args.includes('shell_environment_policy.inherit="none"')));
  assert.equal(process.env.ANTHROPIC_API_KEY, 'fixture-parent-secret-sdk'); assert.equal(process.env.LLM_OPENAI_API_KEY, 'fixture-parent-secret-openai'); assert.equal((await stat(firstConnection.runtimeHome)).mode & 0o777, 0o700); assert.equal((await stat(path.join(firstConnection.runtimeHome, 'auth.json'))).mode & 0o777, 0o600);
  console.log('账户 E2 验证通过：双账户并发、冻结版本/轮换/停用/撤销、4 Driver 认证转发、模型状态、原生登录代次/取消/会话隔离/重启、秘密与环境隔离');
} finally {
  await shutdownAccountLogins(); await shutdownAccountTests(); await app.close(); releaseRuntimeHost(); db.closeDatabase(); for (const response of inflight) response.destroy(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
}
