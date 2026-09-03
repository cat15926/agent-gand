/**
 * LLM Provider 接口与三个实现（规格 §4.2 + §7.1）
 * - MockProvider：确定性演示路径（零依赖，无 key 可跑）
 * - OpenAICompatibleProvider：POST {base}/chat/completions（OpenAI / DeepSeek / GLM / Qwen 等兼容端点）
 * - AnthropicProvider：POST {base}/v1/messages
 * 纯 fetch 实现，不引官方 SDK；代理走 undici ProxyAgent（LLM_PROXY 可选）
 */
import { fetch as undiciFetch, ProxyAgent, type Response as UndiciResponse } from 'undici';
import { config } from '../config.ts';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 工具调用请求：input 为 JSON 序列化的工具入参 */
export interface LlmToolCall {
  name: string;
  input: string;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/** 传给 Provider 的工具 schema（JSON Schema 形式） */
export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  model: string; // 完整路由串，如 'openai:gpt-4o' / 'anthropic:claude-...' / 'mock:x'
  messages: LlmMessage[];
  tools?: LlmToolSchema[];
}

export interface LlmResponse {
  content: string;
  usage: LlmUsage;
  toolCall: LlmToolCall | null;
  /** 终止原因（anthropic stop_reason / openai finish_reason），记入 llm span 供诊断 */
  stopReason: string | null;
}

export interface LLMProvider {
  chat(req: LlmRequest): Promise<LlmResponse>;
}

// ---- 公共网络层 ----

const REQUEST_TIMEOUT_MS = 60_000;

let proxyAgent: ProxyAgent | null | undefined;

/** LLM_PROXY 设置时懒建代理 dispatcher；未设置返回 null（直连） */
function getDispatcher(): ProxyAgent | null {
  if (proxyAgent === undefined) {
    proxyAgent = config.llm.proxy ? new ProxyAgent(config.llm.proxy) : null;
  }
  return proxyAgent;
}

interface LlmFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

function llmFetch(url: string, init: LlmFetchInit): Promise<UndiciResponse> {
  const dispatcher = getDispatcher();
  return undiciFetch(url, {
    ...init,
    // thinking 模型长生成：超时可经 LLM_TIMEOUT_MS 调整（默认 180s，见 config.ts）
    signal: AbortSignal.timeout(config.llm.timeoutMs ?? REQUEST_TIMEOUT_MS),
    ...(dispatcher !== null ? { dispatcher } : {}), // LLM_PROXY 设置时走代理
  });
}

/** 非 2xx → 抛出含 status 与响应体的错误（便于排障） */
async function assertOk(res: UndiciResponse, providerLabel: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new Error(`${providerLabel} 请求失败 HTTP ${res.status}: ${body.slice(0, 300)}`);
}

/** TODO: 真实 Provider 的 costUsd 记账（需按模型维护价格表；当前记 0） */
const ZERO_COST = 0;

function toInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

// ---- MockProvider（P0 演示路径，保留）----

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** [tool:xxx] 标记触发的 mock 工具调用默认入参（保证可直接执行） */
const MOCK_TOOL_INPUTS: Record<string, string> = {
  'fs.read': JSON.stringify({ path: 'mock-demo.txt' }),
  'fs.write': JSON.stringify({ path: 'mock-demo.txt', content: 'mock 写入演示内容' }),
  'http.get': JSON.stringify({ url: 'https://example.com' }),
  'shell.run': JSON.stringify({ cmd: 'echo', args: ['hello from mock'] }),
  'search.files': JSON.stringify({ pattern: 'TODO' }),
};

/** 从最后一条 user 消息提取 [tool:name] 标记（演示工具链/审批门控用） */
function extractToolCall(lastUserContent: string): LlmToolCall | null {
  const match = /\[tool:([a-zA-Z0-9_.-]+)\]/.exec(lastUserContent);
  const name = match?.[1];
  if (!name) return null;
  const input = Object.prototype.hasOwnProperty.call(MOCK_TOOL_INPUTS, name)
    ? MOCK_TOOL_INPUTS[name]!
    : JSON.stringify({ note: 'mock 未提供该工具的默认入参' });
  return { name, input };
}

