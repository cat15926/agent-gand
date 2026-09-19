/** 观测工作台：DeepSeek Harness Trajectory 信息架构的多 Agent 适配。 */
import { useEffect, useMemo, useState } from 'react';
import type { Run, RunGraphNode, TraceTreeSummaryNode } from '@agent-gand/shared';
import { useStore } from '../../store';
import { useRunObservability } from '../../hooks/useRunObservability';
import { RunGraphPanel } from '../observe/RunGraphPanel';
import { TrajectoryPanel } from '../observe/TrajectoryPanel';

function flatten(nodes: TraceTreeSummaryNode[]): TraceTreeSummaryNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1_000)}s`;
}

const STATUS_STYLE: Record<Run['status'], string> = {
  pending: 'bg-zinc-500/10 text-zinc-400', running: 'bg-sky-500/10 text-sky-300', awaiting_approval: 'bg-amber-500/10 text-amber-300',
  waiting_for_user: 'bg-orange-500/10 text-orange-300', completed: 'bg-emerald-500/10 text-emerald-300', failed: 'bg-rose-500/10 text-rose-300',
  cancelled: 'bg-zinc-500/10 text-zinc-400',
};

export function ObserveView() {
  const { state } = useStore();
  const [selected, setSelected] = useState<string | null>(state.activeRunId ?? state.runs[0]?.id ?? null);
  const [view, setView] = useState<'trajectory' | 'graph'>('trajectory');
  const [runQuery, setRunQuery] = useState('');
  const [graphFilter, setGraphFilter] = useState<RunGraphNode | null>(null);
  const [highlightedGraphNode, setHighlightedGraphNode] = useState<RunGraphNode | null>(null);
  const selectedRun = state.runs.find((run) => run.id === selected) ?? null;
  const live = Boolean(selectedRun && !['completed', 'failed'].includes(selectedRun.status));
  const { data: observation, loading, error, liveDeltas, refresh } = useRunObservability(selected, live);

  useEffect(() => {
    if (!selected && state.runs.length > 0) setSelected(state.activeRunId ?? state.runs[0]!.id);
  }, [selected, state.activeRunId, state.runs]);

  useEffect(() => { setGraphFilter(null); setHighlightedGraphNode(null); }, [selected]);

  const rows = useMemo(() => observation ? flatten(observation.trace.roots) : [], [observation]);
  const metrics = useMemo(() => {
    const starts = rows.map((node) => new Date(node.span.startedAt).getTime());
    const ends = rows.map((node) => new Date(node.span.endedAt ?? node.span.startedAt).getTime());
    return {
      duration: rows.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0,
      tokens: rows.reduce((sum, node) => sum + node.span.tokensIn + node.span.tokensOut, 0),
      cost: rows.reduce((sum, node) => sum + node.span.costUsd, 0),
      errors: rows.filter((node) => node.span.status === 'error').length,
      agents: new Set(rows.map((node) => node.span.attributes['agent.id']).filter((value): value is string => typeof value === 'string')).size,
    };
  }, [rows]);
  const normalizedQuery = runQuery.trim().toLowerCase();
  const visibleRuns = state.runs.filter((run) => normalizedQuery === '' || `${run.title ?? ''} ${run.goal} ${run.mode} ${run.status} ${run.id}`.toLowerCase().includes(normalizedQuery));

  return <div className="flex h-full overflow-hidden bg-[#0b0b0d]">
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-800 bg-[#0f0f12]">
      <div className="border-b border-zinc-800 p-3"><div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-medium text-zinc-200">运行观测</h2><span className="text-[10px] text-zinc-600">{state.runs.length} Runs</span></div><input type="search" value={runQuery} onChange={(event) => setRunQuery(event.target.value)} placeholder="搜索运行…" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 outline-none placeholder:text-zinc-700 focus:border-violet-500/50" /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{visibleRuns.map((run) => <button key={run.id} type="button" onClick={() => setSelected(run.id)} className={`mb-1.5 w-full rounded-xl border p-3 text-left transition-colors ${selected === run.id ? 'border-violet-500/40 bg-violet-500/10' : 'border-transparent bg-zinc-900/60 hover:border-zinc-800 hover:bg-zinc-900'}`}><div className="mb-1.5 flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-zinc-600">#{run.turnNo} · {run.id.slice(0, 8)}</span><span className={`rounded-full px-2 py-0.5 text-[9px] ${STATUS_STYLE[run.status]}`}>{run.status}</span></div><div className="line-clamp-2 text-xs leading-5 text-zinc-300">{run.title ?? run.goal}</div><div className="mt-1.5 flex items-center justify-between text-[10px] text-zinc-600"><span>{run.mode}</span><span>{new Date(run.createdAt).toLocaleString()}</span></div></button>)}{visibleRuns.length === 0 && <p className="px-2 py-10 text-center text-xs text-zinc-600">没有匹配的运行</p>}</div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {!selectedRun && <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">选择左侧运行查看执行轨迹</div>}
      {selectedRun && <>
        <header className="shrink-0 border-b border-zinc-800 bg-[#111114] px-5 py-3"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="mb-1 flex items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS_STYLE[selectedRun.status]}`}>{selectedRun.status}</span><span className="text-[10px] uppercase tracking-wider text-zinc-600">{selectedRun.mode} · Turn {selectedRun.turnNo}</span>{live && <span className="flex items-center gap-1 text-[10px] text-sky-300"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />实时</span>}</div><h1 className="max-w-3xl truncate text-sm font-medium text-zinc-100" title={selectedRun.goal}>{selectedRun.title ?? selectedRun.goal}</h1></div><div className="flex items-center gap-2"><div className="flex rounded-lg bg-zinc-950 p-1 text-xs"><button type="button" onClick={() => setView('trajectory')} className={`rounded-md px-3 py-1.5 ${view === 'trajectory' ? 'bg-violet-500/20 text-violet-200' : 'text-zinc-500 hover:text-zinc-300'}`}>执行轨迹</button><button type="button" onClick={() => setView('graph')} className={`rounded-md px-3 py-1.5 ${view === 'graph' ? 'bg-violet-500/20 text-violet-200' : 'text-zinc-500 hover:text-zinc-300'}`}>编排拓扑</button></div><button type="button" onClick={refresh} disabled={loading} className="rounded-lg border border-zinc-800 px-2.5 py-2 text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-50" title="刷新观测数据">↻</button></div></div>
          {observation && <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">{[['总耗时', formatDuration(metrics.duration)], ['Span', String(observation.trace.totalSpans)], ['Agent', String(metrics.agents)], ['Token', metrics.tokens.toLocaleString()], ['成本', `$${metrics.cost.toFixed(4)}`], ['错误', String(metrics.errors)]].map(([label, value]) => <div key={label} className={`rounded-lg border px-3 py-2 ${label === '错误' && metrics.errors > 0 ? 'border-rose-500/30 bg-rose-500/5' : 'border-zinc-800 bg-zinc-950/50'}`}><div className="text-[9px] uppercase tracking-wider text-zinc-600">{label}</div><div className={`mt-0.5 font-mono text-xs ${label === '错误' && metrics.errors > 0 ? 'text-rose-300' : 'text-zinc-300'}`}>{value}</div></div>)}</div>}
        </header>
        {loading && !observation && <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">正在加载轨迹…</div>}
        {error && <div className="m-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">观测数据加载失败：{error}</div>}
        {observation && view === 'trajectory' && <TrajectoryPanel key={selectedRun.id} runId={selectedRun.id} trace={observation.trace} groups={observation.groups} live={live} liveDeltas={liveDeltas} graphFilter={graphFilter} onSpanEntitySelect={(nodeId) => setHighlightedGraphNode(observation.graph.nodes.find((node) => node.id === nodeId) ?? null)} onClearGraphFilter={() => setGraphFilter(null)} />}
        {observation && view === 'graph' && <RunGraphPanel graph={observation.graph} selectedNodeId={highlightedGraphNode?.id ?? null} onSelectNode={(node) => { setHighlightedGraphNode(node); setGraphFilter(node); if (node) setView('trajectory'); }} />}
      </>}
    </main>
  </div>;
}
