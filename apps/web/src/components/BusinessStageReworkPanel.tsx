import { useRef, useEffect, useState } from 'react';
import type { BusinessState } from '@agent-gand/shared';
import * as api from '../services/api';

const button = 'rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40';
export function BusinessStageReworkPanel({ runId, version, item, members, disabled, onCreated }: {
  runId: string; version: number; item: BusinessState['stages'][number]; members: Array<{ id: string; name: string }>;
  disabled: boolean; onCreated: (runId: string) => Promise<void>;
}) {
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<api.BusinessReworkPreview | null>(null);
  const [working, setWorking] = useState(false); const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function prepare() {
    setWorking(true); setError(''); setPreview(null);
    try {
      const value = await api.previewBusinessRework(runId, { stageId: item.stage.id, reportId: item.report!.id, expectedVersion: version, instruction });
      if (alive.current) setPreview(value);
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setWorking(false); }
  }
  async function confirm() {
    if (!preview) return;
    setWorking(true); setError('');
    try { const result = await api.submitBusinessRework(runId, preview); await onCreated(result.run.id); }
    catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : String(error));
        if (error instanceof api.ApiError && ['PREVIEW_STALE', 'BUSINESS_STATE_STALE', 'STAGE_REWORK_UNAVAILABLE'].includes(error.code ?? '')) setPreview(null);
      }
    } finally { if (alive.current) setWorking(false); }
  }
  const busy = disabled || working;
  return <div aria-label={`${item.stage.title} 阶段返工`} className="space-y-3 rounded-lg border border-amber-500/30 p-3">
    <p className="text-amber-200">需要成员修订交付时，可明确发起阶段返工。当前支持公开只读阶段。</p>
    <label className="block text-zinc-400">补充修订要求<textarea aria-label={`${item.stage.title} 返工要求`} className="input mt-1 min-h-20" maxLength={2000} disabled={busy} value={instruction}
      onChange={e => { setInstruction(e.target.value); setPreview(null); setError(''); }} placeholder="说明需要补充或改正的内容；原验收标准和交付清单保持不变" /></label>
    <button className={button} disabled={busy || !instruction.trim()} onClick={() => void prepare()}>预览阶段返工</button>
    {preview && <div aria-label="阶段返工预览" className="space-y-3 border-t border-zinc-700 pt-3">
      <p>返工阶段：{preview.stage.title}。本阶段全部 {preview.stage.assignments.length} 个成员任务将重新执行。</p>
      {preview.stage.assignments.map((a, i) => <p key={i} className="whitespace-pre-wrap text-zinc-300">{i + 1}. {members.find(m => m.id === a.agentId)?.name ?? a.agentId}：{a.objective}</p>)}
      <p>保留已验收阶段：{preview.checkpoint.acceptedStages.map(s => s.title).join('、') || '无'}。后续阶段须等待本次重新验收。</p>
      <p className="whitespace-pre-wrap text-zinc-400">拒绝原因：{preview.checkpoint.rework?.reason}</p>
      <p className="whitespace-pre-wrap text-zinc-300">修订要求：{preview.input.instruction}</p>
      <p className="text-zinc-400">使用新的独立工作区及模型会话，仅复制 {preview.checkpoint.files.length} 个已验收文件。被拒绝的候选留存供参考，不能用于新任务验收。</p>
      <p className="text-zinc-400">执行及阶段时限重新计算。已占用输出 Token 预算结转：本轮 {preview.checkpoint.carriedRunTokens}；返工阶段 {preview.checkpoint.carriedStageTokens.find(s => s.stageId === preview.stage.id)?.charged ?? 0}。</p>
      {preview.closesWaitingSource && <p className="text-amber-200">确认后会关闭原任务的等待执行，保留原拒绝及验收记录，并创建关联返工任务。</p>}
      {preview.preview.decision.issues.map((issue, i) => <p key={i} className={issue.severity === 'error' ? 'text-red-300' : 'text-amber-200'}>{issue.message}</p>)}
      <p className="text-zinc-400">确认后将调用模型，可能消耗额度。</p>
      <div className="flex flex-wrap gap-2"><button className="rounded-lg bg-violet-500 px-3 py-2 text-white disabled:opacity-40" disabled={busy || preview.preview.decision.issues.some(i => i.severity === 'error')} onClick={() => void confirm()}>确认并执行返工</button>
        <button className={button} disabled={busy} onClick={() => setPreview(null)}>关闭返工预览</button></div>
    </div>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </div>;
}
