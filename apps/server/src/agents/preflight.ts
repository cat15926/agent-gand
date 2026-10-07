import type { AgentInput, AgentPreflight } from '@agent-gand/shared';
import { assertAccountCompatibility, currentBinding, resolveAccount } from '../accounts/resolver.ts';
import { AccountError } from '../accounts/errors.ts';
import { verifyIdentity } from '../accounts/native.ts';
import { detectDriver } from '../execution/drivers.ts';
import { READ_TOOLS } from '../execution/policy.ts';
import { redactSecrets } from '../accounts/secrets.ts';
import { listToolNames } from '../tools/builtin/index.ts';
import { READONLY_TOOLS } from '../tools/types.ts';
import { ExecutionError } from '../execution/errors.ts';

/** No inference, credential paths or secret material in this public preview. */
export async function preflightAgent(agent: AgentInput): Promise<AgentPreflight> {
  const external = agent.execution?.kind === 'external' ? agent.execution : null;
  const readonlyCli = external && ['claude-cli', 'codex-exec'].includes(external.driver);
  const catalog = external ? external.platformTools ?? [] : listToolNames();
  const availableTools = catalog.filter((tool) => !agent.disallowedTools.includes(tool) && (agent.permissionMode === 'readonly' ? READONLY_TOOLS.has(tool) : agent.permissionMode === 'auto' ? agent.tools.includes(tool) : true));
  const exemptTools = availableTools.filter((tool) => agent.permissionMode !== 'auto' && READONLY_TOOLS.has(tool) || agent.tools.includes(tool));
  const nativeExempt = !external ? [] : external.driver.startsWith('codex') ? ['沙箱内安全命令'] : agent.permissionMode === 'readonly' || readonlyCli ? [...READ_TOOLS] : agent.permissionMode === 'confirm' ? [...new Set([...READ_TOOLS, ...(external.nativeTools ?? [])])] : [...(external.nativeTools ?? [])];
  const result: AgentPreflight = { ok: true, issues: {}, testedModel: false, permissions: {
    summary: agent.permissionMode === 'readonly' ? '只读分析；禁止写入和有副作用的命令' : agent.permissionMode === 'confirm' ? '写入需确认；允许的读工具无需逐次审批' : '仅勾选的白名单工具自动执行',
    nativeTools: nativeExempt,
    platformTools: availableTools, allowedTools: exemptTools, deniedTools: [...agent.disallowedTools],
    session: external?.sessionPolicy === 'conversation' ? '同一聊天室复用' : external?.sessionPolicy === 'run' ? '同一运行复用' : '每回合新会话',
    limits: external ? ['文件访问受工作区范围限制；明确禁用工具优先'] : ['工具仍受工作区范围与审批策略约束'],
  } };
  if (readonlyCli) result.permissions.limits.push('仅支持顺序流水线中的只读分析');
  if (external && !readonlyCli) result.permissions.limits.push('聊天室的 Runtime 协作控制工具由平台自动提供');
  if (external?.driver === 'codex-app-server' && agent.accountRef && !agent.accountRef.startsWith('legacy-')) result.permissions.limits.push('托管 Codex 拒绝沙箱外命令审批；工作区文件修改可审批');
  if (external?.driver === 'claude-sdk' && agent.permissionMode === 'confirm') result.permissions.limits.push('Read / Grep / Glob 免审；其他未勾选工具逐次确认');
  try {
    assertAccountCompatibility(agent);
    const binding = currentBinding(agent); const account = resolveAccount(agent);
    // Saving verifies the local identity, not the availability of OAuth servers.
    // Launch and explicit account checks still refresh tokens before use.
    if (binding?.identityGeneration) await verifyIdentity(binding.accountId, binding.identityGeneration, undefined, { refreshToken: false });
    if (!agent.model.startsWith('mock:') && ((!external && !account?.apiKey) || (account?.authType === 'api_key' && !account.apiKey))) throw new AccountError(409, '缺少可用的模型密钥', { accountRef: '请配置账户认证' });
  } catch (error) {
    result.issues = error instanceof AccountError && Object.keys(error.fieldErrors).length ? error.fieldErrors : { accountRef: error instanceof ExecutionError && error.code === 'timeout' ? '本地登录状态检查超时，请重新检查。已保存的登录身份未被清除。' : redactSecrets(error instanceof Error ? error.message : '账户不可用') };
  }
  if (external) {
    const driver = await detectDriver(external.driver);
    if (!driver.available) result.issues.execution = driver.error ?? '请安装受支持的客户端版本';
  }
  result.ok = !Object.keys(result.issues).length;
  return result;
}
