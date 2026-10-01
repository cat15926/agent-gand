# Runtime Responsibility Snapshot 与 Blocker Projection

状态：阶段 2 已实施。本文定义 Collaboration 与 Coordination 共用的责任读取和完成阻断口径。

## 唯一读取模型

`apps/server/src/runtime/responsibilitySnapshot.ts` 从现有真相表同步组装责任快照，不维护第二张异步投影表：

- `runtime_subjects` 与 `runtime_custody`：Subject 状态、持有者、代际和行版本；
- Collaboration/Coordination Attempt：当前执行者、状态、claim generation 和租约；
- `runtime_successor_obligations`：每个 stable key 最新 generation 的必需义务；
- `runtime_holds`：当前 generation 中处于 open/claimed 的外部等待。

快照在调用方已有 SQLite 写事务时读取该事务内最新状态。CompletionCandidate 在提交事务内重新加载快照，不使用模型调用前缓存的责任状态。

## Blocker 分类

所有消费者使用同一个 `RuntimeCompletionBlocker`：

| category | 含义 | 典型 code |
| --- | --- | --- |
| `control_action` | 结果可能完整，但缺少明确控制动作 | `MISSING_CONTROL_DISPOSITION` |
| `work` | 仍需完成或处置必需义务 | `REQUIRED_OBLIGATION_PENDING/FAILED/CANCELLED` |
| `external` | 等待用户、审批、事件或其他外部条件 | `EXTERNAL_CONDITION_PENDING` |
| `stale_responsibility` | Attempt、lease、holder 或 generation 已失效 | `ATTEMPT_GENERATION_STALE`、`CUSTODY_HOLDER_MISMATCH` 等 |

必需义务的 `failed` 和 `cancelled` 不等于 `satisfied`。被新 generation 替代的旧记录不重复进入当前投影；最新 generation 若为 failed/cancelled，仍会明确阻止完成。

## 消费边界

- ExitGuard：使用快照 blocker 决定完成、隐式答案或同轮纠偏，不再通过 child Dispatch 数量推断责任。
- Context：显示所有必需未满足义务的具体状态，以及相同 blocker code、category 和引用。
- SubjectCompletion：事务内重新读取快照，再判定 Candidate；旧 generation 即使 agentId 相同也不能提交。
- Run Completion：只让冻结 Contract 中的 required Subject 和必需义务决定终局；非必需 consultation 不因 child Subject 数量阻塞父 Subject。
- API/UI：Run 详情及 `/api/runs/:runId/responsibility` 暴露相同快照；协作面板按四类 blocker 展示原因和引用。

## 验收

专项命令：

```bash
pnpm verify:runtime-responsibility
```

覆盖必需 review 无 child Dispatch、failed/cancelled 义务、非必需 consultation、外部 Hold、旧 generation Attempt，以及 Context、ExitGuard、Completion、API/UI reason code 一致性。
