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
