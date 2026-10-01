# Runtime 公共动作命令

## 目标

`complete`、`wake`、`hold`、`handoff` 和 `consult(all)` 不再由各调度器自行拼接多个独立提交。公共命令层为每个逻辑动作建立稳定幂等键，并把领域状态变更和命令账本放在同一个 SQLite 事务中。

公共命令只提交确定性的本地状态。模型调用、网络请求和外部工具副作用必须在命令事务之外完成；外部副作用继续由 ToolExecution Ledger 管理，不能因为动作命令存在就宣称端到端 exactly-once。

## 命令账本

`runtime_action_commands` 每个 `command_key` 至多一行，记录：

- Run、动作类型、Attempt 和 Dispatch 关联；
- 已冻结的命令结果；
- 创建与提交时间。

重复调用先读取账本：参数一致时返回第一次提交的结果，不再执行领域写入；同一键被不同 Run、类型或执行载体复用时直接报冲突。

## 事务语义

公共入口包括：

- `commitCompleteActionCommand()`
- `commitWakeActionCommand()`
- `commitHoldActionCommand()`
- `commitHandoffActionCommand()`
- `commitConsultAllActionCommand()`

每个入口都通过同一个 `BEGIN IMMEDIATE` 边界执行：

1. 检查是否已有相同命令；
2. 拒绝向已终态 Run 提交新动作；
3. 执行动作对应的本地领域写入；
4. 将最小返回值写入命令账本；
5. 提交后再发送 UI/调度事件。

进程在第 3～4 步被终止时，领域写入和命令行一起回滚；事务提交后被终止时，两者都完整保留。

## 动作覆盖

| 动作 | 同一命令事务内提交的主要状态 |
| --- | --- |
| complete | CompletionCandidate/Evidence、Subject/Custody、Attempt、义务结算；必要时继续进入原子 Run 终局 |
| wake | Hold claim 校验、恢复 Dispatch/责任映射、Run 恢复状态、Hold resumed |
| hold | Attempt/Step 动作、Custody waiting、Decision 或恢复订阅、Durable Hold |
| handoff | Attempt、Custody transferring、接球义务、目标 Dispatch、消息、Capsule |
| consult(all) | 父责任等待、Batch、子 Subject/Dispatch、consult_result obligations 和提问消息 |

Collaboration 的 legacy、shadow、atomic_compat 与 execute 都经过命令边界，执行权和 Runtime 状态写入仍按冻结 Policy 决定。Coordination execute 的普通步骤、Completion Gate、review revision、审批暂停与恢复分别接入 complete、hold 和 wake；固定 DAG 协议不会动态产生 handoff/consult 命令。

## 可观测与验收

Collaboration/Coordination 详情 API 返回 `actionCommands`，前端协作栏显示已提交的原子动作。

`pnpm verify:runtime-action-commands` 覆盖：

- 五类命令的幂等账本；
- 同一 handoff 由多个进程竞争时只有一个赢家、一个后继 Dispatch 和一条消息；
- handoff 事务内 SIGKILL 不留下半状态，提交后 SIGKILL 保留完整状态。

此外，四种 Collaboration Profile 和 Coordination execute 端到端用例验证真实调度器确实经过命令账本，而不是只在专项测试中调用包装函数。
