import type { AccountConnection, AccountInput, AccountProtocol, AccountProvider } from '@agent-gand/shared';
import { AccountError } from './errors.ts';

const protocols: AccountProtocol[] = ['anthropic-messages', 'openai-chat-completions', 'openai-responses'];
const providers: AccountProvider[] = ['anthropic', 'openai', 'custom'];
export const officialBaseUrls = { anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1' };
const controls = /[\u0000-\u001f\u007f]/;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountError(400, '账户请求必须为对象');
  return value as Record<string, unknown>;
}
export function assertFields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AccountError(400, '账户请求包含不支持的字段');
}
export function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AccountError(400, '请提供有效的账户版本');
  return Number(value);
}
export function validateKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 16_384 || /\s/.test(value.trim()) || controls.test(value)) {
    throw new AccountError(400, 'API Key 格式无效', { apiKey: '请输入至少 8 个字符的完整密钥，不能包含空白或控制字符' });
  }
  return value.trim();
}
export function validateConnection(value: Record<string, unknown>, provider: AccountProvider): AccountConnection {
  const errors: Record<string, string> = {};
  let baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  if (!baseUrl && provider !== 'custom') baseUrl = officialBaseUrls[provider];
  try {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || controls.test(baseUrl) || baseUrl.length > 1000) throw new Error();
    baseUrl = url.toString().replace(/\/+$/, '');
  } catch { errors.baseUrl = '请输入 HTTP(S) 服务地址，不包含认证信息、查询参数或片段'; }
  const selected = value.protocols;
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > 3 || selected.some((item) => !protocols.includes(item))) errors.protocols = '请选择至少一种支持的接口';
  const normalized = Array.isArray(selected) ? [...new Set(selected)] as AccountProtocol[] : [];
  if (provider === 'anthropic' && normalized.some((item) => item !== 'anthropic-messages')) errors.protocols = 'Anthropic 服务使用 Messages 接口';
  if (provider === 'openai' && normalized.includes('anthropic-messages')) errors.protocols = 'OpenAI 服务使用 Chat Completions 或 Responses 接口';
  const models = value.models;
  if (!Array.isArray(models) || models.length > 100 || models.some((model) => typeof model !== 'string' || !model.trim() || model.trim().length > 200 || /\s/.test(model.trim()) || controls.test(model))) errors.models = '模型 ID 必须为不含空白的文本，最多 100 个';
  const normalizedModels = Array.isArray(models) ? [...new Set(models.filter((model): model is string => typeof model === 'string').map((model) => model.trim()))] : [];
  const defaultModel = value.defaultModel === null || value.defaultModel === undefined || value.defaultModel === '' ? null : value.defaultModel;
  if (defaultModel !== null && (typeof defaultModel !== 'string' || !normalizedModels.includes(defaultModel))) errors.defaultModel = '默认模型必须在模型列表中';
  const timeoutMs = value.timeoutMs ?? 180_000;
  const authHeader = value.authHeader;
  if (authHeader !== undefined && authHeader !== 'x-api-key' && authHeader !== 'bearer') errors.authHeader = '请选择 x-api-key 或 Bearer 认证';
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1_000 || Number(timeoutMs) > 600_000) errors.timeoutMs = '超时应为 1000–600000 毫秒的整数';
  if (Object.keys(errors).length) throw new AccountError(400, '账户连接配置无效', errors);
  return { baseUrl, ...(authHeader === undefined ? {} : { authHeader: authHeader as 'x-api-key' | 'bearer' }), protocols: normalized, models: normalizedModels, defaultModel: defaultModel as string | null, timeoutMs: Number(timeoutMs) };
}
export function validateName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || controls.test(value)) throw new AccountError(400, '账户名称无效', { displayName: '名称必填且不超过 80 个字符' });
  return value.trim();
}
export function validateInput(value: unknown): AccountInput {
  const input = object(value);
  assertFields(input, ['displayName', 'provider', 'apiKey', 'baseUrl', 'authHeader', 'protocols', 'models', 'defaultModel', 'timeoutMs']);
  if (!providers.includes(input.provider as AccountProvider)) throw new AccountError(400, '供应商无效', { provider: '请选择有效的供应商' });
  const provider = input.provider as AccountProvider;
  return { displayName: validateName(input.displayName), provider, apiKey: validateKey(input.apiKey), ...validateConnection(input, provider) };
}
