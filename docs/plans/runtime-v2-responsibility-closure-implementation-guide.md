# Runtime v2 责任闭环实施指导

> 状态：阶段 0–4 已完成，阶段 5 待实施
> 基线：2026-09-24，`agent-gand/main` @ `4e5ae5b`  
> 前置成果：[Collaboration Runtime Kernel 实施方案](./collaboration-runtime-kernel-implementation-plan.md)  
> 适用范围：Collaboration、Coordination 及后续复用公共 Runtime 的编排入口

## 1. 里程碑定义

上一里程碑已经完成 Contract、Subject、Custody、Capsule、Evidence、Context、Completion Engine 和 Coordination Step Adapter 的第一轮接入。本里程碑不再以“补齐 Runtime v2 组件”为目标，而是收紧这些组件之间的责任边界，使下面的闭环在所有模式中都成立：

```text
模型输出
  → 规范化 ControlAction / AnswerCandidate
  → ExitGuard 校验本轮是否真的可以退出
  → CompletionCandidate
  → SubjectCompletionEngine 校验责任、义务、证据和协议
  → Run Completion Engine 汇合全部必需 Subject
  → 唯一一次终局提交与用户报告
```

本轮的核心不是增加更多编排协议，而是消除以下残余语义分叉：

1. 模型“说完成”与 Runtime“确认完成”仍有混用。
2. 可恢复错误、等待、返工和真正终态失败的边界不够严格。
3. 后继义务仍以动作字符串和调度分支隐式表达。
4. `hold/wake`、上下文贡献者和证据感知防循环尚未成为公共能力。
5. Coordination 已复用公共存储和判定，但退出路径仍有部分独立逻辑。

## 2. 已具备基础与本轮边界

### 2.1 已具备基础

- 新 Run 可冻结 `RuntimeRunContract` 和运行特性，不随进程开关中途改变语义。
- 并行入口按 root Subject 表达，Dispatch、Attempt 与 Subject 已分层。
- Custody Shadow、原子接球、generation fencing、崩溃恢复和 ToolExecution Ledger 已具备。
- Handoff Capsule、EvidenceResolver、ContextAssembler 和 Completion Engine 已落地。
- Coordination Step 已映射为 Subject，并共用 Custody、Evidence、Context 和 Completion Engine。

### 2.2 明确不做

- 不移植 Clowder 的 per-invocation Worklist。
- 不新增向量库、Blob Store 或第二套调度器。
- 不以自然语言回填历史 Run 的责任状态。
- 不在运行中修改已冻结 Run 的 Runtime 版本和完成语义。
- 不让 Agent 直接写 Run 终态，也不让 Coordination 绕过公共 Completion Engine。

## 3. 必须保持的不变量

1. 截断、空回复、审批等待、用户 Stop、租约丢失和进程中断都不能隐式完成 Subject。
2. Agent 的 `complete`、`finish` 或普通正文只产生候选；只有 Runtime 能提交 Subject/Run 终态。
3. 单持有型 Subject 任一 generation 至多一个有效 holder；迟到结果不能覆盖新 generation。
4. handoff request 只创建待接球义务，目标成功 acquire 后才转移 holder。
5. consult 不转移父 Subject；并行 root Subject 必须按 Contract 汇合。
6. 可重试失败只能关闭当前 Attempt，不能提前关闭同 Run 的其他 Subject。
7. Completion 的终态失败优先于普通 `OPEN_DISPATCH/OPEN_BATCH` 等待，但用户尚可决定的部分接受流程除外。
8. `evidenceValid=true` 必须至少有一项可信的最终输出证据；空证据集合不能因 `every([])` 判真。
9. 后继义务必须有类型、状态、稳定键和归属，不能只靠字符串推断。
10. 最终报告按稳定键只发布一次；恢复、重放和竞态都不能生成第二份终局。

## 4. 实施顺序

| 阶段 | 目标 | 当前状态 |
| --- | --- | --- |
| 0 | 稳定化：重试隔离、Custody 合法迁移、证据非空、失败优先级 | 已完成 |
| 1 | 规范化 ControlAction v2 与 Legacy Adapter | 已完成 |
| 2 | ExitGuard 与同轮纠偏 | 已完成 |
| 3 | CompletionCandidate 与 SubjectCompletionEngine | 已完成 |
| 4 | 类型化 Successor Obligation 与 Review Loop | 已完成 |
| 5 | EvidenceBundle、防循环和 Context Contributor | 待实施 |
| 6 | Durable Hold/Wake | 待实施 |
| 7 | Coordination 统一退出路径与旧分支收口 | 待实施 |

