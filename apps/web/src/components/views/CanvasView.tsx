/**
 * 编排视图占位（P1）：按报告 §7.3 决策，画布先做只读拓扑渲染（React Flow + elkjs），
 * 交互式编辑留到 P2，避免先造画布编辑器的最大研发坑。
 */
export function CanvasView() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="text-4xl">⬡</span>
      <h2 className="text-base font-medium text-zinc-300">编排画布（P1）</h2>
      <p className="max-w-md text-sm leading-relaxed text-zinc-500">
        计划以 React Flow（@xyflow/react）渲染执行拓扑：agent 节点 + 依赖边，
        运行时节点实时状态高亮（对标 LangGraph Studio 的"代码即真相 + 只读图"路线）。
        拓扑数据源为 server 的 runs/tasks/messages。
      </p>
      <p className="text-xs text-zinc-600">规格见 docs/scaffold-plan.md §5 与调研报告 §5.1 模式 1</p>
    </div>
  );
}
