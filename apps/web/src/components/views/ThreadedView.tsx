import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ThreadedThreadRecord,ThreadedViewSnapshot,ThreadedWaitView,ThreadedMessageRecord} from '@agent-gand/shared';
import {ThreadedApi} from '../../services/threadedApi';
import type {ThreadedRoutePreview,ThreadedRoutingPolicy} from '../../services/threadedApi';
import {ThreadedSync} from '../../services/threadedSync';
import type {ThreadedSyncState} from '../../services/threadedSync';
import {MarkdownBody} from '../Markdown';
import {Drawer} from '../Drawer';

const button='min-h-11 rounded-lg border border-zinc-700 px-3 text-sm hover:bg-zinc-800 disabled:opacity-40';
const label:Record<string,string>={queued:'已排队',running:'执行中',waiting:'等待',unknown:'执行结果待核实',completed:'本次调用已结束',failed:'调用失败',cancelled:'已停止',
  awaiting:'等待回应',settled:'已结算',withdrawn:'已撤回',superseded:'已替换',responded:'已回应',pending:'等待回应',timeout:'超时',collecting:'征询中',
  complete:'完整汇总',partial:'部分汇总',delivered:'回调已排队',rejected:'回调已拒绝',open:'开放',paused:'已暂停',closed:'已关闭',archived:'已归档',available:'可接收'};
const explain=(value:unknown)=>value instanceof Error?value.message:String(value);
const selectedThread=()=>new URL(location.href).searchParams.get('thread');

export function ThreadedView({onAccounts}:{onAccounts:()=>void}) {
  const [api]=useState(()=>new ThreadedApi());
  const [ready,setReady]=useState(false),[connecting,setConnecting]=useState(false),[error,setError]=useState('');
  const [threads,setThreads]=useState<ThreadedThreadRecord[]>([]),[id,setId]=useState(selectedThread),[generation,setGeneration]=useState(0);
  const alive=useRef(true),authEpoch=useRef(0);
  async function load(connect=false){const epoch=++authEpoch.current;setConnecting(true);setError('');
    try{if(connect)await api.connect();else await api.resume();const list=await api.threads();if(!alive.current||epoch!==authEpoch.current)return;
      setThreads(list);setReady(true);setId(current=>current??list[0]?.id??null);setGeneration(n=>n+1);
    }catch(reason){if(alive.current&&epoch===authEpoch.current){setError(explain(reason));setReady(false);setThreads([]);}}
    finally{if(alive.current&&epoch===authEpoch.current)setConnecting(false);}}
  useEffect(()=>{alive.current=true;void load();const back=()=>setId(selectedThread());window.addEventListener('popstate',back);
    return()=>{alive.current=false;++authEpoch.current;window.removeEventListener('popstate',back);};},[]);
  function select(threadId:string){const url=new URL(location.href);url.searchParams.set('surface','threaded');url.searchParams.set('thread',threadId);if(url.href!==location.href)history.pushState(null,'',url);setId(threadId);}
  async function logout(){++authEpoch.current;setReady(false);setThreads([]);setError('');try{await api.disconnect();}catch(reason){setError(explain(reason));}}
  if(!ready)return <section className="mx-auto max-w-xl p-6" aria-label="持续协作连接"><h1 className="text-xl font-semibold">持续协作</h1>
    <p className="my-3 text-sm text-zinc-400">与多位 Agent 持续交流、接力执行，共同推进工作。</p>
    <p className="mb-4 text-sm text-zinc-400">连接后查看已有空间。新空间与真实执行将在发布验收后开放。</p>
    {error&&<p role="alert" className="my-3 text-sm text-amber-300">{error}</p>}
    <div className="flex gap-2"><button className={button} disabled={connecting} onClick={()=>void load(true)}>{connecting?'正在连接…':'连接持续协作'}</button>
      <button className={button} onClick={onAccounts}>账户与访问设置</button></div></section>;
  return <section className="flex h-full min-h-0 flex-col md:flex-row" aria-label="持续协作工作台">
    <aside className="shrink-0 border-b border-zinc-800 p-3 md:w-56 md:overflow-y-auto md:border-r md:border-b-0">
      <div className="flex items-center gap-2 md:hidden"><select className="input min-w-0 flex-1 text-sm" aria-label="持续协作空间" value={id??''} onChange={e=>select(e.target.value)}><option value="" disabled>选择空间</option>{threads.map(t=><option key={t.id} value={t.id}>{t.title} · {label[t.state]}</option>)}</select><button className="min-h-11 shrink-0 px-2 text-xs text-zinc-400" onClick={()=>void logout()}>断开会话</button></div>
      <div className="mb-3 hidden items-center justify-between md:flex"><h1 className="text-sm font-semibold">持续协作</h1><button className="min-h-11 px-2 text-xs text-zinc-400" onClick={()=>void logout()}>断开会话</button></div>
      <div className="hidden gap-2 md:flex md:flex-col">{threads.map(t=><button key={t.id} className={`${button} shrink-0 text-left ${t.id===id?'border-violet-500 bg-violet-500/15':''}`} aria-current={t.id===id?'page':undefined} onClick={()=>select(t.id)}>{t.title}<span className="ml-2 text-xs text-zinc-400">{label[t.state]}</span></button>)}</div>
      {!threads.length&&<p role="status" className="text-sm text-zinc-400">暂无持续协作空间</p>}
      <p className="mt-3 hidden text-xs text-zinc-500 md:block">新建空间尚未开放</p>
    </aside>
    {id?<ThreadWorkspace key={`${id}:${generation}`} api={api} id={id} reconnect={()=>void load(true)}/>:<p className="p-6 text-zinc-400">选择已有空间查看消息与成员状态。</p>}
  </section>;
}

