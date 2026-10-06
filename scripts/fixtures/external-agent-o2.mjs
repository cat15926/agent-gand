#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (argv.includes('--help')) { console.log('--listen generate-ts'); process.exit(0); }
const codex = argv[0] === 'app-server';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (value) => appendFileSync(process.env.FAKE_D_LOG, JSON.stringify({ pid: process.pid, ...value }) + '\n');
const requests = new Map(); let sequence = 0; let input; let thread; let state; let turn;
const storePath = (id) => path.join(process.env.CODEX_HOME, 'fixture-threads', id + '.json');
const sdkPath = (id) => path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.env.CLAUDE_CODE_PROJECT_DIR_NAME, id + '.jsonl');
const request = (method, params) => new Promise((resolve) => { const id = 'native:' + ++sequence; requests.set(id, resolve); send({ id, method, params }); });
const sdk = (message) => send({ method: 'sdk/message', params: { message } });
function persist() {
  const file = codex ? storePath(thread) : input.session?.id ? sdkPath(thread) : null;
  if (file) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ id: thread, cwd: input.cwd, turns: [{ id: turn, status: 'completed' }], tokensIn: state.tokensIn, tokensOut: state.tokensOut }) + '\n'); }
}
async function execute(prompt) {
  const raw = prompt.includes('【平台上下文投递】') ? Object.values(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)).newBlocks).join('') : prompt;
  log({ kind: 'turn', cwd: input.cwd, thread, resume: !!input.session?.resume, model: input.model, prompt });
  const bridge = codex ? input.config?.mcp_servers?.agent_gand : input.bridge;
  let mcp;
  if (bridge) {
    const { Client } = await import(pathToFileURL(path.join(process.env.FAKE_O2_SERVER_ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
    const { StdioClientTransport } = await import(pathToFileURL(path.join(process.env.FAKE_O2_SERVER_ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
    const env = codex ? Object.fromEntries(bridge.env_vars.map(name => [name, process.env[name]])) : bridge.env;
    mcp = new Client({ name: 'o2-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: bridge.command, args: bridge.args, env: { ...process.env, ...env }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {}); await mcp.connect(transport);
    const tools = (await mcp.listTools()).tools.map(tool => tool.name);
    if (!codex) sdk({ type: 'system', subtype: 'init', session_id: thread,
      tools: [...(input.permissionMode === 'readonly' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']), ...tools.map(name => 'mcp__agent_gand__' + name)],
      mcp_servers: [{ name: 'agent_gand', status: 'connected' }] });
    const artifact = /本步骤产物必须使用 fs.write 完整冻结到 `([^`]+)`/.exec(raw)?.[1];
    if (artifact || input.model.includes('bridge')) {
      const value = await mcp.callTool({ name: 'platform_' + Buffer.from('fs.write').toString('hex'), arguments: { path: artifact ?? 'bridge-result.txt', content: 'O2 frozen platform artifact. '.repeat(8) } });
      if (value.isError) throw new Error('MCP artifact rejected'); log({ kind: 'bridge', cwd: input.cwd, artifact });
    }
  }
  const target = path.join(input.cwd, 'work.txt');
  if (input.model.includes('wait')) {
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.send({type:'ready'});setTimeout(()=>require('fs').writeFileSync(process.argv[1],'late'),1600);setInterval(()=>{},1000)", path.join(input.cwd, 'late-orphan.txt')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', () => log({ kind: 'child-ready', cwd: input.cwd, childPid: child.pid }));
    return;
  }
  let content = 'fixture session complete';
  if (input.model.includes('write')) {
    content = /D_CONTENT=([^\n]+)/.exec(raw)?.[1] ?? 'fixture write';
    const itemId = 'write-' + randomUUID(); let permitted;
    if (codex) {
      send({ method: 'item/started', params: { threadId: thread, turnId: turn, item: { id: itemId, type: 'fileChange', status: 'inProgress', changes: [{ path: target, kind: { type: 'add' } }] } } });
      const response = await request('item/fileChange/requestApproval', { threadId: thread, turnId: turn, itemId }); permitted = response?.decision === 'accept';
    } else {
      sdk({ type: 'assistant', message: { id: itemId, content: [{ type: 'tool_use', id: itemId, name: 'Write', input: { file_path: target, content } }] } });
      const response = await request('sdk/permission', { tool: 'Write', input: { file_path: target, content }, toolUseId: itemId }); permitted = response?.allow === true;
    }
    if (!permitted) throw new Error('fixture write denied');
    writeFileSync(target, content); log({ kind: 'write', cwd: input.cwd, content });
    if (input.model.includes('crash')) return;
    if (codex) send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: itemId, type: 'fileChange', status: 'completed', changes: [{ path: target, kind: { type: 'add' } }] } } });
    else sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: itemId, content: 'written' }] } });
  }
  if (input.model.includes('review')) {
    const source = existsSync(target) ? readFileSync(target, 'utf8') : 'text evidence';
    const revision = /当前实现轮次：(\d+)/.exec(raw)?.[1];
    content = JSON.stringify({ verdict: input.model.includes('revision') && revision === '1' ? 'FAIL' : 'PASS', summary: source, issues: [] });
  }
  if (mcp) await mcp.close();
  state.tokensIn += 10; state.tokensOut += 5; persist();
  if (codex) {
    send({ method: 'item/completed', params: { threadId: thread, turnId: turn, item: { id: 'final-' + turn, type: 'agentMessage', phase: 'final_answer', text: content } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, tokenUsage: { total: { inputTokens: state.tokensIn, outputTokens: state.tokensOut } } } });
    send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turn, status: 'completed' } } });
  } else {
    sdk({ type: 'result', subtype: 'success', session_id: thread, result: content, usage: { input_tokens: state.tokensIn, output_tokens: state.tokensOut }, total_cost_usd: 0.01 });
    send({ method: 'sdk/done', params: {} });
  }
}
createInterface({ input: process.stdin }).on('line', (line) => { void (async () => {
  const message = JSON.parse(line); const params = message.params ?? {};
  if (!message.method && message.id !== undefined) { requests.get(String(message.id))?.(message.result); requests.delete(String(message.id)); return; }
  if (!codex) {
    if (message.method !== 'sdk/start') return;
    input = params; thread = input.session?.id ?? randomUUID(); turn = randomUUID(); state = { tokensIn: 0, tokensOut: 0 };
    if (input.session?.resume) {
      const file = sdkPath(thread);
      if (existsSync(path.join(input.cwd, 'reject-resume')) || !existsSync(file)) { log({ kind: 'resume-rejected' }); send({ method: 'sdk/resumeUnavailable', params: {} }); return; }
      state = JSON.parse(readFileSync(file, 'utf8'));
    }
    sdk({ type: 'system', subtype: 'init', session_id: thread, tools: input.permissionMode === 'readonly' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'], mcp_servers: [] });
    await execute(input.prompt); return;
  }
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture-d' } });
  if (message.method === 'thread/read') {
    if (!existsSync(storePath(params.threadId))) { send({ id: message.id, error: { code: -1, message: 'missing' } }); return; }
    const saved = JSON.parse(readFileSync(storePath(params.threadId), 'utf8')); send({ id: message.id, result: { thread: { ...saved, turns: saved.turns } } });
  }
  if (['thread/start', 'thread/resume'].includes(message.method)) {
    input = params; thread = params.threadId ?? randomUUID(); state = { tokensIn: 0, tokensOut: 0 };
    if (message.method === 'thread/resume') { state = JSON.parse(readFileSync(storePath(thread), 'utf8')); input.session = { resume: true }; }
    send({ id: message.id, result: { cwd: params.cwd, approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'readOnly', networkAccess: false }, thread: { id: thread } } });
  }
  if (message.method === 'turn/start') { turn = randomUUID(); send({ id: message.id, result: { turn: { id: turn } } }); await execute(params.input[0].text); }
  if (message.method === 'turn/interrupt') send({ id: message.id, result: {} });
})().catch((error) => { log({ kind: 'error', message: error.message }); send({ method: codex ? 'error' : 'sdk/error', params: { message: error.message } }); }); });
