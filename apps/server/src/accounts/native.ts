import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, chmod, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { all, get, run } from '../db/database.ts';
import { withRpcProcess } from '../execution/rpc.ts';
import { cleanEnvironment } from './environment.ts';
import { AccountError } from './errors.ts';
import { emit } from '../messaging/bus.ts';
import { rememberSecret } from './secrets.ts';
import { assertCodexHomePolicy, CODEX_SKILL_POLICY } from '../execution/codexHome.ts';

export interface NativeIdentity {
  account_id: string; generation: number; client: 'claude' | 'codex'; directory: string;
  status: 'pending' | 'authenticated' | 'expired'; summary: string | null; identity_hash: string | null;
}
interface NativeInspectionOptions { refreshToken?: boolean }
export function identity(accountId: string, generation: number | null): NativeIdentity | undefined {
  return generation === null ? undefined : get<NativeIdentity>('SELECT * FROM account_native_identities WHERE account_id=? AND generation=?', accountId, generation);
}
export async function privateDirectory(directory: string): Promise<string> {
  const root = path.resolve(config.accounts.privateDir); const target = path.resolve(directory);
  if (target !== root && !target.startsWith(root + path.sep)) throw new AccountError(403, '认证目录越界');
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const current of [root, ...path.relative(root, target).split(path.sep).filter(Boolean).map((_, i, parts) => path.join(root, ...parts.slice(0, i + 1)))]) {
    await mkdir(current, { recursive: true, mode: 0o700 });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new AccountError(503, '私有认证目录无效');
    await chmod(current, 0o700);
  }
  return realpath(target);
}
export function identityDirectory(accountId: string, generation: number): string {
  if (!/^[0-9a-f-]{36}$/.test(accountId) || !Number.isSafeInteger(generation) || generation < 1) throw new AccountError(400, '认证身份引用无效');
  return path.join(config.accounts.privateDir, 'native', accountId, String(generation));
}
export function nativeEnvironment(client: 'claude' | 'codex', directory: string): NodeJS.ProcessEnv {
  return cleanEnvironment({ HOME: directory, ...(client === 'claude' ? { CLAUDE_CONFIG_DIR: path.join(directory, 'config') } : { CODEX_HOME: path.join(directory, 'config') }) });
}
export const loginArgs = ['app-server', '--listen', 'stdio://', ...CODEX_SKILL_POLICY, '-c', 'cli_auth_credentials_store="file"', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.multi_agent=false'];
export async function initializeAccountPeer(peer: import('../execution/rpc.ts').RpcPeer): Promise<void> {
  await peer.request('initialize', { clientInfo: { name: 'agent_gand_accounts', version: '0.1.0' }, capabilities: { experimentalApi: false } });
  peer.send({ method: 'initialized', params: {} });
}
async function protectCredentialFiles(directory: string): Promise<void> {
  for (const name of ['auth.json', '.credentials.json']) {
    try {
      const file = path.join(directory, 'config', name); const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid())) throw new AccountError(503, '原生认证文件无效');
      await chmod(file, 0o600);
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      const remember = (value: unknown, field = '') => { if (typeof value === 'string' && /token|key/i.test(field)) rememberSecret(value); else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) remember(item, key); };
      remember(parsed);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export async function inspectNative(client: 'claude' | 'codex', directory: string, signal = new AbortController().signal, options: NativeInspectionOptions = {}): Promise<{ authenticated: boolean; summary: string | null; fingerprint: string | null }> {
  await privateDirectory(directory); await privateDirectory(path.join(directory, 'config')); await privateDirectory(path.join(directory, 'login'));
  await protectCredentialFiles(directory);
  let authenticated = false; let summary: string | null = null; let identifier = '';
  if (client === 'codex') {
    await assertCodexHomePolicy(path.join(directory, 'config'));
    const account = await withRpcProcess({ command: config.externalAgents.codexCommand, args: loginArgs, cwd: path.join(directory, 'login'), env: nativeEnvironment(client, directory), signal, timeoutMs: 15_000 }, async (peer) => {
      await initializeAccountPeer(peer); return (await peer.request('account/read', { refreshToken: options.refreshToken ?? true })).account;
    });
    authenticated = account?.type === 'chatgpt';
    if (authenticated) {
      summary = [account.email, account.planType].filter((item) => typeof item === 'string').join(' · ').slice(0, 160) || 'Codex 已登录';
      const auth = JSON.parse(await readFile(path.join(directory, 'config', 'auth.json'), 'utf8'));
      identifier = auth.tokens?.account_id ?? auth.account_id ?? account.email ?? '';
      authenticated = !!identifier;
    }
  } else {
    const status = await new Promise<Record<string, unknown>>((resolve, reject) => {
      execFile(config.externalAgents.claudeCommand, ['auth', 'status', '--json'], { cwd: path.join(directory, 'login'), env: nativeEnvironment(client, directory), signal, timeout: 15_000, maxBuffer: 64_000 }, (_error, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { reject(new AccountError(503, '无法检测独立 Claude 登录状态')); }
      });
    });
    authenticated = status.loggedIn === true && status.authMethod !== 'api_key';
    if (authenticated) { summary = [status.email, status.subscriptionType].filter((item) => typeof item === 'string').join(' · ').slice(0, 160) || 'Claude 已登录'; authenticated = !!(status.email || status.orgId); identifier = JSON.stringify([status.email ?? '', status.orgId ?? '']); }
  }
  await protectCredentialFiles(directory);
  return { authenticated, summary: authenticated ? summary : null, fingerprint: authenticated ? createHash('sha256').update(client + ':' + identifier).digest('hex') : null };
}
/** A frozen generation can refresh tokens, but cannot silently change its identity. */
export async function verifyIdentity(accountId: string, generation: number, signal?: AbortSignal, options: NativeInspectionOptions = {}): Promise<NativeIdentity> {
  const current = identity(accountId, generation);
  if (!current || current.status !== 'authenticated') throw new AccountError(409, '登录身份未认证或已失效，请重新登录后创建新运行');
  const detected = await inspectNative(current.client, current.directory, signal, options);
  if (!detected.authenticated || detected.fingerprint !== current.identity_hash) {
    run("UPDATE account_native_identities SET status='expired',updated_at=? WHERE account_id=? AND generation=?", new Date().toISOString(), accountId, generation);
    emit({ type: 'account.login.updated', accountId });
    throw new AccountError(409, '登录身份已失效或改变，请重新登录后创建新运行');
  }
  return current;
}

export async function removeNativeCredentials(accountId: string): Promise<void> {
  // Deletion is admitted only after current roles, unfinished runs and login/tests release it.
  const directory = path.dirname(identityDirectory(accountId, 1));
  for (const row of all<NativeIdentity>('SELECT * FROM account_native_identities WHERE account_id=?', accountId)) {
    if (row.client !== 'claude') continue;
    await privateDirectory(path.join(row.directory, 'config')); await privateDirectory(path.join(row.directory, 'login'));
    await new Promise<void>((resolve, reject) => execFile(config.externalAgents.claudeCommand, ['auth', 'logout'], { cwd: path.join(row.directory, 'login'), env: nativeEnvironment('claude', row.directory), timeout: 5000, maxBuffer: 4096 }, (error) => error ? reject(new AccountError(503, '账户已停用或删除，但 Claude 客户端退出失败；私有认证文件已保留，请由管理员处理')) : resolve()));
  }
  await privateDirectory(directory);
  await rm(directory, { recursive: true, force: true });
}

export function assertNoUnsettledAccountProcess(accountId: string): void {
  if (get(`SELECT token FROM external_native_processes WHERE status='active' AND execution_id IN (
    SELECT 'login:' || id FROM account_login_operations WHERE account_id=?
    UNION ALL SELECT 'test:' || id FROM account_checks WHERE account_id=?
  ) LIMIT 1`, accountId, accountId)) throw new AccountError(409, '账户仍有未收敛的登录或测试进程，请先取消或处理恢复状态');
}
