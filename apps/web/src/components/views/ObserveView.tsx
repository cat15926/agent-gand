/**
 * 观测视图（报告模式 4）：runs 列表 + 事件时间线（span 树的平铺简化版，P1 做瀑布图）
 */
import { useEffect, useState } from 'react';
import type { RunDetail } from '../../services/api';
import * as api from '../../services/api';
import { useStore } from '../../store';

const KIND_COLOR: Record<string, string> = {
  llm: 'text-sky-300',
  tool: 'text-amber-300',
  agent: 'text-violet-300',
  message: 'text-zinc-400',
  approval: 'text-rose-300',
  orchestration: 'text-emerald-300',
};

function fmtDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return '…';
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function ObserveView() {
  const { state } = useStore();
  const [selected, setSelected] = useState<string | null>(state.activeRunId);
  const [detail, setDetail] = useState<RunDetail | null>(null);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    void api.getRun(selected).then(setDetail).catch(() => setDetail(null));
  }, [selected]);

  return (
    <div className="flex h-full">
      <div className="w-80 shrink-0 overflow-y-auto border-r border-zinc-800 p-3">
        <h3 className="mb-2 px-1 text-xs font-medium text-zinc-500">运行历史</h3>
        {[...state.runs].reverse().map((r) => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className={`mb-1.5 w-full rounded-lg p-2.5 text-left text-xs ${
              selected === r.id ? 'bg-violet-500/15 ring-1 ring-violet-500/40' : 'bg-zinc-900 hover:bg-zinc-800'
            }`}
          >
            <div className="mb-0.5 flex items-center justify-between">
              <span className="font-mono text-zinc-500">{r.id.slice(0, 8)}</span>
              <span className="text-zinc-400">{r.status}</span>
            </div>
            <div className="truncate text-zinc-300">[{r.mode}] {r.goal}</div>
            <div className="mt-0.5 text-zinc-600">{new Date(r.createdAt).toLocaleString()}</div>
          </button>
        ))}
        {state.runs.length === 0 && <p className="px-1 text-xs text-zinc-600">暂无运行</p>}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {!detail && <p className="pt-16 text-center text-sm text-zinc-600">选择左侧运行查看事件时间线</p>}
        {detail && (
          <>
            <h2 className="mb-1 text-sm font-medium text-zinc-200">[{detail.run.mode}] {detail.run.goal}</h2>
            <p className="mb-4 text-xs text-zinc-500">
              {detail.run.status} · {detail.events.length} events · {detail.messages.length} messages
            </p>
            <ol className="space-y-2 border-l border-zinc-800 pl-4">
              {detail.events.map((e) => (
                <li key={e.id} className="relative text-xs">
                  <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-zinc-700" />
                  <span className={KIND_COLOR[e.spanKind] ?? 'text-zinc-400'}>[{e.spanKind}]</span>{' '}
                  <span className="text-zinc-300">{e.name}</span>
                  <span className="ml-1 text-zinc-600">
                    {e.status} · {fmtDuration(e.startedAt, e.endedAt)}
                    {e.tokensIn + e.tokensOut > 0 && ` · ${e.tokensIn + e.tokensOut}tok`}
                  </span>
                  {e.output && (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-900 p-2 font-mono text-[11px] text-zinc-500">
                      {e.output.slice(0, 500)}
                    </pre>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  );
}
