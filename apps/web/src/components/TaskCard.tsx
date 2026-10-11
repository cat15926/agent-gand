import { BusinessAcceptancePanel, BUSINESS_OUTCOME_LABEL } from './BusinessAcceptancePanel';
import { useEffect, useState } from 'react';
import type { Run, RunFailureReport } from '@agent-gand/shared';
import * as api from '../services/api';
import { useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { displayStatus } from '../services/displayStatus';
import { taskLabel } from './TaskComposer';
import { executionFailureForRun } from '../services/executionFailure';
import { FailureDetails } from './FailureDetails';
import { SnapshotManifest } from './ArtifactSnapshotPanel';
export const STATUS_LABEL: Record<string,string> = { pending: '已排队', running: '执行中', awaiting_approval: '等待审批', waiting_for_user: '等待你的处理', completed: '已完成', failed: '失败（保留已确认结果）', cancelled: '已取消' };
export function TaskCard({ run, detail, onRevise, onRetryDraft }: { run: Run; detail?: api.TaskState; onRevise: (task: api.TaskState) => void; onRetryDraft: (newRoom: boolean) => void }) {
  const { state, refreshConversation, setActiveRun } = useStore(); const [busy, setBusy] = useState(false); const [error,setError] = useState(''); const [expanded,setExpanded] = useState(false);
  const [coordination,setCoordination] = useState<api.CoordinationRunDetail | null>(null);
  const [continuation,setContinuation] = useState<api.ContinuationPreview | null>(null);
  const [failureReport, setFailureReport] = useState<RunFailureReport | null>(null);
  const [failureLoadError, setFailureLoadError] = useState('');
  const continuationPreview = continuation?.preview;
  const stageContinuation = detail?.recovery?.continuationKind === 'business_stages';
  const pending = state.approvals.filter(a => a.runId === run.id && a.status === 'pending');
  const waiting = state.collaborationDecisions.filter(d => d.runId === run.id && d.status === 'pending');
  const terminal = ['completed','failed','cancelled'].includes(run.status);
  const failureStamp = state.executions.filter(item => item.runId === run.id).map(item => `${item.id}:${item.status}:${item.finishedAt}`).join('|');
  useEffect(() => {
    if (run.status !== 'failed' && !(expanded && run.status === 'cancelled')) return;
    let live = true;
    setFailureLoadError('');
    void api.getRunFailures(run.id).then(value => { if (live) setFailureReport(value); }).catch(reason => { if (live) setFailureLoadError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [run.id, run.status, expanded, failureStamp]);
  useEffect(() => {
    if (!expanded || !detail?.planStatus) return;
    let live = true; let fetching = false;
    const load = async () => {
      if (fetching) return; fetching = true;
      try { const value = await api.getRunCoordination(run.id); if (live) setCoordination(value); }
      catch (reason) { if (live) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { fetching = false; }
    };
    void load(); const timer = terminal ? null : window.setInterval(() => void load(),2000);
    return () => { live = false; if (timer) window.clearInterval(timer); };
  }, [expanded,run.id,run.status,detail?.revision,detail?.planStatus,terminal]);
  async function action(value: 'pause' | 'resume' | 'cancel') { setBusy(true); setError('');
    try { await api.runAction(run.id,value); await refreshConversation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function previewContinuation() { setBusy(true); setError('');
    try { setContinuation(await api.previewRunContinuation(run.id, stageContinuation)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  async function confirmContinuation() { if (!continuationPreview) return; setBusy(true); setError('');
    try { const result = await api.continueRun(run.id,continuationPreview, stageContinuation); setContinuation(null); await refreshConversation(); setActiveRun(result.run.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
  }
  const failedExecution = executionFailureForRun(state.executions, run.id);
  const primaryFailure = failureReport?.nodes.find(node => node.id === failureReport.primaryNodeIds[0]);
  const failure = primaryFailure?.message || failedExecution?.error || detail?.reason || state.messages.filter(m => m.runId === run.id && (m.kind === 'system' || m.deliveryStatus === 'failed')).at(-1)?.body || '';
  const timeoutKind = primaryFailure ? primaryFailure.details?.timeoutKind : failedExecution?.failureDetails?.timeoutKind;
  const workspaceFailure = /workspace|工作区|Git.*仓库|git.*work/i.test(failure);
  const advice = timeoutKind === 'first_response' ? '模型首响应超时。请核对账户连接，并根据模型的首次响应延迟调整首响应时限后准备新任务。'
    : timeoutKind === 'idle' ? '模型响应停滞。请查看最后的执行活动，缩小任务范围或调整停滞时限后准备新任务。'
    : workspaceFailure ? '当前工作区无法执行此任务。请在新房间选择可用的 Git 工作区。' : /401|403|auth|密钥|登录/i.test(failure) ? '账户验证或模型权限未通过。请先在“账户与密钥”中检查账户并测试模型，再准备新任务。' : /timeout|超时/i.test(failure) ? '执行超时。可缩小任务范围，或调整执行时限后准备新任务。' : '查看本轮错误与已确认结果，调整目标或执行设置后准备新任务。';
  const compact = run.status === 'completed' && !expanded && !pending.length && !waiting.length;
  const label = `第 ${run.turnNo} 轮`;
  const actionClass = 'rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-40';
  return <section aria-label={`${label}任务`} className={`my-3 min-w-0 rounded-xl border ${state.activeRunId === run.id ? 'border-violet-500/40' : 'border-zinc-800'} bg-zinc-900/70 p-3 text-xs [overflow-wrap:anywhere]`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-violet-200">{label} · {taskLabel(detail?.snapshot ?? null, run.mode)}</strong><span className={run.status === 'failed' ? 'text-red-300' : 'text-zinc-400'}>{detail?.paused ? '已安全暂停' : STATUS_LABEL[run.status] ?? run.status}</span></div>
    <p className={`mt-2 ${detail?.business?.outcome === 'achieved' ? 'text-emerald-300' : 'text-zinc-400'}`}>业务目标：{BUSINESS_OUTCOME_LABEL[detail?.business?.outcome ?? 'unverified']}{detail?.business?.contractPresent ? ` · ${detail.business.acceptedStages}/${detail.business.totalStages} 阶段已验收` : ''}</p>
    <p className={`mt-2 text-zinc-300 ${compact ? 'truncate' : ''}`} title={detail?.revisedGoal ?? run.goal}>{detail?.revisedGoal ?? run.goal}</p>{detail?.revisedGoal && <details className="mt-1 text-zinc-400"><summary>查看原目标</summary>{run.goal}</details>}
    {!compact && detail?.snapshot && <p className="mt-1 text-zinc-400">{detail.snapshot.decision.reason}{detail.revision ? ` · 计划版本 ${detail.revision}` : ''}</p>}
    {detail?.recovery?.sourceRunId && <p className="mt-2 text-violet-200">关联续跑 · <button className="underline" onClick={() => setActiveRun(detail.recovery!.sourceRunId!)}>查看原任务</button></p>}
    {detail?.recovery?.continuationRunId && <p className="mt-2 text-violet-200">已创建后续任务 · <button className="underline" onClick={() => setActiveRun(detail.recovery!.continuationRunId!)}>查看续跑</button></p>}
    {detail?.reservations.filter(t => t.status === 'waiting').map((ticket,index) => <p key={`${ticket.agentId}:${index}`} className="mt-2 text-amber-200">{state.agents.find(a => a.id === ticket.agentId)?.name ?? ticket.agentId} 已排队 · 前方 {ticket.position} 个执行；其他任务继续运行</p>)}
    {detail?.pauseRequested && !detail.paused && <p className="mt-2 text-amber-200">暂停已请求，等待当前步骤到达安全边界。</p>}
    {detail?.attention && <p role="alert" className="mt-2 text-amber-200">执行结果尚未确认：{detail.reason ?? '请核对执行记录与工作区'}。暂不可恢复或修订，可取消后创建新任务。</p>}
    {detail?.paused && detail.revisionBlockedReason && <p className="mt-2 text-amber-200">{detail.revisionBlockedReason}</p>}
    {waiting.length > 0 && <p className="mt-2 text-violet-200">请在本任务的问题卡中处理原决定；回复问题会继续此任务。</p>}
    {pending.length > 0 && <details open className="mt-3"><summary>本任务待审批（{pending.length}）</summary><div className="mt-2 space-y-2">{pending.map(a => <ApprovalCard key={a.id} approval={a} />)}</div></details>}
    {run.status === 'failed' && <div className="mt-3 rounded-lg bg-red-500/10 p-3 text-sm"><p className="text-red-200">{advice}</p>{failure && <details className="mt-2 text-xs text-zinc-400"><summary>查看错误原文</summary><pre className="mt-2 whitespace-pre-wrap">{failure}</pre></details>}<button className={`${actionClass} mt-3`} onClick={() => onRetryDraft(workspaceFailure)}>{workspaceFailure ? '带入新房间配置工作区' : '准备新任务草稿'}</button><p className="mt-2 text-xs text-zinc-400">保留本轮已确认结果，草稿需要预览并确认后才会执行。</p></div>}
    {failureReport && (run.status === 'failed' || expanded) && <FailureDetails report={failureReport} memberName={id => state.agents.find(agent => agent.id === id)?.name ?? id} />}
    {failureLoadError && <p className="mt-2 text-amber-200">诊断读取失败：{failureLoadError}</p>}
    {run.status === 'failed' && detail?.recovery && !detail.recovery.continuationRunId && <div className="mt-3 rounded-lg border border-zinc-700 p-3">
      <p className="text-zinc-300">{detail.recovery.explanation}</p>
      {detail.recovery.continuationAllowed && <><p className="mt-1 text-zinc-400">携带 {detail.recovery.confirmedOutputs} 条已确认执行输出。原任务终态和证据保持不变。</p><button disabled={busy} className={`${actionClass} mt-2`} onClick={() => void previewContinuation()}>{stageContinuation ? '预览阶段续跑' : '预览只读续跑'}</button></>}
      {continuationPreview && <div aria-label="关联续跑预览" className="mt-3 space-y-2 border-t border-zinc-700 pt-3"><p>剩余事项由 {[...new Set(continuationPreview.plan ? continuationPreview.plan.plan.steps.flatMap(s => s.agentId ? [s.agentId] : []) : continuationPreview.decision.targetIds)].map(id => state.agents.find(agent => agent.id === id)?.name ?? id).join('、') || '平台等待阶段验收'} 执行 · 只读</p><pre className="max-h-32 overflow-y-auto whitespace-pre-wrap text-zinc-300">{continuation?.checkpoint.pendingObjective}</pre>
        {continuation?.checkpoint.business && <div className="space-y-2 rounded bg-violet-500/10 p-2"><p>继承已验收阶段：{continuation.checkpoint.business.acceptedStages.map(s => s.title).join('、') || '无'}。已完成的成员步骤从执行图移除。</p><p>使用新的独立工作区，恢复声明交付与 Git 基线；受控文件按原公开版本迁移。</p>{continuation.checkpoint.business.files.length > 0 && <details><summary>查看归档文件与哈希</summary>{continuation.checkpoint.business.files.map(file => <p key={file.path} className="mt-1 break-all">{file.path} · SHA256 {file.sha256}</p>)}</details>}{continuation.checkpoint.business.archive && <SnapshotManifest snapshot={continuation.checkpoint.business.archive.manifest}/>}<p>执行时限及阶段时限重新计算。已占用的输出 Token 预算结转：本轮 {continuation.checkpoint.business.carriedRunTokens}；阶段 {continuation.checkpoint.business.carriedStageTokens.reduce((n, s) => n + s.charged, 0)}，不会重新获得已消耗额度。</p></div>}
        <details><summary className="cursor-pointer text-zinc-400">查看将复用的确认输出</summary>{continuation?.checkpoint.confirmedOutputs.map(item => <pre key={item.attemptId} className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-zinc-400">{state.agents.find(agent => agent.id === item.agentId)?.name ?? item.agentId}：{item.excerpt}{item.truncated ? '\n[预览摘录已截断]' : ''}</pre>)}</details><p className="text-zinc-400">使用当前角色与账户配置建立新会话。原执行及工具不会被平台重放；确认后会调用模型，可能消耗额度。</p>{continuationPreview.decision.issues.map((issue,index) => <p key={index} className={issue.severity === 'error' ? 'text-red-300' : 'text-amber-200'}>{issue.message}</p>)}<div className="flex gap-2"><button disabled={busy || continuationPreview.decision.issues.some(issue => issue.severity === 'error')} className="rounded-lg bg-violet-500 px-3 py-2 text-white disabled:opacity-40" onClick={() => void confirmContinuation()}>确认并续跑</button><button disabled={busy} className={actionClass} onClick={() => setContinuation(null)}>关闭预览</button></div></div>}
    </div>}
    <div className="mt-3 flex flex-wrap gap-2"><button aria-label={`查看${label}执行轨迹`} className={actionClass} onClick={() => setActiveRun(run.id)}>查看任务详情</button>{!terminal && !detail?.paused && !waiting.length && <button aria-label={`暂停${label}`} disabled={busy || detail?.pauseRequested || run.status === 'awaiting_approval'} className={actionClass} onClick={() => void action('pause')}>暂停此任务</button>}
      {detail?.paused && <button aria-label={`恢复${label}`} disabled={busy || detail.attention || detail.snapshot?.request.businessContract?.executionMode === 'stage_gated' && detail.business?.outcome === 'awaiting_acceptance'} className={actionClass} onClick={() => void action('resume')}>{detail.snapshot?.request.businessContract?.executionMode === 'stage_gated' && detail.business?.outcome === 'awaiting_acceptance' ? '请在阶段验收中继续' : '恢复此任务'}</button>}
      {detail?.paused && detail.snapshot?.executionAuthority === 'orchestration' && detail.snapshot.execution?.engine === 'coordination' && <button aria-label={`修订${label}`} disabled={busy || detail.attention || pending.length > 0 || Boolean(detail.revisionBlockedReason)} className={actionClass} onClick={() => onRevise(detail)}>补充当前任务／修订计划</button>}
      {!terminal && <button aria-label={`取消${label}`} disabled={busy} className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-300 disabled:opacity-40" onClick={() => void action('cancel')}>取消此任务</button>}
      <button className={actionClass} aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起详情' : '查看计划、结果与验收'}</button>
    </div>
    {expanded && <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3"><p className="text-zinc-400">任务 {run.id} · 工作区 {run.workspace ?? '自动工作区'}</p>{coordination?.plan.steps.map(step => {
      const current = coordination.steps.find(s => s.stepId === step.id && s.revision === coordination.plan.revision);
      return <details key={step.id} className="rounded bg-zinc-950/60 p-2" open={current?.status === 'failed'}><summary>{typeof step.metadata.title === 'string' ? step.metadata.title : step.completion} · {state.agents.find(a => a.id === step.agentId)?.name ?? step.actorRole} · {displayStatus(current?.status ?? 'pending')} · 尝试 {current?.attemptNo ?? 0}/{step.maxAttempts}</summary><p className="mt-1 text-zinc-400">{step.dependsOn.length ? `等待 ${step.dependsOn.join('、')}` : '无前置依赖'}</p>{current?.error && <p className="mt-2 text-red-300">{current.error}</p>}{current?.output && <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">{current.output}</pre>}</details>;
    })}{!coordination && <p className="text-zinc-400">执行结果保存在该任务的消息与执行轨迹中。</p>}{run.status === 'failed' && detail?.snapshot?.execution?.engine === 'coordination' && !detail.recovery?.continuationAllowed && <p className="text-amber-200">此任务暂不满足安全续跑条件。请核对失败原因与已确认结果。</p>}{run.status === 'completed' && detail?.snapshot && !detail.snapshot.execution?.readonly && <p className="text-zinc-400">任务完成不代表已经提交、推送、合并或部署；请检查变更补丁与审查结果。</p>}</div>}
    {expanded && <div className="mt-3"><BusinessAcceptancePanel members={detail?.snapshot?.capabilities.agents ?? state.agents} runId={run.id} version={detail?.business?.version} executionStatus={run.status} onNavigate={async id => { await refreshConversation(); setActiveRun(id); }} /></div>}
    {error && <p role="alert" className="mt-2 text-red-300">{error}</p>}
  </section>;
}
