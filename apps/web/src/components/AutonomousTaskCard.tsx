import {useState} from 'react';
import type {Run,AutonomousTaskView} from '@agent-gand/shared';
import {useStore} from '../store';
import * as api from '../services/api';
import {MarkdownBody} from './Markdown';
const states:Record<string,string>={completed:'已完成',failed:'失败',cancelled:'已停止',running:'正在执行',queued:'已排队',waiting:'等待已登记的后续事项',blocked:'等待前置工作'};
export function AutonomousTaskCard({run,view,detail}:{run:Run;view:AutonomousTaskView;detail:api.TaskState}){
 const {state,refreshConversation}=useStore(),[expanded,setExpanded]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const terminal=['completed','failed','cancelled'].includes(run.status),pending=state.collaborationDecisions.filter(d=>d.runId===run.id&&d.status==='pending');
 const completed=view.works.filter(w=>w.state==='completed').length,working=view.works.filter(w=>w.state==='running'),queued=view.works.filter(w=>w.state==='queued');
 const name=(id:string)=>state.agents.find(a=>a.id===id)?.name??id;
 async function action(value:'pause'|'resume'|'cancel'){setBusy(true);setError('');try{await api.runAction(run.id,value);await refreshConversation();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setBusy(false);}}
 const button='rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40';
 return <section aria-label={`第 ${run.turnNo} 轮任务`} className="my-3 min-w-0 space-y-2 rounded-xl border border-violet-500/30 bg-zinc-900/70 p-3 text-xs [overflow-wrap:anywhere]">
  <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-violet-200">自主协作 · {name(view.coordinatorId)}负责</strong><span>{detail.paused?'已暂停':pending.length?'等待你的决定':({completed:'已交付',failed:'执行失败',cancelled:'已停止',running:'正在协作',pending:'已排队',awaiting_approval:'等待审批',waiting_for_user:'等待后续事项'}[run.status]??run.status)}</span></div>
  <p className="text-zinc-300">{run.goal}</p><p className="text-zinc-400">已完成 {completed}/{view.works.length} 项工作{working.length?` · ${working.map(w=>name(w.agentId)).join('、')}正在处理`:''}{queued.length?` · ${queued.map(w=>name(w.agentId)).join('、')}已排队`:''}{view.instructionRevision?` · 已收到 ${view.instructionRevision} 次补充`:''}</p>
  <p className="text-zinc-500">输出已用及占额 {view.budget.chargedOutputTokens}/{view.budget.maxOutputTokens} tokens · 所有分支共用本任务预算</p>
  {detail.pauseRequested&&!detail.paused&&<p className="text-amber-200">暂停已请求，等待当前调用到达安全边界。</p>}
  {pending.length>0&&<p className="text-amber-200">请处理本任务的问题或确切授权卡，回答后自动继续。</p>}
  <div className="flex flex-wrap gap-2"><button aria-expanded={expanded} className={button} onClick={()=>setExpanded(v=>!v)}>{expanded?'收起协作过程':'展开协作过程'}</button>{!terminal&&(detail.paused?<button className={button} disabled={busy} onClick={()=>void action('resume')}>继续任务</button>:<button className={button} disabled={busy||detail.pauseRequested} onClick={()=>void action('pause')}>暂停任务</button>)}{!terminal&&<button className={`${button} text-red-300`} disabled={busy} onClick={()=>void action('cancel')}>停止任务</button>}</div>
  {expanded&&<div role="region" aria-label="协作过程" className="space-y-2 border-t border-zinc-800 pt-2">{view.works.map(w=><details key={w.id} className="rounded bg-zinc-950/50 p-2"><summary>{name(w.agentId)} · {states[w.state]??w.state} · {w.key==='root'?'组织与交付':w.key}</summary><p className="mt-2 whitespace-pre-wrap text-zinc-300">{w.objective}</p>{w.dependsOn.length>0&&<p className="mt-1 text-zinc-500">前置：{w.dependsOn.map(id=>view.works.find(w=>w.id===id)?.key??id).join('、')}</p>}{w.resultMessageId&&<div className="mt-2"><MarkdownBody text={state.messages.find(m=>m.id===w.resultMessageId)?.body??'结果已保存，可在本任务消息中查看。'}/></div>}</details>)}<p className="text-zinc-500">执行完成不等于业务质量已获你的验收；已执行效果与费用保留。</p></div>}
  {run.status==='failed'&&<p className="text-red-300">任务未能完成，已确认结果与消耗已保留。可展开过程并在任务详情核对原因。</p>}
  {error&&<p role="alert" className="text-red-300">{error}</p>}
 </section>;
}