阶段必须按顺序推进。后一阶段可以先补纯类型和纯函数测试，但不得在前一阶段验收前切换执行权。

## 5. 阶段 0：稳定化修复

### 5.1 Coordination 重试失败隔离

现状中单个 Step 的异常会先执行 `closeCoordinationKernelPlan()`，再判断是否重试。这会把尚未运行或已经完成的其他 Subject 提前关闭；由于 Adapter 缺少迁移校验，后续重试又可能把终态 Subject 重新打开。

修复要求：

- Step 失败只更新当前 Attempt 和当前 Subject。
- `retry=true` 时当前 Subject 进入 `waiting`，新 Attempt claim 后回到 `owned`。
- 只有 Plan 真正进入失败终态时，才关闭该 Revision 仍未终结的 Subject。
- 可恢复截断、产物缺失后的首次重试不得产生 `failed` Completion Evaluation。

### 5.2 Custody 合法状态迁移

Coordination Adapter 必须在同一数据库事务中完成“读当前状态、校验、追加事件、更新投影”。第一版合法迁移如下：

| 来源 | 目标 | 用途 |
| --- | --- | --- |
| `unassigned` | `owned` | 首次 claim |
| `waiting` | `owned` | retry、pause 或恢复后的重新 claim |
| `owned` | `waiting` | 可重试失败、等待用户 |
| `completed` | `waiting` | 仅 `review_revision` 明确返工 |
| `owned` | `completed` | 输出和证据校验后完成 |
| 非终态 | `failed/cancelled` | 当前 Subject 或 Plan 关闭 |

`completed/failed/cancelled` 不得被普通 claim 重新打开。暂停恢复复用同一 Attempt 时必须生成新的 reclaim 事件；原始 claim 事件继续保持幂等。

### 5.3 Evidence 非空语义

Collaboration 的最终 Attempt output 是最低可接受证据。若存在 Handoff Capsule，则其中每个 EvidenceRef 也必须可信。规则为：

```text
evidenceValid = trusted(finalAttemptOutput)
                AND every(capsule.evidenceRefs is trusted)
```

没有最终输出或最终输出不属于当前 Run 时必须拒绝完成；没有 Capsule 不构成失败。

### 5.4 Completion 失败优先级

在用户决策和显式部分接受之外，Completion Engine 应先收集以下终态失败，再判断普通开放工作：

- failed/blocked/cancelled Dispatch；
- failed/partial/timeout Batch；
- 缺失、failed 或 cancelled 的必需 Subject；
- 任意已经 failed/cancelled 的后继 Subject。

因此“一个 Dispatch 已失败、另一个仍 running”的结果是 `failed`，不能被 `OPEN_DISPATCH` 掩盖。

### 5.5 阶段 0 验收

- Coordination 截断重试没有中间 `failed` Completion Evaluation。
- retry、pause/resume 能正确执行 `owned → waiting → owned`。
- 迟到 claim 无法重新打开终态 Subject。
- 无可信 Attempt output 时 `evidenceValid=false`。
- failed + running 的 Completion 矩阵返回 `failed`。
- `typecheck`、Runtime 专项、Collaboration Completion 集成和 Coordination execute 全部通过。

## 6. 阶段 1：规范化 ControlAction v2

### 6.1 目标模型

在 shared 包定义版本化规范动作，模型输出先经解析和 Legacy Adapter 归一化：

```ts
type RuntimeControlAction =
  | { version: 2; type: 'complete'; summary?: string }
  | { version: 2; type: 'answer_candidate' }
  | { version: 2; type: 'handoff'; targetAgentId: string; objective: string; reason: string }
  | { version: 2; type: 'consult'; targetAgentIds: string[]; objective: string; reason: string; join: 'all' | 'any' }
  | { version: 2; type: 'hold'; wake: WakeCondition; reason: string }
  | { version: 2; type: 'cancel'; reason: string };
```

Legacy `finish`、`implicit_complete`、`ask_one`、`ask_many` 等只在 Adapter 内出现；Scheduler 和 Completion Engine 只接收规范动作。解析失败产生可观测的 `invalid_action`，不得静默降级为完成。

### 6.2 验收

- 所有旧动作都有确定映射和版本记录。
- `answer_candidate` 与 `complete` 分离。
- 未知动作不改变 Custody，不完成 Subject。
- 历史 Run 继续按冻结版本解释，新的解析器不改变其语义。

