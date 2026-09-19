# Coordination 辩论实测问题报告（阶段 C 验收后）

更新时间：2026-09-19
关联方案：[通用协作规划器与 Coordination Plan 设计](../plans/coordination-planner-design.md)（阶段 A/B/C 已完成）
前序报告：[Collaboration 三轮辩论实测问题报告](./collaboration-debate-test-problem-report.md)

## 1. 测试范围

同一测试批次内连续创建两个辩论聊天室，**绑定同一个外部工作区**（`ext:2f2ef902`，label `0919`，`~/lhz/temp/0919`）。时间为数据库 UTC 记录。

| | 会话 1 | 会话 2 |
|---|---|---|
| Conversation | `f33007c5-21b0-4a88-a228-7a686af3fe87` | `bf646e38-48f2-453b-b28d-4d84b34c6d75` |
| Run | `ea1af766-29d8-416c-ac74-ad23215a458a` | `6c3aa6c4-84c0-421d-946f-42a36432d02f` |
| Plan | `0614cd7c`（revision 1） | `486fcb44`（revision 1） |
| 团队 | coder-jitui + planner + reviewer | coder + coder-jitui + reviewer |
| 执行时间 | 05:27:17—06:23:15（约 56 分钟） | 05:31:58—05:54:58（约 23 分钟） |
| LLM 调用 | 19 次（37,848 in / 74,015 out） | 22 次（54,298 in / 61,358 out） |
| 审批 | 2 次通过，**7 次超时 expired** | 4 次通过，1 次编辑后通过 |
| 工具执行 | 12 次（4 次 `fs.read` 失败） | 29 次（3 次 `fs.read` 失败） |
| 最终状态 | `completed` | `completed` |

- 用户目标：coder 和鸡腿（🍗）围绕 Codex 与 Claude Code 进行三轮辩论，最后由 Reviewer 总结评审
- 模型：`anthropic:glm-5.3`（thinking 模型）
- 成本记账：两场合计约 92K in / 135K out Token，`cost_usd` 全部为 0（未配置 `LLM_PRICING_JSON`）

## 2. 总体结论

结构层面阶段 C 交付的保证全部成立：依赖顺序严格（6 次发言串行、裁判最后）、角色绑定正确、裁定后无迟到消息、attempt 幂等且无重复执行、coordination_events 生命周期完整。相对 [Collaboration 实测报告](./collaboration-debate-test-problem-report.md)中的 12 个问题（多调度中心、立场漂移、Reviewer 提前介入等），Coordination Runtime 已经解决了轮次状态机和角色固定问题。

但两个 Plan 都是**带着失效的产物保证标记为 `completed` 的**："发言已冻结"这一完成条件没有任何机械化校验。会话 2 六篇发言实际只冻结了五篇，缺失的一篇以 35 字符截断 stub 通过了终局屏障；会话 1 只冻结了两篇，裁判靠读取**另一个 run 的文件**补齐了上下文后出具裁决。阶段 D（模型规划）将依赖执行反馈做置信度评分，若不先修复执行侧的产物完整性，评分输入不可信。

## 3. 问题清单

| 编号 | 级别 | 摘要 |
|---|---|---|
| AG-COORD-01 | P0 | 终局屏障不校验冻结产物，步骤可"纸面完成" |
| AG-COORD-02 | P0 | `stop_reason=max_tokens` 截断被当作成功轮次 |
| AG-COORD-03 | P0 | 共享外部工作区导致跨 run 产物污染 |
| AG-COORD-04 | P1 | 审批连续超时无升级路径，run 空转烧预算 |
| AG-COORD-05 | P1 | 冻结产物双重注入，文件内容回显污染聊天流 |
| AG-COORD-06 | P2 | 成本记账为 0，预算门槛形同虚设 |
| AG-COORD-07 | P2 | 指定参与者与团队成员不一致时静默映射 |

### AG-COORD-01：终局屏障不校验冻结产物（P0）

**现象**：会话 2 的 `debate-r2-con` 步骤没有执行任何 `fs.write`（`tool_executions` 无记录），`debate/r2-con.md` 从未存在，但步骤状态为 `completed`（attempt 1 次、无重试）。该步骤落库的 output 仅 35 字符且以损坏字符结尾：

```text
收到，我是反方🍗，执行 debate-r2-con：独立完成第 2 �
```

