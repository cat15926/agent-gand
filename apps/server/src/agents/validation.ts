import type { AgentCapability, AgentDefinition, AgentInput } from '@agent-gand/shared';
import { listToolNames } from '../tools/builtin/index.ts';

const ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const RESERVED = new Set(['user', 'system', 'all', 'supervisor']);
const CAPABILITIES = new Set<AgentCapability>(['execute', 'review', 'coordinate']);
const PERMISSIONS = new Set(['readonly', 'confirm', 'auto']);

export class AgentValidationError extends Error {
  constructor(public status: number, message: string, public fieldErrors: Record<string, string> = {}) { super(message); }
}

export function inferCapabilities(id: string): AgentCapability[] {
  if (/review/i.test(id)) return ['review'];
  if (/plan|supervisor|manager|leader/i.test(id)) return ['coordinate', 'execute'];
  return ['execute'];
}

export function normalizeAgent(def: Partial<AgentDefinition> & Pick<AgentDefinition, 'id' | 'name' | 'systemPrompt' | 'model' | 'tools' | 'disallowedTools' | 'permissionMode' | 'color' | 'source'>): AgentDefinition {
  return { ...def, description: def.description ?? '', capabilities: def.capabilities?.length ? def.capabilities : inferCapabilities(def.id), enabled: def.enabled ?? true, version: def.version ?? 1, syncError: def.syncError ?? null };
}

export function validateAgentInput(value: unknown): AgentInput {
  const input = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const text = (key: string) => typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  const strings = (key: string) => Array.isArray(input[key]) ? [...new Set((input[key] as unknown[]).filter((item): item is string => typeof item === 'string'))] : [];
  const id = text('id'); const name = text('name'); const description = text('description');
  const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt.trim() : '';
  const model = text('model'); const tools = strings('tools'); const disallowedTools = strings('disallowedTools');
  const capabilities = strings('capabilities') as AgentCapability[];
  const permissionMode = text('permissionMode') as AgentInput['permissionMode']; const color = text('color');
  const errors: Record<string, string> = {};
  if (!ID_RE.test(id)) errors.id = '需以小写字母开头，只能包含小写字母、数字和连字符，共 2–48 位'; else if (RESERVED.has(id)) errors.id = '该 ID 为系统保留字';
  if (!name || name.length > 40) errors.name = '名称必填且不超过 40 个字符';
  if (!description || description.length > 300) errors.description = '描述必填且不超过 300 个字符';
  if (!systemPrompt || systemPrompt.length > 20_000) errors.systemPrompt = '系统提示词必填且不超过 20000 个字符';
  if (model.length > 200 || !/^(mock|openai|anthropic):[^\s]+$/.test(model)) errors.model = '模型需使用 mock:、openai: 或 anthropic: 前缀';
  if (!PERMISSIONS.has(permissionMode)) errors.permissionMode = '权限模式无效';
  if (!COLOR_RE.test(color)) errors.color = '颜色需为 #RRGGBB';
  if (capabilities.length === 0 || capabilities.some((item) => !CAPABILITIES.has(item))) errors.capabilities = '至少选择一项有效能力';
  const knownTools = new Set(listToolNames());
  if ([...tools, ...disallowedTools].some((item) => !knownTools.has(item))) errors.tools = '包含未知工具';
  if (tools.some((item) => disallowedTools.includes(item))) errors.disallowedTools = '允许与禁用工具不能重复';
  if (Object.keys(errors).length) throw new AgentValidationError(400, '角色配置校验失败', errors);
  return { id, name, description, capabilities, systemPrompt, model, tools, disallowedTools, permissionMode, color };
}