实施结果：shared 包已定义 v2 判别联合与 v1/v2 存储联合；`runtime/controlAction.ts` 负责结构校验、Legacy 映射、答案候选生成和 Contract 版本冻结。Scheduler、Custody 与 Completion Store 已统一消费规范动作。新 Collaboration Run 冻结 `controlActionVersion=2`，历史缺省固定为 v1，详见 [Runtime ControlAction v2](../architecture/runtime-control-action-v2.md)。

## 7. 阶段 2：ExitGuard 与同轮纠偏

在 AgentTurn 结束、创建 Dispatch 或提交 CompletionCandidate 之前引入纯判定 ExitGuard。输入至少包括停止原因、规范动作、Subject/Custody、未决后继义务、输出、证据、协议和预算。

ExitGuard 返回：

- `allow_candidate`：允许创建 CompletionCandidate；
- `continue_same_turn`：反馈结构化原因，让当前 Agent 在同一责任和预算内纠偏；
- `wait`：转为 durable hold；
- `fail_attempt`：技术错误或非法动作；
- `needs_attention`：未知副作用、责任冲突或无法自动恢复。

同轮纠偏有固定次数和 token 上限。用尽后不得伪装成功，应进入 retry、hold 或 needs_attention。

验收覆盖：普通答案、截断、空回复、遗漏动作、非法 handoff、缺证据 complete、存在后继义务时 complete、用户 Stop 和预算耗尽。

实施结果：新增纯函数 `runtime/exitGuard.ts` 与五态裁决；新 Run 冻结纠偏次数和 token 上限，历史 Run 缺省保持旧语义。动态 handoff/resume/aggregate 的普通答案在同一 AgentTurn 内补交显式处置，简单 initial/fanout 直答保留快路径。纠偏阶段只下发控制工具并保存可恢复 checkpoint，Trace 独立记录初次阻断和最终裁决。详见 [Runtime ExitGuard](../architecture/runtime-exit-guard.md)。

## 8. 阶段 3：CompletionCandidate 与 SubjectCompletionEngine

新增持久化 Candidate，至少保存：

- candidate id、run/subject/attempt/generation；
- 规范动作与候选摘要；
- EvidenceBundle 引用；
- ExitGuard 结果；
- `pending/accepted/rejected/superseded` 状态及原因；
- 幂等来源和创建时间。

SubjectCompletionEngine 只做纯判定，检查：

1. Candidate 对应当前 holder 和 generation；
2. Attempt 未被截断、取消或租约淘汰；
3. 必需输出和 EvidenceBundle 有效；
4. 后继义务均终结；
5. review/protocol/artifact 规则满足；
6. 当前不存在 durable hold 或待接球。

拒绝后优先生成结构化纠偏反馈；只有不可修复原因才失败。接受时在单事务内提交 Subject completed、Candidate accepted 和完成事件。Run Completion Engine 只汇合已被 SubjectCompletionEngine 接受的 Subject。

实施结果：新增 `runtime_completion_candidates` 持久化模型与纯函数 SubjectCompletionEngine。新版本 Run 将 Candidate、Subject/Custody 完成事件和 Attempt/动作结果原子提交；可纠正拒绝返回结构化反馈并通过 `waiting → owned` 进入下一 Attempt，失效 generation 标记为 `superseded`。Completion Store 对 `completionCandidateVersion=1` 只读取 accepted Candidate，显式用户部分接受保留独立授权路径。API、WebSocket、右侧面板和 Trace 均可观察候选状态。详见 [Runtime Subject Completion](../architecture/runtime-subject-completion.md)。

## 9. 阶段 4：类型化 Successor Obligation

新增后继义务实体，建议最小字段：

```text
id, run_id, parent_subject_id, kind,
target_subject_id, source_action_id,
status(open|satisfied|failed|cancelled),
required, generation, payload, created_at, resolved_at
```

第一版类型：

- `handoff_acquire`：目标必须成功 acquire；
- `consult_result`：咨询子 Subject 必须按 join 策略汇合；
- `review_revision`：返工目标与 Reviewer 必须重新到达终局；
- `artifact_commit`：声明产物必须冻结；
- `user_decision`：等待用户明确选择。

Completion 不再从动作字符串推断义务。Review FAIL 创建或重开 `review_revision` 义务，目标完成和 Reviewer PASS 后关闭；每轮有稳定 revision/generation，迟到 PASS 不得关闭新一轮返工。

