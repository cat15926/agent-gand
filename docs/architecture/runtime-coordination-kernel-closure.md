# Runtime Coordination Kernel 收口

> 实施阶段：Runtime v2 责任闭环阶段 7  
> 状态：已接入，按 `COORDINATION_RUNTIME_PROTOCOLS` 灰度

## 1. 保留与收口边界

Coordination 继续负责规划、DAG、协议屏障、Step Attempt、Revision 和前端结构。公共 Runtime 负责 Step 的责任与完成语义：

```text
Coordination Step 输出
  → RuntimeControlAction v2
  → ExitGuard
  → CompletionCandidate + EvidenceBundle
  → SubjectCompletionEngine
  → Subject/Custody 投影
  → Run Completion Engine
```

`completion_gate` 是无 Agent、无 Subject 的 Plan 屏障，不生成第二个 Candidate；它只在所有依赖 Step 已完成后开放 Plan 终局判定。

## 2. Step 提交契约

- Agent Step 的正文被规范化为 `complete` 动作，并与 Attempt 一起冻结。
- Review FAIL 冻结为中间 `answer_candidate`，创建或推进类型化 `review_revision` 义务，不关闭 Reviewer Subject。
- Review PASS、普通 Agent Step、fanout、aggregate 和 debate 发言都必须先通过 ExitGuard。
- execute Run 必须持久化 CompletionCandidate；SubjectCompletionEngine 验证 holder、generation、Attempt、EvidenceBundle、Hold、后继义务、依赖、产物和协议条件。
- Candidate 接受、Attempt 完成、Custody 完成和 Step 完成位于同一个数据库事务；拒绝则在同一事务中落 Candidate、失败反馈和 retry/failed 投影。
- 历史 Run 和 Shadow Run 继续使用原有 Step 完成读取器，不会在重启后改变被冻结语义。

## 3. 等待与恢复

Coordination 工具审批现在会把 Attempt 映射到 Coordination Subject，并创建 `approval` Hold。审批决策可见后，Agent 必须等待对应 Hold 完成 Wake 投影，避免“审批已通过但 Hold 尚未关闭”的 Candidate 竞态。

审批连续超时导致 Plan 暂停时，系统在等待态 Subject 上创建 `event` Hold。用户恢复会写入幂等 WakeEvent，由公共恢复器竞争 claim、恢复 Run，再复用原 Step Attempt 和新 custody generation。显式的安全边界暂停仍由 Plan 控制语义负责，不伪造 Agent 等待条件。

## 4. Plan 终局与唯一输出

execute Run 只有 `finalizeCoordinationKernelPlan()` 可以请求 Plan 终局。它读取公共 Subject/Custody、accepted Candidate、EvidenceBundle、类型化义务、依赖、Review 和协议终局条件，并调用公共 Run Completion Engine。

公共引擎返回 `accepted` 后，Coordination 才能写入 Plan/Run completed。各 Step 消息仍按 Attempt 稳定键发布；Plan 收口不再生成第二条 Agent 最终报告，因此恢复和重放不会重复用户可见结论。

## 5. 灰度与回退

- `COORDINATION_RUNTIME_KERNEL=shadow`：创建公共投影并记录 Completion 对比，但旧路径仍是执行权威。
- `COORDINATION_RUNTIME_KERNEL=execute`（当前默认）：仅当 Plan 的全部协议都在 `COORDINATION_RUNTIME_PROTOCOLS` 中时接管；否则自动降级 Shadow。
- 推荐放量顺序：`single_agent,sequential_pipeline` → `parallel_fanout,supervisor_aggregation` → `review_revision` → `debate`。
- Contract 冻结 `coordinationKernel`、ExitGuard、CompletionCandidate、Obligation、EvidenceBundle、Context 和 Durable Hold 版本。修改环境变量不会改变已入场 Run。
- 回退只需从 allowlist 移除协议或切换到 Shadow；历史 execute Run 仍按已冻结 Contract 恢复。

## 6. 验收不变量

1. 每个有 Agent 的成功 Step 恰有一个 accepted Candidate，Completion Gate 没有 Candidate。
2. Candidate 接受前必须有 `allow_candidate` ExitGuard 和可信 EvidenceBundle。
3. 开放 Hold、开放必需义务、错误 holder/generation、缺产物或 Review 未通过都不能完成 Subject。
4. 重试、暂停恢复和 Revision 不得重开终态 Subject，也不得重复执行已完成工具。
5. Plan completed 前最后一次 Completion Evaluation 必须为 accepted。
6. 三轮 Debate 只能产生六条辩手结果和一条裁判结果，完成后不得追加第二条终局报告。

专项入口：`pnpm verify:runtime-coordination-closure`；全协议端到端入口：在 execute 环境下运行 `pnpm verify:coordination`。
