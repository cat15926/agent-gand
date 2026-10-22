# 持续协作 RC01：固定参考契约核验

日期：2026-10-22（Asia/Shanghai）。状态：**RC01 合同核验完成；确认的实现差异及未验组合已分配后续任务，不表示功能全部兼容或允许发布。**

本地运行时代码基线为 `b99997a76d119ab3962b7b493851726b070d2a7d`，schema v34；Clowder 固定为 `8b373123323aacd7e2047dab94fdc15b8f7567ae`，不查询最新 HEAD。本次未修改运行时代码或迁移，保留开始前的进度文档改动；只核验 RC01，不自动实施 RC02/RC03 或 EXT01。

## 1 结论与退出条件

| 核验项 | 已确认的参考行为与本地差异 | 结论 / 后续归属 |
| --- | --- | --- |
| Session 完整兼容性 | 已追参考链按身份、policy/runtime互斥、载体守卫及连续性证据分层，未提供可直接逐字段照搬的统一指纹。本地完整 policy、输入来源与可信 anchor 检查为显式适配和可靠性增强 | 源合同已核验；实际 index/mid-flight、双 resume、自动压缩等仍由 RC05–RC07 验证；扩展载体归 EXT04 |
| 预算与循环 | 上游默认 A2A 深度15、文本目标2、短回复同成员对 warn2/3、block4；本地阈值对应，但非实质工具分类更严格。当前源码不能证明上游采用本地整套财务/次数/活动预算参数 | 源合同已核验；本地根预算是独立可靠性能力，RC05/RC09/RC10 分别补故障、对账和综合验收 |
| hold 来源、SLA 与命令准入 | 上游 timer 要求结构化来源，SLA 用于恢复错过 timer 的有效窗口；本地仅字符串来源及唤醒时刻。上游 command wake 与 timer 共用 hold 额度，本地专用命令工具尚无该共享准入 | **确认缺口**：RC03 补结构化来源、SLA 恢复/过期处置及命令唤醒准入；RC05 补故障窗口。不能把在线 timer 都改为 SLA 硬截止 |
| 工作区 | 上游普通 Thread 使用经校验的 projectPath；本地生产首批为 owner/thread/agent 独立只读目录。Collective 使用另一套 attempt 隔离策略 | 明确平台差异；RC03 登记选定工程与实际 cwd/读写声明的映射，RC06 验真实写竞争/隔离合并责任；Collective 归 EXT02 |
| 语义检索 | 上游有实际接线的 embedding、独立向量召回、hybrid RRF、来源索引和权限复验，默认/降级仍可为 lexical。本地只有明确标注的 literal_substring | **确认缺口**：EXT01；MEM01 整项继续未完成。实模语义质量门槛须单独制定，不能套用上游词法指标 |

RC01 的退出证据是上述逐项源码对照、明确差异、测试与后续用例，现已齐备。K01–K16 的核心合同及 59 项原场景/预期文字全部原样保留；没有用“已登记”代替“已实现”，也没有以较严格的某一项策略推断整体体验等价。

## 2 来源、证据与复核方法

- [固定来源清单](evidence/threaded-rc01-source-manifest.json)：完整 Git tree `2438b2fa77c59780fba846a62b8e531c2f758cea`，15,458 项、未截断，与 T01 留存 commit metadata 对应；113 个缓存文件逐一通过固定 tree 的 Git blob SHA-1，另留 SHA-256、字节数、行数及固定 URL。其中64个文件用于本次分域引用，缓存存在不表示逐行审计全部文件。
- T01 的33个唯一来源文件缓存重新校验既存 SHA-256；新增源码经公开 GitHub Contents API、限流后固定 SHA 的 raw 地址获取。未使用凭据；超时的不完整归档及树响应不用于结论。上游代码只放临时缓存，仓库保留分析和校验信息，沿用 MIT 许可记录。
- 21 个本地运行时/验证文件的字节与本地基线 commit 一致，哈希见清单。按清单的固定链接重新下载后，应同时复核 `gitBlobSha1` 与 `sha256`；不能改用远端最新文件。
- [本地回归结果](evidence/threaded-rc01-local-checks.json)记录本次命令及原始 JSON；上游测试只读源码，不运行其应用、脚本、数据库、embedding 服务或模型。

