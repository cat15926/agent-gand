import type { CostPolicy, CostPrice } from '@agent-gand/shared';
import { OrchestrationError } from './errors.ts';

function invalid(): never { throw new OrchestrationError(400, 'INVALID_COST_POLICY', '费用政策需选择 USD/CNY、有效上限、控制策略和未知费用政策；价格需绑定成员、模型、来源及版本'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid(); return value.trim(); }
export function costAmount(value: unknown, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (allowZero ? 0 : 0.000001) || value > 1_000_000 || Math.abs(value * 1e6 - Math.round(value * 1e6)) > 1e-6) invalid();
  return value;
}
export function normalizeCostPolicy(value: unknown): CostPolicy {
  const raw = object(value);
  if (Object.keys(raw).some(k => !['version','currency','maxCost','mode','unknownAction','unknownReserve','prices'].includes(k))
    || raw.version !== 1 || !['USD','CNY'].includes(String(raw.currency)) || !['estimate','strict'].includes(String(raw.mode))
    || !['stop','reserve'].includes(String(raw.unknownAction)) || !Array.isArray(raw.prices) || raw.prices.length > 32) invalid();
  const prices = raw.prices.map(value => {
    const p = object(value);
    if (Object.keys(p).some(k => !['agentId','model','source','version','inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion','otherCharges'].includes(k)) || !['none','unknown'].includes(String(p.otherCharges))) invalid();
    const price: CostPrice = { agentId: text(p.agentId), model: text(p.model), source: text(p.source), version: text(p.version), inputPerMillion: costAmount(p.inputPerMillion, true), outputPerMillion: costAmount(p.outputPerMillion, true), otherCharges: p.otherCharges as CostPrice['otherCharges'] };
    for (const key of ['cacheReadPerMillion','cacheWritePerMillion'] as const) if (p[key] !== undefined) price[key] = costAmount(p[key], true);
    return price;
  });
  if (new Set(prices.map(p => p.agentId)).size !== prices.length) invalid();
  if (raw.unknownAction === 'reserve' && raw.unknownReserve === undefined || raw.unknownAction === 'stop' && raw.unknownReserve !== undefined) invalid();
  return { version: 1, currency: raw.currency as CostPolicy['currency'], maxCost: costAmount(raw.maxCost), mode: raw.mode as CostPolicy['mode'], unknownAction: raw.unknownAction as CostPolicy['unknownAction'], prices,
    ...(raw.unknownReserve !== undefined ? { unknownReserve: costAmount(raw.unknownReserve) } : {}) };
}
