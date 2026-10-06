import { mkdirSync, realpathSync } from 'node:fs';
import type { ExternalAgentExecution, NativeAgentEvent, RunEvent } from '@agent-gand/shared';
import { assertExternalPolicy } from '../agents/validation.ts';
import { config } from '../config.ts';
import { emit, subscribe } from '../messaging/bus.ts';
import { endSpan, getRun, markSpanFirstToken, startSpan } from '../runs/trace.ts';
import { workspaceRootDir } from '../tools/builtin/index.ts';
import type { AgentTurnOptions, AgentTurnResult } from '../orchestration/agentStep.ts';
import { getDriver } from './drivers.ts';
import { diagnostic, ExecutionError } from './errors.ts';
import { createExecution, findExecution, getExecution, listExecutions, updateExecution } from './store.ts';
import { bidirectional } from './policy.ts';
import { expireExecutionApprovals, nativeApprovalGate } from './approvals.ts';
import { acquireWorkspace, waitForWorkspace, assertCodingWorkspace, captureEvidence } from './evidence.ts';
import { createExecutionBridge } from './bridge.ts';
import { assertBindingAuthorized, executionAuthorized } from './authority.ts';
import { loadResponsibilitySnapshot } from '../runtime/responsibilitySnapshot.ts';
import { loadRuntimeContract } from '../runtime/runPolicy.ts';
import { registerNativeProcess, markNativeProcessStopped } from './host.ts';
import { captureWorkspaceSnapshot, getIsolatedWorkspace } from '../workspaces/isolated.ts';
import { prepareNativeSession, SessionUnavailableError, type SessionHandle } from './sessions.ts';
import { resolveAccount, assertNotRevoked, type ResolvedAccount } from '../accounts/resolver.ts';
import { redactSecrets, redactSnapshot } from '../accounts/secrets.ts';

const active = new Map<string, { runId: string; controller: AbortController; done: Promise<AgentTurnResult> }>();
const terminal = (runId: string) => { const run = getRun(runId); return !run || ['completed', 'failed', 'cancelled'].includes(run.status); };

/** All terminal paths, including existing collaboration/coordination Stop, revoke native work. */
subscribe((event) => {
  if (event.type === 'run.updated' && ['completed', 'failed', 'cancelled'].includes(event.run.status)) {
    for (const [id, entry] of active) if (entry.runId === event.run.id) { expireExecutionApprovals(id); entry.controller.abort(); }
  }
  if (event.type === 'collaboration.attempt.updated' && event.attempt.status !== 'running') {
    for (const [id, entry] of active) if (getExecution(id)?.attemptId === event.attempt.id) { expireExecutionApprovals(id); entry.controller.abort(); }
  }
});

export async function stopExternalRun(runId: string, agentId?: string): Promise<void> {
  const entries = [...active.entries()].filter(([id, entry]) => entry.runId === runId && (!agentId || getExecution(id)?.agentId === agentId)).map(([, entry]) => entry);
  for (const entry of entries) entry.controller.abort();
  await Promise.allSettled(entries.map((entry) => entry.done));
}
export async function stopExternalAttempt(attemptId: string): Promise<void> {
  const entries = [...active.entries()].filter(([id]) => getExecution(id)?.attemptId === attemptId).map(([, entry]) => entry);
  for (const entry of entries) entry.controller.abort();
  await Promise.allSettled(entries.map(entry => entry.done));
}
export async function shutdownExternalAgents(): Promise<void> {
  const entries = [...active.values()];
  for (const entry of entries) entry.controller.abort();
  await Promise.allSettled(entries.map((entry) => entry.done));
}

function asResult(content: string, toolRounds: number): AgentTurnResult {
  return { content, toolRounds, emptyResponse: false, controlAction: null };
}

