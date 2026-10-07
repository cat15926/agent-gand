#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2); const claude = path.basename(process.argv[1]).includes('claude');
if (args.includes('--version')) { console.log(claude ? '2.1.220 (Claude Code)' : 'codex-cli 0.159.2'); process.exit(0); }
if (args.includes('--help')) { console.log('--settings --include-partial-messages --disable-slash-commands --safe-mode --setting-sources --strict-mcp-config --mcp-config --output-format --tools --permission-mode --no-chrome --listen generate-ts --sandbox --ignore-user-config --ignore-rules --json'); process.exit(0); }
if (args[0] === 'mcp') { console.log('[]'); process.exit(0); }
const home = process.env.CLAUDE_CONFIG_DIR ?? process.env.CODEX_HOME;
const authFile = () => path.join(home, claude ? '.credentials.json' : 'auth.json');
function readAuth() { try { return JSON.parse(readFileSync(authFile(), 'utf8')); } catch { return null; } }
const identity = () => path.basename(path.dirname(home)) === '1' ? 'one' : 'two';
const writeAuth = () => { mkdirSync(home, { recursive: true }); writeFileSync(authFile(), JSON.stringify(claude ? { claudeAiOauth: { accessToken: 'native-fixture-token-' + identity(), email: identity() + '@example.invalid' } } : { auth_mode: 'chatgpt', tokens: { account_id: 'identity-' + identity(), access_token: 'native-fixture-token-' + identity() } }), { mode: 0o600 }); };
if (claude && args[0] === 'auth') {
  if (args[1] === 'logout') { rmSync(authFile(), { force: true }); console.log('Fixture logout'); process.exit(0); }
  if (args[1] === 'login') {
    if (process.env.FAKE_E2_LOGIN_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_E2_LOGIN_DELAY_MS)));
    if (process.env.FAKE_E2_LOGIN_FAIL) { console.error('Fixture login failed'); process.exit(1); }
    writeAuth(); console.log('Fixture login completed'); process.exit(0);
  }
  const auth = readAuth(); console.log(JSON.stringify({ loggedIn: !!auth, authMethod: 'oauth_token', email: auth?.claudeAiOauth.email, subscriptionType: 'fixture' })); process.exit(auth ? 0 : 1);
}
const log = (data) => appendFileSync(process.env.FAKE_E2_LOG, JSON.stringify({ home, cwd: process.cwd(), args, supplierSecret: ['LLM_OPENAI_API_KEY', 'LLM_ANTHROPIC_API_KEY', 'ACCOUNT_MASTER_KEY', 'ACCOUNT_ADMIN_TOKEN', 'UNRELATED_SECRET'].some((name) => !!process.env[name]), keyIsSupplier: (process.env.ANTHROPIC_API_KEY ?? '').startsWith('fixture-supplier-'), ...data }) + '\n');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n'); const notify = (method, params) => send({ method, params });
async function inference(model, apiBase, token, anthropic) {
  if (!token) return 'native OK';
  const response = await fetch(apiBase + (anthropic ? '/v1/messages' : '/responses'), { method: 'POST', headers: { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': token } : { authorization: 'Bearer ' + token }) }, body: JSON.stringify({ model, input: 'Reply only OK.', stream: false }) });
  if (!response.ok) throw new Error('fixture relay error ' + response.status); const data = await response.json(); return anthropic ? data.content[0].text : data.output_text;
}
function codexBase() { const value = args.find((value) => value.startsWith('model_providers.gand_account=')); return value?.match(/base_url="([^"]+)"/)?.[1]; }
if (args[0] === 'exec' || (claude && args.includes('-p'))) {
  log({ kind: 'cli' }); let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const model = args[args.indexOf('--model') + 1] ?? 'default';
  const content = await inference(model, claude ? process.env.ANTHROPIC_BASE_URL : codexBase(), claude ? process.env.ANTHROPIC_API_KEY : process.env.GAND_INFERENCE_TOKEN, claude);
  if (claude) { send({ type: 'system', subtype: 'init', session_id: randomUUID(), tools: args[args.indexOf('--tools') + 1] ? ['Read', 'Grep', 'Glob'] : [], mcp_servers: [] }); send({ type: 'result', subtype: 'success', is_error: false, result: content }); }
  else { send({ type: 'thread.started', thread_id: randomUUID() }); send({ type: 'item.completed', item: { type: 'agent_message', text: content, id: 'text' } }); send({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }); }
  process.exit(0);
}
const approvalWaiters = new Map();
const threadId = randomUUID(); const turnId = randomUUID(); const rl = createInterface({ input: process.stdin });
let input; let cancelled = false;
rl.on('line', async (line) => {
  const message = JSON.parse(line); const { method, params, id } = message;
  if (!method && id !== undefined) { approvalWaiters.get(id)?.(message.result); approvalWaiters.delete(id); return; }
  if (method === 'initialize') send({ id, result: { userAgent: 'fixture' } });
  else if (method === 'account/read') {
    if (process.env.FAKE_E2_LOG) log({ kind: 'account-read', refreshToken: params.refreshToken });
    if (params.refreshToken && process.env.FAKE_E2_REFRESH_FAILURE_FILE && existsSync(process.env.FAKE_E2_REFRESH_FAILURE_FILE)) { send({ id, error: { code: -32000, message: 'Fixture OAuth refresh unavailable' } }); return; }
    const auth = readAuth(); send({ id, result: { account: auth ? { type: 'chatgpt', email: (auth.tokens.account_id === 'identity-one' ? 'one' : 'two') + '@example.invalid', planType: 'fixture' } : null, requiresOpenaiAuth: true } });
  }
  else if (method === 'account/login/start') {
    log({ kind: 'login' }); send({ id, result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' } });
    setTimeout(() => { if (!cancelled) { writeAuth(); notify('account/login/completed', { loginId: 'login-1', success: true, error: null }); } }, 700);
  } else if (method === 'account/login/cancel') { cancelled = true; log({ kind: 'cancel-login' }); send({ id, result: { status: 'canceled' } }); }
  else if (method === 'thread/start') { input = params; log({ kind: 'thread', params }); send({ id, result: { thread: { id: threadId }, cwd: params.cwd, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: params.approvalPolicy, approvalsReviewer: 'user', modelProvider: codexBase() ? 'gand_account' : 'openai' } }); }
  else if (method === 'turn/start') {
    log({ kind: 'turn', params }); send({ id, result: { turn: { id: turnId, status: 'inProgress' } } }); notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    if (input.model === 'managed-approval-fence') {
      const file = { id: 'file-1', type: 'fileChange', status: 'inProgress', changes: [{ path: path.join(input.cwd, 'edited.txt'), kind: { type: 'add' }, diff: '+fixture change' }] };
      notify('item/started', { threadId, turnId, item: file }); const fileDecision = new Promise((resolve) => approvalWaiters.set('file-approval', resolve)); send({ id: 'file-approval', method: 'item/fileChange/requestApproval', params: { threadId, turnId, itemId: file.id } });
      const accepted = (await fileDecision)?.decision === 'accept'; if (accepted) writeFileSync(path.join(input.cwd, 'edited.txt'), 'fixture change'); notify('item/completed', { threadId, turnId, item: { ...file, status: accepted ? 'completed' : 'declined' } });
      const command = { id: 'command-1', type: 'commandExecution', command: 'cat private-file', cwd: input.cwd, status: 'inProgress' }; notify('item/started', { threadId, turnId, item: command }); const decision = new Promise((resolve) => approvalWaiters.set('command-approval', resolve)); send({ id: 'command-approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: command.id, kind: 'command', command: command.command, cwd: input.cwd } });
      const allowed = (await decision)?.decision === 'accept'; log({ kind: 'managed-command', allowed }); notify('item/completed', { threadId, turnId, item: { ...command, status: allowed ? 'completed' : 'declined', aggregatedOutput: '' } });
    }
    const content = input.model === 'managed-approval-fence' ? 'OK' : await inference(input.model, codexBase(), process.env.GAND_INFERENCE_TOKEN, false);
    notify('item/completed', { threadId, turnId, item: { id: 'text', type: 'agentMessage', text: content, phase: 'final_answer' } }); notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  } else if (method === 'sdk/start') {
    input = params; log({ kind: 'sdk', params });
    notify('sdk/message', { message: { type: 'system', subtype: 'init', session_id: input.session?.id ?? threadId, tools: input.controlOnly ? [] : ['Read', 'Grep', 'Glob'], mcp_servers: [] } });
    const content = await inference(input.model, process.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_API_KEY, true);
    notify('sdk/message', { message: { type: 'result', subtype: 'success', is_error: false, session_id: input.session?.id ?? threadId, result: content } }); notify('sdk/done', {});
  }
});
