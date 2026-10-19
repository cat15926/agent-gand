import { legacyRunIdsSql } from '../runs/legacyMode.ts';
import { randomUUID } from 'node:crypto';
import type { CostBudgetScope, CostBudgetState, CostPolicy, CostPrice, OrchestrationPreview } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { config } from '../config.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { businessStageContext } from './businessStageExecution.ts';
import { OrchestrationError, stableDigest } from './normalize.ts';
import type { LlmRequest, LlmUsage } from '../llm/provider.ts';
import {loadAutonomousTaskPolicy} from '../runtime/autonomousPolicy.ts';

/** Both schedulers consume the same money reservation ledger and frozen policy. */
export function runCostPolicy(runId: string): CostPolicy | undefined {
  const autonomous=loadAutonomousTaskPolicy(runId);if(autonomous)return autonomous.costPolicy;
  const unified=getRunOrchestrationSnapshot(runId)?.request.constraints.costPolicy;
  if(unified)return unified;
  const scoped=get<{policy:string|null}>("SELECT json_extract(record,'$.costPolicy') policy FROM scoped_delivery_plans WHERE run_id=?",runId);
  return scoped?.policy ? JSON.parse(scoped.policy) as CostPolicy : undefined;
}
const SCALE = 1_000_000;
const money = (units: number) => units / SCALE;
function units(amount: number): number {
  const result = Math.ceil(amount * SCALE - 1e-9);
  if (!Number.isSafeInteger(result) || result < 0) throw new OrchestrationError(409, 'COST_AMOUNT_INVALID', '费用超出可计算范围，停止派发');
  return result;
}
function fail(code: string, message: string): never { throw new OrchestrationError(409, code, message); }
export interface CostReservationRow {
  id: string; run_id: string; stage_id: string | null; agent_id: string; model: string; backend: string; currency: CostPolicy['currency'];
  reserved: number; known: number | null; status: 'pending' | 'settled' | 'unknown' | 'carried_known' | 'carried_unknown';
  cost_source: 'reported' | 'calculated' | null; pricing: string | null; policy_digest: string; source_reservation_id: string | null;
  created_at: string; settled_at: string | null;
}
const charged = (r: CostReservationRow) => ['settled','carried_known'].includes(r.status) ? r.known ?? r.reserved : Math.max(r.reserved, r.known ?? 0);
function priceFor(policy: CostPolicy, agentId: string, model: string) { return policy.prices.find(p => p.agentId === agentId && p.model === model); }
export function costAdmissionIssues(preview: OrchestrationPreview) {
  const policy = preview.request.constraints.costPolicy;
  if (!policy) return [];
  preview.decision.requiresConfirmation = true;
  const issues: OrchestrationPreview['decision']['issues'] = [];
  if (preview.decision.execution?.plannerRequired) issues.push({ code: 'COST_PLANNING_UNSUPPORTED', severity: 'error', message: '当前费用政策不覆盖提交前的付费主管规划，请选择常规协作、分析与汇总或已明确成员任务的逐阶段工作流' });
  if (policy.mode === 'strict') issues.push({ code: 'HARD_COST_LIMIT_UNSUPPORTED', severity: 'error', message: '当前模型 API、SDK 和 Codex 不能保证供应商账单硬上限；严格费用模式不可派发，请选择估算控制或可落实该限制的后端' });
  else issues.push({ code: 'ESTIMATED_COST_CONTROL', severity: 'warning', message: `费用以 ${policy.currency} 估算控制，调用前预留额度；估算和未知预留不保证供应商账单上限，不包含预览规划、账户测试及平台外调用` });
  for (const id of preview.decision.execution?.participantIds ?? []) {
    const actor = preview.capabilities.agents.find(a => a.id === id)!;
    const price = priceFor(policy, id, actor.model);
    if (actor.driver !== 'builtin-llm' || !price || price.otherCharges === 'unknown') issues.push({ code: 'COST_ESTIMATE_UNKNOWN', severity: policy.unknownAction === 'stop' ? 'error' : 'warning', agentId: id,
      message: `${actor.name} 的${actor.driver !== 'builtin-llm' ? '原生调用次数/费用' : '价格或额外收费项'}无法预先完整计算；${policy.unknownAction === 'stop' ? '当前政策停止派发' : `每次调用预留 ${policy.unknownReserve} ${policy.currency}，缺少可信账单时保持未知`}` });
  }
  return issues;
}
export function costRows(runId: string): CostReservationRow[] { return all<CostReservationRow>('SELECT * FROM execution_cost_reservations WHERE run_id=? ORDER BY created_at,id', runId); }
function scopeSummary(rows: CostReservationRow[], stageId: string | null, limit: number | null): CostBudgetScope {
  const selected = stageId === null ? rows : rows.filter(r => r.stage_id === stageId);
  const total = selected.reduce((n,r) => n + charged(r), 0);
  return { stageId, limit, charged: money(total), remaining: limit === null ? null : Math.max(0, money(units(limit) - total)), exceeded: limit !== null && total > units(limit),
    reported: money(selected.filter(r => r.cost_source === 'reported').reduce((n,r) => n + (r.known ?? 0), 0)),
    calculated: money(selected.filter(r => r.cost_source === 'calculated').reduce((n,r) => n + (r.known ?? 0), 0)),
    pending: money(selected.filter(r => r.status === 'pending').reduce((n,r) => n + charged(r), 0)),
    unknown: money(selected.filter(r => ['unknown','carried_unknown'].includes(r.status)).reduce((n,r) => n + charged(r) - (r.known ?? 0), 0)),
    pendingCalls: selected.filter(r => r.status === 'pending').length, unknownCalls: selected.filter(r => ['unknown','carried_unknown'].includes(r.status)).length };
}
export function costBudgetState(runId: string): CostBudgetState | null {
  const frozen = getRunOrchestrationSnapshot(runId), policy = runCostPolicy(runId);
  if (!policy) return null;
  const rows = costRows(runId);
  return { runId, currency: policy.currency, mode: policy.mode, unknownAction: policy.unknownAction, run: scopeSummary(rows, null, policy.maxCost),
    stages: (frozen?.request.businessContract?.stages ?? []).map(s => scopeSummary(rows, s.id, s.execution?.maxCost ?? null)), inheritedCalls: rows.filter(r => r.source_reservation_id).length };
}
export function reserveCost(runId: string, agentId: string, model: string, backend: string, request?: LlmRequest, callId?: string): CostReservationRow | null {
  const frozen = getRunOrchestrationSnapshot(runId), policy = runCostPolicy(runId);
  if (!policy) return null;
  if (policy.mode === 'strict') fail('HARD_COST_LIMIT_UNSUPPORTED', '当前后端不能落实供应商账单硬上限');
  const stage = businessStageContext();
  if (stage && stage.runId !== runId) fail('COST_SCOPE_INVALID', '费用阶段与本轮不一致');
  const price = backend === 'builtin-llm' ? priceFor(policy, agentId, model) : undefined;
  const quoteKnown = request && price && price.otherCharges === 'none';
  if (!quoteKnown && policy.unknownAction === 'stop') fail('COST_PRICE_UNKNOWN', '价格、其他收费项或原生调用范围未知，当前费用政策禁止派发');
  // Bytes + schemas + overhead are an estimate, never a tokenizer or billing guarantee.
  const inputEstimate = request ? Math.ceil(Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools ?? [] })) * 1.2) + 1024 : 0;
  const rate = price ? Math.max(price.inputPerMillion, price.cacheReadPerMillion ?? 0, price.cacheWritePerMillion ?? 0) : 0;
  const amount = quoteKnown ? (inputEstimate * rate + (request!.maxTokens ?? config.llm.maxTokens) * price!.outputPerMillion) / SCALE : policy.unknownReserve!;
  const reserved = units(amount), stageId = stage?.stageId ?? null;
  return tx(() => {
    const rows = costRows(runId);
    if (rows.some(r => r.currency !== policy.currency)) fail('COST_CURRENCY_MISMATCH', '历史费用币种与冻结政策不一致');
    const checks = [{ label: '本轮', selected: rows, limit: policy.maxCost }, ...(stageId ? [{ label: '当前阶段', selected: rows.filter(r => r.stage_id === stageId), limit: frozen?.request.businessContract?.stages.find(s => s.id === stageId)?.execution?.maxCost }] : [])];
    for (const check of checks) {
      if (check.selected.some(r => r.status === 'pending') && reserved > Math.max(0, units(check.limit ?? policy.maxCost) - check.selected.reduce((n,r) => n + charged(r), 0))) fail('COST_BUDGET_RESERVED', `${check.label}费用已被进行中的调用预留，不能重复消费额度`);
      if (policy.unknownAction === 'stop' && check.selected.some(r => ['unknown','carried_unknown'].includes(r.status))) fail('COST_RESULT_UNKNOWN', `${check.label}费用尚未完整报告，保留额度并停止新派发`);
      if (check.limit !== undefined && check.selected.reduce((n,r) => n + charged(r), 0) + reserved > units(check.limit)) fail('COST_BUDGET_EXHAUSTED', `${check.label}费用预算不足，停止后续调用；已有未知预留不会释放`);
    }
    const row: CostReservationRow = { id: callId ?? randomUUID(), run_id: runId, stage_id: stageId, agent_id: agentId, model, backend, currency: policy.currency, reserved, known: null, status: 'pending', cost_source: null, pricing: price ? JSON.stringify(price) : null, policy_digest: stableDigest(policy), source_reservation_id: null, created_at: new Date().toISOString(), settled_at: null };
    run('INSERT INTO execution_cost_reservations(id,run_id,stage_id,agent_id,model,backend,currency,reserved,status,pricing,policy_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', row.id,runId,stageId,agentId,model,backend,policy.currency,reserved,row.status,row.pricing,row.policy_digest,row.created_at);
    return row;
  });
}
function usageCost(row: CostReservationRow, usage: Partial<LlmUsage> & { costUsd?: number | null } | undefined): { known: number | null; source: CostReservationRow['cost_source']; complete: boolean } {
  if (!usage) return { known: null, source: null, complete: false };
  if (row.currency === 'USD' && usage.costSource === 'reported' && usage.costKnown !== false && typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return { known: units(usage.costUsd), source: 'reported', complete: usage.billingComplete !== false };
  const price = row.pricing && row.backend === 'builtin-llm' ? JSON.parse(row.pricing) as CostPrice : null;
  if (!price) return { known: null, source: null, complete: false };
  const valid = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const inputKnown = usage.inputKnown !== false && valid(usage.tokensIn), outputKnown = usage.outputKnown !== false && valid(usage.tokensOut);
  const cacheRead = usage.cacheReadTokens ?? 0, cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheKnown = (!cacheRead || price.cacheReadPerMillion !== undefined) && (!cacheWrite || price.cacheWritePerMillion !== undefined);
  const amount = (inputKnown ? (usage.inputBaseTokens ?? usage.tokensIn!) * price.inputPerMillion : 0) + (outputKnown ? usage.tokensOut! * price.outputPerMillion : 0)
    + cacheRead * (price.cacheReadPerMillion ?? 0) + cacheWrite * (price.cacheWritePerMillion ?? 0);
  return { known: inputKnown || outputKnown ? units(amount / SCALE) : null, source: 'calculated', complete: inputKnown && outputKnown && cacheKnown && usage.billingComplete !== false && price.otherCharges === 'none' };
}
export function settleCost(row: CostReservationRow | null, usage?: Parameters<typeof usageCost>[1], failed = false): void {
  if (!row) return;
  const result = usageCost(row, usage);
  run("UPDATE execution_cost_reservations SET known=?,cost_source=?,status=?,settled_at=? WHERE id=? AND status='pending'", result.known,result.source,!failed && result.complete ? 'settled' : 'unknown',new Date().toISOString(),row.id);
}
/** A host restart cannot prove a pending supplier call was free or unissued. */
export function recoverCostReservations(): void { run(`UPDATE execution_cost_reservations SET status='unknown' WHERE status='pending'
  AND run_id IN (${legacyRunIdsSql})
  AND NOT EXISTS (SELECT 1 FROM orchestration_model_calls c JOIN scoped_delivery_plans p ON p.run_id=c.run_id
    WHERE c.id=execution_cost_reservations.id AND json_extract(p.record,'$.recoveryVersion')=1)` ); }
export function costCarry(runId: string): CostReservationRow[] {
  const rows = costRows(runId), policy = runCostPolicy(runId);
  if (!policy && rows.length) fail('COST_POLICY_MISSING', '费用账本缺少冻结政策');
  if (rows.some(r => r.status === 'pending')) fail('COST_RESULT_UNKNOWN', '存在进行中的费用调用，请等待进程收敛并恢复账本');
  if (policy?.unknownAction === 'stop' && rows.some(r => ['unknown','carried_unknown'].includes(r.status))) fail('COST_RESULT_UNKNOWN', '历史费用未知，停止政策不允许通过后继绕过');
  return rows;
}
export function carryCosts(targetRunId: string, sourceRows: CostReservationRow[]): void {
  const policy = runCostPolicy(targetRunId);
  if (sourceRows.length && (!policy || sourceRows.some(r => r.currency !== policy.currency || r.policy_digest !== stableDigest(policy)))) fail('COST_CURRENCY_MISMATCH', '后继不能更换费用政策、计价版本或币种');
  for (const row of sourceRows) run(`INSERT INTO execution_cost_reservations(id,run_id,stage_id,agent_id,model,backend,currency,reserved,known,status,cost_source,pricing,policy_digest,source_reservation_id,created_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    randomUUID(),targetRunId,row.stage_id,row.agent_id,row.model,row.backend,row.currency,charged(row),row.known,['settled','carried_known'].includes(row.status)?'carried_known':'carried_unknown',row.cost_source,row.pricing,row.policy_digest,row.source_reservation_id ?? row.id,row.created_at,row.settled_at);
}
