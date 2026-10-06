# 编排入口 O4：执行策略与工作流

状态：本地实现；验收证据见 [O4 验收记录](../reports/orchestration-entry-phase-o4-acceptance.md)。对应 [实施计划](../plans/orchestration-entry-convergence-implementation-plan.md) O4。O5 的界面改版与 O6 的迁移尚未实施。

## 执行入口

`orchestration/entry.ts` 负责规则预览、显式详细规划、确认、幂等提交与图修订。`resolver.ts` 生成 `o4-rules-v1` 决策，`workflows.ts` 编译 `o4-workflows-v1` 图；模型和工具执行沿用 Collaboration、Coordination 与兼容 Pipeline。

| 接口 | 用途 |
|---|---|
| `GET /api/orchestration/options` | 策略、工作流和版本、详细规划成本提示、轮次上限 |
| `POST /api/orchestration/preview` | 默认规则预览；`planning:detailed` 显式调用主管模型 |
| `POST /api/conversations/:id/requests` | 当前聊天室创建本轮任务 |
| `POST /api/conversations` / `POST /api/runs` | 携带新字段时调用统一执行入口；可创建房间与首轮任务 |
| `POST /api/conversations/:id/messages` | 携带新字段时调用统一执行入口；无新字段保留旧兼容语义 |
| `GET /api/runs/:runId/orchestration` | 读取冻结决策及执行政策；历史 O1 记录仍为 comparisonOnly |
| `POST /api/runs/:runId/orchestration/revisions` | 暂停后确认新的步骤图版本 |
| `POST /api/runs/:runId/actions` | 沿用 O3 暂停、恢复、取消入口 |

识别新入口的字段包括 `entryVersion:1`、`strategy`、`workflow`、`constraints`、`aggregatorId`、`previewId`、`planning`。无这些字段的旧调用保留原模式，避免在 O6 前改变历史行为。专用 `requests` 接口始终采用新语义。

规则预览持久化一条确认凭据，不创建 Run、房间、Dispatch、Attempt，不调用模型，不解密账户密钥。详细规划只有明确设置 `planning:detailed` 才发起一次无工具调用，返回模型、调用数及输入/输出用量。详细规划费用与之后 Run 的执行预算分别报告。

复杂工作流以及允许写入的任务必须先预览，然后提交 `previewId` 和 `orchestrationFingerprint`。普通只读常规任务可直接提交。提交必带 8～100 字符的 `clientRequestId`；消息兼容接口也接受 `clientMessageId`。相同请求重复提交返回原 Run，内容或确认凭据冲突返回 409。

## 路由与工作流

明确成员、有效 `@`、被回复成员优先于自动选择；明确顺序保持用户的成员次序。正文指派和明确选择冲突、未知成员、无法判断的多目标任务会返回阻断项。候选团队不等于每轮全员调用。

| 工作流 | 实际结构 |
|---|---|
| 常规单目标 | 现有 Collaboration scheduler；其余可用控制成员保留为接力/咨询候选 |
| 常规多目标只读 | 独立分析分支 → 完成门禁；不会自动添加汇总 |
| 顺序接力 | 按用户顺序执行，每一步收到前序冻结结果 |
| 分析与汇总 | 明确分析成员 → 明确汇总成员 → 完成门禁 |
| 开发与评审 | 一位实现者 → 独立只读评审；FAIL 使实现者返工，再绑定新快照评审 |
| 主管拆解 | 显式模型详细规划 → 确认实际 DAG → 按依赖执行/评审 → 主管汇总 |
| 固定轮次辩论 | 两位固定辩手，每轮正方→反方；可选独立裁判或汇总者 → 完成门禁 |

并行策略只接受只读任务。开发评审和辩论必须保留依赖，显式并行会报冲突。主管图的明确顺序策略会补充顺序依赖；自动/并行也不能删除模型给出的前置任务或评审门禁。

自动选择支持模型 API、Claude SDK 和 Codex app-server 执行成员。主管规划要求具备 `coordinate` 能力的模型 API 成员。只读 CLI 保留明确、简单、只读的顺序任务限制。配置缺失、账户不兼容、严格预算无法执行等情况在预览中解释。

旧 `dynamic_collaboration` 编译为 `executionAdapter:collaboration`，交给同一个 scheduler，不再生成单人 response 步骤，也不创建 Coordination StepAttempt。Plan 状态是 Run 状态的投影，终态由公共 CAS 一次提交。旧 `supervisor_dag` 两步模板停止新准入；主管图由统一入口生成。公开旧协议目录移除共识、投票和旧主管模板，历史定义仍可解释旧记录。

