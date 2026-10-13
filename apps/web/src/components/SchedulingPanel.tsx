import { useEffect,useState } from 'react';
import type { SchedulingPreview,SchedulingState } from '@agent-gand/shared';
import * as api from '../services/api';
import { displayStatus } from '../services/displayStatus';
export function SchedulingPreviewView({preview,members}:{preview:SchedulingPreview;members:Array<{id:string;name:string}>}) {
  const names=(ids:string[])=>ids.filter(id=>id!=='user').map(id=>members.find(a=>a.id===id)?.name??id).join('、');
  return <section aria-label="阶段调度预览" className="mt-3 min-w-0 space-y-2 rounded border border-violet-500/30 p-2 text-xs [overflow-wrap:anywhere]"><p>预计至少 {preview.minimumModelCalls} 次模型调用 · {preview.platformTransitions} 个平台门禁，无需模型确认回执</p><p className="text-zinc-500">每个成员任务及汇合至少一次；工具轮次与重试可能增加调用。预算在调用前预约，额度不足时等待或停止。</p>{preview.stages.map(s=><div key={s.stageId} className="space-y-1"><p>{s.title} · 并发上限 {s.concurrency} · 全部成员完成后等待验收</p><p>就绪批次：{s.waves.map(w=>names(w)).join(' → ')||'已确认工作，无新成员派发'}</p>{s.tasks.map(t=><p key={t.agentId}>接收人 {names([t.agentId])} · 谁能看到：{t.visibility==='private'?`你与 ${names(t.audience)}`:'继承本轮范围'}</p>)}<p>{s.joinAgentId?`汇合：${names([s.joinAgentId])} · 仅使用 ${names(s.joinSourceAgentIds)} 的已确认结果`:'汇合：平台收集交付，不额外调用模型'}</p></div>)}</section>;
}
export function SchedulingPanel({runId,terminal,members}:{runId:string;terminal:boolean;members:Array<{id:string;name:string}>}) {
  const [value,setValue]=useState<SchedulingState|null>(null),[error,setError]=useState('');
  useEffect(()=>{let live=true,pending=false;setValue(old=>old?.runId===runId?old:null);
    const load=async()=>{if(pending)return;pending=true;try{const next=await api.getSchedulingState(runId);if(live){setValue(next);setError('');}}catch(e){if(live)setError(e instanceof Error?e.message:String(e));}finally{pending=false;}};
    void load();const timer=terminal?null:window.setInterval(()=>void load(),1000);return()=>{live=false;if(timer)window.clearInterval(timer);};
  },[runId,terminal]);
  return <section aria-label="任务调度与调用" className="mt-3 min-w-0 space-y-2 rounded border border-zinc-700 p-3 text-xs [overflow-wrap:anywhere]">{value&&<><p>已记录模型 API 请求 {value.apiRequests} · 原生回合启动 {value.nativeInvocations} · 等待准入 {value.waitingCalls}</p><p>平台派发回执 {value.dispatchReceipts} · 平台门禁完成 {value.platformTransitions} · 准入阻断 {value.blockedCalls}</p><p className="text-zinc-500">原生客户端内部请求次数无法由平台完整测量。{value.unknownCalls>0?`${value.unknownCalls} 次已发出请求没有成功完成。`:''}{value.coverage==='legacy_partial'?'历史任务仅统计本次升级后记录。':''}</p>{value.steps.map(s=><p key={s.stepId}>{members.find(a=>a.id===s.agentId)?.name??s.agentId} · {s.kind==='join'?'汇合':'成员任务'} · {s.waitingReason?`等待${s.waitingReason==='cost'?'费用':'Token'}额度`:displayStatus(s.status)} · 已调用 {s.calls} 次 · 准入等待 {(s.waitingMs/1000).toFixed(1)} 秒</p>)}</>}{error&&<p role="alert" className="text-red-300">调度状态读取失败：{error}</p>}</section>;
}
