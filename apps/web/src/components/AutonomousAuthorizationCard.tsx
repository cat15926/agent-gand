import {useEffect,useState} from 'react';
import type {AutonomousDecisionPreview,CollaborationUserDecision} from '@agent-gand/shared';
import {managementRequest} from '../services/accounts';
import {useStore} from '../store';

/** Only the human management session can approve; no model-facing route accepts this action. */
export function AutonomousAuthorizationCard({decision}:{decision:CollaborationUserDecision}){
  const {state,refreshConversation}=useStore();
  const [preview,setPreview]=useState<AutonomousDecisionPreview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const id=typeof decision.payload.autonomousDecisionId==='string'?decision.payload.autonomousDecisionId:'';
  useEffect(()=>{let live=true;void managementRequest<AutonomousDecisionPreview>(`/api/accounts/autonomous-collaboration/decisions/${encodeURIComponent(id)}`)
    .then(value=>{if(live)setPreview(value);}).catch(reason=>{if(live)setError(reason instanceof Error?reason.message:String(reason));});return()=>{live=false;};},[id]);
  async function resolve(action:'approve'|'deny'){
    if(!preview)return;setBusy(true);setError('');
    try{await managementRequest(`/api/accounts/autonomous-collaboration/decisions/${encodeURIComponent(id)}/resolve`,'POST',{fingerprint:preview.fingerprint,action});await refreshConversation();}
    catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}
  }
  const audience=preview?.access.visibility==='public'?'房间公开':preview?.access.audience.map(id=>id==='user'?'你':state.agents.find(a=>a.id===id)?.name??id).join('、');
  return <section className="mt-3 min-w-0 space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3" aria-label="确切授权决策">
    <div className="text-xs font-medium text-amber-200">{preview?.kind==='intake'?'需要新增结果读取者':'需要扩大交付范围'}</div>
    {preview?<>
      <p className="text-xs text-zinc-300">{preview.reason}</p>
      <p className="break-words text-xs text-amber-100">接收范围：{audience}</p>
      <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-950/60 p-3 font-sans text-xs text-zinc-200 [overflow-wrap:anywhere]">{preview.body}</pre>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-medium text-zinc-950 disabled:opacity-40" onClick={()=>void resolve('approve')}>批准此内容与范围</button>
        <button type="button" disabled={busy} className="rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 disabled:opacity-40" onClick={()=>void resolve('deny')}>拒绝并继续</button>
      </div>
    </>:!error&&<p className="text-xs text-zinc-400">正在读取待批准的确切内容…</p>}
    {error&&<p role="alert" className="break-words text-xs text-red-300">{error}</p>}
  </section>;
}
