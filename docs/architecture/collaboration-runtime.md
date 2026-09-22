# Collaboration 运行架构

状态：生效（2026-09-21）

本页描述当前自由协作运行时契约。历史实施决策和测试矩阵见[实施计划](../plans/collaboration-mode-implementation-plan.md)，本轮回归证据见[阶段 F 验收报告](../reports/collaboration-stage-f-acceptance.md)。

## 入口与模式边界

- Web 新聊天室默认进入“智能匹配”：Coordination Planner 先给出可执行方案，再选择其运行模式。用户可显式选择 Collaboration、Pipeline 或 Supervisor；这三个显式入口不会被智能匹配替换。
- `POST /api/conversations` 和 `POST /api/runs` 省略 `mode` 时回退到 `collaboration`，这是服务端兼容默认值，不等于 Web 默认选中自由协作。
- Pipeline 保持固定顺序执行；Supervisor 保持任务 DAG、审查和返工状态机；Collaboration 的动态 Dispatch 不改变这两条显式模式的语义。

## Dispatch、Batch 与终局

- 一个 Conversation 可以有多轮 Run。Collaboration 以 Dispatch 表示一次 Agent 投递，以 Attempt 记录实际执行、输入上下文、输出、错误和租约；`ask_many` 建立 Batch，将多个 fanout Dispatch 的结果回流到唯一 Aggregate Dispatch。
- 不同 Agent 可并行领取；同一 Conversation 中同一 Agent 同时只运行一个 Attempt。队列和 Agent Slot 在数据库事务内领取，防止竞态。
- fanout 的原始输出写入 Attempt，供 Aggregate 构造上下文；成功发言同时作为 `collaboration_contribution` 消息持久展示，发送者为实际 Agent。这条消息是协作发言，不是最终报告，不参与默认“最近回复者”路由，也不重复注入模型上下文。
- 发起者汇总后才发布面向用户的 `collaboration_result`。重复的 fanout 回发不会另建终局 Dispatch；稳定消息 ID 与 Dispatch 幂等键防止重试、刷新和重连导致重复发言。
- Dispatch 完成时，消息、控制动作、子 Dispatch、Attempt、Batch 和 Run 终态在同一事务提交；事务中的实时事件在提交成功后广播，回滚不泄露虚假的完成状态。

## 安全、恢复与可观测性

- 深度、目标数、Dispatch 总数、预算和乒乓交接均受限。路由保护命中时留下 `blocked` Dispatch 与 Guard Trace；预算耗尽或 Agent 提问时 Run 进入 `waiting_for_user`，Decision 和 BudgetRevision 幂等持久化。
- 重启后可恢复排队项和安全可重试的中断 Attempt；已执行写工具等可能产生外部副作用的 Attempt 不自动重放。待用户决策在重启后保持，停止操作把相关项收敛到终态。
- Trace 层级为 `collaboration:<runId> → dispatch:<dispatchId> → agent:<agentId> → llm/tool/control`；用户决策另有 orchestration Span。右侧协作面板展示 Dispatch、Batch 进度、Attempt 输入与输出、错误、去重关系、预算和停止操作；聊天区显示持久发言与最终报告，房间切换后定位最新消息。

## 当前边界

历史 Run 不自动补写修复前缺失的 fanout 发言，以免改变原始消息顺序；其输出仍可从 Attempt 查看。用户实测中第三轮 fanout 超时属于独立问题，不应归因于发言持久化缺口。阶段 F 自动化覆盖模型、数据库和前端视图模型；真实浏览器下的视觉与交互仍需在部署环境单独走查。
