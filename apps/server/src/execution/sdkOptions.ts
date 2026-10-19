import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@agent-gand/shared';
import type { BridgeLaunch } from './bridge.ts';
import type { NativeSessionInput } from './sessions.ts';
import { config } from '../config.ts';
import { cleanEnvironment, protectedEnvironmentNames } from '../accounts/environment.ts';

export interface SdkWorkerInput {
  cwd: string; model: string; instructions: string; prompt: string; permissionMode: PermissionMode; nativeTools: string[];
  bridge?: BridgeLaunch; controlOnly?: boolean; privateContext?: boolean; recoveryFilesOnly?:boolean; connectionTest?: boolean; correctionMaxTokens?: number;
  session?: NativeSessionInput;
  scopedToolTurns?: number;
  autonomousTurn?: { maxOutputTokens: number };
}

/** No broad allow rules. Every native call waits for the server-owned PreToolUse gate. */
export function sdkOptions(input: SdkWorkerInput, gate: (id: string, tool: string, args: Record<string, unknown>) => Promise<boolean>): Options {
  const pre: HookCallback = async (event, id) => {
    if (event.hook_event_name !== 'PreToolUse') return {};
    const accepted = !!id && await gate(id, event.tool_name, event.tool_input as Record<string, unknown>);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: accepted ? 'allow' : 'deny', permissionDecisionReason: accepted ? '平台已允许当前操作' : '平台拒绝当前操作，禁止绕过或重试同一操作' } };
  };
  const afterControl: HookCallback = async (event) => {
    if (event.hook_event_name !== 'PostToolUse' && event.hook_event_name !== 'PostToolUseFailure') return {};
    if (!input.bridge?.toolNames.some(name => event.tool_name === `mcp__agent_gand__${name}`)) return {};
    // Ephemeral scopes end on their control action, after any allowed file tools.
    // In ordinary turns only the
    // typed nonretryable boundary failure ends the query; syntax errors retain
    // their existing bounded correction path.
    const receipt=event.hook_event_name === 'PostToolUseFailure'?event.error:JSON.stringify(event.tool_response??null);
    const boundaryFailure=['PRIVATE_ROUTE_REQUIRES_SCOPE','SCOPED_TOOL_REJECTED'].some(code=>receipt.includes(code));
    const control=input.bridge?.toolNames.some(name=>name.startsWith('agent_')&&event.tool_name===`mcp__agent_gand__${name}`);
    return input.session?.ephemeral&&control || boundaryFailure
      ? { continue:false, stopReason:'平台控制回合已结束，请查看平台记录中的结果或恢复入口。' } : {};
  };
  return {
    cwd: input.cwd, ...(input.model === 'default' ? {} : { model: input.model }),
    // AC6 already supplies the complete frozen responsibility and scoped tools.
    // The coding preset adds unrelated repository workflows to every cold control turn.
    systemPrompt: input.autonomousTurn ? input.instructions : { type: 'preset', preset: 'claude_code', append: input.instructions },
    tools: input.controlOnly || input.privateContext ? [] : input.permissionMode === 'readonly' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Write', 'Edit', ...(input.recoveryFilesOnly?[]:['Bash'])],
    allowedTools: input.bridge?.toolNames.map((name) => `mcp__agent_gand__${name}`) ?? [], disallowedTools: input.bridge ? [] : ['mcp__*'], permissionMode: 'default',
    settingSources: [], mcpServers: input.bridge ? { agent_gand: { command: input.bridge.command, args: input.bridge.args, env: { ...cleanEnvironment() as Record<string, string>, ...Object.fromEntries(protectedEnvironmentNames.map((name) => [name, ''])), ...input.bridge.env } } } : {}, strictMcpConfig: true, plugins: [],
    env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', ...(input.autonomousTurn ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.autonomousTurn.maxOutputTokens) } : {}), ...(input.controlOnly ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.correctionMaxTokens ?? 2048) } : {}) },
    ...(input.autonomousTurn ? { effort: 'low' as const } : {}),
    ...(input.session?.ephemeral ? { maxTurns:Math.min(8,Math.max(1,input.scopedToolTurns??1)) } : input.controlOnly ? { maxTurns: 2 } : {}),
    ...(input.connectionTest ? { thinking: { type: 'disabled' as const }, effort: 'low' as const, maxTurns: 1 } : {}),
    settings: { ...(input.session?.ephemeral ? { autoMemoryEnabled:false, claudeMdExcludes:['**'] } : {}), syncClaudeAiSkills: false, syncClaudeAiPlugins: false, permissions: { deny: [`Read(${config.accounts.privateDir}/**)`] } },
    includePartialMessages: true, persistSession: !!input.session && !input.session.ephemeral && !input.session.transient,
    ...(input.session?.id ? input.session.resume ? { resume: input.session.id } : { sessionId: input.session.id } : {}),
    hooks: { PreToolUse: [{ hooks: [pre], timeout: 86400 }],
      ...(input.bridge ? { PostToolUse:[{hooks:[afterControl]}], PostToolUseFailure:[{hooks:[afterControl]}] } : {}),
    },
    canUseTool: async () => ({ behavior: 'deny', message: '权限必须由平台工具前检查裁定' }),
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      filesystem: { denyRead: [config.accounts.privateDir], allowWrite: [input.cwd], denyWrite: [input.cwd + '/.git', input.cwd + '/.claude', input.cwd + '/.codex', input.cwd + '/.agents', '/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])] },
      credentials: { envVars: protectedEnvironmentNames.map((name) => ({ name, mode: 'deny' as const })), files: [{ path: config.accounts.privateDir, mode: 'deny' }] },
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false } },
    extraArgs: { 'disable-slash-commands': null, 'no-chrome': null },
  };
}