本次对照是指定契约链的静态核验和本地隔离回归，不是上游全产品动态验收、所有 driver 的证明或真实检索质量验收。不会据有限搜索宣布“上游全仓不存在预算”等否定结论。

## 3 Session：身份、互斥、恢复证据分别核验

| 层次 | 固定参考实现 | 本地实现 / 判断 |
| --- | --- | --- |
| 逻辑身份与链状态 | [SessionManager][U-session] 30–69按 user/cat/thread 保存 CLI ID；[invoke-single-cat][U-invoke-chain] 2431–2525再处理 active/sealing/sealed，链读取失败丢弃 resume。[SessionRecord][U-session-types] 的 capacity pin 明确不存 provider/model fingerprint | 本地不把身份记录或相同 ID 直接当恢复成功；不能寻找一个上游通用 struct 后逐字段照搬 |
| 实际互斥 | [invoke-single-cat][U-invoke-lock] 2591–2675先 policy custody，再锁内重解 logical/runtime ID，再取 runtime mutex；6440–6442逆序释放 | [资源 Session](../../apps/server/src/execution/resources/sessions.ts) 28–31、103–117独立按 backend/account identity generation/host/nativeId 排他；[coordinator](../../apps/server/src/execution/resources/coordinator.ts) 220–265与槽/账号/工作区同事务竞争。policy 变化不允许绕过旧 unknown claim；SQLite 持久 fence 是本地增强 |
| 首批对应 SDK 启动 | [Claude SDK launch][U-launch] 94–101重新编译 L0，133–169冻结请求/launch hook并传 cwd/model/systemPrompt/permission/tools/settings/resume；该构建器未执行本地式全字段 policy hash 冷开检查 | 本地 API 重建与 SDK native 连续性分验；不能宣称本地严格 cold 策略是上游逐字段复制 |
| 连续性证据 | [context-continuity][U-continuity] 65–222将缺可验证 preflight 的载体保持 unknown；[ContextEpochOwner][U-epoch] 175–321处理 unknown/replaced/runtime 不匹配及已确认 compaction。持久 binding 本身不是恢复证明 | [sessionContext](../../apps/server/src/threaded/sessionContext.ts) 119–141、181–225、266–283校验来源、输入截止、seal/compaction 与可信 anchor；[sdkWorker](../../apps/server/src/threaded/backends/sdkWorker.ts) 28–32、63–69检查 native/cwd/输入和终态锚点。真实自动压缩/mid-flight 仍未验 |
| 本地完整 policy | 上游按载体分层，不能由容量 pin 或某个 carrier binding 外推全载体合同 | [sessions](../../apps/server/src/execution/resources/sessions.ts) 62–117包含 owner/thread/agent、backend/version/model、canonical workspace及原路径、informationBoundary、成员/角色/权限/账号版本、definitionHash、账号配置/凭据/身份代际/authType、host；变化保留旧版本并 cold，API 无 native ID |
| 配置冻结与 native 兼容的区别 | 不把上游 launch 参数存在误称为自动 cold gate | [backendRuntime](../../apps/server/src/threaded/backendRuntime.ts) 45–52、96–127另冻结配置；instructions、configDir、native/application tools进入信息边界。准备后配置漂移拒绝；并非整个 configurationHash 中每个预算/timeout 字段都触发 native cold |
| 扩展载体 | OpenCode有专属 workspace guard（invoke 2819–2872）；Kimi L0 hash、AGY typed binding分别见清单 | 这些是 EXT04 的对应实现入口，不计首批 API/SDK 已验。全字段更严格、持久锁与 anchor 均须按本地增强独立验收，不能据静态阅读标真实并发通过 |

## 4 预算与循环：保真阈值和本地增强分开

