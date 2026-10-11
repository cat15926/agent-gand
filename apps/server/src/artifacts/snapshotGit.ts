import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactSnapshot } from '@agent-gand/shared';
import { isAccountPrivatePath } from '../accounts/privatePaths.ts';
import { snapshotFail, snapshotHash, snapshotPath, SNAPSHOT_LIMITS, writeSnapshotFile } from './snapshotFiles.ts';

export function snapshotGit(root: string, args: string[], input?: Buffer): Buffer {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','submodule.recurse=false',...args],
    { cwd:root, env:{...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_NO_REPLACE_OBJECTS:'1'}, input,
      timeout:10000,maxBuffer:SNAPSHOT_LIMITS.totalBytes,stdio:['pipe','pipe','pipe'] });
}
export function captureSnapshotGit(root: string, commit?: string): { git: ArtifactSnapshot['git']; pack?: string } {
  let head: string;
  try {
    if (snapshotGit(root,['rev-parse','--show-toplevel']).toString().trim() !== root) return {git:null};
    head = snapshotGit(root,['rev-parse','--verify',commit ?? 'HEAD']).toString().trim();
  } catch { return {git:null}; }
  if (!/^[a-f0-9]{40,64}$/.test(head!)) snapshotFail('SNAPSHOT_GIT_INVALID','仓库基线无效');
  const tree = snapshotGit(root,['rev-parse',head!+'^{tree}']).toString().trim();
  const objects = new Set([head!,tree]); const files: NonNullable<ArtifactSnapshot['git']>['files'] = [];
  let total = 0;
  for (const line of snapshotGit(root,['ls-tree','-r','-t','-z',head!]).toString().split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t(.+)$/s.exec(line);
    if (!match) snapshotFail('SNAPSHOT_GIT_INVALID','Git 基线条目无效');
    const [,mode,type,oid,rel] = match!; snapshotPath(rel!);
    if(isAccountPrivatePath(path.join(root,rel!))) snapshotFail('SNAPSHOT_SENSITIVE_PATH','Git 基线跟踪了账户私有文件或平台数据库，拒绝归档');
    if (type === 'commit' || type === 'blob' && !['100644','100755'].includes(mode!))
      snapshotFail('SNAPSHOT_GIT_UNSUPPORTED','Git 基线包含子模块、链接或不支持的类型');
    objects.add(oid!);
    if (type === 'tree') continue;
    const size = Number(snapshotGit(root,['cat-file','-s',oid!]).toString()); total += size;
    if (size > SNAPSHOT_LIMITS.fileBytes || total > SNAPSHOT_LIMITS.totalBytes || files.length >= SNAPSHOT_LIMITS.maxFiles)
      snapshotFail('SNAPSHOT_TOO_LARGE','Git 基线超过快照大小或文件数量限制');
    const bytes = snapshotGit(root,['cat-file','blob',oid!]);
    files.push({path:rel!,sha256:snapshotHash(bytes),size:bytes.length,mode:mode === '100755' ? 0o700 : 0o600,objectId:oid!});
  }
  // Only this commit and its tree closure. No history, remotes, config, hooks or native homes.
  const pack = snapshotGit(root,['pack-objects','--stdout','--threads=1'],Buffer.from([...objects].sort().join('\n')+'\n'));
  return {git:{commit:head!,tree,packSha256:snapshotHash(pack),files},pack:pack.toString('base64')};
}
export function restoreSnapshotGit(root: string, baseline: NonNullable<ArtifactSnapshot['git']>, encoded: string): void {
  const pack = Buffer.from(encoded,'base64');
  if (snapshotHash(pack) !== baseline.packSha256) snapshotFail('SNAPSHOT_CORRUPT','Git 基线包哈希无效');
  snapshotGit(root,['init','--template=','--quiet']);
  snapshotGit(root,['unpack-objects','-q'],pack);
  if (snapshotGit(root,['rev-parse',baseline.commit+'^{tree}']).toString().trim() !== baseline.tree)
    snapshotFail('SNAPSHOT_CORRUPT','Git 基线 commit 与 tree 不一致');
  const treeFiles = snapshotGit(root,['ls-tree','-r','-z',baseline.commit]).toString().split('\0').filter(Boolean);
  if (treeFiles.length !== baseline.files.length) snapshotFail('SNAPSHOT_CORRUPT','Git 基线清单不完整');
  for (const file of baseline.files) {
    snapshotPath(file.path);
    const mode = file.mode === 0o700 ? '100755' : '100644';
    if (!treeFiles.includes(`${mode} blob ${file.objectId}\t${file.path}`)) snapshotFail('SNAPSHOT_CORRUPT','Git 文件版本与基线不一致');
    const bytes = snapshotGit(root,['cat-file','blob',file.objectId]);
    if (bytes.length !== file.size || snapshotHash(bytes) !== file.sha256) snapshotFail('SNAPSHOT_CORRUPT','Git 基线文件哈希无效');
    writeSnapshotFile(root,file.path,bytes,file.mode);
  }
  // Shallow boundary makes the exact source commit self-contained after the old repository is removed.
  mkdirSync(path.join(root,'.git'),{recursive:true});
  writeFileSync(path.join(root,'.git','shallow'),baseline.commit+'\n',{mode:0o600});
  snapshotGit(root,['update-ref','refs/heads/snapshot',baseline.commit]);
  snapshotGit(root,['symbolic-ref','HEAD','refs/heads/snapshot']);
  snapshotGit(root,['read-tree',baseline.commit]);
}
