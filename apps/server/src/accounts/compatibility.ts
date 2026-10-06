import type { AccountBackend, AccountConnection, AccountProtocol } from '@agent-gand/shared';

const byProtocol: Record<AccountProtocol, AccountBackend[]> = {
  'anthropic-messages': ['builtin-anthropic', 'claude-sdk', 'claude-cli'],
  'openai-chat-completions': ['builtin-openai'],
  'openai-responses': ['codex-app-server', 'codex-exec'],
};
/** Configuration compatibility only; this does not claim model access or successful inference. */
export function compatibleBackends(connection: AccountConnection, nativeClient?: 'claude' | 'codex' | null): AccountBackend[] {
  if (nativeClient) return nativeClient === 'claude' ? ['claude-cli'] : ['codex-app-server', 'codex-exec'];
  return [...new Set(connection.protocols.flatMap((protocol) => byProtocol[protocol]))];
}
