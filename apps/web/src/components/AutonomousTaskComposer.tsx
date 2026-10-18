import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {AutonomousEntryOptions,AutonomousTaskInput,Conversation,Message} from '@agent-gand/shared';
import {useStore} from '../store';
import * as api from '../services/api';
import {mentionedRecipients} from '../services/recipientSelection';
import {Drawer} from './Drawer';
import {AgentAvatar} from './AgentAvatar';

const button='rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40';
export function AutonomousTaskComposer({room,reply,onReplyClear,onAdvanced,options}:{room?:Conversation;reply?:Message|null;onReplyClear?:()=>void;onAdvanced:()=>void;options:AutonomousEntryOptions}){
 const {state,setActiveConversation,setActiveRun,refreshConversation}=useStore();
 const [goal,setGoal]=useState(''),[title,setTitle]=useState(''),[team,setTeam]=useState<string[]>(room?.agentIds??state.agents.map(a=>a.id));
 const candidates=state.agents.filter(a=>(room?.agentIds??team).includes(a.id)),compatible=candidates.filter(a=>a.enabled!==false&&a.execution?.kind!=='external');
 const [coordinator,setCoordinator]=useState(''),[participants,setParticipants]=useState<string[]|null>(null),[privateScope,setPrivateScope]=useState(false),[maxTokens,setMaxTokens]=useState('');
 const [attachments,setAttachments]=useState<NonNullable<AutonomousTaskInput['attachments']>>([]),[busy,setBusy]=useState(false),[attaching,setAttaching]=useState(false),[retryPending,setRetryPending]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[settings,setSettings]=useState(false);
 const [taskStates,setTaskStates]=useState<api.TaskState[]>([]),[target,setTarget]=useState(''),[newTask,setNewTask]=useState(false);
 const active=taskStates.filter(t=>t.autonomous?.entry&&state.runs.some(r=>r.id===t.runId&&!['completed','failed','cancelled'].includes(r.status)));
 const targetId=!newTask&&!reply?(target||(active.length===1?active[0]!.runId:'')):'';
 const ambiguous=active.length>1&&!newTask&&!target&&!reply;
 const current=active.find(t=>t.runId===targetId),pending=state.collaborationDecisions.some(d=>d.runId===targetId&&d.status==='pending');
 const pendingSubmission=useRef<AutonomousTaskInput|null>(null);
 const input=useRef<HTMLTextAreaElement>(null),client=useRef(crypto.randomUUID()),instructionClient=useRef(crypto.randomUUID()),submitting=useRef(false);
 useEffect(()=>{if(!room)return;let live=true;async function load(){try{const result=await api.getTaskStates(room!.id);if(live)setTaskStates(result.tasks);}catch{}}void load();const timer=setInterval(()=>void load(),1500);return()=>{live=false;clearInterval(timer);};},[room?.id,state.runs,state.collaborationDecisions]);
 useEffect(()=>{if(reply?.visibility==='private'){setPrivateScope(true);setParticipants(compatible.filter(a=>reply.audience?.includes(a.id)).map(a=>a.id));}},[reply?.id]);
 useLayoutEffect(()=>{if(input.current){input.current.style.height='0px';input.current.style.height=`${Math.min(144,Math.max(64,input.current.scrollHeight))}px`;}},[goal]);
 const allowed=participants??compatible.map(a=>a.id),mentioned=mentionedRecipients(goal,candidates);
 const actor=coordinator||mentioned[0]||compatible.find(a=>allowed.includes(a.id)&&a.capabilities.includes('coordinate'))?.id||compatible.find(a=>allowed.includes(a.id)&&a.capabilities.includes('execute'))?.id;
 function edit(value:string){setGoal(value);client.current=crypto.randomUUID();instructionClient.current=crypto.randomUUID();setError('');}
 async function send(){
  if(submitting.current||attaching||!goal.trim()||ambiguous&&!retryPending)return;submitting.current=true;setBusy(true);setError('');
  let focusRunId=current?.runId;
  try{
   if(current&&!retryPending){if(pending)throw new Error('请在当前任务的问题或授权卡中处理原决定；普通补充不能代替授权。');await api.appendTaskInstruction(current.runId,{text:goal.trim(),clientRequestId:instructionClient.current,expectedRevision:current.autonomous!.instructionRevision});setNotice('补充已加入原任务，沿用原成员、授权和预算。');}
   else{
    if(!pendingSubmission.current&&(!actor||!allowed.includes(actor)))throw new Error('请选择可执行的模型 API 负责人和参与范围。');
    const submission=pendingSubmission.current??{entryVersion:2,goal:goal.trim(),clientRequestId:client.current,...(room?{conversationId:room.id}:{agentIds:team,...(title.trim()?{roomTitle:title.trim()}:{} )}),coordinatorId:actor,participantIds:allowed,visibility:privateScope?'private':'public',audience:privateScope?allowed:[],attachments,...(maxTokens?{constraints:{maxTokens:Number(maxTokens)}}:{}),...(reply?{replyTo:reply.id}:{})} as AutonomousTaskInput;pendingSubmission.current=submission;
    const created=await api.submitAutonomousTask(submission);focusRunId=created.run.id;
    if(!room)setActiveConversation(created.conversation.id);setNotice('任务已开始，Agent 将自行分工并交付结果。');
   }
   pendingSubmission.current=null;setRetryPending(false);setGoal('');setAttachments([]);setNewTask(false);setTarget('');client.current=crypto.randomUUID();instructionClient.current=crypto.randomUUID();onReplyClear?.();await refreshConversation();if(focusRunId)setActiveRun(focusRunId,{openDetails:false});
  }catch(reason){if(pendingSubmission.current&&!(reason instanceof api.ApiError)){setRetryPending(true);setError('提交结果尚未确认，请重试原提交，系统会核对同一个任务。');}else{pendingSubmission.current=null;setRetryPending(false);setError(reason instanceof Error?reason.message:String(reason));}}finally{submitting.current=false;setBusy(false);}
 }
 return <div data-testid="autonomous-composer" className="mx-auto w-full min-w-0 max-w-3xl p-3">
  {!room&&<><h2 className="mb-3 text-lg font-semibold">向 Agent 提出需求</h2><label className="block text-xs text-zinc-400">房间名称（可选）<input aria-label="房间名称" value={title} onChange={e=>setTitle(e.target.value)} className="input my-2"/></label><fieldset className="mb-3"><legend className="text-xs text-zinc-400">房间成员</legend><div className="mt-2 flex flex-wrap gap-2">{state.agents.map(a=><button type="button" key={a.id} aria-pressed={team.includes(a.id)} onClick={()=>{setTeam(ids=>ids.includes(a.id)?ids.filter(id=>id!==a.id):[...ids,a.id]);setParticipants(null);}} className={`${button} ${team.includes(a.id)?'ring-1 ring-violet-400':''}`}>{a.name}</button>)}</div></fieldset></>}
  <section aria-label="任务输入" className="min-w-0 space-y-2 rounded-xl border border-zinc-700 bg-zinc-900 p-3">
   <div className="flex flex-wrap items-center gap-2 text-xs"><strong className="mr-auto text-violet-200">{retryPending?'核对原提交':current?'补充当前任务':'提出需求'}</strong><button type="button" disabled={busy||retryPending} onClick={()=>setSettings(true)} className={button}>任务范围</button><button type="button" disabled={busy||retryPending} onClick={onAdvanced} className={button}>高级 · 手动编排</button></div>
   {active.length>0&&!reply&&<div className="flex flex-wrap items-center gap-2 text-xs"><label className="min-w-0 flex-1">补充对象<select aria-label="补充对象" className="input mt-1" disabled={busy||retryPending} value={ambiguous?'__choose':targetId} onChange={e=>{setTarget(e.target.value);setNewTask(!e.target.value);instructionClient.current=crypto.randomUUID();}}><option value="__choose" disabled>请选择补充对象或新建任务</option><option value="">新建独立任务</option>{active.map(t=><option key={t.runId} value={t.runId}>{state.runs.find(r=>r.id===t.runId)?.goal.slice(0,60)}</option>)}</select></label>{current&&<span className="text-zinc-400">沿用原预算与可见范围</span>}</div>}
   {!current&&<p className="text-xs text-zinc-400">{actor?<span className="inline-flex items-center gap-1"><AgentAvatar agent={state.agents.find(a=>a.id===actor)} className="h-5 w-5"/>{state.agents.find(a=>a.id===actor)?.name}负责</span>:'请配置可用的模型 API 角色'} · 可参与 {allowed.length} 位 · {privateScope?'仅你与获准成员可见':'目标对房间公开'} · 结果返回你与有权成员</p>}
   {!current&&candidates.some(a=>a.execution?.kind==='external')&&<p className="text-xs text-amber-200">SDK/Codex 成员暂不参与自主任务，可在高级入口使用已开放的流程。</p>}
   {reply&&<p className="flex min-w-0 gap-2 text-xs text-zinc-400"><span className="truncate">明确引用：{reply.body}</span><button aria-label="取消引用" onClick={onReplyClear}>×</button></p>}
   {ambiguous&&<p role="status" className="text-xs text-amber-200">有多项进行中任务，请先选择补充对象或新建任务。</p>}
   {pending&&<p role="status" className="text-xs text-amber-200">请在当前问题或授权卡中回答后继续。</p>}
   <textarea ref={input} aria-label={current?'补充要求':'任务目标'} disabled={busy||retryPending} value={goal} onChange={e=>edit(e.target.value)} placeholder={current?'补充要求，后续步骤将在同一个任务中处理…':'描述需求，可用 @ 指定负责人；Agent 会自行分工并交付。'} className="w-full min-w-0 resize-none bg-transparent py-2 text-sm outline-none" onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
   {!current&&<label className="inline-block cursor-pointer rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300">添加材料<input type="file" multiple aria-label="添加任务附件" className="sr-only" disabled={busy||attaching||retryPending} onChange={async e=>{setAttaching(true);const files=[...(e.target.files??[])];e.target.value='';try{if(files.length+attachments.length>4||files.some(f=>f.size>256*1024))throw new Error('最多 4 个附件，每个不超过 256 KiB');const added=await Promise.all(files.map(async f=>{const bytes=new Uint8Array(await f.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return {path:'attachments/'+f.name,contentBase64:btoa(text),mimeType:f.type||'application/octet-stream'};}));setAttachments(a=>[...a,...added]);client.current=crypto.randomUUID();}catch(reason){setError(String(reason));}finally{setAttaching(false);}}}/></label>}
   {!current&&<p className="text-xs text-zinc-500">文字目标与材料合计最多 12000 字符；附件仅支持 UTF-8 文本。</p>}
   {attachments.map((a,i)=><p key={i} className="break-all text-xs text-zinc-400">{a.path}<button className="ml-2 underline" onClick={()=>{setAttachments(s=>s.filter((_,at)=>at!==i));client.current=crypto.randomUUID();}}>移除</button></p>)}
   <div className="flex items-center justify-end gap-2"><span className="mr-auto text-xs text-zinc-500">Enter 发送 · Shift+Enter 换行</span><button type="button" disabled={busy||attaching||!goal.trim()||!retryPending&&(ambiguous||Boolean(current&&pending)||!current&&(!actor||!allowed.length))} onClick={()=>void send()} className="rounded-lg bg-violet-500 px-4 py-2 text-sm text-white disabled:opacity-40">{busy?'正在提交…':retryPending?'重试原提交':current?current.paused?'保存补充':'补充并继续':'发送'}</button></div>
  </section>
  {room?.preferencesIssue&&<p role="alert" className="mt-2 text-xs text-amber-200">{room.preferencesIssue}</p>}
  {notice&&<p role="status" className="mt-2 text-xs text-sky-200">{notice}</p>}{error&&<p role="alert" className="mt-2 break-words text-xs text-red-300">{error}</p>}
  <Drawer open={settings} title="任务范围" onClose={()=>setSettings(false)}><div className="space-y-4 p-4 text-sm">
   {current?<p>当前任务沿用已冻结的负责人、成员、可见范围和总预算。补充不会扩权或重开任务。</p>:<><label className="block">负责人<select aria-label="负责人" value={coordinator} className="input mt-2" onChange={e=>{setCoordinator(e.target.value);client.current=crypto.randomUUID();}}><option value="">自动选择</option>{compatible.filter(a=>a.capabilities.some(c=>c==='coordinate'||c==='execute')).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
   <fieldset><legend>可参与成员</legend><p className="my-2 text-xs text-zinc-400">Agent 在此范围内自行选择分工，不要求每位成员都执行。</p>{compatible.map(a=><label key={a.id} className="mr-3 inline-flex items-center gap-1"><input type="checkbox" checked={allowed.includes(a.id)} onChange={()=>{setParticipants(ids=>(ids??compatible.map(a=>a.id)).includes(a.id)?(ids??compatible.map(a=>a.id)).filter(id=>id!==a.id):[...(ids??[]),a.id]);client.current=crypto.randomUUID();}}/>{a.name}</label>)}</fieldset>
   <label className="flex items-center gap-2"><input type="checkbox" aria-label="本轮私密" checked={privateScope} onChange={e=>{setPrivateScope(e.target.checked);client.current=crypto.randomUUID();}}/>本轮目标和材料仅对可参与成员可见</label>
   <label className="block">总输出 Token 上限<input aria-label="总输出 Token 上限" type="number" min={1} max={options.maxOutputTokens} value={maxTokens} placeholder="沿用房间默认与服务上限" onChange={e=>{setMaxTokens(e.target.value);client.current=crypto.randomUUID();}} className="input mt-2"/></label><p className="text-xs text-zinc-400">沿用房间费用、时限和角色工具权限，仅使用受控文件。不会修改本地代码仓库。</p></>}
   <button className={button} onClick={()=>setSettings(false)}>完成设置</button>
  </div></Drawer>
 </div>;
}
