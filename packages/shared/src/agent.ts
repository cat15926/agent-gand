/**
 * Agent 定义（P0-1）
 * 来源：agents/*.agent.md（frontmatter + 正文=system prompt）或 DB 注册
 */

/** 权限三档（P0-5：只读 / 需确认 / 白名单自动） */
import type { AgentExecutionConfig, ExecutionDriverInfo } from './execution.ts';

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
  /** 内置后端为 provider:model 路由；外部后端为原生模型名或 default。 */
  model: string;
  /** Logical connection; omission retains the legacy environment/native source. */
  accountRef?: string;
  /** New explicit-connection drafts must not fall back to legacy authentication. */
  requiresAccount?: boolean;
  execution?: AgentExecutionConfig;
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
  accountRef?: string;
  requiresAccount?: boolean;
  execution?: AgentExecutionConfig;
  tools: string[];
  disallowedTools: string[];
  permissionMode: PermissionMode;
  color: string;
  avatar: string;
}

/** Explicit activation is validated by the server; disabled drafts still obey tool policy. */
export type AgentSaveInput = AgentInput & { enabled?: boolean };
export interface AgentPreflight {
  ok: boolean;
  issues: Record<string, string>;
  testedModel: false;
  permissions: {
    summary: string;
    nativeTools: string[];
    platformTools: string[];
    allowedTools: string[];
    deniedTools: string[];
    session: string;
    limits: string[];
  };
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  input: Omit<AgentInput, 'id' | 'name'>;
}

export interface AgentOptions {
  executionDrivers?: ExecutionDriverInfo[];
  tools: Array<{ name: string; description: string; readonly: boolean; source: 'builtin' | 'mcp' }>;
  capabilities: Array<{ value: AgentCapability; label: string }>;
  providers: Array<{ value: 'mock' | 'openai' | 'anthropic'; label: string; configured: boolean }>;
  templates: AgentTemplate[];
}
