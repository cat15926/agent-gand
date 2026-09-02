/**
 * 右侧面板：审批队列 / Trace 时间线 / 用量（对应报告模式 5 / 4）
 */
import { useState } from 'react';
import { useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';

const SPAN_COLOR: Record<string, string> = {
  llm: 'text-sky-300',
  tool: 'text-amber-300',
  agent: 'text-violet-300',
  message: 'text-zinc-400',
  approval: 'text-rose-300',
  orchestration: 'text-emerald-300',
};

export function RightPanel() {
  const { state } = useStore();
  const [tab, setTab] = useState<'approvals' | 'trace' | 'usage'>('approvals');
  const pending = state.approvals.filter((a) => a.status === 'pending');

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900/60">
      <div className="flex shrink-0 border-b border-zinc-800 text-xs">
        {(
          [
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
        {tab === 'approvals' && (
          <div className="space-y-3">
            {pending.length === 0 && <p className="text-xs text-zinc-600">暂无待审批项</p>}
            {pending.map((a) => (
              <ApprovalCard key={a.id} approval={a} />
            ))}
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
