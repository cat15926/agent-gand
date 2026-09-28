# Runtime Durable Hold/Wake

## 责任边界

阶段 6 把“正在等待什么、由谁继续、何时允许继续”从进程内状态升级为 Runtime 的持久化事实：

```text
Subject + holder/generation
  → Durable Hold（冻结条件、截止时间、恢复策略、幂等键）
  → WakeEvent / 到期条件 / 依赖状态
  → 租约式竞争 claim
  → Resume Dispatch 或 Run Wake
```

新 Collaboration Runtime Run 在 Contract 中冻结 `durableHoldVersion=1`。缺少该标记的历史 Run 继续使用原用户决策与恢复路径，不因部署后开关变化而改写语义。

## Hold 模型

`runtime_holds` 保存 Run、Subject、来源 Dispatch/Attempt、holder、generation、条件、截止时间、恢复策略、幂等键和状态。支持条件：

- `user_decision`：等待指定 Collaboration Decision；
- `approval`：等待指定工具审批卡；
- `timer`：到达冻结的 `wakeAt`；
- `event`：收到指定业务事件键；
- `dependency`：指定 Subject 按 `all | any` 到达完成态；
- `lease_recovery`：指定 Attempt 已中断且租约截止时间已到。

恢复策略分为创建 `resume` Dispatch、唤醒原 Run，以及确认既有 Dispatch 已安全重新排队。CompletionCandidate 对新版 Run 直接读取开放 Hold，不再把“存在用户决策行”当作完整等待事实。

## Wake 与竞争

外部事实先以幂等键写入 `runtime_wake_events`。定时器、依赖和租约条件由扫描器在满足时生成系统 WakeEvent。扫描器使用 SQLite `BEGIN IMMEDIATE` 和条件更新把 `open` Hold 竞争性变为 `claimed`，并冻结 claim owner、token 和 30 秒租约；同一时刻只有一个执行者能接管。

Resume Dispatch、generation fencing 和 Hold `resumed` 在同一事务提交。进程在 claim 后崩溃时，租约到期后新进程可重新 claim；若 Run 已终结、holder 改变或 generation 漂移，唤醒会被拒绝。用户停止或其他 Run 终态会把全部 `open/claimed` Hold 关闭，取消后迟到 WakeEvent 只保留审计记录，不能重新打开 Run。

## 接入点

- Collaboration `hold(user_decision)`：动作事务内建立 Hold，用户回答后由 Wake 恢复同一 Subject；
- 工具 Approval：创建审批卡时建立 `wake_run` Hold，审批结果形成 WakeEvent；
- Collaboration 租约回收：安全重试分支记录 `lease_recovery` Hold；
- 服务启动和每秒扫描：先处理到期/已满足 Hold，再恢复对应调度器；
- API、WebSocket 和右侧面板：展示 Hold 状态、恢复策略、deadline、错误与 WakeEvent。

## 验收

- `pnpm verify:runtime-durable-holds`
- `pnpm verify:runtime-atomic`
- `pnpm verify:runtime-subject-completion`
- `pnpm verify:p0-tools`
- `COLLAB_COMPLETION_ENGINE=true COLLAB_RUNTIME_ATOMIC=true pnpm verify:collaboration`
- `pnpm typecheck`

专项用例覆盖重启前后唤醒、重复事件、定时器竞争、Stop/Wake 竞态、过期租约、审批到达、依赖满足和取消后的迟到事件。
