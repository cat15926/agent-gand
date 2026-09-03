/**
 * LLM Provider 接口与三个实现（规格 §4.2 + §7.1 + §8.1 流式 / §8.4 并行工具）
 * - MockProvider：确定性演示路径（零依赖，无 key 可跑；不产生流式增量）
 * - OpenAICompatibleProvider：POST {base}/chat/completions（OpenAI / DeepSeek / GLM / Qwen 等兼容端点）
 * - AnthropicProvider：POST {base}/v1/messages
 * 纯 fetch 实现，不引官方 SDK；代理走 undici ProxyAgent（LLM_PROXY 可选）
 *
 * 流式（§8.1）：真实 Provider 一律 stream:true 请求 + SSE 解析；
 * onDelta 增量回调仅转发文本增量（thinking 增量直接丢弃），span 结束仍记完整 output。
 * 工具调用分片重组：openai 按 tool_calls[index] 分桶拼接 name/arguments；
 * anthropic 按 content_block index 分桶，input_json_delta 为原始字符串拼接、块结束后整体交给消费侧 parse。
 * usage 取流末块（openai stream_options.include_usage / anthropic message_start+message_delta 双段）。
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
  /** §8.4：一轮可含多个工具调用（openai 多 tool_calls / anthropic 多 tool_use block 原生支持） */
  toolCalls: LlmToolCall[];
  /** 终止原因（anthropic stop_reason / openai finish_reason），记入 llm span 供诊断 */
  stopReason: string | null;
}

/** §8.1：文本增量回调（thinking 增量不经过此处） */
export type DeltaHandler = (text: string) => void;

export interface LLMProvider {
  chat(req: LlmRequest, onDelta?: DeltaHandler): Promise<LlmResponse>;
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
    // thinking 模型长生成：超时可经 LLM_TIMEOUT_MS 调整（默认 180s，见 config.ts）。
    // AbortSignal 覆盖整个流式读取过程：中途超时已广播的 llm.delta 不回收，span 由调用方记 error（§8.1 R5）
    signal: AbortSignal.timeout(config.llm.timeoutMs ?? REQUEST_TIMEOUT_MS),
    ...(dispatcher !== null ? { dispatcher } : {}), // LLM_PROXY 设置时走代理
  });
}

/** 非 2xx → 抛出含 status 与响应体的错误（便于排障与降级判定） */
class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

async function assertOk(res: UndiciResponse, providerLabel: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new LlmHttpError(
    `${providerLabel} 请求失败 HTTP ${res.status}: ${body.slice(0, 300)}`,
    res.status,
  );
}

/**
 * SSE 行读取器：yield 每个 data: 载荷（字符串）。
 * 忽略注释/心跳行与 event:/id: 等元数据行；容忍 \r\n 行尾。
 * 不依赖 event: 行、按 data.type 判别——兼容端点事件行缺省/顺序差异（R7 真机实证 GLM 形态标准）。
 */
async function* sseDataLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
  } finally {
    reader.releaseLock();
  }
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
    const toolCall = extractToolCall(goal);
    return {
      content,
      usage: {
        tokensIn,
        tokensOut,
        costUsd: Math.round((tokensIn * 2e-6 + tokensOut * 8e-6) * 1e6) / 1e6,
      },
      toolCalls: toolCall === null ? [] : [toolCall],
      stopReason: null,
    };
  }
}

export const mockProvider = new MockProvider();

// ---- OpenAICompatibleProvider（规格 §7.1 + §8.1/§8.4 流式与多工具）----

/** openai 流式 chunk 的窄类型（只取用到的字段） */
interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        function?: { name?: string | null; arguments?: string | null };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

/** openai 非流式响应的窄类型（兼容端点可能忽略 stream 参数，回退整体 JSON） */
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

/** openai 流式 tool_calls 分片桶：name 与 arguments 均可能跨片，按 index 顺序拼接（R3） */
interface ToolCallAcc {
  name: string;
  args: string;
}

