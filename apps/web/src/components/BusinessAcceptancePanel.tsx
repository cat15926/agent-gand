import { useEffect, useRef, useState } from 'react';
import type { BusinessAuditEntry, BusinessCommand, BusinessEvidenceChoice, BusinessOutcome, BusinessState } from '@agent-gand/shared';
import * as api from '../services/api';

export const BUSINESS_OUTCOME_LABEL: Record<BusinessOutcome, string> = {
  unverified: '目标未验收', in_progress: '目标进行中', awaiting_acceptance: '目标待验收', achieved: '目标已达成',
  not_achieved: '目标未达成', partial_accepted: '已接受部分结果', user_ended: '用户提前结束',
};
const STAGE_LABEL = { pending: '待交付', blocked: '待前置阶段验收', acknowledged: '仅确认收到', awaiting_acceptance: '待验收', rejected: '已拒绝候选', accepted: '已验收' };
const button = 'rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40';
type Action = BusinessCommand extends infer C ? C extends BusinessCommand ? Omit<C, 'expectedVersion' | 'clientRequestId'> : never : never;

function StageAcceptance({ item, index, choices, enabled, settled, priorAccepted, busy, execute, runId }: {
  item: BusinessState['stages'][number]; index: number; choices: BusinessEvidenceChoice[]; enabled: boolean; settled: boolean; busy: boolean;
  execute: (command: Action) => Promise<void>; runId: string; priorAccepted: boolean;
}) {
  const [selected, setSelected] = useState<Record<string, BusinessEvidenceChoice>>({});
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<number[]>([]);
  const [note, setNote] = useState(''); const [fileError, setFileError] = useState(''); const [fileBusy, setFileBusy] = useState(false);
  const report = item.report;
  const openReport = Boolean(report && !item.decision);
  const canRegister = enabled && !openReport && item.status !== 'accepted';
  async function file(id: string) {
    setFileError(''); setFileBusy(true);
    try { const choice = await api.createBusinessFileEvidence(runId, paths[id] ?? ''); setSelected(previous => ({ ...previous, [id]: choice })); }
    catch (error) { setFileError(error instanceof Error ? error.message : String(error)); }
    finally { setFileBusy(false); }
  }
  const disabled = busy || fileBusy;
  return <details className="rounded-lg border border-zinc-700 p-3" open={item.status === 'awaiting_acceptance' || index === 0 && item.status !== 'accepted'}>
    <summary className="cursor-pointer">{index + 1}. {item.stage.title} · {STAGE_LABEL[item.status]}</summary>
    <div className="mt-3 space-y-3">
      <ul className="space-y-1 text-zinc-400">{item.stage.deliverables.map(deliverable => <li key={deliverable.id}>必要交付：{deliverable.title}（{deliverable.kind === 'file' ? '文件' : '文本'}）</li>)}</ul>
      {report && <div className="space-y-2 rounded bg-zinc-950/60 p-2"><p>{report.kind === 'receipt' ? '确认记录' : '候选交付'} · {report.createdAt}</p>{report.note && <p className="whitespace-pre-wrap">{report.note}</p>}
        {report.evidence.map(e => <details key={e.deliverableId}><summary className="cursor-pointer">{item.stage.deliverables.find(d => d.id === e.deliverableId)?.title} · 查看登记证据</summary><pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{e.resolution.excerpt}</pre><p className="mt-1 break-all text-zinc-500">登记哈希：{e.resolution.contentSha256}</p></details>)}
        {item.decision && <p className={item.decision.verdict === 'accept' ? 'text-emerald-300' : 'text-amber-200'}>{item.decision.verdict === 'accept' ? '用户已验收' : '候选已拒绝'} · {item.decision.createdAt}{item.decision.reason ? ` · ${item.decision.reason}` : ''}</p>}
      </div>}
      <fieldset disabled={disabled || !enabled || !openReport || report?.kind !== 'delivery'} className="space-y-2">
        <legend className="mb-2 text-zinc-400">逐项验收标准</legend>{item.stage.criteria.map((criterion, at) => <label key={at} className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={item.decision?.verdict === 'accept' || checked.includes(at)} onChange={e => setChecked(previous => e.target.checked ? [...previous, at] : previous.filter(i => i !== at))} />{criterion}</label>)}
      </fieldset>
      {enabled && item.status !== 'accepted' && <label className="block text-zinc-400">交付或验收说明<textarea aria-label={`${item.stage.title} 说明`} className="input mt-1 min-h-16" maxLength={2000} value={note} disabled={disabled} onChange={e => setNote(e.target.value)} placeholder="拒绝候选时请说明缺少哪些内容" /></label>}
      {canRegister && <div className="space-y-3">
        {item.stage.deliverables.map(deliverable => <div key={deliverable.id}><label className="block text-zinc-400">{deliverable.title}{deliverable.kind === 'text' ? <select className="input mt-1" aria-label={`${deliverable.title} 证据`} disabled={disabled || !settled} value={selected[deliverable.id] ? JSON.stringify(selected[deliverable.id]!.ref) : ''} onChange={e => { const choice = choices.find(c => JSON.stringify(c.ref) === e.target.value); setSelected(previous => { const next = { ...previous }; if (choice) next[deliverable.id] = choice; else delete next[deliverable.id]; return next; }); }}><option value="">选择本任务的成员消息或已完成输出</option>{choices.map(c => <option key={JSON.stringify(c.ref)} value={JSON.stringify(c.ref)}>{c.label} · {c.excerpt.slice(0, 60)}</option>)}</select>
          : <div className="mt-1 flex min-w-0 gap-2"><input aria-label={`${deliverable.title} 文件路径`} className="input min-w-0 flex-1" placeholder="任务工作区相对路径，如 reports/result.md" disabled={disabled || !settled} value={paths[deliverable.id] ?? ''} onChange={e => { setPaths(p => ({ ...p, [deliverable.id]: e.target.value })); setSelected(previous => { const next = { ...previous }; delete next[deliverable.id]; return next; }); }} /><button className={button} disabled={disabled || !settled || !paths[deliverable.id]?.trim()} onClick={() => void file(deliverable.id)}>核对文件</button></div>}</label>
          {selected[deliverable.id] && <details className="mt-1 text-zinc-400"><summary>预览证据</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{selected[deliverable.id]!.excerpt}</pre></details>}
        </div>)}
        {item.stage.deliverables.some(d => d.kind === 'file') && <p className="text-zinc-500">仅支持当前任务绑定工作区内不超过 32 KiB 的普通文件；登记哈希后仍会在验收时重新核对，不会自动迁移产物。</p>}
        <div className="flex flex-wrap gap-2"><button className={button} disabled={disabled || !settled || Object.keys(selected).length !== item.stage.deliverables.length} onClick={() => void execute({ action: 'report', stageId: item.stage.id, kind: 'delivery', note, evidence: Object.entries(selected).map(([deliverableId, choice]) => ({ deliverableId, ref: choice.ref })) })}>登记交付候选</button>
          <button className={button} disabled={disabled || !note.trim()} onClick={() => void execute({ action: 'report', stageId: item.stage.id, kind: 'receipt', note, evidence: [] })}>仅记录确认收到</button></div>
      </div>}
      {enabled && openReport && <div className="flex flex-wrap gap-2">
        {report?.kind === 'delivery' && <button className="rounded-lg bg-emerald-700 px-3 py-2 text-white disabled:opacity-40" disabled={disabled || !settled || !priorAccepted || checked.length !== item.stage.criteria.length} onClick={() => void execute({ action: 'decide', stageId: item.stage.id, reportId: report.id, verdict: 'accept', checkedCriteria: checked, reason: note })}>确认验收本阶段</button>}
        <button className={button} disabled={disabled || !note.trim()} onClick={() => void execute({ action: 'decide', stageId: item.stage.id, reportId: report!.id, verdict: 'reject', checkedCriteria: [], reason: note })}>{report?.kind === 'receipt' ? '关闭确认记录，等待交付' : '拒绝候选，重新登记'}</button>
      </div>}
      {report?.kind === 'receipt' && !item.decision && <p className="text-amber-200">确认收到不能通过验收。填写说明并关闭此记录后，可登记实质交付。</p>}
    </div>
    {fileError && <p role="alert" className="mt-2 text-red-300">{fileError}</p>}
  </details>;
}