const ROLE_LINES: Array<{ keyword: string; label: string; lines: string[] }> = [
  {
    keyword: 'planner',
    label: '【规划】',
    lines: ['1. 梳理目标与约束', '2. 拆解为可独立验收的子任务', '3. 标注依赖与建议执行角色'],
  },
  {
    keyword: 'coder',
    label: '【实现】',
    lines: ['1. 读取相关上下文', '2. 完成主体实现并写入沙箱', '3. 自查后交付说明'],
  },
  {
    keyword: 'reviewer',
    label: '【审查】',
    lines: ['1. 对照验收标准逐项检查', '2. 结论：PASS（演示链路）', '3. 无阻塞性问题'],
  },
];

function buildContent(model: string, goalExcerpt: string): string {
  const role = model.split(':')[1] ?? model;
  const matched = ROLE_LINES.find((r) => role.includes(r.keyword));
  const label = matched?.label ?? '【处理】';
  const lines = matched?.lines ?? ['1. 已理解目标', '2. 已给出处理结果', '3. 交付完成'];
  return [`${label}（mock:${role}）已处理目标「${goalExcerpt}」`, ...lines].join('\n');
}

export class MockProvider implements LLMProvider {
  async chat(req: LlmRequest): Promise<LlmResponse> {
    await delay(200); // 模拟网络延迟
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const goal = lastUser?.content ?? '';
    const content = buildContent(req.model, goal.slice(0, 40));
    // 假 token：按字符数折算（确定性）
    const tokensIn = Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const tokensOut = Math.ceil(content.length / 4);
    return {
      content,
      usage: {
        tokensIn,
        tokensOut,
        costUsd: Math.round((tokensIn * 2e-6 + tokensOut * 8e-6) * 1e6) / 1e6,
      },
      toolCall: extractToolCall(goal),
      stopReason: null,
    };
  }
}

export const mockProvider = new MockProvider();

// ---- OpenAICompatibleProvider（规格 §7.1）----

/** openai chat/completions 响应的窄类型（只取用到的字段） */
interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(apiKey: string | null, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // 去尾部斜杠，拼接路径用
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM_OPENAI_API_KEY（openai-compatible 路由不可用）；配置示例见 .env.example');
    }
    const model = req.model.slice('openai:'.length);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: config.llm.maxTokens, // thinking 模型思考也耗预算（规格 §7 返工①）
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    const res = await llmFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    await assertOk(res, `openai-compatible(${this.baseUrl})`);
    const data = (await res.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    const message = choice?.message;
    const firstToolCall = message?.tool_calls?.[0]?.function;
    // arguments 缺省/为空串时按空对象处理（部分兼容端点会省略）
    const toolCall: LlmToolCall | null =
      firstToolCall?.name
        ? { name: firstToolCall.name, input: firstToolCall.arguments?.trim() || '{}' }
        : null;
    return {
      content: message?.content ?? '',
      usage: {
        tokensIn: toInt(data.usage?.prompt_tokens),
        tokensOut: toInt(data.usage?.completion_tokens),
        costUsd: ZERO_COST,
      },
      toolCall,
      stopReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    };
  }
}

// ---- AnthropicProvider（规格 §7.1）----

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

/** anthropic messages 响应的窄类型 */
interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  stop_reason?: unknown;
}

export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(apiKey: string | null, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM_ANTHROPIC_API_KEY（anthropic 路由不可用）；配置示例见 .env.example');
    }
    const model = req.model.slice('anthropic:'.length);
    // system 提示走独立 system 字段（规格 §7.1）
    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = { model, max_tokens: config.llm.maxTokens, messages: turns };
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }
    const res = await llmFetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    await assertOk(res, `anthropic(${this.baseUrl})`);
    const data = (await res.json()) as AnthropicMessagesResponse;
    const blocks = data.content ?? [];
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const toolUse = blocks.find(
      (b): b is { type: 'tool_use'; name: string; input: unknown } => b.type === 'tool_use',
    );
    const toolCall: LlmToolCall | null = toolUse
      ? { name: toolUse.name, input: JSON.stringify(toolUse.input ?? {}) }
      : null;
    return {
      content: text,
      usage: {
        tokensIn: toInt(data.usage?.input_tokens),
        tokensOut: toInt(data.usage?.output_tokens),
        costUsd: ZERO_COST,
      },
      toolCall,
      stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : null,
    };
  }
}