function finishToolAccs(accs: Map<number, ToolCallAcc>): LlmToolCall[] {
  return [...accs.entries()]
    .sort((a, b) => a[0] - b[0]) // 按 index 还原模型发起顺序
    .map(([, acc]) => ({ name: acc.name, input: acc.args.trim().length > 0 ? acc.args : '{}' }))
    .filter((tc) => tc.name.length > 0);
}

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(apiKey: string | null, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // 去尾部斜杠，拼接路径用
  }

  async chat(req: LlmRequest, onDelta?: DeltaHandler): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM_OPENAI_API_KEY（openai-compatible 路由不可用）；配置示例见 .env.example');
    }
    const model = req.model.slice('openai:'.length);
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: config.llm.maxTokens, // thinking 模型思考也耗预算（规格 §7 返工①）
      stream: true, // §8.1：一律流式请求
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }
    const url = `${this.baseUrl}/chat/completions`;
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };

    // usage 取流末块需 stream_options（R2）：兼容端点可能不支持该参数而 400 → 去参重试一次（usage 记 0 可接受）
    body.stream_options = { include_usage: true };
    let res = await llmFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 400) {
      void res.body?.cancel().catch(() => {});
      delete body.stream_options;
      res = await llmFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    }
    await assertOk(res, `openai-compatible(${this.baseUrl})`);

    // R4：错误体是普通 JSON 不是 SSE；2xx 但非 event-stream（端点忽略 stream 参数）也按整体 JSON 解析
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const data = (await res.json()) as OpenAIChatResponse;
      return parseOpenAIFullResponse(data, onDelta);
    }
    if (res.body === null) throw new Error('openai-compatible 流式响应无 body');

    let content = '';
    let stopReason: string | null = null;
    let tokensIn = 0;
    let tokensOut = 0;
    const toolAccs = new Map<number, ToolCallAcc>();
    for await (const data of sseDataLines(res.body)) {
      if (data === '[DONE]') break;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAIStreamChunk;
      } catch {
        continue; // 半行/畸形帧跳过（容错）
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const acc = toolAccs.get(index) ?? { name: '', args: '' };
          // name 也可能跨片（GLM/DeepSeek 兼容端点见过）：按 index 拼接；arguments 空片段容错
          if (typeof tc.function?.name === 'string') acc.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
          toolAccs.set(index, acc);
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
        stopReason = choice.finish_reason;
      }
      if (chunk.usage) {
        tokensIn = toInt(chunk.usage.prompt_tokens);
        tokensOut = toInt(chunk.usage.completion_tokens);
      }
    }
    return {
      content,
      usage: { tokensIn, tokensOut, costUsd: ZERO_COST },
      toolCalls: finishToolAccs(toolAccs),
      stopReason,
    };
  }
}

/** 兼容端点忽略 stream 参数时的整体 JSON 解析（内容一次性交给 onDelta） */
function parseOpenAIFullResponse(data: OpenAIChatResponse, onDelta?: DeltaHandler): LlmResponse {
  const choice = data.choices?.[0];
  const message = choice?.message;
  const content = message?.content ?? '';
  if (content.length > 0) onDelta?.(content);
  const toolAccs = new Map<number, ToolCallAcc>();
  for (const [i, tc] of (message?.tool_calls ?? []).entries()) {
    if (tc.function?.name) {
      toolAccs.set(i, { name: tc.function.name, args: tc.function.arguments ?? '' });
    }
  }
  return {
    content,
    usage: {
      tokensIn: toInt(data.usage?.prompt_tokens),
      tokensOut: toInt(data.usage?.completion_tokens),
      costUsd: ZERO_COST,
    },
    toolCalls: finishToolAccs(toolAccs),
    stopReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
  };
}

// ---- AnthropicProvider（规格 §7.1 + §8.1/§8.4 流式与多工具）----

/** anthropic 非流式响应的窄类型（content-type 非 event-stream 时兜底） */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: string; [k: string]: unknown };

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
  stop_reason?: unknown;
}

/** anthropic 流式事件的窄类型（data 载荷） */
interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; text?: unknown; name?: unknown } | null;
  delta?:
    | { type: 'text_delta'; text: string }
    | { type: 'input_json_delta'; partial_json: string }
    | { type: string; [k: string]: unknown }
    | null;
  message?: { usage?: { input_tokens?: unknown } } | null;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** content_block 分桶（R1）：text 块拼文本；tool_use 块拼 partial_json 原始字符串 */
interface AnthropicBlockAcc {
  kind: 'text' | 'tool_use' | 'other'; // thinking 等其他块增量直接丢弃（§8.1）
  text: string;
  toolName: string;
  json: string;
}

