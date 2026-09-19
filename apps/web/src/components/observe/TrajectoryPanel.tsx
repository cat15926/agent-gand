import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type {
  RunEvent, RunGraphNode, SpanKind, SpanStatus, TraceTreeSummary, TraceTreeSummaryNode, TrajectoryGroup,
} from '@agent-gand/shared';
import * as api from '../../services/api';

const KINDS: SpanKind[] = ['orchestration', 'agent', 'llm', 'tool', 'approval', 'message'];
const STATUSES: SpanStatus[] = ['running', 'ok', 'error'];
const KIND_META: Record<SpanKind, { label: string; dot: string; badge: string; bar: string }> = {
  orchestration: { label: '编排', dot: 'bg-emerald-400', badge: 'bg-emerald-500/10 text-emerald-300', bar: 'bg-emerald-400' },
  agent: { label: 'Agent', dot: 'bg-violet-400', badge: 'bg-violet-500/10 text-violet-300', bar: 'bg-violet-400' },
  llm: { label: '模型', dot: 'bg-sky-400', badge: 'bg-sky-500/10 text-sky-300', bar: 'bg-sky-400' },
  tool: { label: '工具', dot: 'bg-amber-400', badge: 'bg-amber-500/10 text-amber-300', bar: 'bg-amber-400' },
  approval: { label: '审批', dot: 'bg-rose-400', badge: 'bg-rose-500/10 text-rose-300', bar: 'bg-rose-400' },
  message: { label: '消息', dot: 'bg-zinc-400', badge: 'bg-zinc-500/10 text-zinc-300', bar: 'bg-zinc-400' },
};
const STATUS_META: Record<SpanStatus, { label: string; color: string }> = {
  running: { label: '运行中', color: 'text-sky-300' }, ok: { label: '成功', color: 'text-emerald-300' }, error: { label: '失败', color: 'text-rose-300' },
};

interface FlatSpan { node: TraceTreeSummaryNode; ancestors: string[] }
interface DomainRange { start: number; end: number; mode: 'time' | 'sequence' }
type LedgerEntry = { type: 'group'; group: TrajectoryGroup; count: number } | { type: 'span'; row: FlatSpan };

