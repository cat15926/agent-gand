import type { AgentCapability, AgentDefinition, AgentExecutionConfig, AgentInput } from '@agent-gand/shared';
import { listToolNames } from '../tools/builtin/index.ts';
import { bidirectional, SDK_TOOLS } from '../execution/policy.ts';
import { assertAccountCompatibility } from '../accounts/resolver.ts';

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

export function parseExecution(value: unknown): AgentExecutionConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentValidationError(400, '执行配置无效', { execution: '执行配置必须为对象' });
  const fields = value as Record<string, unknown>;
  if (fields.kind === 'builtin-llm' && Object.keys(fields).every((key) => key === 'kind')) return { kind: 'builtin-llm' };
  if (fields.kind === 'external' && ['claude-cli', 'codex-exec', 'claude-sdk', 'codex-app-server'].includes(String(fields.driver))
    && Object.keys(fields).every((key) => ['kind', 'driver', 'nativeTools', 'platformTools', 'sessionPolicy'].includes(key))) {
    if (fields.sessionPolicy !== undefined && !['turn', 'run', 'conversation'].includes(String(fields.sessionPolicy))) throw new AgentValidationError(400, '外部会话策略无效');
    if (fields.nativeTools !== undefined && (!Array.isArray(fields.nativeTools) || fields.nativeTools.some((tool) => typeof tool !== 'string' || !SDK_TOOLS.includes(tool)))) throw new AgentValidationError(400, '原生工具白名单无效');
    if (fields.platformTools !== undefined && (!Array.isArray(fields.platformTools) || fields.platformTools.some((tool) => typeof tool !== 'string' || !listToolNames().includes(tool)))) throw new AgentValidationError(400, '平台工具开放列表无效');
    return { kind: 'external', driver: fields.driver as Extract<AgentExecutionConfig, { kind: 'external' }>['driver'], ...(fields.nativeTools !== undefined ? { nativeTools: [...new Set(fields.nativeTools as string[])] } : {}), ...(fields.platformTools !== undefined ? { platformTools: [...new Set(fields.platformTools as string[])] } : {}), ...(fields.sessionPolicy !== undefined ? { sessionPolicy: fields.sessionPolicy as 'turn' | 'run' | 'conversation' } : {}) };
  }
  throw new AgentValidationError(400, '执行配置无效', { execution: '仅支持已注册外部 Driver，不接受自定义命令或参数' });
}

export function assertExternalPolicy(agent: Pick<AgentInput, 'execution' | 'model' | 'permissionMode' | 'tools' | 'disallowedTools' | 'capabilities'>): void {
  if (agent.execution?.kind !== 'external') return;
  if (agent.model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(agent.model)) throw new AgentValidationError(400, '原生模型名无效', { model: '填写 CLI 原生模型名或 default' });
  if (bidirectional(agent.execution.driver)) {
    if (agent.capabilities.includes('coordinate')) throw new AgentValidationError(400, '外部后端不能担当内置主管或智能规划器');
    if ([...agent.tools, ...agent.disallowedTools].some((name) => !agent.execution?.kind || agent.execution.kind !== 'external' || !agent.execution.platformTools?.includes(name))) throw new AgentValidationError(400, '平台工具策略只能引用 execution.platformTools 中显式开放的工具');
    if (agent.execution.driver === 'codex-app-server' && (agent.permissionMode === 'auto' || agent.execution.nativeTools?.length)) throw new AgentValidationError(400, 'Codex app-server 仅支持 readonly/confirm，不支持工具白名单或 auto');
    if (agent.permissionMode === 'readonly' && agent.execution.nativeTools?.length) throw new AgentValidationError(400, 'readonly 原生工具由后端固定提供');
    return;
  }
  if (agent.permissionMode !== 'readonly' || agent.tools.length || agent.disallowedTools.length || agent.capabilities.includes('coordinate') || agent.execution.nativeTools?.length || agent.execution.platformTools?.length || (agent.execution.sessionPolicy && agent.execution.sessionPolicy !== 'turn')) {
    throw new AgentValidationError(400, '外部 Agent 阶段 A 仅支持只读分析', { execution: '须使用 readonly、清空平台工具配置且不选择协调能力；原生只读工具由 Driver 固定提供' });
  }
}

