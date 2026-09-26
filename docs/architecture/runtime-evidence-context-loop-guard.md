# Runtime EvidenceBundle、证据感知防循环与 Context Contributor

## 责任边界

阶段 5 将“引用过什么”、“证据是否仍为原内容”、“新一次路由是否带来新信息”和“上下文每段来自哪里”变成 Runtime 的结构化事实：

```text
EvidenceRef
  → EvidenceResolver
  → EvidenceBundle（冻结解析结果 + 全量内容哈希）
  → Completion / Capsule / Coordination

Subject + responsibility objective + agent pair + evidence fingerprint
  → Route Guard chain
  → allowed / warned / blocked

Runtime facts
  → Context Contributors
  → 优先级和预算裁剪
  → 持久化 provenance
```

新 Collaboration Runtime Run 冻结 `evidenceBundleVersion=1`、`evidenceLoopGuardVersion=1` 和 `contextContributorVersion=1`。Coordination Kernel 冻结 EvidenceBundle 与 Context Contributor 版本。缺少对应标记的历史 Run 继续使用原 EvidenceRef、次数型 ping-pong 和兼容上下文段。

## EvidenceBundle

`runtime_evidence_bundles` 保存：

- Run、可选 Subject、owner 类型与 owner id；
- Bundle 版本、EvidenceRef 列表与幂等键；
- 每个引用的 trusted 结果、脱敏摘要、拒绝原因和全量内容 SHA-256；
- Bundle fingerprint、`valid | invalid | drifted` 状态和最后校验时间。

支持的引用类型为 Message、Attempt output、ToolExecution、RunEvent 和 Run 工作区文件。工作区文件同时校验沙箱边界和引用中的文件哈希。Candidate 在 Attempt 尚处于当前事务的 `running` 状态时，只允许对该 Attempt 使用本次候选摘要作为事务内 override；Attempt 提交后必须与持久化 output 的哈希一致。

Bundle 重新校验时会解析所有引用并重算 fingerprint。任一引用失效或内容哈希变化，原 `valid` Bundle 即单向进入 `drifted`；即使后来把内容改回，也不会静默恢复。Completion Snapshot 将漂移 Bundle 视为无效证据，幂等重放 Candidate 会返回 `EVIDENCE_BUNDLE_DRIFTED`。

CompletionCandidate、Handoff Capsule 和 Coordination Step Evidence 均持久化 Bundle id。API、WebSocket 和右侧面板暴露 owner、状态、fingerprint 与校验时间。

## 证据感知防循环

`runtime_route_guard_events` 记录每次 handoff 的：

- Run、Subject 和来源 Dispatch；
- from/to Agent；
- Subject 冻结责任目标哈希；
- 当前实质证据 fingerprint；
- 连续次数、`allowed | warned | blocked` 与结构化原因。

实质证据只计入已完成 ToolExecution、工作区文件和 RunEvent；普通消息或 Attempt 文字不能靠改写说法绕过防循环。同一 Subject、责任目标、Agent 对和 fingerprint 的连续往返使用 Run 入场时的 warn/block 阈值；新的实质证据会产生新 fingerprint 并重置计数。

阻断记录在外层动作事务回滚后重新持久化，不会随未创建的子 Dispatch 一起丢失。Agent 已产生的正文或 handoff objective 以 informational 消息保留，Trace 记录 guard event、次数与 fingerprint，避免“阻断路由同时吞掉输出”。

## Context Contributor Pipeline

`assembleRuntimeContext()` 是 Collaboration 和 Coordination 共用的组装器。每个 contributor 声明：

- `source`：稳定段名；
- `priority`：超预算时的保留顺序；
- `maxChars`：单段硬上限；
- `sensitivePolicy`：脱敏或显式允许；
- `provenance`：对应的 Contract、Custody、Obligation、Capsule、Bundle、Message 或 Plan 来源。

Collaboration v1 稳定段为 identity、contract、custody、obligation、protocol、capsule、evidence 和 conversation。当前事项放在 conversation 段前部，确保历史摘录过长时不会挤掉本轮任务。Coordination 使用同一 Pipeline，只增加 `plan_dag` contributor，不再自行实现截断和持久化逻辑。

`runtime_context_assemblies.segments` 持久化上述声明、实际字符数、token 估算和是否截断。同一 Attempt 二次组装必须产生相同哈希，否则作为 Context 漂移拒绝。

## 验收

- `pnpm verify:runtime-evidence-bundles`
- `pnpm verify:runtime-loop-guard`
- `pnpm verify:runtime-context`
- `pnpm verify:runtime-subject-completion`
- `pnpm verify:runtime-completion-integration`
- `pnpm verify:runtime-atomic`
- `COLLAB_COMPLETION_ENGINE=true COLLAB_RUNTIME_ATOMIC=true pnpm verify:collaboration`
- `COORDINATION_RUNTIME_KERNEL=execute pnpm verify:coordination`
- `pnpm typecheck`

