/**
 * 模型路由（规格 §4.2 llm/router.ts）
 * model 前缀路由：mock:* → MockProvider；openai: / anthropic: → TODO 骨架
 */
import type { LLMProvider } from './provider.ts';
import { mockProvider } from './provider.ts';

export function resolveProvider(model: string): LLMProvider {
  if (model.startsWith('mock:')) return mockProvider;
  if (model.startsWith('openai:') || model.startsWith('anthropic:')) {
    // TODO: 对接真实 LLM API（读取 config.llm 中的 LLM_OPENAI_API_KEY / LLM_ANTHROPIC_API_KEY）
    throw new Error(`LLM provider not configured (TODO): ${model}`);
  }
  throw new Error(`未知的模型路由串: ${model}`);
}
