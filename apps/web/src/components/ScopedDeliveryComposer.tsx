import { useEffect, useRef, useState } from 'react';
import type { AgentDefinition, Conversation, ScopedDeliveryDraft, ScopedDeliveryPreview, ScopedDeliveryStatus } from '@agent-gand/shared';
import { managementRequest } from '../services/accounts';
import { stopCollaborationRun } from '../services/api';
import { InformationReleasePanel } from './InformationReleasePanel';
import { Drawer } from './Drawer';

const base='/api/accounts/scoped-delivery';
const button='rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40';
const expectationLabels={material:'仅投递',acknowledged:'确认收到',result:'提交结果'};
const stateLabels:Record<string,string>={pending:'未开始',queued:'排队中',running:'执行中',delivered:'已投递',acknowledged:'已确认收到',completed:'已完成',failed:'失败',blocked:'需要处理',cancelled:'已停止',waiting_for_user:'等待用户'};
/** Private drafts remain in memory; the server seals previews and owns the frozen plan. */
export function ScopedDeliveryComposer({room,agents,onCreated}:{room:Conversation;agents:AgentDefinition[];onCreated:()=>Promise<void>}) {
  const members=agents.filter(a=>room.agentIds.includes(a.id)&&(a.execution?.kind??'builtin-llm')==='builtin-llm');
  const [open,setOpen]=useState(false),[goal,setGoal]=useState(''),[coordinator,setCoordinator]=useState(members[0]?.id??'');
  const [items,setItems]=useState<ScopedDeliveryDraft['items']>([{key:'item-1',target:members[1]?.id??members[0]?.id??'',batch:1,material:'',expectation:'result'}]);
  const [join,setJoin]=useState<ScopedDeliveryDraft['join']>('all');
  const [maxTokens,setMaxTokens]=useState(16000),[preview,setPreview]=useState<ScopedDeliveryPreview|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [runs,setRuns]=useState<ScopedDeliveryStatus[]>([]);
  const clientKey=useRef(crypto.randomUUID());
  const invalidate=()=>{setPreview(null);setError('');clientKey.current=crypto.randomUUID();};
  const reload=async()=>setRuns(await managementRequest<ScopedDeliveryStatus[]>(`${base}/rooms/${encodeURIComponent(room.id)}`));
  useEffect(()=>{if(!open)return;let live=true;const load=()=>managementRequest<ScopedDeliveryStatus[]>(`${base}/rooms/${encodeURIComponent(room.id)}`).then(data=>{if(live)setRuns(data);}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:'读取失败');});void load();const timer=setInterval(()=>void load(),2500);return()=>{live=false;clearInterval(timer);};},[open,room.id]);
  const update=(index:number,patch:Partial<ScopedDeliveryDraft['items'][number]>)=>{invalidate();setItems(old=>old.map((i,n)=>n===index?{...i,...patch}:i));};
  async function prepare(){setBusy(true);setError('');try{setPreview(await managementRequest<ScopedDeliveryPreview>(`${base}/preview`,'POST',{conversationId:room.id,coordinatorId:coordinator,goal,items,maxTokens,join,returnProfile:'status-only-v1'}));}catch(reason){setError(reason instanceof Error?reason.message:'预览失败');}finally{setBusy(false);}}
  async function confirm(){if(!preview)return;setBusy(true);setError('');try{await managementRequest(`${base}/confirm`,'POST',{previewId:preview.id,fingerprint:preview.fingerprint,clientKey:clientKey.current});setPreview(null);setGoal('');setItems([{key:'item-1',target:members[1]?.id??members[0]?.id??'',batch:1,material:'',expectation:'result'}]);clientKey.current=crypto.randomUUID();setNotice('已启动独立材料协作，可在下方查看各项状态和私密结果。');await reload();await onCreated();}catch(reason){setError(reason instanceof Error?reason.message:'提交失败');}finally{setBusy(false);}}
  const name=(id:string)=>agents.find(a=>a.id===id)?.name??id;
  return <>
    <button type="button" className={`${button} mb-3`} onClick={()=>setOpen(true)}>独立材料协作</button>
    <Drawer open={open} title="独立材料协作" onClose={()=>{if(!busy)setOpen(false);}}>
      <div className="space-y-4 p-4 text-sm [overflow-wrap:anywhere]">
        <p className="text-xs text-zinc-400">给每位成员单独的文字材料，按批次处理。组织者只看固定状态，私密结果由你查看。当前支持模型 API；每批最多 3 项、最多 2 批，不读取房间历史或文件。</p>
        {!members.length&&<p role="alert" className="text-amber-300">房间内暂无模型 API 成员，请先在成员管理中添加。</p>}
        <fieldset disabled={busy} className="min-w-0 space-y-3">
          <label className="block">组织目标<textarea aria-label="独立材料组织目标" className="input mt-1 w-full" rows={2} maxLength={2000} value={goal} onChange={e=>{invalidate();setGoal(e.target.value);}} placeholder="说明组织目标；不要在这里填写只允许单个成员看到的材料"/></label>
          <label className="block">组织者<select aria-label="独立材料组织者" className="input mt-1" value={coordinator} onChange={e=>{invalidate();setCoordinator(e.target.value);}}>{members.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
          <label className="block">批次完成条件<select aria-label="独立材料完成条件" className="input mt-1" value={join} onChange={e=>{invalidate();setJoin(e.target.value as typeof join);}}><option value="all">全部满足后继续</option><option value="any">首个有效结果后继续（只读）</option></select></label>
          {join==='any'&&<p className="text-xs text-amber-200">只支持第 1 批，每个事项须选择“提交结果”。首个结果验收通过后停止其他项；已发出的请求仍可能计费。不开放文件、原生工具或外部写入。</p>}
          {items.map((item,index)=><fieldset key={index} className="min-w-0 space-y-2 rounded-lg border border-zinc-700 p-3">
            <legend className="px-1 text-xs text-violet-200">材料 {index+1} · {item.key}</legend>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <label className="min-w-0 text-xs">接收者<select aria-label={`材料 ${index+1} 接收者`} className="input mt-1" value={item.target} onChange={e=>update(index,{target:e.target.value})}>{members.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
              <label className="min-w-0 text-xs">批次<select aria-label={`材料 ${index+1} 批次`} className="input mt-1" value={item.batch} onChange={e=>update(index,{batch:Number(e.target.value)})}><option value={1}>第 1 批</option><option value={2}>第 2 批</option></select></label>
            </div>
            <label className="block text-xs">交付要求<select aria-label={`材料 ${index+1} 交付要求`} className="input mt-1" value={item.expectation} onChange={e=>update(index,{expectation:e.target.value as typeof item.expectation})}>{Object.entries(expectationLabels).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label>
            <p className="text-xs text-zinc-500">{item.expectation==='material'?'送达独立上下文即完成，不调用接收者模型。':item.expectation==='acknowledged'?'接收者必须明确确认收到；不会当作业务结果。':'接收者必须提交实际结果；一句“收到”不能通过。'}</p>
            <textarea aria-label={`材料 ${index+1} 正文`} className="input w-full" rows={4} maxLength={12000} value={item.material} onChange={e=>update(index,{material:e.target.value})} placeholder="仅 Owner 和此接收者可见的材料及具体任务"/>
            <button type="button" className={button} disabled={items.length===1} onClick={()=>{invalidate();setItems(old=>old.filter((_,i)=>i!==index));}}>移除材料 {index+1}</button>
          </fieldset>)}
          <button type="button" className={button} disabled={items.length>=6} onClick={()=>{invalidate();setItems(old=>[...old,{key:`item-${Math.max(0,...old.map(i=>Number(i.key.replace('item-',''))||0))+1}`,target:members[1]?.id??members[0]?.id??'',batch:old.length>=3?2:1,material:'',expectation:'result'}]);}}>＋ 添加材料</button>
          <label className="block text-xs">本轮输出 Token 总预算<input type="number" aria-label="独立材料输出预算" className="input mt-1" min={256} step={256} value={maxTokens} onChange={e=>{invalidate();setMaxTokens(Number(e.target.value));}}/></label>
          <p className="text-xs text-zinc-500">组织者与各批次共用预算；实际费用另受现有协作限制约束。用量未知时保留占额，不自动重发。</p>
          <button type="button" className={button} disabled={!members.length||!goal.trim()||items.some(i=>!i.material.trim())} onClick={()=>void prepare()}>{busy?'处理中…':'预览材料分发'}</button>
        </fieldset>
        {preview&&<section aria-label="独立材料确认预览" className="space-y-3 rounded-lg border border-violet-500/50 bg-violet-500/5 p-3">
          <h3 className="font-semibold">确认可见范围与顺序</h3><p className="text-xs text-zinc-300">{preview.disclosure}</p>
          {[1,2].filter(b=>preview.draft.items.some(i=>i.batch===b)).map(b=><div key={b}><strong>第 {b} 批 · {preview.draft.join==='any'?'首个有效结果后继续（只读）':'全部满足后继续'}</strong><ul className="mt-2 space-y-1 text-xs">{preview.draft.items.filter(i=>i.batch===b).map(i=><li key={i.key}>{i.key} → {name(i.target)} · {expectationLabels[i.expectation]} · 正文 {i.material.length} 字符</li>)}</ul></div>)}
          <p className="text-xs">组织者：{name(preview.draft.coordinatorId)} · 预计派发 {preview.maxDispatches} 次 · 共用输出预算 {preview.draft.maxTokens}</p>
          {preview.costPolicy&&<p className="text-xs text-amber-200">继承房间费用政策：估算上限 {preview.costPolicy.maxCost} {preview.costPolicy.currency}；未知费用{preview.costPolicy.unknownAction==='stop'?'停止派发':`每次预留 ${preview.costPolicy.unknownReserve}`}。估算控制不保证供应商账单硬上限。</p>}
          <button type="button" disabled={busy} className="rounded-lg bg-violet-600 px-3 py-2 text-sm disabled:opacity-40" onClick={()=>void confirm()}>确认授权并执行</button>
        </section>}
        {error&&<p role="alert" className="text-red-300">{error}</p>}{notice&&<p role="status" className="text-emerald-300">{notice}</p>}
        <section aria-label="独立材料运行面板" className="space-y-3 border-t border-zinc-700 pt-4"><h3 className="font-semibold">运行记录 · Owner 可见</h3>{!runs.length&&<p className="text-xs text-zinc-500">尚无独立材料任务</p>}
          {runs.map(r=><article key={r.runId} className="space-y-2 rounded-lg bg-zinc-900 p-3"><strong>{r.goal}</strong>{['running','waiting_for_user','awaiting_approval'].includes(r.status)&&<button type="button" disabled={busy} className={button} onClick={()=>{setBusy(true);void stopCollaborationRun(r.runId).then(reload).catch(reason=>setError(reason instanceof Error?reason.message:'停止失败')).finally(()=>setBusy(false));}}>停止此任务</button>}<p className="text-xs text-zinc-400">{stateLabels[r.status]??r.status} · 已计入输出 {r.chargedTokens}/{r.maxTokens}{r.unknownCalls>0?` · ${r.unknownCalls} 次用量未知（已保留预算）`:''}</p>
            {r.costBudget&&<p className="text-xs text-amber-200">费用已计入 {r.costBudget.run.charged} / {r.costBudget.run.limit} {r.costBudget.currency} · 未知调用 {r.costBudget.run.unknownCalls}</p>}
            {r.items.map(i=><div className="border-t border-zinc-800 pt-2 text-xs" key={i.key}><p>第 {i.batch} 批 · {i.key} → {name(i.target)} · {expectationLabels[i.expectation]} · {stateLabels[i.status]??i.status}</p>{i.output&&<details className="mt-1"><summary className="cursor-pointer text-violet-300">查看该项私密结果</summary><pre className="mt-2 whitespace-pre-wrap font-sans">{i.output}</pre></details>}</div>)}
          </article>)}
        </section>
        {open&&<InformationReleasePanel room={room} agents={agents} runs={runs} onCreated={async()=>{await reload();await onCreated();}}/>}
      </div>
    </Drawer>
  </>;
}