function flattenTrace(nodes: TraceTreeSummaryNode[], ancestors: string[] = []): FlatSpan[] {
  return nodes.flatMap((node) => [{ node, ancestors }, ...flattenTrace(node.children, [...ancestors, node.span.id])]);
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '进行中';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round(ms % 60_000 / 1_000)}s`;
}

function formatClock(value: string | number): string {
  const date = new Date(value);
  const base = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${base}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function pretty(value: string | null): string {
  if (!value) return '—';
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function matchesGraphNode(node: TraceTreeSummaryNode, graphNode: RunGraphNode | null): boolean {
  if (!graphNode || graphNode.kind === 'run') return true;
  const key = graphNode.kind === 'agent' ? 'agent.id' : graphNode.kind === 'task' ? 'task.id' : graphNode.kind === 'coordination_step' ? 'coordination.step.id' : 'approval.id';
  return node.span.attributes[key] === graphNode.entityId;
}

function graphNodeIdForSpan(runId: string, node: TraceTreeSummaryNode): string {
  const attributes = node.span.attributes;
  if (typeof attributes['approval.id'] === 'string') return `approval:${attributes['approval.id']}`;
  if (typeof attributes['coordination.step.id'] === 'string') return `coordination_step:${attributes['coordination.step.id']}`;
  if (typeof attributes['task.id'] === 'string') return `task:${attributes['task.id']}`;
  if (typeof attributes['agent.id'] === 'string') return `agent:${attributes['agent.id']}`;
  return `run:${runId}`;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="rounded-md border border-zinc-700 px-2 py-1 text-[10px] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200" onClick={() => {
    void navigator.clipboard.writeText(value).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1_200); });
  }}>{copied ? '已复制' : '复制'}</button>;
}

function SpanInspector({ runId, summary, liveText, onClose }: { runId: string; summary: TraceTreeSummaryNode; liveText: string; onClose: () => void }) {
  const [detail, setDetail] = useState<RunEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'summary' | 'input' | 'output' | 'attributes' | 'timing' | 'usage'>('summary');
  const [width, setWidth] = useState(410);
  const resize = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let active = true; setLoading(true); setError(null); setDetail(null);
    void api.getSpanDetail(runId, summary.span.id)
      .then((value) => { if (active) setDetail(value); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [runId, summary.span.endedAt, summary.span.id]);
  useEffect(() => { window.requestAnimationFrame(() => closeRef.current?.focus()); }, [summary.span.id]);
  const span = detail ? { ...detail, ...summary.span, input: detail.input, output: detail.output } : summary.span;
  const ttft = span.firstTokenAt ? new Date(span.firstTokenAt).getTime() - new Date(span.startedAt).getTime() : null;
  const decoding = span.firstTokenAt && span.endedAt ? new Date(span.endedAt).getTime() - new Date(span.firstTokenAt).getTime() : null;
  const tabs = ['summary', 'input', 'output', 'attributes', 'timing', 'usage'] as const;
  const output = detail?.output ?? (liveText || null);
  const content = tab === 'input' ? pretty(detail?.input ?? null) : tab === 'output' ? pretty(output) : JSON.stringify(span.attributes, null, 2);
  return <><button type="button" aria-label="关闭详情遮罩" onClick={onClose} className="absolute inset-0 z-20 hidden bg-black/45 max-xl:block" />
    <aside role="dialog" aria-label={`Span 详情：${span.name}`} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }} style={{ width: `min(92vw, ${width}px)` }} className="relative z-30 flex min-w-[340px] max-w-[70vw] shrink-0 flex-col border-l border-zinc-800 bg-[#0d0d0f] max-xl:absolute max-xl:inset-y-0 max-xl:right-0 max-xl:max-w-none max-xl:shadow-2xl">
      <div role="separator" aria-label="调整详情宽度" className="absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize xl:block" onPointerDown={(event) => { resize.current = { pointerId: event.pointerId, x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (resize.current?.pointerId === event.pointerId) setWidth(Math.min(720, Math.max(340, resize.current.width + resize.current.x - event.clientX))); }} onPointerUp={(event) => { if (resize.current?.pointerId === event.pointerId) { resize.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }} />
      <header className="flex items-start justify-between border-b border-zinc-800 px-4 py-3"><div className="min-w-0"><div className="mb-1 flex items-center gap-2"><span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${KIND_META[span.spanKind].badge}`}>{KIND_META[span.spanKind].label}</span><span className={`${STATUS_META[span.status].color} text-[10px]`}>{STATUS_META[span.status].label}</span></div><h3 className="truncate text-sm font-medium text-zinc-100" title={span.name}>{span.name}</h3><p className="mt-1 truncate font-mono text-[10px] text-zinc-600">{span.id}</p></div><button ref={closeRef} type="button" aria-label="关闭详情" onClick={onClose} className="ml-3 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 focus:ring-2 focus:ring-violet-400">✕</button></header>
      <div role="tablist" aria-label="Span 详情类别" className="flex overflow-x-auto border-b border-zinc-800 px-2 pt-1">{tabs.map((item) => <button key={item} role="tab" aria-selected={tab === item} type="button" onClick={() => setTab(item)} className={`shrink-0 border-b-2 px-2.5 py-2 text-[11px] ${tab === item ? 'border-violet-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>{({ summary: '概览', input: '输入', output: '输出', attributes: '属性', timing: '时序', usage: '用量' })[item]}</button>)}</div>
      <div className="min-h-0 flex-1 overflow-auto p-4">{loading && <div className="mb-3 text-xs text-zinc-600">正在加载完整 Span…</div>}{error && <div className="mb-3 rounded-lg bg-rose-500/10 p-3 text-xs text-rose-300">{error}</div>}
        {tab === 'summary' && <><dl className="grid grid-cols-2 gap-2 text-xs">{[['状态', STATUS_META[span.status].label], ['总耗时', formatDuration(summary.durationMs)], ['自身耗时', formatDuration(summary.selfDurationMs)], ['层级', String(summary.depth)], ['输入大小', `${summary.span.inputBytes} B`], ['输出大小', `${summary.span.outputBytes} B`]].map(([label, value]) => <div key={label} className="rounded-lg bg-zinc-900/80 p-3"><dt className="mb-1 text-[10px] text-zinc-600">{label}</dt><dd className="font-mono text-zinc-300">{value}</dd></div>)}</dl>{span.parentId && <div className="mt-3 rounded-lg border border-zinc-800 p-3 text-xs"><div className="mb-1 text-[10px] text-zinc-600">父 Span</div><div className="break-all font-mono text-zinc-400">{span.parentId}</div></div>}{summary.orphaned && <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-300">父 Span 缺失或父链存在循环，该事件已作为根节点展示。</div>}</>}
        {(tab === 'input' || tab === 'output' || tab === 'attributes') && <div><div className="mb-2 flex items-center justify-between"><span className="text-[10px] text-zinc-600">{tab === 'input' ? `${summary.span.inputBytes} bytes` : tab === 'output' ? `${summary.span.outputBytes} bytes` : `${Object.keys(span.attributes).length} 项`}</span><CopyButton value={content} /></div><pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-950 p-3 font-mono text-[11px] leading-5 text-zinc-400">{content}</pre></div>}
        {tab === 'timing' && <dl className="space-y-2 text-xs">{[['开始', formatClock(span.startedAt)], ['首个 Token', span.firstTokenAt ? formatClock(span.firstTokenAt) : '未记录'], ['结束', span.endedAt ? formatClock(span.endedAt) : '运行中'], ['TTFT', formatDuration(ttft)], ['生成阶段', formatDuration(decoding)], ['总耗时', formatDuration(summary.durationMs)]].map(([label, value]) => <div key={label} className="flex justify-between gap-4 rounded-lg bg-zinc-900/80 p-3"><dt className="text-zinc-600">{label}</dt><dd className="font-mono text-zinc-300">{value}</dd></div>)}</dl>}
        {tab === 'usage' && <dl className="grid grid-cols-2 gap-2 text-xs">{[['输入 Token', span.tokensIn.toLocaleString()], ['输出 Token', span.tokensOut.toLocaleString()], ['总 Token', (span.tokensIn + span.tokensOut).toLocaleString()], ['成本', `$${span.costUsd.toFixed(6)}`], ['模型', String(span.attributes['llm.model'] ?? '—')], ['停止原因', String(span.attributes['llm.stop_reason'] ?? '—')]].map(([label, value]) => <div key={label} className="rounded-lg bg-zinc-900/80 p-3"><dt className="mb-1 text-[10px] text-zinc-600">{label}</dt><dd className="break-all font-mono text-zinc-300">{value}</dd></div>)}</dl>}
      </div>
    </aside></>;
}

function TrajectoryTimeline({ rows, selectedId, actualDuration, range, onRangeChange, onSelect }: { rows: FlatSpan[]; selectedId: string | null; actualDuration: boolean; range: DomainRange | null; onRangeChange: (value: DomainRange | null) => void; onSelect: (id: string) => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const [draft, setDraft] = useState<DomainRange | null>(null);
  const runningEnd = Date.now();
  const fullStart = actualDuration ? Math.min(...rows.map(({ node }) => new Date(node.span.startedAt).getTime()), runningEnd) : 0;
  const fullEnd = actualDuration ? Math.max(...rows.map(({ node }) => new Date(node.span.endedAt ?? runningEnd).getTime()), fullStart + 1) : Math.max(1, rows.length);
  const [viewport, setViewport] = useState<{ start: number; end: number } | null>(null);
  useEffect(() => { setViewport(null); onRangeChange(null); }, [actualDuration]);
  if (rows.length === 0) return <div className="border-b border-zinc-800 px-4 py-6 text-center text-xs text-zinc-600">没有符合条件的轨迹</div>;
  const domain = viewport ?? { start: fullStart, end: fullEnd };
  const domainDuration = Math.max(1, domain.end - domain.start);
  const laneKinds: SpanKind[][] = [['orchestration', 'message'], ['agent'], ['llm'], ['tool', 'approval']];
  const laneLabels = ['编排', 'Agent', '模型', '工具'];
  const valueAt = (clientX: number) => { const rect = trackRef.current?.getBoundingClientRect(); const fraction = rect ? Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width))) : 0; return domain.start + fraction * domainDuration; };
  const interval = (row: FlatSpan, index: number) => actualDuration ? { start: new Date(row.node.span.startedAt).getTime(), end: new Date(row.node.span.endedAt ?? runningEnd).getTime() } : { start: index, end: index + 0.86 };
  const activeRange = draft ?? range;
  const handleWheel = (event: WheelEvent) => { event.preventDefault(); const anchor = valueAt(event.clientX); const total = fullEnd - fullStart; const nextDuration = Math.min(total, Math.max(actualDuration ? 20 : 4, domainDuration * Math.exp(event.deltaY * 0.0015))); if (nextDuration >= total * 0.995) { setViewport(null); return; } const ratio = (anchor - domain.start) / domainDuration; const nextStart = Math.min(Math.max(anchor - ratio * nextDuration, fullStart), fullEnd - nextDuration); setViewport({ start: nextStart, end: nextStart + nextDuration }); };
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => { if ((event.target as HTMLElement).closest('[data-span-id]')) return; const value = valueAt(event.clientX); drag.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value }; event.currentTarget.setPointerCapture(event.pointerId); };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId !== event.pointerId) return; const current = valueAt(event.clientX); setDraft({ start: Math.min(drag.current.startValue, current), end: Math.max(drag.current.startValue, current), mode: actualDuration ? 'time' : 'sequence' }); };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => { if (drag.current?.pointerId !== event.pointerId) return; const moved = Math.abs(event.clientX - drag.current.startX); if (moved >= 3 && draft) onRangeChange(draft); else onRangeChange(null); drag.current = null; setDraft(null); event.currentTarget.releasePointerCapture(event.pointerId); };
  return <section aria-label="轨迹时间轴" className="border-b border-zinc-800 bg-zinc-950/40 px-4 py-3"><div className="mb-2 flex items-center justify-between text-[10px] text-zinc-600"><span>{actualDuration ? formatClock(domain.start) : `#${Math.floor(domain.start) + 1}`}</span><span>{rows.length} 个事件 · 滚轮缩放 · 拖动筛选 · 双击复位</span><span>{actualDuration ? formatClock(domain.end) : `#${Math.ceil(domain.end)}`}</span></div><div className="grid grid-cols-[48px_1fr] gap-x-2"><div className="col-start-2" ref={trackRef} onWheel={handleWheel} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { drag.current = null; setDraft(null); }} onDoubleClick={() => { setViewport(null); onRangeChange(null); }}>{laneKinds.map((lane, laneIndex) => <div key={laneLabels[laneIndex]} className="relative my-0.5 h-6 rounded bg-zinc-900/80"><span className="absolute -left-[56px] top-1.5 w-12 text-[10px] text-zinc-600">{laneLabels[laneIndex]}</span>{rows.map((row, index) => { if (!lane.includes(row.node.span.spanKind)) return null; const item = interval(row, index); if (item.end < domain.start || item.start > domain.end) return null; const left = (item.start - domain.start) / domainDuration * 100; const width = Math.max(0.65, (item.end - item.start) / domainDuration * 100); const inRange = !activeRange || item.start <= activeRange.end && item.end >= activeRange.start; return <button data-span-id={row.node.span.id} key={row.node.span.id} type="button" aria-label={`${row.node.span.name} ${formatDuration(row.node.durationMs)}`} title={`${row.node.span.name}\n${formatDuration(row.node.durationMs)}`} onClick={() => onSelect(row.node.span.id)} style={{ left: `${Math.max(0, left)}%`, width: `${Math.min(width, 100 - Math.max(0, left))}%` }} className={`absolute top-1.5 h-3 min-w-[3px] rounded-sm transition-opacity ${KIND_META[row.node.span.spanKind].bar} ${row.node.span.status === 'error' ? 'ring-1 ring-rose-200' : ''} ${selectedId === row.node.span.id ? 'z-10 ring-2 ring-white/80' : ''} ${inRange ? 'opacity-80 hover:opacity-100' : 'opacity-20'}`} />; })}{activeRange && <span className="pointer-events-none absolute inset-y-0 border-x border-violet-300/80 bg-violet-400/10" style={{ left: `${(activeRange.start - domain.start) / domainDuration * 100}%`, width: `${(activeRange.end - activeRange.start) / domainDuration * 100}%` }} />}</div>)}</div></div></section>;
}

export function TrajectoryPanel({ runId, trace, groups, live = false, liveDeltas = {}, graphFilter = null, onSpanEntitySelect, onClearGraphFilter }: { runId: string; trace: TraceTreeSummary; groups: TrajectoryGroup[]; live?: boolean; liveDeltas?: Record<string, string>; graphFilter?: RunGraphNode | null; onSpanEntitySelect?: (nodeId: string) => void; onClearGraphFilter?: () => void }) {
  const allRows = useMemo(() => flattenTrace(trace.roots), [trace]);
  const [query, setQuery] = useState('');
  const [activeKinds, setActiveKinds] = useState<Set<SpanKind>>(new Set(KINDS));
  const [activeStatuses, setActiveStatuses] = useState<Set<SpanStatus>>(new Set(STATUSES));
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actualDuration, setActualDuration] = useState(true);
  const [range, setRange] = useState<DomainRange | null>(null);
  const [newAvailable, setNewAvailable] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const ledgerRef = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const previousTotal = useRef(trace.totalSpans);
  const normalized = query.trim().toLowerCase();
  const rowIndex = useMemo(() => new Map(allRows.map((row, index) => [row.node.span.id, index])), [allRows]);
  const directMatches = useMemo(() => new Set(allRows.filter(({ node }, index) => {
    const span = node.span;
    const haystack = `${span.name} ${span.inputPreview ?? ''} ${span.outputPreview ?? ''} ${JSON.stringify(span.attributes)}`.toLowerCase();
    const end = span.endedAt ? new Date(span.endedAt).getTime() : Date.now();
    const time = actualDuration ? { start: new Date(span.startedAt).getTime(), end } : { start: index, end: index + 0.86 };
    return activeKinds.has(span.spanKind) && activeStatuses.has(span.status) && matchesGraphNode(node, graphFilter) && (normalized === '' || haystack.includes(normalized)) && (!range || time.start <= range.end && time.end >= range.start);
  }).map(({ node }) => node.span.id)), [activeKinds, activeStatuses, actualDuration, allRows, graphFilter, normalized, range]);
  const visibleContext = useMemo(() => { const ids = new Set(directMatches); for (const row of allRows) if (directMatches.has(row.node.span.id)) row.ancestors.forEach((id) => ids.add(id)); return ids; }, [allRows, directMatches]);
  const timelineRows = allRows.filter(({ node }) => visibleContext.has(node.span.id));
  const selected = allRows.find(({ node }) => node.span.id === selectedId)?.node ?? null;
  const kindCounts = useMemo(() => new Map(KINDS.map((kind) => [kind, allRows.filter(({ node }) => node.span.spanKind === kind).length])), [allRows]);
  const maxDuration = Math.max(1, ...allRows.map(({ node }) => node.durationMs ?? 0));
  const toggleSet = <T,>(setter: (next: Set<T>) => void, source: Set<T>, value: T) => { const next = new Set(source); if (next.has(value)) next.delete(value); else next.add(value); setter(next); };
  const grouped = groups.map((group) => ({ group, rows: group.spanIds.map((id) => allRows[rowIndex.get(id) ?? -1]).filter((row): row is FlatSpan => row !== undefined && visibleContext.has(row.node.span.id) && !row.ancestors.some((id) => collapsedNodes.has(id))) })).filter(({ rows }) => rows.length > 0);
  const entries = useMemo<LedgerEntry[]>(() => grouped.flatMap(({ group, rows }) => [{ type: 'group' as const, group, count: rows.length }, ...(collapsedGroups.has(group.id) ? [] : rows.map((row) => ({ type: 'span' as const, row })))]), [collapsedGroups, grouped]);
  const virtualizer = useVirtualizer({ count: entries.length, getScrollElement: () => ledgerRef.current, estimateSize: (index) => entries[index]?.type === 'group' ? 37 : 52, overscan: 14, getItemKey: (index) => entries[index]?.type === 'group' ? entries[index].group.id : entries[index]?.row.node.span.id ?? index });
  const spanEntryIndexes = useMemo(() => entries.flatMap((entry, index) => entry.type === 'span' ? [{ id: entry.row.node.span.id, index }] : []), [entries]);
  const select = (id: string) => { setSelectedId(id); const index = spanEntryIndexes.find((item) => item.id === id)?.index; if (index !== undefined) virtualizer.scrollToIndex(index, { align: 'center' }); const node = allRows.find((row) => row.node.span.id === id)?.node; if (node) onSpanEntitySelect?.(graphNodeIdForSpan(runId, node)); };
  useEffect(() => {
    if (trace.totalSpans <= previousTotal.current) { previousTotal.current = trace.totalSpans; return; }
    previousTotal.current = trace.totalSpans;
    if (live && atBottom.current && entries.length > 0) virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
    else if (live) setNewAvailable(true);
  }, [entries.length, live, trace.totalSpans, virtualizer]);
  const handleKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === '/' && document.activeElement !== searchRef.current) { event.preventDefault(); searchRef.current?.focus(); return; }
    if (event.key === 'Escape' && selectedId) { setSelectedId(null); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const ids = spanEntryIndexes.map((item) => item.id); if (ids.length === 0) return;
    const current = selectedId ? ids.indexOf(selectedId) : -1;
    const next = event.key === 'ArrowDown' ? Math.min(ids.length - 1, current + 1) : Math.max(0, current <= 0 ? 0 : current - 1);
    select(ids[next]!);
  };

  return <div className="relative flex min-h-0 flex-1 overflow-hidden" onKeyDown={handleKeyboard}>
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-[#111114] px-4 py-2"><label className="relative min-w-48 flex-1 max-w-sm"><span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600">⌕</span><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、摘要或属性（/）" className="w-full rounded-lg border border-zinc-800 bg-zinc-950 py-1.5 pl-8 pr-3 text-xs text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-violet-500/60" /></label>{graphFilter && graphFilter.kind !== 'run' && <button type="button" onClick={onClearGraphFilter} className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-xs text-violet-200">{graphFilter.kind}: {graphFilter.label} ×</button>}<button type="button" onClick={() => setActualDuration((value) => !value)} className={`rounded-lg border px-2.5 py-1.5 text-xs ${actualDuration ? 'border-violet-500/40 bg-violet-500/10 text-violet-200' : 'border-zinc-800 text-zinc-500'}`}>◷ {actualDuration ? '真实耗时' : '等宽顺序'}</button><button type="button" onClick={() => { const shouldCollapse = collapsedNodes.size === 0 && collapsedGroups.size === 0; setCollapsedNodes(shouldCollapse ? new Set(allRows.filter(({ node }) => node.children.length > 0).map(({ node }) => node.span.id)) : new Set()); setCollapsedGroups(shouldCollapse ? new Set(groups.map((group) => group.id)) : new Set()); }} className="rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">{collapsedNodes.size > 0 || collapsedGroups.size > 0 ? '全部展开' : '全部折叠'}</button>{range && <button type="button" onClick={() => setRange(null)} className="rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200">清除区间</button>}</div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-zinc-800 px-4 py-2">{KINDS.map((kind) => <button aria-pressed={activeKinds.has(kind)} key={kind} type="button" onClick={() => toggleSet(setActiveKinds, activeKinds, kind)} className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] ${activeKinds.has(kind) ? 'border-zinc-700 bg-zinc-800/70 text-zinc-300' : 'border-zinc-900 text-zinc-700'}`}><span className={`h-1.5 w-1.5 rounded-full ${KIND_META[kind].dot}`} />{KIND_META[kind].label}<span className="text-zinc-600">{kindCounts.get(kind)}</span></button>)}<span className="mx-1 h-4 w-px bg-zinc-800" />{STATUSES.map((status) => <button aria-pressed={activeStatuses.has(status)} key={status} type="button" onClick={() => toggleSet(setActiveStatuses, activeStatuses, status)} className={`rounded-full border px-2 py-1 text-[10px] ${activeStatuses.has(status) ? `border-zinc-700 bg-zinc-800/70 ${STATUS_META[status].color}` : 'border-zinc-900 text-zinc-700'}`}>{STATUS_META[status].label}</button>)}</div>
      <TrajectoryTimeline rows={timelineRows} selectedId={selectedId} actualDuration={actualDuration} range={range} onRangeChange={setRange} onSelect={select} />
      <div className="grid grid-cols-[minmax(0,1fr)_92px_118px] border-b border-zinc-800 bg-zinc-950/60 px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-600"><span>事件</span><span>开始</span><span>耗时</span></div>
      <div ref={ledgerRef} tabIndex={0} aria-label={`轨迹事件账本，共 ${entries.length} 行`} className="relative min-h-0 flex-1 overflow-y-auto outline-none focus:ring-1 focus:ring-inset focus:ring-violet-500/40" onScroll={(event) => { const element = event.currentTarget; atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 28; if (atBottom.current) setNewAvailable(false); }}><div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>{virtualizer.getVirtualItems().map((virtual) => { const entry = entries[virtual.index]; if (!entry) return null; if (entry.type === 'group') return <button key={entry.group.id} type="button" onClick={() => toggleSet(setCollapsedGroups, collapsedGroups, entry.group.id)} className="absolute left-0 top-0 flex w-full items-center gap-2 border-b border-zinc-800 bg-[#141417] px-4 py-2 text-left" style={{ transform: `translateY(${virtual.start}px)`, height: virtual.size }}><span className={`text-[10px] text-zinc-600 transition-transform ${collapsedGroups.has(entry.group.id) ? '' : 'rotate-90'}`}>▶</span><span className="truncate text-xs font-medium text-zinc-300">{entry.group.label}</span>{entry.group.agentId && <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{entry.group.agentId}</span>}<span className={`ml-auto text-[10px] ${entry.group.status === 'error' ? 'text-rose-300' : entry.group.status === 'running' ? 'text-sky-300' : 'text-emerald-300'}`}>{entry.group.status}</span><span className="text-[10px] text-zinc-600">{entry.count}</span></button>; const { node } = entry.row; const meta = KIND_META[node.span.spanKind]; const preview = node.span.outputPreview ?? node.span.inputPreview ?? ''; const hasChildren = node.children.length > 0; const contextOnly = !directMatches.has(node.span.id); return <button key={node.span.id} type="button" onClick={() => select(node.span.id)} className={`absolute left-0 top-0 grid w-full grid-cols-[minmax(0,1fr)_92px_118px] items-center border-b border-zinc-900 px-4 py-2 text-left transition-colors ${selectedId === node.span.id ? 'bg-violet-500/10' : 'hover:bg-zinc-900/60'} ${contextOnly ? 'opacity-45' : ''}`} style={{ transform: `translateY(${virtual.start}px)`, height: virtual.size }}><span className="flex min-w-0 items-center" style={{ paddingLeft: `${Math.max(0, node.depth - 1) * 17}px` }}><span className="mr-1 flex w-4 shrink-0 justify-center" onClick={(event) => { if (!hasChildren) return; event.stopPropagation(); toggleSet(setCollapsedNodes, collapsedNodes, node.span.id); }}>{hasChildren ? <span className={`text-[10px] text-zinc-600 transition-transform ${collapsedNodes.has(node.span.id) ? '' : 'rotate-90'}`}>▶</span> : <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />}</span><span className={`mr-2 rounded px-1.5 py-0.5 text-[10px] ${meta.badge}`}>{meta.label}</span><span className="min-w-0"><span className="block truncate text-xs text-zinc-200">{node.span.name}</span>{preview && <span className="block truncate text-[10px] text-zinc-600">{preview}</span>}</span>{node.span.status === 'error' && <span className="ml-2 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-300">错误</span>}{node.span.status === 'running' && <span className="ml-2 animate-pulse text-[10px] text-sky-300">运行中</span>}</span><span className="font-mono text-[10px] text-zinc-600">{formatClock(node.span.startedAt)}</span><span className="flex items-center gap-2"><span className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-900"><span className={`block h-full rounded-full ${meta.bar}`} style={{ width: `${Math.max(4, Math.min(100, (node.durationMs ?? 0) / maxDuration * 100))}%` }} /></span><span className="w-14 text-right font-mono text-[10px] text-zinc-500">{formatDuration(node.durationMs)}</span></span></button>; })}</div>{entries.length === 0 && <div className="py-16 text-center text-xs text-zinc-600">没有符合当前筛选条件的事件</div>}</div>
      {newAvailable && <button type="button" onClick={() => { virtualizer.scrollToIndex(Math.max(0, entries.length - 1), { align: 'end' }); setNewAvailable(false); }} className="absolute bottom-4 right-4 z-10 rounded-full bg-violet-500 px-3 py-1.5 text-xs text-white shadow-xl">↓ 回到最新</button>}
    </div>
    {selected && <SpanInspector runId={runId} summary={selected} liveText={liveDeltas[selected.span.id] ?? ''} onClose={() => setSelectedId(null)} />}
  </div>;
}
