import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { isAccountPrivatePath } from '../accounts/privatePaths.ts';
import { managedPath } from './path.ts';
import { OrchestrationError } from '../orchestration/errors.ts';

export const snapshotHash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
export const SNAPSHOT_LIMITS = { fileBytes: 1024 * 1024, totalBytes: 16 * 1024 * 1024, maxFiles: 4000 };
export const snapshotFail = (code: string, message: string): never => { throw new OrchestrationError(409, code, message); };
export function snapshotPath(value: string): string {
  try { managedPath(value); } catch { snapshotFail('SNAPSHOT_PATH_UNSAFE', '快照路径包含越界、保留目录或无效字符'); }
  const parts = value.toLowerCase().split('/');
  if (parts.some(p => ['.aws','.ssh','.gnupg','node_modules','account-master-key.json','credentials.json','auth.json'].includes(p)
    || p === '.env' || p.startsWith('.env.') && !['.env.example','.env.sample'].includes(p)
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(p) || /\.(pem|p12|pfx|key)$/.test(p)))
    snapshotFail('SNAPSHOT_SENSITIVE_PATH', '凭据、登录目录、依赖目录或敏感文件不能进入快照');
  return value;
}
export function statIfPresent(target: string) {
  try { return lstatSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function safeDirectory(dir: string): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir || isAccountPrivatePath(dir))
    snapshotFail('SNAPSHOT_PATH_UNSAFE', '快照目录包含链接或受保护路径');
}
export function safeTarget(root: string, rel: string, createParents = false): string {
  snapshotPath(rel); safeDirectory(root);
  let parent = root;
  for (const part of rel.split('/').slice(0,-1)) {
    parent = path.join(parent,part);
    if (!statIfPresent(parent)) { if (createParents) mkdirSync(parent, { mode: 0o700 }); else return path.join(root,rel); }
    safeDirectory(parent);
  }
  const target = path.join(root,rel);
  if (isAccountPrivatePath(target)) snapshotFail('SNAPSHOT_SENSITIVE_PATH', '受保护的文件不能进入快照');
  return target;
}
/** No-follow descriptor plus parent and inode checks reject links and replacements during capture. */
export function readSnapshotFile(root: string, rel: string): { bytes: Buffer; mode: number; sourceMode: number } | null {
  const target = safeTarget(root,rel); const before = statIfPresent(target);
  if (!before) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > SNAPSHOT_LIMITS.fileBytes)
    snapshotFail('SNAPSHOT_FILE_UNSUPPORTED', '快照仅支持不超过 1 MiB 的普通单链接文件');
  const fd = openSync(target,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); const bytes = readFileSync(fd); const after = lstatSync(target);
    if (stat.ino !== before.ino || stat.dev !== before.dev || after.ino !== stat.ino || after.dev !== stat.dev
      || stat.nlink !== 1 || bytes.length !== stat.size || bytes.length > SNAPSHOT_LIMITS.fileBytes
      || realpathSync(target)!==target || stat.mode !== after.mode || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      snapshotFail('SNAPSHOT_DRIFTED', '读取期间文件或权限发生变化，请重新预览');
    return { bytes, mode: stat.mode & 0o111 ? 0o700 : 0o600, sourceMode:stat.mode & 0o777 };
  } finally { closeSync(fd); }
}
export function writeSnapshotFile(root: string, rel: string, bytes: Buffer, mode: number): void {
  const target = safeTarget(root,rel,true);
  if (statIfPresent(target)) snapshotFail('SNAPSHOT_TARGET_CONFLICT', '快照恢复目标已存在，禁止覆盖');
  const fd = openSync(target,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
  try { writeFileSync(fd,bytes); } finally { closeSync(fd); }
  chmodSync(target,mode);
}
