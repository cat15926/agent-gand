// Exercise the installed SDK/CLI against a local Messages API fixture, without inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-gand-sdk-protocol-'));
const cwd = path.join(root, 'repo'); await mkdir(cwd);
const loader = fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url));
const worker = fileURLToPath(new URL('../apps/server/src/execution/sdkWorker.ts', import.meta.url));
const gateLog = path.join(root, 'permissions.jsonl'); await writeFile(gateLog, '');
const proxy = path.join(root, 'worker-proxy.mjs');
// Transparently observe the real worker protocol, without replacing the SDK or its hooks.
await writeFile(proxy, `#!${process.execPath}\nimport { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const child = spawn(process.execPath, ${JSON.stringify(['--import', loader, worker])}, { stdio: ['pipe', 'pipe', 'pipe'], detached: false });
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
createInterface({ input: child.stdout }).on('line', (line) => { const frame = JSON.parse(line); if (frame.method === 'sdk/permission') appendFileSync(${JSON.stringify(gateLog)}, JSON.stringify({ tool: frame.params.tool }) + '\\n'); });
child.on('error', () => process.exit(1)); child.on('close', (code) => process.exit(code ?? 1));
`); await chmod(proxy, 0o755);
let modelRequests = 0; let callbackCalls = 0; let sealed = false; let resolveCandidate;
const candidate = new Promise((resolve) => { resolveCandidate = resolve; });
const token = randomBytes(32).toString('hex'); const nativeTool = 'mcp__agent_gand__agent_complete';
const callback = createServer((request, response) => { void (async () => {
  assert.equal(request.headers.authorization, 'Bearer ' + token);
  response.setHeader('content-type', 'application/json');
  if (request.url === '/tools') { response.end(JSON.stringify({ tools: [{ name: 'agent_complete', description: 'Submit completion', inputSchema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] } }] })); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const call = JSON.parse(body); assert.equal(call.name, 'agent_complete'); assert.equal(call.arguments.summary, 'local fixture complete'); callbackCalls++;
  sealed = true; response.once('finish', resolveCandidate); response.end(JSON.stringify({ content: [{ type: 'text', text: 'candidate accepted' }] }));
})(); });
const provider = createServer((request, response) => { void (async () => {
  let body = ''; for await (const chunk of request) body += chunk;
  if (request.url.startsWith('/v1/messages/count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":10}'); return; }
  if (!request.url.startsWith('/v1/messages')) { response.writeHead(404).end('{}'); return; }
  const parsed = JSON.parse(body); modelRequests++;
  assert.ok(parsed.tools.some((tool) => tool.name === nativeTool), 'SDK must expose the configured MCP tool');
  const message = { id: 'msg_local_fixture', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
  if (!parsed.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...message, content: [{ type: 'tool_use', id: 'tool_local', name: nativeTool, input: { summary: 'local fixture complete' } }], stop_reason: 'tool_use' })); return; }
  response.setHeader('content-type', 'text/event-stream');
  const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event('message_start', { message });
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'tool_local', name: nativeTool, input: {} } });
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"summary":"local fixture complete"}' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
  event('message_stop', {}); response.end();
})(); });
await Promise.all([callback, provider].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: path.join(root, 'private'), ACCOUNT_MASTER_KEY: '',
  EXTERNAL_CLAUDE_HOME: path.join(root, 'sdk-home'), DB_PATH: path.join(root, 'test.sqlite'), ANTHROPIC_API_KEY: 'fixture-no-inference', ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
  CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', EXTERNAL_CLAUDE_SDK_WORKER_COMMAND: proxy });
const { invokeClaudeSdk } = await import('../apps/server/src/execution/nativeDrivers.ts');
const { closeDatabase } = await import('../apps/server/src/db/database.ts');
const { cleanEnvironment } = await import('../apps/server/src/accounts/environment.ts');
const observed = [];
try {
  await invokeClaudeSdk({ cwd, model: 'default', instructions: 'Use the provided completion tool.', prompt: 'Complete the local fixture.', permissionMode: 'readonly', controlOnly: true,
    environment: cleanEnvironment({ ANTHROPIC_API_KEY: 'fixture-no-inference', ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
    correctionMaxTokens: 2048, signal: new AbortController().signal, timeoutMs: 30000, onEvent: (event) => observed.push(event),
    bridge: { launch: { command: process.execPath, args: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url)), fileURLToPath(new URL('../apps/server/src/execution/bridgeWorker.ts', import.meta.url))],
      env: { AGENT_GAND_BRIDGE_URL: `http://127.0.0.1:${callback.address().port}/`, AGENT_GAND_BRIDGE_TOKEN: token }, toolNames: ['agent_complete'] }, candidate,
      action: () => null, sealed: () => sealed, close: async () => {} } });
  assert.equal(callbackCalls, 1); assert.ok(modelRequests >= 1); assert.ok(observed.some((event) => event.type === 'session.bound'));
  const permissionFrames = (await readFile(gateLog, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(permissionFrames.some((frame) => frame.tool === nativeTool), 'Real PreToolUse hook must reach the platform permission gate');
  console.log('Real Claude SDK MCP verified: local Messages fixture, PreToolUse permission roundtrip, MCP call and controlled interrupt; real model inference = 0');
} finally {
  await Promise.all([callback, provider].map((server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })));
  closeDatabase(); await rm(root, { recursive: true, force: true });
}