export function BusinessAcceptancePanel({ runId, version, executionStatus }: { runId: string; version?: number; executionStatus: string }) {
  const [state, setState] = useState<BusinessState | null>(null); const [choices, setChoices] = useState<BusinessEvidenceChoice[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState<'not_achieved' | 'partial_accepted' | 'user_ended'>('not_achieved');
  const [history, setHistory] = useState<BusinessAuditEntry[] | null>(null);
  const alive = useRef(true); const requestId = useRef<{ digest: string; id: string } | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { let live = true; void Promise.all([api.getBusinessState(runId), api.getBusinessEvidence(runId)]).then(([value, evidence]) => { if (live) { setState(previous => previous?.runId === value.runId && previous.version > value.version ? previous : value); setChoices(evidence.choices); } }).catch(error => { if (live) setError(error instanceof Error ? error.message : String(error)); }); return () => { live = false; }; }, [runId, version, executionStatus]);
  async function execute(command: Action) {
    if (!state) return;
    const digest = JSON.stringify({ ...command, expectedVersion: state.version });
    if (requestId.current?.digest !== digest) requestId.current = { digest, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { const value = await api.applyBusinessCommand(runId, { ...command, expectedVersion: state.version, clientRequestId: requestId.current.id }); if (alive.current) { setState(value); setHistory(null); requestId.current = null; setReason(''); } }
    catch (error) {
      if (alive.current) { setError(error instanceof Error ? error.message : String(error)); if (error instanceof api.ApiError && error.code === 'BUSINESS_STATE_STALE') { requestId.current = null; try { setState(await api.getBusinessState(runId)); } catch { /* Preserve the visible error. */ } } }
    } finally { if (alive.current) setBusy(false); }
  }
  if (!state) return <p className="text-zinc-400">{error || '正在读取阶段验收记录…'}</p>;
  const enabled = Boolean(state.contract && !state.resolution && state.outcome !== 'achieved');
  return <section aria-label="业务阶段验收" className="space-y-3 rounded-xl border border-violet-500/20 p-3">
    <h4 className="font-medium text-violet-200">业务目标 · {BUSINESS_OUTCOME_LABEL[state.outcome]}</h4>
    {!state.contract ? <p className="text-zinc-400">本任务未定义阶段验收清单，执行状态不能证明业务目标达成。新任务可在执行设置中启用阶段验收。</p> : <>
      <p className="text-zinc-400">证据与标准由你核对。全部阶段通过后，业务目标才显示为已达成；这里的决定不改写原执行终态，也不会调用模型。</p>
      {!state.settled && <p className="text-amber-200">请等待执行结束；如需提前结束，先使用“取消此任务”。未知进程或工具结果收敛后才能登记交付和验收。</p>}
      {state.stages.map((item, index) => <StageAcceptance key={`${item.stage.id}:${item.report?.id ?? 'new'}:${item.decision?.verdict ?? ''}`} item={item} index={index} choices={choices} enabled={enabled} settled={state.settled} priorAccepted={state.stages.slice(0, index).every(s => s.status === 'accepted')} busy={busy} execute={execute} runId={runId} />)}
      {state.resolution && <p className="whitespace-pre-wrap text-zinc-400">用户决定：{state.resolution.reason} · {state.resolution.createdAt}</p>}
      {enabled && <details><summary className="cursor-pointer text-zinc-400">结束业务验收或接受部分结果</summary><div className="mt-2 space-y-2"><select aria-label="业务结束方式" className="input" disabled={busy || !state.settled} value={resolution} onChange={e => setResolution(e.target.value as typeof resolution)}><option value="not_achieved">明确目标未达成</option><option value="partial_accepted" disabled={!state.stages.some(s => s.status === 'accepted')}>接受已验收的部分结果</option><option value="user_ended">用户提前结束</option></select><textarea aria-label="业务结束原因" className="input min-h-16" maxLength={2000} value={reason} disabled={busy || !state.settled} onChange={e => setReason(e.target.value)} placeholder="请说明结束原因或接受范围，此决定会固定本轮业务结果" /><button className={button} disabled={busy || !state.settled || !reason.trim()} onClick={() => void execute({ action: 'resolve', outcome: resolution, reason })}>确认并固定业务结果</button></div></details>}
    </>}
    <details onToggle={e => { if (e.currentTarget.open) void api.getBusinessHistory(runId).then(value => { if (alive.current) setHistory(value.events); }).catch(error => { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }); }}><summary className="cursor-pointer text-zinc-400">查看验收历史（最近 100 条）</summary><div className="mt-2 space-y-2">{history?.map(event => <details key={event.id} className="rounded bg-zinc-950/60 p-2"><summary>记录 {event.version} · {event.action === 'report' ? event.report?.kind === 'receipt' ? '确认收到' : '登记交付' : event.action === 'decide' ? event.decision?.verdict === 'accept' ? '验收通过' : '拒绝候选' : '固定业务结果'} · {event.createdAt}</summary><p className="mt-2 whitespace-pre-wrap">{event.report?.note ?? event.decision?.reason ?? event.resolution?.reason}</p>{event.report?.evidence.map(evidence => <pre key={evidence.deliverableId} className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{evidence.resolution.source}{'\n'}{evidence.resolution.excerpt}{'\n'}SHA256: {evidence.resolution.contentSha256}</pre>)}</details>)}{history?.length === 0 && <p className="text-zinc-500">尚无验收记录。</p>}</div></details>
    {error && <p role="alert" className="text-red-300">{error}</p>}
  </section>;
}