这段 stub 随后被运行时作为"前序冻结产物"注入 `debate-r3-pro`、`debate-r3-con` 和 `debate-judge` 的 prompt（`[con · debate-r2-con]` 段落）。下游三次 `fs.read debate/r2-con.md` 全部失败（05:44:10、05:47:08、05:52:31），裁判额外执行 `search.files` 检索"反方交锋""第 2 轮 · 反方"均未命中——模型已自行发现内容缺失——但仍然出具裁决，Plan 照常 `completed`。

会话 1 更极端：本 run 六篇发言仅冻结两篇（r1-pro/r1-con），裁判读 r2/r3 共四个文件全部失败后读到了其他来源文件（见 AG-COORD-03），最终输出"Round 1–3 全部发言冻结后出具"的裁决，对本 run 而言是虚假陈述。

**影响**：验收标准"必需分支完成并成功聚合"（方案 §15.1）没有机械保证；Plan 终态不可作为交付物完整性的证据；下游步骤和用户被注入伪冻结内容。

**建议**：

1. 声明冻结产物的步骤在标记 `completed` 前校验产物存在且非 stub（如文件存在 + 最小长度阈值）；
2. 裁判/聚合类步骤启动前校验全部声明的输入产物可读，不可读时阻断或进入 `waiting_for_user`，而不是依赖模型"如实报告"；
3. 校验失败计入 step error 并触发既有 attempt 重试或受控重规划（方案 §12）。

**验收标准**：六篇发言任意一篇未落盘时，裁判步骤不能进入 `ready`；Plan 终态为 `completed` 时，全部声明产物必须存在且与步骤 output 一致。

### AG-COORD-02：`max_tokens` 截断被当作成功轮次（P0）

**现象**：`debate-r2-con` 的第二次 LLM 调用 `tokens_out = 8192`，恰等于 `LLM_MAX_TOKENS` 默认值。glm-5.3 为 thinking 模型，思考消耗预算后正文被截断，output 末尾的 `�`（"第 2 轮"被切成半个 UTF-8 字符）是流式截断的直接证据。运行时将截断响应当作成功的 Agent 轮次接受，无重试、无告警。`apps/server/.env.example` 已记载该故障模式（"thinking 模型思考也耗预算，过小会出现'只思考不出正文'"），但仅在配置注释层面提示，运行时未防御。

**影响**：AG-COORD-01 的直接根因之一；截断可能发生在任意长输出步骤，静默降低交付质量。

**建议**：

1. Provider 层将 `stop_reason=max_tokens` 上抛为可识别错误或标记位；
2. Coordination Runtime 对标记截断的轮次判定 attempt 失败：重试（可为该 attempt 临时提高 `LLM_MAX_TOKENS`）或记入 step error；
3. 输出落库前校验 UTF-8 完整性，出现 `U+FFFD` 视为截断信号。

**验收标准**：构造 `stop_reason=max_tokens` 的 stub 模型复现该场景时，步骤不得标记 `completed`；重试路径产生完整正文或步骤进入失败态。

### AG-COORD-03：共享外部工作区导致跨 run 产物污染（P0）

**现象**：两个 run 绑定同一外部工作区 `ext:2f2ef902`，两场辩论的文件混在同一目录（会话 1 命名 `r1-pro-codex.md` / `r1-con-claudecode.md`，会话 2 命名 `r1-pro.md`…`r3-con.md`）。会话 1 的裁判读本 run 文件失败后，`search.files` 检索"结辩"命中会话 2 的 `debate/r3-con.md`，随后成功读取会话 2 的 `r3-pro.md` 与 `r3-con.md`（tool_executions 06:21:19 两条 `completed`），裁决部分建立在另一个 run 的辩论内容上。

**影响**：裁判无法分辨产物归属；README 声明"并发写同一命名工作区在 MVP 下接受、不设锁"针对写竞争，但本例暴露的是**读侧归属污染**——裁决结论的证据链已跨 run 混淆。

**建议**：

1. 协议步骤的产物路径由编译器统一定义命名空间（如 `debate/<planId 前 8 位>/r2-con.md`），不依赖模型自选文件名；
2. 同一外部工作区被并发 run 绑定时至少告警，或按 run 建子目录隔离；
3. 裁判步骤读取的文件应限制在本 plan 声明的产物清单内。

