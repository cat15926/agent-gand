#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (argv.includes('--help')) { console.log('--listen generate-ts'); process.exit(0); }
const { Client } = await import(pathToFileURL(path.join(process.env.FAKE_C_SERVER_ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(process.env.FAKE_C_SERVER_ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const sdk = !argv.includes('app-server');
const threadId = randomUUID(); const turnId = randomUUID(); let input; let prompt;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const log = (value) => appendFileSync(process.env.FAKE_C_LOG, JSON.stringify({ pid: process.pid, sdk, ...value }) + '\n');
const event = (message) => notify('sdk/message', { message });
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (message.method === 'thread/start') {
    input = message.params;
    send({ id: message.id, result: { thread: { id: threadId }, cwd: input.cwd, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: input.approvalPolicy, approvalsReviewer: 'user' } });
  }
  if (message.method === 'turn/start') {
    prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: turnId } } }); notify('turn/started', { threadId, turn: { id: turnId } }); void work();
  }
  if (message.method === 'sdk/start') { input = message.params; prompt = input.prompt; void work(); }
  if (['sdk/interrupt', 'turn/interrupt'].includes(message.method)) log({ kind: 'interrupt' });
});
function finish(content) {
  if (sdk) { event({ type: 'result', subtype: 'success', session_id: threadId, result: content }); notify('sdk/done', {}); }
  else { notify('item/completed', { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: content, phase: 'final_answer' } }); notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); }
}
async function work() {
  try {
    const bridge = sdk ? input.bridge : input.config?.mcp_servers?.agent_gand;
    if (!bridge) throw new Error('Missing execution MCP bridge');
    const controlOnly = sdk ? input.controlOnly === true : argv.includes('features.shell_tool=false');
    const env = sdk ? bridge.env : Object.fromEntries(bridge.env_vars.map((name) => [name, process.env[name]]));
    const client = new Client({ name: 'native-fixture', version: '1' });
    const transport = new StdioClientTransport({ command: bridge.command, args: bridge.args, env: { ...process.env, ...env }, stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport); const { tools } = await client.listTools();
    const current = JSON.parse(prompt.match(/__AGENT_GAND_CURRENT__=(.+)/)?.[1] ?? '{}');
    const mode = input.model ?? 'fixture-complete';
    log({ kind: 'start', model: mode, controlOnly, tools: tools.map((tool) => tool.name), message: current.message });
    if (sdk) event({ type: 'system', subtype: 'init', session_id: threadId, tools: [...(controlOnly ? [] : ['Read', 'Grep', 'Glob']), ...tools.map((tool) => 'mcp__agent_gand__' + tool.name)], mcp_servers: [{ name: 'agent_gand', status: 'connected' }] });
    const call = async (name, args) => {
      log({ kind: 'call', name });
      const value = await client.callTool({ name, arguments: args });
      log({ kind: 'result', name, isError: !!value.isError }); return value;
    };
    if (mode === 'fixture-wait') { setInterval(() => {}, 1000); return; }
    if (mode === 'fixture-plain' && !controlOnly || mode === 'fixture-no-correction') { finish('本轮工作已有完整结果。'); return; }
    if (controlOnly) {
      if (!tools.every((tool) => tool.name.startsWith('agent_'))) throw new Error('Correction exposed ordinary bridge tools');
      await call('agent_complete', { summary: '根据原有结果完成受限纠偏。' }); return;
    }
    if (mode === 'fixture-forge') {
      const value = await call('agent_complete', { summary: '伪造完成', subjectId: 'foreign', generation: 999 });
      if (!value.isError) throw new Error('Authority injection accepted');
    }
    if (mode === 'fixture-business') {
      const value = await call('platform_' + Buffer.from('fs.write').toString('hex'), { path: 'bridge-result.txt', content: 'MCP ledger evidence\n' });
      if (value.isError) throw new Error('Business tool rejected');
    }
    if (mode === 'fixture-handoff') {
      // A descendant that ignores TERM must be gone before the receiving Agent starts.
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
      log({ kind: 'child', childPid: child.pid });
      setTimeout(() => { writeFileSync(path.join(input.cwd, 'late-native-write.txt'), 'late'); log({ kind: 'late-write' }); }, 1500);
      await call('agent_handoff', { target: current.memberIds.find((id) => id !== current.agentId), objective: '完成交接后的工作并提交结果', reason: '需要下一位成员处理' }); return;
    }
    if (mode.startsWith('fixture-consult') && !current.message?.startsWith('并行征询结果已汇总：')) {
      await call('agent_consult', { targets: current.memberIds.filter((id) => id !== current.agentId), objective: '给出一个简短的独立结论', reason: '汇总多个成员的判断', join: mode.endsWith('any') ? 'any' : 'all' }); return;
    }
    if (mode === 'fixture-hold-user' && current.message?.startsWith('C-SCENARIO:')) {
      await call('agent_hold', { mode: 'user', question: '是否继续？', reason: '需要用户决定' }); return;
    }
    if (mode === 'fixture-hold-timer' && current.message?.startsWith('C-SCENARIO:')) {
      await call('agent_hold', { mode: 'timer', delaySeconds: 1, reason: '稍后继续' }); return;
    }
    await call('agent_complete', { summary: `已完成 ${current.agentId ?? mode} 的当前责任，结果完整。` });
  } catch (error) { log({ kind: 'error', message: error.message }); if (sdk) notify('sdk/error', { message: error.message }); else notify('error', { message: error.message }); }
}
