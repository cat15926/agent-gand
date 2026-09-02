/**
 * 运行视图（报告模式 2）：消息流时间线 + 启动器 + 工作区占位
 */
import { useState } from 'react';
import type { Message } from '@agent-gand/shared';
import * as api from '../../services/api';
import { useStore } from '../../store';

function MessageBubble({ msg }: { msg: Message }) {
  const { state } = useStore();
  const agent = state.agents.find((a) => a.id === msg.from);
  const color = agent?.color ?? '#7c8a9c';

  // 系统与工具消息：紧凑卡片，工具详情可折叠（过程降噪，见报告 §5.3-5）
  if (msg.kind === 'system' || msg.kind === 'tool') {
    return (
      <details className="mx-auto w-full max-w-2xl">
        <summary className="cursor-pointer py-1 text-center text-[11px] text-zinc-600 hover:text-zinc-400">
          {msg.kind === 'tool' ? `🔧 ${msg.from}` : '⚙ system'} · {msg.body.slice(0, 60)}
          {msg.body.length > 60 ? '…' : ''}
        </summary>
        <pre className="mx-auto max-w-2xl whitespace-pre-wrap rounded-lg bg-zinc-900 p-3 font-mono text-[11px] text-zinc-400">
          {msg.body}
        </pre>
      </details>
    );
  }

  const mine = msg.from === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-2xl rounded-2xl px-4 py-2.5 text-sm ${mine ? 'bg-violet-500/20 text-zinc-100' : 'bg-zinc-800 text-zinc-200'}`}>
        {!mine && (
          <div className="mb-0.5 flex items-center gap-1.5 text-[11px]" style={{ color }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            {agent?.name ?? msg.from}
          </div>
        )}
        <div className="whitespace-pre-wrap leading-relaxed">{msg.body}</div>
      </div>
    </div>
  );
}

function Launcher() {
  const { state, setActiveRun } = useStore();
  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<'pipeline' | 'supervisor'>('pipeline');
  const [selected, setSelected] = useState<string[]>(state.agents.map((a) => a.id));
  const [busy, setBusy] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function launch() {
    if (!goal.trim() || selected.length === 0 || busy) return;
    setBusy(true);
    try {
      const { run } = await api.startRun({ goal: goal.trim(), mode, agentIds: selected });
      setActiveRun(run.id);
      setGoal('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as 'pipeline' | 'supervisor')}
          className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 outline-none"
        >
          <option value="pipeline">顺序流水线</option>
          <option value="supervisor">主管委派</option>
        </select>
        {state.agents.map((a) => (
          <button
            key={a.id}
            onClick={() => toggle(a.id)}
            className={`rounded-full px-2.5 py-1 ${
              selected.includes(a.id) ? 'text-zinc-100' : 'text-zinc-500'
            }`}
            style={{
              backgroundColor: selected.includes(a.id) ? `${a.color}26` : 'transparent',
              boxShadow: selected.includes(a.id) ? `0 0 0 1px ${a.color}66` : 'none',
            }}
          >
            {a.name}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void launch()}
          placeholder="输入目标，如：调研并生成一份竞品分析报告"
          className="flex-1 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-200 outline-none ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:ring-violet-500"
        />
        <button
          disabled={busy || !goal.trim() || selected.length === 0}
          onClick={() => void launch()}
          className="rounded-lg bg-violet-500/80 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
        >
          启动
        </button>
      </div>
    </div>
  );
}

export function RunView() {
  const { state, setActiveRun } = useStore();

  return (
    <div className="flex h-full flex-col">
      {/* 运行切换 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs">
        <span className="text-zinc-500">运行会话</span>
        <select
          value={state.activeRunId ?? ''}
          onChange={(e) => setActiveRun(e.target.value || null)}
          className="max-w-72 flex-1 rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 outline-none"
        >
          <option value="">（无）</option>
          {[...state.runs].reverse().map((r) => (
            <option key={r.id} value={r.id}>
              [{r.mode}] {r.goal.slice(0, 30)} · {r.status}
            </option>
          ))}
        </select>
        {/* 工作区占位：P1 接入沙箱终端/浏览器实时视图（报告模式 2 右栏） */}
        <span className="ml-auto rounded-md bg-zinc-800 px-2 py-1 text-zinc-600">🖥 工作区（P1）</span>
      </div>

      {/* 消息流 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {state.messages.length === 0 && (
          <p className="pt-16 text-center text-sm text-zinc-600">
            {state.activeRunId ? '等待消息…' : '在下方输入目标，启动一次多 Agent 运行'}
          </p>
        )}
        {state.messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
      </div>

      <Launcher />
    </div>
  );
}