function ThreadWorkspace({api,id,reconnect}:{api:ThreadedApi;id:string;reconnect:()=>void}){
  const [sync,setSync]=useState<ThreadedSyncState>({status:'loading',snapshot:null,error:''});
  const controller=useRef<ThreadedSync|null>(null);const [before,setBefore]=useState<number|undefined>();
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[showStatus,setShowStatus]=useState(false);
  const pending=useRef<{signature:string;requestId:string}|null>(null);
  const timeline=useRef<HTMLDivElement|null>(null),following=useRef(true),scrollTop=useRef(0),lastSeq=useRef(0);
  const [unread,setUnread]=useState(0);
  useLayoutEffect(()=>{const element=timeline.current,snapshot=sync.snapshot;if(!element||!snapshot)return;
    const latest=snapshot.messages.at(-1)?.seq??0;
    if(following.current&&before===undefined){element.scrollTop=element.scrollHeight;setUnread(0);}else{element.scrollTop=scrollTop.current;if(latest>lastSeq.current&&lastSeq.current>0){const count=snapshot.messages.filter(m=>m.seq>lastSeq.current).length;setUnread(n=>n+count);}}
    lastSeq.current=latest;
  },[sync.snapshot?.revision,before]);
  useEffect(()=>{let active=true;const next=new ThreadedSync(api,id,value=>{if(active)setSync(value);},{beforeSeq:before});controller.current=next;void next.start();
    return()=>{active=false;next.stop();controller.current=null;};},[api,id,before]);
  async function mutate(signature:string,action:(requestId:string)=>Promise<unknown>){if(busy)return false;setBusy(true);setError('');
    const request=pending.current?.signature===signature?pending.current:{signature,requestId:crypto.randomUUID()};pending.current=request;
    try{await action(request.requestId);pending.current=null;await controller.current?.refresh();return true;}
    catch(reason){setError(`${explain(reason)}。重试同一操作会沿用原请求身份。`);await controller.current?.refresh();return false;}finally{setBusy(false);}}
  const s=sync.snapshot;
  if(!s)return <div className="flex-1 p-6"><p role="status">{sync.status==='disconnected'?'访问已中断':sync.status==='reconnecting'?'正在重连并重新核验访问…':'正在加载授权快照…'}</p>
    {sync.error&&<p role="alert" className="my-3 text-sm text-amber-300">{sync.error}</p>}
    <button className={`${button} mt-3`} onClick={reconnect}>重新连接持续协作</button></div>;
  const canSend=s.capabilities.implemented.admission&&s.thread.state!=='closed'&&s.thread.state!=='archived';
  const control=(kind:'thread'|'member'|'invocation',target:string|undefined,action:'pause'|'stop'|'resume')=>
    mutate(`control:${kind}:${target??id}:${action}`,requestId=>api.control(id,{kind,id:target},action,requestId));
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="threaded-workspace">
    <header className="shrink-0 border-b border-zinc-800 p-3"><div className="flex flex-wrap items-center gap-2"><h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{s.thread.title}</h2>
      <span role="status" className="text-xs text-emerald-300">{sync.status==='live'?'已同步':'正在同步'}</span><button className={button} onClick={()=>setShowStatus(!showStatus)}>{showStatus?'收起成员与调用':'成员与调用'}</button>
      <button className={button} onClick={()=>void controller.current?.refresh()}>重新同步</button></div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400"><span>空间：{label[s.thread.state]}</span><span className="hidden sm:inline">业务状态：{s.business.label}</span>
        <details className="relative"><summary className="flex min-h-11 cursor-pointer items-center rounded px-2 hover:bg-zinc-800">空间控制 ▾</summary><div className="absolute left-0 z-30 flex w-40 flex-col rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-xl">
        {(['pause','stop','resume'] as const).map(action=><button key={action} className="min-h-11 rounded px-2 text-left hover:bg-zinc-800 disabled:opacity-40" disabled={busy} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');void control('thread',undefined,action);}}>{action==='pause'?'暂停空间':action==='stop'?'停止空间工作':'恢复空间'}</button>)}</div></details></div>
      {!s.capabilities.implemented.admission&&<p className="mt-1 text-xs text-amber-300">新工作入场已关闭；现有历史与控制可用。</p>}
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-zinc-400" aria-label="协作进度"><span>已保存（本页）：{s.messages.length}</span><span>已排队：{s.memberQueues.reduce((n,m)=>n+m.count,0)}</span><span>执行中：{s.invocations.filter(i=>i.status==='running').length}</span><span>上下文已交付：{s.progress.filter(p=>p.delivered).length}</span><span>等待回应：{s.waits.filter(w=>w.state==='awaiting').length}</span><span>业务责任：{s.business.label}</span></div>
      {!!s.business.actions?.length&&<details className="mt-2 text-xs text-zinc-400"><summary className="cursor-pointer py-2">业务责任与领域校验</summary><ul className="max-h-48 space-y-2 overflow-auto" data-testid="threaded-actions">
        {s.business.actions.map(a=><li key={a.id} className="break-words rounded border border-zinc-800 p-2"><div>{a.subject.kind==='task'?`平台任务 ${a.subject.taskId}`:`${a.subject.repository}#${a.subject.number}`} · 第 {a.generation} 代 · {a.state==='completed'?'责任已完成':a.state==='replaceable'?'等待合法替换':'责任进行中'}</div>
          <div>持有人：{a.holders.map(h=>`${h.agentId}（${h.outcome??'待交付'}）`).join('、')}</div><div>领域校验：{a.freshnessStatus==='verified'?'已核验':a.freshnessStatus==='stale'?'版本已变化，需新评审':'当前不可核验'} · {a.freshness}</div>
          {a.predicate==='review_delivered'&&<div>评审交付与批准门禁分别核验；此处不授予业务批准。</div>}
          {a.commands?.map(command=><div key={command.id} className={command.state==='unknown'?'text-amber-300':''}>命令 {command.id} · 第 {command.generation} 代 · {command.state==='unknown'?'执行结果待核验':command.state==='running'?'执行中':command.state}{command.generation!==a.generation?'（历史责任，仍需对账）':''}</div>)}</li>)}</ul></details>}
      {error&&<p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    </header>
    <div className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={timeline} className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5" data-testid="threaded-timeline" onScroll={event=>{const el=event.currentTarget;scrollTop.current=el.scrollTop;following.current=el.scrollHeight-el.scrollTop-el.clientHeight<40;if(following.current)setUnread(0);}}>
          <div className="mb-4 flex gap-2">{s.nextBeforeSeq!==null&&<button className={button} onClick={()=>{following.current=false;scrollTop.current=0;setBefore(s.nextBeforeSeq!);}}>更早消息</button>}{before!==undefined&&<button className={button} onClick={()=>{following.current=true;setBefore(undefined);}}>返回最新消息</button>}</div>
          {!s.messages.length&&<p className="py-8 text-center text-sm text-zinc-400">此页没有可读取的消息。</p>}
          {s.messages.map(m=><ThreadMessage key={m.id} api={api} message={m} snapshot={s}/>)}
        </div>
        {unread>0&&before===undefined&&<button className="min-h-11 bg-violet-500/15 text-xs text-violet-200" onClick={()=>{following.current=true;setUnread(0);if(timeline.current)timeline.current.scrollTop=timeline.current.scrollHeight;}}>{unread} 条新消息 · 跳到最新</button>}
        <ThreadComposer api={api} snapshot={s} enabled={canSend} onSaved={()=>controller.current?.refresh()??Promise.resolve()}/>
      </div>
      {showStatus&&<aside className="absolute inset-0 z-20 overflow-y-auto border-t border-zinc-800 bg-zinc-950 p-3 lg:static lg:z-auto lg:w-80 lg:shrink-0 lg:border-t-0 lg:border-l" aria-label="成员与调用状态">
        <button className="mb-2 min-h-11 text-sm text-violet-300 lg:hidden" onClick={()=>setShowStatus(false)}>关闭成员与调用状态</button><h3 className="mb-2 font-medium">成员状态</h3>{s.members.map(m=>{const calls=s.invocations.filter(i=>i.agentId===m.agentId),active=calls.find(i=>['running','unknown','queued','waiting'].includes(i.status));
          const state=s.memberControls.find(c=>c.agentId===m.agentId)?.state??'available';return <div key={m.agentId} className="mb-3 rounded-lg bg-zinc-900 p-3 text-sm"><p className="break-all font-medium">@{m.handle}</p><p className="my-1 text-xs text-zinc-400">{m.status==='left'?'已离开':label[state]} · {active?label[active.status]:'当前无执行'}{(s.memberQueues.find(q=>q.agentId===m.agentId)?.count??0)>0?` · 已排队 ${s.memberQueues.find(q=>q.agentId===m.agentId)!.count}`:''}</p>
            <div className="flex gap-1">{(['pause','stop','resume'] as const).map(a=><button key={a} className="min-h-11 px-2 text-xs text-zinc-300 disabled:opacity-40" aria-label={`${a==='pause'?'暂停':a==='stop'?'停止':'恢复'} @${m.handle}`} disabled={busy||m.status==='left'} onClick={()=>void control('member',m.agentId,a)}>{a==='pause'?'暂停':a==='stop'?'停止':'恢复'}</button>)}</div></div>;})}
        <p className="my-3 text-xs text-zinc-500">停止或暂停请求不代表外部进程已停止。结果待核实时保留原执行围栏。</p>
        <h3 className="my-2 font-medium">等待与人类回应</h3>{s.waits.map(w=><WaitCard key={`${w.id}:${w.version}`} wait={w} enabled={canSend&&!busy} submit={body=>mutate(`answer:${w.id}:${w.version}:${body}`,requestId=>api.answer(id,w.id,{body,clientRequestId:requestId,expectedVersion:w.version}))}/>)}
        <h3 className="my-3 font-medium">征询</h3>{s.consultations.map(g=><div key={g.id} className="mb-2 rounded bg-zinc-900 p-3 text-xs"><p>{label[g.state]} · {g.kind?label[g.kind]:new Date(g.deadline).toLocaleTimeString('zh-CN')}</p>{g.targets.map(t=><p key={t.agentId} className="mt-1 break-all">@{t.agentId}：{label[t.status]??t.status}</p>)}{g.callback&&<p className="mt-2 text-zinc-400">{label[g.callback.state]??g.callback.state}{g.callback.reason?` · ${g.callback.reason}`:''}</p>}</div>)}
        <h3 className="my-3 font-medium">执行审批</h3>{s.approvals.map(a=><div key={a.id} className="mb-2 rounded bg-amber-500/10 p-3 text-xs"><p>原生执行待审批 · @{a.agentId}</p><p className="my-2 text-zinc-400">与普通问题回应分开；不代表业务验收。</p>{(['approve','reject'] as const).map(decision=><button key={decision} className={button} disabled={busy} onClick={()=>void mutate(`approval:${a.id}:${decision}`,requestId=>api.approval(id,a.id,decision,requestId))}>{decision==='approve'?'批准执行':'拒绝执行'}</button>)}</div>)}
        <h3 className="my-3 font-medium">Invocation 日志（最近 200 条）</h3>{s.invocations.map(i=><details key={i.id} className="mb-2 rounded bg-zinc-900 p-3 text-xs"><summary className="cursor-pointer break-all">@{i.agentId} · {label[i.status]}</summary>
          <p className="my-2 break-all text-zinc-400">调用 {i.id}{i.reason?` · ${i.reason}`:''}</p>{i.attempts.map(a=><p key={a.id} className="my-1 break-all">Attempt {a.number} · {a.status} · {a.stage}{a.reason?` · ${a.reason}`:''}</p>)}
          <p className="my-2 text-zinc-500">{i.pauseRequested?'暂停请求待核实 ':''}{i.cancelRequested?'停止请求待核实':''}</p>
          {(['pause','stop','resume'] as const).map(a=><button key={a} disabled={busy} className="min-h-11 px-2 text-zinc-300 disabled:opacity-40" onClick={()=>void control('invocation',i.id,a)}>{a==='pause'?'暂停此调用':a==='stop'?'停止此调用':'恢复此调用'}</button>)}</details>)}
      </aside>}
    </div>
  </div>;
}

function WaitCard({wait:w,enabled,submit}:{wait:ThreadedWaitView;enabled:boolean;submit:(body:string)=>Promise<boolean>}){
  const [body,setBody]=useState('');return <div className="mb-2 rounded-lg border border-zinc-700 p-3 text-xs"><p>@{w.agentId} · {w.kind==='decision'?'普通问题':w.kind==='timer'?'计时等待':'事件跟踪'} · {label[w.state]??w.state}</p>
    {w.question&&<p className="my-2 whitespace-pre-wrap break-words text-sm">{w.question}</p>}{w.deadline&&<p className="my-2 text-zinc-400">期限：{new Date(w.deadline).toLocaleString('zh-CN')}</p>}
    {w.outcome&&<p className="my-2 text-zinc-400">等待结果：{String(w.outcome.type??'已记录')}；业务完成需另行验收。</p>}
    {w.responseCount>0&&<p className="my-2 text-sky-300">已保存 {w.responseCount} 条回应{w.state==='awaiting'?'，等待成员处理。':'。'}</p>}
    {w.kind==='decision'&&w.state==='awaiting'&&<form onSubmit={event=>{event.preventDefault();void submit(body.trim()).then(ok=>{if(ok)setBody('');});}}><textarea className="input my-2 text-sm" aria-label={`回应问题 ${w.id}`} value={body} onChange={e=>setBody(e.target.value)} disabled={!enabled} maxLength={20000}/><button className={button} disabled={!enabled||!body.trim()}>{w.responseCount?'补充回应':'提交回应'}</button><p className="mt-2 text-zinc-500">回应当前版本的普通问题；不授予业务批准。</p></form>}
  </div>;
}

function ThreadMessage({api,message:m,snapshot:s}:{api:ThreadedApi;message:ThreadedMessageRecord;snapshot:ThreadedViewSnapshot}){
  const [sources,setSources]=useState<ThreadedMessageRecord[]|null>(null),[error,setError]=useState('');
  const progress=s.progress.filter(p=>p.messageId===m.id);
  return <article id={`threaded-message-${m.id}`} data-message-id={m.id} className="mb-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
    <div className="mb-3 flex flex-wrap gap-2 text-xs text-zinc-400"><span className="break-all font-semibold text-zinc-200">{m.sender.kind==='user'?'你':m.sender.kind==='system'?'系统':`@${m.sender.agentId}`}</span><span>{m.origin==='agent_post'?'独立发送':m.origin==='agent_response'?'本次回复':m.origin==='user'?'用户消息':'系统回调'}</span>
      <span>{m.visibility==='private'?`私密 · ${m.audience.join('、')}`:'公开'}</span>{m.state==='draft'&&<span className="text-amber-300">草稿</span>}<span>已保存 · #{m.seq}</span></div>
    {m.targets.length>0&&<p className="mb-2 break-all text-xs text-violet-300">收件人：{m.targets.map(id=>`@${id}`).join('、')}</p>}
    <div className="prose prose-invert max-w-none break-words text-sm"><MarkdownBody text={m.body}/></div>
    {m.attachments.map(a=><a key={a.id} className="mt-3 block break-all text-xs text-sky-300 underline" href={api.attachmentUrl(m.threadId,a.id)} download>{a.name} · {a.byteLength} 字节</a>)}
    {progress.map(p=><p key={p.agentId} className="mt-3 break-all text-xs text-zinc-400">@{p.agentId}：{[p.queued?'已排队':null,p.executing?'执行中':null,p.responded?'本次调用已结束':null,p.delivered?'上下文已交付':null,p.seen?'已读':null,p.mentionAcknowledged?'提及已确认':null].filter(Boolean).join(' · ')||'已建立逻辑投递'}{p.reason?` · ${p.reason}`:''}</p>)}
    {m.sourceRefs.length>0&&<button className="mt-2 min-h-11 text-xs text-sky-300" onClick={()=>void api.sources(m.threadId,m.id).then(r=>{setSources(r.messages);setError('');}).catch(e=>{setSources(null);setError(explain(e));})}>查看获权来源</button>}
    {sources&&<ul className="space-y-2 border-t border-zinc-800 pt-2 text-xs text-zinc-400">{sources.map(source=><li key={source.id} className="break-all"><details><summary className="min-h-11 cursor-pointer">#{source.seq} · {source.threadId===m.threadId?'当前空间':'跨空间来源'} · {source.id}</summary><div className="prose prose-invert max-w-none break-words"><MarkdownBody text={source.body}/></div></details></li>)}</ul>}{error&&<p role="alert" className="text-xs text-red-300">{error}</p>}
  </article>;
}

function ThreadComposer({api,snapshot:s,enabled,onSaved}:{api:ThreadedApi;snapshot:ThreadedViewSnapshot;enabled:boolean;onSaved:()=>Promise<void>}){
  const [body,setBody]=useState(''),[targets,setTargets]=useState<string[]>([]),[visibility,setVisibility]=useState<'public'|'private'>('public');
  const [audience,setAudience]=useState<string[]>([]);
  const [intent,setIntent]=useState('auto'),[critique,setCritique]=useState(false),[preview,setPreview]=useState<ThreadedRoutePreview|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[policy,setPolicy]=useState<{version:number;policy:ThreadedRoutingPolicy}|null>(null),[policyOpen,setPolicyOpen]=useState(false);
  const pending=useRef<{signature:string;id:string}|null>(null),previewEpoch=useRef(0);
  const content=[body,...(intent==='auto'?[]:[`#${intent}`]),...(critique?['#critique']:[])].join('\n');
  useEffect(()=>{let active=true;void api.policy(s.thread.id).then(r=>{if(active)setPolicy(r.routing);}).catch(e=>{if(active)setError(explain(e));});return()=>{active=false;};},[api,s.thread.id,s.routingVersion]);
  useEffect(()=>{const epoch=++previewEpoch.current;setPreview(null);if(!body.trim())return;
    const timer=setTimeout(()=>{void api.preview(s.thread.id,content,targets).then(r=>{if(epoch===previewEpoch.current){setPreview(r.route);setError('');}}).catch(e=>{if(epoch===previewEpoch.current)setError(explain(e));});},250);
    return()=>{clearTimeout(timer);++previewEpoch.current;};},[api,s.thread.id,content,targets,policy?.version]);
  async function send(){if(!enabled||!preview||busy)return;setBusy(true);setError('');
    const input={body:content,...(targets.length?{targets}:{}),visibility,...(visibility==='private'?{audience:[...new Set([...preview.targets,...audience])]}:{})};
    const signature=JSON.stringify(input),request=pending.current?.signature===signature?pending.current:{signature,id:crypto.randomUUID()};pending.current=request;
    try{await api.send(s.thread.id,{...input,clientRequestId:request.id});pending.current=null;setBody('');setPreview(null);await onSaved();}
    catch(reason){setError(`${explain(reason)}。再次提交相同内容会复用请求身份。`);}finally{setBusy(false);}}
  return <footer className="shrink-0 border-t border-zinc-800 bg-zinc-950 p-3">
    <form onSubmit={event=>{event.preventDefault();void send();}}>
      <div className="mb-2 flex flex-wrap gap-2 text-xs">{s.members.filter(m=>m.status==='joined').map(m=><label key={m.agentId} className="flex min-h-11 items-center gap-1 rounded bg-zinc-900 px-2"><input type="checkbox" checked={targets.includes(m.agentId)} disabled={busy} onChange={e=>setTargets(ids=>e.target.checked?[...ids,m.agentId]:ids.filter(id=>id!==m.agentId))}/>@{m.handle}</label>)}
        <label className="flex items-center gap-1">意图<select aria-label="协作意图" className="rounded bg-zinc-900 p-2" value={intent} onChange={e=>setIntent(e.target.value)}><option value="auto">自动</option><option value="ideate">独立思考</option><option value="execute">依次执行</option></select></label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={critique} onChange={e=>setCritique(e.target.checked)}/>批判性分析</label>
        <select aria-label="消息可见范围" className="rounded bg-zinc-900 p-2" value={visibility} onChange={e=>setVisibility(e.target.value as 'public'|'private')}><option value="public">公开</option><option value="private">私密（另选可见成员）</option></select>
      </div>
      {visibility==='private'&&<fieldset className="mb-2 flex flex-wrap items-center gap-2 text-xs"><legend>私密可见成员</legend>{s.members.filter(m=>m.status==='joined').map(m=><label key={m.agentId} className="flex min-h-11 items-center gap-1"><input type="checkbox" disabled={busy||preview?.targets.includes(m.agentId)} checked={!!preview?.targets.includes(m.agentId)||audience.includes(m.agentId)} onChange={e=>setAudience(ids=>e.target.checked?[...ids,m.agentId]:ids.filter(id=>id!==m.agentId))}/>@{m.handle}</label>)}<span className="text-zinc-500">收件人均可见；额外可见成员不会因此启动。</span></fieldset>}
      <textarea className="input text-sm" rows={2} aria-label="持续协作消息" placeholder="输入消息，使用 @成员 或 @群组点名" value={body} onChange={e=>setBody(e.target.value)} disabled={busy} maxLength={1048576}/>
      <div className="mt-2 flex flex-wrap items-center gap-3"><button className={`${button} bg-violet-500/20 text-violet-200`} disabled={!enabled||busy||!body.trim()||!preview}>{busy?'提交中…':'发送消息'}</button>
        {preview&&<p role="status" className="min-w-0 break-all text-xs text-zinc-400">预览：{preview.targets.map(id=>`@${id}`).join('、')} · {preview.strategy==='parallel'?'独立并行':'依次执行'}{preview.promptTags.includes('critique')?' · 批判性分析':''}</p>}
        <button type="button" className="min-h-11 text-xs text-zinc-400" onClick={()=>setPolicyOpen(!policyOpen)}>路由设置</button></div>
      {error&&<p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
    </form>
    <Drawer open={policyOpen} title="路由设置" onClose={()=>setPolicyOpen(false)}>{policyOpen&&<RoutingEditor key={policy?.version??0} policy={policy} members={s.members.filter(m=>m.status==='joined').map(m=>m.agentId)} save={async(value,version)=>{await api.configure(s.thread.id,value,version);setPolicy((await api.policy(s.thread.id)).routing);setPolicyOpen(false);await onSaved();}}/>}</Drawer>
  </footer>;
}

function RoutingEditor({policy,members,save}:{policy:{version:number;policy:ThreadedRoutingPolicy}|null;members:string[];save:(policy:ThreadedRoutingPolicy,version:number)=>Promise<void>}){
  const [defaultAgent,setDefault]=useState(policy?.policy.defaultAgent??members[0]??''),[duty,setDuty]=useState(policy?.policy.duty??'');
  const [preferred,setPreferred]=useState(policy?.policy.preferred??[]),[groups,setGroups]=useState(Object.entries(policy?.policy.groups??{}).map(([name,targets])=>({name,targets}))),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <form className="mt-3 space-y-2 rounded-lg border border-zinc-700 p-3 text-xs" onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setError('');void(async()=>{
    try{if(new Set(groups.map(g=>g.name)).size!==groups.length)throw new Error('群组名称不能重复');await save({defaultAgent,...(duty?{duty}:{}),preferred,groups:Object.fromEntries(groups.map(g=>[g.name,g.targets]))},policy?.version??0);}
    catch(e){setError(explain(e));}finally{setBusy(false);}})();}}>
    <label className="block">默认成员<select className="input mt-1 text-sm" aria-label="默认路由成员" value={defaultAgent} onChange={e=>setDefault(e.target.value)}>{members.map(id=><option key={id}>{id}</option>)}</select></label>
    <label className="block">值班成员<select className="input mt-1 text-sm" value={duty} onChange={e=>setDuty(e.target.value)}><option value="">未指定</option>{members.map(id=><option key={id}>{id}</option>)}</select></label>
    <fieldset className="flex flex-wrap gap-2"><legend>优先成员</legend>{members.map(id=><label key={id} className="flex min-h-11 items-center gap-1"><input type="checkbox" checked={preferred.includes(id)} onChange={e=>setPreferred(ids=>e.target.checked?[...ids,id]:ids.filter(v=>v!==id))}/>@{id}</label>)}</fieldset>
    <fieldset><legend>项目群组</legend>{groups.map((g,index)=><div key={index} className="my-2 rounded border border-zinc-800 p-2"><input className="input text-xs" aria-label={`群组名称 ${index+1}`} value={g.name} placeholder="例如 reviewers" onChange={e=>setGroups(rows=>rows.map((row,i)=>i===index?{...row,name:e.target.value}:row))}/>
      <div className="flex flex-wrap gap-2">{members.map(id=><label key={id} className="flex min-h-11 items-center gap-1"><input type="checkbox" checked={g.targets.includes(id)} onChange={e=>setGroups(rows=>rows.map((row,i)=>i===index?{...row,targets:e.target.checked?[...row.targets,id]:row.targets.filter(v=>v!==id)}:row))}/>@{id}</label>)}<button type="button" className="min-h-11 text-zinc-400" onClick={()=>setGroups(rows=>rows.filter((_,i)=>i!==index))}>移除群组</button></div></div>)}<button type="button" className="min-h-11 text-sky-300" onClick={()=>setGroups(rows=>[...rows,{name:'',targets:[]}])}>添加群组</button></fieldset>
    <button className={button} disabled={busy||!defaultAgent}>保存路由设置</button><span className="ml-2 text-zinc-500">版本 {policy?.version??0}</span>{error&&<p role="alert" className="text-red-300">{error}；重新加载设置后再试。</p>}
  </form>;
}
