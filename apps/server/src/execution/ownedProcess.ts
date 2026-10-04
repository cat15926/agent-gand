import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ExecutionError } from './errors.ts';

export interface ProcessRegistration { pid: number; token: string }
export interface OwnedProcessInput {
  command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal;
  onProcess?: (owner: ProcessRegistration) => void | Promise<void>;
  onProcessStopped?: (token: string) => void;
}
export interface OwnedProcess {
  child: ChildProcessWithoutNullStreams;
  exit: { code?: number | null; signal?: string | null; spawnError?: string };
}

export async function spawnOwnedProcess(input: OwnedProcessInput): Promise<OwnedProcess> {
  if (input.signal.aborted) throw new ExecutionError('cancelled', '执行已停止');
  const token = randomUUID();
  const child = spawn(process.execPath, [fileURLToPath(new URL('./guardian.mjs', import.meta.url)), token], {
    cwd: input.cwd, env: input.env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  }) as ChildProcessWithoutNullStreams;
  const exit: OwnedProcess['exit'] = {};
  const closed = new Promise<void>((resolve) => child.once('close', resolve));
  child.on('message', (message: any) => {
    if (message.type === 'exit') { exit.code = message.code; exit.signal = message.signal; }
    if (message.type === 'spawnError') exit.spawnError = message.code;
  });
  child.once('close', () => input.onProcessStopped?.(token));
  const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => error(new ExecutionError('timeout', '原生守护进程启动超时')), 5000);
      const abort = () => error(new ExecutionError('cancelled', '执行已停止'));
      const cleanup = () => { settled = true; clearTimeout(timer); input.signal.removeEventListener('abort', abort); child.off('message', ready); child.off('error', error); child.off('close', close); };
      const error = (cause: Error) => { cleanup(); reject(cause); };
      const close = () => error(new ExecutionError('nonzero_exit', '原生守护进程在登记前退出'));
      const ready = (message: any) => {
        if (message.type === 'ready') {
          if (message.pid !== child.pid || message.token !== token) { error(new ExecutionError('protocol_error', '进程所有权登记无效')); return; }
          Promise.resolve(input.onProcess?.({ pid: message.pid, token })).then(() => {
            if (settled) return;
            if (input.signal.aborted) { error(new ExecutionError('cancelled', '执行已停止')); return; }
            child.send({ type: 'start', command: input.command, args: input.args, cwd: input.cwd, env: input.env }, (cause) => { if (cause) error(new ExecutionError('nonzero_exit', '原生守护进程启动通道已关闭')); });
          }).catch(error);
        } else if (message.type === 'started') { cleanup(); resolve(); }
        else if (message.type === 'spawnError') error(new ExecutionError(message.code === 'ENOENT' ? 'missing_binary' : 'nonzero_exit', `原生进程启动失败：${message.code}`));
      };
      child.on('message', ready); child.once('error', error); child.once('close', close);
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
    });
    return { child, exit };
  } catch (error) { kill(); await closed; throw error; }
}