实施结果：新增版本化 `runtime_successor_obligations` 投影，覆盖接球、咨询汇合、Review 返工、产物提交和用户决策。所有 settle 均使用 generation fencing，`consult all/any` 具有明确的必需汇合语义；Review FAIL 推进稳定义务代际，只有返工目标和 Reviewer 均在更新 Custody generation 完成时 PASS 才能关闭。Subject/Run Completion、API、WebSocket 与右侧面板已统一读取该投影，旧 Contract 保留派生义务兼容路径。详见 [Runtime Successor Obligation 与 Review Loop](../architecture/runtime-successor-obligations.md)。

## 10. 阶段 5：EvidenceBundle、防循环与 Context Contributor

### 10.1 EvidenceBundle

Candidate 使用版本化 Bundle 引用 Message、Attempt output、ToolExecution、RunEvent 和工作区文件。Bundle 保存解析结果、哈希和校验时间；任何引用漂移都使 Candidate 失效。

### 10.2 证据感知防循环

现有次数型 ping-pong 防护升级为证据感知策略：

- 相同 Subject、目标、目标 Agent 和 Evidence fingerprint 的重复转发计数；
- Evidence 有实质新增时允许继续；
- 无新增证据的往返超过阈值后进入同轮纠偏或 needs_attention；
- 记录阻断原因和对应链路，不吞掉 Agent 输出。

### 10.3 Context Contributor

把当前 ContextAssembler 拆为稳定贡献者：identity、contract、custody、obligation、capsule、evidence、conversation、protocol。每段声明优先级、字符上限、敏感信息策略和 provenance。Coordination 只增加 Plan/DAG contributor，不再拥有独立上下文主流程。

## 11. 阶段 6：Durable Hold/Wake

实现持久化 `hold`，支持：

- `user_decision` / `approval`；
- `timer`；
- `event`；
- `dependency`；
- `lease_recovery`。

Hold 必须冻结 Subject、holder/generation、唤醒条件、截止时间、恢复策略和幂等键。Wake 在事务中竞争性 claim，只有一个执行者能恢复。取消 Run 时关闭全部 Hold；恢复进程先扫描到期和已满足条件，再调度工作。

验收包括：重启前后唤醒、重复事件、定时器竞争、Stop 与 wake 竞态、过期 lease、审批到达及取消后迟到 wake。

## 12. 阶段 7：Coordination 收口

保留 Coordination 的规划、DAG、协议屏障、Step Attempt、Revision 和 UI 结构；收口以下重复语义：

- Step 输出统一生成规范动作或 AnswerCandidate；
- 所有 Step 完成先经过 ExitGuard 和 SubjectCompletionEngine；
- Review Revision 使用类型化义务；
- 等待统一进入 Hold/Wake；
- Context 使用公共 contributor pipeline；
- Plan 终局只由公共 Run Completion Engine 提交。

切换顺序：`single_agent/sequential → parallel → review_revision → debate`。每种协议先 Shadow 对比，再加入 execute allowlist。执行模式不得出现第二套 claim、第二次工具调用或第二条最终报告。

旧的 `implicit_complete`、Coordination 本地终局断言和重复完成分支在全部协议验收后才能删除；删除前保留冻结 Run 的兼容读取器。

## 13. 发布、回退与观测

### 13.1 开关与版本

- 新能力按 Run 入场冻结版本，不直接读取运行中变化的全局开关。
- 顺序为：纯判定记录 → Shadow → 指定测试会话 → 协议 allowlist → 全部新 Run。
- 回退只停止新版本入场；已入场 Run 继续由对应兼容实现排空。

### 13.2 必需指标

- ExitGuard 各类决策与纠偏成功率；
- Candidate 拒绝原因和平均纠偏次数；
- orphan/double-holder/illegal-transition 数量；
- open obligation 数量和最长持续时间；
- hold 到期、唤醒延迟和重复唤醒抑制数；
- Evidence 缺失、漂移和跨 Run 拒绝数；
- 无新增证据 ping-pong 阻断数；
- Completion Evaluation 序列和最终报告去重数。

### 13.3 最终门槛

确定性测试和故障注入中达到：零双 holder、零责任黑洞、零截断成功、零空证据完成、零终态重开、零未经授权证据、零重复最终报告。Shadow 分歧必须能定位到 Run、Subject、generation、Candidate 和源事件。

## 14. 测试矩阵

每阶段至少执行：

