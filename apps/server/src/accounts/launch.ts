import { ExecutionError } from '../execution/errors.ts';
import { AccountError } from './errors.ts';
import type { ExternalDriverId } from '@agent-gand/shared';
import { config } from '../config.ts';
import { cleanEnvironment } from './environment.ts';
import { nativeEnvironment, privateDirectory, verifyIdentity } from './native.ts';
import type { ResolvedAccount } from './resolver.ts';
import { createCredentialRelay } from './relay.ts';

export function codexCredentialPolicy(): string[] {
  return ['-c', 'default_permissions="gand_accounts"', '-c', 'permissions.gand_accounts.extends=":read-only"',
    '-c', `permissions.gand_accounts.filesystem={${JSON.stringify(config.accounts.privateDir)}="deny"}`,
    '-c', 'permissions.gand_accounts.network.enabled=false', '-c', 'allow_login_shell=false',
    '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.set={${Object.entries(cleanEnvironment()).filter(([key]) => /^(PATH|LANG|LC_.*|TMPDIR|TMP|TEMP|TZ)$/.test(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}`];
}
export async function prepareAccountLaunch(driver: ExternalDriverId, account: ResolvedAccount | null | undefined, signal: AbortSignal, noTools = false, connectionTest = false) {
  let env = cleanEnvironment(); let home: string | undefined; let args: string[] = []; let close = async () => {};
  const authenticationAbort = new AbortController();
  let authenticationError: ExecutionError | null = null;
  const launchSignal = AbortSignal.any([signal, authenticationAbort.signal]);
  if (account?.managed) {
    home = await privateDirectory(account.runtimeHome!);
    if (account.authType === 'native_login') {
      try { await verifyIdentity(account.accountId, account.binding!.identityGeneration!, signal); } catch (error) { if (error instanceof AccountError && error.status === 409) throw new ExecutionError('auth_required', error.message); throw error; }
      env = nativeEnvironment(account.nativeClient!, account.nativeDirectory!);
    } else {
      const relay = await createCredentialRelay(account, driver.startsWith('claude') ? 'anthropic' : 'openai', launchSignal, noTools, (status, detail) => {
        authenticationError ??= new ExecutionError('auth_required', `所选账户的模型服务返回 HTTP ${status}${detail ? `（${detail}）` : ''}。请检查密钥、认证方式及模型权限。`);
        authenticationAbort.abort();
      }, connectionTest); close = () => relay.close();
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
  return { env, home, args, close, signal: launchSignal, authenticationError: () => authenticationError };
}
