import type { CostPolicy } from '@agent-gand/shared';

/** Drafts must retain a fee guard, even when stale browser data cannot be trusted. */
export function readCostPolicyDraft(value: unknown): CostPolicy | null {
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
export const blockedCostPolicyDraft = (): CostPolicy => ({version:1,currency:'USD',mode:'strict',maxCost:1,unknownAction:'stop',prices:[]});
