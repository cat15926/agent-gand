# Runtime Durable Hold/Wake

## 责任边界

“正在等待什么、由谁继续、何时允许继续”是 Runtime 的持久化事实：

```text
Subject + holder/generation
  → Durable Hold（冻结条件、wakeAt/timeoutAt、恢复策略、幂等键）
  → WakeEvent / 到期条件 / 依赖状态
  → 租约式竞争 claim
  → Resume Dispatch 或 Run Wake
```

新 Collaboration 与 execute Coordination Run 在 Contract 中冻结 `durableHoldVersion=2`。v1 行和冻结为 v1 的 Run 继续按原 `deadlineAt` 语义读取与恢复；缺少该标记的历史 Run 继续使用原恢复路径，不因部署后开关变化而改写语义。

## Hold 模型

`runtime_holds` 保存 Run、Subject、来源 Dispatch/Attempt、holder、generation、条件、恢复策略、幂等键和状态。v2 将时间拆为：

- `wakeAt`：计划条件最早可以成立的时间；
- `timeoutAt`：外部事实仍未成立时的确定性终止边界；
- `onTimeout`：`fail | cancel | wake`；
- `retryCount / nextRetryAt / maxRetries`：恢复执行失败后的指数退避与永久结案边界。

支持条件：

- `user_decision`：等待指定 Collaboration Decision；
- `approval`：等待指定工具审批卡；
- `timer`：到达冻结的 `wakeAt`；
- `event`：收到指定业务事件键；阶段 8 的新入口必须来自服务端注册接收器；
- `dependency`：指定 Subject 按 `all | any` 到达完成态；
- `lease_recovery`：指定 Attempt 已中断且租约截止时间已到。

恢复策略分为创建 `resume` Dispatch、唤醒原 Run，以及确认既有 Dispatch 已安全重新排队。CompletionCandidate 对新版 Run 直接读取开放 Hold，不再把“存在用户决策行”当作完整等待事实。

事件与超时按事实时间裁决：匹配事件的 `createdAt <= timeoutAt` 时事件优先；晚于 `timeoutAt` 的事件只保留审计，不能重新打开 Hold。时间恰好相等也由事件获胜。timer/lease 使用冻结的语义唤醒时间，而不是扫描器实际运行时间，避免进程暂停改变结果。

阶段 8 起，新权威 Run 冻结 `externalWaitVersion=1`。Agent 只可请求 timer 和同 Run dependency；Subject ID 与绝对时间由 Runtime 派生。注册 external event 使用 receiver、Run scope、correlation/generation、sourceEventId 和 payload schema 信封，首个真实接收器为 Coordination Resume。完整边界见 [Runtime 外部等待入口](./runtime-external-waits.md)。

## Wake 与竞争

外部事实先以幂等键写入 `runtime_wake_events`。定时器、依赖和租约条件由扫描器在满足时生成系统 WakeEvent。扫描器使用 SQLite `BEGIN IMMEDIATE` 和条件更新把 `open` Hold 竞争性变为 `claimed`，并冻结 claim owner、token 和 30 秒租约；同一时刻只有一个执行者能接管。

Resume Dispatch、generation fencing 和 Hold `resumed` 在同一公共 Wake 命令事务提交。进程在 claim 后崩溃时，租约到期后新进程可重新 claim；若 Run 已终结、holder 改变或 generation 漂移，Hold 永久关闭，且不会结算新 generation 的任何义务。用户停止或其他 Run 终态会把全部 `open/claimed` Hold 关闭，取消后迟到 WakeEvent 只保留审计记录，不能重新打开 Run。

恢复错误分四类：

| 类型 | 处理 |
| --- | --- |
| `transient` | v2 按 1s、2s、4s…退避，最多 60s；超过 `maxRetries` 后失败结案 |
| `permanent` | 立即失败结案，不再入队 |
| `stale` | 以 `STALE_GENERATION` 失败结案，不触碰后继义务 |
| `terminal` | 取消 Hold，Run 终态优先 |

dependency 的失败也属于结案事实：`all` 中任一依赖失败/取消即不再可满足；`any` 只有在全部依赖都终结且没有完成项时关闭。

每次 claim、退避、成功、失败和取消都会写入 `runtime_hold_recovery_audit`，固定记录 `runId / subjectId / generation / holdId / reasonCode`。API、WebSocket 和右侧面板均展示该审计链。

## 接入点

- Collaboration `hold(user_decision)`：动作事务内建立 Hold，用户回答后由 Wake 恢复同一 Subject；
- 工具 Approval：创建审批卡时建立 `wake_run` Hold，审批结果形成 WakeEvent；
- Collaboration 租约回收：安全重试分支记录 `lease_recovery` Hold；
- 服务启动和每秒扫描：先处理到期/已满足 Hold，再恢复对应调度器；
- API、WebSocket 和右侧面板：展示 Hold 版本、唤醒/超时、重试、类型化错误、WakeEvent 与恢复审计。

## 验收

- `pnpm verify:runtime-durable-holds`
- `pnpm verify:runtime-hold-recovery-v2`
- `pnpm verify:runtime-atomic`
- `pnpm verify:runtime-subject-completion`
- `pnpm verify:p0-tools`
- `pnpm verify:runtime-compatibility-retirement`
- `pnpm typecheck`

v1 用例覆盖重启前后唤醒、重复事件、定时器竞争、Stop/Wake 竞态、过期租约、审批到达、依赖满足和取消后的迟到事件。v2 用例额外覆盖事件/超时边界、event never arrives、依赖失败、临时错误退避、重试耗尽、永久错误隔离、旧 generation 义务隔离、恢复审计以及跨进程 claim 竞争。
