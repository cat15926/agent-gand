import { useEffect, useRef, useState } from 'react';
import type { BusinessState, RecoveryInspection, RecoveryReviewInput, RecoveryReview } from '@agent-gand/shared';
import * as api from '../services/api';
import { SnapshotManifest } from './ArtifactSnapshotPanel';
import { CostBudgetSummary } from './CostBudgetPanel';

const button = 'rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 disabled:opacity-40';
type Choice = { verdict: '' | 'completed' | 'not_executed'; reason: string; output: string };
export function RecoveryReviewHistory({ runId }: { runId: string }) {
  const [reviews, setReviews] = useState<RecoveryReview[] | null>(null), [error, setError] = useState('');
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setReviews(null); setError(''); return () => { epoch.current++; }; }, [runId]);
  async function read() {
    const current = epoch.current;
    try { const result = await api.getBusinessRecoveryReviews(runId); if (current === epoch.current) setReviews(result.reviews); }
    catch (e) { if (current === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
  }
  return <details aria-label="恢复核对记录" className="min-w-0 rounded-lg border border-zinc-700 p-3" onToggle={e => { if (e.currentTarget.open) void read(); }}>
    <summary className="cursor-pointer">查看所有者恢复核对记录</summary>
    <div className="mt-3 space-y-3 text-xs [overflow-wrap:anywhere]">
      {reviews?.length === 0 && <p className="text-zinc-400">暂无核对记录。</p>}
      {reviews?.map(r => <div key={r.id} className="space-y-2 rounded bg-zinc-950/50 p-2">
        <p>所有者核对 · {r.createdAt}</p><p className="whitespace-pre-wrap">{r.input.reason}</p>
        {r.input.steps.map(s => <details key={s.stepId}><summary>{s.stepId} · {s.verdict === 'completed' ? '确认完成' : '确认未执行'}</summary><p className="mt-2 whitespace-pre-wrap">{s.reason}</p>{s.output && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{s.output}</pre>}</details>)}
        <p className="text-zinc-500">记录 {r.id}</p>
      </div>)}
      {reviews && reviews.length > 0 && <p className="text-zinc-500">显示最近 10 条不可变记录；历史记录保留在原任务归档中。</p>}
      {error && <p role="alert" className="text-red-300">{error}</p>}
    </div>
  </details>;
}
export function CheckpointRecoveryScope({ checkpoint, members }: {
  checkpoint: Pick<NonNullable<BusinessState['checkpoint']>, 'access' | 'readonly' | 'recovery'>;
  members: Array<{ id: string; name: string }>;
}) {
  if (!checkpoint.access) return null;
  return <div className="space-y-2 text-zinc-400">
    <p>授权范围：{checkpoint.access.visibility === 'public' ? '公开' : `私密 · ${checkpoint.access.audience.filter(id => id !== 'user').map(id => members.find(m => m.id === id)?.name ?? id).join('、')}`}。私密文件保留加密，通过获准的文件工具读取。</p>
    <p>{checkpoint.readonly ? '只读执行' : '受控文件写入'}，使用新目录和新模型会话。命令和外部副作用工具保持禁用。</p>
    {checkpoint.recovery?.reviewId && <p className="break-all">所有者核对记录：{checkpoint.recovery.reviewId}。</p>}
    {Boolean(checkpoint.recovery?.runUnknownTokens) && <p className="text-amber-200">原任务未知用量按预留上限结转：{checkpoint.recovery!.runUnknownTokens} 输出 Token；原未知账本保留。</p>}
  </div>;
}
export function BusinessRecoveryPanel({ runId, members, onReviewed }: {
  runId: string; members: Array<{ id: string; name: string }>; onReviewed: () => Promise<void> | void;
}) {
  const [inspection, setInspection] = useState<RecoveryInspection | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [reason, setReason] = useState(''), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const epoch = useRef(0), requestId = useRef('');
  useEffect(() => { epoch.current++; setInspection(null); setError(''); setBusy(false); return () => { epoch.current++; }; }, [runId]);
  const memberName = (id: string) => members.find(m => m.id === id)?.name ?? id;
  const unknown = inspection?.steps.filter(s => s.state === 'unknown') ?? [];
  async function inspect() {
    const current = epoch.current; setBusy(true); setError('');
    try {
      const result = await api.inspectBusinessRecovery(runId);
      if (current !== epoch.current) return;
      setInspection(result); setChoices(Object.fromEntries(result.steps.filter(s => s.state === 'unknown').map(s => [s.stepId, { verdict: '', reason: '', output: '' }])));
      setReason(''); setChecked(false); requestId.current = crypto.randomUUID();
    } catch (e) { if (current === epoch.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (current === epoch.current) setBusy(false); }
  }
  function change(id: string, patch: Partial<Choice>) { setChoices(c => ({ ...c, [id]: { ...c[id]!, ...patch } })); requestId.current = crypto.randomUUID(); }
  async function confirm() {
    if (!inspection) return;
    const current = epoch.current; setBusy(true); setError('');
    const input: RecoveryReviewInput = { fingerprint: inspection.fingerprint, clientRequestId: requestId.current, reason, externalEffectsChecked: checked,
      steps: unknown.map(s => ({ stepId: s.stepId, verdict: choices[s.stepId]!.verdict as 'completed' | 'not_executed', reason: choices[s.stepId]!.reason,
        ...(choices[s.stepId]!.verdict === 'completed' ? { output: choices[s.stepId]!.output } : {}) })) };
    try { const result = await api.confirmBusinessRecovery(runId, input); if (current === epoch.current) { setInspection(result); await onReviewed(); } }
    catch (e) { if (current === epoch.current) { setError(e instanceof Error ? e.message : String(e)); if (e instanceof api.ApiError && e.code === 'RECOVERY_REVIEW_STALE') setInspection(null); } }
    finally { if (current === epoch.current) setBusy(false); }
  }
  const invalid = !checked || reason.trim().length < 10 || unknown.some(s => !choices[s.stepId]?.verdict || choices[s.stepId]!.reason.trim().length < 10
    || choices[s.stepId]!.verdict === 'completed' && choices[s.stepId]!.output.trim().length < 30);
  return <div aria-label="恢复前核对" className="min-w-0 space-y-3 rounded-lg border border-amber-500/30 p-3 text-xs">
    <p className="text-amber-200">恢复前核对：查看授权范围、工作树及工具结果，确认剩余事项。核对本身不会调用模型。</p>
    <button className={button} disabled={busy} onClick={() => void inspect()}>{inspection ? '重新检查恢复条件' : '检查恢复条件与副作用'}</button>
    {inspection && <div className="min-w-0 space-y-3" aria-label="恢复核对结果">
      <p className="[overflow-wrap:anywhere]">{inspection.readonly ? '只读任务' : '写入任务'} · {inspection.scope.visibility === 'public' ? '公开范围' : `私密范围：${inspection.scope.audience.filter(id => id !== 'user').map(memberName).join('、')}`}。后续任务保留此范围。</p>
      <ul className="space-y-2">{inspection.steps.map(s => <li key={s.stepId} className="[overflow-wrap:anywhere]">{memberName(s.agentId)} · {s.stepId} · {({ completed: '已确认完成', not_executed: '可执行的剩余步骤', unknown: '结果未知，等待核对' })[s.state]}<p className="mt-1 text-zinc-400">{s.reason}</p></li>)}</ul>
      <p className="text-zinc-400">当前工作状态快照用于核对与隔离恢复，不代表阶段验收通过。另保留 {inspection.acceptedArchiveIds.length} 份已验收产物归档。</p>
      <SnapshotManifest snapshot={inspection.snapshot} />
      {inspection.costBudget && <CostBudgetSummary budget={inspection.costBudget}/>}
      {inspection.tools.length > 0 && <details><summary>查看工具账本（{inspection.tools.length} 项）</summary>{inspection.tools.map(t => <p key={t.id} className="mt-1 [overflow-wrap:anywhere]">{t.name} · {t.status} · {t.replayPolicy}</p>)}</details>}
      {inspection.unknownUsage > 0 && <p className="text-amber-200">有 {inspection.unknownUsage} 条未知用量记录。续跑按预留上限结转输出 Token，不会把未知消耗当作零。</p>}
      {inspection.reviewId ? <p role="status" className="text-emerald-300">核对记录已保存，可以重新预览续跑或返工。文件、授权或账本变化后须重新核对。</p> : inspection.requiresReview ? <fieldset disabled={busy} className="min-w-0 space-y-3">
        {unknown.map(s => <div key={s.stepId} className="space-y-2 rounded bg-zinc-950/50 p-3">
          <label className="block">{memberName(s.agentId)} · 核对结论<select aria-label={`${s.stepId} 核对结论`} className="input mt-1" value={choices[s.stepId]!.verdict} onChange={e => change(s.stepId, { verdict: e.target.value as Choice['verdict'] })}>
            <option value="">仍未知，保持阻断</option><option value="completed">已完成，复用核对后的交付</option><option value="not_executed" disabled={!s.canConfirmNotExecuted}>确认未执行，允许执行一次</option>
          </select></label>
          {!s.canConfirmNotExecuted && <p className="text-amber-200">已观察到写入副作用，不能标为未执行后重跑。请核实或人工收尾，再确认完成。</p>}
          <label className="block">步骤核对依据<textarea aria-label={`${s.stepId} 核对依据`} className="input mt-1 min-h-16" maxLength={2000} value={choices[s.stepId]!.reason} onChange={e => change(s.stepId, { reason: e.target.value })} placeholder="至少 10 字：检查了哪些文件、工具或外部服务，结果是什么" /></label>
          {choices[s.stepId]!.verdict === 'completed' && <label className="block">核对后的实质交付<textarea aria-label={`${s.stepId} 核对交付`} className="input mt-1 min-h-24" maxLength={100000} value={choices[s.stepId]!.output} onChange={e => change(s.stepId, { output: e.target.value })} placeholder="至少 30 字，说明实际完成的内容与证据；保存为所有者核对结果，保留原失败记录" /></label>}
        </div>)}
        <label className="block">整体核对依据<textarea aria-label="整体核对依据" className="input mt-1 min-h-16" maxLength={2000} value={reason} onChange={e => { setReason(e.target.value); requestId.current = crypto.randomUUID(); }} placeholder="至少 10 字，说明可安全继续的依据" /></label>
        <label className="flex items-start gap-2"><input aria-label="确认已核对外部副作用" type="checkbox" checked={checked} onChange={e => { setChecked(e.target.checked); requestId.current = crypto.randomUUID(); }} />已核对工作树、工具账本及外部服务的实际结果。后续只执行剩余文件任务；命令与外部工具保持禁用。</label>
        <button className={button} disabled={busy || invalid} onClick={() => void confirm()}>保存核对记录</button>
      </fieldset> : <p className="text-emerald-300">恢复条件已检查，无需副作用确认，可以预览关联任务。</p>}
    </div>}
    {error && <p role="alert" className="break-words text-red-300">{error}</p>}
  </div>;
}
