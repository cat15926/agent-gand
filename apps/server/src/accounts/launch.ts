import { ExecutionError } from '../execution/errors.ts';
import { AccountError } from './errors.ts';
import type { ExternalDriverId } from '@agent-gand/shared';
import { config } from '../config.ts';
import { cleanEnvironment } from './environment.ts';
import { nativeEnvironment, privateDirectory, verifyIdentity } from './native.ts';
import type { ResolvedAccount } from './resolver.ts';
import { createCredentialRelay } from './relay.ts';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { rememberSecret } from './secrets.ts';
import type { ScopedNativeEnvironment } from '../execution/scopedNative.ts';

export function codexCredentialPolicy(): string[] {
  return ['-c', 'default_permissions="gand_accounts"', '-c', 'permissions.gand_accounts.extends=":read-only"',
    '-c', `permissions.gand_accounts.filesystem={${[config.accounts.privateDir,config.dbPath,config.dbPath+'-wal',config.dbPath+'-shm'].map(file => `${JSON.stringify(file)}="deny"`).join(',')}}`,
    '-c', 'permissions.gand_accounts.network.enabled=false', '-c', 'allow_login_shell=false',
    '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.set={${Object.entries(cleanEnvironment()).filter(([key]) => /^(PATH|LANG|LC_.*|TMPDIR|TMP|TEMP|TZ)$/.test(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`];
}
export async function prepareAccountLaunch(driver: ExternalDriverId, account: ResolvedAccount | null | undefined, signal: AbortSignal, noTools = false, connectionTest = false, scoped?: ScopedNativeEnvironment, inferenceAllowed?:()=>boolean) {
  let env = cleanEnvironment(); let home: string | undefined; let args: string[] = []; let close = async () => {};
  let externalAuth: { accessToken: string; chatgptAccountId: string } | undefined;
  scoped?.assertAuthorized();
  if (scoped && (!account?.managed || !['claude-sdk','codex-app-server'].includes(driver)
    || account.authType === 'native_login' && driver !== 'codex-app-server')) throw new ExecutionError('policy_rejected', '该认证方式尚未实现独立 Scope 原生隔离');
  const authenticationAbort = new AbortController();
  let authenticationError: ExecutionError | null = null;
  const launchSignal = AbortSignal.any([signal, authenticationAbort.signal]);
  if (account?.managed) {
    home = scoped?.home ?? await privateDirectory(account.runtimeHome!);
    if (account.authType === 'native_login') {
      try { await verifyIdentity(account.accountId, account.binding!.identityGeneration!, signal); }
      catch (error) {
        if(error instanceof ExecutionError&&error.code==='timeout')throw new ExecutionError('timeout','原生账户身份检查超时（15 秒），尚未进入模型回复阶段。',{...error.details,phase:'initialization',initializationStep:'client',timeoutKind:'total',limitMs:15000});
        if (error instanceof AccountError && error.status === 409) throw new ExecutionError('auth_required', error.message);
        throw error;
      }
      if (scoped) {
        // Refresh stays in the account authority above. Only a short-lived access token is
        // handed to the child over stdio; no refresh token, auth file or shared home copy.
        const auth = JSON.parse(await readFile(path.join(account.nativeDirectory!, 'config', 'auth.json'), 'utf8'));
        if (typeof auth.tokens?.access_token !== 'string' || typeof auth.tokens?.account_id !== 'string') throw new ExecutionError('auth_required', 'Codex 登录缺少可用于隔离执行的访问令牌');
        rememberSecret(auth.tokens.access_token);
        externalAuth = { accessToken: auth.tokens.access_token, chatgptAccountId: auth.tokens.account_id };
        env = cleanEnvironment({ HOME: home, CODEX_HOME: home });
        args.push('-c', 'cli_auth_credentials_store="ephemeral"');
      } else env = nativeEnvironment(account.nativeClient!, account.nativeDirectory!);
    } else {
      const relay = await createCredentialRelay(account, driver.startsWith('claude') ? 'anthropic' : 'openai', launchSignal, noTools, (status, detail) => {
        authenticationError ??= new ExecutionError('auth_required', `所选账户的模型服务返回 HTTP ${status}${detail ? `（${detail}）` : ''}。请检查密钥、认证方式及模型权限。`);
        authenticationAbort.abort();
      }, connectionTest, inferenceAllowed); close = () => relay.close();
      if (driver.startsWith('claude')) env = cleanEnvironment({ HOME: home, CLAUDE_CONFIG_DIR: home, ANTHROPIC_API_KEY: relay.token, ANTHROPIC_BASE_URL: relay.baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
      else {
        env = cleanEnvironment({ HOME: home, CODEX_HOME: home, GAND_INFERENCE_TOKEN: relay.token });
        args = ['-c', 'model_provider="gand_account"', '-c', `model_providers.gand_account={name="Gand account",base_url=${JSON.stringify(relay.baseUrl)},env_key="GAND_INFERENCE_TOKEN",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`];
      }
    }
    if (driver.startsWith('codex')) args.push(...codexCredentialPolicy());
  } else if (driver === 'claude-sdk') {
    env = cleanEnvironment({ ANTHROPIC_API_KEY: account?.apiKey ?? process.env.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: account?.connection.baseUrl ?? process.env.ANTHROPIC_BASE_URL });
  } else if (driver.startsWith('codex')) env = cleanEnvironment({ CODEX_HOME: config.externalAgents.codexHome });
  else {
    // Preserve only the previous Claude CLI source, not unrelated model credentials.
    env = cleanEnvironment({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL });
  }
  if (scoped) {
    try { scoped.assertAuthorized(); } catch (error) { await close(); throw error; }
    env = { ...env, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, GIT_CEILING_DIRECTORIES: path.dirname(scoped.cwd) };
  }
  return { env, home, args, close, externalAuth, signal: launchSignal, authenticationError: () => authenticationError };
}
