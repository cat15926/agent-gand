import path from 'node:path';
import { realpathSync } from 'node:fs';
import { config } from '../config.ts';

/** Defense for file tools, searches and workspace registration, including symlink aliases. */
export function isAccountPrivatePath(value: string): boolean {
  const absolute = path.resolve(value); const root = path.resolve(config.accounts.privateDir);
  let physicalRoot = root; let physical = absolute;
  try { physicalRoot = realpathSync(root); } catch {}
  try { physical = realpathSync(absolute); } catch {}
  return path.basename(absolute).toLowerCase() === 'account-master-key.json'
    || [absolute, physical].some((file) => [root, physicalRoot].some((dir) => file === dir || file.startsWith(dir + path.sep)));
}
