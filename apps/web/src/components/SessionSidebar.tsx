/**
 * 会话侧栏（规格 §13.1/13.4）：聊天区左侧常驻窄栏（~240px 可折叠为图标条）
 * 状态点/标题（内联重命名）/模式徽标/相对时间/工作区徽标；今天/昨天/本周/更早分组；
 * 搜索（标题+目标）+ 状态过滤（含已删除）；多选批删；删除确认（明示证据保留）；
 * ＋新会话（空态聚焦）；点击即时切换；新 run 启动自动滚动定位。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Run, RunStatus } from '@agent-gand/shared';
import * as api from '../services/api';
import { useStore } from '../store';

const STATUS_FILTERS = [
  { key: '', label: '全部' },
  { key: 'running', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
  { key: 'deleted', label: '已删除' },
] as const;

const DOT: Record<string, string> = {
  pending: 'bg-zinc-500',
  running: 'bg-sky-400 animate-pulse',
  awaiting_approval: 'bg-amber-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-500',
};

/** 相对时间（简版）：今天 HH:mm；昨天；本周 周X；更早 YYYY-MM-DD */
function relTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, yesterday)) return '昨天';
  if (now.getTime() - d.getTime() < 7 * 86400_000) return `周${'日一二三四五六'[d.getDay()]}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function timeGroup(iso: string): 0 | 1 | 2 | 3 {
  const d = new Date(iso);
  const now = new Date();
  const day = 86400_000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startOfToday) return 0; // 今天
  if (t >= startOfToday - day) return 1; // 昨天
  if (t >= startOfToday - 7 * day) return 2; // 本周
  return 3; // 更早
}

const GROUP_LABEL = ['今天', '昨天', '本周', '更早'];

export interface SessionSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeRunId: string | null;
  onSelect: (id: string) => void;
  /** ＋新会话：清空激活并聚焦输入框 */
  onNewSession: () => void;
}

export function SessionSidebar({ collapsed, onToggleCollapse, activeRunId, onSelect, onNewSession }: SessionSidebarProps) {
  const { state } = useStore();
  const [runs, setRuns] = useState<Run[]>([]);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [batchMode, setBatchMode] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null); // 待确认删除（单/批共用）
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);

  const includeDeleted = statusFilter === 'deleted';
  const effectiveStatus = statusFilter === 'deleted' || statusFilter === '' ? undefined : statusFilter;

  async function refresh() {
    try {
      setRuns(await api.getRuns({ includeDeleted: true, q: q.trim() || undefined, status: effectiveStatus }));
    } catch {
      // 列表失败保留现状（下次事件触发重拉）
    }
  }

  // 挂载/过滤变化刷新；store 的 run.updated/新 run 到达（WS 增量驱动）节流刷新
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, statusFilter, state.runs.length]);
  useEffect(() => {
    const t = setTimeout(() => void refresh(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.runs]);

  // 激活项滚动定位（新 run 启动后自动滚动到可见）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeRunId, runs.length]);

  const groups = useMemo(() => {
    const visible = runs.filter((r) => (includeDeleted ? r.deletedAt != null : r.deletedAt == null));
    const buckets: Run[][] = [[], [], [], []];
    for (const r of visible) {
      const g = buckets[timeGroup(r.createdAt)];
      if (g) g.push(r);
    }
    return buckets;
  }, [runs, includeDeleted]);

  async function doDelete(ids: string[]) {
    for (const id of ids) {
      try {
        await api.softDeleteRun(id);
      } catch {
        // 单条失败继续其余（批删语义：逐个置位）
      }
    }
    setConfirmIds(null);
    setPicked(new Set());
    setBatchMode(false);
    if (ids.includes(activeRunId ?? '')) onNewSession();
    await refresh();
  }

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-2 border-r border-zinc-800 bg-zinc-900/60 py-2">
        <button onClick={onToggleCollapse} className="rounded-md px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="展开会话栏">
          »
        </button>
        <button onClick={onNewSession} className="rounded-md px-1.5 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="新会话">
          ＋
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60">
      {/* 顶部：新会话 + 折叠 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-800 px-2.5 py-2">
        <button
          onClick={onNewSession}
          className="flex-1 rounded-md bg-violet-500/20 px-2 py-1.5 text-xs text-violet-200 hover:bg-violet-500/30"
        >
          ＋ 新会话
        </button>
        <button onClick={onToggleCollapse} className="rounded-md px-1.5 py-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="折叠">
          «
        </button>
      </div>

      {/* 搜索 + 状态过滤 */}
      <div className="shrink-0 space-y-1.5 border-b border-zinc-800 px-2.5 py-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索标题或目标…"
          className="w-full rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:ring-violet-500"
        />
        <div className="flex flex-wrap gap-1 text-[11px]">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`rounded-full px-2 py-0.5 ${
                statusFilter === f.key ? 'bg-violet-500/25 text-violet-200' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f.label}
            </button>
          ))}
          <button
            onClick={() => {
              setBatchMode((v) => !v);
              setPicked(new Set());
            }}
            className={`ml-auto rounded-full px-2 py-0.5 ${batchMode ? 'bg-amber-500/25 text-amber-200' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'}`}
            title="多选批删"
          >
            {batchMode ? '退出多选' : '多选'}
          </button>
        </div>
        {batchMode && (
          <div className="flex items-center gap-1.5 text-[11px]">
            <button className="text-zinc-400 hover:text-zinc-100" onClick={() => setPicked(new Set(runs.filter((r) => r.deletedAt == null).map((r) => r.id)))}>
              全选未删
            </button>
            <span className="text-zinc-600">已选 {picked.size}</span>
            <button
              className="ml-auto rounded-md bg-red-500/15 px-2 py-0.5 text-red-300 hover:bg-red-500/25 disabled:opacity-40"
              disabled={picked.size === 0}
              onClick={() => setConfirmIds([...picked])}
            >
              删除所选
            </button>
          </div>
        )}
      </div>

      {/* 分组列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {groups.every((g) => g.length === 0) && (
          <p className="pt-8 text-center text-[11px] text-zinc-600">
            {q.trim() !== '' || statusFilter !== '' ? '无匹配会话' : '暂无会话——输入目标开启第一个会话'}
          </p>
        )}
        {groups.map((bucket, gi) =>
          bucket.length === 0 ? null : (
            <div key={gi} className="mb-1.5">
              <p className="px-1.5 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-600">{GROUP_LABEL[gi]}</p>
              {bucket.map((r) => {
                const deleted = r.deletedAt != null;
                const isActive = r.id === activeRunId;
                const title = r.title ?? r.goal.slice(0, 24);
                return (
                  <div
                    key={r.id}
                    className={`group mb-0.5 flex items-start gap-1.5 rounded-lg px-1.5 py-1.5 ${
                      isActive ? 'bg-violet-500/15 ring-1 ring-violet-500/40' : 'hover:bg-zinc-800/70'
                    } ${deleted ? 'opacity-50' : ''}`}
                  >
                    {batchMode && !deleted && (
                      <input
                        type="checkbox"
                        checked={picked.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(picked);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setPicked(next);
                        }}
                        className="mt-1 accent-violet-500"
                      />
                    )}
                    <button
                      ref={isActive ? activeRef : undefined}
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onSelect(r.id)}
                      title={r.goal}
                    >
                      {renaming?.id === r.id ? null : (
                        <>
                          <span className="flex items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[r.status] ?? 'bg-zinc-500'}`} />
                            <span className={`min-w-0 flex-1 truncate text-xs ${deleted ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
                              {title}
                            </span>
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5 pl-3 text-[10px] text-zinc-500">
                            <span className="rounded bg-zinc-800 px-1 py-px">{r.mode === 'pipeline' ? '流水' : '主管'}</span>
                            <span>{relTime(r.createdAt)}</span>
                            {r.workspace ? (
                              r.workspace.startsWith('ext:') ? (
                                <span title="外部工作区">📁</span>
                              ) : (
                                <span className="max-w-16 truncate rounded bg-sky-500/10 px-1 py-px text-sky-300/80" title={r.workspace}>
                                  {r.workspace}
                                </span>
                              )
                            ) : null}
                          </span>
                        </>
                      )}
                    </button>
                    {renaming?.id === r.id ? (
                      <span className="flex min-w-0 flex-1 items-center gap-1">
                        <input
                          autoFocus
                          value={renaming.title}
                          onChange={(e) => setRenaming({ id: r.id, title: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && renaming.title.trim().length > 0 && renaming.title.trim().length <= 80) {
                              void api
                                .renameRun(r.id, renaming.title.trim())
                                .then(refresh)
                                .catch(() => undefined);
                              setRenaming(null);
                            }
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                          className="min-w-0 flex-1 rounded-md bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-200 outline-none ring-1 ring-zinc-700 focus:ring-violet-500"
                        />
                        <button
                          className="text-[10px] text-violet-300 hover:text-violet-200"
                          onClick={() => {
                            if (renaming.title.trim().length > 0 && renaming.title.trim().length <= 80) {
                              void api
                                .renameRun(r.id, renaming.title.trim())
                                .then(refresh)
                                .catch(() => undefined);
                              setRenaming(null);
                            }
                          }}
                        >
                          ✓
                        </button>
                      </span>
                    ) : !deleted && !batchMode ? (
                      <span className="flex shrink-0 flex-col gap-0.5 opacity-40 transition-opacity group-hover:opacity-100">
                        <button
                          className="rounded px-1 text-[10px] text-zinc-500 hover:text-zinc-100"
                          title="重命名"
                          onClick={() => setRenaming({ id: r.id, title })}
                        >
                          ✎
                        </button>
                        <button
                          className="rounded px-1 text-[10px] text-zinc-500 hover:text-red-300"
                          title="删除会话"
                          onClick={() => setConfirmIds([r.id])}
                        >
                          🗑
                        </button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ),
        )}
      </div>

      {/* 删除确认（§13.3 文案：明示证据保留） */}
      {confirmIds && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6" onClick={() => setConfirmIds(null)}>
          <div className="w-full max-w-sm rounded-2xl border border-red-500/40 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-red-300">删除{confirmIds.length > 1 ? ` ${confirmIds.length} 个会话` : '会话'}？</h3>
            <p className="mt-2 text-xs leading-relaxed text-zinc-300">
              会话将从列表移除（可在"已删除"筛选中查看）；沙箱产物与 span 证据保留，runId 取证链不受影响。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="rounded-md px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200" onClick={() => setConfirmIds(null)}>
                取消
              </button>
              <button
                className="rounded-md bg-red-500/20 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/30"
                onClick={() => void doDelete(confirmIds)}
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
