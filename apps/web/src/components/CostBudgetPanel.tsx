import { useEffect, useRef, useState } from 'react';
import type { CostBudgetState } from '@agent-gand/shared';
import * as api from '../services/api';

const amount = (value: number) => value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0';
export function CostBudgetSummary({ budget }: { budget: CostBudgetState }) {
  return <div className="min-w-0 space-y-2 text-xs [overflow-wrap:anywhere]">
    <p>费用控制 · {budget.currency} · {budget.mode==='strict'?'严格账单上限':'估算控制'}</p>
    <p>后端报告 {amount(budget.run.reported)} · 按版本计价 {amount(budget.run.calculated)} · 进行中预留 {amount(budget.run.pending)} · 未知费用保留 {amount(budget.run.unknown)}</p>
    <p>已占用 {amount(budget.run.charged)} / {amount(budget.run.limit!)} · 可派发剩余 {amount(budget.run.remaining!)}</p>
    {budget.run.unknownCalls>0 && <p className="text-amber-200">{budget.run.unknownCalls} 次费用未完整报告；已知部分单独计入，未知部分不按零结算。政策：{budget.unknownAction==='stop'?'停止新派发':'保留预留额度，有剩余额度时允许新调用'}。</p>}
    {budget.run.exceeded && <p className="text-red-300">报告费用已超过估算预算，后续调用停止。已发出的供应商费用不能撤回。</p>}
    {budget.inheritedCalls>0 && <p>继承 {budget.inheritedCalls} 条费用记录；续跑和返工不重置额度。</p>}
    {budget.stages.filter(s=>s.limit!==null||s.charged>0).map(s=><p key={s.stageId}>阶段 {s.stageId}：已占用 {amount(s.charged)}{s.limit!==null?` / ${amount(s.limit)} · 剩余 ${amount(s.remaining!)}`:' · 不另设上限'}{s.unknownCalls>0?` · ${s.unknownCalls} 次费用未知`:''}</p>)}
  </div>;
}
export function CostBudgetPanel({ runId, terminal }: { runId: string; terminal: boolean }) {
  const [value,setValue] = useState<Awaited<ReturnType<typeof api.getCostBudget>> | null>(null),[error,setError]=useState('');
  const epoch=useRef(0);
  useEffect(()=>{const current=++epoch.current;let pending=false;setValue(null);setError('');
    const load=async()=>{if(pending)return;pending=true;try{const result=await api.getCostBudget(runId);if(current===epoch.current){setValue(result);setError('');}}catch(e){if(current===epoch.current)setError(e instanceof Error?e.message:String(e));}finally{pending=false;}};
    void load();const timer=terminal?null:window.setInterval(()=>void load(),2000);return()=>{epoch.current++;if(timer)window.clearInterval(timer);};
  },[runId,terminal]);
  return <section aria-label="任务费用预算" className="mt-3 min-w-0 space-y-2 rounded-lg border border-zinc-700 p-3 text-xs">
    {value?.budget && <CostBudgetSummary budget={value.budget}/>}
    {value?.records.length ? <details><summary className="cursor-pointer">查看费用记录与计价版本</summary><p className="mt-2 text-zinc-500">展示最近 100 条记录，预算汇总包含全部历史。后端报告和版本计价均不替代供应商账单。</p>{value.records.map(r=><div key={r.id} className="mt-2 rounded bg-zinc-950/50 p-2 [overflow-wrap:anywhere]"><p>{r.agentId} · {r.model} · {r.status} · {r.currency}</p><p>预留 {amount(r.reserved)} · 已知 {r.known===null?'未知':amount(r.known)}</p>{r.pricing&&<p>计价：{r.pricing.source} · {r.pricing.version}</p>}{r.sourceReservationId&&<p>继承记录 {r.sourceReservationId}</p>}</div>)}</details>:null}
    {error&&<p role="alert" className="text-red-300">费用读取失败：{error}</p>}
  </section>;
}