| 项 | 固定参考 | 本地对照与处置 |
| --- | --- | --- |
| A2A 边界 | [a2a-mentions][U-depth] 19–25默认深度15、文本目标最多2；[durable lineage][U-lineage] 37–83沿已完成响应因果链恢复，遍历保护256 | [routing](../../apps/server/src/threaded/routing.ts) 30–45、[budget](../../apps/server/src/threaded/budget.ts) 204–237持久 parent depth与冻结 root 上限；接力/cross-post 不新建预算。热环境变量与根级冻结是实现差异 |
| 短回复循环 | [WorklistRegistry][U-worklist] 32–121同一无序成员对 warn2/3、block4；输出>200字符或实质工具可重置为1；新用户输入重置 | 本地阈值相同；[tools](../../apps/server/src/threaded/tools.ts) 61的非实质工具列表更广，含 cross_post/status/tracking/Decision/seen/ack，属更严格分类适配。hold回调保留原 streak；不是每次 wake 重置 |
| 财务/次数/活动限制 | WorklistRegistry 明确只管 A2A 投影；[cat-budgets][U-catbudgets] 为上下文容量，不是根财务预算；provider goal tokenBudget、managed-job 并发分别属于其他控制面 | 本地默认300000总输出、24576/请求、20 Invocation、2 Attempt、30分钟累计活动、估算5 USD、1000ms可续活动片和 unknown 保留，都是本地已冻结的可靠性政策，**未证明上游同参**，也不据此宣称上游没有其他预算 |
| 账本和故障 | 不以命名或接口推断参考有本地同等 unknown/费用保证 | 本地先预留后I/O；同 Attempt 活动重叠取并集、不同 Attempt 累加，等待不扣活动但不重置；独立 deadline 不被 hold 延长。RC05验真实故障，RC09对账旧 unknown，RC10验跨接力/修订/替换同根，不因本次66组通过而清零旧预留 |

## 5 hold：已确认的核心缺口及领域范围

| 项 | 固定参考实现 | 本地行为 / 必须补齐 |
| --- | --- | --- |
| 结构化等待来源 | [hold route][U-hold] 250–267：kind 为 github_issue/github_comment/thread_message/task/reporter_handle/managed_command，含非空 value、expectedSignal、正整数 slaUntilMs；reporter_handle另须anchorRef。295–334要求 timer 来源、5秒–1小时、wakeAfterMs/wakeWhen恰选一个，拒绝 pending_input | [tools](../../apps/server/src/threaded/tools.ts) 31、147–150与[cooperation](../../apps/server/src/threaded/cooperation.ts) 180–201只有非空 waitSourceRef 字符串，不能证明来源或等待条件，**不是结构化等价**。RC03补来源校验及边界用例，不能只新增一个可任填 SLA 字段 |
| SLA 的实际消费 | hold 1033–1046写 await.expiresAt；[timer recovery][U-timer-recovery] 17–58检查错过 timer 的身份/ownerAuth/baseline/generation/expiry；[TaskRunnerV2][U-task-runner] 768–787采用 recoverMissed/retryUntil并持久退休。327–329明确仅恢复错过 timer 时额外验证，在线仍为 one-shot | cooperation 195–227只有 wake deadline，停机任意久后到期仍结算 timer_elapsed，无独立恢复窗口/retired_expired。**RC03补有界恢复及过期处置；不把所有在线 timer 改成 SLA 硬取消**。边界等于expiresAt在recovery函数可recover，但runner重试条件为 `< retryUntil`，须分层验，不能笼统同刻都可派发 |
| 到时与业务完成 | hold 964–970要求重新评估，1037–1041 predicate=timer_elapsed | cooperation 227明确 `businessConditionVerified:false`，命令终态也不证明Action完成。这部分保真；现有通过测试不覆盖上述缺口 |
| 额度/幂等/替换 | [hold quota][U-quota] 119–166原子滑窗，thread/cat一小时3次；hold新建失败补偿、同job重试不二扣；参考优先Redis、fallback SQLite | cooperation 183–216以SQLite IMMEDIATE将quota、新timer与旧wait退休同事务；失败保留旧等待。本地单宿主适配与多节点参考不同，分布式范围归EXT05；退休wake不等于停止旧命令 |
| 命令唤醒准入 | hold 769–893的wakeWhen同样经过hold额度，已有job重试在835–849提前返回；ManagedJobService另有默认4并发/同user+cat | 本地[Action commands](../../apps/server/src/threaded/actionCommands.ts) 48–79独立工具/权限/holder/generation/资源，未扣threaded_hold_quota。**RC03须明确命令wake对应准入并补共享额度语义**；不复制模型任意shell字符串接口，不因8组OS生命周期通过而宣布额度等价 |
| 守门领域政策 | [gate-keeping guard][U-gate] 42–50、259–283只针对特殊Thread，短timer≤10分钟、来源及无事件回调策略；当前hold实际传hasEventCallback:false，不是实时探测；grounding shadow不阻断，guard还有缺store的fail-open | 当前普通home Thread没有该ThreadKind。单列为参考业务域，不自动把10分钟上限套到所有普通timer，也不照搬fail-open；RC03明确支持域及所采用的严格策略 |
| tracking 与 timer 分开 | TypedWaitRegistration保留source/owner/generation/baseline predicate，expiresAt可选，持续tracking可无期限 | 不给全部tracking强加timer SLA；RC02补生产来源接线，RC04验真实新事件。已存在callback授权/控制/private来源重验不能替代timer恢复窗口 |

