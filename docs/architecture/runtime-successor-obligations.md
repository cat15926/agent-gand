# Runtime Successor Obligation 与 Review Loop

## 目标

阶段 4 把“当前 Subject 结束前还必须发生什么”从 ControlAction 字符、Dispatch 形状和协议分支中抽离，固化为可持久化、可分代、可重放的 Successor Obligation：

```text
ControlAction / Coordination protocol event
  → open Successor Obligation
  → claim / child result / artifact evidence / review PASS / user decision
  → settle the same obligation generation
  → SubjectCompletionEngine
  → Run Completion Engine
```

Agent 不能通过输出“已完成”跳过义务。Runtime 只从结构化义务投影判定新版 Run 是否还有必需后续责任。

## 持久化模型

`runtime_successor_obligations` 保存：

- Run、parent Subject 与可选 target Subject；
- `kind` 和 `status`；
- 产生义务的 `source_action_id`、稳定语义键 `stable_key`；
- `required` 与单调增加的 `generation`；
- 创建 payload、解决来源、解决 payload 与时间。

状态为 `open | satisfied | failed | cancelled`。对完成判定而言，必需义务只有 `satisfied` 算满足；`failed/cancelled` 保留失败事实，不会被当作成功。

两组唯一约束保证：

1. `(run_id, stable_key, generation)` 使同一语义义务的每一代唯一；
2. `(run_id, kind, source_action_id, stable_key)` 使同一源事件重放时返回原记录。

所有 settle 都带 `expectedGeneration` 条件更新。旧代事件可以被观测，但无法改写新代义务。

## 义务类型

| 类型 | 打开时机 | 满足条件 |
| --- | --- | --- |
| `handoff_acquire` | handoff 子 Dispatch 建立时 | 目标 Dispatch 在预期 Subject/generation 上成功 claim |
| `consult_result` | consult fanout 建立时 | `all` 需每个子 Subject 结果；`any` 需任意一个结果 |
| `review_revision` | Reviewer FAIL 时 | 返工目标在更新 generation 完成，且 Reviewer 在更新 generation PASS |
| `artifact_commit` | Coordination Plan 接纳声明产物时 | 目标 Attempt 产物和输出证据全部验证可信 |
| `user_decision` | 预算、Agent 问题或部分结果决策建立时 | 对应决策被明确解决 |

`consult join=any` 用一个必需的组汇合义务和多个非必需成员义务表达。任一成员成功时关闭组义务；单个成员失败不会提前将 `any` 汇合判为失败。

## Review Revision 代际

Review FAIL 使用稳定键 `plan + revision + review step + target step` 打开返工义务，并在 payload 中冻结 target 与 Reviewer 当时的 Custody generation。同一 FAIL Attempt 重放是幂等的；新一轮 FAIL 会取消尚未结束的旧代并创建下一代。

Reviewer PASS 只有同时满足下列条件才能 settle：

1. PASS Attempt 仍是 Reviewer Subject 当前 holder 的 claim；
2. 返工目标已在高于打开时的 generation 完成；
3. Reviewer claim generation 高于打开时的 generation；
4. settle 指定的义务 generation 仍是当前 open 代。

因此，上一轮延迟到达的 PASS 无法关闭新一轮返工。

## Completion 集成

新 Collaboration Run 与 Coordination Kernel Run 在冻结 Contract 中写入：

```ts
features: {
  successorObligationVersion: 1
}
```

- SubjectCompletionEngine 按 parent Subject 统计未满足的必需义务；
- Run Completion Engine 在本次需要汇合的 Subjects 上检查义务；
- 尚有必需义务时返回 `SUCCESSOR_OBLIGATIONS_NOT_SATISFIED`；
- 历史 Contract 没有版本标记时，继续走子 Subject/Dispatch 派生的兼容路径。

停止 Run、取消 Dispatch、技术阻断、终态中断、Plan 失败和 Revision 替换都会显式 settle 关联义务，不留下无主 open 记录。创建、转移与 settle 参与外层数据库事务，实时事件只在提交后发布。

## 观测与验收

API 在 Collaboration Run、Conversation Collaboration 和 Coordination 详情中返回 `successorObligations`。右侧运行面板展示类型、状态、generation、稳定键、parent/target 和解决来源；`runtime.successor_obligation.updated` 用于提交后实时刷新。

专项验收：

- `pnpm verify:runtime-obligations`
- `pnpm verify:runtime-review-obligations`
- `pnpm verify:runtime-subject-completion`
- `pnpm verify:runtime-completion-integration`
- `pnpm verify:runtime-atomic`
- `COLLAB_COMPLETION_ENGINE=true COLLAB_RUNTIME_ATOMIC=true pnpm verify:collaboration`
- `COORDINATION_RUNTIME_KERNEL=execute pnpm verify:coordination`
- `pnpm typecheck`

