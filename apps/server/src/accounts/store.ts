import { randomUUID } from 'node:crypto';
import type { AccountBackend, AccountCheck, AccountConnection, AccountProvider, AccountReferences, AccountView } from '@agent-gand/shared';
import { afterCommit, all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { compatibleBackends } from './compatibility.ts';
import { credentialSummary, writeCredential } from './credentials.ts';
import { AccountError } from './errors.ts';
import { implicitAccount, legacyAccounts } from './legacy.ts';
import { assertFields, expectedVersion, object, validateConnection, validateInput, validateKey, validateName } from './validation.ts';
import { identity, assertNoUnsettledAccountProcess } from './native.ts';

interface AccountRow {
  id: string; display_name: string; provider: AccountProvider; auth_type: 'api_key' | 'native_login'; source: 'managed';
  enabled: number; archived: number; version: number; config_version: number; credential_version: number | null; created_at: string; updated_at: string;
  identity_generation: number | null;
}
interface Definition { id?: string; name?: string; model?: string; accountRef?: string; requiresAccount?: boolean; execution?: { kind?: string; driver?: string } }
function matches(def: Definition, id: string): boolean { return def.accountRef === id || implicitAccount(def) === id; }
function connection(row: AccountRow): AccountConnection {
  const item = get<{ connection: string }>('SELECT connection FROM account_versions WHERE account_id=? AND version=?', row.id, row.config_version);
  if (!item) throw new AccountError(503, '账户连接版本缺失，请恢复备份');
  return JSON.parse(item.connection) as AccountConnection;
}
function view(row: AccountRow): AccountView {
  const config = connection(row);
  const native = identity(row.id, row.identity_generation);
  const nativeClient = row.auth_type === 'native_login' ? row.provider === 'anthropic' ? 'claude' : 'codex' : null;
  const check = get<{ backend: AccountBackend; model: string; tested_at: string; error: string | null; status: 'passed' | 'failed'; config_version: number; credential_version: number | null; identity_generation: number | null }>("SELECT * FROM account_checks WHERE account_id=? AND status<>'running' ORDER BY tested_at DESC,rowid DESC LIMIT 1", row.id);
  const testStatus = !check ? 'untested' : check.config_version !== row.config_version || check.credential_version !== row.credential_version || check.identity_generation !== row.identity_generation || (row.auth_type === 'native_login' && native?.status !== 'authenticated') ? 'stale' : check.status;
  return { id: row.id, displayName: row.display_name, provider: row.provider, authType: row.auth_type, source: row.source,
    enabled: row.enabled === 1, archived: row.archived === 1, version: row.version, configVersion: row.config_version, credentialVersion: row.credential_version,
    connection: config, ...(nativeClient ? { hasCredential: native?.status === 'authenticated', keySuffix: null, authentication: native?.status ?? 'pending' as const } : credentialSummary(row.id, row.credential_version)),
    testStatus, lastTest: check ? { backend: check.backend, model: check.model, status: testStatus as 'passed' | 'failed' | 'stale', configVersion: check.config_version, credentialVersion: check.credential_version, identityGeneration: check.identity_generation, testedAt: check.tested_at, error: check.error } : null, compatibleBackends: compatibleBackends(config, nativeClient),
    nativeClient, identityGeneration: row.identity_generation, identitySummary: native?.summary ?? null,
    revoked: !!get('SELECT account_id FROM account_revocations WHERE account_id=?', row.id), roleCount: references(row.id).roles.length, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function references(id: string): AccountReferences {
  const roles = all<{ id: string; name: string; enabled: number; definition: string }>('SELECT id,name,enabled,definition FROM agents')
    .filter((row) => matches(JSON.parse(row.definition) as Definition, id))
    .map((row) => ({ id: row.id, name: row.name, enabled: row.enabled === 1, implicit: !(JSON.parse(row.definition) as Definition).accountRef }));
  const runs = new Map<string, string>();
  for (const row of all<{ id: string; status: string }>('SELECT r.id,r.status FROM run_account_bindings b JOIN runs r ON r.id=b.run_id WHERE b.account_id=?', id)) runs.set(row.id, row.status);
  for (const row of all<{ id: string; status: string; definition: string }>('SELECT r.id,r.status,s.definition FROM run_agent_snapshots s JOIN runs r ON r.id=s.run_id')) {
    if (matches(JSON.parse(row.definition) as Definition, id)) runs.set(row.id, row.status);
  }
  for (const row of all<{ id: string; status: string; definition: string }>('SELECT r.id,r.status,s.definition FROM run_planner_snapshots s JOIN runs r ON r.id=s.run_id WHERE s.definition IS NOT NULL')) {
    if (matches(JSON.parse(row.definition) as Definition, id)) runs.set(row.id, row.status);
  }
  const terminal = ['completed', 'failed', 'cancelled'];
  const historicalRoleVersionCount = all<{ definition: string }>(
    'SELECT v.definition FROM agent_versions v LEFT JOIN agents a ON a.id=v.agent_id WHERE a.id IS NULL OR v.version<>a.version',
  ).filter((row) => matches(JSON.parse(row.definition) as Definition, id)).length;
  return { roles, activeRuns: [...runs].filter(([, status]) => !terminal.includes(status)).map(([id, status]) => ({ id, status })),
    historicalRunCount: [...runs.values()].filter((status) => terminal.includes(status)).length, historicalRoleVersionCount };
}
export function listAccounts(includeArchived = false): AccountView[] {
  const managed = all<AccountRow>(`SELECT * FROM accounts${includeArchived ? '' : ' WHERE archived=0'} ORDER BY created_at DESC,id`).map(view);
  return [...managed, ...legacyAccounts().map((item) => ({ ...item, roleCount: references(item.id).roles.length }))];
}
export function getAccount(id: string): AccountView {
  const row = get<AccountRow>('SELECT * FROM accounts WHERE id=?', id);
  if (row) return view(row);
  const legacy = legacyAccounts().find((item) => item.id === id);
  if (legacy) return { ...legacy, roleCount: references(id).roles.length };
  throw new AccountError(404, '账户不存在');
}
function mutable(id: string, version: unknown, allowRevoked = false): AccountRow {
  const account = getAccount(id);
  if (account.source !== 'managed') throw new AccountError(403, '旧配置为只读，请新增托管密钥');
  if (account.archived) throw new AccountError(409, '账户已归档');
  if (account.revoked && !allowRevoked) throw new AccountError(409, '账户已撤销，请创建新的连接');
  if (account.version !== expectedVersion(version)) throw new AccountError(409, '账户已被其他操作修改，请刷新后重试');
  return get<AccountRow>('SELECT * FROM accounts WHERE id=?', id)!;
}
export function changed(id: string, version: number, deleted = false): void {
  // Only invalidation identifiers cross the existing unauthenticated WS channel.
  afterCommit(() => emit({ type: 'account.updated', accountId: id, version, deleted }));
}
export function createAccount(value: unknown): AccountView {
  if (object(value).authType === 'native_login') return createNativeAccount(value);
  const input = validateInput(value); const id = randomUUID(); const now = new Date().toISOString();
  const { displayName, provider, apiKey, ...config } = input;
  tx(() => {
    writeCredential(id, 1, apiKey);
    run("INSERT INTO accounts (id,display_name,provider,auth_type,source,enabled,archived,version,config_version,credential_version,created_at,updated_at) VALUES (?,?,?,'api_key','managed',1,0,1,1,1,?,?)", id, displayName, provider, now, now);
    run('INSERT INTO account_versions (account_id,version,connection,created_at) VALUES (?,1,?,?)', id, JSON.stringify(config), now);
    changed(id, 1);
  });
  return getAccount(id);
}
function createNativeAccount(value: unknown): AccountView {
  const input = object(value); assertFields(input, ['displayName', 'authType', 'nativeClient']);
  if (!['claude', 'codex'].includes(String(input.nativeClient))) throw new AccountError(400, '请选择 Claude Code 或 Codex');
  const id = randomUUID(); const now = new Date().toISOString();
  tx(() => {
    run("INSERT INTO accounts (id,display_name,provider,auth_type,source,enabled,archived,version,config_version,credential_version,created_at,updated_at) VALUES (?,?,?,'native_login','managed',1,0,1,1,NULL,?,?)", id, validateName(input.displayName), input.nativeClient === 'claude' ? 'anthropic' : 'openai', now, now);
    run('INSERT INTO account_versions (account_id,version,connection,created_at) VALUES (?,1,?,?)', id, JSON.stringify({ baseUrl: '', protocols: [], models: [], defaultModel: null, timeoutMs: 180000 }), now);
    changed(id, 1);
  });
  return getAccount(id);
}
export function updateAccount(id: string, value: unknown): AccountView {
  const input = object(value);
  assertFields(input, ['expectedVersion', 'displayName', 'enabled', 'baseUrl', 'authHeader', 'protocols', 'models', 'defaultModel', 'timeoutMs']);
  tx(() => {
    const current = mutable(id, input.expectedVersion); const previous = connection(current);
    const displayName = input.displayName === undefined ? current.display_name : validateName(input.displayName);
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new AccountError(400, '启用状态必须为布尔值');
    if (current.auth_type === 'native_login' && Object.keys(input).some((key) => !['expectedVersion', 'displayName', 'enabled'].includes(key))) throw new AccountError(400, '登录账户只能修改名称与启用状态');
    const config = current.auth_type === 'native_login' ? previous : validateConnection({ ...previous, ...input }, current.provider);
    const configChanged = JSON.stringify(config) !== JSON.stringify(previous);
    const nextConfig = current.config_version + (configChanged ? 1 : 0); const now = new Date().toISOString();
    if (configChanged) run('INSERT INTO account_versions (account_id,version,connection,created_at) VALUES (?,?,?,?)', id, nextConfig, JSON.stringify(config), now);
    run('UPDATE accounts SET display_name=?,enabled=?,version=version+1,config_version=?,updated_at=? WHERE id=?', displayName, input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, nextConfig, now, id);
    changed(id, current.version + 1);
  });
  return getAccount(id);
}
export function replaceCredential(id: string, value: unknown): AccountView {
  const input = object(value); assertFields(input, ['expectedVersion', 'apiKey']); const key = validateKey(input.apiKey);
  tx(() => {
    const current = mutable(id, input.expectedVersion);
    if (current.auth_type !== 'api_key') throw new AccountError(400, '登录账户不能设置 API Key');
    const version = (get<{ version: number }>('SELECT MAX(version) version FROM account_credentials WHERE account_id=?', id)?.version ?? 0) + 1;
    writeCredential(id, version, key);
    run('UPDATE accounts SET credential_version=?,version=version+1,updated_at=? WHERE id=?', version, new Date().toISOString(), id);
    changed(id, current.version + 1);
  });
  return getAccount(id);
}
export function clearCredential(id: string, value: unknown): AccountView {
  const input = object(value); assertFields(input, ['expectedVersion']);
  tx(() => {
    const current = mutable(id, input.expectedVersion);
    if (current.auth_type !== 'api_key') throw new AccountError(400, '登录账户不能清除 API Key');
    // Retain immutable old versions for pinned runs. E2 owns retirement and immediate revocation.
    run('UPDATE accounts SET credential_version=NULL,version=version+1,updated_at=? WHERE id=?', new Date().toISOString(), id);
    changed(id, current.version + 1);
  });
  return getAccount(id);
}
export function deleteAccount(id: string, value: unknown): { archived: boolean } {
  const input = object(value); assertFields(input, ['expectedVersion']);
  return tx(() => {
    const current = mutable(id, input.expectedVersion, true); const refs = references(id);
    if (get("SELECT id FROM account_login_operations WHERE account_id=? AND status IN ('starting','pending')", id)) throw new AccountError(409, '请先取消正在进行的登录');
    if (get("SELECT id FROM account_checks WHERE account_id=? AND status='running'", id)) throw new AccountError(409, '请先等待模型测试结束');
    if (refs.roles.length || refs.activeRuns.length) throw new AccountError(409, '账户仍被角色或未完成的运行引用，请先解除引用');
    assertNoUnsettledAccountProcess(id);
    const archive = refs.historicalRunCount > 0 || refs.historicalRoleVersionCount > 0;
    if (archive) {
      run('UPDATE accounts SET enabled=0,archived=1,credential_version=NULL,identity_generation=NULL,version=version+1,updated_at=? WHERE id=?', new Date().toISOString(), id);
    } else {
      run('DELETE FROM account_versions WHERE account_id=?', id);
      run('DELETE FROM accounts WHERE id=?', id);
    }
    run('DELETE FROM account_credentials WHERE account_id=?', id);
    run("UPDATE account_native_identities SET status='expired' WHERE account_id=?", id);
    changed(id, current.version + 1, !archive);
    return { archived: archive };
  });
}
export function checkAccount(id: string): AccountCheck {
  const account = getAccount(id);
  if (account.authType === 'api_key') validateConnection(account.connection as unknown as Record<string, unknown>, account.provider);
  return { ok: account.enabled && !account.archived && !account.revoked && ['configured', 'authenticated'].includes(account.authentication), configuration: 'valid',
    authentication: account.authentication, testedModel: false, checkedAt: new Date().toISOString() };
}
