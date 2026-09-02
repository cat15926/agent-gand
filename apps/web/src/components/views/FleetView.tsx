/**
 * 舰队视图（报告模式 6）：一行一 agent —— 状态分组 + 单行摘要 + 待办提示
 * 状态推导：待审批 > 工作中 > 空闲（Claude Code agent view 的 Needs-input 置顶思想）
 */
import { useStore } from '../../store';

type AgentStatus = 'needs_input' | 'working' | 'idle';

const STATUS_META: Record<AgentStatus, { label: string; cls: string }> = {
  needs_input: { label: '待输入', cls: 'bg-amber-400 animate-pulse' },
  working: { label: '工作中', cls: 'bg-sky-400 animate-pulse' },
  idle: { label: '空闲', cls: 'bg-zinc-600' },
};

function agentStatus(agentId: string, ctx: ReturnType<typeof useStore>['state']): AgentStatus {
  if (ctx.approvals.some((a) => a.status === 'pending' && a.agentId === agentId)) return 'needs_input';
  if (ctx.tasks.some((t) => t.status === 'in_progress' && t.assignee === agentId)) return 'working';
  return 'idle';
}

export function FleetView() {
  const { state } = useStore();

  const rows = state.agents.map((agent) => {
    const status = agentStatus(agent.id, state);
    const activeTask = state.tasks.find((t) => t.assignee === agent.id && t.status === 'in_progress');
    const done = state.tasks.filter((t) => t.assignee === agent.id && t.status === 'completed').length;
    return { agent, status, summary: activeTask?.title ?? (done > 0 ? `已完成 ${done} 项任务` : '暂无任务'), done };
  });

  // 待输入置顶（报告 §5.1 模式 6 共性要素）
  const order: Record<AgentStatus, number> = { needs_input: 0, working: 1, idle: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status]);

  return (
    <div className="h-full overflow-y-auto p-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
            <th className="py-2 font-normal">状态</th>
            <th className="py-2 font-normal">Agent</th>
            <th className="py-2 font-normal">当前摘要</th>
            <th className="py-2 font-normal text-right">已完成</th>
            <th className="py-2 font-normal text-right">权限模式</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ agent, status, summary, done }) => (
            <tr key={agent.id} className="border-b border-zinc-800/50">
              <td className="py-2.5">
                <span className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className={`h-2 w-2 rounded-full ${STATUS_META[status].cls}`} />
                  {STATUS_META[status].label}
                </span>
              </td>
              <td className="py-2.5">
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: agent.color }} />
                  <span className="text-zinc-200">{agent.name}</span>
                  <span className="text-xs text-zinc-600">{agent.model}</span>
                </span>
              </td>
              <td className="max-w-72 truncate py-2.5 text-zinc-400">{summary}</td>
              <td className="py-2.5 text-right font-mono text-xs text-zinc-400">{done}</td>
              <td className="py-2.5 text-right">
                <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                  {agent.permissionMode === 'readonly' ? '只读' : agent.permissionMode === 'confirm' ? '需确认' : '自动'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
