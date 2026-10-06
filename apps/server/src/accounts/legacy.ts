import type { AccountConnection, AccountView } from '@agent-gand/shared';
import { config } from '../config.ts';
import { compatibleBackends } from './compatibility.ts';

export const legacyAccountIds = ['legacy-llm-openai', 'legacy-llm-anthropic', 'legacy-claude-sdk', 'legacy-claude-cli', 'legacy-codex-native'] as const;
/** Read-only projection, never imports environment keys or copies native refresh tokens. */
export function legacyAccounts(): AccountView[] {
  const connection = (baseUrl: string, protocols: AccountConnection['protocols']): AccountConnection => ({ baseUrl: safeUrl(baseUrl), protocols, models: [], defaultModel: null, timeoutMs: config.llm.timeoutMs });
  const entries = [
    { id: legacyAccountIds[0], displayName: '旧配置 · OpenAI 模型 API', provider: 'openai' as const, key: config.llm.openaiApiKey, connection: connection(config.llm.openaiBaseUrl, ['openai-chat-completions']), nativeClient: null },
    { id: legacyAccountIds[1], displayName: '旧配置 · Anthropic 模型 API', provider: 'anthropic' as const, key: config.llm.anthropicApiKey, connection: connection(config.llm.anthropicBaseUrl, ['anthropic-messages']), nativeClient: null },
    { id: legacyAccountIds[2], displayName: '旧配置 · Claude SDK', provider: 'anthropic' as const, key: process.env.ANTHROPIC_API_KEY, connection: connection(process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com', ['anthropic-messages']), nativeClient: null },
    { id: legacyAccountIds[3], displayName: '旧认证 · Claude Code CLI', provider: 'anthropic' as const, key: null, connection: connection('', []), nativeClient: 'claude' as const },
    { id: legacyAccountIds[4], displayName: '旧认证 · Codex 专用目录', provider: 'openai' as const, key: null, connection: connection('', []), nativeClient: 'codex' as const },
  ];
  return entries.map((entry) => ({
    id: entry.id, displayName: entry.displayName, provider: entry.provider, authType: entry.nativeClient ? 'native_login' : 'api_key',
    source: entry.nativeClient ? 'legacy_native' : 'legacy_env', enabled: true, archived: false, version: 1, configVersion: 1, credentialVersion: null,
    connection: entry.connection, hasCredential: !!entry.key, keySuffix: entry.key && entry.key.length >= 8 ? entry.key.slice(-4) : null,
    authentication: entry.nativeClient ? 'unchecked' : entry.key ? 'configured' : 'missing', testStatus: 'untested',
    compatibleBackends: entry.id === 'legacy-llm-anthropic' ? ['builtin-anthropic'] : entry.id === 'legacy-claude-sdk' ? ['claude-sdk'] : compatibleBackends(entry.connection, entry.nativeClient),
    nativeClient: entry.nativeClient, roleCount: 0, createdAt: null, updatedAt: null,
  }));
}
function safeUrl(raw: string): string {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch { return ''; }
}
export function implicitAccount(definition: { model?: string; execution?: { kind?: string; driver?: string }; accountRef?: string; requiresAccount?: boolean }): string | null {
  if (definition.accountRef || definition.requiresAccount) return null;
  if (definition.execution?.kind === 'external') {
    if (definition.execution.driver === 'claude-sdk') return 'legacy-claude-sdk';
    if (definition.execution.driver === 'claude-cli') return 'legacy-claude-cli';
    if (['codex-exec', 'codex-app-server'].includes(definition.execution.driver ?? '')) return 'legacy-codex-native';
    return null;
  }
  return definition.model?.startsWith('openai:') ? 'legacy-llm-openai' : definition.model?.startsWith('anthropic:') ? 'legacy-llm-anthropic' : null;
}
