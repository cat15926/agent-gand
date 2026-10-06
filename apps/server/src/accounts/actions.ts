import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AccountBackend, AccountTestResult } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { emit } from '../messaging/bus.ts';
import { finishRun, getRun } from '../runs/trace.ts';
import { commitRunTerminal } from '../runtime/terminal.ts';
import { cancelCollaborationRun } from '../collaboration/store.ts';
import { closeCollaborationTrace } from '../collaboration/scheduler.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { cancelCoordinationRun } from '../coordination/runtime.ts';
import { stopExternalRun } from '../execution/runner.ts';
import { getDriver } from '../execution/drivers.ts';
import { ExecutionError } from '../execution/errors.ts';
import { registerNativeProcess, markNativeProcessStopped, quiesceNativeProcesses } from '../execution/host.ts';
import { resolveProvider } from '../llm/router.ts';
import { AccountError } from './errors.ts';
import { currentBinding, resolveAccount } from './resolver.ts';
import { changed, getAccount, references } from './store.ts';
import { assertFields, expectedVersion, object } from './validation.ts';
import { privateDirectory, assertNoUnsettledAccountProcess } from './native.ts';
import { redactSecrets } from './secrets.ts';
import { cancelLogin } from './login.ts';

const tests = new Map<string, { controller: AbortController; done: Promise<void> }>();
export async function testAccount(id: string, value: unknown): Promise<AccountTestResult> {
  const input = object(value); assertFields(input, ['expectedVersion', 'backend', 'model']);
  const account = getAccount(id);
  if (account.source !== 'managed') throw new AccountError(400, '请先创建托管连接，再测试实际调用');
  if (account.version !== expectedVersion(input.expectedVersion)) throw new AccountError(409, '账户已修改，请刷新后重试');
  if (!account.compatibleBackends.includes(input.backend as AccountBackend)) throw new AccountError(400, '测试接入方式与账户不兼容');
  const backend = input.backend as AccountBackend;
  const model = typeof input.model === 'string' ? input.model.trim() : account.connection.defaultModel ?? 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(model) || (model === 'default' && account.authType === 'api_key')) throw new AccountError(400, '请填写用于测试的原生模型 ID');
  assertNoUnsettledAccountProcess(id);
  if (tests.has(id)) throw new AccountError(409, '该账户已有模型测试');
  const builtin = backend.startsWith('builtin-');
  const agent = { id: 'account-test', accountRef: id, model: builtin ? `${backend === 'builtin-anthropic' ? 'anthropic' : 'openai'}:${model}` : model,
    ...(builtin ? {} : { execution: { kind: 'external' as const, driver: backend as 'claude-sdk' | 'claude-cli' | 'codex-app-server' | 'codex-exec' } }) };
  const binding = currentBinding(agent)!; const resolved = resolveAccount(agent)!;
  const operationId = randomUUID(); const testedAt = new Date().toISOString(); const controller = new AbortController(); let finished!: () => void; const done = new Promise<void>((resolve) => { finished = resolve; }); tests.set(id, { controller, done });
  let timedOut = false;
  const deadline = Date.now() + resolved.connection.timeoutMs;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, resolved.connection.timeoutMs);
  try {
  const result: AccountTestResult = { backend, model, status: 'passed', configVersion: binding.configVersion, credentialVersion: binding.credentialVersion, identityGeneration: binding.identityGeneration, testedAt, error: null };
  run("INSERT INTO account_checks (id,account_id,backend,model,config_version,credential_version,identity_generation,status,tested_at) VALUES (?,?,?,?,?,?,?,'running',?)", operationId, id, backend, model, binding.configVersion, binding.credentialVersion, binding.identityGeneration, testedAt);
  try {
    if (builtin) {
      const response = await resolveProvider(agent.model, resolved).chat({ model: agent.model, messages: [{ role: 'user', content: 'Reply only OK. Do not use tools.' }], maxTokens: 512, connectionTest: true, signal: controller.signal });
      if (!response.content.trim() || response.toolCalls.length) throw new Error('测试未返回无工具的文本响应');
    } else {
      const cwd = await privateDirectory(path.join(path.dirname(resolved.runtimeHome!), 'tests', operationId));
      const driver = getDriver(agent.execution!.driver); const info = await driver.detect();
      if (!info.available) throw new Error(info.error ?? '原生客户端不可用');
      let tool = false;
      const content = await driver.invoke({ account: resolved, cwd, model, instructions: 'This is a connection test. No tools, no filesystem access, no external side effects. Reply only OK.', prompt: 'Reply only OK.', signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()), permissionMode: 'readonly', controlOnly: true, connectionTest: true, onEvent: (event) => { if (event.type === 'tool.started') tool = true; },
        onProcess: (owner) => registerNativeProcess('test:' + operationId, owner), onProcessStopped: markNativeProcessStopped });
      if (tool || !content.trim()) throw new Error('测试未返回无工具的文本响应');
    }
  } catch (error) { result.status = 'failed'; result.error = timedOut || (error instanceof ExecutionError && error.code === 'timeout')
    ? `模型连接测试在 ${resolved.connection.timeoutMs / 1000} 秒内未完成，请检查服务响应或调大账户的请求超时。`
    : redactSecrets(error instanceof Error ? error.message : '连接测试失败').slice(0, 240); }

  run('UPDATE account_checks SET status=?,error=? WHERE id=?', result.status, result.error, operationId);
  const current = getAccount(id);
  if (current.configVersion !== result.configVersion || current.credentialVersion !== result.credentialVersion || (current.identityGeneration ?? null) !== result.identityGeneration) result.status = 'stale';
  changed(id, current.version);
  return result;
  } finally { clearTimeout(timer); tests.delete(id); finished(); }
}
export async function revokeAccount(id: string, value: unknown): Promise<{ cancelledRunIds: string[] }> {
  const input = object(value); assertFields(input, ['expectedVersion']);
  const account = getAccount(id);
  if (account.source !== 'managed' || account.archived) throw new AccountError(400, '只能撤销未归档的托管账户');
  if (account.version !== expectedVersion(input.expectedVersion)) throw new AccountError(409, '账户已修改，请刷新后重试');
  const refs = references(id);
  tx(() => {
    run('INSERT OR IGNORE INTO account_revocations (account_id,revoked_at) VALUES (?,?)', id, new Date().toISOString());
    run('UPDATE accounts SET enabled=0,version=version+1,updated_at=? WHERE id=?', new Date().toISOString(), id);
    changed(id, account.version + 1);
  });
  emit({ type: 'account.revoked', accountId: id }); tests.get(id)?.controller.abort();
  for (const row of all<{ id: string; owner_session: string }>("SELECT * FROM account_login_operations WHERE account_id=? AND status IN ('starting','pending')", id)) await cancelLogin(row.id, row.owner_session);
  for (const item of refs.activeRuns) {
    if (getRunCoordinationPlan(item.id)) cancelCoordinationRun(item.id);
    else if (getRun(item.id)?.mode === 'collaboration') {
      const result = commitRunTerminal({ runId: item.id, status: 'cancelled', disposition: 'cancelled', source: 'account_revoked', userMessageStatus: 'failed', closeExecution: () => cancelCollaborationRun(item.id), prepare: () => ({ reasonCodes: ['ACCOUNT_REVOKED'] }) });
      if (result.committed) closeCollaborationTrace(item.id, 'cancelled');
    } else finishRun(item.id, 'cancelled');
  }
  await Promise.all(refs.activeRuns.map((item) => stopExternalRun(item.id)));
  return { cancelledRunIds: refs.activeRuns.map((item) => item.id) };
}
export async function recoverAccountTests(): Promise<void> {
  for (const row of all<{ id: string }>("SELECT id FROM account_checks WHERE status='running'")) {
    const safe = await quiesceNativeProcesses('test:' + row.id); run("UPDATE account_checks SET status='failed',error=? WHERE id=?", safe ? '服务重启，测试已停止；未重放模型请求' : '旧测试进程状态无法验证，账户暂不可测试或删除，请由管理员处理', row.id);
  }
}
export async function shutdownAccountTests(): Promise<void> { const entries = [...tests.values()]; for (const entry of entries) entry.controller.abort(); await Promise.allSettled(entries.map((entry) => entry.done)); }
