import type { AccountBackend, AccountView, AgentDefinition, AgentInput, ExternalDriverId } from '@agent-gand/shared';

export type AgentProduct = 'api' | 'claude' | 'codex' | 'demo';
export const productNames: Record<AgentProduct, string> = { api: '模型 API', claude: 'Claude Code', codex: 'Codex', demo: '演示' };
export const authNames: Record<AccountView['authentication'], string> = { configured: '密钥已设置', missing: '未设置密钥', locked: '密钥已锁定', unchecked: '认证未检测', pending: '待登录', authenticated: '已登录', expired: '登录已失效' };
export interface AgentConnection { product: AgentProduct; accountId: string; backend: AccountBackend; model: string; implicit: boolean }
export function productFor(agent: Pick<AgentInput, 'execution' | 'model'>): AgentProduct {
  if (agent.execution?.kind === 'external') return agent.execution.driver.startsWith('claude') ? 'claude' : 'codex';
  return agent.model.startsWith('mock:') ? 'demo' : 'api';
}
export function backendFor(agent: Pick<AgentInput, 'execution' | 'model'>): AccountBackend {
  return agent.execution?.kind === 'external' ? agent.execution.driver : agent.model.startsWith('anthropic:') ? 'builtin-anthropic' : 'builtin-openai';
}
export function implicitAccountId(agent: Pick<AgentInput, 'execution' | 'model'>): string {
  const backend = backendFor(agent);
  return ({ 'builtin-anthropic': 'legacy-llm-anthropic', 'builtin-openai': 'legacy-llm-openai', 'claude-sdk': 'legacy-claude-sdk', 'claude-cli': 'legacy-claude-cli', 'codex-app-server': 'legacy-codex-native', 'codex-exec': 'legacy-codex-native' })[backend];
}
export function nativeModel(agent: Pick<AgentInput, 'execution' | 'model'>): string { return agent.execution?.kind === 'external' ? agent.model : agent.model.replace(/^(openai|anthropic|mock):/, ''); }
export function initialConnection(agent: AgentInput): AgentConnection {
  const product = productFor(agent);
  return { product, backend: backendFor(agent), model: nativeModel(agent), accountId: agent.accountRef ?? (product === 'demo' || agent.requiresAccount ? '' : implicitAccountId(agent)), implicit: !agent.accountRef && !agent.requiresAccount && product !== 'demo' };
}
export function productBackends(product: AgentProduct): AccountBackend[] {
  return product === 'api' ? ['builtin-anthropic', 'builtin-openai'] : product === 'claude' ? ['claude-sdk', 'claude-cli'] : product === 'codex' ? ['codex-app-server', 'codex-exec'] : [];
}
export function compatibleAccount(account: AccountView, product: AgentProduct): boolean { return productBackends(product).some((backend) => account.compatibleBackends.includes(backend)); }
export function unavailableAccount(account: AccountView): string | null {
  return account.revoked ? '已撤销' : account.archived ? '已归档' : !account.enabled ? '已停用' : !['configured', 'authenticated'].includes(account.authentication) ? authNames[account.authentication] : null;
}
export function selectAccount(connection: AgentConnection, account: AccountView): AgentConnection {
  const backends = productBackends(connection.product).filter((backend) => account.compatibleBackends.includes(backend));
  const backend = backends.includes(connection.backend) ? connection.backend : backends[0] ?? connection.backend;
  return { ...connection, accountId: account.id, implicit: false, backend, model: account.connection.defaultModel ?? account.connection.models[0] ?? (account.authType === 'native_login' ? 'default' : '') };
}
export function compileConnection(form: AgentInput, connection: AgentConnection): AgentInput {
  const external = connection.product === 'claude' || connection.product === 'codex';
  const readonlyCli = external && ['claude-cli', 'codex-exec'].includes(connection.backend);
  const oldExecution = form.execution?.kind === 'external' && form.execution.driver === connection.backend ? form.execution : null;
  const permissionMode = readonlyCli ? 'readonly' : connection.backend === 'codex-app-server' && form.permissionMode === 'auto' ? 'confirm' : form.permissionMode;
  return { ...form, model: external ? connection.model : `${connection.product === 'demo' ? 'mock' : connection.backend === 'builtin-anthropic' ? 'anthropic' : 'openai'}:${connection.model}`,
    accountRef: connection.product === 'demo' || connection.implicit ? undefined : connection.accountId || undefined,
    requiresAccount: connection.product === 'demo' || connection.implicit ? undefined : true,
    execution: external ? { kind: 'external', driver: connection.backend as ExternalDriverId, sessionPolicy: readonlyCli ? 'turn' : oldExecution ? oldExecution.sessionPolicy : 'run',
      ...(connection.backend === 'claude-sdk' && permissionMode !== 'readonly' ? { nativeTools: oldExecution?.nativeTools ?? [] } : {}), ...(readonlyCli ? {} : { platformTools: oldExecution?.platformTools ?? [] }) } : { kind: 'builtin-llm' },
    permissionMode, capabilities: external ? form.capabilities.filter((cap) => cap !== 'coordinate').length ? form.capabilities.filter((cap) => cap !== 'coordinate') : ['execute'] : form.capabilities,
    tools: external ? readonlyCli ? [] : form.tools.filter((tool) => oldExecution?.platformTools?.includes(tool)) : form.tools,
    disallowedTools: external ? readonlyCli ? [] : form.disallowedTools.filter((tool) => oldExecution?.platformTools?.includes(tool)) : form.disallowedTools };
}
export function scopedTest(account: AccountView, backend: AccountBackend, model: string): string {
  if (!account.lastTest || account.lastTest.backend !== backend || account.lastTest.model !== model) return '该方式与模型未测试';
  return ({ untested: '该方式与模型未测试', passed: '模型测试通过', failed: '模型测试失败', stale: '测试已过期' })[account.testStatus];
}
export function roleConnection(agent: AgentDefinition, accounts: AccountView[]): { label: string; status: string; warning: boolean } {
  const product = productFor(agent);
  if (product === 'demo') return { label: '演示 · 无外部账户', status: '本地预设动作', warning: false };
  if (agent.requiresAccount && !agent.accountRef) return { label: `${productNames[product]} · 尚未选择账户`, status: '请选择账户后启用', warning: true };
  const account = accounts.find((item) => item.id === (agent.accountRef ?? implicitAccountId(agent)));
  if (!account) return { label: `${productNames[product]} · ${agent.accountRef ? '账户不可见或已删除' : '旧配置'}`, status: '请检查连接', warning: true };
  const incompatible = !account.compatibleBackends.includes(backendFor(agent)); const unavailable = unavailableAccount(account);
  return { label: `${productNames[product]} · ${account.displayName}`, status: incompatible ? '接入方式不兼容' : unavailable ?? `${authNames[account.authentication]} · ${scopedTest(account, backendFor(agent), nativeModel(agent))}`, warning: incompatible || !!unavailable };
}
