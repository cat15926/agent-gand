/**
 * 顶栏：品牌 + 活动运行状态 + 用量 + WS 连接指示（P0-6）
 */
import { useStore } from '../store';

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  awaiting_approval: '待审批',
  waiting_for_user: '等待你的决定',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-zinc-500',
  running: 'bg-sky-400 animate-pulse',
  awaiting_approval: 'bg-amber-400 animate-pulse',
  waiting_for_user: 'bg-violet-400 animate-pulse',
  completed: 'bg-emerald-400',
  failed: 'bg-red-500',
  cancelled: 'bg-zinc-500',
};

export function TopBar() {
  const { state } = useStore();
  const activeRun = state.runs.find((r) => r.id === state.activeRunId);
  const tokens = state.usage.reduce((acc, u) => acc + u.tokensIn + u.tokensOut, 0);
  // 待审批数（含所有 run）：>0 时 amber 高亮 + pulse 常驻（§8.2）
  const pendingApprovals = state.approvals.filter((a) => a.status === 'pending').length;

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 sm:gap-4 sm:px-4">
      <span className="shrink-0 whitespace-nowrap text-sm font-semibold tracking-wide text-zinc-100">
        agent-gand <span className="hidden text-zinc-400 lg:inline">· 多 Agent 协作平台</span>
      </span>

      {pendingApprovals > 0 && (
        <span className="flex shrink-0 animate-pulse items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-500/40">
          ⚠ 待审批 {pendingApprovals}
        </span>
      )}

      {activeRun && (
        <span className="hidden min-w-0 items-center gap-2 whitespace-nowrap rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-300 sm:flex">
          <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[activeRun.status] ?? 'bg-zinc-500'}`} />
          查看第 {activeRun.turnNo} 轮 · {STATUS_LABEL[activeRun.status] ?? activeRun.status}
          <span className="max-w-48 truncate text-zinc-400">{activeRun.goal}</span>
        </span>
      )}

      <span className="ml-auto hidden whitespace-nowrap text-xs text-zinc-400 md:inline">
        用量 <span className="font-mono text-zinc-200">{tokens.toLocaleString()}</span> tokens{state.usage.some((item) => item.hasUnknownTokens) ? ' + 未知用量' : ''}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-zinc-400 md:ml-0">
        <span
          className={`h-2 w-2 rounded-full ${state.wsConnected ? 'bg-emerald-400' : 'bg-red-500'}`}
        />
        {state.wsConnected ? '已连接' : '重连中'}
      </span>
    </header>
  );
}
