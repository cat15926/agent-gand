import type { BusinessContract, BusinessStage } from '@agent-gand/shared';

const newStage = (): BusinessStage => ({ id: crypto.randomUUID(), title: '', criteria: [''], deliverables: [{ id: crypto.randomUUID(), title: '', kind: 'text' }] });
const button = 'rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40';
export function BusinessContractEditor({ value, onChange, disabled }: { value: BusinessContract | null; onChange: (value: BusinessContract | null) => void; disabled: boolean }) {
  const update = (index: number, patch: Partial<BusinessStage>) => { if (value) onChange({ ...value, stages: value.stages.map((s, i) => i === index ? { ...s, ...patch } : s) }); };
  return <section aria-label="阶段验收设置" className="space-y-3 rounded-xl border border-zinc-700 p-3 text-xs">
    <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={e => onChange(e.target.checked ? { version: 1, stages: [newStage()] } : null)} />本任务启用阶段验收</label>
    <p className="text-zinc-400">执行结束后关联交付证据，由你按顺序逐阶段验收。清单只属于本任务，不改变工作流调度，也不保存为房间默认。</p>
    {value?.stages.map((stage, index) => <fieldset key={stage.id} disabled={disabled} className="min-w-0 space-y-2 rounded-lg bg-zinc-950/60 p-3">
      <legend>阶段 {index + 1}</legend>
      <label className="block">阶段名称<input aria-label={`阶段 ${index + 1} 名称`} className="input mt-1" maxLength={200} value={stage.title} placeholder="例如：方案确认" onChange={e => update(index, { title: e.target.value })} /></label>
      <label className="block">验收标准（每行一条，最多 12 条）<textarea aria-label={`阶段 ${index + 1} 验收标准`} className="input mt-1 min-h-20" value={stage.criteria.join('\n')} placeholder="例如：覆盖失败分支与恢复方式" onChange={e => update(index, { criteria: e.target.value.split('\n') })} /></label>
      <p>必要交付项</p>
      {stage.deliverables.map((item, at) => <div className="flex min-w-0 flex-wrap gap-2" key={item.id}>
        <input aria-label={`阶段 ${index + 1} 交付项 ${at + 1}`} className="input min-w-0 flex-1" maxLength={200} value={item.title} placeholder="交付内容名称" onChange={e => update(index, { deliverables: stage.deliverables.map((d, i) => i === at ? { ...d, title: e.target.value } : d) })} />
        <select aria-label={`阶段 ${index + 1} 交付类型 ${at + 1}`} className="input w-auto" value={item.kind} onChange={e => update(index, { deliverables: stage.deliverables.map((d, i) => i === at ? { ...d, kind: e.target.value as 'text' | 'file' } : d) })}><option value="text">文本输出</option><option value="file">工作区文件</option></select>
        <button type="button" className={button} aria-label={`删除交付项 ${at + 1}`} disabled={stage.deliverables.length === 1} onClick={() => update(index, { deliverables: stage.deliverables.filter((_, i) => i !== at) })}>删除</button>
      </div>)}
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={stage.deliverables.length >= 12} onClick={() => update(index, { deliverables: [...stage.deliverables, { id: crypto.randomUUID(), title: '', kind: 'text' }] })}>添加交付项</button>
        <button type="button" className={button} disabled={index === 0} onClick={() => { const stages = [...value.stages]; [stages[index - 1], stages[index]] = [stages[index]!, stages[index - 1]!]; onChange({ ...value, stages }); }}>上移阶段</button>
        <button type="button" className={button} disabled={value.stages.length === 1} onClick={() => onChange({ ...value, stages: value.stages.filter((_, i) => i !== index) })}>删除阶段</button></div>
    </fieldset>)}
    {value && <button type="button" className={button} disabled={disabled || value.stages.length >= 8} onClick={() => onChange({ ...value, stages: [...value.stages, newStage()] })}>添加阶段（最多 8 个）</button>}
  </section>;
}
