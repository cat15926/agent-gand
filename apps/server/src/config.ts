/**
 * 环境变量与路径解析（规格 §4.2 config.ts）
 * 路径一律用 fileURLToPath(import.meta.url) 解析，兼容 tsx 直跑源码
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** apps/server/src → apps/server */
const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');
/** apps/server → 仓库根 */
export const repoRoot = path.resolve(serverRoot, '..', '..');

/** LLM_* 环境变量透传（TODO: 真实 Provider 接入时消费） */
function collectLlmEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('LLM_') && typeof value === 'string') env[key] = value;
  }
  return env;
}

function firstInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: firstInt(process.env.PORT, 3010),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  dataDir: path.join(serverRoot, 'data'),
  dbPath: process.env.DB_PATH ?? path.join(serverRoot, 'data', 'agent-gand.sqlite'),
  agentsDir: process.env.AGENTS_DIR ?? path.join(repoRoot, 'agents'),
  /** 内置 fs 工具的沙箱根（规格：限定 apps/server/data/sandbox/） */
  sandboxDir: path.join(serverRoot, 'data', 'sandbox'),
  llm: collectLlmEnv(),
  mcp: {
    command: process.env.MCP_SERVER_CMD ?? null,
    args: (process.env.MCP_SERVER_ARGS ?? '').split(/\s+/).filter(Boolean),
  },
} as const;

export type AppConfig = typeof config;
