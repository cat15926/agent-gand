import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ExternalWorkspaceBinding, Run } from '@agent-gand/shared';
import { config } from '../config.ts';
import { getRunOrchestrationSnapshot } from '../orchestration/store.ts';
import { all, get, run } from '../db/database.ts';
import { getExternalByIdOrThrow } from './external.ts';
import { waitForDurableLease } from '../execution/leases.ts';
import { ExecutionError } from '../execution/errors.ts';
import { isAccountPrivatePath } from '../accounts/privatePaths.ts';

const preparing = new Map<string, Promise<ExternalWorkspaceBinding | null>>();
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
async function rawGit(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args],
      { cwd, env: gitEnv(), encoding: 'buffer', timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    if (input) child.stdin?.end(input); else child.stdin?.end();
  });
}
async function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  let keys: string[] = [];
  try { keys = (await rawGit(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'])).toString().split('\0').filter(Boolean); } catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
  const filters = keys.flatMap((key) => ['-c', key + (key.endsWith('.required') ? '=false' : '=')]);
  return rawGit(cwd, [...filters, ...args], input);
}
async function addWorktree(sourceRoot: string, cwd: string, target: string, commit: string, signal: AbortSignal): Promise<void> {
  // Git enumerates the shared worktree registry while adding entries; concurrent
  // additions can observe a directory before its commondir file is complete.
  const release = await waitForDurableLease('repository:' + sourceRoot, 'worktree:' + randomUUID(), false, signal);
  try { await git(cwd, ['worktree', 'add', '--detach', target, commit]); } finally { release(); }
}
const safeRelative = (file: string) => {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === '..' || part.toLowerCase() === '.git')) throw new ExecutionError('policy_rejected', 'Git 快照包含不安全路径');
  return file;
};
async function sourceState(root: string) {
  const head = (await git(root, ['rev-parse', 'HEAD'])).toString().trim();
  const top = (await git(root, ['rev-parse', '--show-toplevel'])).toString().trim();
  if (await realpath(top) !== root) throw new ExecutionError('policy_rejected', '隔离编码须注册有 HEAD 的 Git 仓库根目录');
  if ((await git(root, ['ls-files', '--stage'])).toString().split('\n').some((line) => line.startsWith('160000 '))) throw new ExecutionError('policy_rejected', '当前隔离工作区暂不支持 Git submodule');
  if ((await git(root, ['ls-files', '-z'])).toString().split('\0').filter(Boolean).some((file) => isAccountPrivatePath(path.join(root, file)))) throw new ExecutionError('policy_rejected', '注册仓库跟踪了账户私有文件，拒绝创建或导出快照');
  const patch = await git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--', '.']);
  const files = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).toString().split('\0').filter(Boolean).map(safeRelative).filter((file) => !isAccountPrivatePath(path.join(root, file)));
  if (files.length > 2000) throw new ExecutionError('policy_rejected', '待复制未跟踪文件过多，请先整理工作区');
  const hash = createHash('sha256').update(head).update(patch); let bytes = patch.byteLength;
  for (const file of files) {
    const absolute = path.join(root, file); const stat = await lstat(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new ExecutionError('policy_rejected', '未跟踪目录或嵌套仓库不能作为完整快照复制');
    bytes += stat.size;
    if (bytes > 64 * 1024 * 1024 || stat.size > 8 * 1024 * 1024) throw new ExecutionError('policy_rejected', '工作区快照超过复制限制');
    hash.update(JSON.stringify([file, stat.mode])); hash.update(stat.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute));
  }
  return { head, patch, files, fingerprint: hash.digest('hex') };
}
export function getIsolatedWorkspace(runId: string): ExternalWorkspaceBinding | null {
  const row = get<{ record: string }>('SELECT record FROM external_workspace_bindings WHERE run_id=?', runId);
  return row ? JSON.parse(row.record) : null;
}
function save(binding: ExternalWorkspaceBinding): void {
  run('INSERT OR REPLACE INTO external_workspace_bindings (run_id,record) VALUES (?,?)', binding.runId, JSON.stringify(binding));
}
/** Existing mixed teams resolve the same managed root before their first tool call. */
export async function ensureIsolatedWorkspace(current: Run, signal: AbortSignal = new AbortController().signal): Promise<ExternalWorkspaceBinding | null> {
  if (config.externalAgents.workspaceMode !== 'isolated' || !current.workspace?.startsWith('ext:')) return null;
  const members = all<{ definition: string }>('SELECT definition FROM run_agent_snapshots WHERE run_id=?', current.id).map((row) => JSON.parse(row.definition));
  const orchestration = getRunOrchestrationSnapshot(current.id);
  const fixedReview = orchestration?.executionAuthority === 'orchestration' && !orchestration.execution?.readonly
    && ['development_review','supervisor_decomposition'].includes(orchestration.request.workflow);
  if (!fixedReview && !members.some((member) => member.execution?.kind === 'external' && ['claude-sdk', 'codex-app-server'].includes(member.execution.driver))) return null;
  const existing = preparing.get(current.id); if (existing) return existing;
  const promise = prepare(current, members, signal); preparing.set(current.id, promise);
  try { return await promise; } finally { preparing.delete(current.id); }
}
async function prepare(current: Run, members: any[], signal: AbortSignal): Promise<ExternalWorkspaceBinding> {
  const check = () => { if (signal.aborted) throw signal.reason instanceof ExecutionError ? signal.reason : new ExecutionError('cancelled', '隔离工作区准备已停止'); };
  check();
  const sourceRoot = await realpath(getExternalByIdOrThrow(current.workspace!.slice(4)).absPath);
  const conversationSession = members.some((member) => member.execution?.sessionPolicy === 'conversation');
  const key = conversationSession ? 'conversation-' + current.conversationId : 'run-' + current.id;
  await mkdir(config.externalAgents.workspaceDir, { recursive: true });
  const managedRoot = await realpath(config.externalAgents.workspaceDir);
  const root = path.resolve(managedRoot, key);
  if (!root.startsWith(managedRoot + path.sep)) throw new ExecutionError('policy_rejected', '隔离工作区路径无效');
  const release = await waitForDurableLease('prepare:' + root, 'prepare:' + current.id, false, signal);
  try {
    check();
    const existing = getIsolatedWorkspace(current.id);
    if (existing) {
      if (existing.status !== 'ready') throw new ExecutionError('interrupted', existing.error ?? '工作区准备曾中断，请检查隔离目录后创建新运行');
      if (existing.sourceRoot !== sourceRoot || await realpath(existing.cwd) !== existing.cwd) throw new ExecutionError('policy_rejected', '工作区绑定已改变');
      return existing;
    }
    if (conversationSession) {
      const prior = all<{ record: string }>('SELECT record FROM external_workspace_bindings ORDER BY rowid DESC').map((row) => JSON.parse(row.record) as ExternalWorkspaceBinding).find((item) => item.cwd === root && item.sourceRoot === sourceRoot);
      if (prior) {
        if (prior.status !== 'ready' || get<{ status: string }>('SELECT status FROM runs WHERE id=?', prior.runId)?.status !== 'completed' || all<{ status: string }>("SELECT status FROM external_agent_executions WHERE run_id=? AND status IN ('running','failed','cancelled','interrupted')", prior.runId).length) throw new ExecutionError('interrupted', '会话工作区存在未完成或失败执行，请等待前轮完成或使用新的聊天室');
        const binding = { ...prior, id: randomUUID(), runId: current.id, createdAt: new Date().toISOString() }; save(binding); return binding;
      }
    }
    const state = await sourceState(sourceRoot);
    const binding: ExternalWorkspaceBinding = { id: randomUUID(), runId: current.id, sourceRoot, sourceHead: state.head, sourceFingerprint: state.fingerprint,
      cwd: root, baseCommit: null, status: 'preparing', createdAt: new Date().toISOString(), error: null };
    save(binding);
    try {
      await mkdir(path.dirname(root), { recursive: true });
      await addWorktree(sourceRoot, sourceRoot, root, state.head, signal);
      check();
      if (state.patch.length) await git(root, ['apply', '--binary', '-'], state.patch);
      for (const file of state.files) { check(); await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await cp(path.join(sourceRoot, file), path.join(root, file), { dereference: false, verbatimSymlinks: true, preserveTimestamps: true }); }
      check();
      if ((await sourceState(sourceRoot)).fingerprint !== state.fingerprint) throw new ExecutionError('policy_rejected', '注册目录在复制期间发生变化，隔离快照不完整');
      binding.baseCommit = await createSnapshotCommit(root);
      await git(root, ['reset', '--mixed', binding.baseCommit]);
      check();
      binding.status = 'ready'; save(binding); return binding;
    } catch (error) { binding.status = 'attention'; binding.error = error instanceof Error ? error.message : String(error); save(binding); throw error; }
  } finally { release(); }
}
export async function createSnapshotCommit(cwd: string): Promise<string> {
  await git(cwd, ['add', '--all', '--', '.']);
  const tree = (await git(cwd, ['write-tree'])).toString().trim();
  return (await git(cwd, ['-c', 'user.name=agent-gand snapshot', '-c', 'user.email=snapshot@agent-gand.invalid', 'commit-tree', tree, '-p', 'HEAD', '-m', 'agent-gand immutable snapshot'])).toString().trim();
}
export async function captureWorkspaceSnapshot(runId: string, executionId: string, cwd: string): Promise<{ commit: string; path: string } | undefined> {
  const binding = getIsolatedWorkspace(runId); if (!binding || binding.cwd !== cwd) return undefined;
  const release = await waitForDurableLease('snapshot:' + cwd, 'snapshot:' + executionId, false, AbortSignal.timeout(30000));
  try {
    const commit = await createSnapshotCommit(cwd);
    const snapshotPath = path.resolve(await realpath(config.externalAgents.workspaceDir), 'snapshots', executionId);
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    await addWorktree(binding.sourceRoot, cwd, snapshotPath, commit, AbortSignal.timeout(30000));
    const snapshot = { commit, path: snapshotPath };
    binding.latestSnapshot = snapshot; save(binding);
    return snapshot;
  } finally { release(); }
}
export function reviewSnapshotPath(executionId?: string): string | undefined {
  if (!executionId) return undefined;
  const row = get<{ record: string }>('SELECT record FROM external_agent_executions WHERE id=?', executionId);
  const execution = row ? JSON.parse(row.record) : null;
  return execution?.snapshot?.path;
}
export async function exportWorkspacePatch(runId: string): Promise<string> {
  const binding = getIsolatedWorkspace(runId);
  if (!binding || binding.status !== 'ready' || !binding.baseCommit) throw new ExecutionError('policy_rejected', '没有可导出的隔离工作区');
  if (!binding.latestSnapshot) throw new ExecutionError('policy_rejected', '执行尚未产生可验证快照');
  return (await git(binding.cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', binding.baseCommit, binding.latestSnapshot.commit, '--', '.'])).toString();
}
