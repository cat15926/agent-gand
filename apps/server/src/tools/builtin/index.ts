/**
 * 内置工具（规格 §4.2 tools/builtin/index.ts）
 * fs.read/fs.write（沙箱限定 data/sandbox/）、http.get、shell.run（白名单 echo/date/pwd）、search.files（对 data/ grep）
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.ts';
import { ToolError, expectObject, expectString, type Tool } from '../types.ts';

/** 限定在沙箱目录内，防止路径逃逸（../ 等） */
function resolveInSandbox(relPath: string): string {
  const sandbox = path.resolve(config.sandboxDir);
  const resolved = path.resolve(sandbox, relPath);
  if (resolved !== sandbox && !resolved.startsWith(sandbox + path.sep)) {
    throw new ToolError(`路径越出沙箱目录: ${relPath}`);
  }
  return resolved;
}

const fsRead: Tool = {
  name: 'fs.read',
  description: '读取沙箱内文本文件',
  async run(input) {
    const obj = expectObject(input);
    const file = resolveInSandbox(expectString(obj, 'path'));
    try {
      const content = readFileSync(file, 'utf-8');
      return content.slice(0, 10_000);
    } catch {
      throw new ToolError(`读取失败（文件不存在或不可读）: ${obj.path}`);
    }
  },
};

const fsWrite: Tool = {
  name: 'fs.write',
  description: '写入沙箱内文本文件（自动建目录）',
  async run(input) {
    const obj = expectObject(input);
    const file = resolveInSandbox(expectString(obj, 'path'));
    const content = typeof obj.content === 'string' ? obj.content : '';
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf-8');
    return `已写入 ${content.length} 字符 → ${String(obj.path)}`;
  },
};

const httpGet: Tool = {
  name: 'http.get',
  description: 'GET 一个 http(s) URL，返回状态与正文前 2000 字符',
  async run(input) {
    const obj = expectObject(input);
    const url = expectString(obj, 'url');
    if (!/^https?:\/\//.test(url)) throw new ToolError('url 必须以 http(s):// 开头');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const body = (await res.text()).slice(0, 2000);
      return `HTTP ${res.status} ${res.statusText}\n${body}`;
    } catch (err) {
      throw new ToolError(`请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

/** shell.run 白名单：仅这三个无副作用命令 */
const SHELL_WHITELIST = new Set(['echo', 'date', 'pwd']);

function execFileP(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) reject(new ToolError(stderr.length > 0 ? stderr : String(err)));
      else resolve(String(stdout));
    });
  });
}

const shellRun: Tool = {
  name: 'shell.run',
  description: '执行白名单命令（echo/date/pwd），不经过 shell 解释器',
  async run(input) {
    const obj = expectObject(input);
    const cmd = expectString(obj, 'cmd');
    if (!SHELL_WHITELIST.has(cmd)) {
      throw new ToolError(`命令不在白名单内（仅 ${[...SHELL_WHITELIST].join('/')}）: ${cmd}`);
    }
    const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === 'string') : [];
    return (await execFileP(cmd, args)).trim();
  },
};

/** 递归收集目录下文件（跳过 sqlite 二进制） */
function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else if (!/\.sqlite(-wal|-shm)?$/.test(entry)) out.push(full);
  }
  return out;
}

const searchFiles: Tool = {
  name: 'search.files',
  description: '在 data/ 目录下做大小写不敏感的文本搜索（grep），返回前 50 条命中',
  async run(input) {
    const obj = expectObject(input);
    const pattern = expectString(obj, 'pattern').toLowerCase();
    const results: string[] = [];
    for (const file of walkFiles(config.dataDir)) {
      if (results.length >= 50) break;
      let content: string;
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        continue; // 非文本/不可读文件跳过
      }
      const rel = path.relative(config.dataDir, file);
      for (const [i, line] of content.split('\n').entries()) {
        if (results.length >= 50) break;
        if (line.toLowerCase().includes(pattern)) {
          results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
        }
      }
    }
    return results.length === 0 ? `未命中: ${pattern}` : results.join('\n');
  },
};

export const builtinTools: Tool[] = [fsRead, fsWrite, httpGet, shellRun, searchFiles];

const registry = new Map(builtinTools.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listToolNames(): string[] {
  return [...registry.keys()];
}
