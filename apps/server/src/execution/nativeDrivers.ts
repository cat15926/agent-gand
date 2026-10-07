import { fileURLToPath } from 'node:url';
import { chmod, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { NativeAgentEvent } from '@agent-gand/shared';
import { config } from '../config.ts';
import type { DriverInput } from './drivers.ts';
import { codexProjectPolicy } from './drivers.ts';
import { NativeEventParser } from './parsers.ts';
import { ExecutionError, diagnostic, exitError } from './errors.ts';
import { withRpcProcess } from './rpc.ts';
import { containedPath, sdkPermission, SDK_TOOLS, READ_TOOLS } from './policy.ts';
import { BRIDGE_NAME } from './bridge.ts';
import { protectedEnvironmentNames } from '../accounts/environment.ts';
import { SessionUnavailableError } from './sessions.ts';
import { assertCodexHomePolicy, CODEX_SKILL_POLICY } from './codexHome.ts';

export async function invokeClaudeSdk(input: DriverInput): Promise<string> {
  if (!input.environment?.ANTHROPIC_API_KEY) throw new ExecutionError('auth_required', 'Claude SDK 需要所选账户的 API Key');
  const sdkHome = path.resolve(input.nativeHome ?? config.externalAgents.claudeHome);
  let userHome = path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'));
  try { userHome = await realpath(userHome); } catch {}
  await mkdir(sdkHome, { recursive: true, mode: 0o700 });
  const physicalHome = await realpath(sdkHome);
  if (physicalHome === userHome) throw new ExecutionError('policy_rejected', 'EXTERNAL_CLAUDE_HOME 必须独立于用户 Claude 配置目录');
  if ((await readdir(physicalHome)).some((name) => ['settings.json', 'settings.local.json', 'hooks', 'plugins', 'skills', 'agents', '.credentials.json'].includes(name))) throw new ExecutionError('policy_rejected', 'Claude 专用执行目录包含自定义配置或登录凭证，API key 后端拒绝启动');
  if (input.session?.configDir && input.session.configDir !== physicalHome) throw new ExecutionError('policy_rejected', 'Claude 会话持久目录绑定已改变');
  await chmod(physicalHome, 0o700);
  const mode = input.permissionMode ?? 'readonly';
  const mcpTools = input.bridge?.launch.toolNames.map((name) => `mcp__${BRIDGE_NAME}__${name}`) ?? [];
  let initialized = false;
  const parser = new NativeEventParser('claude-sdk', (event) => {
    if (event.type === 'session.bound') initialized = true;
    // Resume billing semantics are not assumed to be turn-local; retain unknown rather than count twice.
    input.onEvent(input.session?.resume && event.type === 'usage' ? { ...event, tokensIn: null, tokensOut: null, costUsd: null } : event, parser.content);
  }, [...(input.controlOnly ? [] : mode === 'readonly' ? READ_TOOLS : SDK_TOOLS), ...mcpTools], input.bridge ? [BRIDGE_NAME] : []);
  return withRpcProcess({ command: config.externalAgents.sdkWorkerCommand ?? process.execPath,
    args: config.externalAgents.sdkWorkerCommand ? [] : ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./sdkWorker.ts', import.meta.url))],
    cwd: input.cwd, signal: input.signal, timeoutMs: input.timeoutMs, onProcess: input.onProcess, onProcessStopped: input.onProcessStopped,
    env: { ...input.environment, AGENT_GAND_ISOLATED_WORKER: '1', AGENT_GAND_PRIVATE_DIR: config.accounts.privateDir, CLAUDE_CONFIG_DIR: physicalHome, CLAUDE_CODE_PROJECT_DIR_NAME: input.session?.projectDir ?? '', CLAUDE_CODE_OAUTH_TOKEN: '' } }, async (peer) => {
    let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    peer.onInterrupt(() => peer.send({ method: 'sdk/interrupt', params: {} }));
    peer.onMessage(async (message) => {
      if (input.signal.aborted || input.authorized?.() === false || input.bridge?.sealed()) return;
      if (message.method === 'sdk/message') parser.accept(message.params?.message);
      else if (message.method === 'sdk/resumeUnavailable' && input.session?.resume && !initialized) rejectDone(new SessionUnavailableError('SDK 会话恢复预检失败'));
      else if (message.method === 'sdk/error') rejectDone(exitError(String(message.params?.message ?? 'SDK failed')));
      else if (message.method === 'sdk/done') resolveDone();
      else if (message.method === 'sdk/permission' && message.id !== undefined) {
        const params = message.params ?? {};
        if (typeof params.tool !== 'string' || !params.input || typeof params.input !== 'object' || Array.isArray(params.input) || typeof params.toolUseId !== 'string') throw new ExecutionError('protocol_error', 'SDK 权限请求缺少参数');
        const isBridge = mcpTools.includes(params.tool);
        const decision = isBridge ? 'allow' : input.controlOnly ? 'deny' : sdkPermission({ permissionMode: mode, execution: { kind: 'external', driver: 'claude-sdk', nativeTools: input.nativeTools } }, input.cwd, params.tool, params.input);
        let accepted = decision === 'allow';
        if (decision === 'ask') {
          const id = String(message.id);
          accepted = await (input.requestApproval?.(id, params.tool, params.input) ?? Promise.resolve(false));
        }
        if (accepted && !isBridge && sdkPermission({ permissionMode: mode, execution: { kind: 'external', driver: 'claude-sdk', nativeTools: input.nativeTools } }, input.cwd, params.tool, params.input) === 'deny') accepted = false;
        if (!input.signal.aborted) peer.send({ id: message.id, result: { allow: accepted && input.authorized?.() !== false && !input.bridge?.sealed() } });
      } else throw new ExecutionError('protocol_error', 'SDK worker 返回未准入的消息');
    });
    peer.send({ method: 'sdk/start', params: { cwd: input.cwd, model: input.model, instructions: input.instructions, prompt: input.prompt, permissionMode: mode, nativeTools: input.nativeTools ?? [], bridge: input.bridge?.launch, controlOnly: input.controlOnly, connectionTest: input.connectionTest, correctionMaxTokens: input.correctionMaxTokens, session: input.session } });
    const ending = await Promise.race([done.then(() => 'terminal'), ...(input.bridge ? [input.bridge.candidate.then(() => 'control')] : [])]);
    if (ending === 'control') peer.send({ method: 'sdk/interrupt', params: {} }); else parser.finish();
    return parser.content;
  });
}

/** Version-specific v2 stdio adapter. No experimental API or session-wide approvals. */
export async function invokeCodexAppServer(input: DriverInput): Promise<string> {
  const mode = input.permissionMode ?? 'readonly';
  if (mode === 'auto' || input.nativeTools?.length) throw new ExecutionError('policy_rejected', 'Codex app-server 不支持平台原生工具白名单或 auto 模式');
  // A dedicated persistent login avoids duplicating OAuth refresh tokens. Its
  // configuration must stay empty; invocation policy is owned by this server.
  const nativeHome = path.resolve(input.nativeHome ?? config.externalAgents.codexHome);
  let userHome = path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'));
  try { userHome = await realpath(userHome); } catch {}
  if (nativeHome === userHome) throw new ExecutionError('policy_rejected', 'EXTERNAL_CODEX_HOME 必须为独立执行目录，不能使用用户 Codex 配置目录');
  await mkdir(nativeHome, { recursive: true, mode: 0o700 });
  if (await realpath(nativeHome) === userHome) throw new ExecutionError('policy_rejected', 'EXTERNAL_CODEX_HOME 不能通过符号链接指向用户配置目录');
  await assertCodexHomePolicy(nativeHome);
  await chmod(nativeHome, 0o700);
  const bridgeConfig = input.bridge ? { command: input.bridge.launch.command, args: input.bridge.launch.args,
    env: Object.fromEntries(protectedEnvironmentNames.filter((name) => !(name in input.bridge!.launch.env)).map((name) => [name, ''])), env_vars: Object.keys(input.bridge.launch.env), enabled: true, required: true,
    enabled_tools: input.bridge.launch.toolNames, default_tools_approval_mode: 'approve', tool_timeout_sec: Math.ceil(input.timeoutMs / 1000) + 5 } : null;
  const args = ['app-server', '--listen', 'stdio://', ...codexProjectPolicy(input.cwd), ...CODEX_SKILL_POLICY,
    '-c', 'web_search="disabled"', '-c', 'approvals_reviewer="user"', '-c', 'sandbox_mode="read-only"',
    ...['goals', 'hooks', 'plugins', 'apps', 'multi_agent', 'skill_mcp_dependency_install', 'browser_use', 'computer_use', 'code_mode', 'code_mode_host', 'workspace_dependencies', 'shell_snapshot', 'daemon_auto_start', ...(input.controlOnly ? ['shell_tool', 'view_image', 'image_generation', 'sleep_tool'] : [])].flatMap((name) => ['-c', `features.${name}=false`]), ...input.credentialArgs ?? []];
  if (input.account?.managed) args.splice(args.indexOf('sandbox_mode="read-only"') - 1, 2);
  return withRpcProcess({ command: config.externalAgents.codexCommand, args, cwd: input.cwd, signal: input.signal, timeoutMs: input.timeoutMs, env: { ...input.environment, CODEX_HOME: nativeHome, ...input.bridge?.launch.env }, onProcess: input.onProcess, onProcessStopped: input.onProcessStopped }, async (peer) => {
    let threadId = ''; let turnId = ''; let final = ''; let ended = false;
    const items = new Map<string, Record<string, any>>();
    const textItems = new Map<string, string>();
    let resolveDone!: () => void; let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void done.catch(() => {});
    const emitEvent = (event: NativeAgentEvent) => input.onEvent(event, final || [...textItems.values()].join('\n\n'));
    const valid = (params: Record<string, any>) => params.threadId === threadId && (!turnId || !params.turnId || params.turnId === turnId);
    const requests = new Map<string, { fingerprint: string; response: Promise<boolean> }>();
    peer.onMessage(async (message) => {
      if (input.signal.aborted || input.authorized?.() === false || input.bridge?.sealed()) return;
      const params = message.params ?? {};
      if (message.id !== undefined) {
        const file = message.method === 'item/fileChange/requestApproval';
        const command = message.method === 'item/commandExecution/requestApproval';
        if (!valid(params) || ended || (!file && !command)) {
          peer.send({ id: message.id, error: { code: -32601, message: '当前执行不支持此原生控制请求' } });
          if (!file && !command) throw new ExecutionError('policy_rejected', 'Codex 请求了阶段 B 未实现的用户输入/权限/MCP 控制');
          return;
        }
        const item = items.get(params.itemId);
        let eligible = !input.controlOnly && mode === 'confirm' && !!item;
        // A command approval may escape the private-directory read fence. Managed
        // connections keep sandboxed commands and contained file-change approvals only.
        if (command && input.account?.managed) eligible = false;
        const payload = { ...params, item };
        try {
          if (file) {
            if (params.grantRoot || item?.type !== 'fileChange' || !Array.isArray(item.changes) || !item.changes.length) eligible = false;
            else for (const change of item.changes) { containedPath(input.cwd, change.path, true); if (change.kind?.move_path) containedPath(input.cwd, change.kind.move_path, true); }
          } else {
            if (item?.type !== 'commandExecution' || params.kind !== 'command' || params.networkApprovalContext || params.proposedNetworkPolicyAmendments?.length
              || params.command !== item.command || params.cwd !== item.cwd || typeof params.command !== 'string' || typeof params.cwd !== 'string') eligible = false;
            else containedPath(input.cwd, params.cwd);
          }
        } catch { eligible = false; }
        const id = String(message.id); const fingerprint = JSON.stringify(payload);
        const previous = requests.get(id);
        if (previous && previous.fingerprint !== fingerprint) throw new ExecutionError('protocol_error', '同一原生审批 ID 返回了不同操作');
        const response = previous?.response ?? (eligible ? input.requestApproval?.(id, file ? 'fileChange' : 'commandExecution', payload,
          command ? '批准此原生命令可能授予沙箱外执行；请核对完整命令和目录。本次批准不保存规则。' : params.reason) ?? Promise.resolve(false) : Promise.resolve(false));
        requests.set(id, { fingerprint, response });
        const accepted = await response;
        let stillContained = true;
        try { if (file && item?.changes) for (const change of item.changes) { containedPath(input.cwd, change.path, true); if (change.kind?.move_path) containedPath(input.cwd, change.kind.move_path, true); } }
        catch { stillContained = false; }
        if (!input.signal.aborted && !ended) peer.send({ id: message.id, result: { decision: accepted && stillContained && input.authorized?.() !== false ? 'accept' : 'decline' } });
        return;
      }
      if (params.threadId && threadId && params.threadId !== threadId) throw new ExecutionError('protocol_error', 'Codex 通知属于其他 thread');
      if (params.turnId && turnId && params.turnId !== turnId) throw new ExecutionError('protocol_error', 'Codex 通知属于其他 turn');
      if (message.method === 'turn/started') { if (turnId && turnId !== params.turn?.id) throw new ExecutionError('protocol_error', 'Codex turn 绑定冲突'); turnId = params.turn?.id ?? ''; }
      if (message.method === 'item/agentMessage/delta') {
        if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') throw new ExecutionError('protocol_error', 'Codex 文本增量无效');
        textItems.set(params.itemId, (textItems.get(params.itemId) ?? '') + params.delta); emitEvent({ type: 'text.delta', itemId: params.itemId, text: params.delta });
      }
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = params.item;
        if (!item || typeof item.id !== 'string' || typeof item.type !== 'string') throw new ExecutionError('protocol_error', 'Codex item 格式无效');
        items.set(item.id, item);
        if (item.type === 'agentMessage') {
          if (typeof item.text === 'string') { textItems.set(item.id, item.text); if (item.phase === 'final_answer') final = item.text; emitEvent({ type: 'text.snapshot', itemId: item.id, text: item.text }); }
        } else if (['commandExecution', 'fileChange'].includes(item.type)) {
          if (input.controlOnly) throw new ExecutionError('policy_rejected', '纠偏回合不允许原生普通工具');
          if (mode === 'readonly' && item.type === 'fileChange' && item.status === 'completed') throw new ExecutionError('policy_rejected', '只读 Codex 回合返回了文件写入完成');
          emitEvent({ type: message.method === 'item/completed' ? 'tool.completed' : 'tool.started', itemId: item.id, name: item.type,
            output: diagnostic(item.aggregatedOutput ?? JSON.stringify(item.changes ?? '')), exitCode: typeof item.exitCode === 'number' ? item.exitCode : null, failed: ['failed', 'declined'].includes(item.status) });
        } else if (item.type === 'mcpToolCall') {
          if (item.server !== BRIDGE_NAME || !input.bridge?.launch.toolNames.includes(item.tool)) throw new ExecutionError('policy_rejected', 'Codex 请求未准入的 MCP 工具');
          emitEvent({ type: message.method === 'item/completed' ? 'tool.completed' : 'tool.started', itemId: item.id, name: `mcp:${item.tool}`, output: diagnostic(JSON.stringify(item.result ?? item.error ?? '')), failed: !!item.error });
        } else if (['dynamicToolCall', 'collabAgentToolCall', 'imageGeneration'].includes(item.type)) throw new ExecutionError('policy_rejected', `Codex 暴露未准入工具：${item.type}`);
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const usage = params.tokenUsage?.total;
        const baseline = input.session?.resume ? input.session.usageBaseline : { tokensIn: 0, tokensOut: 0, costUsd: null };
        const delta = (value: unknown, before: number | null | undefined) => typeof value === 'number' && typeof before === 'number' && value >= before ? value - before : null;
        emitEvent({ type: 'usage', tokensIn: delta(usage?.inputTokens, baseline?.tokensIn), tokensOut: delta(usage?.outputTokens, baseline?.tokensOut), costUsd: null,
          cumulative: { tokensIn: typeof usage?.inputTokens === 'number' ? usage.inputTokens : null, tokensOut: typeof usage?.outputTokens === 'number' ? usage.outputTokens : null, costUsd: null } });
      }
      if (message.method === 'turn/completed') {
        ended = true;
        if (params.turn?.id !== turnId || params.turn?.status !== 'completed') rejectDone(exitError(String(params.turn?.error?.message ?? `Codex turn ${params.turn?.status}`)));
        else { emitEvent({ type: 'terminal', status: 'completed' }); resolveDone(); }
      }
      if (message.method === 'error' && params.willRetry !== true) rejectDone(exitError(String(params.error?.message ?? params.message ?? 'Codex failed')));
    });
    await peer.request('initialize', { clientInfo: { name: 'agent_gand', title: 'Agent Gand', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    peer.send({ method: 'initialized', params: {} });
    if (input.session?.resume && input.session.id) {
      let saved;
      try { saved = await peer.request('thread/read', { threadId: input.session.id, includeTurns: true }); }
      catch { throw new SessionUnavailableError('Codex 本地 thread 不可读取'); }
      if (saved.thread?.id !== input.session.id || saved.thread.cwd !== input.cwd || !Array.isArray(saved.thread.turns) || saved.thread.turns.at(-1)?.status !== 'completed') throw new SessionUnavailableError('Codex 本地 thread 缺少可恢复的完成终态或 cwd 已改变');
    }
    let thread;
    try { thread = await peer.request(input.session?.resume ? 'thread/resume' : 'thread/start', { ...(input.session?.resume ? { threadId: input.session.id } : {}), cwd: input.cwd, model: input.model === 'default' ? null : input.model,
      approvalPolicy: mode === 'readonly' ? 'never' : 'untrusted', approvalsReviewer: 'user', ...(input.account?.managed ? {} : { sandbox: 'read-only' }), developerInstructions: input.instructions,
      ...(bridgeConfig ? { config: { mcp_servers: { [BRIDGE_NAME]: bridgeConfig } } } : {}) }); }
    catch (error) { if (input.session?.resume) throw new SessionUnavailableError('Codex thread 恢复在模型 turn 前失败'); throw error; }
    threadId = thread.thread?.id;
    if (typeof threadId !== 'string' || !threadId || (input.session?.resume && threadId !== input.session.id) || thread.cwd !== input.cwd || thread.sandbox?.type !== 'readOnly' || thread.sandbox.networkAccess !== false || thread.approvalPolicy !== (mode === 'readonly' ? 'never' : 'untrusted') || thread.approvalsReviewer !== 'user') throw new ExecutionError('policy_rejected', 'Codex 实际线程策略与平台编译策略不一致');
    emitEvent({ type: 'session.bound', sessionId: threadId });
    const turn = await peer.request('turn/start', { threadId, input: [{ type: 'text', text: input.prompt }], ...(input.account?.managed ? {} : { sandboxPolicy: { type: 'readOnly', networkAccess: false } }), approvalPolicy: mode === 'readonly' ? 'never' : 'untrusted', approvalsReviewer: 'user' });
    if (turnId && turnId !== turn.turn?.id) throw new ExecutionError('protocol_error', 'Codex turn 响应绑定冲突');
    turnId = turn.turn?.id;
    if (typeof turnId !== 'string' || !turnId) throw new ExecutionError('protocol_error', 'Codex turn 缺少 ID');
    const interrupt = () => { void peer.request('turn/interrupt', { threadId, turnId }).catch(() => {}); };
    peer.onInterrupt(interrupt);
    const ending = await Promise.race([done.then(() => 'terminal'), ...(input.bridge ? [input.bridge.candidate.then(() => 'control')] : [])]);
    if (ending === 'control') { interrupt(); return final || [...textItems.values()].join('\n\n'); }
    const content = final || [...textItems.values()].join('\n\n');
    if (!content.trim()) throw new ExecutionError('protocol_error', 'Codex 成功终态没有正文');
    return content;
  });
}
