# Runtime ControlAction v2

## 目标

Runtime ControlAction v2 把模型/历史数据使用的多种动作结构归一化为单一内部协议。Scheduler、Custody Shadow 和 Completion Store 不再直接分支处理 `finish`、`implicit_complete`、`ask_many` 等历史名称。

本阶段统一动作语言和版本边界；`answer_candidate` 是否允许退出由已落地的 ExitGuard 判定。

## 规范动作

`RuntimeControlAction` 是带 `version: 2` 的判别联合：

- `complete`：Agent 显式申请完成；
- `answer_candidate`：Agent 给出自然语言答案但没有显式完成动作；
- `handoff`：把当前责任交给一个目标；
- `consult`：创建一个或多个咨询分支，并声明 join 策略；
- `hold`：等待用户决策；
- `cancel`：规范协议保留的取消申请，当前 Agent 无权直接取消 Run。

`complete` 与 `answer_candidate` 必须是不同类型。`complete` 可携带最终 `summary`，后者不是 Subject 完成事实；ExitGuard 只允许简单首轮直答走隐式快路径，动态协作步骤必须补交显式处置。详见 [Runtime ExitGuard](./runtime-exit-guard.md)。

## Legacy Adapter

`runtime/controlAction.ts` 是唯一的历史动作归一化入口：

| 历史动作 | v2 动作 |
| --- | --- |
| `finish` | `complete` |
| `implicit_complete` | `answer_candidate` |
| `handoff.message` | `handoff.objective` |
| `ask_many.question` | `consult.objective`，`join=all` |
| `wait_user` | `hold(user_decision/agent_question)` |
| `propose_task` | `hold(user_decision/supervisor_task_proposal)` |

归一化返回动作来源：`native_v2`、`legacy_v1` 或 `answer_candidate`。未知类型、缺少必需字段和历史 Run 中出现 v2 动作都会返回结构化错误；Scheduler 将 Attempt 标为 blocked/failed 并写入 Trace 和系统消息，不会降级成完成。

## 版本冻结

`RuntimeRunContract.features.controlActionVersion` 决定 Run 的动作协议：

- 新 Collaboration/Coordination Run 写入 `2`；
- 没有 Contract 或 Contract 没有该字段的历史 Run 固定为 `1`；
- Contract 使用 insert-only 冻结，部署时默认值变化不能覆盖已经入场的 Run。

控制工具根据冻结版本产生相应存储结构。Scheduler 随后统一归一化为 v2 执行：新 Attempt 持久化 v2，历史 v1 Run 继续持久化旧结构。API 因此允许 v1/v2 数据并存，但 Runtime 执行路径始终只接收 v2。

## 边界

- `agent.ask_many` 是 LLM 工具名，可以保留；它产生的 Runtime 动作是 `consult`。
- Completion Store 读取历史 Attempt 时必须先经过 Adapter。
- Custody 观察器为重放测试兼容 v1 输入，但进入状态迁移前必须完成归一化。
- `consult join=any` 已进入协议类型，当前 Scheduler 尚未放量，若被直接提交会显式阻断。
- `cancel` 尚未暴露为 Agent 工具；Agent 直接提交时显式阻断，用户 Stop 仍走现有授权路径。

## 验收

- `pnpm verify:runtime-control-actions`
- `pnpm verify:runtime-shadow`
- `pnpm verify:runtime-completion-integration`
- `pnpm verify:collaboration-exit`
- `pnpm verify:collaboration`
- `COLLAB_COMPLETION_ENGINE=true COLLAB_RUNTIME_SHADOW=true pnpm verify:collaboration`
- `pnpm typecheck`

端到端验收额外断言：新 Run 的 handoff Attempt 保存 `version=2,type=handoff`；简单首轮普通正文保存 `answer_candidate`，动态 handoff 接手者经同轮纠偏后保存 `complete`。
