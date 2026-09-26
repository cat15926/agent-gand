# Runtime ExitGuard

## 目标与位置

ExitGuard 是 AgentTurn 与 Dispatch/Completion 提交之间的纯判定层。它不直接写数据库、不执行工具，也不提交 Subject 或 Run 终态，只回答“当前责任是否可以离开本回合”。

```text
AgentTurn 候选输出
  → ControlAction v2 归一化
  → ExitGuard
      ├─ allow_candidate
      ├─ continue_same_turn
      ├─ wait
      ├─ fail_attempt
      └─ needs_attention
  → Scheduler / 后续 CompletionCandidate
```

这使普通正文、显式完成申请和技术中断不再共享同一个“回合结束即成功”的隐式语义。

## 判定输入

`runtime/exitGuard.ts` 的 `evaluateExitGuard()` 是无数据库、无副作用的纯函数，输入包括：

- 技术停止原因：正常、截断、审批等待、空回复、取消或错误；
- 规范 `RuntimeControlAction`；
- 当前输出和可信证据数量；
- Attempt 是否仍持有有效执行权、holder 是否匹配；
- 未终结后继义务数量；
- 当前协议是否允许隐式直答；
- 已用纠偏次数和剩余预算；
- 入场时冻结的 ExitGuard 策略。

当前以活跃 Collaboration Attempt 作为执行权事实来源。类型化 Successor Obligation 已接管开放后续责任；新版 Run 使用 [EvidenceBundle 与证据感知防循环](./runtime-evidence-context-loop-guard.md)，ExitGuard 的证据数量只读取当前 Attempt 已完成的 ToolExecution 账本，不从模型文字推测。

## 决策规则

| 条件 | 结果 |
| --- | --- |
| 截断、空回复、取消、执行错误 | `fail_attempt` |
| 审批等待 | `wait` |
| 缺少有效执行权或 holder 不匹配 | `needs_attention` |
| 合法 `handoff/consult` | `allow_candidate` |
| 合法 `hold` | `wait` |
| `cancel` 由 Agent 提交 | `needs_attention` |
| `complete` 有交付结果且无开放义务 | `allow_candidate` |
| 简单 `initial/fanout` 的完整普通答案 | `allow_candidate` |
| 动态 `handoff/resume/aggregate` 的普通答案 | `continue_same_turn`；耗尽后 `needs_attention` |
| 缺输出的完成申请 | `continue_same_turn`；耗尽后 `fail_attempt` |
| 存在开放后继义务时申请完成 | `continue_same_turn`；耗尽后 `needs_attention` |

`allow_candidate` 只允许结果进入下一层，不等于 Runtime 已确认 Subject 或 Run 完成。持久化 CompletionCandidate 和 SubjectCompletionEngine 已接管新版本 Run 的最终提交，详见 [Runtime Subject Completion](./runtime-subject-completion.md)。

## 同一 AgentTurn 纠偏

新 Run 默认最多纠偏一次。ExitGuard 返回 `continue_same_turn` 时，执行器把结构化反馈追加到原有上下文，并保存 `exit_correction` checkpoint。纠偏具备以下硬边界：

1. 仍使用相同 Attempt、执行权和 `executionScopeId`；
2. 只下发 `agent.complete/send_message/ask_many/wait_for_user/propose_supervisor_task` 控制工具；
3. 不下发或执行文件、Shell、HTTP 等普通工具，避免重复副作用；
4. 单次输出 token 受冻结策略限制；
5. 次数耗尽、预算不足或纠偏阶段请求普通工具时显式阻断；
6. checkpoint 恢复后继续使用已经消费的纠偏次数。

Mock Provider 识别内部纠偏标记并把前一轮答案作为 `agent.complete.summary`，用于确定性端到端验收。真实 Provider 看到的是同样的控制工具约束和结构化反馈。

## Run 级冻结与兼容

新 Collaboration Run 在 `RuntimeRunContract.features.exitGuard` 中冻结：

```ts
{
  version: 1,
  maxCorrections: 1,
  correctionMaxTokens: 2048
}
```

默认值可由 `COLLAB_EXIT_GUARD_MAX_CORRECTIONS` 和 `COLLAB_EXIT_GUARD_CORRECTION_MAX_TOKENS` 调整，但只影响之后入场的 Run。已冻结 Contract 使用 insert-only 语义，不会被部署期配置覆盖。

缺少 `exitGuard` 字段的历史 Run 不启用新门禁，继续沿用原退出语义；v1 动作 Run 也不会看到新增的 `agent.complete` 工具。

## 可观测性

每次关键判定写入 `exit_guard:<status>` orchestration span，记录：

- Dispatch、Agent 和纠偏次数；
- 判定状态与稳定原因码；
- 完整判定输入和输出。

纠偏 LLM span 使用 `orchestration.phase=agent.exit_correction`，可核对其工具列表只包含协作控制工具。

## 当前阶段边界

- `approval_wait` 已在纯语义中返回 `wait`，当前 Scheduler 仍沿用既有 blocked 展示；阶段 6 的 Durable Hold/Wake 会接管持久等待和唤醒。
- 开放义务当前由 Dispatch 关系投影计算；阶段 4 会改为类型化 Successor Obligation。
- 新版本 Run 的 `allow_candidate` 会先持久化 Candidate，再由 SubjectCompletionEngine 接受或拒绝；历史 Run 继续使用冻结的兼容路径。

## 验收

- `pnpm verify:runtime-exit-guard`
- `pnpm verify:runtime-control-actions`
- `pnpm verify:collaboration-exit`
- `pnpm verify:collaboration`
- `COLLAB_COMPLETION_ENGINE=true COLLAB_RUNTIME_SHADOW=true pnpm verify:collaboration`
- `pnpm typecheck`
