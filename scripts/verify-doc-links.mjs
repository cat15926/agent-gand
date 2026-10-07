import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Check project sources, including new documents. Never traverse ignored private
// account directories or client-generated skill caches as repository docs.
const { stdout } = await promisify(execFile)('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
const markdownFiles = [...new Set(stdout.split('\0').filter(file => file.toLowerCase().endsWith('.md')))];

const missing = [];
for (const relative of markdownFiles) {
  const file = path.join(root, relative);
  try { await stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#|codex:)/.test(target)) continue;
    target = decodeURIComponent(target.split('#')[0] ?? '');
    if (!target) continue;
    try {
      await stat(path.resolve(path.dirname(file), target));
    } catch {
      missing.push(`${path.relative(root, file)} -> ${target}`);
    }
  }
}

if (missing.length > 0) {
  console.error(`发现 ${missing.length} 个失效的本地 Markdown 链接：\n${missing.join('\n')}`);
  process.exit(1);
}
console.log('文档本地链接校验通过');
