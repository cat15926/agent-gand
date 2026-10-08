import { diagnostic, ExecutionError, exitError } from './errors.ts';
import { spawnOwnedProcess, type OwnedProcessInput } from './ownedProcess.ts';
import { cleanEnvironment } from '../accounts/environment.ts';

type Wire = Record<string, any>;
export interface RpcPeer {
  request(method: string, params: unknown): Promise<Wire>;
  send(message: Wire): void;
  onMessage(handler: (message: Wire) => void | Promise<void>): void;
  onInterrupt(handler: () => void): void;
}

/** Owned stdio process group, bounded framing, correlated bidirectional requests. */
export async function withRpcProcess<T>(input: { command: string; args: string[]; cwd: string; signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv } & Pick<OwnedProcessInput, 'onProcess' | 'onProcessStopped'>, action: (peer: RpcPeer) => Promise<T>): Promise<T> {
  if (process.platform === 'win32') throw new ExecutionError('unsupported_cli', '原生进程树管理仅支持 macOS/Linux');
  if (input.signal.aborted) throw new ExecutionError('cancelled', '执行已停止');
  const env = cleanEnvironment(input.env);
  const owned = await spawnOwnedProcess({ ...input, env }); const child = owned.child;
  let sequence = 0; let pending = ''; let stderr = ''; let bytes = 0; let closing = false; let failed = false;
  let handler: (message: Wire) => void | Promise<void> = () => {};
  let interrupt = () => {};
  const requests = new Map<string, { resolve(value: Wire): void; reject(error: Error): void }>();
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  const kill = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch {} } };
  const fail = (error: Error) => {
    if (closing || failed) return;
    failed = true;
    for (const request of requests.values()) request.reject(error);
    requests.clear(); rejectFailure(error);
  };
  const peer: RpcPeer = {
    send(message) { if (closing || failed) return; child.stdin.write(JSON.stringify(message) + '\n'); },
    request(method, params) {
      if (closing || failed || input.signal.aborted) return Promise.reject(new ExecutionError('cancelled', '原生连接已关闭'));
      const id = `platform:${++sequence}`;
      return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); peer.send({ id, method, params }); });
    },
    onMessage(value) { handler = value; },
    onInterrupt(value) { interrupt = value; },
  };
  const decode = (line: string) => {
    if (!line.trim() || failed || closing) return;
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new ExecutionError('protocol_error', '原生 RPC 行超过限制');
    let message: Wire;
    try { message = JSON.parse(line); } catch { throw new ExecutionError('invalid_json', '原生 RPC JSON 无效'); }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new ExecutionError('protocol_error', '原生 RPC 不是对象');
    if (!message.method && message.id !== undefined) {
      const request = requests.get(String(message.id));
      if (!request) throw new ExecutionError('protocol_error', '原生 RPC 返回未知请求 ID');
      requests.delete(String(message.id));
      if (message.error) request.reject(exitError(String(message.error.message ?? 'RPC error'))); else request.resolve(message.result ?? {});
    } else if (typeof message.method === 'string') {
      Promise.resolve(handler(message)).catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
    } else throw new ExecutionError('protocol_error', '原生 RPC 消息缺少 method/id');
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    try {
      bytes += Buffer.byteLength(chunk); if (bytes > 16 * 1024 * 1024) throw new ExecutionError('protocol_error', '原生输出超过限制');
      pending += chunk; let index: number;
      while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, index); pending = pending.slice(index + 1); decode(line); }
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) throw new ExecutionError('protocol_error', '原生 RPC 半行超过限制');
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
  child.stdin.on('error', () => {});
  child.on('error', (error: NodeJS.ErrnoException) => fail(new ExecutionError(error.code === 'ENOENT' ? 'missing_binary' : 'nonzero_exit', `原生进程启动失败：${error.code}`)));
  let resolveClose!: () => void; const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
  child.on('close', (code, signal) => { const nativeCode = owned.exit.code === undefined ? code : owned.exit.code; if (!closing) fail(nativeCode !== 0 ? exitError(`原生 exit=${nativeCode ?? signal}\n${stderr}`) : new ExecutionError('protocol_error', '原生连接在回合结束前关闭')); kill('SIGKILL'); resolveClose(); });
  const withStderr = (error: ExecutionError) => new ExecutionError(error.code, error.message,
    { ...error.details, ...(stderr.trim() ? { stderr: diagnostic(stderr) } : {}) });
  const abort = () => { interrupt(); fail(withStderr(input.signal.reason instanceof ExecutionError ? input.signal.reason : new ExecutionError('cancelled', '执行已停止'))); };
  input.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { interrupt(); fail(withStderr(new ExecutionError('timeout', '外部 Agent 执行超时'))); }, input.timeoutMs);
  if (input.signal.aborted) abort();
  try { return await Promise.race([action(peer), failure]); }
  finally {
    closing = true; clearTimeout(timer); input.signal.removeEventListener('abort', abort);
    for (const request of requests.values()) request.reject(new ExecutionError('cancelled', '原生连接已关闭'));
    requests.clear(); child.stdin.end();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 150))]);
    kill('SIGTERM');
    const killer = setTimeout(() => kill('SIGKILL'), 500);
    await closed; clearTimeout(killer); kill('SIGKILL');
  }
}
