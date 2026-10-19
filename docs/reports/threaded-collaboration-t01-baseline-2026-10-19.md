# Threaded 协作 T01 固定源码基线与参考证据

日期：2026-10-19（Asia/Shanghai）。范围：实施指导 T01 的源码、环境、迁移目录、上游兼容行为及许可基线。

本报告完成了固定源码核对，未实现 Threaded 产品能力。所有结论按静态源码证据标注；没有运行真实模型、启动应用、读取业务数据库或凭据。单独的回归测试结果不由本报告替代。

## 1 可复现基线

| 对象 | 固定值 | 核验方式 |
| --- | --- | --- |
| agent-gand 的 Issue 基线 | `996513c673498811bed894b3eecf64382e71af3f` | 本地 Git 对象 |
| 本轮实施 HEAD | `b95dc2553405268a9b807b3983fee8f9facc55fa` | `git rev-parse HEAD` 与固定提交差异 |
| 本轮提交主题 | `fix(chat): separate execution drafts and improve result presentation` | 本地 Git 对象 |
| Clowder 参考基线 | `8b373123323aacd7e2047dab94fdc15b8f7567ae` | GitHub commit API 返回同一完整 SHA |
| Clowder tree | `2438b2fa77c59780fba846a62b8e531c2f758cea` | 固定 commit API 的 tree SHA |
| Clowder 提交主题 | `feat(site): 文档站加「理念」分类，挂上六条思想线 (#1618)` | 固定 commit API |
| Clowder 提交时间 | `2026-10-19T05:05:41Z` | commit 元数据（UTC） |

没有查询或追随上游最新 HEAD。公开上游文件通过 GitHub Contents API 的 `ref=<固定 SHA>` 读取；先前 raw host 连接重置，改用 API 后全部指定文件可读取。未 clone 完整上游仓库。

[机器可读证据清单](evidence/threaded-t01-source-manifest.json) 保存 34 个参考条目、33 个唯一上游文件的完整路径、固定源码 URL、读取 URL、临时缓存位置、字节数、SHA256、计算所得 Git blob SHA1、抽查行及结论。计算的 blob SHA1 是本地内容标识，不宣称已逐个与远端 tree 比对。commit 对象另存 API URL、元数据 SHA256 和固定 tree SHA。

缓存位于 `/tmp/clowder-contract-check/`，可能被系统清理；复核者应使用清单中的固定 URL 重新读取并比较 SHA256。仓库内没有 vendor 上游源码。

## 2 初始工作区与运行环境

开始本任务时记录的既有未提交变更如下，均未由本任务覆盖：

```text
 M docs/README.md
?? docs/plans/threaded-collaboration-implementation-guide.md
```

任务已读取根目录 `AGENTS.md` 并执行 `squad help`。并行协作中的后续文件变化不属于该初始快照；本任务仅写本报告和证据清单两份文件。

| 项目 | 实测 / 声明 |
| --- | --- |
| Node | `v22.23.1`；项目声明 `>=22` |
| pnpm | `9.15.4`；项目声明 `pnpm@9.15.4` |
| OS / 架构 | Darwin arm64，macOS 13.5，build 22G74 |
| 锁文件 | `pnpm-lock.yaml`，相对 Issue 基线字节未变 |
| 锁文件 SHA256 | `789e526fb1e2650c8096f31342824d4dc94b9dfe216840281f751c1b384e3afe` |

该环境快照仅证明当前工具版本，不证明所有原生执行后端均已获得支持。未运行 package install、数据库导入或任何真实模型调用。

## 3 agent-gand 与 Issue 基线的差异

`996513c..b95dc25` 仅有 1 个提交，25 文件变更，330 行增加、45 行删除。完整路径列表在 manifest 的 `local.changedPaths`。

