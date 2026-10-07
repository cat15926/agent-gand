/**
 * 右侧面板：审批队列 / Trace 时间线 / 用量（对应报告模式 5 / 4）
 */
import { displayStatus } from '../services/displayStatus';
import { RunExecutionDetails } from './RunExecutionDetails';
import { useState } from 'react';
import { useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import * as api from '../services/api';
import { collaborationAttemptTone, collaborationBatchProgress } from '../collaborationView';

const SPAN_COLOR: Record<string, string> = {
  llm: 'text-sky-300',
  tool: 'text-amber-300',
  agent: 'text-violet-300',
  message: 'text-zinc-400',
  approval: 'text-rose-300',
  orchestration: 'text-emerald-300',
};

/** 已决策状态标签（最近记录区用，pending 卡走完整 ApprovalCard） */
const DECIDED_LABEL: Record<string, string> = {
  approved: '已批准',
  rejected: '已拒绝',
  edited: '已编辑',
  expired: '已超时',
};

const COORDINATION_STATUS: Record<string, { label: string; color: string; marker: string }> = {
  pending: { label: '等待依赖', color: 'text-zinc-400', marker: '○' },
  ready: { label: '已就绪', color: 'text-violet-300', marker: '◇' },
  running: { label: '运行中', color: 'text-sky-300', marker: '◌' },
  completed: { label: '已完成', color: 'text-emerald-400', marker: '✓' },
  failed: { label: '失败', color: 'text-red-400', marker: '✗' },
  interrupted: { label: '已中断', color: 'text-amber-300', marker: '!' },
};

const STEP_TYPE_LABEL: Record<string, string> = {
  agent_turn: 'Agent 执行', fanout: '并行分支', aggregate: '汇总', review: '独立审查', completion_gate: '完成屏障',
};

const BLOCKER_CATEGORY_LABEL: Record<string, string> = {
  control_action: '需要明确控制动作',
  work: '需要补实际工作',
  external: '等待外部条件',
  stale_responsibility: '责任已失效',
};
const ACTION_COMMAND_LABEL: Record<string, string> = {
  complete: '提交完成', wake: '恢复执行', hold: '进入等待', handoff: '移交责任',
  consult_all: '并行征询（全部）', consult_any: '并行征询（首个成功）',
};
const SHADOW_CLASSIFICATION_LABEL: Record<string, string> = {
  match: '一致', runtime_stricter: 'Runtime 更严格', runtime_looser: 'Runtime 更宽松',
  projection_only: '仅投影', observer_error: '观察失败',
};

export function RightPanel() {
  const { state } = useStore();
  const [tab, setTab] = useState<'collaboration' | 'tasks' | 'approvals' | 'trace' | 'usage'>('collaboration');
  const [actionError, setActionError] = useState('');
  const [actingTask, setActingTask] = useState<string | null>(null);

  async function taskAction(taskId: string, action: 'retry' | 'cancel') {
    setActingTask(taskId); setActionError('');
    try {
      if (action === 'retry') await api.retryTask(taskId);
      else await api.cancelTask(taskId);
    } catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)); } finally {
      setActingTask(null);
    }
  }
  // pending 按 createdAt 置顶（最早最紧急在前）；已决策的最近 5 条折叠展示在下方（§8.2）
  const pending = state.approvals
    .filter((a) => a.status === 'pending' && a.runId === state.activeRunId)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const decidedRecent = state.approvals
    .filter((a) => a.status !== 'pending' && a.runId === state.activeRunId)
    .sort((x, y) => (y.decidedAt ?? y.createdAt).localeCompare(x.decidedAt ?? x.createdAt))
    .slice(0, 5);
  const coordinationCompleted = state.coordinationSteps.filter((step) => step.status === 'completed').length;
  const legacyTasks = state.tasks.filter((task) => task.runId === state.activeRunId);
  const activeRun = state.runs.find((run) => run.id === state.activeRunId);
  const terminalDispositionLabel = activeRun?.terminalDisposition === 'accepted' ? '正常完成'
    : activeRun?.terminalDisposition === 'authorized_partial' ? '已授权部分结果'
      : activeRun?.terminalDisposition === 'delegated' ? '已委派后续执行'
        : activeRun?.terminalDisposition === 'failed' ? '执行失败'
          : activeRun?.terminalDisposition === 'cancelled' ? '已取消' : null;
  const activeDispatches = state.collaborationDispatches.filter(item => item.runId === state.activeRunId);
  const activeEvents = state.events.filter(item => item.runId === state.activeRunId);
  const activeUsage = state.usage.filter(item => item.runId === state.activeRunId);
  const name = (id: string) => state.agents.find(a => a.id === id)?.name ?? ({ user: '你', system: '系统' }[id] ?? id);
  const activeBatches = state.collaborationBatches.filter((batch) => !state.activeRunId || batch.runId === state.activeRunId);
  const activeAttempts = state.collaborationAttempts.filter((attempt) => !state.activeRunId || attempt.runId === state.activeRunId);
  const activeCandidates = state.completionCandidates.filter((candidate) => !state.activeRunId || candidate.runId === state.activeRunId);
  const activeObligations = state.successorObligations.filter((obligation) => !state.activeRunId || obligation.runId === state.activeRunId);
  const activeEvidenceBundles = state.evidenceBundles.filter((bundle) => !state.activeRunId || bundle.runId === state.activeRunId);
  const activeRouteGuards = state.routeGuardEvents.filter((event) => !state.activeRunId || event.runId === state.activeRunId);
  const activeDurableHolds = state.durableHolds.filter((hold) => !state.activeRunId || hold.runId === state.activeRunId);
  const activeWakeEvents = state.wakeEvents.filter((event) => !state.activeRunId || event.runId === state.activeRunId);
  const activeHoldRecoveryAudits = state.holdRecoveryAudits
    .filter((audit) => !state.activeRunId || audit.runId === state.activeRunId);
  const activeResponsibilitySnapshots = state.responsibilitySnapshots
    .filter((snapshot) => !state.activeRunId || snapshot.runId === state.activeRunId);
  const activeActionCommands = state.actionCommands
    .filter((command) => !state.activeRunId || command.runId === state.activeRunId);
  const activeShadowComparisons = state.shadowComparisons
    .filter((comparison) => !state.activeRunId || comparison.runId === state.activeRunId);
  const activeBlockers = activeResponsibilitySnapshots.flatMap((snapshot) => snapshot.completionBlockers
    .map((blocker) => ({ snapshot, blocker })));

  return (
    <aside className="flex min-h-full min-w-0 flex-col bg-zinc-900/60 [overflow-wrap:anywhere]">
      <div className="border-b border-zinc-800 p-4"><h3 className="text-sm text-violet-200">第 {activeRun?.turnNo ?? '—'} 轮 · 当前查看的任务</h3><p className="mt-1 text-sm text-zinc-300">{activeRun?.goal}</p></div>
      <div className="flex shrink-0 border-b border-zinc-800 text-xs">
        {(
          [
            ['collaboration', '协作'],
            ['tasks', '任务'],
            ['approvals', `审批${pending.length ? ` (${pending.length})` : ''}`],
            ['trace', '轨迹'],
            ['usage', '用量'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-2.5 ${
              tab === key ? 'border-b-2 border-violet-400 text-zinc-100' : 'text-zinc-400 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'collaboration' && <div className="space-y-3 text-xs">
          <RunExecutionDetails />
          {terminalDispositionLabel && <div className={`rounded-lg border px-3 py-2 ${activeRun?.terminalDisposition === 'failed' ? 'border-red-500/20 bg-red-500/5 text-red-300' : activeRun?.terminalDisposition === 'cancelled' ? 'border-amber-500/20 bg-amber-500/5 text-amber-300' : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'}`}><span className="text-zinc-400">本轮终局：</span>{terminalDispositionLabel}</div>}

          {state.coordinationPlan && <>
            <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-2.5">
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-fuchsia-200">执行计划</span><span className={state.coordinationPlan.status === 'failed' ? 'text-red-300' : state.coordinationPlan.status === 'completed' ? 'text-emerald-300' : 'text-sky-300'}>{displayStatus(state.coordinationPlan.status)}</span></div>
              <div className="mt-1 text-xs text-zinc-400">{state.coordinationPlan.protocols.map((item) => displayStatus(item.protocol)).join(' → ')}</div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-fuchsia-400 transition-all" style={{ width: `${state.coordinationSteps.length > 0 ? coordinationCompleted / state.coordinationSteps.length * 100 : 0}%` }} /></div>
              <div className="mt-1 text-right text-xs text-zinc-400">{coordinationCompleted}/{state.coordinationSteps.length} 步</div>
              <p className="mt-2 text-xs text-zinc-400">暂停、恢复和修订请使用聊天中的对应任务卡。</p>
            </div>
            <div className="space-y-1.5">{state.coordinationSteps.map((step) => {
              const definition = state.coordinationPlan?.steps.find((item) => item.id === step.stepId);
              const meta = COORDINATION_STATUS[step.status] ?? COORDINATION_STATUS.pending!;
              return <div key={`${step.revision}:${step.stepId}`} className="rounded-lg bg-zinc-800/60 p-2"><div className="flex items-start gap-2"><span className={meta.color}>{meta.marker}</span><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><span className="truncate text-zinc-300">{definition?.actorRole ?? step.stepId}</span><span className={`shrink-0 ${meta.color}`}>{meta.label}</span></div><div className="mt-0.5 text-xs text-zinc-400">{definition ? STEP_TYPE_LABEL[definition.type] ?? definition.type : step.stepId}{definition?.agentId ? ` · ${definition.agentId}` : ''}{definition?.dependsOn.length ? ` · 等待 ${definition.dependsOn.length} 项` : ''}</div></div></div></div>;
            })}</div>
          </>}
          {state.collaborationScheduler && <div className="rounded-lg bg-violet-500/10 p-2 text-violet-200">房间整体：活跃 {state.collaborationScheduler.activeAgentIds.length} · 排队 {state.collaborationScheduler.queued} · 阻断 {state.collaborationScheduler.blocked}</div>}
          {activeBlockers.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">完成阻断</div>{activeBlockers.map(({ snapshot, blocker }, index) => <div key={`${snapshot.subjectId}:${blocker.code}:${blocker.refId ?? index}`} className={`rounded-lg border p-2 ${blocker.category === 'stale_responsibility' ? 'border-red-500/20 bg-red-500/5' : blocker.category === 'external' ? 'border-amber-500/20 bg-amber-500/5' : 'border-violet-500/20 bg-violet-500/5'}`}><div className="flex justify-between gap-2"><span className="text-zinc-200">{snapshot.subjectKey}</span><span className={blocker.category === 'stale_responsibility' ? 'text-red-300' : blocker.category === 'external' ? 'text-amber-300' : 'text-violet-300'}>{BLOCKER_CATEGORY_LABEL[blocker.category] ?? blocker.category}</span></div><div className="mt-1 text-xs text-zinc-400">{blocker.message}</div><div className="mt-1 text-xs text-zinc-400">{blocker.code}{blocker.refId ? ` · ${blocker.refType}:${blocker.refId.slice(0, 12)}` : ''}</div></div>)}</section>}
          <div className="space-y-2">{activeDispatches.map((dispatch) => <div key={dispatch.id} className="rounded-lg bg-zinc-800/60 p-2"><div className="flex justify-between gap-2"><span className="text-zinc-300">{name(dispatch.from)} → {name(dispatch.targetAgentId)}</span><span className={dispatch.status === 'failed' || dispatch.status === 'blocked' ? 'text-red-300' : dispatch.status === 'running' ? 'text-sky-300' : 'text-zinc-400'}>{displayStatus(dispatch.status)}</span></div><div className="mt-1 text-xs text-zinc-400">{displayStatus(dispatch.kind)} · 深度 {dispatch.depth}{dispatch.reason ? ` · ${dispatch.reason}` : ''}</div>{dispatch.status === 'queued' && <button onClick={() => void api.cancelCollaborationDispatch(dispatch.id)} className="mt-2 text-xs text-red-300">取消排队</button>}{dispatch.status === 'running' && state.activeConversationId && <button onClick={() => void api.stopCollaborationAgent(dispatch.targetAgentId, state.activeConversationId!, dispatch.runId)} className="mt-2 text-xs text-red-300">停止该 Agent</button>}</div>)}</div>
          {activeBatches.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">并行批次</div>{activeBatches.map((batch) => {
            const progress = collaborationBatchProgress(batch, activeDispatches);
            return <div key={batch.id} className="rounded-lg border border-sky-500/10 bg-sky-500/5 p-2"><div className="flex justify-between gap-2"><span className="text-sky-200">{batch.initiatorAgentId} 并行征询 · {displayStatus(batch.joinPolicy)}</span><span className={batch.status === 'failed' || batch.status === 'timeout' ? 'text-red-300' : batch.status === 'completed' ? 'text-emerald-300' : 'text-sky-300'}>{displayStatus(batch.status)}</span></div><div className="mt-1 text-xs text-zinc-400">{progress.terminal}/{progress.total} 已结束 · 版本 {batch.generation} · {batch.targetAgentIds.join('、')}</div>{batch.winnerDispatchId && <div className="mt-1 text-xs text-emerald-300">winner {batch.winnerDispatchId.slice(0, 8)}{batch.settledAt ? ` · ${batch.settledAt}` : ''}</div>}<div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full rounded bg-sky-400" style={{ width: `${progress.percent}%` }} /></div><div className="mt-1 truncate text-xs text-zinc-400" title={batch.question}>{batch.question}</div></div>;
          })}</section>}
          {activeAttempts.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">执行尝试</div>{activeAttempts.slice().reverse().map((attempt) => { const tone = collaborationAttemptTone(attempt); return <details key={attempt.id} open={tone === 'active' || tone === 'danger'} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2"><span className="text-zinc-300">{name(attempt.agentId)} · 尝试 {attempt.attemptNo}</span><span className={tone === 'success' ? 'text-emerald-300' : tone === 'active' ? 'text-sky-300' : tone === 'danger' ? 'text-red-300' : 'text-zinc-400'}>{displayStatus(attempt.status)}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs"><div className="text-zinc-400">调度记录 {attempt.dispatchId.slice(0, 8)}</div>{attempt.deduplicatedTo && <div className="text-amber-300">已去重到 {attempt.deduplicatedTo.slice(0, 8)}</div>}{attempt.output && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/70 p-2 text-zinc-400">{attempt.output}</pre>}{attempt.error && <div className="rounded bg-red-500/10 p-2 text-red-300">{attempt.error}</div>}{attempt.inputContext && <details><summary className="cursor-pointer text-zinc-400">查看输入上下文</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/70 p-2 text-zinc-400">{attempt.inputContext}</pre></details>}</div></details>; })}</section>}
          <details><summary className="cursor-pointer py-2 text-zinc-300">技术诊断与审计记录</summary><div className="mt-2 space-y-3">
          {activeActionCommands.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">原子动作</div>{activeActionCommands.slice().reverse().map((command) => <div key={command.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><div className="flex justify-between gap-2"><span className="text-zinc-300">{ACTION_COMMAND_LABEL[command.kind] ?? command.kind}</span><span className="text-emerald-300">已提交</span></div><div className="mt-1 text-xs text-zinc-400">{command.attemptId ? `Attempt ${command.attemptId.slice(0, 8)}` : 'Run 级动作'} · {command.committedAt}</div></div>)}</section>}
          {activeShadowComparisons.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">Shadow 对比</div>{activeShadowComparisons.slice().reverse().map((comparison) => <details key={comparison.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2"><span className="text-zinc-300">{comparison.actionType} · Attempt {comparison.attemptId.slice(0, 8)}</span><span className={comparison.classification === 'match' ? 'text-emerald-300' : comparison.classification === 'projection_only' ? 'text-sky-300' : comparison.classification === 'observer_error' ? 'text-red-300' : 'text-amber-300'}>{SHADOW_CLASSIFICATION_LABEL[comparison.classification] ?? comparison.classification}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400"><div>legacy：{comparison.legacyOutcome} · runtime：{comparison.runtimeOutcome}</div><div>{comparison.reasons.join(' · ')}</div><div className="text-xs text-zinc-400">output {comparison.outputSha256.slice(0, 12)}{comparison.snapshotFingerprint ? ` · snapshot ${comparison.snapshotFingerprint.slice(0, 12)}` : ''}{comparison.generation !== null ? ` · g${comparison.generation}` : ''}</div></div></details>)}</section>}
          {activeCandidates.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">完成候选</div>{activeCandidates.slice().reverse().map((candidate) => <details key={candidate.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2"><span className="text-zinc-300">{candidate.agentId} · 版本 {candidate.generation}</span><span className={candidate.status === 'accepted' ? 'text-emerald-300' : candidate.status === 'rejected' ? 'text-red-300' : candidate.status === 'superseded' ? 'text-amber-300' : 'text-sky-300'}>{candidate.status}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs"><div className="text-zinc-400">Subject {candidate.subjectKey}</div><div className="text-zinc-400">动作：{candidate.action.type} · ExitGuard：{candidate.exitGuard.status}</div><pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/70 p-2 text-zinc-400">{candidate.summary}</pre>{candidate.exitGuard.reasons.length > 0 && <div className="text-zinc-400">{candidate.exitGuard.reasons.join(' · ')}</div>}{candidate.reasons.length > 0 && <div className="text-amber-300">{candidate.reasons.join(' · ')}</div>}{candidate.feedback && <div className="rounded bg-red-500/10 p-2 text-red-300">{candidate.feedback}</div>}</div></details>)}</section>}
          {activeObligations.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">后继义务</div>{activeObligations.slice().reverse().map((obligation) => <details key={obligation.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2"><span className="text-zinc-300">{obligation.kind} · 版本 {obligation.generation}</span><span className={obligation.status === 'satisfied' ? 'text-emerald-300' : obligation.status === 'open' ? 'text-sky-300' : obligation.status === 'failed' ? 'text-red-300' : 'text-amber-300'}>{obligation.status}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400"><div>stable key：{obligation.stableKey}</div><div>parent：{obligation.parentSubjectId.slice(0, 8)}{obligation.targetSubjectId ? ` · target：${obligation.targetSubjectId.slice(0, 8)}` : ''}</div>{obligation.resolutionSourceId && <div>resolved by：{obligation.resolutionSourceId}</div>}</div></details>)}</section>}
          {activeEvidenceBundles.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">证据包</div>{activeEvidenceBundles.slice().reverse().map((bundle) => <details key={bundle.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2"><span className="text-zinc-300">{bundle.ownerType} · {bundle.refs.length} 项</span><span className={bundle.status === 'valid' ? 'text-emerald-300' : bundle.status === 'drifted' ? 'text-red-300' : 'text-amber-300'}>{bundle.status}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400"><div>fingerprint：{bundle.fingerprint.slice(0, 16)}</div><div>owner：{bundle.ownerId}</div><div>校验时间：{bundle.validatedAt}</div></div></details>)}</section>}
          {activeRouteGuards.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">路由防循环</div>{activeRouteGuards.slice().reverse().map((event) => <div key={event.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2 text-xs"><div className="flex justify-between gap-2"><span className="text-zinc-300">{event.fromAgentId} → {event.targetAgentId} · {event.repeatedCount}</span><span className={event.outcome === 'blocked' ? 'text-red-300' : event.outcome === 'warned' ? 'text-amber-300' : 'text-emerald-300'}>{event.outcome}</span></div>{event.progressDigest && <div className="mt-1 text-xs text-zinc-400">progress {event.progressDigest.digest.slice(0, 12)} · {event.progressDigest.entries.length} 项 · 排除只读重复 {event.progressDigest.excluded.duplicateReadOnlyResults} / 日志 {event.progressDigest.excluded.ordinaryLogs}</div>}{event.reason && <div className="mt-1 text-zinc-400">{event.reason}</div>}</div>)}</section>}
          {activeDurableHolds.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">持久化等待</div>{activeDurableHolds.slice().reverse().map((hold) => <details key={hold.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2 text-xs"><span className="text-zinc-300">v{hold.version} · {hold.condition.kind} · 版本 {hold.generation}</span><span className={hold.status === 'resumed' ? 'text-emerald-300' : hold.status === 'open' || hold.status === 'claimed' ? 'text-sky-300' : hold.status === 'failed' ? 'text-red-300' : 'text-amber-300'}>{hold.status}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-xs text-zinc-400"><div>holder：{hold.holderAgentId}</div><div>恢复策略：{hold.recoveryPolicy.kind}</div>{hold.condition.kind === 'dependency' && <div>依赖：{hold.condition.policy} · {hold.condition.subjectIds.map((id) => id.slice(0, 8)).join('、')}</div>}{hold.condition.kind === 'event' && hold.condition.receiverId && <div>接收器：{hold.condition.receiverId} · g{hold.condition.generation}<br />correlation：{hold.condition.correlationId}</div>}{hold.wakeAt && <div>唤醒：{hold.wakeAt}</div>}{hold.timeoutAt && <div>超时：{hold.timeoutAt} · {hold.onTimeout?.kind ?? 'fail'}</div>}{hold.retryCount > 0 && <div>重试：{hold.retryCount}/{hold.maxRetries}{hold.nextRetryAt ? ` · 下次 ${hold.nextRetryAt}` : ''}</div>}{hold.lastError && <div className="text-red-300">{hold.lastErrorCode ? `${hold.lastErrorCode} · ` : ''}{hold.lastError}</div>}{hold.resumedDispatchId && <div>resume：{hold.resumedDispatchId.slice(0, 8)}</div>}</div></details>)}</section>}
          {activeHoldRecoveryAudits.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">恢复审计</div>{activeHoldRecoveryAudits.slice().reverse().slice(0, 20).map((audit) => <div key={audit.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2 text-xs"><div className="flex justify-between gap-2"><span className="text-zinc-300">{audit.reasonCode} · g{audit.generation}</span><span className={audit.outcome === 'resumed' ? 'text-emerald-300' : audit.outcome === 'failed' ? 'text-red-300' : audit.outcome === 'cancelled' ? 'text-amber-300' : 'text-sky-300'}>{audit.outcome}</span></div><div className="mt-1 text-zinc-400">{audit.reason}</div><div className="mt-1 text-xs text-zinc-400">hold {audit.holdId.slice(0, 8)} · {audit.createdAt}</div></div>)}</section>}
          {activeWakeEvents.length > 0 && <section className="space-y-2"><div className="text-xs font-medium uppercase tracking-wide text-zinc-400">唤醒事件</div>{activeWakeEvents.slice().reverse().slice(0, 12).map((event) => <div key={event.id} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2 text-xs"><div className="flex justify-between gap-2"><span className="text-zinc-300">{event.kind}</span><span className="text-zinc-400">{event.createdAt}</span></div><div className="mt-1 truncate text-zinc-400">{event.sourceKey}</div></div>)}</section>}
          </div></details>
          {!state.coordinationPlan && activeDispatches.length === 0 && <p className="text-zinc-400">当前聊天室暂无协作调度记录</p>}
          {state.activeRunId && state.collaborationBudgets[state.activeRunId] && (() => { const budget = state.collaborationBudgets[state.activeRunId]!; return <div className="rounded-lg border border-zinc-800 p-2 text-xs text-zinc-400"><div className="mb-1 text-zinc-300">本轮预算</div><div>调度次数 {budget.dispatches.used}/{budget.dispatches.currentLimit}</div><div>Token 预算 {budget.tokens.used}/{budget.tokens.currentLimit}</div><div>成本 ${budget.costUsd.used.toFixed(4)}/${budget.costUsd.currentLimit.toFixed(2)}</div><div>累计倍数 {budget.cumulativeMultiplier.toFixed(2)}× / {budget.maxMultiplier}×</div></div>; })()}
        </div>}
        {tab === 'tasks' && (
          <div className="space-y-2">
            {actionError && <p role="alert" className="text-xs text-red-300">{actionError}</p>}
            {state.scheduler && (
              <div className="rounded-md bg-violet-500/10 px-2 py-1.5 text-xs text-violet-300">
                调度中 {state.scheduler.active} · 排队 {state.scheduler.queued}
              </div>
            )}
            {state.coordinationPlan && state.coordinationSteps.map((step) => {
              const definition = state.coordinationPlan?.steps.find((item) => item.id === step.stepId);
              const attempts = state.coordinationAttempts.filter((attempt) => attempt.stepId === step.stepId && attempt.revision === step.revision);
              const meta = COORDINATION_STATUS[step.status] ?? COORDINATION_STATUS.pending!;
              return <details key={`coordination:${step.revision}:${step.stepId}`} open={step.status === 'running' || step.status === 'ready' || step.status === 'failed'} className="rounded-lg border border-fuchsia-500/10 bg-zinc-800/60 p-2.5 text-xs">
                <summary className="cursor-pointer list-none"><div className="flex items-start justify-between gap-2"><span className="text-zinc-200">{definition?.completion ?? step.stepId}</span><span className={meta.color}>{meta.label}</span></div><div className="mt-1 text-xs text-zinc-400">{definition?.actorRole ?? '计划步骤'}{definition?.agentId ? ` · ${definition.agentId}` : ''} · 第 {step.attemptNo}/{definition?.maxAttempts ?? '—'} 次</div></summary>
                <div className="mt-2 space-y-1 border-t border-zinc-700/70 pt-2 text-xs text-zinc-400">
                  <div>{STEP_TYPE_LABEL[definition?.type ?? ''] ?? definition?.type ?? 'Coordination Step'} · {step.stepId}</div>
                  {definition?.dependsOn.length ? <div className="text-zinc-400">依赖：{definition.dependsOn.join('、')}</div> : <div className="text-zinc-400">无前置依赖</div>}
                  {attempts.map((attempt) => { const attemptMeta = COORDINATION_STATUS[attempt.status] ?? COORDINATION_STATUS.pending!; return <div key={attempt.id}><div className={attemptMeta.color}>{attemptMeta.marker} 第 {attempt.attemptNo} · {attemptMeta.label}</div>{attempt.controlAction && <div className="pl-3 text-zinc-400">动作：{attempt.controlAction.type}{attempt.exitGuard ? ` · ExitGuard：${attempt.exitGuard.status}` : ''}</div>}</div>; })}
                  {step.error && <div className="rounded bg-red-500/10 p-1.5 text-red-300">{step.error}</div>}
                  {step.output && <div className="line-clamp-3 whitespace-pre-wrap rounded bg-zinc-950/60 p-1.5 text-zinc-400">{step.output}</div>}
                </div>
              </details>;
            })}
            {legacyTasks.map((task) => {
              const attempts = state.attempts.filter((attempt) => attempt.taskId === task.id);
              const review = state.reviews.filter((item) => item.taskId === task.id).at(-1);
              return (
                <details key={task.id} open={task.status === 'in_progress' || task.status === 'awaiting_review' || task.status === 'needs_revision'} className="rounded-lg bg-zinc-800/60 p-2.5 text-xs">
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-zinc-200">{task.title}</span>
                      <span className={task.status === 'completed' ? 'text-emerald-400' : task.status === 'failed' ? 'text-red-400' : task.status === 'needs_revision' ? 'text-amber-300' : 'text-sky-300'}>
                        {task.status}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">
                      {task.assignee ?? '未指派'} · 第 {task.attempt}/{task.maxAttempts} 次
                      {task.reviewerId && ` · Reviewer ${task.reviewerId}`}
                    </div>
                  </summary>
                  <div className="mt-2 space-y-1 border-t border-zinc-700/70 pt-2 text-xs text-zinc-400">
                    {attempts.map((attempt) => (
                      <div key={attempt.id}>
                        {attempt.status === 'completed' ? '✓' : attempt.status === 'failed' ? '✗' : '◌'}{' '}
                        {attempt.kind === 'review' ? '审查' : '实现'} #{attempt.attemptNo} · {attempt.agentId}
                      </div>
                    ))}
                    {review && (
                      <div className={review.verdict === 'PASS' ? 'text-emerald-400' : 'text-red-400'}>
                        {review.verdict}：{review.summary}
                      </div>
                    )}
                    {task.lastError && <div className="text-red-300">{task.lastError}</div>}
                    <div className="flex gap-2 pt-1">
                      {task.status === 'failed' && activeRun?.mode === 'supervisor' && task.createdBy !== 'system' && (
                        <button disabled={actingTask === task.id} onClick={() => void taskAction(task.id, 'retry')} className="rounded bg-violet-500/20 px-2 py-1 text-violet-200 disabled:opacity-40">
                          人工重试
                        </button>
                      )}
                      {(task.status === 'pending' || task.status === 'needs_revision') && (
                        <button disabled={actingTask === task.id} onClick={() => void taskAction(task.id, 'cancel')} className="rounded bg-red-500/10 px-2 py-1 text-red-300 disabled:opacity-40">
                          取消任务
                        </button>
                      )}
                    </div>
                  </div>
                </details>
              );
            })}
            {!state.coordinationPlan && legacyTasks.length === 0 && <p className="text-xs text-zinc-400">暂无调度任务</p>}
          </div>
        )}
        {tab === 'approvals' && (
          <div className="space-y-3">
            {pending.length === 0 && <p className="text-xs text-zinc-400">暂无待审批项</p>}
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
            {decidedRecent.length > 0 && (
              <details className="pt-1">
                <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-400">
                  最近已决策（{decidedRecent.length}）
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {decidedRecent.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-xs text-zinc-400">
                      <span className="truncate">{a.toolName} · {a.agentId}</span>
                      <span
                        className={
                          a.status === 'approved'
                            ? 'text-emerald-400/80'
                            : a.status === 'expired'
                              ? 'text-amber-400/80'
                              : 'text-red-400/80'
                        }
                      >
                        {DECIDED_LABEL[a.status] ?? a.status}
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {tab === 'trace' && (
          <ol className="space-y-2 border-l border-zinc-800 pl-3">
            {activeEvents.length === 0 && <p className="text-xs text-zinc-400">暂无事件</p>}
            {activeEvents.map((e) => (
              <li key={e.id} className="relative text-xs">
                <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-zinc-600" />
                <span className={SPAN_COLOR[e.spanKind] ?? 'text-zinc-400'}>[{e.spanKind}]</span>{' '}
                <span className="text-zinc-300">{e.name}</span>
                <span className="ml-1 text-zinc-400">
                  {e.status}
                  {e.tokensIn + e.tokensOut > 0 && ` · ${e.tokensIn + e.tokensOut}tok`}
                </span>
              </li>
            ))}
          </ol>
        )}

        {tab === 'usage' && (
          <div className="space-y-2">
            {activeUsage.length === 0 && <p className="text-xs text-zinc-400">暂无用量数据</p>}
            {activeUsage.map((u) => (
              <div key={u.runId} className="rounded-lg bg-zinc-800/60 p-2.5 text-xs">
                <div className="mb-1 truncate text-zinc-400">run {u.runId.slice(0, 8)}</div>
                <div className="grid grid-cols-2 gap-1 text-zinc-300">
                  <span>输入 {u.tokensIn.toLocaleString()} tok</span>
                  <span>输出 {u.tokensOut.toLocaleString()} tok</span>
                  <span>LLM {u.llmCalls} 次</span>
                  <span>工具 {u.toolCalls} 次</span>
                  <span className="col-span-2 text-zinc-400">{u.hasUnknownCost ? '成本未知（CLI 未完整报告）' : `成本 ≈ $${u.costUsd.toFixed(4)}`}{u.hasUnknownTokens ? ' · 以上为已报告用量，部分调用未知' : ''}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