## 实际主管图与评审

规划模型只能从已准入的执行/评审成员中选择，必须提供 1～5 个标题唯一的任务、具体工作内容、明确验收标准、评审要求和无环依赖。非法模型结果保留错误，不能用固定两步或伪造任务替代。

每个任务编译为实际执行步骤。任务有 Reviewer 时，下游依赖 Reviewer 的 PASS 门禁；返工使用已有责任代际更新及固定快照机制，旧 PASS 不能覆盖新实现。确认过的图直接持久化到 Run，不在启动时再次规划。一个预览可用于创建独立 Run，每个 Run 有新的 Plan/Draft/能力快照 ID。

写入的开发评审和主管工作流要求已注册、已有 HEAD 的 Git 根工作区及 `EXTERNAL_WORKSPACE_MODE=isolated`。模型 API 实现者也会建立隔离工作树，使独立评审读取固定快照。角色权限与审批策略继续生效。

## 预算与截止时间

`constraints.maxTokens` 是整轮**生成输出 Token**上限，不表示输入 Token、供应商账单或金额上限。API 调用在 I/O 前通过 SQLite 事务预留额度；并行分支不能重复占用同一余额。工具续轮、退出纠偏、截断重试与收尾调用都采用同一预算路径。已确认响应退还未使用额度；零/缺失用量保守扣除全部预留；消耗未知保留额度并停止自动重发。

SDK/Codex 当前不能保证严格输出 Token 上限，明确选择它们且设置硬上限时会拒绝准入。没有硬上限的原生任务依然受到步骤次数、工具循环、轮次、租约和截止时间约束。

`constraints.deadlineMs` 在提交时变为绝对截止时间，恢复不能重置。模型调用与原生进程接收停止信号，执行绑定也在期限到达后失权，迟到正文、审批或 MCP 副作用不能提交为成功。已发出的供应商请求可能仍有消费，客户端中止不能证明供应商取消了账单。

辩论必须明确 1～10 轮，正文和参数轮数不一致会拒绝。无裁判时执行 2×轮数个发言步骤；裁判/汇总不增加辩论轮数。

## 已确认图修订

先暂停到安全步骤边界，再按当前聊天室生成新预览，调用 `orchestration/revisions` 提交预览 ID、指纹和 `instruction`。主管工作流仍需显式详细规划。

修订保持原工作流、工作区、读写政策、Run 预算和已冻结成员/账户；新角色、新配置或政策变化需要新任务。只读图可以重新验收全部步骤，原输出和历史步骤保留在旧版本。尚未启动的写入图可调整；已经开始的写任务拒绝重建图，防止重复副作用。

修订复用现有 `applyCoordinationPlanRevision`：生成新 revision、撤销旧责任、建立新图责任。旧执行绑定因版本变化失权。相同预览的重复确认返回已有修订，不能增加重复版本。修订完成后仍暂停，用户通过原恢复入口执行新图。旧 `coordination/revisions` 调整器不能覆盖 O4 模板。

## 请求示例

规则预览（ID 替换为实际聊天室与角色）：

```json
{
  "conversationId": "room-id",
  "goal": "分别分析接口设计，再由汇总者整合结论",
  "recipientIds": ["analyst-a", "analyst-b"],
  "strategy": "parallel",
  "workflow": "analysis_summary",
  "aggregatorId": "summarizer",
  "constraints": { "readonly": true, "deadlineMs": 120000 }
}
```

确认后，向 `POST /api/conversations/room-id/requests` 发送同样字段，并增加：

```json
{
  "clientRequestId": "reviewed-analysis-0001",
  "previewId": "returned-preview-id",
  "orchestrationFingerprint": "returned-fingerprint"
}
```

主管预览增加 `workflow:supervisor_decomposition`、`supervisorId`，并显式设置 `planning:detailed`。规则预览只能提示需要主管规划，不能直接确认成空图。

图修订向 `POST /api/runs/run-id/orchestration/revisions` 发送：

```json
{
  "previewId": "returned-revision-preview-id",
  "orchestrationFingerprint": "returned-revision-fingerprint",
  "instruction": "按新的依赖图重新验收只读分析结果"
}
```

本阶段提供服务器接口与执行闭环；页面上的工作流控件、详细规划按钮和修订交互由 O5 接入。真实供应商连接由 O7 单独验收。
