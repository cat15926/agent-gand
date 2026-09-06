/**
 * 运行视图（报告模式 2）：消息流时间线 + 启动器 + 工作区占位
 */
import { useEffect, useState } from 'react';
import type { Message } from '@agent-gand/shared';
import * as api from '../../services/api';
import { useStore } from '../../store';
import { MarkdownBody } from '../Markdown';

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
        <div className="min-w-0">
          <MarkdownBody text={msg.body} />
        </div>
      </div>
    </div>
  );
}

/** 流式段落（§8.1）：活动 llm span 的渐增文本，span 结束后由 store 折叠（正式消息随后到达） */
function StreamingBubble({ spanId, text }: { spanId: string; text: string }) {
  const { state } = useStore();
  // llm span 的父级是 agent span（name = agent:<id>[（supervisor）]）→ 解析出 agent 名与颜色
  const span = state.events.find((e) => e.id === spanId);
  const parent = span?.parentId ? state.events.find((e) => e.id === span.parentId) : undefined;
  const agentId = parent?.name.startsWith('agent:') ? parent.name.slice('agent:'.length) : null;
  const agent = agentId ? state.agents.find((a) => agentId === a.id || agentId.startsWith(`${a.id}（`)) : undefined;
  const color = agent?.color ?? '#7c8a9c';

  return (
    <div className="flex justify-start">
      <div className="max-w-2xl rounded-2xl border border-dashed border-zinc-700 bg-zinc-800/60 px-4 py-2.5 text-sm">
        <div className="mb-0.5 flex items-center gap-1.5 text-[11px]" style={{ color }}>
          <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: color }} />
          ⟳ {agent?.name ?? span?.name ?? '生成中'}
        </div>
        <div className="min-w-0 text-zinc-400">
          <MarkdownBody text={text} />
          <span className="animate-pulse">▍</span>
        </div>
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
  // 工作区选择（§10.3）：'' = 每次 run 专属；否则命名工作区（下拉历史或输入新名）
  const [workspace, setWorkspace] = useState('');
  const [newWorkspace, setNewWorkspace] = useState('');
  const [workspaces, setWorkspaces] = useState<Array<{ name: string; modifiedAt: string }>>([]);

  useEffect(() => {
    // 打开时与运行结束后刷新可选工作区列表（新建命名工作区后即出现在下拉）
    api
      .getWorkspaces()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, [state.runs.length]);

  // @提及路由：输入中的 @agentId 自动限定接收者（按提及顺序）并剥离前缀，形成"单聊"语义
  const mentionedIds = [...goal.matchAll(/@([\w-]+)/g)]
    .map((m) => m[1] ?? '')
    .filter((id) => id !== '' && state.agents.some((a) => a.id === id));
  const routedIds = [...new Set(mentionedIds)];

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function launch() {
    if (!goal.trim() || selected.length === 0 || busy) return;
    // 新名输入优先于下拉选择；非法名（非 [\w-] 或超 32）不发请求（服务端同样校验）
    const ws = newWorkspace.trim() !== '' ? newWorkspace.trim() : workspace;
    if (ws !== '' && !/^[\w-]{1,32}$/.test(ws)) return;
    setBusy(true);
    try {
      let effectiveGoal = goal.trim();
      let effectiveAgents = selected;
      if (routedIds.length > 0) {
        effectiveAgents = routedIds;
        let stripped = goal;
        for (const id of routedIds) stripped = stripped.replaceAll(`@${id}`, '');
        stripped = stripped.replace(/\s+/g, ' ').trim();
        if (stripped !== '') effectiveGoal = stripped; // 剥离后为空（纯提及）则保留原文
      }
      const { run } = await api.startRun({
        goal: effectiveGoal,
        mode,
        agentIds: effectiveAgents,
        ...(ws !== '' ? { workspace: ws } : {}),
      });
      setActiveRun(run.id);
      setGoal('');
      setNewWorkspace(''); // 启动成功后清空新名输入（下拉会在列表刷新后带上它）
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
        {/* 工作区选择（§10.3）：每次新建（默认）或历史命名工作区；新名输入优先生效 */}
        <select
          value={workspace}
          onChange={(e) => {
            setWorkspace(e.target.value);
            setNewWorkspace('');
          }}
          className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-300 outline-none"
          title={workspace === '' ? '每次运行使用独立目录' : `命名工作区：${workspace}`}
        >
          <option value="">🗂 每次新建</option>
          {workspaces.map((w) => (
            <option key={w.name} value={w.name}>
              🗂 {w.name}
            </option>
          ))}
        </select>
        <input
          value={newWorkspace}
          onChange={(e) => setNewWorkspace(e.target.value)}
          placeholder="或输入新工作区名（字母/数字/-/_）"
          className={`w-52 rounded-md bg-zinc-800 px-2 py-1 outline-none ring-1 ${
            newWorkspace !== '' && !/^[\w-]{1,32}$/.test(newWorkspace.trim())
              ? 'ring-red-500/70 text-zinc-300'
              : 'ring-zinc-700 text-zinc-300'
          } placeholder:text-zinc-600`}
        />
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
        {routedIds.length > 0 && (
          <span className="text-amber-300/90">
            → @路由：仅发送给{' '}
            {routedIds.map((id) => state.agents.find((a) => a.id === id)?.name ?? id).join('、')}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void launch()}
          placeholder="输入目标；@coder 前缀=仅发给该 agent"
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
  const activeRun = state.runs.find((r) => r.id === state.activeRunId);

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
        {/* 当前 run 的工作区标识（§10.3）：命名工作区或 run 专属 */}
        {activeRun?.workspace ? (
          <span
            className="rounded-md bg-sky-500/10 px-2 py-1 text-[11px] text-sky-300 ring-1 ring-sky-500/30"
            title="命名工作区：同名单次运行共用目录（跨 run 文件延续）"
          >
            🗂 {activeRun.workspace}
          </span>
        ) : (
          <span className="rounded-md bg-zinc-800 px-2 py-1 text-[11px] text-zinc-500" title="本次运行使用独立目录">
            🗂 独立目录
          </span>
        )}
        {/* 工作区占位：P1 接入沙箱终端/浏览器实时视图（报告模式 2 右栏） */}
        <span className="rounded-md bg-zinc-800 px-2 py-1 text-zinc-600">🖥 工作区（P1）</span>
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
        {Object.entries(state.streams).map(([spanId, text]) => (
          <StreamingBubble key={spanId} spanId={spanId} text={text} />
        ))}
      </div>

      <Launcher />
    </div>
  );
}
