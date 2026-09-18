/**
 * Agent 定义（P0-1）
 * 来源：agents/*.agent.md（frontmatter + 正文=system prompt）或 DB 注册
 */

/** 权限三档（P0-5：只读 / 需确认 / 白名单自动） */
export type PermissionMode = 'readonly' | 'confirm' | 'auto';
export type AgentCapability = 'execute' | 'review' | 'coordinate';

export interface AgentDefinition {
  id: string;
  name: string;
  /** 给 supervisor 路由/自动委派用的一句话描述 */
  description?: string;
  /** 调度能力：执行、审查、协调。 */
  capabilities: AgentCapability[];
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
  /** 头像：短文字/Emoji，或 HTTPS 图片 URL。空值时回退到名称首字。 */
  avatar?: string;
  source: 'file' | 'db';
  enabled: boolean;
  /** 每次有效配置变更递增，用于乐观锁和运行快照。 */
  version: number;
  syncError?: string | null;
}

export interface AgentInput {
  id: string;
  name: string;
  description: string;
  capabilities: AgentCapability[];
  systemPrompt: string;
  model: string;
  tools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  color: string;
  avatar: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  input: Omit<AgentInput, 'id' | 'name'>;
}

export interface AgentOptions {
  tools: Array<{ name: string; description: string; readonly: boolean; source: 'builtin' | 'mcp' }>;
  capabilities: Array<{ value: AgentCapability; label: string }>;
  providers: Array<{ value: 'mock' | 'openai' | 'anthropic'; label: string; configured: boolean }>;
  templates: AgentTemplate[];
}
