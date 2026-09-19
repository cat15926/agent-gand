import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function markdownFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await markdownFiles(full));
    else if (entry.name.toLowerCase().endsWith('.md')) result.push(full);
  }
  return result;
}

const missing = [];
for (const file of await markdownFiles(root)) {
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
