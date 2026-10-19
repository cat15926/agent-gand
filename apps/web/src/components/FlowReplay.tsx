import {useState} from 'react';
import type {AgentDefinition} from '@agent-gand/shared';
import {CONFIDENCE_LABEL,ROLE_LABEL,type ReplayPresentation,type ReplayLine,type ReplayAction} from '../services/flowReplayPresentation';
import {MarkdownBody} from './Markdown';

export function FlowReplay({replay,original,agents}:{replay:ReplayPresentation;original:string;agents:AgentDefinition[]}){
  const [raw,setRaw]=useState(false);
  const name=(id:string)=>agents.find(a=>a.id===id)?.name??id;
  const actor=(id:string)=><span title={id} className="font-medium text-zinc-200">{name(id)}</span>;
  const line=(item:ReplayLine)=>{
    if(item.type==='night')return <>{actor(item.target!)} 在第{item.round}夜出局。</>;
    if(item.type==='alive')return <span className="text-zinc-400">存活：{item.players!.map(name).join('、')}</span>;
    if(item.type==='exile')return <>{actor(item.target!)} 被放逐，得票 {item.votes} 票。</>;
    if(item.type==='vote')return <>{actor(item.actor!)} 投给 {actor(item.target!)}。</>;
    return <>{actor(item.actor!)} 自称{ROLE_LABEL[item.claim!]}，建议放逐 {actor(item.target!)}；信心：{CONFIDENCE_LABEL[item.confidence!]}。</>;
  };
  const action=(a:ReplayAction)=>a.kind==='attack'?'夜间袭击':a.kind==='inspect'?'查验':a.kind==='vote'?'投票':`声明：自称${ROLE_LABEL[a.claim!]}（信心${CONFIDENCE_LABEL[a.confidence!]}）`;
  return <section aria-label="狼人杀完整回放" className="space-y-4">
    <header className="border-b border-zinc-700/70 pb-3"><div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold text-zinc-100">狼人杀 · 完整回放</h3><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300">已结束</span></div><p className="mt-2 text-lg font-semibold text-violet-200">{replay.winner==='wolf'?'狼人获胜':'好人阵营获胜'}</p><p className="mt-1 text-xs text-zinc-400">{replay.stages.length} 个阶段 · {replay.stages.reduce((n,s)=>n+s.actions.length,0)} 条玩家行动</p></header>
    <section aria-label="终局身份"><h4 className="mb-2 text-sm font-semibold text-zinc-200">终局身份</h4><ul className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-2 sm:grid-cols-3">{replay.players.map(p=><li key={p.id} className="min-w-0 rounded-lg bg-zinc-950/40 px-3 py-2"><div className="break-words text-sm" title={p.id}>{name(p.id)}</div><div className="mt-1 text-xs text-zinc-400">{ROLE_LABEL[p.role]}</div></li>)}</ul></section>
    <ol className="space-y-3" aria-label="游戏阶段">{replay.stages.map(stage=><li key={stage.number} className="rounded-lg border border-zinc-700/70 bg-zinc-950/20 p-3"><h4 className="mb-2 text-sm font-semibold text-sky-200">{stage.title}</h4><ul className="space-y-2 text-sm leading-7">{stage.lines.map((item,i)=><li key={i}>{line(item)}</li>)}</ul><details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">查看本阶段 {stage.actions.length} 条行动</summary><ul className="mt-2 space-y-2">{stage.actions.map(a=><li key={a.actor}>{actor(a.actor)} · {action(a)} → {actor(a.target)}</li>)}</ul></details></li>)}</ol>
    <details className="rounded-lg border border-zinc-700/70 p-3 text-xs text-zinc-400"><summary className="cursor-pointer">本局规则</summary><p className="mt-2 whitespace-pre-line leading-6">{replay.rules}</p></details>
    <button type="button" aria-expanded={raw} onClick={()=>setRaw(v=>!v)} className="rounded-lg bg-zinc-950/50 px-3 py-2 text-xs text-violet-200">{raw?'收起原始消息':'查看原始消息'}</button>
    {raw&&<div aria-label="原始交付正文" className="border-t border-zinc-700 pt-3"><MarkdownBody text={original}/></div>}
  </section>;
}
