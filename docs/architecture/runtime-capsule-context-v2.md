# Runtime Capsule v2 与关键 Context 预算

## 目标

阶段 7 消除 handoff 中“说明文字”和“机器义务”混为一谈的问题，并确保 Agent 在长对话下仍能获得完成当前责任所需的关键事实。

```text
handoff command transaction
  → 创建目标 Dispatch 与 Subject 映射
  → Runtime 创建 handoff_acquire obligation
  → 完成来源 Attempt
  → 保存引用 obligationId + generation 的 Capsule v2
  → 一次提交或整体回滚
```

模型只提交目标 Agent、objective 和 reason。`subjectId`、`generation`、`obligationId` 与稳定幂等键均由 Runtime 生成，不属于模型输入。

## Capsule 版本语义

`schemaVersion` 表示 payload 结构版本，`version` 继续表示同一 Dispatch 的内容修订序号：

```ts
interface RuntimeHandoffCapsuleV2 {
  schemaVersion: 2;
  version: number;
  successorObligationRefs: Array<{
    obligationId: string;
    generation: number;
  }>;
}
```

权威 Runtime 的 handoff Capsule 必须且只能引用一个 `handoff_acquire` 义务。保存和读取时校验该引用的 Run、目标 Subject、来源 Attempt、目标 Dispatch、stable key 与 generation；伪造、跨 Run、过期或错绑引用会拒绝整个命令事务。

历史 Capsule 缺少 `schemaVersion` 时按 v1 读取。v1 的 `successorObligations: string[]` 和 v2 中保留的同名字段都只是面向人的说明，永远不会自动创建、满足或取消机器义务。`legacy` 与 `shadow` 路径继续生成 v1；`atomic_compat` 与 `execute` 的权威状态路径生成 v2。

## 关键 Context 预算

Context Contributor 增加 `protected` 标记。以下 Collaboration 段使用受保护预算：

- 当前目标；
- 冻结策略允许的 Agent 动作；
- Subject holder、pending holder 与 generation；
- Completion blockers；
- 未满足的类型化义务及其 ID/generation/status；
- 最近一次 CompletionCandidate 拒绝反馈；
- Capsule v2 的完整后继义务引用 JSON。

受保护段超出自身预算或全部受保护段加 tail 超出总预算时，组装器显式失败，不会静默裁切。聊天室历史、证据摘录、Contract 诊断副本等弹性段只使用剩余预算，仍按优先级稳定裁切。当前目标若超过产品上限，会带可见的截断标记和原始长度。

`runtime_context_assemblies.segments` 继续保存 provenance、实际长度、token 估算和截断状态，并新增 `protected` 审计字段。旧记录没有该字段时仍可读取 JSON，不需要迁移历史 payload。

## 事务与回退

- `execute`、`atomic_compat`：义务、来源 Attempt、目标 Dispatch、Capsule v2 与动作命令账本共享外层事务；任一校验失败整体回滚。
- `shadow`：Legacy 仍掌握执行权并写 v1 Capsule；Runtime 观察器在提交后运行，不把 shadow 状态引用写回已提交业务数据。
- `legacy`：保持 v1 Capsule 与旧 Context 兼容语义，但关键 Runtime ID 不从说明字符串推导。
- Capsule v2 不增加数据库列；采用 payload 内结构版本，避免原地改写历史记录。

## 验收

- `pnpm verify:runtime-capsule-context-v2`：覆盖 v1/v2 兼容、Runtime 生成引用、伪造 generation 拒绝、Evidence 漂移、敏感信息、关键段不可截断及 Context provenance。
- `pnpm verify:collaboration`：覆盖真实 execute Scheduler 的 Capsule v2 和接手者 Context。
- `pnpm verify:runtime-compatibility-retirement`：验证退役 Profile 仅保留历史读取，不再被 worker 执行。
- `pnpm typecheck` 与 `pnpm verify:docs`。
