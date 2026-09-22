/**
 * 右侧面板：审批队列 / Trace 时间线 / 用量（对应报告模式 5 / 4）
 */
import { useState } from 'react';
import { useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import * as api from '../services/api';
import { canStopCollaborationRun, collaborationAttemptTone, collaborationBatchProgress } from '../collaborationView';

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
  pending: { label: '等待依赖', color: 'text-zinc-500', marker: '○' },
  ready: { label: '已就绪', color: 'text-violet-300', marker: '◇' },
  running: { label: '运行中', color: 'text-sky-300', marker: '◌' },
  completed: { label: '已完成', color: 'text-emerald-400', marker: '✓' },
  failed: { label: '失败', color: 'text-red-400', marker: '✗' },
  interrupted: { label: '已中断', color: 'text-amber-300', marker: '!' },
};

const STEP_TYPE_LABEL: Record<string, string> = {
  agent_turn: 'Agent 执行', fanout: '并行分支', aggregate: '汇总', review: '独立审查', completion_gate: '完成屏障',
};

export function RightPanel() {
  const { state, refreshConversation } = useStore();
  const [tab, setTab] = useState<'collaboration' | 'tasks' | 'approvals' | 'trace' | 'usage'>('collaboration');
  const [actingTask, setActingTask] = useState<string | null>(null);
  const [stoppingRun, setStoppingRun] = useState(false);
  const [coordinationAction, setCoordinationAction] = useState(false);
  const [revisionInstruction, setRevisionInstruction] = useState('');

  async function taskAction(taskId: string, action: 'retry' | 'cancel') {
    setActingTask(taskId);
    try {
      if (action === 'retry') await api.retryTask(taskId);
      else await api.cancelTask(taskId);
    } finally {
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
  const activeBatches = state.collaborationBatches.filter((batch) => !state.activeRunId || batch.runId === state.activeRunId);
  const activeAttempts = state.collaborationAttempts.filter((attempt) => !state.activeRunId || attempt.runId === state.activeRunId);

  async function stopRun() {
    if (!activeRun || stoppingRun || !window.confirm('停止本轮协作？正在运行和排队的工作都会取消。')) return;
    setStoppingRun(true);
    try { await api.stopCollaborationRun(activeRun.id); await refreshConversation(); }
    finally { setStoppingRun(false); }
  }

  async function pausePlan() {
    if (!activeRun || coordinationAction) return;
    setCoordinationAction(true);
    try { await api.pauseCoordinationRun(activeRun.id); await refreshConversation(); }
    finally { setCoordinationAction(false); }
  }

  async function resumePlan() {
    if (!activeRun || coordinationAction) return;
    setCoordinationAction(true);
    try { await api.resumeCoordinationRun(activeRun.id); await refreshConversation(); }
    finally { setCoordinationAction(false); }
  }

  async function revisePlan() {
    if (!activeRun || coordinationAction || !revisionInstruction.trim()) return;
    setCoordinationAction(true);
    try { await api.reviseCoordinationRun(activeRun.id, revisionInstruction.trim()); setRevisionInstruction(''); await refreshConversation(); }
    finally { setCoordinationAction(false); }
  }

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/60">
      <div className="flex shrink-0 border-b border-zinc-800 text-xs">
        {(
          [
            ['collaboration', '协作'],
            ['tasks', '任务'],
            ['approvals', `审批${pending.length ? ` (${pending.length})` : ''}`],
            ['trace', 'Trace'],
            ['usage', '用量'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-2.5 ${
              tab === key ? 'border-b-2 border-violet-400 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'collaboration' && <div className="space-y-3 text-xs">
          {!state.coordinationPlan && canStopCollaborationRun(activeRun) && <button disabled={stoppingRun} onClick={() => void stopRun()} className="w-full rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-left text-red-300 disabled:opacity-50">{stoppingRun ? '正在停止…' : '停止本轮协作'}</button>}
          {state.coordinationPlan && <>
            <div className="rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-2.5">
              <div className="flex items-center justify-between gap-2"><span className="font-medium text-fuchsia-200">Coordination Plan</span><span className={state.coordinationPlan.status === 'failed' ? 'text-red-300' : state.coordinationPlan.status === 'completed' ? 'text-emerald-300' : 'text-sky-300'}>{state.coordinationPlan.status}</span></div>
              <div className="mt-1 text-[11px] text-zinc-500">{state.coordinationPlan.protocols.map((item) => item.protocol).join(' → ')}</div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full bg-fuchsia-400 transition-all" style={{ width: `${state.coordinationSteps.length > 0 ? coordinationCompleted / state.coordinationSteps.length * 100 : 0}%` }} /></div>
              <div className="mt-1 text-right text-[10px] text-zinc-600">{coordinationCompleted}/{state.coordinationSteps.length} 步</div>
              <div className="mt-2 flex gap-2">
                {['validated', 'active'].includes(state.coordinationPlan.status) && <button disabled={coordinationAction} onClick={() => void pausePlan()} className="rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 disabled:opacity-40">暂停并调整</button>}
                {state.coordinationPlan.status === 'pause_requested' && <span className="text-[11px] text-amber-300">将在当前步骤批次结束后暂停</span>}
                {state.coordinationPlan.status === 'paused' && <button disabled={coordinationAction} onClick={() => void resumePlan()} className="rounded bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-40">直接恢复</button>}
              </div>
              {state.coordinationPlan.status === 'paused' && <div className="mt-2 space-y-2"><textarea value={revisionInstruction} onChange={(event) => setRevisionInstruction(event.target.value)} rows={2} placeholder="用自然语言调整后续计划…" className="w-full rounded bg-zinc-950/70 p-2 text-[11px] text-zinc-300 outline-none ring-1 ring-zinc-700 focus:ring-fuchsia-500" /><button disabled={coordinationAction || !revisionInstruction.trim()} onClick={() => void revisePlan()} className="rounded bg-fuchsia-500/20 px-2 py-1 text-[11px] text-fuchsia-200 disabled:opacity-40">生成新 Revision</button></div>}
            </div>
            <div className="space-y-1.5">{state.coordinationSteps.map((step) => {
              const definition = state.coordinationPlan?.steps.find((item) => item.id === step.stepId);
              const meta = COORDINATION_STATUS[step.status] ?? COORDINATION_STATUS.pending!;
              return <div key={`${step.revision}:${step.stepId}`} className="rounded-lg bg-zinc-800/60 p-2"><div className="flex items-start gap-2"><span className={meta.color}>{meta.marker}</span><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><span className="truncate text-zinc-300">{definition?.actorRole ?? step.stepId}</span><span className={`shrink-0 ${meta.color}`}>{meta.label}</span></div><div className="mt-0.5 text-[10px] text-zinc-600">{definition ? STEP_TYPE_LABEL[definition.type] ?? definition.type : step.stepId}{definition?.agentId ? ` · ${definition.agentId}` : ''}{definition?.dependsOn.length ? ` · 等待 ${definition.dependsOn.length} 项` : ''}</div></div></div></div>;
            })}</div>
          </>}
          {state.collaborationScheduler && <div className="rounded-lg bg-violet-500/10 p-2 text-violet-200">活跃 {state.collaborationScheduler.activeAgentIds.length} · 排队 {state.collaborationScheduler.queued} · 阻断 {state.collaborationScheduler.blocked}</div>}
          <div className="space-y-2">{state.collaborationDispatches.map((dispatch) => <div key={dispatch.id} className="rounded-lg bg-zinc-800/60 p-2"><div className="flex justify-between gap-2"><span className="text-zinc-300">{dispatch.from} → {dispatch.targetAgentId}</span><span className={dispatch.status === 'failed' || dispatch.status === 'blocked' ? 'text-red-300' : dispatch.status === 'running' ? 'text-sky-300' : 'text-zinc-500'}>{dispatch.status}</span></div><div className="mt-1 text-[11px] text-zinc-500">{dispatch.kind} · 深度 {dispatch.depth}{dispatch.reason ? ` · ${dispatch.reason}` : ''}</div>{dispatch.status === 'queued' && <button onClick={() => void api.cancelCollaborationDispatch(dispatch.id)} className="mt-2 text-[11px] text-red-300">取消排队</button>}{dispatch.status === 'running' && state.activeConversationId && <button onClick={() => void api.stopCollaborationAgent(dispatch.targetAgentId, state.activeConversationId!)} className="mt-2 text-[11px] text-red-300">停止该 Agent</button>}</div>)}</div>
          {activeBatches.length > 0 && <section className="space-y-2"><div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">并行批次</div>{activeBatches.map((batch) => {
            const progress = collaborationBatchProgress(batch, state.collaborationDispatches);
            return <div key={batch.id} className="rounded-lg border border-sky-500/10 bg-sky-500/5 p-2"><div className="flex justify-between gap-2"><span className="text-sky-200">{batch.initiatorAgentId} 并行征询</span><span className={batch.status === 'failed' || batch.status === 'timeout' ? 'text-red-300' : batch.status === 'completed' ? 'text-emerald-300' : 'text-sky-300'}>{batch.status}</span></div><div className="mt-1 text-[11px] text-zinc-500">{progress.terminal}/{progress.total} 已结束 · {batch.targetAgentIds.join('、')}</div><div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full rounded bg-sky-400" style={{ width: `${progress.percent}%` }} /></div><div className="mt-1 truncate text-[11px] text-zinc-600" title={batch.question}>{batch.question}</div></div>;
          })}</section>}
          {activeAttempts.length > 0 && <section className="space-y-2"><div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">执行尝试</div>{activeAttempts.slice().reverse().map((attempt) => { const tone = collaborationAttemptTone(attempt); return <details key={attempt.id} open={tone === 'active' || tone === 'danger'} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2"><summary className="cursor-pointer list-none"><div className="flex justify-between gap-2"><span className="text-zinc-300">{attempt.agentId} · Attempt #{attempt.attemptNo}</span><span className={tone === 'success' ? 'text-emerald-300' : tone === 'active' ? 'text-sky-300' : tone === 'danger' ? 'text-red-300' : 'text-zinc-500'}>{attempt.status}</span></div></summary><div className="mt-2 space-y-1 border-t border-zinc-800 pt-2 text-[11px]"><div className="text-zinc-600">Dispatch {attempt.dispatchId.slice(0, 8)}</div>{attempt.deduplicatedTo && <div className="text-amber-300">已去重到 {attempt.deduplicatedTo.slice(0, 8)}</div>}{attempt.output && <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/70 p-2 text-zinc-400">{attempt.output}</pre>}{attempt.error && <div className="rounded bg-red-500/10 p-2 text-red-300">{attempt.error}</div>}{attempt.inputContext && <details><summary className="cursor-pointer text-zinc-600">查看输入上下文</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950/70 p-2 text-zinc-500">{attempt.inputContext}</pre></details>}</div></details>; })}</section>}
          {!state.coordinationPlan && state.collaborationDispatches.length === 0 && <p className="text-zinc-600">当前聊天室暂无 Collaboration 调度记录</p>}
          {state.activeRunId && state.collaborationBudgets[state.activeRunId] && (() => { const budget = state.collaborationBudgets[state.activeRunId]!; return <div className="rounded-lg border border-zinc-800 p-2 text-[11px] text-zinc-500"><div className="mb-1 text-zinc-300">本轮预算</div><div>Dispatch {budget.dispatches.used}/{budget.dispatches.currentLimit}</div><div>Token {budget.tokens.used}/{budget.tokens.currentLimit}</div><div>成本 ${budget.costUsd.used.toFixed(4)}/${budget.costUsd.currentLimit.toFixed(2)}</div><div>累计倍数 {budget.cumulativeMultiplier.toFixed(2)}× / {budget.maxMultiplier}×</div></div>; })()}
        </div>}
        {tab === 'tasks' && (
          <div className="space-y-2">
            {state.scheduler && (
              <div className="rounded-md bg-violet-500/10 px-2 py-1.5 text-[11px] text-violet-300">
                调度中 {state.scheduler.active} · 排队 {state.scheduler.queued}
              </div>
            )}
            {state.coordinationPlan && state.coordinationSteps.map((step) => {
              const definition = state.coordinationPlan?.steps.find((item) => item.id === step.stepId);
              const attempts = state.coordinationAttempts.filter((attempt) => attempt.stepId === step.stepId && attempt.revision === step.revision);
              const meta = COORDINATION_STATUS[step.status] ?? COORDINATION_STATUS.pending!;
              return <details key={`coordination:${step.revision}:${step.stepId}`} open={step.status === 'running' || step.status === 'ready' || step.status === 'failed'} className="rounded-lg border border-fuchsia-500/10 bg-zinc-800/60 p-2.5 text-xs">
                <summary className="cursor-pointer list-none"><div className="flex items-start justify-between gap-2"><span className="text-zinc-200">{definition?.completion ?? step.stepId}</span><span className={meta.color}>{meta.label}</span></div><div className="mt-1 text-[11px] text-zinc-500">{definition?.actorRole ?? '计划步骤'}{definition?.agentId ? ` · ${definition.agentId}` : ''} · 第 {step.attemptNo}/{definition?.maxAttempts ?? '—'} 次</div></summary>
                <div className="mt-2 space-y-1 border-t border-zinc-700/70 pt-2 text-[11px] text-zinc-400">
                  <div>{STEP_TYPE_LABEL[definition?.type ?? ''] ?? definition?.type ?? 'Coordination Step'} · {step.stepId}</div>
                  {definition?.dependsOn.length ? <div className="text-zinc-500">依赖：{definition.dependsOn.join('、')}</div> : <div className="text-zinc-600">无前置依赖</div>}
                  {attempts.map((attempt) => { const attemptMeta = COORDINATION_STATUS[attempt.status] ?? COORDINATION_STATUS.pending!; return <div key={attempt.id} className={attemptMeta.color}>{attemptMeta.marker} Attempt #{attempt.attemptNo} · {attemptMeta.label}</div>; })}
                  {step.error && <div className="rounded bg-red-500/10 p-1.5 text-red-300">{step.error}</div>}
                  {step.output && <div className="line-clamp-3 whitespace-pre-wrap rounded bg-zinc-950/60 p-1.5 text-zinc-500">{step.output}</div>}
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
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {task.assignee ?? '未指派'} · 第 {task.attempt}/{task.maxAttempts} 次
                      {task.reviewerId && ` · Reviewer ${task.reviewerId}`}
                    </div>
                  </summary>
                  <div className="mt-2 space-y-1 border-t border-zinc-700/70 pt-2 text-[11px] text-zinc-400">
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
                      {task.status === 'failed' && (
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
            {!state.coordinationPlan && legacyTasks.length === 0 && <p className="text-xs text-zinc-600">暂无调度任务</p>}
          </div>
        )}
        {tab === 'approvals' && (
          <div className="space-y-3">
            {pending.length === 0 && <p className="text-xs text-zinc-600">暂无待审批项</p>}
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
            {decidedRecent.length > 0 && (
              <details className="pt-1">
                <summary className="cursor-pointer text-[11px] text-zinc-600 hover:text-zinc-400">
                  最近已决策（{decidedRecent.length}）
                </summary>
                <ul className="mt-1.5 space-y-1">
                  {decidedRecent.map((a) => (
                    <li key={a.id} className="flex items-center justify-between text-[11px] text-zinc-500">
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
            {state.events.length === 0 && <p className="text-xs text-zinc-600">暂无事件</p>}
            {state.events.map((e) => (
              <li key={e.id} className="relative text-xs">
                <span className="absolute -left-[17px] top-1.5 h-2 w-2 rounded-full bg-zinc-600" />
                <span className={SPAN_COLOR[e.spanKind] ?? 'text-zinc-400'}>[{e.spanKind}]</span>{' '}
                <span className="text-zinc-300">{e.name}</span>
                <span className="ml-1 text-zinc-600">
                  {e.status}
                  {e.tokensIn + e.tokensOut > 0 && ` · ${e.tokensIn + e.tokensOut}tok`}
                </span>
              </li>
            ))}
          </ol>
        )}

        {tab === 'usage' && (
          <div className="space-y-2">
            {state.usage.length === 0 && <p className="text-xs text-zinc-600">暂无用量数据</p>}
            {state.usage.map((u) => (
              <div key={u.runId} className="rounded-lg bg-zinc-800/60 p-2.5 text-xs">
                <div className="mb-1 truncate text-zinc-400">run {u.runId.slice(0, 8)}</div>
                <div className="grid grid-cols-2 gap-1 text-zinc-300">
                  <span>输入 {u.tokensIn.toLocaleString()} tok</span>
                  <span>输出 {u.tokensOut.toLocaleString()} tok</span>
                  <span>LLM {u.llmCalls} 次</span>
                  <span>工具 {u.toolCalls} 次</span>
                  <span className="col-span-2 text-zinc-500">成本 ≈ ${u.costUsd.toFixed(4)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
