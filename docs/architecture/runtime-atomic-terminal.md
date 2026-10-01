# Runtime 原子终局

## 目标

Runtime 拥有执行权的 Run 只能通过 `commitRunTerminal()` 进入终态。该命令把终态竞争、Completion Evaluation、最终报告及 Runtime 关闭动作纳入一个 SQLite 事务，消除“报告已显示但 Run 未完成”或“Stop 覆盖已完成结果”等半状态。

## 数据模型

- `runs.terminal_disposition`：记录 `accepted`、`authorized_partial`、`delegated`、`failed` 或 `cancelled`。
- `runtime_run_terminals`：每个 Run 至多一行，记录最终状态、disposition、Completion Evaluation 序号、报告消息、reason code、来源和提交时间。
- 最终报告沿用 `messages`，并使用稳定的 `client_message_id` 保证幂等。

历史终态 Run 没有 `runtime_run_terminals` 时按只读兼容记录解释，不补写、不重放。

## 提交顺序

`commitRunTerminal()` 在 `BEGIN IMMEDIATE` 内执行：

1. 读取既有终局；若已有赢家，直接返回，迟到命令不得覆盖。
2. 对 `runs` 执行条件更新，仅允许非终态进入一次终态。
3. 关闭调用方执行载体，例如 Collaboration Dispatch 或 Coordination Plan。
4. 在同一事务内重读最终状态并生成 Completion Evaluation；`completed` 必须是 `accepted`，且 disposition 必须一致。
5. 记录 Evaluation，关闭 Durable Holds 和开放的后继义务。
6. 幂等写入最终报告，更新用户消息投递状态。
7. 写入 `runtime_run_terminals`，提交事务后才广播消息和 Run 更新。

任何一步失败都会回滚 CAS、报告和关闭动作。进程在提交前被终止时数据库保持事务前状态；提交后被终止时数据库保持完整终态。

## 接入边界

- Collaboration execute 的完成、拒绝和用户 Stop 使用公共终局命令。
- Coordination execute 的完成、失败和取消使用公共终局命令。
- legacy、Pipeline 和 Supervisor 暂由 `finishRun()` 兼容；该函数也已增加终态 CAS，但不冒充 Runtime 完成判定。
- execute 路径不得直接调用 `finishRun()`。

API 的 Collaboration/Coordination 详情返回 `terminal`，Run 本身返回 `terminalDisposition`；前端在协作栏展示用户可理解的终局类型。

## 验收

`pnpm verify:runtime-terminal` 覆盖：

- Complete、Fail、Cancel 跨进程竞争只有一个赢家；
- 最终报告及终局记录只有一份，状态与 disposition 一致；
- 外层事务回滚不发送消息或 Run 更新事件；
- Completion 校验失败完整回滚；
- 提交前/提交后 SIGKILL 分别只留下事务前/事务后完整状态；
- 终局提交同步关闭 Hold 与开放义务。