## 6 工作区：普通工程和 Collective 不混用

上游 [invoke-single-cat][U-invoke-workspace] 2690–2809使用 Thread 的 projectPath，游戏虚拟路径、bootcamp及要求绑定的carrier另走分支。[project-path][U-project-path] 125–151执行 realpath、默认denylist/legacy allowlist及目录存在验证；[persistent-project-path][U-persistent-path] 69–135将 disposable runtime checkout 内的路径映射回持久根。普通Thread不能据此解释为自动给每个成员创建隔离worktree。

本地 [productionSettings](../../apps/server/src/threaded/productionSettings.ts) 60–76是 owner/thread/agent canonical工作目录及私有config目录；API无文件工具，SDK首批为Read/Grep/Glob和应用工具，模型执行申请workspace read claim。资源层已有父子路径read/write冲突规则，但这不等于已经交付普通Thread工程projectPath绑定交互、真实并发写作或自动项目合并。

RC03登记选定工程根、成员目录、命令cwd及读写声明的映射，验证符号链接替换、未注册cwd和读声明实际写的拒绝；RC06用真实工作进程证明同工程read/write、write/write互斥，或选定隔离产物并明确唯一合并责任人和版本。未纳入工程组合时继续标未验，不以目录已存在替代工程能力。

[Collective private invocation][U-collective] 27–128只有admitted task上下文、专用工具、无home resume及持续authority复验；[Collective workspace policy][U-collective-policy] 16–40的实际目录包含task hash、execution revision/ref和random UUID，是每native attempt独立目录。不能按注释把它误读成所有普通Thread共享的持久Task目录；其写权限/技能/网络scope交EXT02单独实施。

## 7 语义链：真实存在，但默认、权限和质量有边界

