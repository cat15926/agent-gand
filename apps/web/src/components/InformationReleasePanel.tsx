import { useEffect, useRef, useState } from 'react';
import type { AgentDefinition, Conversation, InformationReleaseMode, InformationReleasePreview, InformationReleaseState, PrivateAggregatePreview, ScopedDeliveryStatus } from '@agent-gand/shared';
import { managementRequest } from '../services/accounts';

const base='/api/accounts/information-releases';
const button='rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-40';
const primary='rounded-lg bg-violet-600 px-3 py-2 text-xs text-white disabled:opacity-40';
export function InformationReleasePanel({room,agents,runs,onCreated}:{room:Conversation;agents:AgentDefinition[];runs:ScopedDeliveryStatus[];onCreated:()=>Promise<void>}) {
  const [states,setStates]=useState<InformationReleaseState[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [sourceId,setSourceId]=useState(''),[keys,setKeys]=useState<string[]>([]),[aggregator,setAggregator]=useState('');
  const [instruction,setInstruction]=useState('综合所选报告生成一份总评，详细依据保留私密。'),[maxTokens,setMaxTokens]=useState(8000);
  const [preview,setPreview]=useState<PrivateAggregatePreview|null>(null);
  const clientKey=useRef(crypto.randomUUID());
  const members=agents.filter(a=>room.agentIds.includes(a.id)&&(a.execution?.kind??'builtin-llm')==='builtin-llm');
  const sources=runs.filter(r=>r.status==='completed'&&r.items.some(i=>i.expectation==='result'&&i.status==='completed')&&!states.some(s=>s.runId===r.runId));
  const source=sources.find(r=>r.runId===sourceId);
  const reload=async()=>setStates(await managementRequest<InformationReleaseState[]>(`${base}/rooms/${room.id}`));
  useEffect(()=>{let live=true;const load=()=>managementRequest<InformationReleaseState[]>(`${base}/rooms/${room.id}`).then(s=>{if(live)setStates(s);}).catch(e=>{if(live)setError(e.message);});void load();const timer=setInterval(()=>void load(),2500);return()=>{live=false;clearInterval(timer);};},[room.id]);
  const invalidate=()=>{setPreview(null);clientKey.current=crypto.randomUUID();};
  async function perform(action:()=>Promise<unknown>){setBusy(true);setError('');try{await action();await reload();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  return <section aria-label="私密汇总与发布" className="min-w-0 space-y-4 border-t border-zinc-700 pt-4">
    <h3 className="font-semibold">私密汇总与发布</h3>
    <p className="text-xs text-zinc-400">先授权一位成员读取选中的结果，生成私密总评；再由你批准确切发布文字和接收者。原报告保持私密。汇总会创建独立任务并使用新的预算。</p>
    <fieldset disabled={busy} className="min-w-0 space-y-3">
      <label className="block text-xs">来源任务<select aria-label="汇总来源任务" className="input mt-1" value={sourceId} onChange={e=>{setSourceId(e.target.value);setKeys([]);invalidate();}}><option value="">选择已完成的独立材料任务</option>{sources.map(r=><option key={r.runId} value={r.runId}>{r.goal}</option>)}</select></label>
      {source&&<fieldset className="space-y-2"><legend className="mb-2 text-xs">允许汇总者读取的结果</legend>{source.items.filter(i=>i.expectation==='result'&&i.status==='completed').map(i=><label key={i.key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={keys.includes(i.key)} onChange={e=>{setKeys(old=>e.target.checked?[...old,i.key]:old.filter(k=>k!==i.key));invalidate();}}/>{i.key} · {agents.find(a=>a.id===i.target)?.name??i.target}</label>)}</fieldset>}
      <label className="block text-xs">私密汇总者<select aria-label="私密汇总者" className="input mt-1" value={aggregator} onChange={e=>{setAggregator(e.target.value);invalidate();}}><option value="">选择模型 API 成员</option>{members.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="block text-xs">汇总要求<textarea aria-label="汇总要求" className="input mt-1 w-full" rows={2} maxLength={2000} value={instruction} onChange={e=>{setInstruction(e.target.value);invalidate();}}/></label>
      <label className="block text-xs">汇总输出 Token 总预算<input aria-label="汇总输出预算" type="number" className="input mt-1" min={256} value={maxTokens} onChange={e=>{setMaxTokens(Number(e.target.value));invalidate();}}/></label>
      <button type="button" className={button} disabled={!source||!keys.length||!aggregator||!instruction.trim()} onClick={()=>void perform(async()=>setPreview(await managementRequest<PrivateAggregatePreview>(`${base}/aggregate/preview`,'POST',{sourceRunId:sourceId,itemKeys:keys,aggregatorId:aggregator,instruction,maxTokens})))}>预览汇总授权</button>
    </fieldset>
    {preview&&<section aria-label="汇总读取授权预览" className="space-y-3 rounded-lg border border-violet-500/50 p-3">
      <p className="text-xs">{preview.disclosure}</p><p className="text-xs">汇总者：{agents.find(a=>a.id===preview.draft.aggregatorId)?.name??preview.draft.aggregatorId} · 输出预算 {preview.draft.maxTokens}</p>
      {preview.costPolicy&&<p className="text-xs text-amber-200">继承房间费用估算上限 {preview.costPolicy.maxCost} {preview.costPolicy.currency}，不保证供应商账单硬上限。</p>}
      {preview.sources.map(s=><details key={s.key}><summary className="cursor-pointer text-xs text-violet-200">查看将授权的结果 {s.key}</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-xs">{s.body}</pre></details>)}
      <button type="button" disabled={busy} className={primary} onClick={()=>void perform(async()=>{await managementRequest(`${base}/aggregate/confirm`,'POST',{previewId:preview.id,fingerprint:preview.fingerprint,clientKey:clientKey.current});invalidate();setKeys([]);await onCreated();})}>授权读取并生成私密草稿</button>
    </section>}
    {states.map(state=><ReleaseCard key={state.runId} state={state} agents={agents.filter(a=>room.agentIds.includes(a.id))} runStatus={runs.find(r=>r.runId===state.runId)?.status} onChange={reload}/>)}
    {error&&<p role="alert" className="text-xs text-red-300">{error}</p>}
  </section>;
}
function ReleaseCard({state,agents,runStatus,onChange}:{state:InformationReleaseState;agents:AgentDefinition[];runStatus?:string;onChange:()=>Promise<void>}) {
  const [body,setBody]=useState(state.draft?.body??''),[mode,setMode]=useState<InformationReleaseMode>('exact_content');
  const [visibility,setVisibility]=useState<'private'|'public'>('private'),[targets,setTargets]=useState<string[]>([]);
  const [preview,setPreview]=useState<InformationReleasePreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=useRef(crypto.randomUUID());
  useEffect(()=>{setBody(state.draft?.body??'');setPreview(null);key.current=crypto.randomUUID();},[state.draft?.revision]);
  const dirty=body!==state.draft?.body;
  const closed=state.records.length>0||['failed','cancelled','completed'].includes(runStatus??'');
  const invalidate=()=>{setPreview(null);key.current=crypto.randomUUID();};
  async function perform(fn:()=>Promise<unknown>){setBusy(true);setError('');try{await fn();await onChange();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  return <article aria-label={`发布卡 ${state.runId}`} className="min-w-0 space-y-3 rounded-lg border border-zinc-700 p-3">
    <h4 className="text-sm font-semibold">私密汇总草稿 · {agents.find(a=>a.id===state.aggregatorId)?.name??state.aggregatorId}</h4>
    <details className="text-xs text-zinc-400"><summary className="cursor-pointer">来源与版本（{state.sourceSummary.length} 份报告）</summary>{state.sourceSummary.map(s=><p key={s.key} className="mt-1 break-all">{s.key} · 版本 {s.ref.version} · {s.inputCount} 条输入 · SHA-256 {s.ref.sha256}</p>)}</details>
    {!state.draft?<p className="text-xs text-zinc-400">{closed?'任务已结束，未生成草稿。':'正在生成私密草稿，尚未发布。'}</p>:<>
      <p className="text-xs text-zinc-400">草稿 v{state.draft.revision} · 仅 Owner 与汇总者可读；批准与发布分为两步。</p>
      {closed?<details className="text-xs"><summary className="cursor-pointer text-violet-200">查看保留的私密草稿</summary><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{body}</pre></details>:<fieldset disabled={busy} className="min-w-0 space-y-3">
        <label className="block text-xs">确切发布文字<textarea aria-label="确切发布文字" rows={5} maxLength={24000} className="input mt-1 w-full" value={body} onChange={e=>{setBody(e.target.value);invalidate();}}/></label>
        {dirty&&<button type="button" className={button} onClick={()=>void perform(()=>managementRequest(`${base}/runs/${state.runId}/draft`,'PATCH',{expectedRevision:state.draft!.revision,body}))}>保存新版本并使旧批准失效</button>}
        <label className="block text-xs">发布内容<select aria-label="发布内容" className="input mt-1" value={mode} onChange={e=>{setMode(e.target.value as InformationReleaseMode);invalidate();}}><option value="exact_content">确切草稿文字</option><option value="deterministic_projection">固定状态投影（仅编号与完成状态）</option></select></label>
        <label className="block text-xs">发布范围<select aria-label="发布范围" className="input mt-1" value={visibility} onChange={e=>{setVisibility(e.target.value as 'private'|'public');invalidate();}}><option value="private">指定成员</option><option value="public">房间公开</option></select></label>
        {visibility==='private'&&<fieldset className="flex flex-wrap gap-3"><legend className="mb-2 text-xs">发布接收者</legend>{agents.map(a=><label className="flex items-center gap-1 text-xs" key={a.id}><input type="checkbox" aria-label={`发布给 ${a.name}`} checked={targets.includes(a.id)} onChange={e=>{setTargets(old=>e.target.checked?[...old,a.id]:old.filter(id=>id!==a.id));invalidate();}}/>{a.name}</label>)}</fieldset>}
        <button type="button" className={button} disabled={dirty||visibility==='private'&&!targets.length} onClick={()=>void perform(async()=>setPreview(await managementRequest<InformationReleasePreview>(`${base}/runs/${state.runId}/preview`,'POST',{expectedRevision:state.draft!.revision,mode,access:{visibility,audience:visibility==='public'?[]:targets}})))}>预览确切发布内容</button>
      </fieldset>}
      {preview&&!closed&&<section aria-label="发布批准预览" className="space-y-2 rounded-lg border border-amber-500/50 p-3">
        <p className="text-xs text-amber-200">将向{preview.access.visibility==='public'?'房间公开':preview.access.audience.filter(id=>id!=='user').map(id=>agents.find(a=>a.id===id)?.name??id).join('、')}发布以下完整文字。无附件；仅可发布一次。</p>
        <pre className="whitespace-pre-wrap break-words font-sans text-xs">{preview.body}</pre>
        <p className="text-xs text-zinc-400">绑定草稿 v{preview.draftRevision}、{preview.sourceCount} 份来源报告与 {preview.inputCount} 条输入记录。有效至 {new Date(preview.expiresAt).toLocaleTimeString()}。修改内容、成员或输入后须重新批准。</p>
        <button type="button" disabled={busy} className={primary} onClick={()=>void perform(async()=>{await managementRequest(`${base}/confirm`,'POST',{previewId:preview.id,fingerprint:preview.fingerprint,clientKey:key.current});setPreview(null);key.current=crypto.randomUUID();})}>批准此版本（暂不发布）</button>
      </section>}
    </>}
    {state.grants.map(g=>{const policy=state.policies.find(p=>p.id===g.policyId),valid=policy?.status==='approved'&&g.draftRevision===state.draft?.revision&&Date.parse(policy.expiresAt)>Date.now();return <section key={g.id} aria-label="已批准发布" className="space-y-2 border-t border-zinc-800 pt-3">
      <p className="text-xs">草稿 v{g.draftRevision} · {g.status==='consumed'?'已发布':policy?.status==='revoked'?'已撤销':valid?'已批准，等待发布':'批准已失效'}</p>
      {g.status==='ready'&&valid&&!closed&&<><pre className="whitespace-pre-wrap break-words font-sans text-xs">{g.body}</pre><p className="text-xs text-amber-200">接收范围：{g.access.visibility==='public'?'房间公开':g.access.audience.filter(id=>id!=='user').map(id=>agents.find(a=>a.id===id)?.name??id).join('、')}。发布后无法收回已被阅读的信息。</p><button type="button" className={primary} disabled={busy||dirty} onClick={()=>void perform(()=>managementRequest(`${base}/grants/${g.id}/publish`,'POST',{}))}>发布已批准内容</button></>}
      {policy?.status!=='revoked'&&g.status==='ready'&&<button type="button" className={`${button} ml-2`} disabled={busy} onClick={()=>void perform(()=>managementRequest(`/api/accounts/information-release-policies/${g.policyId}/revoke`,'POST',{}))}>撤销批准</button>}
    </section>;})}
    {state.records.map(r=><div key={r.id} role="status" className="rounded-lg bg-emerald-900/20 p-2 text-xs text-emerald-200">发布完成 · 已创建独立消息；原报告保持原权限。<p className="mt-1">接收范围：{r.access.visibility==='public'?'房间公开':r.access.audience.filter(id=>id!=='user').map(id=>agents.find(a=>a.id===id)?.name??id).join('、')}</p><pre className="mt-2 whitespace-pre-wrap break-words font-sans">{r.body}</pre></div>)}
    {error&&<p role="alert" className="text-xs text-red-300">{error}</p>}
  </article>;
}
