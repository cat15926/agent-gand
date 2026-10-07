import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionError } from './errors.ts';

// The client installs this cache during login/inspection too. Keep it on disk,
// but never load bundled skills into a platform-controlled invocation.
export const CODEX_SKILL_POLICY = ['-c', 'skills.bundled.enabled=false'];

export async function assertCodexHomePolicy(home: string): Promise<void> {
  const reject = () => new ExecutionError('policy_rejected', 'Codex 专用执行目录包含自定义配置、规则或插件，拒绝启动');
  const entries = await readdir(home);
  if (entries.some(name => ['config.toml', 'rules', 'plugins', 'agents'].includes(name) || name.endsWith('.config.toml'))) throw reject();
  if (!entries.includes('skills')) return;
  const skills = path.join(home, 'skills');
  const stat = await lstat(skills);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw reject();
  const children = await readdir(skills);
  if (!children.length) return;
  if (children.length !== 1 || children[0] !== '.system') throw reject();
  const cache = path.join(skills, '.system');
  const cacheStat = await lstat(cache);
  if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) throw reject();
  try {
    const marker = path.join(cache, '.codex-system-skills.marker');
    const markerStat = await lstat(marker);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 64
      || !/^[0-9a-f]{1,32}\s*$/.test(await readFile(marker, 'utf8'))) throw reject();
  } catch { throw reject(); }
  // A marker identifies the cache, not trusted instructions. CODEX_SKILL_POLICY
  // excludes this entire namespace, including modified/stale cache contents.
}