| 链节 | 固定参考事实 | 对本地实施的含义 |
| --- | --- | --- |
| 生产入口 | [index][U-memory-main] 1413–1453、7608–7746、8084初始化memory factory，注入KnowledgeResolver/IndexBuilder/MessageSearch，注册工具/owner路由并启动warmup | 已追到生产调用者，不能再写“只核验interfaces，是否有实现未知” |
| 启用条件 | [factory][U-memory-factory] 133–185及MemoryEmbeddingLifecycle：默认embedding off，显式shadow/on、ready sidecar、sqlite-vec及向量表才激活；默认store mode lexical | 有实现不等于默认运行semantic；文档和消息、project/global/library各有范围，不推断所有collection同配置 |
| 索引与召回 | [IndexBuilder][U-memory-index] 318–810、1679–1888建立文档/消息passage、provenance/sourceHash，变更失效向量；[store][U-memory-store] 769–852、1092–1168、1515–1608独立embedding→NN，以及BM25+NN的RRF，k60 | 语义必须能召回无字面关键词的结果，不能只重排substring已命中项；需绑定模型/维度/来源版本并刷新失效向量 |
| 权限与来源 | [KnowledgeResolver][U-resolver] 39–187、264–330默认library只public/internal，私密须显式authorized集合；[MessageSearch][U-message-search] 94–173、234–361重读canonical消息/Thread并复验grant/viewer/删除/内容，带精确drill-down | 不把collection文档ACL和消息ACL混为一层；本地递归来源/撤权/cutoff边界须继续保留。当前仅展开平台published消息，不等价完整sealed native session体验 |
| 有界查询/降级 | 文档候选max(limit×4,20)且cap100，消息候选≤2000；message sourceCoverage/freshness=unknown、partial=true。依赖不可用显式degraded/reason/effectiveMode=lexical，取消/截止不吞 | 不承诺全量召回；EXT01要返回partial/coverage/hasMore等范围信息，关闭或降级不得冒称semantic通过 |
| 实际测试边界 | [search mode tests][U-semantic-tests]及raw-passage测试预置3D向量/fake embedding，证明独立NN/hybrid逻辑。 [lexical eval][U-lexical-eval] 41–70的Recall@5≥80%明确排除semantic；[embed eval][U-embed-eval] 43–60实模semantic仍为scaffold；RecallFixtureRunner/NDCG/MRR是可参考工具 | 不把注入向量、测试文件存在或词法80%门槛当实模语义质量已验。EXT01冻结本地corpus/model/config、Recall@k/MRR/NDCG及负例泄漏门槛，标明为本地质量合同 |

本地 [knowledge](../../apps/server/src/threaded/knowledge.ts) 14–23、181–200明确是标题/正文substring、按更新时间排序的home查询；54–159已具Binding/cutoff、递归来源ACL、不可变版本、过期/替代与CAS，202–207将privacySources接回工具。基础实现保留，**EXT01仍需索引、embedding、独立semantic/hybrid、跨会话范围和质量验收**。MEM01的语义子项保持未实现/未验证，整项不能标完整通过。

## 8 本次本地检查与保留的失败

| 命令 / 范围 | 本次结果 | 不能替代 |
| --- | --- | --- |
| `pnpm verify:threaded-session-context` | 13组通过：逐项policy变化、来源撤权、anchor/compaction/seal/cutoff、未知围栏 | 真实auto compact、index/mid-flight供应商组合 |
| `pnpm verify:threaded-resource-integration` | 8组通过：canonical alias、Session CAS、资源/Attempt事务与unknown | 真实工程写入/同native双resume组合 |
| `pnpm verify:threaded-budget` | 14组通过：持久root、实际请求计数、unknown、活动并集/idle、deadline与跨Thread深度 | 供应商硬账单封顶或旧unknown已对账 |
| `pnpm verify:threaded-collaboration` | 17组通过：路由/循环、timer/额度/替换、root/streak、权限及征询等；注入HTTP41次 | 本次确认缺失的结构化来源、SLA恢复和命令共享准入 |
| `pnpm verify:threaded-knowledge` | 8组通过：基础来源/字面检索/版本/ACL和工具组合 | semantic或实模质量 |
| activity heartbeat原脚本，临时cwd | 允许本机loopback后6组通过，包含API/SDK buffered progress、慢授权、过期/硬上限/撤权保留unknown | 真实模型故障、自动恢复或生产许可 |

去重合计 **66组通过，真实模型0、fixture外部网络0**；公开源码下载不计作fixture网络。没有读取累计token账本、凭据或日常业务库，不释放既有unknown，也未回写历史T12证据。

心跳首次并行运行和一次顺序复验均在首个API场景失败（expected completed，实际unknown，synthetic elapsed=0）。临时Node loader只在内存暴露被catch的原异常，确认是沙箱 `listen EPERM 127.0.0.1`；API场景同样创建本机listener。随后允许loopback、在临时cwd用**未修改的原脚本**6组全过。两次原失败、一次诊断和处置见[环境证据](evidence/threaded-rc01-heartbeat-environment.json)。这是已定位的测试环境限制，不登记成未定位的预算缺陷，也不用后续成功删除原失败。