**验收标准**：两个并发 run 共用工作区时，任一裁判步骤读取不到对方 plan 的产物文件；工作区中产物路径可静态追溯到所属 plan。

### AG-COORD-04：审批连续超时无升级路径（P1）

**现象**：会话 1 在用户转向会话 2 后（约 05:31 起），连续 7 次 `fs.write` 审批等待满 `APPROVAL_TIMEOUT_MS`（5 分钟）后 expired，时间跨度 05:31:09—06:16:42。每次超时后 Agent 重试并产生新的 LLM 轮次，run 在被放弃状态下继续空转约 30 分钟，消耗 19 次 LLM 调用 / 74,015 out Token。系统全程无通知、无暂停、不进入 `waiting_for_user`。

**影响**：用户遗忘或放弃的 run 持续消耗预算；审批卡在 UI 中堆积无人处理时没有任何熔断。

**建议**：同一 run 连续 N 次审批 expired 后暂停调度并置 run 为 `waiting_for_user`（携带"审批无人处理"原因），由用户决定恢复或取消；参考 Collaboration 模式的预算暂停语义。

**验收标准**：连续审批超时达到阈值后，不再产生新的 LLM 调用；run 状态可观测到暂停原因；用户恢复后从断点继续。

### AG-COORD-05：冻结产物双重注入与聊天流污染（P1）

**现象**：运行时已把"前序冻结产物"全文注入步骤 prompt（`coordination_step_attempts.input` 可见），但 Agent 每步仍通过 `fs.read` 重读全部历史文件（会话 2 共 22 次 LLM 调用，其中大量为读取轮次），且每次读取的完整文件内容作为 `informational` tool 消息落入聊天流（会话 2 的 seq 7-8、15-17、22-26、30-35 均为文件内容回显）。

**影响**：上下文双倍消耗（同一内容既在 prompt 又在工具结果）；聊天室反复刷屏同一段冻结内容，掩盖真正的业务消息。

**建议**：步骤 prompt 已注入产物时，从该步骤的可用工具中收起重复读取路径或降低其优先级；`fs.read` 的文件正文不作为聊天消息广播（保留在 Trace/RunGraph 中查看），聊天流只保留一句"读取了 debate/r1-pro.md"级别的摘要。与前序报告 AG-COLLAB-11（内部技术消息移出主聊天流）同源。

**验收标准**：同一文件内容在一次 run 的聊天流中至多出现一次完整正文；步骤 prompt 中的冻结产物与工具读取不重复计费同一内容的场景有明确策略。

### AG-COORD-06：成本记账为 0（P2）

**现象**：两场 run 合计约 92K in / 135K out Token，`run_events.cost_usd` 与 Plan 预算统计全部为 0，因未配置 `LLM_PRICING_JSON`。README 声明"未配置价格的模型成本记为 0，避免把未知价格当成真实账单"，属设计行为。

**影响**：thinking 模型辩论场景单 run 消耗 10 万 Token 量级，无成本数据时方案 §7.4 的 `budgetRisk` 评分与预算门槛（Token 维度除外）无法生效。

**建议**：为已接入的 `anthropic:glm-5.3` 配置 `LLM_PRICING_JSON`；成本为 0 且模型未配置价格时，在 UI 预算展示中明确标注"未计价"而非显示 0 成本。

**验收标准**：配置计价后新 run 的成本与 Token 一致可查；未计价模型在 UI 有显式标识。

### AG-COORD-07：指定参与者与团队成员不一致时静默映射（P2）

**现象**：会话 1 用户指令为"coder 和🍗进行辩论"，但所选团队为 coder-jitui + planner + reviewer（不含 coder）。规划器按团队选择顺序绑定 pro=coder-jitui、con=planner，全程无提示。用户消息中的参与者指称与实际团队不一致时未被识别为关键歧义。

**影响**：用户语义中的"coder"被静默替换为 planner，产出与预期参与者不符；违反方案 §4"Normalizer 不得静默改变参与者"的精神（当前 planner.ts 为确定性实现，尚未处理自然语言指称）。

**建议**：TaskBrief 归一化时比对用户指称的参与者与实际团队，不一致时在计划卡中显著提示实际绑定结果，或作为阶段 D 澄清问题（方案 §13.3）的输入。