export function normalizeAgent(def: Partial<AgentDefinition> & Pick<AgentDefinition, 'id' | 'name' | 'systemPrompt' | 'model' | 'tools' | 'disallowedTools' | 'permissionMode' | 'color' | 'source'>): AgentDefinition {
  return { ...def, avatar: def.avatar ?? '', description: def.description ?? '', capabilities: def.capabilities?.length ? def.capabilities : inferCapabilities(def.id), enabled: def.enabled ?? true, version: def.version ?? 1, syncError: def.syncError ?? null };
}

export function validateAgentInput(value: unknown, options: { allowUnavailableAccount?: boolean } = {}): AgentInput {
  const input = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const execution = parseExecution(input.execution);
  const text = (key: string) => typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  const strings = (key: string) => Array.isArray(input[key]) ? [...new Set((input[key] as unknown[]).filter((item): item is string => typeof item === 'string'))] : [];
  const id = text('id'); const name = text('name'); const description = text('description');
  const systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt.trim() : '';
  const model = text('model'); const tools = strings('tools'); const disallowedTools = strings('disallowedTools');
  const accountRef = input.accountRef === undefined || input.accountRef === '' ? undefined : text('accountRef');
  const capabilities = strings('capabilities') as AgentCapability[];
  const permissionMode = text('permissionMode') as AgentInput['permissionMode']; const color = text('color'); const avatar = text('avatar');
  const localAvatar = /^\/api\/agent-avatars\/[0-9a-f-]+\.(?:png|jpg|webp|gif)$/i.test(avatar);
  const errors: Record<string, string> = {};
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') errors.enabled = '启用状态必须为布尔值';
  if (input.requiresAccount !== undefined && typeof input.requiresAccount !== 'boolean') errors.accountRef = '账户绑定要求必须为布尔值';
  if (input.accountRef !== undefined && input.accountRef !== '' && (!accountRef || accountRef.length > 100 || !/^[A-Za-z0-9-]+$/.test(accountRef))) errors.accountRef = '账户引用格式无效';
  if (!ID_RE.test(id)) errors.id = '需以小写字母开头，只能包含小写字母、数字和连字符，共 2–48 位'; else if (RESERVED.has(id)) errors.id = '该 ID 为系统保留字';
  if (!name || name.length > 40) errors.name = '名称必填且不超过 40 个字符';
  if (!description || description.length > 300) errors.description = '描述必填且不超过 300 个字符';
  if (!systemPrompt || systemPrompt.length > 20_000) errors.systemPrompt = '系统提示词必填且不超过 20000 个字符';
  if (execution?.kind === 'external') {
    if (model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(model)) errors.model = '填写外部 CLI 的原生模型名或 default';
  } else if (model.length > 200 || !/^(mock|openai|anthropic):[^\s]+$/.test(model)) errors.model = '模型需使用 mock:、openai: 或 anthropic: 前缀';
  if (!PERMISSIONS.has(permissionMode)) errors.permissionMode = '权限模式无效';
  if (!COLOR_RE.test(color)) errors.color = '颜色需为 #RRGGBB';
  if (avatar.length > 500) errors.avatar = '头像内容不能超过 500 个字符';
  else if (avatar.startsWith('/api/agent-avatars/') && !localAvatar) errors.avatar = '本地头像地址无效';
  else if (localAvatar) { /* 服务端上传生成的地址 */ }
  else if (avatar.includes('://') && !/^https:\/\/\S+$/i.test(avatar)) errors.avatar = '图片头像仅支持 HTTPS URL';
  else if (!avatar.includes('://') && Array.from(avatar).length > 8) errors.avatar = '文字头像不能超过 8 个字符';
  if (capabilities.length === 0 || capabilities.some((item) => !CAPABILITIES.has(item))) errors.capabilities = '至少选择一项有效能力';
  const knownTools = new Set(listToolNames());
  if ([...tools, ...disallowedTools].some((item) => !knownTools.has(item))) errors.tools = '包含未知工具';
  if (tools.some((item) => disallowedTools.includes(item))) errors.disallowedTools = '允许与禁用工具不能重复';
  if (Object.keys(errors).length) throw new AgentValidationError(400, '角色配置校验失败', errors);
  const result = { id, name, description, capabilities, systemPrompt, model, execution, ...(accountRef ? { accountRef } : {}), ...(input.requiresAccount === true ? { requiresAccount: true } : {}), tools, disallowedTools, permissionMode, color, avatar };
  assertExternalPolicy(result);
  if (!options.allowUnavailableAccount) assertAccountCompatibility(result);
  return result;
}
