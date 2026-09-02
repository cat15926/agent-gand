/**
 * 顶栏：品牌 + 活动运行状态 + 用量 + WS 连接指示（P0-6）
 */
import { useStore } from '../store';

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  awaiting_approval: '待审批',
  completed: '已完成',
  failed: '失败',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-zinc-500',
  running: 'bg-sky-400 animate-pulse',
  awaiting_approval: 'bg-amber-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-500',
};

export function TopBar() {
  const { state } = useStore();
  const activeRun = state.runs.find((r) => r.id === state.activeRunId);
  const tokens = state.usage.reduce((acc, u) => acc + u.tokensIn + u.tokensOut, 0);

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-zinc-800 bg-zinc-900/60 px-4">
      <span className="text-sm font-semibold tracking-wide text-zinc-100">
        agent-gand <span className="text-zinc-500">· 多 Agent 协作平台</span>
      </span>

      {activeRun && (
        <span className="flex items-center gap-2 rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300">
          <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[activeRun.status] ?? 'bg-zinc-500'}`} />
          {STATUS_LABEL[activeRun.status] ?? activeRun.status}
          <span className="max-w-48 truncate text-zinc-500">{activeRun.goal}</span>
        </span>
      )}

      <span className="ml-auto text-xs text-zinc-400">
        用量 <span className="font-mono text-zinc-200">{tokens.toLocaleString()}</span> tokens
      </span>
      <span className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span
          className={`h-2 w-2 rounded-full ${state.wsConnected ? 'bg-emerald-400' : 'bg-red-500'}`}
        />
        {state.wsConnected ? '已连接' : '重连中'}
      </span>
    </header>
  );
}
