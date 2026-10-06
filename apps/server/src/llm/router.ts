/**
 * 模型路由（规格 §4.2 + §7.1 + §8.1/8.4）
 * 前缀路由：mock:* → Mock；openai:* → OpenAICompatible；anthropic:* → Anthropic
 * 真实 Provider 单例懒建；缺 key 时 chat 调用即报错（不影响启动与 mock 路径）
 * TODO: 协议原生 tool 消息回传（openai role:tool / anthropic tool_result block，当前 user 消息模拟）
 */
import { config } from '../config.ts';
import type { LLMProvider } from './provider.ts';
import { AnthropicProvider, mockProvider, OpenAICompatibleProvider } from './provider.ts';
import type { AgentDefinition } from '@agent-gand/shared';
import { resolveAccount, assertNotRevoked, type ResolvedAccount } from '../accounts/resolver.ts';
import { redactSecrets, secretSafeDelta } from '../accounts/secrets.ts';
import { subscribe } from '../messaging/bus.ts';

let openaiProvider: OpenAICompatibleProvider | null = null;
let anthropicProvider: AnthropicProvider | null = null;
const accountProviders = new Map<string, LLMProvider>();

export function resolveProvider(model: string, account?: ResolvedAccount | null): LLMProvider {
  if (model.startsWith('mock:')) return mockProvider;
  if (account) {
    if (account.authType !== 'api_key' || !account.apiKey) throw new Error('所选账户缺少模型 API 密钥');
    const protocol = model.startsWith('anthropic:') ? 'anthropic-messages' : model.startsWith('openai:') ? 'openai-chat-completions' : null;
    if (!protocol || !account.connection.protocols.includes(protocol)) throw new Error('所选账户不支持该模型接口');
    const key = account.cacheKey + ':' + protocol;
    let provider = accountProviders.get(key);
    if (!provider) {
      provider = protocol === 'anthropic-messages' ? new AnthropicProvider(account.apiKey, account.connection.baseUrl, account.connection.timeoutMs, account.connection.authHeader) : new OpenAICompatibleProvider(account.apiKey, account.connection.baseUrl, account.connection.timeoutMs);
      accountProviders.set(key, provider); if (accountProviders.size > 100) accountProviders.delete(accountProviders.keys().next().value!);
    }
    const selected = provider;
    return { async chat(req, onDelta) {
      assertNotRevoked(account.accountId);
      const controller = new AbortController();
      const unsubscribe = subscribe((event) => { if (event.type === 'account.revoked' && event.accountId === account.accountId) controller.abort(); });
      const deltas = secretSafeDelta(onDelta);
      try {
        const result = await selected.chat({ ...req, signal: req.signal ? AbortSignal.any([controller.signal, req.signal]) : controller.signal }, (text) => deltas.push(text));
        assertNotRevoked(account.accountId); deltas.finish();
        return { ...result, content: redactSecrets(result.content), toolCalls: result.toolCalls.map((call) => ({ name: call.name, input: redactSecrets(call.input) })) };
      } catch (error) { throw new Error(redactSecrets(error instanceof Error ? error.message : String(error))); }
      finally { unsubscribe(); }
    } };
  }
  if (model.startsWith('openai:')) {
    openaiProvider ??= new OpenAICompatibleProvider(config.llm.openaiApiKey, config.llm.openaiBaseUrl);
    return openaiProvider;
  }
  if (model.startsWith('anthropic:')) {
    anthropicProvider ??= new AnthropicProvider(config.llm.anthropicApiKey, config.llm.anthropicBaseUrl);
    return anthropicProvider;
  }
  throw new Error(`未知的模型路由串: ${model}`);
}
export function providerForAgent(agent: Pick<AgentDefinition, 'id' | 'model' | 'execution' | 'accountRef' | 'requiresAccount'>, runId?: string): LLMProvider {
  return resolveProvider(agent.model, resolveAccount(agent, runId));
}
