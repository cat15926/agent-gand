/**
 * 内置工具（规格 §4.2 tools/builtin/index.ts + §7.1 工具 schema + §9 per-run 沙箱）
 * fs.read/fs.write/search.files/shell.run 统一走 §9.2 路径 resolver（三段语义）；
 * http.get 不涉路径。目录模型见 §9.1：runs/<runId>/（run 内多 agent 共享）、shared/（跨 run）、
 * 根级遗留（archive/ 前缀只读访问，不移动不删除）。
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../config.ts';
import type { LlmToolSchema } from '../../llm/provider.ts';
import { READONLY_TOOLS, ToolError, expectObject, expectString, type Tool } from '../types.ts';
import type { AgentDefinition } from '@agent-gand/shared';
import { externalId, getExternalByIdOrThrow, isExternalWorkspace } from '../../workspaces/external.ts';

/** §9.1 沙箱区域（§10 后无前缀区可为 run 专属或命名工作区） */
type SandboxArea = 'run' | 'shared' | 'archive';

interface ResolvedSandboxPath {
  area: SandboxArea;
  absPath: string;
  /** archive → true（根级历史归档只读，写入被拒并提示用 shared/） */
  readOnly: boolean;
}

/** 命名工作区合法字符（§10.2，与 API 侧校验一致；resolver 处再做防御） */
const WORKSPACE_NAME_RE = /^[\w-]{1,32}$/;

/**
 * 当前 run 的无前缀工作区根目录（§10.1/10.2 + §11.3）：
 * - ext:<id> → 注册的外部本机目录（包含性检查以注册根为界）
 * - 命名工作区 → sandbox/workspaces/<name>/（跨 run 复用）
 * - 缺省 → sandbox/runs/<runId>/（run 专属）
 * shell.run 的 cwd、search.files 的本区范围共用此函数。
 */
export function workspaceRootDir(ctx: { runId: string; workspace?: string | null }): string {
  const ws = ctx.workspace ?? null;
  if (isExternalWorkspace(ws)) {
    return getExternalByIdOrThrow(externalId(ws)!).absPath; // 未注册 → ToolError 语义的领域错误
  }
  if (ws !== null && !WORKSPACE_NAME_RE.test(ws)) {
    throw new ToolError(`工作区名非法（只允许字母/数字/下划线/连字符，1-32 位）: ${ws}`);
  }
  return ws === null ? path.join(config.sandboxDir, 'runs', ctx.runId) : path.join(config.sandboxDir, 'workspaces', ws);
}

/** run 工作区是否为外部注册目录（§11.3：前缀禁用/写审批的判定基础） */
export function isExternalRun(ctx: { workspace?: string | null }): boolean {
  return isExternalWorkspace(ctx.workspace ?? null);
}

/** 兼容旧名（§9 时期语义）：run 专属目录 */
export function runWorkspaceDir(runId: string): string {
  return path.join(config.sandboxDir, 'runs', runId);
}

/**
 * realpath 消解（§11.3 inspector 补充：防符号链接绕过注册根边界）：
 * 目标不存在（如待写入的新文件）时向上找最近存在的祖先消解，再拼回余下部分。
 */
