/**
 * 内置工具（规格 §4.2 tools/builtin/index.ts + §7.1 工具 schema + §9 per-run 沙箱）
 * fs.read/fs.write/search.files/shell.run 统一走 §9.2 路径 resolver（三段语义）；
 * http.get 不涉路径。目录模型见 §9.1：runs/<runId>/（run 内多 agent 共享）、shared/（跨 run）、
 * 根级遗留（archive/ 前缀只读访问，不移动不删除）。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.ts';
import type { LlmToolSchema } from '../../llm/provider.ts';
import { READONLY_TOOLS, ToolError, expectObject, expectString, type Tool } from '../types.ts';
import type { AgentDefinition } from '@agent-gand/shared';

/** §9.1 沙箱三段区域 */
type SandboxArea = 'run' | 'shared' | 'archive';

interface ResolvedSandboxPath {
  area: SandboxArea;
  absPath: string;
  /** archive → true（根级历史归档只读，写入被拒并提示用 shared/） */
  readOnly: boolean;
}

/** 当前 run 的独立工作区目录（shell.run 的 cwd、search.files 的 run 范围共用） */
export function runWorkspaceDir(runId: string): string {
  return path.join(config.sandboxDir, 'runs', runId);
}

/**
 * §9.2 路径解析规则（tools/builtin 统一 resolver）：
 * - 无前缀 → sandbox/runs/<runId>/...（run 内读写，run 间隔离）
 * - shared/ → sandbox/shared/...（跨 run 共享，读写）
 * - archive/ → sandbox/<去前缀路径>（根级历史遗留，只读）
 * - 绝对路径 / 以 / 开头 / 含 .. 段 → 拒绝（防逃逸）
 */
export function resolveSandboxPath(relPath: string, runId: string): ResolvedSandboxPath {
  if (
    path.isAbsolute(relPath) ||
    relPath.startsWith('/') ||
    relPath.split(/[\\/]+/).includes('..')
  ) {
    throw new ToolError(`路径被拒绝（禁止绝对路径、前导 / 或 .. 逃逸）: ${relPath}`);
  }
  const sandbox = path.resolve(config.sandboxDir);
  let area: SandboxArea;
  let absPath: string;
  if (relPath === 'shared' || relPath.startsWith('shared/')) {
    area = 'shared';
    absPath = path.resolve(sandbox, relPath);
  } else if (relPath === 'archive' || relPath.startsWith('archive/')) {
    area = 'archive';
    const legacy = relPath === 'archive' ? '' : relPath.slice('archive/'.length);
    absPath = path.resolve(sandbox, legacy);
    // archive/ 只映射根级遗留：借道 archive/runs/<其他run>/ 或 archive/shared/ 绕过隔离 → 拒绝
    if (legacy === 'runs' || legacy.startsWith('runs/') || legacy === 'shared' || legacy.startsWith('shared/')) {
      throw new ToolError(`archive/ 仅访问根级历史归档，不能指向 runs/ 或 shared/: ${relPath}`);
    }
  } else {
    area = 'run';
    absPath = path.resolve(runWorkspaceDir(runId), relPath);
  }
  // 兜底防逃逸：解析结果必须落在沙箱内（覆盖盘符等 path.isAbsolute 未拦的变体）
  if (absPath !== sandbox && !absPath.startsWith(sandbox + path.sep)) {
    throw new ToolError(`路径越出沙箱目录: ${relPath}`);
  }
  return { area, absPath, readOnly: area === 'archive' };
}

/** 三段路径语义的 schema 描述（告知模型，减少试错——规格 §9.2） */
const PATH_SEMANTICS =
  '路径三段语义：无前缀=当前 run 独立工作区；shared/xxx=跨 run 共享区；archive/xxx=历史归档（只读）。禁止绝对路径与 ..';

const fsRead: Tool = {
  name: 'fs.read',
  description: '读取沙箱内文本文件（当前 run 工作区 / shared/ 共享区 / archive/ 历史归档）',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: PATH_SEMANTICS,
      },
    },
    required: ['path'],
  },
  async run(input, ctx) {
    const obj = expectObject(input);
    const { absPath } = resolveSandboxPath(expectString(obj, 'path'), ctx.runId);
    try {
      const content = readFileSync(absPath, 'utf-8');
      return content.slice(0, 10_000);
    } catch {
      throw new ToolError(`读取失败（文件不存在或不可读）: ${obj.path}`);
    }
  },
};

