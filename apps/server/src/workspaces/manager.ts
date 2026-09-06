/**
 * 内部工作区管理（规格 §11.1 M1 / §11.2 browse）
 * 元数据列表（文件数/关联 run 数/最近目标）、重命名、复制、删除归档（移入
 * sandbox/_deleted-workspaces/，不物理删除——只增不删原则）、本机目录浏览器。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { get } from '../db/database.ts';

export interface WorkspaceMeta {
  name: string;
  modifiedAt: string;
  fileCount: number;
  runCount: number;
  lastGoal: string | null;
}

export class WorkspaceManageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'WorkspaceManageError';
  }
}

/** 工作区名（与 API/resolver 同规） */
const NAME_RE = /^[\w-]{1,32}$/;

function workspacesRoot(): string {
  return path.join(config.sandboxDir, 'workspaces');
}

function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new WorkspaceManageError('工作区名只允许字母/数字/下划线/连字符，长度 1-32', 400);
  }
}

function wsDir(name: string): string {
  assertValidName(name);
  return path.join(workspacesRoot(), name);
}

/** 递归文件计数（不跟随符号链接；目录缺失返回 0） */
function countFiles(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

/** §11.1：卡片元数据（最后使用 = 目录 mtime；runCount/lastGoal 查 runs 表） */
export function listWorkspaceMetas(): WorkspaceMeta[] {
  let entries: string[];
  try {
    entries = readdirSync(workspacesRoot());
  } catch {
    return [];
  }
  const out: WorkspaceMeta[] = [];
  for (const name of entries) {
    if (!NAME_RE.test(name)) continue;
    const dir = path.join(workspacesRoot(), name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const stats = get<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE workspace = ?', name);
    const last = get<{ goal: string }>('SELECT goal FROM runs WHERE workspace = ? ORDER BY created_at DESC LIMIT 1', name);
    out.push({
      name,
      modifiedAt: new Date(statSync(dir).mtimeMs).toISOString(),
      fileCount: countFiles(dir),
      runCount: stats?.n ?? 0,
      lastGoal: last?.goal ?? null,
    });
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

/** §11.1 重命名：目录改名（历史 run 记录保留旧名，属可接受的历史语义） */
export function renameWorkspace(from: string, to: string): WorkspaceMeta {
  const fromDir = wsDir(from);
  const toDir = wsDir(to);
  if (!existsSync(fromDir)) throw new WorkspaceManageError(`工作区不存在: ${from}`, 404);
  if (existsSync(toDir)) throw new WorkspaceManageError(`目标名已存在: ${to}`, 409);
  renameSync(fromDir, toDir);
  return listWorkspaceMetas().find((w) => w.name === to)!;
}

/** §11.1 复制：<name>-copy（存在则 -copy2/-copy3…） */
export function duplicateWorkspace(name: string): WorkspaceMeta {
  const src = wsDir(name);
  if (!existsSync(src)) throw new WorkspaceManageError(`工作区不存在: ${name}`, 404);
  let target = `${name}-copy`;
  for (let i = 2; existsSync(wsDir(target)); i += 1) target = `${name}-copy${i}`;
  const targetDir = wsDir(target);
  mkdirSync(path.dirname(targetDir), { recursive: true });
  cpSync(src, targetDir, { recursive: true });
  return listWorkspaceMetas().find((w) => w.name === target)!;
}

/** §11.1 删除：确认后移入 sandbox/_deleted-workspaces/<name>-<ISO时间> 归档（不物理删除） */
export function deleteWorkspace(name: string, confirm: boolean): { archivedAs: string } {
  if (confirm !== true) throw new WorkspaceManageError('删除需显式确认（confirm:true）', 400);
  const dir = wsDir(name);
  if (!existsSync(dir)) throw new WorkspaceManageError(`工作区不存在: ${name}`, 404);
  const archiveRoot = path.join(config.sandboxDir, '_deleted-workspaces');
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archivedAs = `${name}-${stamp}`;
  renameSync(dir, path.join(archiveRoot, archivedAs));
  return { archivedAs };
}

/** §11.1 自动名建议：目标关键词 slug 优先（task-MMDD-<slug>），否则 task-MMDD；撞名追加 -2/-3… */
export function suggestWorkspaceName(goal: string | undefined): string {
  const now = new Date();
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const latin = (goal ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .find((w) => w.length >= 2) ?? '';
  const base = latin !== '' ? `task-${mmdd}-${latin}`.slice(0, 24) : `task-${mmdd}`;
  const valid = NAME_RE.test(base) ? base : `task-${mmdd}`;
  let candidate = valid;
  for (let i = 2; existsSync(wsDir(candidate)); i += 1) candidate = `${valid}-${i}`.slice(0, 32);
  return candidate;
}

export interface BrowseResult {
  current: string;
  dirs: Array<{ name: string; path: string }>;
}

/** §11.2 目录浏览器：只列目录、跳过点开头；缺省=用户主目录。仅本地单用户场景（README 注明）。
 *  current 经 realpath 消解（§11.3 inspector 补充：符号链接显示真实位置，避免误注册歧义路径）。 */
export function browseDirs(inputPath: string | undefined): BrowseResult {
  const target = inputPath && inputPath.trim().length > 0 ? path.resolve(inputPath.trim()) : homedir();
  let real: string;
  let entries: string[];
  try {
    real = realpathSync(target);
    entries = readdirSync(real);
  } catch {
    throw new WorkspaceManageError(`目录不可访问: ${target}`, 400);
  }
  const dirs: Array<{ name: string; path: string }> = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue; // 跳过点开头
    const full = path.join(real, entry);
    try {
      if (statSync(full).isDirectory()) dirs.push({ name: entry, path: full });
    } catch {
      continue; // 无权限等跳过
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  return { current: real, dirs };
}
