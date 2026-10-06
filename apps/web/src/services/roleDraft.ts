import type { AgentExecutionConfig, AgentInput } from '@agent-gand/shared';
import { productBackends, type AgentConnection, type AgentProduct } from './agentConnection';

export type RolePolicy = Pick<AgentInput, 'execution' | 'permissionMode' | 'tools' | 'disallowedTools' | 'capabilities'>;
export type ConnectionDraft = { connection: AgentConnection; policy: RolePolicy };
export type RoleDraft = { form: AgentInput; connection: AgentConnection; step: number; idEdited: boolean; connections: Partial<Record<AgentProduct, ConnectionDraft>>; version: number | null; pendingAvatarName?: string };
const products: AgentProduct[] = ['api', 'claude', 'codex', 'demo'];
const backends = ['builtin-anthropic', 'builtin-openai', 'claude-sdk', 'claude-cli', 'codex-app-server', 'codex-exec'];
const drivers = ['claude-sdk', 'claude-cli', 'codex-app-server', 'codex-exec'];
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function execution(value: unknown): AgentExecutionConfig | null {
  if (!record(value)) return null;
  if (value.kind === 'builtin-llm') return { kind: 'builtin-llm' };
  if (value.kind !== 'external' || typeof value.driver !== 'string' || !drivers.includes(value.driver)
    || (value.nativeTools !== undefined && !strings(value.nativeTools)) || (value.platformTools !== undefined && !strings(value.platformTools))
    || (value.sessionPolicy !== undefined && !['turn', 'run', 'conversation'].includes(value.sessionPolicy as string))) return null;
  return { kind: 'external', driver: value.driver, ...(value.nativeTools !== undefined ? { nativeTools: value.nativeTools } : {}),
    ...(value.platformTools !== undefined ? { platformTools: value.platformTools } : {}), ...(value.sessionPolicy !== undefined ? { sessionPolicy: value.sessionPolicy } : {}) } as AgentExecutionConfig;
}
function policy(value: unknown): RolePolicy | null {
  if (!record(value) || !strings(value.capabilities) || !value.capabilities.every((cap) => ['execute', 'review', 'coordinate'].includes(cap))
    || !strings(value.tools) || !strings(value.disallowedTools) || !['readonly', 'confirm', 'auto'].includes(value.permissionMode as string)) return null;
  const parsedExecution = value.execution === undefined ? undefined : execution(value.execution);
  if (parsedExecution === null) return null;
  return { capabilities: value.capabilities, tools: value.tools, disallowedTools: value.disallowedTools,
    permissionMode: value.permissionMode, ...(parsedExecution ? { execution: parsedExecution } : {}) } as RolePolicy;
}
function input(value: unknown): AgentInput | null {
  if (!record(value) || !['id', 'name', 'description', 'systemPrompt', 'model', 'color', 'avatar'].every((key) => typeof value[key] === 'string')
    || (value.accountRef !== undefined && typeof value.accountRef !== 'string') || (value.requiresAccount !== undefined && typeof value.requiresAccount !== 'boolean')) return null;
  const parsedPolicy = policy(value); if (!parsedPolicy) return null;
  return { id: value.id, name: value.name, description: value.description, systemPrompt: value.systemPrompt, model: value.model, color: value.color, avatar: value.avatar,
    ...parsedPolicy, ...(value.accountRef !== undefined ? { accountRef: value.accountRef } : {}), ...(value.requiresAccount !== undefined ? { requiresAccount: value.requiresAccount } : {}) } as AgentInput;
}
function connection(value: unknown): AgentConnection | null {
  if (!record(value) || !products.includes(value.product as AgentProduct) || !backends.includes(value.backend as string)
    || typeof value.accountId !== 'string' || typeof value.model !== 'string' || typeof value.implicit !== 'boolean') return null;
  if (value.product !== 'demo' && !productBackends(value.product as AgentProduct).includes(value.backend as AgentConnection['backend'])) return null;
  return { product: value.product, backend: value.backend, accountId: value.accountId, model: value.model, implicit: value.implicit } as AgentConnection;
}

/** Restore incomplete user input, but never pass malformed storage values to the form. */
export function readRoleDraft(key: string, version: number | null): RoleDraft | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (!record(value) || value.version !== version || !Number.isInteger(value.step) || (value.step as number) < 0 || (value.step as number) > 2 || typeof value.idEdited !== 'boolean') return null;
    const parsedInput = input(value.form), parsedConnection = connection(value.connection); if (!parsedInput || !parsedConnection) return null;
    const connections: RoleDraft['connections'] = {};
    if (record(value.connections)) for (const product of products) {
      const cached = value.connections[product]; if (!record(cached)) continue;
      const cachedConnection = connection(cached.connection), cachedPolicy = policy(cached.policy);
      if (cachedConnection?.product === product && cachedPolicy) connections[product] = { connection: cachedConnection, policy: cachedPolicy };
    }
    return { form: parsedInput, connection: parsedConnection, connections, version, step: value.step as number, idEdited: value.idEdited,
      ...(typeof value.pendingAvatarName === 'string' ? { pendingAvatarName: value.pendingAvatarName } : {}) };
  } catch { return null; }
}
