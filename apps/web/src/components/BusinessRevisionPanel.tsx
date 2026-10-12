import { useState } from 'react';
import type { BusinessContract, BusinessState } from '@agent-gand/shared';
import * as api from '../services/api';
import { BusinessContractEditor } from './BusinessContractEditor';
import { BusinessChangeImpact } from './BusinessChangeImpact';
import { BusinessRecoveryPanel } from './BusinessRecoveryPanel';
import { CostBudgetSummary } from './CostBudgetPanel';

export function BusinessRevisionPanel({state,members,onCreated}:{state:BusinessState;members:Array<{id:string;name:string}>;onCreated:(id:string)=>Promise<void>}) {
  const [contract,setContract]=useState<BusinessContract>({...structuredClone(state.contract!),version:2,revision:(state.contract!.revision??1)+1});
  const [instruction,setInstruction]=useState(''),[preview,setPreview]=useState<api.BusinessRevisionPreview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const update=(value:BusinessContract|null)=>{if(value)setContract({...value,version:2,revision:(state.contract!.revision??1)+1});setPreview(null);};
  async function prepare(){setBusy(true);setError('');setPreview(null);try{setPreview(await api.previewBusinessRevision(state.runId,{expectedVersion:state.version,contract,instruction}));}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
  async function confirm(){if(!preview)return;setBusy(true);setError('');try{const result=await api.submitBusinessRevision(state.runId,preview);await onCreated(result.run.id);}catch(e){setError(e instanceof Error?e.message:String(e));setPreview(null);}finally{setBusy(false);}}
  return <details className="rounded-lg border border-violet-500/30 p-3"><summary className="cursor-pointer">修订验收清单或成员分工 · 创建新契约版本</summary><div className="mt-3 space-y-3">
    <p className="text-zinc-400">原契约及验收决定保留。修订须在失败或阶段验收边界确认，受影响的交付和后续阶段重新处理，已用预算继续结转。</p>
    <BusinessRecoveryPanel runId={state.runId} members={members} onReviewed={()=>setPreview(null)}/>
    <BusinessContractEditor value={contract} disabled={busy} agents={members} onChange={update} revisionMode/>
    <label className="block">修订说明<textarea aria-label="契约修订说明" className="input mt-1 min-h-20" maxLength={2000} value={instruction} disabled={busy} onChange={e=>{setInstruction(e.target.value);setPreview(null);}}/></label>
    <button className="rounded-lg bg-zinc-800 px-3 py-2 disabled:opacity-40" disabled={busy||!instruction.trim()} onClick={()=>void prepare()}>预览契约修订</button>
    {preview&&<div aria-label="契约修订预览" className="space-y-3">{preview.checkpoint.impact&&<BusinessChangeImpact impact={preview.checkpoint.impact} members={members}/>}
      {preview.checkpoint.costBudget&&<CostBudgetSummary budget={preview.checkpoint.costBudget}/>}
      <p>本轮已占用输出 Token：{preview.checkpoint.carriedRunTokens}。确认后创建关联任务并调用模型，可能消耗额度。</p>
      {preview.preview.decision.issues.map((i,n)=><p key={n}>{i.message}</p>)}
      <button className="rounded-lg bg-violet-500 px-3 py-2 text-white disabled:opacity-40" disabled={busy||preview.preview.decision.issues.some(i=>i.severity==='error')} onClick={()=>void confirm()}>确认修订并执行</button>
    </div>}{error&&<p role="alert" className="text-red-300">{error}</p>}
  </div></details>;
}