| 变化 | 对 Threaded 实施的约束 |
| --- | --- |
| 新增 `turnDisplayKind`，`LlmDisplayKind` 增加 `control_draft` | 复用执行驱动时必须显式定义新模式展示语义；有 `controlTools` 的回合自动成为 `control_draft`，不能假设自由正文仍作为聊天室消息发布 |
| `agentStep` 仅在 display kind 为 `message` 时存工具轮过程正文；native runner 与 closing call 也使用统一分类 | Threaded 的 post/final、过程输出及正式消息来源需要独立合同；不能因复用公共执行入口丢失消息，或把控制草稿当正式消息 |
| 旧协作与自主协作 `agent.complete.summary` 文案强调完整正式交付正文 | 继续保护旧模式的正式提交语义，不把普通模型 prose 自动补到 summary |
| Web 增加 FlowReplay、Markdown/RunView/状态投影修正，以及对应脚本 | 评估 UI 复用时以新 HEAD 为准；旧 Issue 的行号可能漂移 |

证据：[展示分类](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/apps/server/src/orchestration/turnDisplay.ts)、[过程消息提交](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/apps/server/src/orchestration/agentStep.ts)、[原生流式输出](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/apps/server/src/execution/runner.ts)、[事件类型](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/packages/shared/src/events.ts)。

Issue 所依赖的 Agent 全局互斥、成员 FIFO/租约、会话策略、旧 Run 完成、终态证明、模式入口和启动恢复等关键文件已与固定基线按内容比对；manifest 记录每个文件的 baseline/HEAD/worktree SHA256。`controlTools.ts` 的交付描述变更没有改变其协议边界。`turnDisplay.ts` 是新增文件，旧基线 hash 为 null 属于预期。

数据库相关源码和锁文件没有随该提交变化。仍应按指导拆分模式授权、资源 claim、完成证明及恢复器，不能根据这次主要展示修复假设已经具备 Threaded 生命周期。

## 4 数据库迁移基线

源码 `ORCHESTRATION_MIGRATIONS` 包含版本 1–24；最高版本为 `24 / autonomous-estimated-cost-reserve-v1`。manifest 保存每个版本、名称及 descriptor SHA256。

[迁移目录](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/apps/server/src/db/orchestrationMigrations.ts)声明 descriptor 不可改写，后续升级追加版本。[数据库初始化](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/apps/server/src/db/database.ts)还包含 additive column migration，因此“源码迁移目录最高版本 24”不等于已穷尽全部 schema 演化逻辑。

**未读取业务库，实际数据库已应用版本未知。** 没有 import 数据库初始化模块，未执行 migration/reset/audit。后续结构迁移须在隔离测试数据库验证，并另行记录部署库版本及备份/回滚依据。

## 5 已核实的上游行为

