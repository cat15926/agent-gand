# Runtime Agent API v2

## 目标

Agent API v2 把模型看到的协作工具从调度实现名称收敛为领域语义名称。新 Collaboration Run 只允许冻结 `executionPolicy.toolApiVersion=2`；历史版本仍可只读解释，不再交给当前 worker 执行。

| v2 工具 | 模型填写 | Runtime 生成或校验 |
| --- | --- | --- |
| `agent.complete` | `summary` | Subject、Attempt、generation、Candidate 和 commandKey |
| `agent.handoff` | `target`、`objective`、`reason` | Subject、generation、接球义务和 commandKey |
| `agent.consult` | `targets`、`objective`、`reason`；启用 any 时填写 `join` | 子 Subject、Batch、winner、consult 义务和 commandKey |
| `agent.hold` | 用户问题，或 timer/dependency 的领域参数 | Hold、绝对时间、Subject、generation、claimToken 和 commandKey |

`agent.propose_supervisor_task` 暂时保留为用户决策型 Hold 的专用入口。冻结 `consultAnyVersion=1` 的权威 Run 会向 `agent.consult` 增加 `join=all|any`；缺少该版本的历史 Run 只读保留原 schema。`any` 的 winner、代际和汇合义务全部由 Runtime 生成，详见 [Runtime consult(any)](./runtime-consult-any.md)。

模型不能提交 `subjectId`、`generation`、`obligationId`、`claimToken` 或 `commandKey`。这些字段只能从当前执行上下文和 Runtime 状态派生。

冻结 `externalWaitVersion=1` 的权威 Run 会把 `agent.hold` 扩展为 `user/timer/dependency` 三种 mode；缺少该版本的历史 Contract 仍可只读解释。通用 external event 不进入 Agent API，详见 [Runtime 外部等待入口](./runtime-external-waits.md)。

## 版本化暴露

`collaborationControlTools(toolApiVersion)` 是唯一工具集合入口：

- `toolApiVersion=1`：模型工具暴露已退役，调用会失败；
- `toolApiVersion=2`：只向模型暴露 `agent.complete`、`agent.handoff`、`agent.consult`、`agent.hold` 和 `agent.propose_supervisor_task`；
- `consultAnyVersion=1`：只扩展 `agent.consult` 的领域参数，不新增第二个工具名；
- 旧别名不再由当前 worker 暴露或执行。

LLM Span 的 input 会记录实际下发工具名，可以据此审计某个 Run 是否遵守冻结版本。

## 历史 Alias 只读解释

阶段 1–5 已经创建过 `toolApiVersion=2` 的 Contract，但当时的二进制仍可能把 `agent.send_message/ask_many/wait_for_user` 写进 `tool_calls_ready` checkpoint。阶段 10 清理前，库存门禁确认不存在引用旧别名的活跃 checkpoint。

当前行为：

- Provider 只收到 v2 工具 schema；
- 当前 v2 执行路径的 `parseControlCall()` 明确拒绝旧别名；
- 历史数据解释可显式传入 `historicalAlias: true`，将旧参数归一化为 RuntimeControlAction，但不会创建模型调用或继续执行 checkpoint。

终态历史动作和 checkpoint 保留，不因清理而改写；详见 [Runtime ProgressDigest 与兼容清理门禁](./runtime-progress-digest-compatibility-retirement.md)。

## 验收

```bash
pnpm verify:runtime-agent-api-v2
pnpm verify:runtime-control-actions
pnpm verify:runtime-consult-any
pnpm verify:collaboration
pnpm verify:runtime-compatibility-retirement
pnpm typecheck
```

专项测试验证 v1 暴露拒绝、v2 参数归一化、当前执行拒绝旧别名、显式历史解析，以及新 Run 的 LLM Trace 中只存在 v2 名称。