**验收标准**：指称与团队不一致时，计划卡展示"实际参与：鸡腿（正方）、planner（反方）"级别的明确信息；不出现未被用户确认的静默替换。

## 4. 修复记录（2026-09-19）

| 编号 | 状态 | 实现要点 |
|---|---|---|
| AG-COORD-01 | ✅ 已修复 | `CoordinationPlanStep.expectedArtifacts` 结构化声明产物路径；编译器为辩论发言步骤定义 `debate/rN-<side>.md` 并在 prompt 下达冻结指令；Runtime 在步骤完成前校验产物存在且 ≥64 字节，review/aggregate 启动前校验全部祖先产物（终局屏障） |
| AG-COORD-02 | ✅ 已修复 | `LlmResponse.truncated`（openai `length` / anthropic `max_tokens`）；agentStep 截断时不执行其 toolCalls、升预算（2×，上限 32768）重发一次；仍截断则标记 `truncated` 由 Runtime 判 attempt 失败；`makeStep` 默认 `maxAttempts: 2` |
| AG-COORD-03 | ✅ 已修复 | 外部工作区对 Coordination run 按 `planId` 前 8 位映射子目录（`workspaceScope` 贯穿 tool ctx → `workspaceRootDir`，fs/search/shell 一并隔离）；其他编排模式保持直访注册根 |
| AG-COORD-04 | ✅ 已修复 | `APPROVAL_MAX_EXPIRIES`（默认 2）计数同一轮内审批超时，达到即中止轮次；步骤 attempt 置 `paused` 释放回 ready，run 置 `waiting_for_user`、plan 置 `paused`，残留 pending 审批清空；`POST /api/runs/:id/coordination/resume` / `cancel` + 聊天室横幅按钮；恢复复用原 attempt，不烧重试次数。审批幂等键顺延（终态旧卡不复用），避免恢复后立即再次熔断的死锁 |
| AG-COORD-05 | ✅ 已修复 | 工具输出 >200 字符时聊天流只发一行摘要（完整内容在 Trace/Trajectory）；步骤 prompt 注入"前序产物已注入上文，不要 fs.read 重读"指令 |
| AG-COORD-06 | ✅ 已修复 | `lookupPricing` 区分"未计价"与"价格为 0"，llm span 记 `llm.pricing: priced/unpriced`；计价仍需用户配置 `LLM_PRICING_JSON` |
| AG-COORD-07 | ✅ 已修复 | `participantNotices` 比对目标文本点名与所选团队，`CoordinationPreview.notices` 随计划卡展示 ⚠ 提示，不再静默替换 |

验证：`pnpm verify:coordination` 新增四个场景——缺产物阻断（步骤失败、裁判不得启动、run failed）、截断重试（首次 attempt 记 `max_tokens 截断`、重试后落盘）、外部工作区 plan 隔离（产物仅在 `<extRoot>/<planId8>/` 下）、暂停→恢复→完成与取消终态。全量回归（durable / scheduler / agents / collaboration / observability / p0-tools / llm-stubs 135 项 / typecheck）通过。

## 5. 结构正确的部分（回归基线）

以下阶段 C 保证在本轮实测成立，修复上述问题时不得破坏：

- 依赖与轮次：6 次发言严格按 r1-pro → r1-con → … → r3-con 串行，裁判最后执行，无跳轮、无重复发言；
- 角色固定：正反方与裁判绑定后全程不变，无立场漂移（对比 AG-COLLAB-03/04/05）；
- 无迟到消息：两场 run 的最后一条消息均为裁判裁决，与 run 终态时间一致；
- attempt 幂等：全部步骤 attempt_no=1，无重复执行；
- HITL 正常路径：会话 2 中 1 次审批被用户编辑后通过，写入内容与编辑一致；
- coordination_events 完整记录 step_ready/started/completed 与 plan_completed 生命周期。

## 6. 修复优先级建议（修复前存档）

1. **进入阶段 D 前必须修复**：AG-COORD-01、02（执行反馈的完整性是模型规划置信度评分的输入）、AG-COORD-03（工作区归属污染会直接污染裁判证据链）；
2. **可与阶段 D 并行**：AG-COORD-04、05（升级路径与聊天流治理）；
3. **配置项**：AG-COORD-06（计价）、AG-COORD-07（参与者提示，自然语言指称解析归入阶段 D）。
