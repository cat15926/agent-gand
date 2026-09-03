/**
 * 模型路由（规格 §4.2 + §7.1）
 * 前缀路由：mock:* → Mock；openai:* → OpenAICompatible；anthropic:* → Anthropic
 * 真实 Provider 单例懒建；缺 key 时 chat 调用即报错（不影响启动与 mock 路径）
 * TODO: 多工具并行 tool_calls、tool 结果回传多轮对话
 */
import { config } from '../config.ts';
import type { LLMProvider } from './provider.ts';
import { AnthropicProvider, mockProvider, OpenAICompatibleProvider } from './provider.ts';

let openaiProvider: OpenAICompatibleProvider | null = null;
let anthropicProvider: AnthropicProvider | null = null;

export function resolveProvider(model: string): LLMProvider {
  if (model.startsWith('mock:')) return mockProvider;
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
