import type { CostPolicy, CostPrice } from '@agent-gand/shared';

export function CostPolicyEditor({ value, agents, disabled, onChange }: {
  value?: CostPolicy; agents: Array<{id:string;name:string;model:string}>; disabled: boolean; onChange: (value?: CostPolicy) => void;
}) {
  const update = (patch: Partial<CostPolicy>) => { if (value) onChange({ ...value, ...patch }); };
  const price = (index: number, patch: Partial<CostPrice>) => update({ prices: value!.prices.map((p,i) => i === index ? { ...p, ...patch } : p) });
  const available = agents.filter(a => !value?.prices.some(p => p.agentId === a.id));
  return <fieldset aria-label="费用控制设置" disabled={disabled} className="min-w-0 space-y-3 rounded-xl border border-zinc-700 p-3 text-xs [overflow-wrap:anywhere]">
    <label className="flex items-center gap-2"><input aria-label="启用费用控制" type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked ? { version:1,currency:'USD',maxCost:1,mode:'estimate',unknownAction:'stop',prices:[] } : undefined)} />本任务启用费用控制</label>
    {value && <>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        <label>币种<select aria-label="费用币种" className="input mt-1" value={value.currency} onChange={e => update({ currency:e.target.value as CostPolicy['currency'],prices:[] })}><option value="USD">USD · 美元</option><option value="CNY">CNY · 人民币</option></select></label>
        <label>本轮费用上限<input aria-label="本轮费用上限" className="input mt-1" type="number" min={0.000001} max={1000000} step="0.000001" value={value.maxCost} onChange={e => update({maxCost:Number(e.target.value)})} /></label>
        <label>控制策略<select aria-label="费用控制策略" className="input mt-1" value={value.mode} onChange={e => update({mode:e.target.value as CostPolicy['mode']})}><option value="estimate">估算控制 · 额度不足停止新派发</option><option value="strict">严格账单上限 · 需后端硬限制</option></select></label>
        <label>未知费用<select aria-label="未知费用政策" className="input mt-1" value={value.unknownAction} onChange={e => update({unknownAction:e.target.value as CostPolicy['unknownAction'],unknownReserve:e.target.value==='reserve'?0.1:undefined})}><option value="stop">停止派发 · 不接受未知价格/结果</option><option value="reserve">保留预留额度 · 有剩余额度时允许新调用</option></select></label>
      </div>
      {value.unknownAction==='reserve' && <label className="block">每次未知调用预留（{value.currency}）<input aria-label="未知调用预留金额" className="input mt-1" type="number" min={0.000001} max={1000000} step="0.000001" value={value.unknownReserve??''} onChange={e => update({unknownReserve:Number(e.target.value)})} /></label>}
      <p className="text-zinc-400">估算会计入输入、输出及已声明的其他收费项。预留是派发依据，不能保证供应商账单上限；缺少用量、价格或账单时保留未知，不算免费。SDK/Codex 调用范围无法预先完整计算，需明确选择未知预留。严格模式目前会拒绝执行。</p>
      <details className="space-y-2"><summary className="cursor-pointer">成员计价（{value.prices.length} 项）</summary><p className="mt-2 text-zinc-500">按所选币种填写自己的计价来源和版本。更换币种会清空价格，不自动换汇；模型变更后原价格不自动套用。</p>
        {value.prices.map((p,i) => <div key={p.agentId} className="mt-3 min-w-0 space-y-2 rounded-lg bg-zinc-950/50 p-3">
          <p>{agents.find(a=>a.id===p.agentId)?.name??p.agentId} · {p.model}</p>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            <label>计价来源<input aria-label={`${p.agentId} 计价来源`} className="input mt-1" maxLength={200} value={p.source} onChange={e=>price(i,{source:e.target.value})} placeholder="供应商价目表或套餐计价说明" /></label>
            <label>计价版本<input aria-label={`${p.agentId} 计价版本`} className="input mt-1" maxLength={200} value={p.version} onChange={e=>price(i,{version:e.target.value})} placeholder="生效日期或版本号" /></label>
            {(['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion'] as const).map(key=><label key={key}>{({inputPerMillion:'输入',outputPerMillion:'输出',cacheReadPerMillion:'缓存读取',cacheWritePerMillion:'缓存写入'})[key]} / 百万 Token<input aria-label={`${p.agentId} ${key}`} className="input mt-1" type="number" min={0} max={1000000} step="0.000001" value={p[key]??''} placeholder={key.startsWith('cache')?'未知时留空':''} onChange={e=>price(i,{[key]:e.target.value===''&&key.startsWith('cache')?undefined:Number(e.target.value)})} /></label>)}
          </div>
          <label className="block">其他收费项<select aria-label={`${p.agentId} 其他收费项`} className="input mt-1" value={p.otherCharges} onChange={e=>price(i,{otherCharges:e.target.value as CostPrice['otherCharges']})}><option value="unknown">有额外收费或尚未核实</option><option value="none">已核实：除上述 Token 外无额外收费</option></select></label>
          <button type="button" className="rounded bg-zinc-800 px-3 py-2" onClick={()=>update({prices:value.prices.filter((_,at)=>at!==i)})}>移除此价格</button>
        </div>)}
        <label className="mt-3 block">添加成员价格<select aria-label="添加成员价格" className="input mt-1" value="" disabled={!available.length} onChange={e=>{const a=available.find(a=>a.id===e.target.value);if(a)update({prices:[...value.prices,{agentId:a.id,model:a.model,source:'',version:'',inputPerMillion:0,outputPerMillion:0,otherCharges:'unknown'}]});}}><option value="">选择成员及当前模型</option>{available.map(a=><option key={a.id} value={a.id}>{a.name} · {a.model}</option>)}</select></label>
      </details>
    </>}
  </fieldset>;
}
