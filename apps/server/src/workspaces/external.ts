/**
 * 外部工作区注册表（规格 §11.2 M2）
 * 本机目录注册为 run 可用的工作区：workspace 字符串约定 ext:<id> 指向注册根。
 * 注册时取 realpath（解析符号链接，登记真实位置）；解除注册不动文件。
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { all, get, run } from '../db/database.ts';

export interface ExternalWorkspace {
  id: string;
  label: string;
  absPath: string;
  createdAt: string;
}

interface ExternalRow {
  id: string;
  label: string;
  abs_path: string;
  created_at: string;
}

function rowToExternal(row: ExternalRow): ExternalWorkspace {
  return { id: row.id, label: row.label, absPath: row.abs_path, createdAt: row.created_at };
}

export class ExternalWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ExternalWorkspaceError';
  }
}

/** workspace 字符串是否为外部约定（ext:<id>） */
export function isExternalWorkspace(workspace: string | null | undefined): workspace is string {
  return typeof workspace === 'string' && workspace.startsWith('ext:') && workspace.length > 4;
}

/** 取外部 id（去 ext: 前缀）；非外部形态返回 null */
export function externalId(workspace: string | null | undefined): string | null {
  return isExternalWorkspace(workspace) ? workspace.slice('ext:'.length) : null;
}

export function listExternal(): ExternalWorkspace[] {
  return all<ExternalRow>('SELECT * FROM external_workspaces ORDER BY created_at DESC').map(rowToExternal);
}

export function getExternal(id: string): ExternalWorkspace | undefined {
  const row = get<ExternalRow>('SELECT * FROM external_workspaces WHERE id = ?', id);
  return row ? rowToExternal(row) : undefined;
}

/** 按注册根路径反查（写审批 reason 用目录真实路径） */
export function getExternalByIdOrThrow(id: string): ExternalWorkspace {
  const found = getExternal(id);
  if (!found) throw new ExternalWorkspaceError(`外部工作区未注册: ${id}`, 404);
  return found;
}

/**
 * 注册本机目录：必须存在且为目录；取 realpath 登记（唯一）。
 * 同一路径重复注册 → 409（返回既有记录由调用方决定文案）。
 */
export function registerExternal(input: { path: string; label?: string }): ExternalWorkspace {
  let real: string;
  try {
    real = realpathSync(path.resolve(input.path));
  } catch {
    throw new ExternalWorkspaceError(`路径不存在或不可访问: ${input.path}`, 400);
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    throw new ExternalWorkspaceError(`路径不可访问: ${real}`, 400);
  }
  if (!st.isDirectory()) throw new ExternalWorkspaceError(`不是目录（仅支持目录注册）: ${input.path}`, 400);
  const existing = get<ExternalRow>('SELECT * FROM external_workspaces WHERE abs_path = ?', real);
  if (existing) {
    throw new ExternalWorkspaceError(`该目录已注册（id=${existing.id}）: ${existing.abs_path}`, 409);
  }
  const record: ExternalWorkspace = {
    // 短 id：workspace 串为 ext:<id>，保持轻量可读
    id: randomUUID().replace(/-/g, '').slice(0, 8),
    label: input.label && input.label.trim().length > 0 ? input.label.trim() : path.basename(real),
    absPath: real,
    createdAt: new Date().toISOString(),
  };
  run(
    'INSERT INTO external_workspaces (id, label, abs_path, created_at) VALUES (?, ?, ?, ?)',
    record.id,
    record.label,
    record.absPath,
    record.createdAt,
  );
  return record;
}

/** 解除注册（不动磁盘文件）；id 不存在 → 404 */
export function unregisterExternal(id: string): void {
  const changes = run('DELETE FROM external_workspaces WHERE id = ?', id);
  if (changes === 0) throw new ExternalWorkspaceError(`外部工作区未注册: ${id}`, 404);
}

/** §12.3 label 编辑：仅更新注册表显示名，不动磁盘 */
export function updateExternalLabel(id: string, label: string): ExternalWorkspace {
  if (label.trim().length === 0) throw new ExternalWorkspaceError('label 不能为空', 400);
  const changes = run('UPDATE external_workspaces SET label = ? WHERE id = ?', label.trim(), id);
  if (changes === 0) throw new ExternalWorkspaceError(`外部工作区未注册: ${id}`, 404);
  return getExternalByIdOrThrow(id);
}

/**
 * §12.3 在 Finder 中显示——用户直接操作语义（同 Finder 的 reveal），仅对已注册项生效（§12.5 分线）。
 * 仅支持 darwin（本项目本机单用户场景）；打开失败原样报错。
 */
export function revealExternal(id: string): { ok: true; path: string } {
  const ws = getExternalByIdOrThrow(id); // 未注册 → 404
  if (process.platform !== 'darwin') {
    throw new ExternalWorkspaceError(`当前平台不支持 Finder 定位（${process.platform}）`, 400);
  }
  try {
    execFileSync('open', [ws.absPath], { stdio: 'ignore' });
  } catch (err) {
    throw new ExternalWorkspaceError(`打开失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  return { ok: true, path: ws.absPath };
}