function resolveReal(absPath: string): string {
  let current = absPath;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absPath; // 到根都不存在：原样返回（后续包含检查兜底拦截）
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * §9.2/§10.2/§11.3 路径解析规则（tools/builtin 统一 resolver）：
 * - 无前缀 → 工作区根目录（外部注册根 / 命名工作区 / run 专属）
 * - shared/ → sandbox/shared/...（跨 run 共享，读写；写入由编排侧强制审批）——外部工作区内禁用
 * - archive/ → sandbox/<去前缀路径>（根级历史遗留，只读）——外部工作区内禁用
 * - 绝对路径 / 以 / 开头 / 含 .. 段 → 拒绝（防逃逸）
 * - 外部工作区：包含性检查以注册根为界，且经 realpath 消解后再判（防 symlink 逃逸）
 */
export function resolveSandboxPath(
  relPath: string,
  ctx: { runId: string; workspace?: string | null },
): ResolvedSandboxPath {
  if (
    path.isAbsolute(relPath) ||
    relPath.startsWith('/') ||
    relPath.split(/[\\/]+/).includes('..')
  ) {
    throw new ToolError(`路径被拒绝（禁止绝对路径、前导 / 或 .. 逃逸）: ${relPath}`);
  }
  const external = isExternalWorkspace(ctx.workspace ?? null);
  const sandbox = path.resolve(config.sandboxDir);
  if (external) {
    // §11.3 前缀禁用：外部工作区自成一体
    if (relPath === 'shared' || relPath.startsWith('shared/') || relPath === 'archive' || relPath.startsWith('archive/')) {
      throw new ToolError('外部工作区自成一体，shared/archive 仅在内部工作区可用');
    }
    const root = resolveReal(workspaceRootDir(ctx)); // 注册根再消解（双保险，注册时已 realpath）
    const absPath = resolveReal(path.resolve(root, relPath)); // 符号链接消解后再判包含
    if (absPath !== root && !absPath.startsWith(root + path.sep)) {
      throw new ToolError(`路径越出外部工作区目录（${root}）: ${relPath}`);
    }
    return { area: 'run', absPath, readOnly: false };
  }
  let area: SandboxArea;
  let absPath: string;
  if (relPath === 'shared' || relPath.startsWith('shared/')) {
    area = 'shared';
    absPath = path.resolve(sandbox, relPath);
  } else if (relPath === 'archive' || relPath.startsWith('archive/')) {
    area = 'archive';
    const legacy = relPath === 'archive' ? '' : relPath.slice('archive/'.length);
    absPath = path.resolve(sandbox, legacy);
    // archive/ 只映射根级遗留：借道 archive/runs|workspaces|shared/ 绕过隔离 → 拒绝
    if (
      legacy === 'runs' || legacy.startsWith('runs/') ||
      legacy === 'workspaces' || legacy.startsWith('workspaces/') ||
      legacy === 'shared' || legacy.startsWith('shared/')
    ) {
      throw new ToolError(`archive/ 仅访问根级历史归档，不能指向 runs/、workspaces/ 或 shared/: ${relPath}`);
    }
  } else {
    area = 'run';
    absPath = path.resolve(workspaceRootDir(ctx), relPath);
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
    const { absPath } = resolveSandboxPath(expectString(obj, 'path'), ctx);
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
  description:
    '写入沙箱内文本文件（无前缀=当前 run 工作区，自动建目录）。注意：写入 shared/ 前缀（团队共享区）或本次运行使用外部工作区时，一律触发人工审批；shared/ 只存放跨 run 复用的持久团队资产（模板/词典/规范），任务看板与一次性产物请写本 run 工作区。历史产物在 archive/ 前缀下只读。',
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
    const { absPath, readOnly } = resolveSandboxPath(rel, ctx);
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
    // §9.2/§10.2：cwd = 当前工作区根（命名工作区或 run 专属；不存在则建）
    const rootDir = workspaceRootDir(ctx);
    mkdirSync(rootDir, { recursive: true });
    return (await execFileP(cmd, args, rootDir)).trim();
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
    // §9.2/§10.2：搜索范围=当前工作区（命名或 run 专属）+ shared/ + 根级遗留（archive 视图）；
    // 其他 run/工作区的目录不可见（隔离）。结果路径带三段语义前缀。
    // §11.3：外部工作区自成一体——只搜外部根，无 shared/archive 视图。
    const scopes: Array<{ dir: string; prefix: string }> = isExternalWorkspace(ctx.workspace ?? null)
      ? [{ dir: workspaceRootDir(ctx), prefix: '' }]
      : [
          { dir: workspaceRootDir(ctx), prefix: '' },
          { dir: path.join(sandbox, 'shared'), prefix: 'shared/' },
          { dir: sandbox, prefix: 'archive/' },
        ];
    const results: string[] = [];
    for (const { dir, prefix } of scopes) {
      // 根级遍历时跳过 runs/ 与 shared/（已有各自范围，避免重复且不泄露其他 run）
      const files = dir === sandbox ? walkFiles(dir, [], new Set(['runs', 'workspaces', 'shared'])) : walkFiles(dir);
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

/** 命名工作区列表（§10.3，GET /api/workspaces）：workspaces/ 下目录名 + mtime */
export function listWorkspaces(): Array<{ name: string; modifiedAt: string }> {
  const root = path.join(config.sandboxDir, 'workspaces');
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // 目录不存在（尚无命名工作区）
  }
  const out: Array<{ name: string; modifiedAt: string }> = [];
  for (const name of entries) {
    if (!WORKSPACE_NAME_RE.test(name)) continue; // 只报合法命名工作区
    try {
      const st = statSync(path.join(root, name));
      if (st.isDirectory()) out.push({ name, modifiedAt: new Date(st.mtimeMs).toISOString() });
    } catch {
      // 竞态消失的目录跳过
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)); // 最近使用在前
  return out;
}
