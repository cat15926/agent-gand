import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@agent-gand/shared';
import type { BridgeLaunch } from './bridge.ts';
import type { NativeSessionInput } from './sessions.ts';
import { config } from '../config.ts';
import { cleanEnvironment, protectedEnvironmentNames } from '../accounts/environment.ts';

export interface SdkWorkerInput {
  cwd: string; model: string; instructions: string; prompt: string; permissionMode: PermissionMode; nativeTools: string[];
  bridge?: BridgeLaunch; controlOnly?: boolean; connectionTest?: boolean; correctionMaxTokens?: number;
  session?: NativeSessionInput;
}

/** No broad allow rules. Every native call waits for the server-owned PreToolUse gate. */
export function sdkOptions(input: SdkWorkerInput, gate: (id: string, tool: string, args: Record<string, unknown>) => Promise<boolean>): Options {
  const pre: HookCallback = async (event, id) => {
    if (event.hook_event_name !== 'PreToolUse') return {};
    const accepted = !!id && await gate(id, event.tool_name, event.tool_input as Record<string, unknown>);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: accepted ? 'allow' : 'deny', permissionDecisionReason: accepted ? '平台已允许当前操作' : '平台拒绝当前操作，禁止绕过或重试同一操作' } };
  };
  return {
    cwd: input.cwd, ...(input.model === 'default' ? {} : { model: input.model }),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.instructions },
    tools: input.controlOnly ? [] : input.permissionMode === 'readonly' ? ['Read', 'Grep', 'Glob'] : ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'],
    allowedTools: input.bridge?.toolNames.map((name) => `mcp__agent_gand__${name}`) ?? [], disallowedTools: input.bridge ? [] : ['mcp__*'], permissionMode: 'default',
    settingSources: [], mcpServers: input.bridge ? { agent_gand: { command: input.bridge.command, args: input.bridge.args, env: { ...cleanEnvironment() as Record<string, string>, ...Object.fromEntries(protectedEnvironmentNames.map((name) => [name, ''])), ...input.bridge.env } } } : {}, strictMcpConfig: true, plugins: [],
    env: { ...process.env, ENABLE_TOOL_SEARCH: 'false', ...(input.controlOnly ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.correctionMaxTokens ?? 2048) } : {}) },
    ...(input.controlOnly ? { maxTurns: 2 } : {}),
    ...(input.connectionTest ? { thinking: { type: 'disabled' as const }, effort: 'low' as const, maxTurns: 1 } : {}),
    settings: { syncClaudeAiSkills: false, syncClaudeAiPlugins: false, permissions: { deny: [`Read(${config.accounts.privateDir}/**)`] } },
    includePartialMessages: true, persistSession: !!input.session,
    ...(input.session?.id ? input.session.resume ? { resume: input.session.id } : { sessionId: input.session.id } : {}),
    hooks: { PreToolUse: [{ hooks: [pre], timeout: 86400 }] },
    canUseTool: async () => ({ behavior: 'deny', message: '权限必须由平台工具前检查裁定' }),
    sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false,
      filesystem: { denyRead: [config.accounts.privateDir], allowWrite: [input.cwd], denyWrite: [input.cwd + '/.git', input.cwd + '/.claude', input.cwd + '/.codex', input.cwd + '/.agents', '/tmp', ...(process.env.TMPDIR ? [process.env.TMPDIR] : [])] },
      credentials: { envVars: protectedEnvironmentNames.map((name) => ({ name, mode: 'deny' as const })), files: [{ path: config.accounts.privateDir, mode: 'deny' }] },
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowAllUnixSockets: false } },
    extraArgs: { 'disable-slash-commands': null, 'no-chrome': null },
  };
}
