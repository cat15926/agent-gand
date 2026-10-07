// Installed Codex 0.159.2 against a local Responses fixture; no supplier model request.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = await mkdtemp(path.join(tmpdir(), 'gand-account-codex-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), AGENTS_DIR: path.join(root, 'roles'), MCP_SERVER_CMD: '', LOG_LEVEL: 'silent', LLM_OPENAI_API_KEY: 'fixture-parent-secret-unselected' });
const key = 'fixture-supplier-codex-local-only'; const requests = [];
const upstream = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw); requests.push({ url: req.url, key: req.headers.authorization, body });
    assert.equal(req.headers.authorization, 'Bearer ' + key); assert.ok(req.url.startsWith('/v1/responses'));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); let sequence = 0;
    const response = { id: 'resp_fixture', object: 'response', created_at: 1791100000, model: body.model, status: 'in_progress', output: [] };
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', phase: 'final_answer', content: [] };
    const part = { type: 'output_text', text: 'OK', annotations: [] };
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    send('response.created', { response }); send('response.output_item.added', { output_index: 0, item }); send('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: '' } });
    send('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' }); send('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: 'OK' }); send('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part });
    const completedItem = { ...item, status: 'completed', content: [part] }; send('response.output_item.done', { output_index: 0, item: completedItem }); send('response.completed', { response: { ...response, status: 'completed', output: [completedItem], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }); res.end();
  } catch { res.writeHead(500).end(); }
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const { createAccount } = await import('../apps/server/src/accounts/store.ts'); const { resolveAccount } = await import('../apps/server/src/accounts/resolver.ts'); const { getDriver } = await import('../apps/server/src/execution/drivers.ts'); const { closeDatabase } = await import('../apps/server/src/db/database.ts');
try {
  const account = createAccount({ displayName: 'Actual Codex fixture', provider: 'custom', apiKey: key, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocols: ['openai-responses'], models: ['gpt-5.4'], defaultModel: 'gpt-5.4', timeoutMs: 30000 });
  const agent = { id: 'codex-fixture', model: 'gpt-5.4', accountRef: account.id, execution: { kind: 'external', driver: 'codex-app-server' } }; const cwd = path.join(root, 'repo'); await mkdir(cwd);
  for (const driver of ['codex-app-server', 'codex-exec', 'codex-app-server']) {
    const selected = { ...agent, execution: { kind: 'external', driver } };
    const content = await getDriver(driver).invoke({ account: resolveAccount(selected), cwd, model: agent.model, prompt: 'Reply only OK.', instructions: 'No tools. This is a connection test.', permissionMode: 'readonly', controlOnly: true, signal: new AbortController().signal, timeoutMs: 30000, onEvent: () => {} });
    assert.equal(content, 'OK');
  } assert.ok(requests.length > 0); assert.ok(requests.every((request) => request.key === 'Bearer ' + key && !request.body.tools?.length));
  console.log('实际 Codex 0.159.2 app-server/exec 接入验证通过：逐账户 relay、自定义 Responses provider、本机 SSE、无工具响应、服务端所选 Key；真实供应商模型请求=0');
} finally { closeDatabase(); upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); await rm(root, { recursive: true, force: true }); }