const fsWrite: Tool = {
  name: 'fs.write',
  description: '写入沙箱内文本文件（当前 run 工作区或 shared/ 共享区，自动建目录）',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: `${PATH_SEMANTICS}；archive/ 只读不可写，跨 run 共享请写 shared/`,
      },
      content: { type: 'string', description: '写入的文本内容' },
    },
    required: ['path', 'content'],
  },
  async run(input, ctx) {
    const obj = expectObject(input);
    const rel = expectString(obj, 'path');
    const { absPath, readOnly } = resolveSandboxPath(rel, ctx.runId);
    if (readOnly) {
      throw new ToolError(`archive/ 是历史归档只读区，不可写入（跨 run 共享请用 shared/ 前缀）: ${rel}`);
    }
    const content = typeof obj.content === 'string' ? obj.content : '';
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
    return `已写入 ${content.length} 字符 → ${rel}`;
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

function execFileP(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 3000 }, (err, stdout, stderr) => {
      if (err) reject(new ToolError(stderr.length > 0 ? stderr : String(err)));
      else resolve(String(stdout));
    });
  });
}

const shellRun: Tool = {
  name: 'shell.run',
  description: '执行白名单命令（echo/date/pwd），工作目录为当前 run 的沙箱工作区',
  inputSchema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: '命令名（仅 echo/date/pwd）' },
      args: { type: 'array', items: { type: 'string' }, description: '参数列表' },
    },
    required: ['cmd'],
  },
  async run(input, ctx) {
    const obj = expectObject(input);
    const cmd = expectString(obj, 'cmd');
    if (!SHELL_WHITELIST.has(cmd)) {
      throw new ToolError(`命令不在白名单内（仅 ${[...SHELL_WHITELIST].join('/')}）: ${cmd}`);
    }
    const args = Array.isArray(obj.args) ? obj.args.filter((a): a is string => typeof a === 'string') : [];
    // §9.2：cwd = 当前 run 工作区（不存在则建，pwd/相对操作都以 run 目录为根）
    const runDir = runWorkspaceDir(ctx.runId);
    mkdirSync(runDir, { recursive: true });
    return (await execFileP(cmd, args, runDir)).trim();
  },
};

/** 递归收集目录下文件（跳过 sqlite 二进制）；exclude 目录名集合整棵跳过 */
function walkFiles(dir: string, out: string[] = [], exclude: Set<string> = new Set()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // 目录不存在（如 run 工作区尚未创建）
  }
  for (const entry of entries) {
    if (exclude.has(entry)) continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(full, out, exclude);
    else if (!/\.sqlite(-wal|-shm)?$/.test(entry)) out.push(full);
  }
  return out;
}

const searchFiles: Tool = {
  name: 'search.files',
  description:
    '在当前 run 工作区、shared/ 共享区与 archive/（根级历史归档）做大小写不敏感的文本搜索（grep），返回前 50 条命中',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '搜索关键词（命中路径按三段语义标注前缀）' },
      maxResults: { type: 'integer', description: '最大命中数（默认 50）' },
    },
    required: ['pattern'],
  },
  async run(input, ctx) {
    const obj = expectObject(input);
    const pattern = expectString(obj, 'pattern').toLowerCase();
    // maxResults：可选，夹取到 [1, 200]（与 schema 声明一致）
    const maxResults =
      typeof obj.maxResults === 'number' && Number.isFinite(obj.maxResults)
        ? Math.min(Math.max(1, Math.round(obj.maxResults)), 200)
        : 50;
    const sandbox = path.resolve(config.sandboxDir);
    // §9.2：搜索范围=当前 run 工作区 + shared/ + 根级遗留（archive 视图）；
    // 其他 run 的 runs/<id>/ 目录不可见（per-run 隔离）。结果路径带三段语义前缀。
    const scopes: Array<{ dir: string; prefix: string }> = [
      { dir: runWorkspaceDir(ctx.runId), prefix: '' },
      { dir: path.join(sandbox, 'shared'), prefix: 'shared/' },
      { dir: sandbox, prefix: 'archive/' },
    ];
    const results: string[] = [];
    for (const { dir, prefix } of scopes) {
      // 根级遍历时跳过 runs/ 与 shared/（已有各自范围，避免重复且不泄露其他 run）
      const files = dir === sandbox ? walkFiles(dir, [], new Set(['runs', 'shared'])) : walkFiles(dir);
      for (const file of files) {
        if (results.length >= maxResults) break;
        let content: string;
        try {
          content = readFileSync(file, 'utf-8');
        } catch {
          continue; // 非文本/不可读文件跳过
        }
        const rel = `${prefix}${path.relative(dir, file)}`;
        for (const [i, line] of content.split('\n').entries()) {
          if (results.length >= maxResults) break;
          if (line.toLowerCase().includes(pattern)) {
            results.push(`${rel}:${i + 1}: ${line.trim().slice(0, 160)}`);
          }
        }
      }
      if (results.length >= maxResults) break;
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
