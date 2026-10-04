#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (args.includes('--help')) { console.log('--listen generate-ts'); process.exit(0); }
const sdk = !args.includes('app-server');
const threadId = 'thread-' + randomUUID(); const turnId = 'turn-' + randomUUID();
const waiters = new Map(); let sequence = 100; let input; let prompt = '';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const event = (message) => notify('sdk/message', { message });
const log = (data) => appendFileSync(process.env.FAKE_B_LOG, JSON.stringify({ pid: process.pid, sdk, ...data }) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method && message.id !== undefined) { waiters.get(String(message.id))?.(message.result); waiters.delete(String(message.id)); return; }
  if (message.method === 'sdk/start') { input = message.params; prompt = input.prompt; void work(); }
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (message.method === 'thread/start') {
    input = message.params;
    if (input.sandbox !== 'read-only') throw new Error('v2 ThreadStartParams.sandbox must use kebab-case');
    send({ id: message.id, result: { thread: { id: threadId }, cwd: input.cwd, sandbox: { type: input.model === 'unsafe-policy' ? 'workspaceWrite' : 'readOnly', networkAccess: false }, approvalPolicy: input.approvalPolicy, approvalsReviewer: 'user' } });
  }
  if (message.method === 'turn/start') {
    prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } }); void work();
  }
  if (message.method === 'turn/interrupt') log({ kind: 'interrupt' });
});
function nativeItem(type, id, value, completed = false) {
  if (!sdk) notify(completed ? 'item/completed' : 'item/started', { threadId, turnId, item: { type, id, ...value } });
}
async function permission(tool, params, item) {
  const id = ++sequence;
  const method = sdk ? 'sdk/permission' : tool === 'Write' ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval';
  const payload = sdk ? { tool, input: params, toolUseId: 'use-' + id } : { threadId, turnId, itemId: item, startedAtMs: Date.now(), ...(tool === 'Bash' ? { kind: 'command', command: params.command, cwd: input.cwd } : {}) };
  const response = new Promise((resolve) => waiters.set(String(id), resolve));
  send({ id, method, params: payload });
  if (prompt.includes('SCENARIO:duplicate')) send({ id, method, params: payload });
  const value = await response; const accepted = sdk ? value?.allow === true : value?.decision === 'accept';
  log({ kind: 'decision', tool, accepted }); return accepted;
}
function toolStart(id, name, args) {
  if (sdk) event({ type: 'assistant', message: { id: 'message-' + id, content: [{ type: 'tool_use', id, name, input: args }] } });
}
function toolEnd(id, output, failed = false) { if (sdk) event({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, is_error: failed }] } }); }
function finish(content) {
  if (sdk) { event({ type: 'result', subtype: 'success', is_error: false, session_id: threadId, result: content, usage: { input_tokens: 9, output_tokens: 3 }, total_cost_usd: 0.02 }); notify('sdk/done', {}); }
  else {
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { inputTokens: 9, outputTokens: 3 } } });
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'text', delta: content.slice(0, 2) });
    nativeItem('agentMessage', 'text', { text: content, phase: 'final_answer' }, true);
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }
}
async function work() {
  log({ kind: 'start', prompt, cwd: input.cwd, nativeHome: process.env.CODEX_HOME, inheritedConfig: existsSync(path.join(process.env.CODEX_HOME ?? '.', 'config.toml')) });
  if (sdk) event({ type: 'system', subtype: 'init', session_id: threadId, tools: input.permissionMode === 'readonly' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'], mcp_servers: [] });
  if (prompt.includes('__AGENT_GAND_REVIEW_JSON__')) {
    const good = readFileSync(path.join(input.cwd, 'sum.mjs'), 'utf8').includes('a + b');
    finish(JSON.stringify({ verdict: good ? 'PASS' : 'FAIL', summary: good ? '代码与真实测试证据一致' : '求和实现错误', issues: good ? [] : [{ severity: 'blocking', file: 'sum.mjs', line: 1, problem: '实现减法', suggestion: '使用 a + b' }] })); return;
  }
  if (prompt.includes('SCENARIO:readonly')) { finish('已只读检查仓库。'); return; }
  if (prompt.includes('SCENARIO:invalid')) { process.stdout.write('{broken\n'); return; }
  if (prompt.includes('SCENARIO:foreign')) { notify('item/started', { threadId: 'foreign-thread', turnId, item: { id: 'other', type: 'agentMessage', text: 'wrong' } }); return; }
  if (prompt.includes('SCENARIO:no-terminal')) { finish('partial'); process.exit(1); return; }
  const escaped = prompt.includes('SCENARIO:escape');
  const target = escaped ? path.join(input.cwd, '..', 'escape.mjs') : path.join(input.cwd, 'sum.mjs');
  const code = prompt.includes('SCENARIO:revision') && !prompt.includes('第 2/') ? 'export const sum = (a, b) => a - b;\n' : 'export const sum = (a, b) => a + b;\n';
  const fileId = 'file'; const fileInput = { file_path: target, content: code };
  toolStart(fileId, 'Write', fileInput);
  nativeItem('fileChange', fileId, { changes: [{ path: target, kind: { type: 'update', move_path: null }, diff: code }], status: 'inProgress' });
  const approved = await permission('Write', fileInput, fileId);
  if (prompt.includes('SCENARIO:stall') || prompt.includes('SCENARIO:timeout')) {
    process.on('SIGTERM', () => {});
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
    log({ kind: 'child', childPid: child.pid }); setInterval(() => {}, 1000); return;
  }
  if (!approved) { toolEnd(fileId, '平台明确拒绝写入', true); nativeItem('fileChange', fileId, { changes: [], status: 'declined' }, true); finish('平台拒绝操作，文件未写入。'); return; }
  writeFileSync(target, code); log({ kind: 'write', target });
  toolEnd(fileId, '文件已写入'); nativeItem('fileChange', fileId, { changes: [{ path: target, kind: { type: 'update', move_path: null }, diff: code }], status: 'completed' }, true);
  const command = 'node --test sum.test.mjs'; const commandId = 'test';
  toolStart(commandId, 'Bash', { command }); nativeItem('commandExecution', commandId, { command, cwd: input.cwd, status: 'inProgress' });
  const permitted = await permission('Bash', { command }, commandId);
  let output = '平台拒绝测试命令'; let exitCode = null;
  if (permitted) {
    try { output = execFileSync(process.execPath, ['--test', 'sum.test.mjs'], { cwd: input.cwd, encoding: 'utf8' }); exitCode = 0; }
    catch (error) { output = error.stdout + error.stderr; exitCode = error.status; }
    log({ kind: 'test', exitCode });
  }
  toolEnd(commandId, output, exitCode !== 0); nativeItem('commandExecution', commandId, { command, cwd: input.cwd, status: exitCode === 0 ? 'completed' : 'failed', aggregatedOutput: output, exitCode }, true);
  finish('已实现求和函数，测试 exit=' + exitCode);
}
