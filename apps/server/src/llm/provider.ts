/**
 * LLM Provider 接口与 MockProvider（规格 §4.2 llm/provider.ts）
 * Mock：确定性文案 + 假 token 数 + ~200ms 延迟；演示链路可端到端跑通
 */
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

export interface LlmRequest {
  model: string;
  messages: LlmMessage[];
}

export interface LlmResponse {
  content: string;
  usage: LlmUsage;
  toolCall: LlmToolCall | null;
}

export interface LLMProvider {
  chat(req: LlmRequest): Promise<LlmResponse>;
}

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
    };
  }
}

export const mockProvider = new MockProvider();