## 9 后续任务的最小验收用例

| 任务 | 本次核验明确增加/细化的退出证据 |
| --- | --- |
| RC03 | 结构化kind/value/expectedSignal/SLA与reporter anchor；非法/用户输入式伪等待拒绝；新wait失败保留旧wait；命令wake与timer额度及同job幂等；守门领域范围；SLA过期恢复处置；工程映射/cwd/读写声明 |
| RC05 | 服务停机跨过fireAt、恢复窗口之前/等于/之后分层验证；ownerAuth/baseline/generation漂移退休；未发送有证据才retry，可能已发保留unknown/native fence；不把历史静止后续接当mid-flight |
| RC06 | 不同policy争同native只一holder；旧finally不释放successor；取消A而独立B继续；真实父子路径工程read/write竞争，或隔离产物版本及合并责任 |
| RC07 | 真实instructions/tool/权限变化、跨Thread来源撤权、旧cutoff、自动compaction前后检查cold/resume、nativeId和anchor来源集合；接EXT01后补多来源检索授权/冻结输入组合 |
| RC09 / RC10 | 旧unknown继续可信对账；真实综合链验证same-root预算和循环不被hold/修订/替换重置；明确新增增强、适配与未验范围 |
| EXT01 | 同义改写无关键词召回、词法/语义独有双路、版本/过期/替代、撤权/旧索引/负例、模型不可用显式降级、bounded候选和精确来源；另冻结真实质量门槛 |
| EXT02 / EXT04 | Collective与其他carrier的专属上下文/workspace/L0/native binding/history导入守卫分别实施，不外推首批通过 |

文档本地链接（`pnpm verify:docs`）、`git diff --check`、113个来源文件哈希、30个报告源码锚点及16条核心/59项原文不变检查均通过；本地运行时代码与基线一致。

当前进度和任务依赖已同步到[实施状态](../plans/threaded-collaboration-implementation-status.md)、[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)和[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。日常生产继续closed；本报告不启动迁移、灰度、远端写入或下一个任务。

[U-session]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/session/SessionManager.ts#L30
[U-invoke-chain]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts#L2431
[U-invoke-lock]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts#L2591
[U-session-types]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/shared/src/types/session.ts#L16
[U-launch]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/providers/claude-sdk-launch.ts#L94
[U-continuity]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/context-continuity.ts#L65
[U-epoch]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/session/context/ContextEpochOwner.ts#L175
[U-depth]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts#L19
[U-lineage]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/durable-a2a-lineage.ts#L37
[U-worklist]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts#L32
[U-catbudgets]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/config/cat-budgets.ts#L1
[U-hold]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-hold-ball-routes.ts#L250
[U-timer-recovery]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/infrastructure/scheduler/timer-hold-recovery.ts#L17
[U-task-runner]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/infrastructure/scheduler/TaskRunnerV2.ts#L327
[U-quota]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/hold-quota-store.ts#L119
[U-gate]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/gate-keeping-guard.ts#L259
[U-invoke-workspace]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts#L2690
[U-project-path]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/utils/project-path.ts#L125
[U-persistent-path]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/utils/persistent-project-path.ts#L69
[U-collective]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/collective-private-invocation.ts#L27
[U-collective-policy]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/providers/collective-work-cli-policy.ts#L16
[U-memory-main]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/index.ts#L1413
[U-memory-factory]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/factory.ts#L133
[U-memory-index]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/IndexBuilder.ts#L318
[U-memory-store]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/SqliteEvidenceStore.ts#L769
[U-resolver]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/KnowledgeResolver.ts#L39
[U-message-search]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/MessageSearchService.ts#L94
[U-semantic-tests]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/test/memory/search-mode-split.test.js#L115
[U-lexical-eval]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/test/memory/eval-runner.test.js#L41
[U-embed-eval]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/test/memory/embed-eval.test.js#L43
