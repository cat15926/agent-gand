/**
 * Agent 定义（P0-1）
 * 来源：agents/*.agent.md（frontmatter + 正文=system prompt）或 DB 注册
 */

/** 权限三档（P0-5：只读 / 需确认 / 白名单自动） */
export type PermissionMode = 'readonly' | 'confirm' | 'auto';

export interface AgentDefinition {
  id: string;
  name: string;
  /** 给 supervisor 路由/自动委派用的一句话描述 */
  description?: string;
  /** 正文即 system prompt */
  systemPrompt: string;
  /** 模型路由串，如 'mock:planner' | 'openai:gpt-5' | 'anthropic:claude-...' */
  model: string;
  /** 工具白名单 */
  tools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  /** 前端展示用的主题色 */
  color: string;
  source: 'file' | 'db';
}
