import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { containedPath } from './policy.ts';
import { diagnostic, ExecutionError } from './errors.ts';
import { acquireDurableLease, waitForDurableLease } from './leases.ts';

const LIMIT = 128 * 1024;
async function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: LIMIT * 2 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
export async function assertCodingWorkspace(cwd: string): Promise<void> {
  let root: string;
  try { root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new ExecutionError('policy_rejected', '阶段 B 写入须选择已注册的 Git 仓库工作区'); }
  if (root !== cwd) throw new ExecutionError('policy_rejected', '编码工作区必须注册 Git 仓库根目录');
}

/** Evidence is observed independently of the model summary; no external diff/textconv. */
export async function captureEvidence(cwd: string): Promise<{ head: string | null; diff: string; truncated: boolean }> {
  let head: string | null = null; let diff = ''; let truncated = false;
  try { head = (await git(cwd, ['rev-parse', 'HEAD'])).trim(); } catch {}
  try {
    diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', '.']);
    const files = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const file of files.slice(0, 20)) {
      const absolute = containedPath(cwd, file);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.size > LIMIT || stat.isSymbolicLink()) { truncated = true; continue; }
      const bytes = await readFile(absolute);
      if (bytes.includes(0)) { diff += `\n新二进制文件 ${file} (${stat.size} bytes)\n`; continue; }
      diff += `\n--- /dev/null\n+++ b/${file}\n` + bytes.toString('utf8').split('\n').map((line) => '+' + line).join('\n');
      if (diff.length > LIMIT) { truncated = true; break; }
    }
    if (files.length > 20) truncated = true;
  } catch { truncated = true; }
  if (diff.length > LIMIT) truncated = true;
  return { head, diff: diagnostic(diff.slice(0, LIMIT), LIMIT), truncated };
}

/** SQLite-backed ownership, including process identity and native-process fences. */
export function acquireWorkspace(cwd: string, executionId: string, readonly = false): () => void {
  return acquireDurableLease('workspace:' + cwd, executionId, readonly);
}

export async function waitForWorkspace(cwd: string, executionId: string, signal: AbortSignal, readonly: boolean): Promise<() => void> {
  return waitForDurableLease('workspace:' + cwd, executionId, readonly, signal);
}
