# Runtime consult(any)

## 目标

`consult(any)` 表示“首个通过 SubjectCompletion 的成功咨询候选胜出”，不是首个返回文本、首个结束的 Attempt 或首个网络响应。新权威 Runtime Run 通过冻结 `consultAnyVersion=1` 获得该能力；历史 Run、Legacy 和 Shadow 继续只使用 `consult(all)`。

## 冻结 Batch

`collaboration_batches` 为每轮咨询保存：

- `join_policy=all|any`；
- `winner_dispatch_id`；
- `generation`；
- `settled_at`；
- `result_dispatch_id`。

这些字段在 Run 内持久化，进程重启后不重新从模型输出或当前配置推导。`agent.consult` 只有在 Contract 冻结 `consultAnyVersion=1` 时才向模型公开 `join` 参数；旧 schema 不会被扩宽，旧 `agent.ask_many` 永远归一化为 `join=all`。

## Winner 事务

```text
fanout Attempt
  → SubjectCompletion accepted
  → 校验 accepted Candidate 属于当前 fanout Dispatch
  → CAS(batchId, generation, winner IS NULL)
  → 满足 any 组义务
  → 取消其他 queued/running fanout 与 Attempt
  → 结算 loser 成员义务
  → 保存 winner 输出
  → 创建唯一 aggregate 和结果消息
```

以上步骤复用 Runtime Action Command 的 `BEGIN IMMEDIATE` 事务。并发成功只能有一个 CAS winner；事务前崩溃不留下 Candidate/winner，事务提交后重放命中相同 command。aggregate 使用稳定消息 ID 和 `aggregate:<batchId>` 幂等键，父级最多收到一个恢复 Dispatch。

只有 `kind=fanout` 的 Dispatch 可以竞选 winner。aggregate 虽然保留 batchId 用于追踪，但不会再次参与 winner CAS。

## Loser 与迟到结果

winner 选出后，未胜出的 queued Dispatch 直接取消，running Attempt 进入协作中止状态；已经在模型侧执行的调用返回时会因 Attempt 失去提交权而丢弃，不能发布贡献、生成 Candidate 或改变 winner。

loser 使用 `CONSULT_ANY_NOT_SELECTED:<winnerDispatchId>` 作为明确终止原因。Completion Engine 会忽略这种预期取消，但仍将普通 failed/blocked/cancelled Dispatch 视为失败。

Runtime 为 `any` 创建一个必需组义务和多个非必需成员义务：winner 成员与组义务为 `satisfied`，未胜出成员为 `cancelled`。这是一种显式 join resolution，不通过子任务数量或“队列已空”猜测完成。

## 失败、超时、Stop 与恢复

- 全部候选失败：组义务标记 `failed`，Batch 为 `failed`，生成一次失败汇总。
- 超时且没有 winner：取消 queued/running 分支，组义务标记 `failed`，Batch 为 `timeout`。
- 用户 Stop：开放 Batch 标记 `cancelled`，其义务与执行载体在终态事务中关闭，不创建 aggregate。
- 重启恢复：无 aggregate 的 Batch 会先尝试确定性汇合；开放 Batch 再恢复超时计时。winner、generation 和 settledAt 均从数据库读取。
- 迟到结果：不能提交 accepted Candidate，也不能覆盖 winner 或重新打开 Batch。

第一版只实现 `all` 和 `any`，不实现 quorum。

## 可观测性与验收

API 和右侧运行面板展示 join policy、winner、generation 与 settledAt；动作账本区分 `consult_all` 和 `consult_any`。

```bash
pnpm verify:runtime-consult-any
pnpm verify:runtime-obligations
pnpm verify:runtime-action-commands
pnpm verify:collaboration
pnpm verify:runtime-compatibility-retirement
pnpm typecheck
```

专项测试覆盖 schema 冻结、accepted Candidate 约束、winner CAS、loser 中止、迟到隔离、事务回滚、全失败、超时、Stop 和义务结算；端到端测试断言单 winner、单 aggregate、单贡献和单最终报告。
