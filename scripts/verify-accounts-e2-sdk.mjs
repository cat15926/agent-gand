// Installed SDK + its bundled Claude binary against a local Messages fixture; no supplier inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-account-sdk-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent', EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: '', LLM_OPENAI_API_KEY: 'fixture-parent-secret-openai', ANTHROPIC_API_KEY: 'fixture-parent-secret-unselected', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
const key = 'fixture-supplier-sdk-local-only'; const requests = [];
const upstream = createServer(async (req, res) => {
  try {
    let text = ''; for await (const chunk of req) text += chunk; const body = JSON.parse(text); requests.push({ url: req.url, key: req.headers['x-api-key'], body });
    assert.equal(req.headers['x-api-key'], key);
    if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":4}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }); send('content_block_stop', { index: 0 }); send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }); send('message_stop', {}); res.end();
  } catch { res.writeHead(500).end(); }
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const { createAccount } = await import('../apps/server/src/accounts/store.ts'); const { resolveAccount } = await import('../apps/server/src/accounts/resolver.ts'); const { getDriver } = await import('../apps/server/src/execution/drivers.ts'); const { closeDatabase } = await import('../apps/server/src/db/database.ts');
try {
  const account = createAccount({ displayName: 'Actual SDK fixture', provider: 'custom', apiKey: key, baseUrl: `http://127.0.0.1:${upstream.address().port}`, protocols: ['anthropic-messages'], models: ['claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-6', timeoutMs: 30000 });
  const agent = { id: 'sdk-fixture', model: 'claude-sonnet-4-6', accountRef: account.id, execution: { kind: 'external', driver: 'claude-sdk' } }; const cwd = path.join(root, 'repo'); await mkdir(cwd);
  for (const driver of ['claude-sdk', 'claude-cli']) {
    const selected = { ...agent, execution: { kind: 'external', driver } };
    const content = await getDriver(driver).invoke({ account: resolveAccount(selected), cwd, model: agent.model, prompt: 'Reply only OK.', instructions: 'No tools. This is a connection test.', permissionMode: 'readonly', controlOnly: true, signal: new AbortController().signal, timeoutMs: 30000, onEvent: () => {} });
    assert.equal(content, 'OK');
  } assert.ok(requests.some((request) => request.url.startsWith('/v1/messages'))); assert.ok(requests.every((request) => request.key === key)); assert.ok(requests.filter((request) => !request.url.includes('count_tokens')).every((request) => !request.body.tools?.length));
  console.log('实际 Claude SDK 0.3.288、Claude CLI 接入验证通过：逐账户 relay、本机 Messages SSE、无工具响应、服务端所选 Key；真实供应商模型请求=0');
} finally { closeDatabase(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); }
