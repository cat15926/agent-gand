// Real SDK persistence/resume against a local Messages API; no supplier model inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-sdk-session-')));
const cwd = path.join(root, 'repo'); const configDir = path.join(root, 'sdk-home');
await mkdir(cwd); await mkdir(configDir, { mode: 0o700 });
const requests = []; let providerError;
const provider = createServer((request, response) => { void (async () => {
  try {
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.url.startsWith('/v1/messages/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":10}'); return; }
    if (!request.url.startsWith('/v1/messages')) { response.writeHead(404).end('{}'); return; }
    const parsed = JSON.parse(body); requests.push(parsed);
    const text = 'SDK_LOCAL_SESSION_RESPONSE_' + requests.length;
    const message = { id: 'msg_local_' + requests.length, type: 'message', role: 'assistant', model: parsed.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!parsed.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...message, content: [{ type: 'text', text }], stop_reason: 'end_turn' })); return; }
    response.setHeader('content-type', 'text/event-stream');
    const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('message_start', { message });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {}); response.end();
  } catch (error) { providerError = error; response.writeHead(500).end('{}'); }
})(); });
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.sqlite'), EXTERNAL_CLAUDE_HOME: configDir,
  ANTHROPIC_API_KEY: 'fixture-no-inference', ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
  CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' });
delete process.env.EXTERNAL_CLAUDE_SDK_WORKER_COMMAND;
const { invokeClaudeSdk } = await import('../apps/server/src/execution/nativeDrivers.ts');
const { closeDatabase } = await import('../apps/server/src/db/database.ts');
const id = randomUUID(); const projectDir = 'agent-gand-probe-' + randomUUID();
const observed = [];
const base = { cwd, model: 'default', instructions: 'Answer the current local fixture briefly.', permissionMode: 'readonly', controlOnly: true,
  correctionMaxTokens: 2048, signal: new AbortController().signal, timeoutMs: 30000, onEvent: (event) => observed.push(event) };
try {
  const first = await invokeClaudeSdk({ ...base, prompt: 'SDK_FIRST_TASK_MARKER', session: { id, resume: false, configDir, projectDir } });
  assert.match(first, /SDK_LOCAL_SESSION_RESPONSE/);
  const saved = await readFile(path.join(configDir, 'projects', projectDir, id + '.jsonl'), 'utf8');
  assert.ok(saved.includes('SDK_FIRST_TASK_MARKER')); assert.ok(saved.includes(id));
  const before = requests.length;
  const second = await invokeClaudeSdk({ ...base, prompt: 'SDK_SECOND_TASK_MARKER', session: { id, resume: true, configDir, projectDir } });
  assert.match(second, /SDK_LOCAL_SESSION_RESPONSE/); assert.ok(requests.length > before);
  const nativeHistory = JSON.stringify(requests.at(-1).messages);
  assert.ok(nativeHistory.includes('SDK_FIRST_TASK_MARKER')); assert.ok(nativeHistory.includes('SDK_SECOND_TASK_MARKER'));
  assert.ok(nativeHistory.includes('SDK_LOCAL_SESSION_RESPONSE_1'), 'Resume must load the first assistant response');
  const bindings = observed.filter((event) => event.type === 'session.bound');
  assert.ok(bindings.length >= 2); assert.equal(bindings.every((event) => event.sessionId === id), true);
  const usage = observed.filter((event) => event.type === 'usage').at(-1); assert.equal(usage.tokensIn, null); assert.equal(usage.costUsd, null);
  if (providerError) throw providerError;
  console.log('Real Claude SDK session verified: private JSONL persistence, metadata preflight, second process resume and preserved native history; supplier model inference = 0');
} finally {
  await new Promise((resolve) => { provider.close(resolve); provider.closeAllConnections(); });
  closeDatabase(); await rm(root, { recursive: true, force: true });
}
