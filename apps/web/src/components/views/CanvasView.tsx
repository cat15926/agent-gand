import { useEffect, useMemo, useState } from 'react';
import type { RunGraphNode } from '@agent-gand/shared';
import { useStore } from '../../store';
import { useRunObservability } from '../../hooks/useRunObservability';
import { RunGraphPanel } from '../observe/RunGraphPanel';

export function CanvasView() {
  const { state } = useStore();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(state.activeRunId ?? state.runs[0]?.id ?? null);
  const [selectedNode, setSelectedNode] = useState<RunGraphNode | null>(null);
  const [query, setQuery] = useState('');
  const run = state.runs.find((item) => item.id === selectedRunId) ?? null;
  const live = Boolean(run && !['completed', 'failed'].includes(run.status));
  const { data, loading, error, refresh } = useRunObservability(selectedRunId, live);
  useEffect(() => {
    if (!selectedRunId && state.runs.length > 0) setSelectedRunId(state.activeRunId ?? state.runs[0]!.id);
  }, [selectedRunId, state.activeRunId, state.runs]);
  useEffect(() => setSelectedNode(null), [selectedRunId]);
  const normalized = query.trim().toLowerCase();
  const runs = useMemo(() => state.runs.filter((item) => normalized === '' || `${item.title ?? ''} ${item.goal} ${item.mode} ${item.status}`.toLowerCase().includes(normalized)), [normalized, state.runs]);

  return <div className="flex h-full overflow-hidden bg-[#0b0b0d]">
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-[#0f0f12] max-md:w-48">
      <div className="border-b border-zinc-800 p-3"><h2 className="mb-2 text-sm font-medium text-zinc-200">编排画布</h2><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Run…" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-300 outline-none focus:border-violet-500/50" /></div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">{runs.map((item) => <button key={item.id} type="button" onClick={() => setSelectedRunId(item.id)} className={`mb-1.5 w-full rounded-xl border p-3 text-left ${item.id === selectedRunId ? 'border-violet-500/40 bg-violet-500/10' : 'border-transparent bg-zinc-900/60 hover:border-zinc-800'}`}><div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-zinc-600">#{item.turnNo} · {item.mode}</span><span className={`h-2 w-2 rounded-full ${item.status === 'failed' ? 'bg-rose-400' : item.status === 'completed' ? 'bg-emerald-400' : 'animate-pulse bg-sky-400'}`} /></div><div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-300">{item.title ?? item.goal}</div></button>)}</div>
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      {run && <header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 bg-[#111114] px-4 py-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className="rounded bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-300">{run.mode}</span><span className="text-[10px] text-zinc-600">{run.status}</span>{live && <span className="flex items-center gap-1 text-[10px] text-sky-300"><i className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-300" />实时</span>}</div><h1 className="mt-1 truncate text-sm text-zinc-100">{run.title ?? run.goal}</h1></div><button type="button" onClick={refresh} disabled={loading} className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-50">刷新</button></header>}
      {!run && <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">选择一个 Run 查看编排拓扑</div>}
      {run && loading && !data && <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">正在生成拓扑…</div>}
      {error && <div className="m-4 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 text-sm text-rose-300">拓扑加载失败：{error}</div>}
      {data && <RunGraphPanel graph={data.graph} selectedNodeId={selectedNode?.id ?? null} onSelectNode={setSelectedNode} />}
      {selectedNode && <div className="shrink-0 border-t border-violet-500/20 bg-violet-500/5 px-4 py-2 text-xs text-zinc-400"><span className="text-violet-300">已选 {selectedNode.kind}</span> · {selectedNode.label} · <span className="font-mono text-zinc-600">{selectedNode.entityId}</span></div>}
    </main>
  </div>;
}
