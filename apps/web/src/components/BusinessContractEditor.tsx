import type { BusinessContract, BusinessStage } from '@agent-gand/shared';

const newStage = (): BusinessStage => ({ id: crypto.randomUUID(), title: '', criteria: [''], deliverables: [{ id: crypto.randomUUID(), title: '', kind: 'text' }] });
const button = 'rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40';
export function BusinessContractEditor({ value, onChange, disabled, agents }: { value: BusinessContract | null; onChange: (value: BusinessContract | null) => void; disabled: boolean; agents: Array<{ id: string; name: string }> }) {
  const update = (index: number, patch: Partial<BusinessStage>) => { if (value) onChange({ ...value, stages: value.stages.map((s, i) => i === index ? { ...s, ...patch } : s) }); };
  const gated = value?.executionMode === 'stage_gated';
  const assignment = () => ({ agentId: agents[0]?.id ?? '', objective: '' });
  return <section aria-label="阶段验收设置" className="space-y-3 rounded-xl border border-zinc-700 p-3 text-xs">
    <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={e => onChange(e.target.checked ? { version: 1, stages: [newStage()] } : null)} />本任务启用阶段验收</label>
    {value && <label className="block">执行与验收方式<select aria-label="阶段执行方式" className="input mt-1" disabled={disabled} value={gated ? 'stage_gated' : 'after_execution'} onChange={e => {
      if (e.target.value === 'stage_gated') onChange({ ...value, executionMode: 'stage_gated', stages: value.stages.map(s => ({ ...s, execution: s.execution ?? { assignments: [assignment()] } })) });
      else onChange({ version: 1, stages: value.stages.map(({ execution: _execution, ...s }) => s) });
    }}><option value="after_execution">执行结束后验收</option><option value="stage_gated">逐阶段执行 · 验收后继续</option></select></label>}
    <p className="text-zinc-400">{gated ? '阶段内按任务顺序派发，交付后等待你验收；通过后会继续执行下一阶段，可能消耗额度。使用常规顺序工作流，支持模型 API、Claude SDK、Codex app-server。' : '执行结束后关联交付证据，由你按顺序逐阶段验收，使用原工作流。'}清单只属于本任务，不保存为房间默认。</p>
    {value?.stages.map((stage, index) => <fieldset key={stage.id} disabled={disabled} className="min-w-0 space-y-2 rounded-lg bg-zinc-950/60 p-3">
      <legend>阶段 {index + 1}</legend>
      <label className="block">阶段名称<input aria-label={`阶段 ${index + 1} 名称`} className="input mt-1" maxLength={200} value={stage.title} placeholder="例如：方案确认" onChange={e => update(index, { title: e.target.value })} /></label>
      {gated && stage.execution && <div className="space-y-2">
        <p className="text-zinc-400">阶段任务（按下列顺序执行）</p>
        {stage.execution.assignments.map((task, at) => <div key={at} className="space-y-2 rounded border border-zinc-800 p-2">
          <label className="block">任务 {at + 1} · 成员<select aria-label={`阶段 ${index + 1} 任务 ${at + 1} 成员`} className="input mt-1" value={task.agentId} onChange={e => update(index, { execution: { ...stage.execution!, assignments: stage.execution!.assignments.map((a, i) => i === at ? { ...a, agentId: e.target.value } : a) } })}><option value="">选择房间成员</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}{task.agentId && !agents.some(a => a.id === task.agentId) && <option value={task.agentId}>成员已移出房间 · {task.agentId}</option>}</select></label>
          <label className="block">具体任务<textarea aria-label={`阶段 ${index + 1} 任务 ${at + 1} 内容`} className="input mt-1 min-h-16" maxLength={2000} value={task.objective} placeholder="说明此成员负责什么、需要交付什么" onChange={e => update(index, { execution: { ...stage.execution!, assignments: stage.execution!.assignments.map((a, i) => i === at ? { ...a, objective: e.target.value } : a) } })} /></label>
          <button type="button" className={button} disabled={stage.execution!.assignments.length === 1} onClick={() => update(index, { execution: { ...stage.execution!, assignments: stage.execution!.assignments.filter((_, i) => i !== at) } })}>删除任务</button>
        </div>)}
        <button type="button" className={button} disabled={stage.execution.assignments.length >= 12} onClick={() => update(index, { execution: { ...stage.execution!, assignments: [...stage.execution!.assignments, assignment()] } })}>添加成员任务</button>
        <div className="grid gap-2 sm:grid-cols-2"><label>阶段执行时限（秒）<input aria-label={`阶段 ${index + 1} 执行时限`} className="input mt-1" type="number" min={1} max={86400} value={stage.execution.timeoutMs === undefined ? '' : stage.execution.timeoutMs / 1000} placeholder="留空沿用运行时限" onChange={e => update(index, { execution: { ...stage.execution!, timeoutMs: e.target.value ? Number(e.target.value) * 1000 : undefined } })} /></label>
          <label>阶段输出 Token 总预算<input aria-label={`阶段 ${index + 1} Token 总预算`} className="input mt-1" type="number" min={1} max={1000000} value={stage.execution.maxTokens ?? ''} placeholder="可选；仅模型 API 支持" onChange={e => update(index, { execution: { ...stage.execution!, maxTokens: e.target.value ? Number(e.target.value) : undefined } })} /></label></div>
        <p className="text-zinc-500">时限从首个任务派发计时，包含工具与普通暂停；本阶段交付后的验收等待不计入，运行总截止时间仍持续。Token 总预算包含本阶段全部成员和工具轮次；未知消耗保留预约额度。</p>
      </div>}
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
    {value && <button type="button" className={button} disabled={disabled || value.stages.length >= 8} onClick={() => onChange({ ...value, stages: [...value.stages, { ...newStage(), ...(gated ? { execution: { assignments: [assignment()] } } : {}) }] })}>添加阶段（最多 8 个）</button>}
  </section>;
}
