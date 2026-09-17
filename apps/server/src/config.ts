/**
 * 环境变量与路径解析（规格 §4.2 config.ts）
 * 路径一律用 fileURLToPath(import.meta.url) 解析，兼容 tsx 直跑源码
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** apps/server/src → apps/server */
const here = path.dirname(fileURLToPath(import.meta.url));
export const serverRoot = path.resolve(here, '..');
/** apps/server → 仓库根 */
export const repoRoot = path.resolve(serverRoot, '..', '..');

/**
 * 可选加载 apps/server/.env（不存在则忽略；已设置的环境变量优先于 .env）。
 * 零依赖手写解析：跳过注释/空行，去引号。
 */
function loadDotEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    return; // 无 .env 文件
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(serverRoot, '.env'));

/** LLM_* 环境变量全量透传（真实 Provider 的 key/base_url/proxy 见下方结构化字段） */
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

export interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

function parsePricing(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ModelPrice>>;
    const result: Record<string, ModelPrice> = {};
    for (const [model, price] of Object.entries(parsed)) {
      const input = price?.inputPerMillion;
      const output = price?.outputPerMillion;
      if (typeof input === 'number' && Number.isFinite(input) && input >= 0
        && typeof output === 'number' && Number.isFinite(output) && output >= 0) {
        result[model] = { inputPerMillion: input, outputPerMillion: output };
      }
    }
    return result;
  } catch {
    throw new Error('LLM_PRICING_JSON 必须是合法 JSON，格式见 apps/server/.env.example');
  }
}

export const config = {
  port: firstInt(process.env.PORT, 3010),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  dataDir: path.join(serverRoot, 'data'),
  dbPath: process.env.DB_PATH ?? path.join(serverRoot, 'data', 'agent-gand.sqlite'),
  agentsDir: process.env.AGENTS_DIR ?? path.join(repoRoot, 'agents'),
  /** 内置 fs 工具的沙箱根（规格：限定 apps/server/data/sandbox/） */
  sandboxDir: path.join(serverRoot, 'data', 'sandbox'),
  llm: {
    ...collectLlmEnv(),
    /** 结构化字段（规格 §7.1）：openai-compatible / anthropic / 代理 */
    openaiApiKey: process.env.LLM_OPENAI_API_KEY ?? null,
    openaiBaseUrl: process.env.LLM_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    anthropicApiKey: process.env.LLM_ANTHROPIC_API_KEY ?? null,
    anthropicBaseUrl: process.env.LLM_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    /** 可选出站代理（如 http://127.0.0.1:7897）；不设则直连 */
    proxy: process.env.LLM_PROXY ?? null,
    /** 单次响应 max_tokens（thinking 模型思考也耗预算，过小会导致正文为空） */
    maxTokens: firstInt(process.env.LLM_MAX_TOKENS, 8192),
    /** 单次请求超时毫秒（thinking 模型长生成需要更长时间） */
    timeoutMs: firstInt(process.env.LLM_TIMEOUT_MS, 180_000),
    /** 每百万 token 美元价格；支持完整路由名或 openai:* / anthropic:* 兜底。 */
    pricing: parsePricing(process.env.LLM_PRICING_JSON),
  },
  mcp: {
    command: process.env.MCP_SERVER_CMD ?? null,
    args: (process.env.MCP_SERVER_ARGS ?? '').split(/\s+/).filter(Boolean),
    heartbeatMs: Math.max(5_000, firstInt(process.env.MCP_HEARTBEAT_MS, 30_000)),
  },
  /** 审批等待超时毫秒（规格 §8.2；默认 300s，0 = 不超时；超时置 expired 按拒绝处理） */
  approvalTimeoutMs: firstInt(process.env.APPROVAL_TIMEOUT_MS, 300_000),
  /** Supervisor 调度并发、任务返工上限与执行租约。 */
  orchestratorConcurrency: Math.max(1, firstInt(process.env.ORCHESTRATOR_CONCURRENCY, 2)),
  taskMaxAttempts: Math.max(1, firstInt(process.env.TASK_MAX_ATTEMPTS, 3)),
  taskLeaseMs: Math.max(10_000, firstInt(process.env.TASK_LEASE_MS, 300_000)),
  collaboration: {
    maxDepth: Math.max(1, firstInt(process.env.COLLAB_MAX_DEPTH, 12)),
    maxDispatches: Math.max(1, firstInt(process.env.COLLAB_MAX_DISPATCHES, 20)),
    maxTargets: Math.min(3, Math.max(1, firstInt(process.env.COLLAB_MAX_TARGETS, 3))),
    maxConcurrency: Math.max(1, firstInt(process.env.COLLAB_MAX_CONCURRENCY, 3)),
    maxAttempts: Math.max(1, firstInt(process.env.COLLAB_MAX_ATTEMPTS, 2)),
    batchTimeoutMs: Math.max(10_000, firstInt(process.env.COLLAB_BATCH_TIMEOUT_MS, 300_000)),
    runTimeoutMs: Math.max(60_000, firstInt(process.env.COLLAB_RUN_TIMEOUT_MS, 1_800_000)),
    maxTokens: Math.max(1_000, firstInt(process.env.COLLAB_MAX_TOKENS, 100_000)),
    maxCostUsd: Math.max(0.01, Number(process.env.COLLAB_MAX_COST_USD ?? 5) || 5),
    maxBudgetMultiplier: Math.max(1, Number(process.env.COLLAB_MAX_BUDGET_MULTIPLIER ?? 4) || 4),
    pingPongWarn: Math.max(1, firstInt(process.env.COLLAB_PINGPONG_WARN, 2)),
    pingPongBlock: Math.max(2, firstInt(process.env.COLLAB_PINGPONG_BLOCK, 4)),
    attemptLeaseMs: Math.max(10_000, firstInt(process.env.COLLAB_ATTEMPT_LEASE_MS, 300_000)),
  },
} as const;

export type AppConfig = typeof config;
