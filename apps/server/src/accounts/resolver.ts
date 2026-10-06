import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AccountBackend, AccountConnection, AgentDefinition, RunAccountBinding } from '@agent-gand/shared';
import { config } from '../config.ts';
import { all, get, run } from '../db/database.ts';
import { getAccount } from './store.ts';
import { readCredential } from './credentials.ts';
import { AccountError } from './errors.ts';
import { identity } from './native.ts';
import { compatibleBackends } from './compatibility.ts';
import { implicitAccount } from './legacy.ts';
import { rememberSecret } from './secrets.ts';
import { configuredPlanner } from './planner.ts';

export interface ResolvedAccount {
  binding: RunAccountBinding | null; managed: boolean; accountId: string;
  authType: 'api_key' | 'native_login'; connection: AccountConnection;
  apiKey: string | null; nativeClient: 'claude' | 'codex' | null; nativeDirectory: string | null;
  runtimeHome: string | null; cacheKey: string;
}
interface BindingRow { run_id: string; agent_id: string; account_id: string; config_version: number; credential_version: number | null; identity_generation: number | null; backend: AccountBackend; model: string }
const publicBinding = (row: BindingRow): RunAccountBinding => ({ runId: row.run_id, agentId: row.agent_id, accountId: row.account_id, configVersion: row.config_version, credentialVersion: row.credential_version, identityGeneration: row.identity_generation, backend: row.backend, model: row.model });
export function backendFor(agent: Pick<AgentDefinition, 'execution' | 'model'>): AccountBackend | null {
  return agent.execution?.kind === 'external' ? agent.execution.driver : agent.model.startsWith('anthropic:') ? 'builtin-anthropic' : agent.model.startsWith('openai:') ? 'builtin-openai' : null;
}
export function assertNotRevoked(id: string): void { if (get('SELECT account_id FROM account_revocations WHERE account_id=?', id)) throw new AccountError(409, '账户已立即撤销，请选择新账户'); }
export function assertAccountCompatibility(agent: Pick<AgentDefinition, 'accountRef' | 'requiresAccount' | 'execution' | 'model'>): void {
  if (agent.requiresAccount && !agent.accountRef) throw new AccountError(409, '此角色尚未选择账户，禁止回退到旧认证', { accountRef: '请显式选择账户或密钥' });
  if (!agent.accountRef) return;
  const account = getAccount(agent.accountRef); const backend = backendFor(agent);
  if (!backend || !account.compatibleBackends.includes(backend)) throw new AccountError(400, '账户协议或认证类型与角色接入方式不兼容', { accountRef: '请为该接入方式选择兼容账户' });
}
export function currentBinding(agent: Pick<AgentDefinition, 'id' | 'model' | 'execution' | 'accountRef' | 'requiresAccount'>, runId = ''): RunAccountBinding | null {
  if (agent.requiresAccount && !agent.accountRef) assertAccountCompatibility(agent);
  if (!agent.accountRef) return null; // Existing roles and old snapshots retain their original source.
  assertAccountCompatibility(agent); const account = getAccount(agent.accountRef);
  assertNotRevoked(account.id);
  if (!account.enabled || account.archived) throw new AccountError(409, `角色 ${agent.id} 的账户已停用或归档`, { accountRef: '修复账户后重试' });
  if (account.source !== 'managed') return null;
  if (!['configured', 'authenticated'].includes(account.authentication)) throw new AccountError(409, `角色 ${agent.id} 的账户缺少可用认证`, { accountRef: '请设置密钥或完成登录' });
  const model = agent.execution?.kind === 'external' && agent.model === 'default' ? account.connection.defaultModel ?? 'default' : agent.model;
  if (account.authType === 'api_key' && model === 'default') throw new AccountError(400, 'API Key 外部连接需要指定模型或账户推荐模型');
  return { runId, agentId: agent.id, accountId: account.id, configVersion: account.configVersion, credentialVersion: account.credentialVersion,
    identityGeneration: account.identityGeneration ?? null, backend: backendFor(agent)!, model };
}
export function freezeRunAccounts(runId: string, agents: AgentDefinition[]): void {
  for (const agent of agents) {
    const binding = currentBinding(agent, runId); if (!binding) continue;
    run('INSERT INTO run_account_bindings (run_id,agent_id,account_id,config_version,credential_version,identity_generation,backend,model) VALUES (?,?,?,?,?,?,?,?)', runId, agent.id, binding.accountId, binding.configVersion, binding.credentialVersion, binding.identityGeneration, binding.backend, binding.model);
  }
  const planner = configuredPlanner();
  run('INSERT INTO run_planner_snapshots (run_id,definition,created_at) VALUES (?,?,?)', runId, planner ? JSON.stringify(planner) : null, new Date().toISOString());
  // An unavailable optional planner must not block manual runs. Its captured connection cannot later switch to a new key.
  if (planner) {
    let binding: RunAccountBinding | null;
    try { binding = currentBinding(planner, runId); } catch (error) { if (error instanceof AccountError) return; throw error; }
    if (binding) run('INSERT INTO run_account_bindings (run_id,agent_id,account_id,config_version,credential_version,identity_generation,backend,model) VALUES (?,?,?,?,?,?,?,?)', runId, planner.id, binding.accountId, binding.configVersion, binding.credentialVersion, binding.identityGeneration, binding.backend, binding.model);
  }
}
export function listRunAccountBindings(runId: string): RunAccountBinding[] { return all<BindingRow>('SELECT * FROM run_account_bindings WHERE run_id=?', runId).map(publicBinding); }
export function resolveAccount(agent: Pick<AgentDefinition, 'id' | 'model' | 'execution' | 'accountRef' | 'requiresAccount'>, runId?: string): ResolvedAccount | null {
  if (agent.requiresAccount && !agent.accountRef) assertAccountCompatibility(agent);
  const pinned = runId ? get<BindingRow>('SELECT * FROM run_account_bindings WHERE run_id=? AND agent_id=?', runId, agent.id) : undefined;
  if (pinned && (pinned.account_id !== agent.accountRef || pinned.backend !== backendFor(agent))) throw new AccountError(409, '运行角色与冻结账户绑定不匹配，禁止回退或更换认证');
  const id = agent.accountRef ?? implicitAccount(agent); if (!id) return null;
  const account = getAccount(id); const managed = account.source === 'managed';
  let binding: RunAccountBinding | null = null;
  if (managed) {
    if (runId) {
      const row = pinned;
      if (!row || row.account_id !== id || row.backend !== backendFor(agent)) throw new AccountError(409, '运行缺少匹配的冻结账户绑定，禁止回退到全局认证');
      binding = publicBinding(row);
    } else binding = currentBinding(agent);
  } else if (agent.accountRef) assertAccountCompatibility(agent);
  assertNotRevoked(id);
  let connection = account.connection; let apiKey: string | null = null; let nativeDirectory: string | null = null;
  if (binding) {
    const saved = get<{ connection: string }>('SELECT connection FROM account_versions WHERE account_id=? AND version=?', id, binding.configVersion);
    if (!saved) throw new AccountError(503, '冻结的账户连接版本缺失');
    connection = JSON.parse(saved.connection) as AccountConnection;
    if (!compatibleBackends(connection, account.nativeClient).includes(binding.backend)) throw new AccountError(409, '冻结的账户协议不兼容');
    if (account.authType === 'api_key') {
      if (binding.credentialVersion === null) throw new AccountError(409, '冻结的密钥版本缺失');
      apiKey = readCredential(id, binding.credentialVersion);
    } else {
      const native = identity(id, binding.identityGeneration);
      if (!native || native.status !== 'authenticated') throw new AccountError(409, '冻结的登录身份已失效');
      nativeDirectory = native.directory;
    }
  } else {
    apiKey = id === 'legacy-llm-openai' ? config.llm.openaiApiKey : id === 'legacy-llm-anthropic' ? config.llm.anthropicApiKey : id === 'legacy-claude-sdk' ? process.env.ANTHROPIC_API_KEY ?? null : null;
    nativeDirectory = id === 'legacy-codex-native' ? config.externalAgents.codexHome : null;
  }
  rememberSecret(apiKey);
  const cacheKey = binding ? JSON.stringify([id, binding.configVersion, binding.credentialVersion, binding.identityGeneration]) : createHash('sha256').update(JSON.stringify([id, connection, apiKey, nativeDirectory])).digest('hex');
  const runtimeHome = managed && binding ? account.authType === 'native_login' ? path.join(nativeDirectory!, 'config') : path.join(config.accounts.privateDir, 'runtime', id, `${binding.configVersion}-${binding.credentialVersion}`, backendFor(agent)!) : null;
  return { binding, managed, accountId: id, authType: account.authType, connection, apiKey, nativeClient: account.nativeClient, nativeDirectory, runtimeHome, cacheKey };
}
