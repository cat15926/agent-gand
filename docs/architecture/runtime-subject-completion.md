# Runtime CompletionCandidate 与 SubjectCompletionEngine

## 目标与责任边界

阶段 3 把“Agent 给出结果”和“Runtime 确认工作项完成”拆成两个事实：

```text
AgentTurn
  → ControlAction v2
  → ExitGuard allow_candidate
  → CompletionCandidate（持久化）
  → SubjectCompletionEngine（纯判定）
      ├─ accepted
      ├─ rejected + 结构化纠偏
      └─ superseded
  → Subject/Custody 完成投影
  → Run Completion Engine 汇合 accepted Candidate
```

`complete` 和 `answer_candidate` 都只能提出候选。Agent、Scheduler 和普通 Attempt 完成记录都不能直接作为新版本 Run 的 Subject 完成证据。

## 持久化模型

`runtime_completion_candidates` 保存：

- Run、Subject、Subject key、Attempt、generation 与提交 Agent；
- 已归一化的 ControlAction、候选摘要和 EvidenceRef；
- ExitGuard 状态与原因；
- `pending/accepted/rejected/superseded` 状态、原因、是否可纠正和反馈；
- 稳定幂等键、创建时间与裁决时间。

默认幂等键为 `completion:<attemptId>`。相同 Attempt 重放返回同一 Candidate 和原裁决，不会重复迁移 Custody，也不会重复生成完成事件。

## SubjectCompletionEngine

`runtime/subjectCompletion.ts` 中的 `evaluateSubjectCompletion()` 是无数据库、无副作用的纯函数。它按以下顺序裁决：

1. Candidate 是否仍对应当前 Subject 和 generation；不匹配时标记 `superseded`。
2. Attempt 是否仍可提交、租约是否有效、执行 Agent 是否一致。
3. Subject 是否为 `active`、Custody 是否为当前 Agent `owned`，且没有待接球者。
4. ExitGuard 是否已经返回 `allow_candidate`，动作是否为完成候选。
5. 是否存在待用户决策、责任转移或未终结后继 Subject。
6. 摘要是否非空、EvidenceRef 是否非空且可信。
7. 依赖、必要产物、Review 和协议终局是否满足。

缺输出、缺证据、开放义务和协议未满足属于可纠正拒绝；无效 Attempt、holder 冲突和非法退出属于不可重试拒绝；旧 generation 永远不能覆盖新责任代际。

阶段 4 会把当前由子 Subject/Dispatch 投影的开放义务替换为类型化 Successor Obligation；阶段 5 会把 EvidenceRef 集合升级为冻结并校验哈希的 EvidenceBundle。

## 原子提交与恢复

在 Atomic 模式下，Candidate 插入与裁决、`subject.completion_accepted` Custody 事件、Subject/Custody 完成投影、Attempt 完成和动作结果写入位于同一外层数据库事务中。故障注入导致事务回滚时，不会留下“Candidate 已接受但 Attempt 未完成”或相反的半状态。

可纠正拒绝会让当前 Attempt 失败，并在尚有 Attempt 预算时把 Dispatch 重新排队、将 Subject/Custody 置为 `waiting`。下一次 claim 执行 `waiting → owned`，Subject 同步回到 `active`。超过重试上限时保留 Candidate 的可纠正语义，但 Custody 进入失败，避免 Run 悬空。

Shadow 模式只在旧事务提交后观察并保存 Candidate，不影响既有调度结果。Atomic 模式才使用 Candidate 裁决决定是否应用动作和完成 Attempt。

## Run Completion 的读取规则

当冻结 Contract 含 `completionCandidateVersion=1` 时：

- Subject 最终摘要、Agent 和 Evidence 只来自该 Subject 最新的 `accepted` Candidate；
- 普通完成不得从“已完成 Attempt”或聊天正文反推 Subject 已完成；
- 最终报告只从 required Subject 的已接受 Candidate 构造，Run 判定同时要求后继 Subject 到达可接受终局；
- 历史 Run 没有该版本标记时继续使用原 Attempt 推断兼容路径。

显式 `partial_user_accepted` 是唯一例外：用户在预算边界授权接受当前部分结果时，可以读取已有 Attempt 输出形成部分报告，但不会把这些输出倒写为 accepted Candidate，也不会改变正常完成的判定规则。

## 纠偏、上下文与观测

Rejected Candidate 的稳定原因和反馈会加入后续 Attempt 的 `completion_feedback` 上下文段，使 Agent 能针对缺失项重试。API 在聊天室和 Run 明细中返回 `completionCandidates`，右侧运行面板展示状态、Subject、generation、摘要、原因和反馈。

每次裁决产生 `completion_candidate:<status>` Trace span，并通过 `runtime.completion_candidate.updated` 推送实时更新。accepted Candidate 的权威状态仍以数据库记录和 Custody 事件为准。

## 版本冻结

启用 Runtime Shadow 或 Atomic 状态层的新 Collaboration Run 会冻结：

```ts
features: {
  completionCandidateVersion: 1
}
```

缺少该字段的历史 Contract 保持旧语义。冻结值不会被部署期配置变化覆盖。

## 验收

- `pnpm verify:runtime-subject-completion`
- `pnpm verify:runtime-completion-integration`
- `pnpm verify:runtime-atomic`
- `pnpm verify:runtime-shadow`
- `COLLAB_COMPLETION_ENGINE=true COLLAB_RUNTIME_SHADOW=true pnpm verify:collaboration`
- `pnpm typecheck`

专项矩阵覆盖 accepted、可纠正拒绝、不可重试拒绝、generation 失效、幂等重放、事务回滚、`waiting → owned` 恢复、Run Completion 绕过防护与部分接受例外。
