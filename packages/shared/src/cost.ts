export interface CostPrice {
  agentId: string;
  model: string;
  source: string;
  version: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  cacheWritePerMillion?: number;
  /** Explicit owner declaration; unknown ancillary charges prevent full settlement. */
  otherCharges: 'none' | 'unknown';
}
export interface CostPolicy {
  version: 1;
  currency: 'USD' | 'CNY';
  maxCost: number;
  mode: 'estimate' | 'strict';
  unknownAction: 'stop' | 'reserve';
  /** Per-call estimate for unpriced or unbounded native calls; never a billing guarantee. */
  unknownReserve?: number;
  prices: CostPrice[];
}
export interface CostBudgetScope {
  stageId: string | null;
  limit: number | null;
  reported: number;
  calculated: number;
  pending: number;
  unknown: number;
  charged: number;
  remaining: number | null;
  pendingCalls: number;
  unknownCalls: number;
  exceeded: boolean;
}
export interface CostBudgetState {
  runId: string;
  currency: CostPolicy['currency'];
  mode: CostPolicy['mode'];
  unknownAction: CostPolicy['unknownAction'];
  run: CostBudgetScope;
  stages: CostBudgetScope[];
  inheritedCalls: number;
}

export function readCostPolicy(value: unknown): CostPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as CostPolicy;
  const amount = (n: unknown, zero = false) => typeof n === 'number' && Number.isFinite(n) && n >= (zero ? 0 : 0.000001) && n <= 1_000_000 && Math.abs(n * 1e6 - Math.round(n * 1e6)) <= 1e-6;
  const text = (s: unknown) => typeof s === 'string' && Boolean(s.trim()) && s.length <= 200;
  if (p.version !== 1 || !['USD','CNY'].includes(p.currency) || !['estimate','strict'].includes(p.mode) || !amount(p.maxCost)
    || !['stop','reserve'].includes(p.unknownAction) || (p.unknownAction === 'reserve' ? !amount(p.unknownReserve) : p.unknownReserve !== undefined)
    || !Array.isArray(p.prices) || p.prices.length > 32) return null;
  if (p.prices.some(r => !r || !text(r.agentId) || !text(r.model) || !text(r.source) || !text(r.version)
    || !amount(r.inputPerMillion,true) || !amount(r.outputPerMillion,true)
    || r.cacheReadPerMillion !== undefined && !amount(r.cacheReadPerMillion,true)
    || r.cacheWritePerMillion !== undefined && !amount(r.cacheWritePerMillion,true)
    || !['none','unknown'].includes(r.otherCharges)) || new Set(p.prices.map(r=>r.agentId)).size !== p.prices.length) return null;
  return p;
}