1. shared 类型和纯函数状态矩阵；
2. SQLite 事务、幂等、generation 和重放测试；
3. Collaboration 单目标、并行、handoff、consult、部分失败、Stop、恢复；
4. Coordination single/sequential、parallel、review_revision、debate、截断重试、暂停恢复；
5. 进程级崩溃注入、租约超时并发、ToolExecution 未知副作用；
6. API/UI 的候选、义务、等待、失败原因和唯一最终报告展示；
7. `pnpm typecheck`、文档链接检查和工作区差异检查。

## 15. 当前执行记录

2026-09-24 完成阶段 0，修改范围：

- 将 Coordination Kernel 的 Plan 关闭从 Step catch 移到 Plan 真正失败路径；
- 为 Coordination Custody 增加事务内合法迁移校验和暂停复用 Attempt 的 reclaim；
- 让 Completion Store 以可信最终 Attempt output 作为非空证据基线；
- 调整 Completion Engine，使终态失败不被普通开放工作掩盖；
- 增加 retry 隔离、终态重开、pause/resume reclaim 和 failed+running 专项验收。

已通过 `verify:runtime-completion`、`verify:runtime-completion-integration`、`verify:runtime-coordination-adapter`、启用 Completion Engine 的 Collaboration 端到端、启用 Coordination Kernel execute 全协议端到端、`typecheck`、文档链接和差异格式检查。

2026-09-24 完成阶段 1：

- 新增 `complete/answer_candidate/handoff/consult/hold/cancel` 规范动作，明确答案候选不等于完成申请；
- 新增 Legacy Adapter，覆盖全部现存 v1 动作，未知或版本错配动作显式失败；
- 新 Run 在 Contract 中冻结 v2，历史无标记 Run 固定为 v1；
- Scheduler、Custody、Completion Store 统一在规范动作上执行，新旧持久化格式可并存；
- 端到端断言新 handoff 与普通答案分别持久化为 `handoff` 和 `answer_candidate` v2。

2026-09-25 完成阶段 2：

- 新增五态 ExitGuard 纯判定，区分普通候选、等待、技术失败和责任冲突；
- 新 Run 在 Contract 中冻结最大纠偏次数与单次 token 上限，历史 Run 保持旧语义；
- AgentTurn 支持可恢复的同轮纠偏 checkpoint，纠偏阶段仅暴露控制工具，禁止重复普通工具；
- 新增 `agent.complete(summary)`，动态协作普通答案经一次纠偏后转为显式完成申请；
- 为初次纠偏和最终裁决新增独立 Trace，补齐决策矩阵、非法 handoff、预算耗尽和端到端验收。

2026-09-25 完成阶段 3：

- 新增 CompletionCandidate 持久化、幂等重放、实时事件、API 与前端运行面板；
- 新增纯函数 SubjectCompletionEngine，校验 Attempt、holder、generation、ExitGuard、输出、证据、开放义务和协议条件；
- Atomic 模式在单事务内接受 Candidate、提交 Subject/Custody 完成事件并完成 Attempt，故障回滚不留半状态；
- 可纠正拒绝进入 `waiting` 并在下一 claim 恢复 `active/owned`，重试反馈进入后续 Context；
- Run Completion 对新版本只汇合 accepted Candidate，同时保留显式用户部分接受的独立授权语义；
- 补齐纯判定、事务、幂等、generation、恢复、绕过防护、部分接受、API/UI 与端到端验收。

2026-09-25 完成阶段 4：

- 新增类型化 Successor Obligation 存储、稳定键、幂等来源、代际推进和条件 settle；
- handoff 在目标实际 claim 后关闭接球义务，consult 按 `all/any` 策略汇合子 Subject；
- 用户决策、Run/Dispatch 取消、技术失败和 Revision 替换都有显式义务终结记录；
- Coordination 在 Plan 接纳时打开产物义务，只有经 EvidenceResolver 验证后才关闭；
- Review FAIL 创建/推进 `review_revision` generation，目标返工和 Reviewer 重新 claim 双重门禁拒绝迟到 PASS；
- Subject/Run Completion、API、实时事件与右侧面板已接入，补齐事务回滚、代际竞态、Review 循环和端到端验收。

已通过 `verify:runtime-obligations`、`verify:runtime-review-obligations`、`verify:runtime-subject-completion`、`verify:runtime-completion`、`verify:runtime-completion-integration`、`verify:runtime-shadow`、`verify:runtime-atomic`、`verify:runtime-coordination-adapter`、Collaboration Atomic 端到端、Coordination execute 端到端、可靠性/UI 专项与 `typecheck`。

下一阶段进入 EvidenceBundle、证据感知防循环和 Context Contributor。
