import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ExecutionDriverInfo, ExternalDriverId, NativeAgentEvent } from '@agent-gand/shared';
import { config } from '../config.ts';
import { ExecutionError } from './errors.ts';
import { NativeEventParser } from './parsers.ts';
import { runJsonProcess } from './process.ts';
import { invokeClaudeSdk, invokeCodexAppServer } from './nativeDrivers.ts';
import type { PermissionMode } from '@agent-gand/shared';
import type { ExecutionBridge } from './bridge.ts';
import type { ProcessRegistration } from './ownedProcess.ts';
import type { NativeSessionInput } from './sessions.ts';

export interface DriverInput {
  cwd: string;
  model: string;
  instructions: string;
  prompt: string;
  signal: AbortSignal;
  timeoutMs: number;
  onEvent: (event: NativeAgentEvent, content: string) => void;
  permissionMode?: PermissionMode;
  nativeTools?: string[];
  requestApproval?: (requestId: string, tool: string, input: unknown, reason?: string) => Promise<boolean>;
  bridge?: ExecutionBridge;
  controlOnly?: boolean;
  correctionMaxTokens?: number;
  onProcess?: (owner: ProcessRegistration) => void | Promise<void>;
  onProcessStopped?: (token: string) => void;
  session?: NativeSessionInput;
}
export interface AgentDriver {
  id: ExternalDriverId;
  detect: () => Promise<ExecutionDriverInfo>;
  invoke: (input: DriverInput) => Promise<string>;
}

const commands: Record<ExternalDriverId, string> = { 'claude-cli': config.externalAgents.claudeCommand, 'codex-exec': config.externalAgents.codexCommand, 'claude-sdk': process.execPath, 'codex-app-server': config.externalAgents.codexCommand };
const probes = new Map<ExternalDriverId, { expires: number; result: Promise<ExecutionDriverInfo> }>();
function probe(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, timeout: 5_000, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (options.signal?.aborted) reject(new ExecutionError('cancelled', '执行已停止'));
      else if (error) reject(new ExecutionError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_binary' : 'unsupported_cli', (error as NodeJS.ErrnoException).code === 'ENOENT' ? `未找到 CLI：${command}` : `CLI 检测失败：${command}`));
      else resolve(stdout.trim());
    });
  });
}

export function detectDriver(id: ExternalDriverId, refresh = false): Promise<ExecutionDriverInfo> {
  const cached = probes.get(id);
  if (!refresh && cached && cached.expires > Date.now()) return cached.result;
  const result = (async (): Promise<ExecutionDriverInfo> => {
    let version: string | null = null;
    try {
      if (process.platform === 'win32') throw new ExecutionError('unsupported_cli', '阶段 A 仅支持 macOS/Linux');
      if (id === 'claude-sdk') return { id, available: true, version: 'claude-agent-sdk 0.3.288', error: null, readonly: true, permissionModes: ['readonly', 'confirm', 'auto'], nativeApprovals: true, runtimeControl: true };
      version = (await probe(commands[id], ['--version'])).slice(0, 200);
      if (id === 'codex-app-server' && !/^codex-cli 0\.159\.2$/.test(version)) throw new ExecutionError('unsupported_cli', 'Codex app-server 阶段 B 只准入已验证的 0.159.2 协议版本');
      const help = await probe(commands[id], id === 'claude-cli' ? ['--help'] : id === 'codex-app-server' ? ['app-server', '--help'] : ['exec', '--help']);
      const required = id === 'claude-cli'
        ? ['--safe-mode', '--tools', '--permission-mode', '--strict-mcp-config', '--mcp-config', '--setting-sources', '--settings', '--include-partial-messages', '--output-format', '--disable-slash-commands', '--no-chrome']
        : id === 'codex-app-server' ? ['--listen', 'generate-ts'] : ['--sandbox', '--ignore-user-config', '--ignore-rules', '--json'];
      if (required.some((flag) => !help.includes(flag))) throw new ExecutionError('unsupported_cli', 'CLI 缺少阶段 A 必需的只读/隔离选项，请升级');
      return { id, available: true, version, error: null, readonly: true, permissionModes: id === 'codex-app-server' ? ['readonly', 'confirm'] : ['readonly'], nativeApprovals: id === 'codex-app-server', runtimeControl: id === 'codex-app-server' };
    } catch (error) {
      return { id, available: false, version, error: error instanceof Error ? error.message : String(error), errorCode: error instanceof ExecutionError ? error.code : 'unsupported_cli', readonly: true };
    }
  })();
  probes.set(id, { expires: Date.now() + 30_000, result });
  return result;
}

