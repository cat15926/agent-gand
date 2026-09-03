/**
 * 内置工具（规格 §4.2 tools/builtin/index.ts + §7.1 工具 schema）
 * fs.read/fs.write（沙箱限定 data/sandbox/）、http.get、shell.run（白名单 echo/date/pwd）、search.files（对 data/ grep）
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.ts';
import type { LlmToolSchema } from '../../llm/provider.ts';
import { READONLY_TOOLS, ToolError, expectObject, expectString, type Tool } from '../types.ts';
import type { AgentDefinition } from '@agent-gand/shared';

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
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: '路径相对沙箱根目录（apps/server/data/sandbox/），勿加 data/ 或 sandbox/ 前缀',
      },
    },
    required: ['path'],
  },
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
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱内相对路径' },
      content: { type: 'string', description: '写入的文本内容' },
    },
    required: ['path', 'content'],
  },
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
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: '完整的 http(s) 地址' } },
    required: ['url'],
  },
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
  inputSchema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: '命令名（仅 echo/date/pwd）' },
      args: { type: 'array', items: { type: 'string' }, description: '参数列表' },
    },
    required: ['cmd'],
  },
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
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索关键词' },
      maxResults: { type: 'integer', description: '最大命中数（默认 50）' },
    },
    required: ['pattern'],
  },
  async run(input) {
    const obj = expectObject(input);
    const pattern = expectString(obj, 'pattern').toLowerCase();
    // maxResults：可选，夹取到 [1, 200]（与 schema 声明一致）
    const maxResults =
      typeof obj.maxResults === 'number' && Number.isFinite(obj.maxResults)
        ? Math.min(Math.max(1, Math.round(obj.maxResults)), 200)
        : 50;
    const results: string[] = [];
    for (const file of walkFiles(config.dataDir)) {
      if (results.length >= maxResults) break;
      let content: string;
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        continue; // 非文本/不可读文件跳过
      }
      const rel = path.relative(config.dataDir, file);
      for (const [i, line] of content.split('\n').entries()) {
        if (results.length >= maxResults) break;
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

/** 按工具名列表生成传给真实 LLM 的 tools schema（找不到的名字跳过） */
export function toolSchemas(names: string[]): LlmToolSchema[] {
  const schemas: LlmToolSchema[] = [];
  for (const name of names) {
    const tool = registry.get(name);
    if (tool) {
      schemas.push({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
    }
  }
  return schemas;
}

/**
 * 按权限三档决定下发给 LLM 的工具 schema 集合（执行时仍走 checkPermission 门控）：
 * - readonly：只读工具集（该档也只放行这些）
 * - auto：白名单（白名单外一律 deny，没必要邀请模型调用）
 * - confirm：全量下发——"白名单外需审批"这档语义要求模型能请求白名单外工具，
 *   否则真实 LLM 永远不会触发审批（mock 靠 [tool:X] 标记才能演示）
 */
export function toolsForAgent(agent: AgentDefinition): LlmToolSchema[] {
  if (agent.permissionMode === 'readonly') return toolSchemas([...READONLY_TOOLS]);
  if (agent.permissionMode === 'auto') return toolSchemas(agent.tools);
  return toolSchemas(listToolNames());
}
