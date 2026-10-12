import type { BusinessChangeImpact as Impact } from '@agent-gand/shared';
export function BusinessChangeImpact({impact,members}:{impact:Impact;members:Array<{id:string;name:string}>}) {
  const name=(id:string)=>members.find(m=>m.id===id)?.name??id;
  return <div aria-label="返工影响范围" className="space-y-2 rounded bg-zinc-950/60 p-3">
    {impact.kind==='contract_revision'&&<p>契约版本：{impact.fromRevision} → {impact.toRevision}</p>}
    <p className="text-emerald-300">保留：{impact.retained.map(t=>name(t.agentId)+' · '+t.objective).join('；')||'无'}</p>
    <p className="text-amber-200">必须重做：{impact.redo.map(t=>name(t.agentId)+' · '+t.objective).join('；')||'无'}</p>
    <p>需要重新验收：{impact.invalidatedDeliverables.map(d=>d.title).join('、')}</p>
    {impact.reasons.map((reason,i)=><p key={i} className="text-zinc-400">{reason}</p>)}
  </div>;
}
