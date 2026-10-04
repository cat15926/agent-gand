#!/usr/bin/env node
// Protocol fixture only: no model calls, auth reads, or writes in the target repository.
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === 'mcp' && args[1] === 'list') {
  if (process.env.FAKE_MCP_INVALID) console.log('{invalid');
  else console.log(JSON.stringify([{ name: 'fixture_mcp', enabled: Boolean(process.env.FAKE_MCP_LOCKED) || !args.includes('mcp_servers.fixture_mcp.enabled=false') }]));
  process.exit(0);
}
if (args.includes('--version')) { console.log('fixture-cli 1.0'); process.exit(0); }
if (args.includes('--help')) {
  if (process.env.FAKE_CLI_UNSUPPORTED) { console.log('--help'); process.exit(0); }
  console.log('--safe-mode --tools --permission-mode --strict-mcp-config --mcp-config --setting-sources --settings --include-partial-messages --output-format --disable-slash-commands --no-chrome --sandbox --ignore-user-config --ignore-rules --json');
  process.exit(0);
}
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const driver = basename(process.argv[1]).includes('claude') ? 'claude' : 'codex';
const scenario = /SCENARIO:([a-z-]+)/.exec(prompt)?.[1] ?? 'normal';
const session = randomUUID();
const send = (record) => process.stdout.write(JSON.stringify(record) + '\n');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const call = { driver, args, prompt, cwd: process.cwd(), pid: process.pid, session, scenario };
if (scenario === 'stall' || scenario === 'timeout') {
  process.on('SIGTERM', () => {
    // Deliberate late output while the owner is already stopping; it must not be published.
    if (driver === 'codex') { send({ type: 'item.completed', item: { id: 'late', type: 'agent_message', text: '迟到结果' } }); send({ type: 'turn.completed', usage: {} }); }
  });
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], { stdio: 'ignore' });
  call.childPid = child.pid;
}
appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify(call) + '\n');
if (scenario === 'invalid') { process.stdout.write('not-json\n'); await sleep(5_000); }
if (scenario === 'half') { process.stdout.write('{"type":"thread.started"'); process.exit(0); }
if (scenario === 'nonzero') { process.stderr.write('intentional failure'); process.exit(7); }
if (driver === 'claude') send({ type: 'system', subtype: 'init', session_id: session, tools: ['Read', 'Grep', 'Glob'], mcp_servers: [] });
else { send({ type: 'thread.started', thread_id: session }); send({ type: 'turn.started' }); }
if (scenario === 'auth') {
  const message = 'Authentication required: invalid API key sk-fixtureSecret123';
  if (driver === 'claude') send({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, errors: [message], result: message });
  else { send({ type: 'error', message }); send({ type: 'turn.failed', error: { message } }); }
  process.exit(1);
}
if (scenario === 'stall' || scenario === 'timeout') { setInterval(() => {}, 1_000); await new Promise(() => {}); }
if (scenario === 'policy') {
  if (driver === 'claude') send({ type: 'assistant', message: { id: 'bad', content: [{ type: 'tool_use', id: 'bad-tool', name: 'Write' }] } });
  else send({ type: 'item.started', item: { id: 'bad-tool', type: 'mcp_tool_call' } });
  await sleep(5_000);
}
const content = `分析：${readFileSync(join(process.cwd(), 'README.md'), 'utf8').trim()}`;
if (driver === 'claude') {
  send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1' } } });
  // Split inside a UTF-8 code point and a JSON line to exercise incremental framing.
  const bytes = Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } } }) + '\n');
  const split = bytes.indexOf(Buffer.from('分析')) + 1;
  process.stdout.write(bytes.subarray(0, split)); await sleep(10); process.stdout.write(bytes.subarray(split));
  send({ type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: content }] } });
  send({ type: 'assistant', message: { id: 'tool-msg', content: [{ type: 'tool_use', id: 'read-1', name: 'Read' }] } });
  send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1' }] } });
  if (scenario !== 'no-terminal') send({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: content, usage: scenario === 'no-usage' ? {} : { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 2 }, total_cost_usd: scenario === 'no-usage' ? undefined : 0.01 });
} else {
  send({ type: 'item.started', item: { id: 'read-1', type: 'command_execution' } });
  send({ type: 'item.completed', item: { id: 'read-1', type: 'command_execution', status: 'completed' } });
  send({ type: 'item.updated', item: { id: 'answer', type: 'agent_message', text: '初步分析' } });
  send({ type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: content } });
  if (scenario !== 'no-terminal') send({ type: 'turn.completed', usage: scenario === 'no-usage' ? {} : { input_tokens: 8, output_tokens: 2 } });
}
if (scenario === 'late-nonzero') { process.stderr.write('failure after native terminal'); process.exit(3); }
