import { ExecutionError, exitError } from './errors.ts';
import { spawnOwnedProcess, type OwnedProcessInput } from './ownedProcess.ts';
import { cleanEnvironment } from '../accounts/environment.ts';

export interface JsonProcessInput {
  command: string;
  args: string[];
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onRecord: (record: unknown) => void;
  onProcess?: OwnedProcessInput['onProcess'];
  onProcessStopped?: OwnedProcessInput['onProcessStopped'];
}

/** One owned POSIX process group; abort waits for TERM/KILL and pipe closure. No shell. */
export async function runJsonProcess(input: JsonProcessInput): Promise<void> {
  if (process.platform === 'win32') throw new ExecutionError('unsupported_cli', '阶段 A 的进程树停止目前仅支持 macOS/Linux');
  if (input.signal.aborted) throw new ExecutionError('cancelled', '执行已停止');
  const env = input.env ?? cleanEnvironment();
  const owned = await spawnOwnedProcess({ ...input, env });
  await new Promise<void>((resolve, reject) => {
    const child = owned.child;
    let pending = ''; let stderr = ''; let bytes = 0; let failure: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let completed = false;
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    };
    const fail = (error: Error) => {
      if (failure || completed) return;
      failure = error;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 500);
    };
    const abort = () => fail(new ExecutionError('cancelled', '执行已停止'));
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => fail(new ExecutionError('timeout', '外部 Agent 执行超时')), input.timeoutMs);
    const record = (line: string) => {
      if (!line.trim() || failure) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { throw new ExecutionError('invalid_json', 'CLI stdout 包含非法或未闭合的 JSON'); }
      input.onRecord(parsed);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      try {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 16 * 1024 * 1024) throw new ExecutionError('protocol_error', 'CLI 输出超过 16 MiB 限制');
        pending += chunk;
        let index: number;
        while ((index = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, index); pending = pending.slice(index + 1);
          if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new ExecutionError('protocol_error', 'CLI JSON 行超过 4 MiB 限制');
          record(line);
        }
        if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new ExecutionError('protocol_error', 'CLI JSON 行超过 4 MiB 限制');
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
    child.stdin.on('error', () => { /* EPIPE is diagnosed using exit status/stderr. */ });
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure = failure ?? new ExecutionError(error.code === 'ENOENT' ? 'missing_binary' : 'nonzero_exit', error.code === 'ENOENT' ? `未找到 CLI：${input.command}` : `无法启动 CLI：${error.code ?? 'unknown'}`);
    });
    child.once('close', (code, signal) => {
      completed = true;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', abort);
      // Kill group remnants even if the parent exits before the escalation timer fires.
      killGroup('SIGKILL');
      const nativeCode = owned.exit.code === undefined ? code : owned.exit.code;
      if (!failure && nativeCode !== 0) failure = exitError(`CLI exit=${nativeCode ?? signal}\n${stderr}`);
      if (!failure) {
        try { record(pending); } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
      }
      if (failure) reject(failure); else resolve();
    });
    child.stdin.end(input.stdin);
    // Close the spawn/listener race if cancellation arrived synchronously during setup.
    if (input.signal.aborted) abort();
  });
}
