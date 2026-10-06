// Installed SDK/CLI against local Messages fixtures only; no supplier inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'gand-account-connection-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent', ACCOUNT_MASTER_KEY: '', EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_API_KEY: 'fixture-unselected-parent-key', ANTHROPIC_AUTH_TOKEN: 'fixture-unselected-parent-token' });
const key = 'fixture-connection-supplier-key';
const requests = []; const fixtureErrors = []; const timers = new Set();
const upstream = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: req.url, key: req.headers['x-api-key'], authorization: req.headers.authorization, body });
    const bearer = !req.url.includes('/x-key/');
    assert.equal(req.headers['x-api-key'], bearer ? undefined : key);
    assert.equal(req.headers.authorization, bearer ? `Bearer ${key}` : undefined);
    if (req.url.includes('/deny-')) {
      const status = Number(req.url.match(/deny-(\d+)/)[1]);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? '1000' : 'permission_error', message: `fixture authentication denied: ${key}` } })); return;
    }
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":4}'); return; }
    assert.ok(!body.tools?.length, 'connection tests must not send tools');
    assert.equal(body.thinking?.type, 'disabled');
    assert.equal(body.max_tokens, 512);
    const reply = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: 'msg_connection_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } });
      if (req.url.includes('/hang/')) return;
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
      send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }); send('message_stop', {}); res.end();
    };
    if (req.url.includes('/slow/')) {
      const timer = setTimeout(() => { timers.delete(timer); reply(); }, 31_000); timers.add(timer);
      res.once('close', () => { clearTimeout(timer); timers.delete(timer); });
    } else reply();
  } catch (error) { fixtureErrors.push(error.message); if (!res.headersSent) res.writeHead(500); res.end(); }
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${upstream.address().port}/api/anthropic`;
const { createAccount, updateAccount } = await import('../apps/server/src/accounts/store.ts');
const { resolveAccount } = await import('../apps/server/src/accounts/resolver.ts');
const { testAccount } = await import('../apps/server/src/accounts/actions.ts');
const { getDriver } = await import('../apps/server/src/execution/drivers.ts');
const { authenticationErrorDetail } = await import('../apps/server/src/accounts/upstreamError.ts');
const { get, closeDatabase } = await import('../apps/server/src/db/database.ts');
const cwd = path.join(root, 'repo'); await mkdir(cwd);
const create = (suffix, authHeader, timeoutMs = 60_000) => createAccount({ displayName: suffix, provider: 'custom', apiKey: key, baseUrl: `${base}/${suffix}`, ...(authHeader ? { authHeader } : {}), protocols: ['anthropic-messages'], models: ['glm-5.3'], defaultModel: 'glm-5.3', timeoutMs });
try {
  assert.equal(await authenticationErrorDetail(new Response('<html>gateway error</html>')), null);
  assert.equal(await authenticationErrorDetail(new Response(JSON.stringify({ error: { message: 'x'.repeat(9000) } }))), null);
  assert.equal(await authenticationErrorDetail(new Response(JSON.stringify({ error: { type: '1000', message: '身份验证失败。' } }))), '业务码 1000：身份验证失败。');
  let cancelled = false; const readingAt = Date.now();
  assert.equal(await authenticationErrorDetail(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"error":')); }, cancel() { cancelled = true; } }))), null);
  assert.equal(cancelled, true); assert.ok(Date.now() - readingAt < 3000, 'unending authentication body must not delay failure indefinitely');
  assert.throws(() => create('invalid', 'invalid'), /连接配置无效/);
  const original = create('x-key');
  const frozen = resolveAccount({ id: 'fixture', accountRef: original.id, model: 'glm-5.3', execution: { kind: 'external', driver: 'claude-sdk' } });
  const changed = updateAccount(original.id, { expectedVersion: original.version, authHeader: 'bearer', baseUrl: `${base}/bearer` });
  assert.equal(changed.configVersion, original.configVersion + 1);
  assert.equal(frozen.connection.authHeader, undefined);
  assert.equal(await getDriver('claude-sdk').invoke({ account: frozen, cwd, model: 'glm-5.3', instructions: 'No tools. Reply only OK.', prompt: 'Reply only OK.', permissionMode: 'readonly', controlOnly: true, connectionTest: true, signal: new AbortController().signal, timeoutMs: 30_000, onEvent: () => {} }), 'OK');
  for (const auth of ['x-api-key', 'bearer']) {
    const account = create(auth === 'bearer' ? 'bearer' : 'x-key', auth);
    for (const backend of ['builtin-anthropic', 'claude-sdk', 'claude-cli']) {
      const result = await testAccount(account.id, { expectedVersion: account.version, backend, model: 'glm-5.3' });
      assert.equal(result.status, 'passed', `${auth}/${backend}: ${result.error}`);
    }
  }
  console.log('Messages x-api-key/Bearer、实际 SDK/CLI、GLM 模型 ID、配置版本隔离验证通过。');
  const slow = create('slow', 'bearer'); const started = Date.now();
  const slowResult = await testAccount(slow.id, { expectedVersion: slow.version, backend: 'claude-sdk', model: 'glm-5.3' });
  assert.equal(slowResult.status, 'passed', slowResult.error); assert.ok(Date.now() - started > 30_000);
  console.log('实际 SDK 等待 31 秒模型响应仍测试通过：不再受旧 30 秒上限影响。');
  for (const [status, backend] of [[401, 'claude-sdk'], [403, 'claude-sdk'], [401, 'claude-cli']]) {
    const denied = create(`deny-${status}`, 'bearer'); const begin = Date.now(); const before = requests.length;
    const result = await testAccount(denied.id, { expectedVersion: denied.version, backend, model: 'glm-5.3' });
    assert.equal(result.status, 'failed'); assert.match(result.error, new RegExp(`HTTP ${status}`)); assert.doesNotMatch(result.error, /超时/); assert.ok(Date.now() - begin < 25_000);
    assert.equal(requests.slice(before).filter((request) => !request.url.includes('count_tokens')).length, 1, 'authentication failure must stop SDK retries');
    assert.match(result.error, status === 401 ? /业务码 1000/ : /业务码 permission_error/); assert.match(result.error, /fixture authentication denied/); assert.ok(!result.error.includes(key), 'supplier authentication details must redact credentials');
  }
  const hung = create('hang', 'bearer', 8_000);
  for (const backend of ['builtin-anthropic', 'claude-sdk']) {
    const begin = Date.now(); const result = await testAccount(hung.id, { expectedVersion: hung.version, backend, model: 'glm-5.3' });
    assert.equal(result.status, 'failed'); assert.match(result.error, /8 秒内未完成/); assert.ok(Date.now() - begin < 12_000, 'deadline covers streamed response and process cleanup');
  }
  assert.equal(get("SELECT COUNT(*) AS n FROM external_native_processes WHERE status='active'").n, 0);
  assert.equal(get("SELECT COUNT(*) AS n FROM account_checks WHERE status='running'").n, 0);
  assert.deepEqual(fixtureErrors, []);
  console.log('账户连接修复验证通过：31 秒 SDK 响应、401/403 停止重试、SDK/流式 API 超时提示与进程清理；真实供应商模型请求=0。');
} finally {
  for (const timer of timers) clearTimeout(timer);
  closeDatabase(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true });
}
