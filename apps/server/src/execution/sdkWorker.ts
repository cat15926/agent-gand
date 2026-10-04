import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { getSessionInfo, query } from '@anthropic-ai/claude-agent-sdk';
import { sdkOptions, type SdkWorkerInput } from './sdkOptions.ts';
import { diagnostic } from './errors.ts';

const send = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const decisions = new Map<string, (value: boolean) => void>();
const rl = createInterface({ input: process.stdin });
let started = false;
const controller = new AbortController();
rl.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.method === 'sdk/start' && !started) {
      started = true; void run(message.params as SdkWorkerInput);
    } else if (message.method === 'sdk/interrupt') {
      controller.abort(); for (const resolve of decisions.values()) resolve(false);
    } else if (message.id !== undefined && !message.method) {
      decisions.get(String(message.id))?.(message.result?.allow === true); decisions.delete(String(message.id));
    } else throw new Error('SDK worker protocol error');
  } catch { send({ method: 'sdk/error', params: { message: 'SDK worker 输入无效' } }); process.exitCode = 1; rl.close(); }
});
rl.on('close', () => { controller.abort(); for (const resolve of decisions.values()) resolve(false); });

async function run(input: SdkWorkerInput): Promise<void> {
  try {
    if (input.session?.resume && input.session.id) {
      let info;
      try { info = await getSessionInfo(input.session.id, { dir: input.cwd }); }
      catch { send({ method: 'sdk/resumeUnavailable', params: {} }); return; }
      if (!info || info.sessionId !== input.session.id || info.cwd !== input.cwd) { send({ method: 'sdk/resumeUnavailable', params: {} }); return; }
    }
    const options = sdkOptions(input, (id, tool, args) => new Promise((resolve) => {
      const requestId = `tool:${id}`; decisions.set(requestId, resolve);
      send({ id: requestId, method: 'sdk/permission', params: { tool, input: args, toolUseId: id } });
    }));
    options.abortController = controller;
    // All CLI descendants inherit this worker's owned POSIX group.
    options.spawnClaudeCodeProcess = (opts) => {
      const child = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, detached: false, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stderr.on('data', (chunk) => process.stderr.write(diagnostic(String(chunk))));
      return child;
    };
    const result = query({ prompt: input.prompt, options });
    try { for await (const message of result) send({ method: 'sdk/message', params: { message } }); }
    finally { result.close(); }
    send({ method: 'sdk/done', params: {} });
  } catch (error) { send({ method: 'sdk/error', params: { message: diagnostic(error instanceof Error ? error.message : String(error)) } }); }
}