export async function runExternalAgentTurn(opts: AgentTurnOptions): Promise<AgentTurnResult> {
  assertExternalPolicy(opts.agent);
  if (opts.agent.execution?.kind !== 'external') throw new ExecutionError('policy_rejected', '缺少外部执行配置');
  const duplex = bidirectional(opts.agent.execution.driver);
  const coordination = opts.executionBinding?.origin === 'coordination_step_attempt';
  assertBindingAuthorized(opts.executionBinding);
  if (coordination && !duplex) throw new ExecutionError('policy_rejected', 'Coordination 步骤仅开放 Claude SDK 和 Codex app-server；只读 CLI 请使用流水线');
  const collaboration = duplex && !coordination && opts.run.mode === 'collaboration';
  if (!coordination && opts.run.mode !== 'pipeline' && !(duplex && opts.run.mode === 'supervisor' && opts.agent.id !== opts.run.supervisorId) && !collaboration) throw new ExecutionError('policy_rejected', '外部执行支持流水线；双向后端还支持内置主管 worker/reviewer 和自由协作');
  if ((opts.controlTools?.length || opts.reviewExit) && !collaboration) throw new ExecutionError('policy_rejected', '当前编排模式未开放 Runtime 控制');
  const responsibility = collaboration && opts.attemptId ? loadResponsibilitySnapshot({ runId: opts.run.id, attemptId: opts.attemptId }) : null;
  if (collaboration && (!responsibility || !opts.controlTools?.length || !opts.handleControlCalls)) throw new ExecutionError('policy_rejected', '自由协作缺少冻结的 Runtime 执行上下文');
  if (terminal(opts.run.id)) throw new ExecutionError('cancelled', '运行已终止');
  if (duplex && listExecutions(opts.run.id).some((execution) => execution.status === 'interrupted')) throw new ExecutionError('interrupted', '本 Run 存在状态不确定的原生执行；检查工作区实际变更后再创建新运行');
  const scopeId = opts.executionScopeId ?? `agent:${opts.agent.id}`;
  const existing = findExecution(opts.run.id, opts.agent.id, scopeId);
  if (existing) {
    const owned = active.get(existing.id);
    if (owned) return owned.done;
    if (existing.status === 'completed' && (!collaboration || existing.attemptId === opts.attemptId)
      && (!opts.executionBinding || existing.executionBinding?.id === opts.executionBinding.id)) return { ...asResult(existing.content, 0), workspaceSnapshot: existing.snapshot, controlAction: existing.controlAction ?? null, exitCorrectionAttempts: existing.exitCorrectionAttempts ?? 0 };
    throw new ExecutionError(existing.errorCode ?? 'interrupted', existing.error ?? '原生执行未完成，不自动重放；请创建新运行');
  }
  const root = workspaceRootDir({ runId: opts.run.id, workspace: opts.run.workspace, workspaceScope: coordination ? null : opts.workspaceScope, workspaceRoot: opts.nativeWorkspaceRoot ?? opts.workspaceRoot });
  // Only platform-managed empty workspaces may be created. Registered repo paths must exist.
  if (!opts.run.workspace?.startsWith('ext:')) mkdirSync(root, { recursive: true });
  const cwd = realpathSync(root);
  if (duplex && opts.agent.permissionMode !== 'readonly' && opts.displayKind !== 'review_protocol') {
    if (!opts.run.workspace?.startsWith('ext:')) throw new ExecutionError('policy_rejected', '阶段 B 写入须选择已注册的 Git 仓库工作区');
  }
  const account = resolveAccount(opts.agent, opts.run.id);
  const execution = createExecution({ runId: opts.run.id, agentId: opts.agent.id, scopeId, driver: opts.agent.execution.driver, agentVersion: opts.agent.version, cwd });
  execution.sourceCwd = getIsolatedWorkspace(opts.run.id)?.sourceRoot;
  updateExecution(execution.id, { sourceCwd: execution.sourceCwd });
  updateExecution(execution.id, { attemptId: opts.attemptId ?? null, executionBinding: opts.executionBinding, permissionMode: opts.displayKind === 'review_protocol' ? 'readonly' : opts.agent.permissionMode });
  execution.executionBinding = opts.executionBinding;
  execution.permissionMode = opts.displayKind === 'review_protocol' ? 'readonly' : opts.agent.permissionMode;
  execution.attemptId = opts.attemptId ?? null;
  if (responsibility) {
    execution.runtimeBinding = { subjectId: responsibility.subjectId, generation: responsibility.custody.generation, contractRevision: responsibility.contractRevision };
    updateExecution(execution.id, { runtimeBinding: execution.runtimeBinding });
  }
  const controller = new AbortController();
  const configuredTimeout = account?.managed ? account.connection.timeoutMs : config.externalAgents.timeoutMs;
  const timeoutMs = opts.executionBinding?.origin === 'coordination_step_attempt'
    ? Math.max(1, Math.min(configuredTimeout, new Date(opts.executionBinding.leaseExpiresAt).getTime() - Date.now())) : configuredTimeout;
  const timer = setTimeout(() => controller.abort(new ExecutionError('timeout', '外部 Agent 执行超时')), timeoutMs);
  const authorityTimer = setInterval(() => {
    if (!executionAuthorized(execution)) controller.abort(new ExecutionError('cancelled', '执行或责任代际已失效'));
    try { if (account?.managed) assertNotRevoked(account.accountId); } catch { controller.abort(new ExecutionError('cancelled', '账户已立即撤销')); }
  }, 100);
  const done = invokeTurn(opts, execution, controller.signal, account);
  active.set(execution.id, { runId: opts.run.id, controller, done });
  try { return await done; } finally { clearTimeout(timer); clearInterval(authorityTimer); active.delete(execution.id); }
}

