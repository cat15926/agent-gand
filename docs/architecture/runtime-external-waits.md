# Runtime 外部等待入口

## 冻结能力与开放边界

阶段 8 为新建且 Runtime 状态权威的 Run 冻结 `externalWaitVersion=1`。缺少该标记的存量 Run 保持原 `agent.hold(question, reason)` schema，部署升级不会动态扩大其模型能力。

启用后，`agent.hold` 只向模型开放三种条件：

| mode | 模型参数 | Runtime 派生或校验 |
| --- | --- | --- |
| `user` | `question`、`reason` | Decision、Subject、generation、Hold、commandKey |
| `timer` | `delaySeconds`、`reason` | 绝对 `wakeAt`、Subject、generation、WakeEvent |
| `dependency` | `targets`、`policy=all\|any`、`timeoutSeconds`、`reason` | 同 Run 唯一 Subject ID、绝对 `timeoutAt`、恢复载体 |

`delaySeconds/timeoutSeconds` 限制为 1～604800 秒。解析控制调用时即换算为绝对 ISO 时间并持久化到 ControlAction，重试或进程重启不会重新从相对时长推导。

dependency 的模型输入是聊天室成员 ID，不是 Subject ID。Runtime 只接受同 Run 中能唯一映射的其他 Subject：当前 holder、pending holder，或仍在 queued/running Dispatch 的目标成员。空集合、重复、自依赖、跨 Run、缺失或歧义映射都会在动作事务中失败。

通用 external event 不进入 Agent Tool schema。没有服务端注册的可信事件接收器时，模型不能创建 event Hold。

## Hold 与恢复事务

timer/dependency 使用既有公共 Hold/Wake 内核：

```text
agent.hold
  → 公共 hold command
  → Custody waiting + Durable Hold + Attempt completed
  → Completion Engine 返回 waiting
  → timer/dependency fact 形成 WakeEvent
  → 租约 claim + 公共 wake command
  → Resume Dispatch + generation link + Hold resumed
```

开放 external Hold 时，`EXTERNAL_CONDITION_PENDING` 是等待结论，不是完成拒绝或 Run 失败。dependency 的 `all` 在任一依赖失败/取消时结案，`any` 在全部终结且无人完成时结案；未在绝对期限内满足则按 `onTimeout=fail` 确定性关闭。

Legacy/shadow Run 不获得新增 Tool schema。`atomic_compat/execute` 新 Run 冻结该能力；历史 Contract 缺少版本时继续按原工具和恢复语义执行。

## 注册 External Event 接收器

服务端代码使用 `registerRuntimeExternalEventReceiver()` 注册可信接收器，注册项包含稳定 receiver ID、payload schema 版本和校验函数。没有动态 HTTP 注册入口，也不会把 receiver/eventKey 暴露给模型。

注册事件信封固定包含：

- `receiverId` 与 payload schema version；
- `runId` 作用域；
- `correlationId`；
- 正整数 `generation`；
- 上游 `sourceEventId`；
- 通过接收器校验且不超过 16 KiB 的 payload。

Runtime 从 receiver/correlation/generation 生成不可碰撞的订阅键，并从 receiver/sourceEventId 生成去重键。同一来源事件重复投递返回同一 WakeEvent；改变 Run、correlation、generation 或 payload 的冲突重放会被拒绝。事件可以先于 Hold 到达，后建立的同作用域订阅仍能匹配；跨 Run 和旧 generation 事件只保留审计，不能唤醒当前 Hold。事件时间晚于 `timeoutAt` 时也不能重新打开 Hold。

首个真实接收器是 `coordination.resume.v1`。Coordination 暂停 Hold 使用 `runId:attemptId` 作为 correlation、Plan revision 作为 generation，并冻结超时策略；用户调用现有 Resume API 时，服务端写入经过 schema 校验的注册 WakeEvent。每次暂停使用不同 correlation，较早暂停的事件不会唤醒后续暂停。

## 观测

Run/Collaboration API 已返回 Durable Hold、WakeEvent 和恢复审计。右侧面板额外展示 dependency Subject、注册 receiver、correlation、事件 generation、wake/timeout 和最终错误。注册事件信封保存在 WakeEvent payload 中，可关联来源事件且不需要新增可变执行权表。

## 验收

- `pnpm verify:runtime-external-waits`
- `pnpm verify:runtime-completion`
- `pnpm verify:runtime-durable-holds`
- `pnpm verify:runtime-hold-recovery-v2`
- `pnpm verify:runtime-coordination-closure`
- `pnpm verify:collaboration`
- `pnpm verify:runtime-compatibility-retirement`
- `pnpm verify:coordination`
- `pnpm typecheck`
- `pnpm verify:docs`
