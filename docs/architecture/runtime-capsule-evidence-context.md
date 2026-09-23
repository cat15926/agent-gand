# Runtime Capsule / Evidence / Context（阶段 5）

## 已实现语义

- 每个新建的 Collaboration handoff Dispatch 在父 Attempt 完成的同一事务中保存最小 HandoffCapsule。旧控制工具仍只需 `targetAgentId/message/reason`；Runtime 补齐目标、来源、摘要、已做事项、未决问题、预期产出、后继义务与证据引用。Capsule 按 Dispatch 追加版本，同版本重试必须内容一致。
- EvidenceRef 第一版支持同 Run 的用户/Agent 消息、已完成 ToolExecution、已完成 Collaboration Attempt 输出、成功 RunEvent 输出，以及 Run 独立工作区内带 SHA-256 的普通文件。聊天消息只保证来源可追溯，不证明其事实内容。工具聊天摘要、系统消息、跨 Run/未完成记录、共享/归档/命名/外部工作区文件、符号链接逃逸与超过 32 KiB 的文件均不能作为此版文件证据。
- 文件引用在冻结时与组装 Context 时分别校验哈希；缺失或变化仅报告证据不可用，不注入当前文件内容。证据摘录有长度限制并遮蔽常见密钥、Bearer Token 与私钥块；不记录工具输入作为证据。
- Collaboration ContextAssembler 从身份、冻结 Contract、Subject/Custody、最新 Capsule、可解析证据及当前聊天室最近消息构造提示词。聊天室历史是未经事实核验的上下文，不参与 EvidenceRef 授权；只读取当前聊天室。最近消息优先，fanout 原文仍由聚合消息注入。总长度硬限制 24,000 字符，`runtime_context_assemblies` 保存每段来源、字符数、估算 token、截断标志和全文哈希；同一 Attempt 不允许上下文漂移。

## 兼容与边界

旧 handoff 没有 Capsule 时，ContextAssembler 使用来源消息生成兼容提示，不从自然语言推断持有人或已验证证据。当前只在 Collaboration 执行路径使用；Coordination 的 expectedArtifacts 仍只是路径，不伪装成独立 Artifact 实体。Capsule 与 Context 不改变阶段 6 尚未实现的完成判定。

验收：`pnpm verify:runtime-context` 覆盖跨 Run、篡改文件、符号链接、敏感值和长度预算；`pnpm verify:runtime-crash` 覆盖交接提交后由新进程读取 Capsule 并组装 Context；`pnpm verify:collaboration` 与 `COLLAB_RUNTIME_ATOMIC=true pnpm verify:collaboration` 覆盖真实调度路径；另执行 `pnpm typecheck`。
