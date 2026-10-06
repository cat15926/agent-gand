import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AccountLoginOperation } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { config } from '../config.ts';
import { emit } from '../messaging/bus.ts';
import { detectDriver } from '../execution/drivers.ts';
import { withRpcProcess } from '../execution/rpc.ts';
import { spawnOwnedProcess } from '../execution/ownedProcess.ts';
import { registerNativeProcess, markNativeProcessStopped, quiesceNativeProcesses } from '../execution/host.ts';
import { AccountError } from './errors.ts';
import { changed, getAccount } from './store.ts';
import { expectedVersion } from './validation.ts';
import { identity, identityDirectory, initializeAccountPeer, inspectNative, loginArgs, nativeEnvironment, privateDirectory, assertNoUnsettledAccountProcess } from './native.ts';
import { redactSecrets, rememberSecret } from './secrets.ts';

interface LoginRow { id: string; account_id: string; generation: number; client: 'claude' | 'codex'; status: AccountLoginOperation['status']; owner_session: string; error: string | null; expires_at: string }
const active = new Map<string, { controller: AbortController; done: Promise<void>; cancel?: () => Promise<void>; verificationUrl?: string; userCode?: string }>();
const terminal = (status: string) => !['starting', 'pending'].includes(status);
function status(id: string, next: AccountLoginOperation['status'], error: string | null = null): void {
  run('UPDATE account_login_operations SET status=?,error=? WHERE id=?', next, error ? redactSecrets(error).slice(0, 240) : null, id);
  const row = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id);
  if (row) emit({ type: 'account.login.updated', accountId: row.account_id }); // No URL, code, operation ID or identity on public WS.
}
export function loginOperation(id: string, owner: string): AccountLoginOperation {
  const row = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=? AND owner_session=?', id, owner);
  if (!row) throw new AccountError(404, '登录操作不存在或不属于当前管理会话');
  const live = active.get(id); const pending = !terminal(row.status) && Date.parse(row.expires_at) > Date.now();
  return { id, accountId: row.account_id, generation: row.generation, client: row.client, status: row.status, error: row.error, expiresAt: row.expires_at,
    verificationUrl: pending ? live?.verificationUrl ?? null : null, userCode: pending ? live?.userCode ?? null : null,
    ...(pending && row.client === 'claude' ? { terminalCommand: `pnpm accounts:login ${id}` } : {}) };
}
export async function completeLogin(id: string): Promise<void> {
  const row = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id);
  if (!row || terminal(row.status) || Date.parse(row.expires_at) <= Date.now()) throw new AccountError(409, '登录操作已结束或过期');
  const native = identity(row.account_id, row.generation)!;
  const detected = await inspectNative(row.client, native.directory);
  if (!detected.authenticated) throw new AccountError(409, '尚未完成供应商登录，请完成授权后重新检测');
  tx(() => {
    const current = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id)!;
    if (terminal(current.status) || Date.parse(current.expires_at) <= Date.now()) throw new AccountError(409, '登录操作已取消或过期');
    const account = getAccount(row.account_id);
    if (account.archived || account.revoked) throw new AccountError(409, '账户已归档或撤销');
    const now = new Date().toISOString();
    run("UPDATE account_native_identities SET status='authenticated',summary=?,identity_hash=?,updated_at=? WHERE account_id=? AND generation=?", detected.summary, detected.fingerprint, now, row.account_id, row.generation);
    run('UPDATE accounts SET identity_generation=?,version=version+1,updated_at=? WHERE id=?', row.generation, now, row.account_id);
    status(id, 'completed'); changed(row.account_id, account.version + 1);
  });
  const live = active.get(id); live?.controller.abort(); active.delete(id);
}
export async function startLogin(accountId: string, version: unknown, owner: string): Promise<AccountLoginOperation> {
  const account = getAccount(accountId);
  if (account.source !== 'managed' || account.authType !== 'native_login' || !account.nativeClient) throw new AccountError(400, '只能登录托管的原生账户');
  if (account.archived || account.revoked || !account.enabled) throw new AccountError(409, '账户已停用、归档或撤销');
  if (account.version !== expectedVersion(version)) throw new AccountError(409, '账户已修改，请刷新后重试');
  if (get("SELECT id FROM account_login_operations WHERE account_id=? AND status IN ('starting','pending')", accountId)) throw new AccountError(409, '该账户已有登录操作，请先取消');
  assertNoUnsettledAccountProcess(accountId);
  const driver = await detectDriver(account.nativeClient === 'codex' ? 'codex-app-server' : 'claude-cli');
  if (!driver.available) throw new AccountError(503, driver.error ?? '原生客户端不可用');
  const generation = (get<{ generation: number }>('SELECT MAX(generation) generation FROM account_native_identities WHERE account_id=?', accountId)?.generation ?? 0) + 1;
  const directory = identityDirectory(accountId, generation);
  await privateDirectory(directory); await privateDirectory(path.join(directory, 'config')); await privateDirectory(path.join(directory, 'login'));
  const id = randomUUID(); const now = new Date().toISOString(); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  tx(() => {
    const current = getAccount(accountId); if (current.version !== account.version) throw new AccountError(409, '账户已修改，请刷新后重试');
    run("INSERT INTO account_native_identities (account_id,generation,client,directory,status,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?)", accountId, generation, account.nativeClient, directory, now, now);
    run("INSERT INTO account_login_operations (id,account_id,generation,client,status,owner_session,expires_at,created_at) VALUES (?,?,?,?,'starting',?,?,?)", id, accountId, generation, account.nativeClient, owner, expiresAt, now);
    run('UPDATE accounts SET version=version+1,updated_at=? WHERE id=?', now, accountId); changed(accountId, current.version + 1);
  });
  const controller = new AbortController();
  const live = { controller, done: Promise.resolve() } as NonNullable<ReturnType<typeof active.get>>; active.set(id, live);
  if (account.nativeClient === 'claude') {
    status(id, 'pending');
    const timer = setTimeout(() => { if (!terminal(get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id)?.status ?? 'expired')) { status(id, 'expired', '登录操作已过期'); void quiesceNativeProcesses('login:' + id); } active.delete(id); }, 10 * 60_000);
    timer.unref(); controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  } else {
    live.done = (async () => {
      try {
        await withRpcProcess({ command: config.externalAgents.codexCommand, args: loginArgs, cwd: path.join(directory, 'login'), env: nativeEnvironment('codex', directory), signal: controller.signal, timeoutMs: 10 * 60_000,
          onProcess: (owned) => registerNativeProcess('login:' + id, owned), onProcessStopped: markNativeProcessStopped }, async (peer) => {
          await initializeAccountPeer(peer);
          let loginId = ''; let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
          const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; }); void done.catch(() => {});
          const notifications: Record<string, any>[] = [];
          const completed = (params: Record<string, any>) => { if (!loginId) { notifications.push(params); return; } if (params.loginId !== loginId) return; if (params.success === true) resolveDone(); else rejectDone(new AccountError(409, '供应商登录未完成，请重试')); };
          peer.onMessage((message) => { if (message.method === 'account/login/completed') completed(message.params ?? {}); else if (message.id !== undefined) peer.send({ id: message.id, error: { code: -32601, message: '登录连接不接受工具请求' } }); });
          const result = await peer.request('account/login/start', { type: 'chatgptDeviceCode' });
          const url = new URL(result.verificationUrl ?? '');
          if (result.type !== 'chatgptDeviceCode' || typeof result.loginId !== 'string' || url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.username || url.password || typeof result.userCode !== 'string' || !/^[A-Za-z0-9 -]{1,40}$/.test(result.userCode)) throw new AccountError(503, '原生客户端返回了不受支持的登录流程');
          rememberSecret(result.userCode); rememberSecret(url.toString());
          loginId = result.loginId; live.verificationUrl = url.toString(); live.userCode = result.userCode;
          live.cancel = async () => { await peer.request('account/login/cancel', { loginId }); };
          status(id, 'pending'); notifications.forEach(completed); await done;
        });
        await completeLogin(id);
      } catch (error) {
        const current = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id);
        if (current && !terminal(current.status)) status(id, controller.signal.aborted ? 'cancelled' : Date.now() >= Date.parse(expiresAt) ? 'expired' : 'failed', controller.signal.aborted ? '登录已取消' : redactSecrets(error instanceof Error ? error.message : '登录失败'));
      } finally { live.verificationUrl = undefined; live.userCode = undefined; active.delete(id); }
    })();
  }
  return loginOperation(id, owner);
}
export function pendingLogin(accountId: string, owner: string): AccountLoginOperation | null {
  const row = get<LoginRow>("SELECT * FROM account_login_operations WHERE account_id=? AND owner_session=? AND status IN ('starting','pending') ORDER BY created_at DESC LIMIT 1", accountId, owner);
  return row ? loginOperation(row.id, owner) : null;
}
export async function cancelLogin(id: string, owner: string): Promise<AccountLoginOperation> {
  loginOperation(id, owner); const live = active.get(id);
  if (!terminal(get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id)!.status)) status(id, 'cancelled', '登录已取消');
  try { await Promise.race([live?.cancel?.(), new Promise((resolve) => setTimeout(resolve, 1000))]); } catch {} live?.controller.abort();
  await live?.done; await quiesceNativeProcesses('login:' + id); active.delete(id);
  return loginOperation(id, owner);
}
export async function checkLogin(id: string, owner: string): Promise<AccountLoginOperation> {
  const op = loginOperation(id, owner); if (!terminal(op.status)) await completeLogin(id); return loginOperation(id, owner);
}
export async function cancelSessionLogins(owner: string): Promise<void> {
  for (const row of all<LoginRow>("SELECT * FROM account_login_operations WHERE owner_session=? AND status IN ('starting','pending')", owner)) await cancelLogin(row.id, owner);
}
export async function recoverAccountLogins(): Promise<void> {
  for (const row of all<LoginRow>("SELECT * FROM account_login_operations WHERE status IN ('starting','pending')")) {
    status(row.id, 'interrupted', '服务重启，正在收敛旧登录操作');
    const live = active.get(row.id); live?.controller.abort(); await live?.done; active.delete(row.id);
    const safe = await quiesceNativeProcesses('login:' + row.id);
    status(row.id, 'interrupted', safe ? '服务重启，登录操作已停止，请重新开始' : '登录进程状态无法验证，请检查服务器后重新登录');
  }
}
export async function shutdownAccountLogins(): Promise<void> {
  for (const row of all<LoginRow>("SELECT * FROM account_login_operations WHERE status IN ('starting','pending')")) await cancelLogin(row.id, row.owner_session);
}
/** Local guided Claude login, using exactly the server-generated pending identity. */
export async function runTerminalLogin(id: string): Promise<void> {
  const row = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id);
  if (!row || row.client !== 'claude' || row.status !== 'pending' || Date.parse(row.expires_at) <= Date.now()) throw new AccountError(409, 'Claude 登录操作无效或已过期，请从账户页重新开始');
  const native = identity(row.account_id, row.generation)!; const controller = new AbortController();
  let anotherTerminalOwns = false;
  const timer = setTimeout(() => controller.abort(), Math.max(1, Date.parse(row.expires_at) - Date.now()));
  const interrupt = () => controller.abort(); process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
  const owned = await spawnOwnedProcess({ command: config.externalAgents.claudeCommand, args: ['auth', 'login', '--claudeai'], cwd: path.join(native.directory, 'login'), env: nativeEnvironment('claude', native.directory), signal: controller.signal,
    onProcess: (owner) => tx(() => {
      if (get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id)?.status !== 'pending') throw new AccountError(409, '登录已取消');
      if (get("SELECT token FROM external_native_processes WHERE execution_id=? AND status='active'", 'login:' + id)) {
        anotherTerminalOwns = true;
        throw new AccountError(409, '此登录已由另一个终端持有');
      }
      registerNativeProcess('login:' + id, owner);
    }), onProcessStopped: markNativeProcessStopped });
  const child = owned.child;
  process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const abort = () => { void quiesceNativeProcesses('login:' + id); }; controller.signal.addEventListener('abort', abort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve) => child.once('close', (code) => resolve(owned.exit.code ?? code)));
    if (code !== 0 || controller.signal.aborted) throw new AccountError(409, 'Claude 登录未完成');
    await completeLogin(id);
  } finally { process.stdin.unpipe(child.stdin); process.stdin.pause(); controller.signal.removeEventListener('abort', abort); }
  } catch (error) {
    const current = get<LoginRow>('SELECT * FROM account_login_operations WHERE id=?', id);
    if (!anotherTerminalOwns && current && !terminal(current.status)) status(id, controller.signal.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : 'Claude 登录未完成');
    throw error;
  } finally { clearTimeout(timer); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