export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;

  constructor(apiKey: string | null, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async chat(req: LlmRequest, onDelta?: DeltaHandler): Promise<LlmResponse> {
    if (!this.apiKey) {
      throw new Error('未配置 LLM_ANTHROPIC_API_KEY（anthropic 路由不可用）；配置示例见 .env.example');
    }
    const model = req.model.slice('anthropic:'.length);
    // system 提示走独立 system 字段（规格 §7.1）
    const systemParts = req.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const turns = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    const body: Record<string, unknown> = {
      model,
      max_tokens: config.llm.maxTokens,
      messages: turns,
      stream: true, // §8.1：一律流式请求
    };
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

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const data = (await res.json()) as AnthropicMessagesResponse;
      return parseAnthropicFullResponse(data, onDelta);
    }
    if (res.body === null) throw new Error('anthropic 流式响应无 body');

    const blocks = new Map<number, AnthropicBlockAcc>();
    let stopReason: string | null = null;
    // R2：anthropic usage 双段——message_start.usage.input_tokens + message_delta.usage.output_tokens
    let tokensIn = 0;
    let tokensOut = 0;
    for await (const data of sseDataLines(res.body)) {
      let ev: AnthropicStreamEvent;
      try {
        ev = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          tokensIn = toInt(ev.message?.usage?.input_tokens);
          break;
        case 'content_block_start': {
          const blockType = ev.content_block?.type ?? 'other';
          const acc: AnthropicBlockAcc = {
            kind: blockType === 'text' ? 'text' : blockType === 'tool_use' ? 'tool_use' : 'other',
            text: typeof ev.content_block?.text === 'string' ? ev.content_block.text : '',
            toolName: typeof ev.content_block?.name === 'string' ? ev.content_block.name : '',
            json: '',
          };
          blocks.set(ev.index ?? blocks.size, acc);
          if (acc.kind === 'text' && acc.text.length > 0) onDelta?.(acc.text);
          break;
        }
        case 'content_block_delta': {
          const acc = blocks.get(ev.index ?? 0);
          if (!acc) break;
          const d = ev.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            acc.text += d.text;
            if (acc.kind === 'text') onDelta?.(d.text);
          } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            // 原始字符串拼接（不是 JSON 合并），结束后整体 parse 在消费侧（R1）
            acc.json += d.partial_json;
          }
          // thinking_delta 等其他增量直接丢弃（§8.1）
          break;
        }
        case 'message_delta': {
          const stop = (ev as { delta?: { stop_reason?: unknown } }).delta?.stop_reason;
          if (typeof stop === 'string') stopReason = stop;
          // R2 双段合并：官方端点 input 只在 message_start、output 在 message_delta；
          // GLM 兼容端点把真实 input_tokens 也放 message_delta（message_start 里是 0）——
          // input 以非零最新值为准，两种形态都记账正确（R7 真机实证）
          const inTok = toInt(ev.usage?.input_tokens);
          if (inTok > 0) tokensIn = inTok;
          const outTok = toInt(ev.usage?.output_tokens);
          if (outTok > 0) tokensOut = outTok;
          break;
        }
        default:
          break; // ping / content_block_stop / message_stop：无需累积
      }
    }

    const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, acc]) => acc);
    const text = ordered.filter((b) => b.kind === 'text').map((b) => b.text).join('\n');
    const toolCalls: LlmToolCall[] = ordered
      .filter((b) => b.kind === 'tool_use' && b.toolName.length > 0)
      .map((b) => ({ name: b.toolName, input: b.json.trim().length > 0 ? b.json : '{}' }));
    return {
      content: text,
      usage: { tokensIn, tokensOut, costUsd: ZERO_COST },
      toolCalls,
      stopReason,
    };
  }
}

/** 兼容端点忽略 stream 参数时的整体 JSON 解析（内容一次性交给 onDelta） */
function parseAnthropicFullResponse(
  data: AnthropicMessagesResponse,
  onDelta?: DeltaHandler,
): LlmResponse {
  const blocks = data.content ?? [];
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (text.length > 0) onDelta?.(text);
  const toolCalls: LlmToolCall[] = blocks
    .filter((b): b is { type: 'tool_use'; name: string; input: unknown } => b.type === 'tool_use')
    .map((b) => ({ name: b.name, input: JSON.stringify(b.input ?? {}) }));
  return {
    content: text,
    usage: {
      tokensIn: toInt(data.usage?.input_tokens),
      tokensOut: toInt(data.usage?.output_tokens),
      costUsd: ZERO_COST,
    },
    toolCalls,
    stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : null,
  };
}