| 范围 | 固定源码结论 | 证据 |
| --- | --- | --- |
| 队列与后继执行 | InvocationQueue 的 canonical state 由 QueueLedgerStore 管理；内存 Map 为投影。serial worklist 只含本次已准入批次，响应后的接力走持久 message_wake | [C01](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L1)、[C02](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L534)、[CX3](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/commit-completed-response.ts) |
| 用户路由 | 当前显式用户 mention 优先，可出现在正文任意位置。隐式路由先考虑 ideate/concierge 特例，再查先前用户提及、健康回复者、偏好或可用参与者、偏好成员与默认成员；线程策略可改变候选 | [C08](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts#L114) |
| 文本 A2A | 与用户解析不同：完整响应后解析，排除 fenced code、自调用；按行首及 Markdown 前缀、最长 alias/token boundary 匹配，最多 2 个目标。默认链深度 15。parallel 独立思考文本 mention 不接力 | [C09](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts#L1)、[CX4](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-parallel.ts) |
| 消息可见性 | 公共消息所有成员可见；未揭示 whisper 只向 whisperTo 成员可见。该 helper 的 user viewer 全可见前提不能替代租户/线程授权。公共 reply preview 不得引用未揭示 whisper | [C03](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/visibility.ts#L175) |
| 上下文 | assembler 排除未投递、显示专用系统消息、briefing 等内容，按预算从新到旧纳入；候选与可见性筛选仍由 route 等调用方负责，不能把 assembler 当完整 ACL | [C04](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/context/ContextAssembler.ts#L225) |
| 游标 | delivery、seen、mention ACK 独立；seen 不推进 delivery。配置了解析器时，不可解析的旧游标 mutation 失败关闭 | [C21](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/ports/DeliveryCursorStore.ts#L68) |
| 执行槽与 Session | 槽按 thread+cat，释放校验同一 reservation；稳定 managed-conversation policy mutex 与原生 runtime/session mutex 分离，按先 policy 后 runtime 获取，锁内重新解析恢复目标 | [CX1](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts)、[CX2](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts) |
| Collective | 私有工作使用任务 workspace、新鲜任务上下文、受限技能根和 toolExecutionPolicy；执行前与执行中重新验证 authority。公共 Collective context 也按服务/集体/频道/root 过滤 | [C05](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/collective-private-invocation.ts#L51)、[C04](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/context/ContextAssembler.ts#L225) |
| 循环与 SOP | Worklist 仅负责从持久因果史重建的深度/ping-pong guard；warn=2、block=4，存在实质工作豁免。SOP stage hint 在 serial route 为 info-only；port 本身还暴露 managed-work admission，不能据此推断所有 SOP 能力无业务权限 | [C10](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts#L1)、[C12](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts#L1)、[C02](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L534) |
| 显式 post 与 final | 两条 authored message 各有独立来源；先前 post 的目标不能吞掉 final 对同一目标的显式提及 | [C25](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L3151) |
| Action | active registry 两类为 review_delivered、task_done；完成要求服务端 truth、freshness、代际和真实 producer/ports。生产接线在 Redis 分支，不能声称无条件跨 backend 可用 | [C07](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionTerminalPredicateCatalog.ts#L181)、[C13](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts#L111)、[C14](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionSuccessorCompletionService.ts#L20)、[C18](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/index.ts#L8000) |
| Review | 交付不等于通过；ArtifactReview 的 human decision、changes_requested、reopen、新版本评审轮次为独立领域转移 | [CS3](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/action-terminal-predicate-truth.ts)、[C15](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/collaborative-content/artifact-review/reducer.ts#L93) |
| 替换责任 | replacement 校验持久身份、claim origin、return proof、freshness，并以 expectedGeneration 进入存储 CAS | [C16](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionSuccessorReplacementAdmission.ts#L154) |
| 知识 Evidence | interface 包含来源 hash、supersededBy、provenance、authority、摘要 source IDs 等；这只确认数据合同，未证明检索实现和 ACL 全链 | [C17](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/interfaces.ts#L92) |
| 等待与外部跟踪 | hold timer 5 秒至 1 小时，带 wait source/SLA；wakeWhen 互斥；不用于人类输入。每 thread/cat 原子滑动窗口 3 次/小时；新 wake 先可靠注册再退役旧 wake。typed tracking receipt 绑定 owner/generation，digest 纳入注册 baseline，持续等待可无 expiresAt | [C20](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-hold-ball-routes.ts#L242)、[C23](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/TypedWaitRegistration.ts#L14) |
| 启动恢复 | 已知存活外部执行受到保护；外部 owner snapshot 不完整时保留运行中的未知执行，不直接全部标失败 | [C18](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/index.ts#L8000) |
| 特定 Codex carrier | `assertCodexManagedPlatformSupport` 限 Darwin、原生 carrier、精确 `codex-cli 0.159.0`、policy probe 与账号身份。此限制只描述该 managed 路径 | [C19](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/config/codex-managed-support.ts#L8) |
| 用户决定 | 认证后旧 request_user_input 返回 410；ordinary invocation 的 interactive once Decision 创建后立即返回。manage 要 expectedRevision/operationId；settle 限 strict invocation 的确切 origin 用户消息，且消息须在卡片发布之后 | [C24](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-runtime-interaction-routes.ts#L85)、[C11](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callbacks.ts#L3032)、[CS5](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/runtime-interaction/RuntimeConversationDecisionService.ts) |

## 6 必须登记的补充与差异

1. **multi_mention 的 review Action 禁入。** 固定源码拒绝 `actionFamily: review`，指向普通 durable A2A 的 localReviewVerdict、reviewedHeadSha 与 accepted-source 合同。本地评审工具准入和测试需要分流，不能把征询和 review custody 合并。[CS2](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-multi-mention-routes.ts)
2. **parallel 目标数存在 return 例外。** 普通 parallel 至少两个目标；`parallel + returnToPredecessor` 恰好一个 predecessor 目标。两种都要求 parallelIntent；有 Action 元数据必须带 idempotencyKey。[CS1](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/mcp-server/src/tools/callback-tools.ts)、[CS2](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-multi-mention-routes.ts)
3. **multi_mention 持久化属于增强。** 上游 group/response/idempotency/controller/timer 在进程内。MCP 客户端要求 searchEvidenceRefs 或 overrideReason，HTTP schema 并无同样必选组合；这不证明搜索质量。[C06](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts#L39)、[CS1](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/mcp-server/src/tools/callback-tools.ts)、[CS2](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-multi-mention-routes.ts)
4. **可靠汇总 callback 不能当作已验证的上游能力。** 抽查 route 的 flush 写入 mentions=[] 汇总并广播；callbackTo 仅出现在展示 metadata，未见该路径唤醒 callbackTo。timeout 回调标记状态但未调用 flush；flush 写失败仅记录错误。Threaded 的唯一可靠 settlement、超时汇总、outbox 和 callback wake 应明确记为目标合同/增强。未运行产品，也未穷尽其他模块的潜在消费者。[CS2](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-multi-mention-routes.ts)
5. **私密信息边界与可见性 helper 不等同。** 上游 user viewer 全可见依赖上层认证 scope；新项目不可因此绕过已有 owner/tenant/信息边界。Collective 的 scoped 行为也不能套用普通 home-thread 共享规则。[C03](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/visibility.ts#L175)、[C05](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/collective-private-invocation.ts#L51)
6. **新 HEAD 的 control_draft 必须进入适配清单。** Threaded 协作工具若通过 controlTools 注入，会触发展示分类；为 post/final 和正式消息制定明确入口，防止草稿丢失或错误公开。[当前实现](https://github.com/cat15926/agent-gand/blob/b95dc2553405268a9b807b3983fee8f9facc55fa/apps/server/src/orchestration/turnDisplay.ts)

## 7 许可与复用边界

固定版本 LICENSE 为 MIT，版权行为 `Copyright (c) 2026 Clowder AI Contributors`。复制或使用源码的实质部分时须保留版权及许可声明；后续若实际复制代码，应随对应文件/分发包登记来源和许可。[固定 LICENSE](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/LICENSE)

本任务只把 URL、hash 和分析写入项目，上游源码留在 `/tmp` 临时核查缓存，没有复制实现进仓库，因此此次没有新增 vendored-source NOTICE。此项是固定许可文本核对，不是对其他资产、商标、依赖或未来复制范围的全量审查。

## 8 验证范围及交接

已完成：固定 Git 差异读取、环境版本、锁文件和关键源码 hash、版本 1–24 的迁移 descriptor hash、上游固定 commit 对象核验、C01–C25 与 9 个补充条目的定点源码审查、许可读取。机器清单可解析，条目包含固定 ref 与 SHA256。

未完成/不在本报告范围：真实模型与跨后端验收、数据库已应用版本、实际恢复与取消演练、业务事实 producer-resolver 运行验收、端到端 ACL、完整上游测试或安全审计。没有用类型/注册表存在替代这些运行验证。

后续 T02 及实施阶段以本 HEAD 为本地底座，以固定上游 SHA 为兼容参考；把第 6 节差异写入相应协议/验收任务。源码参考更新时新增差异记录，不静默替换该 manifest。部署库读取与迁移必须另行记录实际授权、隔离范围和证据。
