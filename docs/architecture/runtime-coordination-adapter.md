# Coordination 接入公共 Runtime 内核

状态：阶段 7 已实现并验收；默认关闭，支持 Shadow 与按协议灰度接管。

## 边界

Coordination 继续负责 Plan、DAG、Step 就绪、Revision、并发执行和协议屏障。公共 Runtime 不创建第二套调度队列，也不改变既有 Coordination Step/Attempt ID、工具执行幂等键或聊天消息幂等键。

Step Adapter 将当前 Plan Revision 的每个非 `completion_gate` 步骤映射为 `coord:r<revision>:<stepId>` Subject：

- Step claim 与 Custody acquire 在同一数据库事务提交；
- retry、审批暂停、Reviewer 返工、失败和取消均产生可回放的 Custody 代际；
- Plan Revision 会保存新的 Contract Revision，并取消旧 Revision 中未终结的责任；
- 进程恢复复用原 Attempt、冻结 Context 和工具执行账本，不重复增加 Attempt 或聊天发言。

## Context 与 Evidence

Coordination 的原步骤提示仍保留。公共 Context 在其外层加入冻结 Contract、当前 Custody 和已经服务端校验的依赖 Evidence，并沿用 24,000 字符硬预算、敏感值遮蔽和 Attempt 级哈希防漂移。

每个成功 Step 至少保存一个 `attempt_output` EvidenceRef；声明 `expectedArtifacts` 的步骤还保存带 SHA-256 和 workspace scope 的文件 EvidenceRef。EvidenceResolver 同时支持 Collaboration Attempt 与 Coordination Step Attempt，并复用工作区路径包含性检查。

## Completion Engine

Coordination 的 Plan/DAG 仍计算依赖和协议终局，但终止前会投影为公共 Completion Engine 输入：

- 必需 Subject 是否完成且责任闭合；
- 当前 Step 是否仍 queued/running/failed；
- 依赖是否满足；
- 必需产物 Evidence 是否有效；
- `review_revision` 的最新 Reviewer 结论是否 PASS；
- `completion_gate` 是否到达终局。

Shadow 模式只保存判定结果，不改变旧终局；execute 模式只有 `accepted` 才允许 Plan/Run 完成。Coordination 仍沿用既有步骤消息，因此内核验收不会额外发布聊天结果，也不会产生重复最终发言。

## 发布与回退

- `COORDINATION_RUNTIME_KERNEL=off|shadow|execute`，默认 `off`；
- `COORDINATION_RUNTIME_PROTOCOLS` 控制 execute 放量协议；不在名单内的新 Run 自动进入 Shadow；
- 推荐顺序：`single_agent,sequential_pipeline` → `parallel_fanout,supervisor_aggregation` → `review_revision` → `debate`；
- 模式和协议结果冻结在新 Run Contract。关闭开关只停止新 Run 入场，已经入场的 Run 继续使用冻结模式完成或排空；
- `/api/runs/:runId/coordination` 返回 `runtimeKernel` 和 `completionEvaluations`，用于检查 Subject、Custody、Evidence、Context 数量与终局判定。

## 验收

- `pnpm verify:runtime-coordination-adapter`
- `COORDINATION_RUNTIME_KERNEL=shadow pnpm verify:coordination`
- `COORDINATION_RUNTIME_KERNEL=execute pnpm verify:coordination`
- `pnpm verify:coordination`
- `pnpm typecheck`

覆盖单人、顺序、并行、Reviewer 返工、辩论、截断重试、产物缺失、暂停/恢复、取消、进程崩溃恢复和外部工作区隔离。验收要求零孤儿责任、零双持有、零重复工具执行、零重复聊天发言和零未经授权证据。
