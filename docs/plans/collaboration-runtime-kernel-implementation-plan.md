# Collaboration Runtime Kernel 实施方案

状态：全部实施完成；阶段 1–6 已完成 Collaboration 公共内核，阶段 7 已完成 Coordination Step Adapter、Shadow/execute 灰度接入及完整验收。所有执行权开关默认关闭。

基线：`agent-gand` main，2026-09-22。

参考：[Clowder AI](https://github.com/zts212653/clowder-ai)、[连续性问题 #502](https://github.com/zts212653/clowder-ai/issues/502)、[WorklistRegistry](https://github.com/zts212653/clowder-ai/blob/main/packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts)

## 实施记录（更新至 2026-09-23）

| 阶段 | 进度 | 已落地及验收 |
| --- | --- | --- |
| 1 停止/截断 | 已完成 | AgentTurn 分类、技术中断阻断隐式完成、显式兼容完成记录；纯测试与 Collaboration 端到端截断用例通过。错误与取消仍沿既有异常/Stop 路径处理。 |
| 2 Subject/契约 | 已完成语义层 | 并行 root Subject、all-required 完成契约、Dispatch 关系与状态矩阵；ADR 和纯测试通过。持久化在阶段 3 承接。 |
| 3 Custody Shadow | Shadow 基础完成 | 增量表、幂等事件/投影、入场/claim/action/aggregate 观察、事件重放审计和开关；直测及启用 Shadow 的 Collaboration 端到端通过。当前仍由旧 Scheduler 执行，暂不以 Shadow 判定 Run 终态。 |
| 4 原子接球/恢复 | 实现及专项验收完成，待发布 | `COLLAB_RUNTIME_ATOMIC` 默认关闭；Admission、transfer request、Attempt claim、action、Stop、终止恢复与 Custody 同事务写入。handoff Dispatch 锁定 request generation，迟到 Attempt 不能提交，冲突 Dispatch 单独 blocked。进程级故障注入覆盖入场/claim/交接提交前后和工具执行中崩溃；跨进程 claim 与租约续期/过期竞争已验收。独立 ToolExecution 账本决定可重试或需人工确认，并阻止并发、未知副作用与迟到写回。 |
| 5 Capsule/Evidence/Context | Collaboration 已实现并验收 | handoff 最小 Capsule 与版本追加、同 Run EvidenceResolver、文件哈希冻结/复核、敏感值遮蔽、24,000 字符预算 ContextAssembler、段级来源/token 估算与哈希持久化；旧交接兼容。Coordination 尚未接入，详见 [架构说明](../architecture/runtime-capsule-evidence-context.md)。 |
| 6 Completion Engine | Collaboration 已实现并验收 | 纯判定与提交分离；all-required Subject、后继义务、Custody、输出/证据、Batch/Decision、依赖/产物/reviewer/协议终局检查；判定记录由 API 返回，失败展示中文原因，最终报告按稳定键只发布一次。预算部分接受和 Supervisor 委派也经过引擎。由 `COLLAB_COMPLETION_ENGINE` 试验开关控制且默认关闭，接管标记冻结在新 Run Contract，历史 Run 不随进程开关切换语义，详见 [架构说明](../architecture/runtime-completion-engine.md)。 |
| 7 Coordination 接入 | 已实现并验收 | 保留 Plan/DAG/Revision 和协议屏障；Step 映射 Subject，共用 Custody、Context、Evidence 与 Completion Engine；保持原 Step/Attempt/工具/消息幂等键。支持 Shadow、协议 allowlist 与冻结 Run 语义，详见 [架构说明](../architecture/runtime-coordination-adapter.md)。 |

现有 Shadow 只对开关启用后新入场的 Collaboration Run 生效；旧历史不回填。Projection 审计可发现分歧，但自动修复和转移超时指标尚未实现。阶段 4 的原子模式只同步记录责任，不接管旧 Scheduler 的选派或最终完成判定；生产环境保持关闭。验收命令：`pnpm typecheck`、`pnpm verify:collaboration-exit`、`pnpm verify:runtime-subject-contract`、`pnpm verify:runtime-shadow`、`pnpm verify:runtime-atomic`、`pnpm verify:runtime-crash`、`pnpm verify:tool-execution-ledger`、`pnpm verify:runtime-context`、`COLLAB_RUNTIME_SHADOW=true pnpm verify:collaboration`、`COLLAB_RUNTIME_ATOMIC=true pnpm verify:collaboration`、`pnpm verify:durable`、`pnpm verify:p0-tools`。

阶段 4 事务边界：Shadow 模式仍在旧事务提交后观察；原子试验模式则在各自旧事务内共同提交。两种模式都尚不把 Custody 当作执行权威。工具账本已经独立于 Trace：人工策略的未决调用转 `needs_attention`，安全/幂等策略的未决调用先转 `interrupted` 后允许重试；旧 Attempt 无账本时保留保守 Trace 兼容判断。执行权切换仍需运行版本固定/回退和阶段 5–6 的上下文、证据与完成判定。

## 目标与边界

保留现有 SQLite Dispatch/Attempt/lease、结构化 ControlAction、Coordination Plan 和协议 DAG；建立跨模式共享的责任、上下文、证据与完成判定。Clowder 的 per-invocation Worklist 不移植到本项目。模型提出动作，Runtime 校验并持久化状态迁移。

Run 表示一轮用户目标，可包含多个并行 WorkSubject；只有单持有型 WorkSubject 才要求任一时刻最多一个 holder。Dispatch 是派发，Attempt 是执行尝试，二者都不等于 WorkSubject 完成。用户后续修改通过版本化 Contract/Plan Revision，不覆盖历史快照。

本轮不引入新的向量库、Blob Store、Clowder Worklist 或完整 Prompt Hook 系统。timer/event `hold` 和 Pipeline/Supervisor 全面收敛列为后续扩展；现有用户/审批等待必须纳入完成判断。

## 不变量

1. 技术性停止（截断、审批等待、空回复、取消）不能隐式完成工作。
2. 无 ControlAction 只是答案候选，不等同于工作或 Run 完成。
3. 同一单持有型 Subject 至多一个有效 holder；并行 Run 可以有多个 Subject。
4. handoff request 不等于目标已 acquire；consult 不转移父 Subject 的责任。
5. 每次责任迁移有稳定幂等来源和 generation fencing，迟到结果不得改变新状态。
6. Run completed 只能由完成判定器接受；部分成功不得冒充完整成功。
7. 证据引用必须校验 Run 归属、来源、状态和版本；聊天内容不能充当已验证事实。
8. 恢复先重建责任与义务，再组装 Agent 上下文；未知副作用不得盲重放。

## 阶段 1：停止/截断语义与基线用例

在 `orchestration/agentStep.ts` 到 `collaboration/scheduler.ts` 的边界分类 `control_action | answer_candidate | truncated | approval_wait | empty | error | cancelled`。截断和审批等待优先处理，不得落入 `null => finish`。健康正文无动作时只生成显式的 `implicit_completion` 候选；兼容规则允许简单答复，且保存判定原因与计数，为阶段 6 收紧准备。并行子任务正文仍是内部结果。

新增专项验证，覆盖截断正文、审批耗尽、空回复、普通问答、handoff 后自然答复、fanout、用户 Stop 与迟到输出。完成门槛：技术中断不生成 `collaboration_result` 或 completed Run；旧正常问答无回归。此阶段不改变数据库结构。

## 阶段 2：并行 Subject 与完成契约

先落 ADR 和纯函数测试，再做持久化。单目标入口为一个 root Subject；显式多接收者为各接收者分别创建 root Subject，Run 默认 `all_required`；handoff 沿用原 Subject；consult 创建子 Subject，发起者保留父责任；aggregate 沿用父 Subject。计划步骤稍后映射为 step Subject。

`RunContract` 入场冻结目标、参与者、路由类型、必需 Subject、汇合策略、产物、审查、失败及部分成功策略。定义 Subject、Dispatch、Attempt、Run 四层终态和兼容映射。验收：单目标、多目标、部分失败、consult、handoff、取消的状态矩阵完整，且无“至少一项成功即整体成功”的歧义。

## 阶段 3：Custody Shadow

增量建 `runtime_contracts`、`runtime_subjects`、`runtime_custody_events`、`runtime_custody`。事件 append-only，`source_event_id` 唯一；Projection 有 version/generation，可重放校验。旧 Scheduler 仍为执行权威；只对新 Run 影子写入并比较 legacy 与投影。旧历史 Run 不从自然语言猜测 holder，已运行的旧 Run 固定 legacy 版本。

指标：孤儿 Subject、双 holder、超时待接球、影子分歧。验收：影子故障不影响旧执行；重复事件不重复迁移；重建 Projection 一致；差异可追到具体事件。

## 阶段 4：原子接球与恢复

在当前 handoff 事务中加入 `transfer_requested` 事件和 Projection 更新，保留 `holder=A,pending=B`；在现有 Dispatch claim 事务中同时创建 Attempt、校验 request generation 并写 `acquired(holder=B)`。取消、重试、lease 失效、目标停用、服务重启均按 generation 和尝试状态仲裁。交接失败转可重试或 `needs_attention`，不产生责任黑洞。未知副作用由 ToolExecution Ledger 判定，不能自动重放。

验收：请求/claim 前后崩溃、重复交接、迟到结果、同 Agent 并发、Stop 竞态、过期 lease；零双持有、零重复最终报告、零盲重放。

## 阶段 5：Capsule / Evidence / Context

版本化 HandoffCapsule 保存目标、来源 Dispatch/Attempt、摘要、已做事项、未决问题、预期产出、后继义务和 EvidenceRef。旧 Tool 输入兼容，缺字段由 Runtime 生成最小 Capsule。EvidenceRef 第一版只引用真实存在的 Message、ToolExecution、Attempt output、RunEvent 和带哈希的工作区文件；Coordination 当前只有 expectedArtifacts 路径，不假设独立 Artifact 实体。

EvidenceResolver 检查归属、权限、状态、版本及敏感数据。ContextAssembler 先等价替代 `buildContext()`，再按身份、Contract、Subject/Custody、Capsule、可信证据、必要聊天摘录组装，保存段级 token/来源 Trace。验收：跨 handoff 与重启的控制流一致；无跨 Run 泄露；缺失/变化的文件不能冒充冻结证据；Prompt 预算有界。

## 阶段 6：Completion Engine

实现纯判定 `accepted | rejected(reasons) | waiting | failed`，提交终态另由事务完成。Agent `complete` 只是申请。Subject 检查 holder/generation、后继义务、活动等待、必要输出/证据、截断和审查规则；Run 再检查必需 Subject、Decision、协议终局和部分成功策略。先让 Collaboration 的 `finalizeRun()` 使用此引擎，并显示拒绝原因及部分结果。

从 Coordination 现有产物、依赖、终局和 reviewer 校验提取纯规则，不复制一份。验收：成功 Dispatch 不足以完成未满足契约的 Run；缺产物/审查失败/待交接不完成；全部条件满足只发布一次最终结果。

## 阶段 7：Coordination 接公共内核

保留 Coordination 的 Plan、DAG、就绪、Revision 和协议屏障。Step Adapter 将步骤映射为 Subject，共用责任、上下文、证据、停止与完成判定，保留原 Step/Attempt ID 和幂等键。按 single/sequential → parallel → review-revision → debate 顺序对新 Run 切换；先 Shadow 对比，再切执行权。不得出现双重调度、重复工具执行或重复聊天发言。

实施结果：已通过 Step Adapter 接入公共 Runtime。`COORDINATION_RUNTIME_KERNEL=shadow|execute` 控制新 Run 入场，`COORDINATION_RUNTIME_PROTOCOLS` 支持上述协议顺序灰度；未在 execute allowlist 的协议自动进入 Shadow。Plan Revision 保存 Contract Revision 并关闭旧 Revision 未完成责任，暂停/恢复与崩溃恢复复用原 Attempt 和冻结 Context。Completion Engine 只接管终局验收，不创建第二套调度器或额外结果消息。详见 [Coordination 接入公共 Runtime 内核](../architecture/runtime-coordination-adapter.md)。

## 横向发布与验收

数据库迁移仅增量；Run 入场固定 `runtimeVersion`。开关顺序：Shadow → 指定测试房间 → 小范围新 Run → 全部新 Run。回退先停止新 V2 入场；已入场 V2 由兼容版本继续或排空，不中途切换旧 Scheduler。每阶段通过 typecheck、Collaboration/可靠性、Coordination、Scheduler、Durable、follow-up 回归；另增 Runtime Contract、故障注入、真实浏览器和三轮辩论回归。

最终门槛：确定性测试中零孤儿责任、零双持有、零截断成功、零重复最终报告、零未经授权证据；Shadow 分歧逐项解释。保存拒绝原因、implicit completion、待接球时长、恢复成功率、上下文证据数量与 token 分段指标。