/** These are server-owned arguments; role files/API callers cannot override policy. */
export function readonlyArgs(id: ExternalDriverId, input: Pick<DriverInput, 'model' | 'instructions' | 'cwd'>): string[] {
  if (id === 'claude-cli') return [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob',
    '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome',
    '--append-system-prompt', input.instructions,
    ...(input.model === 'default' ? [] : ['--model', input.model]),
  ];
  return [
    'exec', '--json', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    ...codexProjectPolicy(input.cwd),
    ...['hooks', 'plugins', 'apps', 'multi_agent', 'skill_mcp_dependency_install', 'browser_use', 'computer_use', 'code_mode', 'code_mode_host', 'workspace_dependencies', 'shell_snapshot', 'daemon_auto_start'].flatMap((name) => ['-c', `features.${name}=false`]),
    '-c', `developer_instructions=${JSON.stringify(input.instructions)}`,
    ...(input.model === 'default' ? [] : ['--model', input.model]), '--', '-',
  ];
}

export function codexProjectPolicy(cwd: string): string[] {
  const roots: string[] = [];
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    roots.push(`${JSON.stringify(current)}={trust_level="untrusted"}`);
    if (path.dirname(current) === current) break;
  }
  // Invocation-local trust decisions disable project config/hooks; never modify saved trust.
  return ['-c', `projects={${roots.join(',')}}`];
}

export async function codexMcpPolicy(input: Pick<DriverInput, 'cwd' | 'signal'>): Promise<string[]> {
  const base = ['mcp', 'list', '--json', ...codexProjectPolicy(input.cwd), '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'features.hooks=false'];
  const roster = async (overrides: string[]) => {
    const raw = await probe(commands['codex-exec'], [...base, ...overrides], { cwd: input.cwd, signal: input.signal });
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ExecutionError('policy_rejected', '无法解析 Codex MCP 配置，拒绝启动只读执行'); }
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.enabled !== 'boolean')) throw new ExecutionError('policy_rejected', 'Codex MCP 配置格式不受支持');
    return parsed as Array<{ name: string; enabled: boolean }>;
  };
  // `mcp_servers={}` merges rather than clearing the existing table. Verify actual per-server
  // disabled flags using the CLI itself. Roster inspection does not connect/start servers.
  const servers = await roster([]);
  if (servers.some((server) => !/^[A-Za-z0-9_-]+$/.test(server.name))) throw new ExecutionError('policy_rejected', 'Codex MCP 服务器名称无法安全编译为禁用参数');
  const overrides = servers.flatMap((server) => ['-c', `mcp_servers.${server.name}.enabled=false`]);
  if ((await roster(overrides)).some((server) => server.enabled)) throw new ExecutionError('policy_rejected', 'Codex 管理配置仍启用 MCP，拒绝启动只读执行');
  return overrides;
}

export function getDriver(id: ExternalDriverId): AgentDriver {
  if (!(id in commands)) throw new ExecutionError('unsupported_cli', '未知外部 Driver');
  return { id, detect: () => detectDriver(id), invoke: async (input) => {
    if (id === 'claude-sdk') return invokeClaudeSdk(input);
    if (id === 'codex-app-server') return invokeCodexAppServer(input);
    const parser = new NativeEventParser(id, (event) => input.onEvent(event, parser.content));
    const args = readonlyArgs(id, input);
    if (id === 'codex-exec') args.splice(args.length - 2, 0, ...await codexMcpPolicy(input));
    try {
      await runJsonProcess({ command: commands[id], args, cwd: input.cwd,
        stdin: input.prompt, signal: input.signal, timeoutMs: input.timeoutMs, onProcess: input.onProcess, onProcessStopped: input.onProcessStopped, onRecord: (record) => parser.accept(record) });
    } catch (error) {
      if (error instanceof ExecutionError && error.code === 'nonzero_exit' && parser.error) throw parser.error;
      throw error;
    }
    parser.finish();
    return parser.content;
  } };
}

export async function listDrivers(refresh = false): Promise<ExecutionDriverInfo[]> {
  return Promise.all((['claude-cli', 'codex-exec', 'claude-sdk', 'codex-app-server'] as const).map((id) => detectDriver(id, refresh)));
}