async function invokeTurn(opts: AgentTurnOptions, execution: ExternalAgentExecution, signal: AbortSignal, account: ResolvedAccount | null): Promise<AgentTurnResult> {
  const mode = execution.permissionMode ?? 'readonly';
  const span = startSpan(opts.run.id, { parentId: opts.parentSpanId, spanKind: 'llm', name: `external:${execution.driver}:${opts.agent.model}`,
    input: JSON.stringify({ messages: opts.messages, cwd: execution.cwd, policy: mode, sessionPolicy: opts.agent.execution?.kind === 'external' ? opts.agent.execution.sessionPolicy ?? 'turn' : 'turn' }),
    attributes: { 'agent.id': opts.agent.id, 'llm.model': opts.agent.model, 'execution.id': execution.id, 'execution.driver': execution.driver, 'execution.cwd': execution.cwd, 'execution.policy': mode, 'orchestration.phase': 'agent.external' } });
  const toolSpans = new Map<string, RunEvent>();
  const commands: NonNullable<ExternalAgentExecution['evidence']>['commands'] = [];
  let release = () => {};
  let before: Awaited<ReturnType<typeof captureEvidence>> | null = null;
  let toolsStarted = 0; let firstText = true;
  let correction = 0;
  let session: SessionHandle | undefined;
  let forceCold = false; let naturalTerminal = false;
  const usage = new Map<number, { tokensIn: number | null; tokensOut: number | null; costUsd: number | null }>();
  const onEvent = (event: NativeAgentEvent, content: string) => {
    content = redactSnapshot(content);
    if (event.type === 'text.delta') event = { ...event, text: '' }; // Use the redacted accumulated snapshot below, never raw split tokens.
    if (event.type === 'text.snapshot') event = { ...event, text: redactSnapshot(event.text) };
    if ((event.type === 'tool.started' || event.type === 'tool.completed') && event.output) event = { ...event, output: redactSecrets(event.output) };
    if (signal.aborted || !executionAuthorized(execution)) return;
    if (correction && (event.type === 'text.delta' || event.type === 'text.snapshot') && Buffer.byteLength(content) > (opts.exitCorrectionMaxTokens ?? 2048)) throw new ExecutionError('policy_rejected', '纠偏输出超过平台限制');
    if ('itemId' in event) event = { ...event, itemId: `${correction}:${event.itemId}` };
    emit({ type: 'execution.native', runId: opts.run.id, executionId: execution.id, event });
    if (event.type === 'session.bound') { session?.bind(event.sessionId); updateExecution(execution.id, { sessionId: event.sessionId }); }
    if (event.type === 'terminal') naturalTerminal = event.status === 'completed';
    if (event.type === 'usage') {
      if (session && event.cumulative) session.record.totalUsage = event.cumulative;
      usage.set(correction, event);
      const sum = (key: 'tokensIn' | 'tokensOut' | 'costUsd') => [...usage.values()].some((part) => part[key] === null) ? null : [...usage.values()].reduce((total, part) => total + (part[key] ?? 0), 0);
      updateExecution(execution.id, { tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'), costUsd: sum('costUsd') });
    }
    if (event.type === 'text.delta' || event.type === 'text.snapshot') {
      if (content && firstText) { markSpanFirstToken(span.id); firstText = false; }
      emit({ type: 'llm.snapshot', runId: opts.run.id, spanId: span.id, text: content, displayKind: opts.displayKind });
    }
    if (event.type === 'tool.started' && !toolSpans.has(event.itemId)) {
      toolsStarted++;
      toolSpans.set(event.itemId, startSpan(opts.run.id, { parentId: span.id, spanKind: 'tool', name: `native:${event.name}`,
        attributes: { 'agent.id': opts.agent.id, 'execution.id': execution.id, 'tool.native': true, 'tool.item_id': event.itemId } }));
    }
    if (event.type === 'tool.completed') {
      const tool = toolSpans.get(event.itemId);
      if (tool && !tool.endedAt) {
        endSpan(tool, { status: event.failed ? 'error' : 'ok', output: event.output ?? '原生工具完成（由原生后端执行）' }); tool.endedAt = new Date().toISOString();
        if (commands.length < 100 && event.output) commands.push({ itemId: event.itemId, name: tool.name, output: event.output, exitCode: event.exitCode ?? null });
      }
    }
  };
  try {
    if (bidirectional(execution.driver)) {
      release = await waitForWorkspace(execution.cwd, execution.id, signal, mode === 'readonly');
      if (mode !== 'readonly') await assertCodingWorkspace(execution.cwd);
    }
    if (bidirectional(execution.driver)) {
      before = await captureEvidence(execution.cwd);
      updateExecution(execution.id, { evidence: { head: before.head, beforeDiff: before.diff, afterDiff: before.diff, truncated: before.truncated, commands: [] } });
    }
    const driver = getDriver(execution.driver);
    const info = await driver.detect();
    updateExecution(execution.id, { driverVersion: info.version });
    if (!info.available) throw new ExecutionError(info.errorCode ?? 'unsupported_cli', info.error ?? 'CLI 不可用');
    if (signal.aborted || terminal(opts.run.id)) throw new ExecutionError('cancelled', '运行已停止');
    const systems = opts.messages.filter((message) => message.role === 'system' && !message.content.startsWith('会话边界提示：')).map((message) => message.content);
    const instructions = [...systems, `本轮按平台投递的当前任务执行。工作目录为 ${execution.cwd}。${mode === 'readonly' ? '只读分析；禁止文件写入及外部副作用。' : '仅修改当前仓库的任务文件，给出 diff、测试命令及结果。操作须服从平台权限检查，拒绝后不能绕过。'}原生文件工具不使用平台的 shared/archive 虚拟路径。`,
      opts.controlTools?.length ? 'Runtime 工具通过 agent_gand MCP 提供。上下文中的 agent.complete/handoff/consult/hold 对应 agent_complete/agent_handoff/agent_consult/agent_hold。一次只提交一个最终动作；调用后当前原生回合会停止，平台校验后才提交责任变更。不要自行猜测内部 ID。' : '当前编排未提供 Runtime 控制工具。'].join('\n\n');
    let prompt = opts.messages.filter((message) => message.role !== 'system').map((message) => `[${message.role}]\n${message.content}`).join('\n\n');
    let result: AgentTurnResult;
    const approve = nativeApprovalGate(execution, signal);
    const maxCorrections = Math.min(4, loadRuntimeContract(opts.run.id)?.features?.exitGuard?.maxCorrections ?? 0);
    for (;;) {
      if (signal.aborted || !executionAuthorized(execution)) throw new ExecutionError('cancelled', '执行权已撤销');
      if (!correction && !session && bidirectional(execution.driver)) {
        session = await prepareNativeSession(opts, { ...execution, driverVersion: info.version }, signal, forceCold, account);
        if (session) updateExecution(execution.id, { sessionBindingId: session.record.id, sessionMode: session.resume ? 'resume' : 'cold', sessionReason: session.record.reason });
      }
      const bridge = opts.controlTools?.length || (opts.agent.execution?.kind === 'external' && opts.agent.execution.platformTools?.length)
        ? await createExecutionBridge(opts, execution, signal, correction > 0) : undefined;
      let content = ''; let retryCold = false; naturalTerminal = false;
      usage.set(correction, { tokensIn: null, tokensOut: null, costUsd: null });
      updateExecution(execution.id, { tokensIn: null, tokensOut: null, costUsd: null });
      try {
        content = redactSecrets(await driver.invoke({ cwd: execution.cwd, model: account?.binding?.model ?? opts.agent.model, account, instructions: instructions + (correction ? '\n当前是控制纠偏，只允许 MCP 控制工具，禁止普通工具。' : session?.resume ? '\n继续已验证会话，只处理本次平台上下文增量。' : '\n建立新会话，使用本次完整平台上下文。'), prompt: session?.prompt ?? prompt, signal, timeoutMs: account?.managed ? account.connection.timeoutMs : config.externalAgents.timeoutMs, onEvent,
          authorized: () => executionAuthorized(execution),
          permissionMode: correction ? 'readonly' : mode, nativeTools: correction || mode === 'readonly' ? [] : opts.agent.execution?.kind === 'external' ? opts.agent.execution.nativeTools : [],
          requestApproval: async (id, tool, args, reason) => !bridge?.sealed() && !correction && await approve(`${correction}:${id}`, tool, args, reason),
          bridge, controlOnly: correction > 0, correctionMaxTokens: opts.exitCorrectionMaxTokens,
          session: session?.input,
          onProcess: (owner) => { if (signal.aborted || !executionAuthorized(execution)) throw new ExecutionError('cancelled', '进程登记前执行已失效'); registerNativeProcess(execution.id, owner); },
          onProcessStopped: markNativeProcessStopped }));
      } catch (error) {
        if (error instanceof SessionUnavailableError && session?.resume && !forceCold) {
          session.finish(false); session.release(); session = undefined; forceCold = true; retryCold = true;
        } else throw error;
      } finally { await bridge?.close(); }
      if (retryCold) continue;
      if (signal.aborted || !executionAuthorized(execution)) throw new ExecutionError('cancelled', '原生回合停止后执行权已撤销');
      result = { ...asResult(content, toolsStarted), controlAction: bridge?.action() ?? null, exitCorrectionAttempts: correction };
      const review = opts.reviewExit?.(result, correction);
      if (review?.status !== 'continue_same_turn') break;
      if (correction >= maxCorrections) throw new ExecutionError('policy_rejected', '控制纠偏次数已耗尽');
      correction++;
      session?.finish(false); session?.release(); session = undefined;
      updateExecution(execution.id, { exitCorrectionAttempts: correction });
      prompt += `\n[assistant]\n${content || JSON.stringify(result.controlAction)}\n[user]\n【Runtime ExitGuard 同一回合纠偏】\n${review.feedback}\n只提交控制动作，不得再次执行普通工具。`;
    }
    const content = result.content;
    if (signal.aborted || terminal(opts.run.id)) throw new ExecutionError('cancelled', '运行已停止，迟到结果已丢弃');
    const after = before ? await captureEvidence(execution.cwd) : null;
    const evidence = before && after ? { head: after.head, beforeDiff: before.diff, afterDiff: after.diff, truncated: before.truncated || after.truncated, commands } : undefined;
    if (signal.aborted || terminal(opts.run.id)) throw new ExecutionError('cancelled', '运行已停止，证据采集后的迟到结果已丢弃');
    const snapshot = opts.displayKind !== 'review_protocol' ? await captureWorkspaceSnapshot(opts.run.id, execution.id, execution.cwd) : undefined;
    if (signal.aborted || !executionAuthorized(execution)) throw new ExecutionError('cancelled', '快照采集后的迟到结果已丢弃');
    const record = updateExecution(execution.id, { status: 'completed', content, evidence, snapshot, controlAction: result.controlAction, exitCorrectionAttempts: correction, finishedAt: new Date().toISOString() });
    session?.finish(naturalTerminal && !result.controlAction && correction === 0);
    endSpan(span, { status: 'ok', output: content, tokensIn: record.tokensIn ?? undefined, tokensOut: record.tokensOut ?? undefined, costUsd: record.costUsd ?? undefined,
      attributes: { 'execution.status': 'completed', 'execution.session_id': record.sessionId, 'execution.usage_known': record.tokensIn !== null && record.tokensOut !== null, 'execution.cost_known': record.costUsd !== null } });
    return { ...result, workspaceSnapshot: snapshot };
  } catch (error) {
    session?.finish(false);
    const failure = signal.aborted && signal.reason instanceof ExecutionError ? signal.reason : error instanceof ExecutionError ? error : new ExecutionError('protocol_error', diagnostic(error instanceof Error ? error.message : String(error)));
    const after = before ? await captureEvidence(execution.cwd) : null;
    const evidence = before && after ? { head: after.head, beforeDiff: before.diff, afterDiff: after.diff, truncated: before.truncated || after.truncated, commands } : undefined;
    const record = updateExecution(execution.id, { status: failure.code === 'cancelled' ? 'cancelled' : 'failed', evidence, errorCode: failure.code, error: diagnostic(failure.message), finishedAt: new Date().toISOString() });
    endSpan(span, { status: 'error', output: diagnostic(failure.message), tokensIn: record.tokensIn ?? undefined, tokensOut: record.tokensOut ?? undefined, costUsd: record.costUsd ?? undefined,
      attributes: { 'execution.status': failure.code === 'cancelled' ? 'cancelled' : 'failed', 'execution.error_code': failure.code, 'execution.usage_known': record.tokensIn !== null && record.tokensOut !== null, 'execution.cost_known': record.costUsd !== null } });
    throw failure;
  } finally {
    session?.release();
    expireExecutionApprovals(execution.id); release();
    const status = getExecution(execution.id)?.status;
    for (const tool of toolSpans.values()) if (!tool.endedAt) endSpan(tool, { status: 'error', output: `原生工具未返回完成事件（execution=${status}）` });
  }
}
