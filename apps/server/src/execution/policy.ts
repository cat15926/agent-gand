import path from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import type { AgentDefinition, RunMode } from '@agent-gand/shared';
import { ExecutionError } from './errors.ts';
import { isAccountPrivatePath } from '../accounts/privatePaths.ts';

export const SDK_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'];
export const READ_TOOLS = ['Read', 'Grep', 'Glob'];
export function bidirectional(driver: string): boolean { return driver === 'claude-sdk' || driver === 'codex-app-server'; }

export function assertExternalAdmission(agents: AgentDefinition[], mode: RunMode, supervisorId?: string | null): void {
  for (const agent of agents) {
    if (agent.execution?.kind !== 'external') continue;
    if (mode !== 'pipeline' && !(bidirectional(agent.execution.driver) && (mode === 'collaboration' || (mode === 'supervisor' && agent.id !== supervisorId)))) {
      throw Object.assign(new Error('只读 CLI 支持流水线；双向后端还支持内置主管的 worker/reviewer 和自由协作'), { status: 400 });
    }
  }
}

/** Resolve existing ancestors as well as a possibly new leaf; reject symlink escapes. */
export function containedPath(cwd: string, value: string, writing = false): string {
  const absolute = path.resolve(cwd, value);
  let ancestor = absolute;
  for (;;) {
    try { lstatSync(ancestor); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new ExecutionError('policy_rejected', '路径无法解析');
    ancestor = parent;
  }
  const resolved = path.resolve(realpathSync(ancestor), path.relative(ancestor, absolute));
  if (isAccountPrivatePath(resolved)) throw new ExecutionError('policy_rejected', '原生文件工具不能访问账户私有文件');
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new ExecutionError('policy_rejected', '原生文件工具路径超出工作区');
  if (writing && relative.split(path.sep).some((part) => ['.git', '.claude', '.codex', '.agents'].includes(part.toLowerCase()))) throw new ExecutionError('policy_rejected', '原生写入不能修改仓库元数据或执行配置');
  return resolved;
}

export function sdkPermission(agent: Pick<AgentDefinition, 'permissionMode' | 'execution'>, cwd: string, tool: string, input: Record<string, unknown>): 'allow' | 'deny' | 'ask' {
  if (!SDK_TOOLS.includes(tool)) return 'deny';
  const reading = READ_TOOLS.includes(tool);
  if (agent.permissionMode === 'readonly' && !reading) return 'deny';
  try {
    if (['Read', 'Write', 'Edit'].includes(tool)) {
      if (typeof input.file_path !== 'string') return 'deny';
      containedPath(cwd, input.file_path, !reading);
    } else if (tool === 'Grep' || tool === 'Glob') {
      if (input.path !== undefined && typeof input.path !== 'string') return 'deny';
      containedPath(cwd, typeof input.path === 'string' ? input.path : cwd);
    } else if (tool === 'Bash' && (typeof input.command !== 'string' || (input.run_in_background !== undefined && input.run_in_background !== false) || (input.dangerouslyDisableSandbox !== undefined && input.dangerouslyDisableSandbox !== false))) return 'deny';
  } catch { return 'deny'; }
  const allowed = agent.execution?.kind === 'external' ? agent.execution.nativeTools ?? [] : [];
  if (agent.permissionMode === 'auto') return allowed.includes(tool) ? 'allow' : 'deny';
  if (reading || allowed.includes(tool)) return 'allow';
  return 'ask';
}
