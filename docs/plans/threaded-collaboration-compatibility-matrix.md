# 持续协作兼容矩阵与验收范围

状态：**T01–T11 已按记录范围交付；T12 主体和所列分层验收已提交推送，整体发布验收未完成**。更新：2026-10-23。RC01/进度文档已推送 `35804a1`，RC02已推送`a871910`，RC03首批选定命令profile与hold合同已推送`ee751a3`；RC04生产跟踪分享桥接及所列隔离/进程验证已完成，真实观察已结束、not_observed，完整真实链未通过，变更未提交。代码schema保持v35，历史v25–v34不变；默认closed，日常未配置/启用、未迁移。产品名为“持续协作”，内部标识 `threaded`。

本文件配套[实施指导](./threaded-collaboration-implementation-guide.md)，把 [Issue #16](https://github.com/cat15926/agent-gand/issues/16) 的 K01–K16、T01–T12 和 59 个原验收 ID 转为可追踪清单。用户确认的四项目标为：**核心规则不简化、平台差异显式登记、可靠性增强单独验收、高级能力逐项说明范围**。剩余实现、补验、对账与发布操作按[剩余工作计划](./threaded-collaboration-remaining-plan.md)分列；RC01–RC03已按记录范围完成，RC04本次实现及分层验收已执行，本轮真实观察已结束为not_observed，H1/H2完整真实领域退出条件未满足；其他RC/EXT不因列入计划而自动开工。

以下 T01–T11 段落记录各阶段当时的交付与验证口径；各阶段的“待后续”不覆盖 T12 已有结果，当前逐项状态以本表第 2–7 节为准。

T01 当时完成设计和来源映射；T02–T06 已交付身份/隔离、可信 Binding、共享资源、消息/Outbox、持久调度与根预算，T06 已提交推送为 `79bad41`，见[T06 证据](../reports/threaded-collaboration-t06-runtime-2026-10-20.md)。T07 新增 v30、精确 manifest、单条投递账本、三类游标、Session 边界及 API/SDK 适配，见[上下文与后端合同](../architecture/threaded-context-backends-v1.md)和[T07 证据][T07]。未标注完成的能力仍为目标合同，旧模式代码、上游源码和文档检查不替代功能验收。

T07 当时的隔离验证为 context 14 组、Session 13 组、backends 14 组、backend-runtime 7 组及迁移 13 组。真实验证限 macOS、同一已授权配置账号、`glm-5.3` 的 Anthropic-compatible 接口与 `claude-sdk 0.3.288`：API 两次请求验证重建及私密排除；SDK 三次请求验证冷开、同 nativeId 续接及权限变化冷开，第四次实际请求取消后保留 unknown 且不重放。追加的[真实重开证据](../reports/evidence/threaded-t07-real-sdk-reopen.json)已验证同 harness 进程内关闭并重建 runtime 与 SQLite 连接，使用新资源 owner 和持久 anchor 续接同 nativeId/marker，恢复阶段实际请求为 0；这不等于主服务完整进程重启。原生自动压缩未真实触发；OpenAI 协议只有隔离证据。上述结果不代表真实业务验收，当时生产入场关闭且无executor；T12现已接受信生产factory，日常仍关闭；T08 工具/路由/等待/征询已实现；T09 UI与授权同步已实现；T10 Action已实现并完成所列分层验证，T11 Review/Revision、SOP与基础知识已实现；语义检索仍未实现。

T08 当时以已推送 `a773698` 为基线，新增 v31；17组协作、4组实际SDK/HTTP工具接线、4组专用HTTP、14组迁移验证通过，见[T08报告][T08]与[T08合同](../architecture/threaded-collaboration-v1.md)。macOS同一账号真实API/SDK读取及发送工具通过；首轮征询SDK cancelled失败保留、原因未定位，新隔离双成员征询复验通过唯一结算和回调。T08新增14请求/22,757确认token，累计75,327含旧未知预留39,010。隔离E01–E06与真实成功路径分开记证，不能宣称全部59项通过。

T09当时在已推送T08 `606a8c0`上实施：4组客户端/4组投影HTTP/11组实际Chrome验证、旧聊天UI五组及相关回归通过；实际隔离HTTP进程SIGKILL后从同SQLite恢复。无新增schema或真实模型调用，准确范围及三张截图见[T09报告][T09]。T10/T12 的后续证据见下段；当前完整真实生产发布故障组合仍未验，不能用 UI 通过替代业务完成。

T09当时已推送 `72efefd`；T10追加v32，12组Action、12组实际Chrome、15组迁移及真实GitHub GET/本地review交付通过，见[T10报告][T10]和[领域合同](../architecture/threaded-actions-v1.md)。真实新远端事件未在等待中出现，动态唤醒仅注入验证；T11的完整Review/Revision及门禁另记下段；当时具体 OS 命令端口/生产发布留 T12，现有 T12 子项见下段。T10 无新增模型 token，当时生产入场关闭。

T10当时已推送 `c944c9d`；T11在其上追加v33、完整accepted-source/版本/恰好一位作者的普通A2A评审、finding逐项修订/独立核验/当前HEAD门禁、SOP CAS与精确task_done verifier、home基础知识和ACL。9/6/8组隔离、15组实际Chrome、16组迁移和22次真实GitHub GET通过，见[T11报告][T11]及[合同](../architecture/threaded-workflows-v1.md)。完整修订/approved/新HEAD推进竞态的PR传输为注入；真实域验证为changes_requested交付与blocked门禁。历史门禁快照不授当前批准；新增可靠性故障、既有E增强及高级范围继续分列，MEM01整体未全过。T11已提交推送 `ba438b1`，日常生产关闭。

T12已提交推送 `b99997a`，在T11基线上追加v34、固定pack/根授权、独立入场与派发、observe只读、启动屏障/有界退出及macOS注册命令。17组迁移、7/16/9/4/8/5组分层验收通过，见[T12报告][T12]。真实API五工具和修复后SDK五工具/隔离HTTP服务原生续接通过，前两次失败保留；48次官方GET/606秒未观察远端新HEAD，not_observed。日常未激活；未通过/未验证项继续保留，不宣告全部59项通过。

[RC04][RC04]新增[真实领域验收合同](../architecture/threaded-live-review-acceptance-v1.md)，修复生产GitHub caller-only跟踪回调阻断修订/独立复审的缺口：受信private audience与原来源ACL取交集，冻结grant/identity并于派发重验；generic与旧wait不自动共享。38组专验已通过（transport12/生产delivery授权6/分享7/同Action注入链9/实际worker进程4），另70组相关回归通过，共108组；PR事实/模型答复的注入层不替代真实领域层。完整真实退出要求单Action、同root的H0→H1→H2两次自然HEAD；本轮609秒/71次官方GET、17轮poll/66次PR事实已结束，目标`#1698/#1701/#1505`均0新HEAD/0tracking callback，结果not_observed，H1/H2完整真实链未通过。3目标各一次实际SIGKILL、共6 PID，恢复0额外GET/0脚本重放且原ID/计数保持；真实基线恢复不等于动态新事件唤醒，原T阶段证据不覆盖。

## 1 固定基线、分类与状态口径

| 对象 | 基线与用途 |
| --- | --- |
| Clowder | `8b373123323aacd7e2047dab94fdc15b8f7567ae`；所有 C 类源码链接固定到此提交，不表示最新版本 |
| Issue 的 agent-gand | `996513c673498811bed894b3eecf64382e71af3f`；用于保留原迁移分析上下文 |
| 历史本地核对版本 | `b95dc2553405268a9b807b3983fee8f9facc55fa`；保留当时分析基线，本地链接指向当前工作区 |
| 当前实现版本 | T12代码b99997a、RC01文档35804a1、RC02 a871910已推送；[RC03][RC03]首批命令profile/hold已推送ee751a3；[RC04][RC04]当前变更未提交、真实not_observed、完整链未通过；代码schema v35；默认closed，日常未配置且未迁移 |
| T01 首批目标 | 普通 home Thread 的完整核心合同，包含 Action、Review/Revision、基础知识和 SOP；阶段 4 仅是中间里程碑 |
| 首批后端与平台 | 模型 API + `claude-sdk`；macOS 首验，Linux 后续验证。API 上下文重建与 SDK 原生连续会话分别验收，其他 driver 作为扩展 |

差异分类可以组合，但不得互相替代：

- **保真**：以固定上游可观察协议行为为目标；同消息、成员、权限和结果下比较目标、可见范围、允许的顺序及状态，不要求随机模型逐字输出相同文本。
- **适配**：由 agent-gand 的 SQLite、身份、Run、驱动或界面产生的实现差异；若影响可观察行为，必须写明，未解决的核心差异不能标兼容通过。
- **增强**：本地新增的可靠性保证，独立使用 E 编号和故障证据；不反向宣称上游已有同等保证。
- **范围**：本批未纳入的高级组合或后端；不等于功能已经验证。既定核心规则、基础知识权限与 SOP 不能以此免验。
- **待核验**：现有来源不足以确认的上游细节或实际生产接线；进入对应任务前核验固定源码，不根据类型名推断能力。

原始 C01–C25 链接继承 Issue 的源码索引；此前局部静态核对覆盖 Action、普通响应、征询与 Decision 等。2026-10-22 [RC01][RC01]追加核验 Session/工作区、预算/循环、hold/SLA 与实际检索链，固定来源113个文件校验、64个分域引用，本地66组隔离回归通过；这不表示逐行审计所有缓存或已完成动态等价验证。未在本次范围的语义继续按实际证据标待核验。

## 2 K01–K16 核心合同

“核心合同”列保留 Issue 原文。引用的上游文件支持对应机制或提供入口；K06、K14、K16 中的新旧模式共存要求是本地集成合同，并非宣称 Clowder 存在 agent-gand 的旧模式。

| ID | 核心合同（不可简化） | 固定参考源码 | 本地目标/差异分类 | 任务包 | 关联原验收 ID | 实现 | 验证 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| K01 | Thread、Invocation 和 Action 分别持久化生命周期；队列清空不等于业务完成 | [C01]、[C13]、[C14] | Thread/Invocation/Action 分开持久化，Invocation 唯一执行 Run 适配；保真+适配 | T02、T03、T06、T10 | ISO05、A01–A07、UI01 | Thread/Invocation/Action独立持久化已实现 | [T10][T10] 平台任务/真实GitHub域与普通Invocation分离；[T12][T12] 发布控制与分层恢复已验，完整真实发布组合仍未通过 |
| K02 | 消息存储、可见性、路由和模型上下文投递是四个不同步骤 | [C03]、[C04]、[C21] | Message/ACL/Delivery/Wake/Context delivery 独立事实；保真+适配 | T05、T07、T09 | CTX01–CTX05、M02、UI01 | T05–T09四类事实与独立UI/精确回执已实现 | [T08][T08]工具曝光及[T09][T09]实际UI区分保存/排队/执行/上下文/回应/业务状态通过 |
| K03 | 有效响应完成后形成可恢复的后续 wake；不能只依赖进程内回调 | [C01]、[C02]、[C25] | 响应与后继 wake/outbox 同事务；保真+适配；征询独立增强见 E01–E05 | T05、T06、T08 | REC01、REC04–REC05、M01、MM04 | 响应及征询/等待回调wake/outbox已实现 | [T12][T12] 实际组合服务提交后崩溃、后继恢复、征询partial/deadline唯一回调通过；供应商传输注入 |
| K04 | 同一幂等请求重试不产生第二份消息、第二次逻辑唤醒或第二次业务转移 | [C01]、[C11]、[C13]、[C25] | 按来源消息/请求身份及 Action 业务身份幂等，同键异内容冲突；保真+适配 | T05、T06、T08、T10 | DB01–DB02、M01、M03、A01 | 消息/工具/等待及Action业务身份幂等已实现 | [T10][T10] 真实双进程唯一准入、事务故障/幂等回执通过 |
| K05 | 同槽启动须有原子领取和所有者代际；旧执行不能释放或提交到新执行的槽 | [Queue 同槽所有者][X01]、[C13]、[C16] | owner/generation/fencing token 控制领取、提交和释放；保真+适配 | T03、T04、T06、T10 | ISO03、Q01、Q06、REC05、A03 | 执行槽/Action代际围栏及RC03独立命令多workspace资源已实现 | [T12][T12]历史macOS独立claim/旧代际/伪造PID/IPC与owner退出证据保留；[RC03][RC03]当前注册、代际及资源复验分层结果另记，扩展平台未验 |
| K06 | 线程级执行槽、实际原生 Session 锁、账号容量和文件资源冲突分别管理 | [Session 锁][X02]、[C19] | 统一旧独占/thread-slot/session/account/workspace claim 冲突矩阵；保真+本地混合模式适配 | T04、T07 | Q01–Q06、OS01 | 资源、Session及RC03独立命令多read/write claim已实现 | [RC03][RC03]资源19＋集成8＋旧资源11组本轮回归通过；[T07][T07]同nativeId续接通过，完整真实并发仍RC06 |
| K07 | 成员会话只恢复到兼容的身份、工作区、账号、模型、工具和权限边界 | [Session 锁][X02]、[C04]、[C19] | Thread/Agent 稳定 Session 绑定、完整本地 policy 和可信 anchor；[RC01][RC01]确认上游按身份/互斥/载体守卫/连续性分层，已追链未提供可直接照搬的统一指纹；本地更严格 cold 策略为适配+增强 | T03、T07 | ISO03–ISO04、Q04、CTX06、OS01 | T07身份/权限/输入边界及锚点、RC03选定工程映射身份已实现 | [T12][T12]真实SDK静止后续接证据保留；[RC03][RC03]工程/成员/命令目录映射与路径漂移围栏已接，完整真实index/mid-flight/压缩仍未验 |
| K08 | 可读取的公共消息按成员游标和预算组装；不能共享其他成员私有模型 transcript | [C03]、[C04]、[C21] | 精确输入 manifest、预算、delivery/seen/mention_ack 分离及单条补投账本；保真+适配 | T07 | CTX01–CTX06 | T07 manifest/预算/精确集合/三游标已实现 | [T07][T07] context 14 组通过；真实 API 重建和私密排除、SDK 续接通过；不读取其他成员 transcript |
| K09 | 私密信息及其摘要、附件和衍生上下文保持授权边界；收件人不等于可见受众 | [C03]、[C05]、[C17] | ordinary Thread 的消息/附件/摘要/搜索同一 ACL；Collective 特殊路径另列范围，不削弱普通私密隔离；保真+适配 | T05、T07、T08、T11 | CTX01–CTX02、M02、MEM02 | 消息/SOP/知识/Session来源ACL及RC02/RC03回调授权复验已实现；RC04新增GitHub受信private audience与原ACL交集 | [T11][T11]基础私密/撤权、[RC02][RC02]tracking撤权及[RC03][RC03]hold/命令围栏保留；[RC04][RC04]7组实际cooperation/ACL及6组生产授权覆盖冻结grant/identity、paused撤权拒绝、新成员不追加入旧audience；generic/旧wait保持caller-only，Collective仍后续 |
| K10 | 普通消息接力不自动创建必须完成的业务 Action；业务交接使用结构化身份与责任 | [C02]、[C11]、[C13] | 普通接力只生 wake，结构化业务交接验证身份/standing/代际；保真 | T08、T10 | M01–M03、A01–A03 | 结构化责任准入和普通A2A边界已实现 | [T10][T10] A2A可求助但不授予standing；canonical身份重复safe_wait |
| K11 | 业务完成由服务端解析领域事实；Agent 的完成声明只形成候选 | [C07]、[C14]、[完成事实][X08] | review_delivered/task_done 真实 producer-resolver-freshness 链；保真+领域系统适配 | T10 | A02–A05、A07 | task_done/PR review_delivered及生产可选GitHub来源已接；RC04补跟踪到修订的受信分享桥接 | [T10][T10]既有真实域通过；[RC02][RC02]provider7项/8GET保留；[RC04][RC04]同Action双HEAD注入链及进程恢复通过，真实观察已结束、not_observed，H1/H2双自然HEAD完整链未通过 |
| K12 | Review 交付、Review 通过、修改完成和再次评审是不同状态或事件 | [C13]、[C15]、[完成事实][X08] | 交付/verdict/修改/复审分开，冻结被审 revision；保真+领域政策适配 | T10、T11 | A04–A06 | 交付、verdict、逐项修订、独立复审及门禁分别持久化；RC04单Action同root链已接 | [T11][T11]真实changes_requested完成责任但blocked保留；[RC04][RC04]9组注入链覆盖旧approved失效、逐项attested/verified及不同本地reviewer复核，4组实际进程恢复；真实观察已结束、not_observed，H1/H2双自然HEAD闭环未通过 |
| K13 | 已有外部副作用或执行结果不确定时，不盲目重放模型调用或写操作 | [C18]、[C01] | 外部执行 unknown 与副作用对账，保留 fence；保真+宿主/驱动适配 | T03、T06、T07 | REC02–REC06、OS01 | 执行unknown、可信静止/传输证据及RC03独立命令副作用verifier已实现 | [T12][T12]实际服务可能发送后不重放、SDK未知费用保留；[RC03][RC03]选定profile完整副作用域与独立租约核验另记，供应商最终对账仍RC09 |
| K14 | 重启恢复以持久事实为准，缓存是投影；每条记录只有一套模式恢复器负责 | [C01]、[C18]、[领域恢复][X09] | 按 mode/origin 唯一恢复器，先外部存活再恢复投影最后派发；保真+本地共存适配 | T03、T06、T10、T12 | ISO02、ISO04、REC01–REC06、A07、OPS01 | 消息/等待/UI及task_done领域恢复已实现；RC04补生产GitHub双轮链的worker恢复 | [T12][T12]实际index/启动屏障及24个组合服务子进程证据保留；[RC04][RC04]4组实际worker进程恢复验证持久Action/root/唯一callback/Review，PR与模型传输为注入；真实供应商全窗口仍未验 |
| K15 | 每次 wake 不重置整个因果链的预算和循环限制；费用未知与执行未知分别记录 | [C10]、[C20]；[RC01][RC01]已核验深度/循环及预算职责边界 | 持久因果链预算/循环限制；费用与执行unknown分开。本地财务/次数/活动上限为新增可靠性政策，未证明上游同参；A2A阈值保真+分类适配 | T04、T06、T08 | R04、W03、B01–B02 | 接力/等待/Action修订继承原root，RC03 timer/command wake共享hold准入已实现 | [T12][T12]同根排空/预算不重置证据保留；[RC03][RC03]共享3次/小时、同job复用及恢复SLA边界单独验收，未知费用不释放 |
| K16 | 旧 Collaboration、自主协作及其他执行路径维持原来的契约和权限行为 | [Issue #16 §3](https://github.com/cat15926/agent-gand/issues/16)；本地[RunMode](../../packages/shared/src/run.ts)、[旧控制工具](../../apps/server/src/collaboration/controlTools.ts)、[自主入口](../../apps/server/src/collaboration/autonomousEntry.ts) | 独立 threaded 入场/执行/恢复/终态，保留旧契约；本地适配 | T02–T04、T06、T12 | ISO01–ISO05、DB03、Q03、OPS01 | 独立Thread UI/数据通道与旧模式隔离已接；生产入场关闭 | [T12][T12] 旧隔离/资源/控制/终态及真实Chrome回归通过；实际index关闭模式保持历史，完整真实模型混跑未验 |

## 3 易产生体验差异的细化行为

这些 F 编号是核心合同的展开，不替代 K 或原验收 ID。“局部静态核对”只表示此前读取过相关分支，不是上游全链路或本地行为已通过。

| 项 | 固定参考与核验边界 | 本地目标及差异分类 | 任务包 / 原验收 | 实现 / 验证 |
| --- | --- | --- | --- | --- |
| F01 用户路由 | [C08]；完整 fallback 顺序待移植时逐分支核验 | preferred、值班、近期点名、健康回答成员、默认成员等按参考策略；用户输入与 Agent A2A 分策略，preview 共用准入函数；保真，不能任意选默认成员 | T08 / R01–R02 | T08已实现/隔离通过：完整fallback、群组、preview；见[T08][T08] |
| F02 文本接力 | [C09]、[C10]、[并行文本边界][X03] | 完整提交后行首 handle、代码围栏排除、token 边界/长 handle 优先、自身过滤；两个文本目标、默认深度15；独立思考并行文本提及不接力；持久循环警告/阻断/重置；保真 | T06、T08 / R01、R03–R04 | T08已实现/隔离通过：两个行首目标、并行抑制、持久warn/block/reset；见[T08][T08] |
| F03 post/final/cross_post | [C11]、[C25]；普通响应路由局部静态核对 | 显式 post 独立提交，final 合法提及是不同消息；禁止旧模式跨 source 的文本语义去重；跨 Thread 验证实际授权，不复制私有 transcript；保真+适配 | T05、T08 / M01–M03 | T08已实现/工具组合通过：post/final独立、cross_post授权；见[T08][T08] |
| F04 征询 | [C06]、[MCP 参数][X04]、[Action 准入][X05]；局部静态核对 | 1–3目标，默认8分钟、3–20分钟范围，anti-cascade，每目标首个有效回复；保留原回答及各状态，不用旧 consult-any 胜者取消机制；保真。持久结算另列 E 项 | T08 / MM01–MM04 | T08已实现/限制及逐目标原答隔离通过、真实双成员复验通过；见[T08][T08] |
| F05 征询入口差别 | [MCP 参数][X04]、[Action 准入][X05]；局部静态核对 | MCP 要求 searchEvidenceRefs 或 overrideReason；HTTP schema 没有同等组合校验，分别登记入口政策；引用存在不证明搜索正确。action metadata 要 idempotencyKey；review 不经 multi_mention；parallel 普通至少2目标、returnToPredecessor 拒绝责任返回恰好1前任且仍需 parallelIntent；保真，不能泛化校验 | T08、T10 / R02、MM03、A01、A03 | T08 工具/内部端口已实现；T10 专用 Action 工具落实 standing、parallelIntent、冻结前驱返回及代际政策，multi_mention 拒绝 Action metadata/review 捷径；此入口适配见[T10合同](../architecture/threaded-actions-v1.md)与[T10][T10] |
| F06 hold/命令唤醒 | [C20]、[命令代际][X10]；[RC01][RC01]已追恢复/过期消费链 | 5秒–1小时、结构化waitSourceRef；SLA限定错过timer的恢复窗口及过期处置，不把在线one-shot一律改硬截止；滑动一小时每Thread/Agent最多3次，命令wake须有对应共享准入；同job幂等、新建后退休旧wake；非阻塞/同槽互斥、旧命令另取消、timer_elapsed不证明业务完成；保真+进程适配 | T08、T10、T12 / W01、W03–W04、OS01 | [RC03][RC03]已实现结构化来源/anchor授权及私密衍生、missed-timer SLA恢复/过期退休、timer/command wake共享3次/小时与稳定job幂等；ordinary/守门专域显式区分，在线one-shot不统一硬截止。等待14/命令准入4组通过，实际production及原生边界详见报告；真实供应商停机组合仍RC05，日常未注册 |
| F07 外部 tracking | [C23]、[等待恢复][X11] | 冻结live baseline与匹配条件，历史不立即触发；正式tracking和持久waitOutcome，不以周期hold替代；保真+事件生产者适配 | T08、T10、T12 / W01、W05 | [RC02][RC02]生产可选GitHub注册/官方GET/撤权围栏保留；[RC04][RC04]补受信private audience、原来源ACL交集及grant/identity冻结复验，generic/旧wait不自动共享。38组专验通过；原T12 48GET/606秒not_observed保留，本轮609秒/71次官方GET未观察新HEAD，结果not_observed，H1/H2完整真实动态链未通过，日常未配置 |
| F08 人类回应 | [C24]、[创建限制][X06]、[结算绑定][X07]；局部静态核对 | 新模式参考request_user_input返回410；ordinary invocation的interactive block/once产生非阻塞Decision，注册不强制结束当前Invocation；早到回应只排后继wake，不绕同槽互斥提前启动；settle/withdraw/supersede有版本及操作身份；responseMessageId必须是认证Invocation真实origin trigger并校验用户/Thread/时间/未删除；不等于业务批准；保真 | T08 / W02、W06 | T08已实现/隔离HTTP及工具通过；普通Decision不授业务批准；见[T08][T08] |
| F09 Action 完成 | [C07]、[C13]、[C14]、[完成事实][X08]、[生产接线][X12]；注册表/完成路径局部静态核对 | 服务端依据真实producer/resolver核验review_delivered/task_done；standing、generation、freshness、ACL校验后CAS；返回、替换和投影均恢复；保真+SQLite/领域适配。上游注册表存在不代表所有配置可用 | T10 / A01–A05、A07 | T10/T11领域/门禁已验；[RC02][RC02]生产PR source接入既有Review producer/resolver，18新组含当前HEAD/typed交付与blocked gate；真实新事件组合仍未通过 |
| F10 评审/修订 | [C15]、[C16]、[Action 准入][X05] | 普通讨论不强制评审流水线；本地评审走普通持久A2A并绑定localReviewVerdict/reviewedHeadSha/accepted-source；changes_requested可完成评审责任但不通过批准；新HEAD重新评审；保真+具体领域政策 | T10、T11 / A03–A06 | T11合同及[RC02][RC02]接线保留；[RC04][RC04]同Action/同root的H0→H1→H2注入链及实际worker恢复通过，明确旧批准失效、交付/门禁分离和逐项独立复核；单GitHub principal与不同本地Agent身份分列，scripted报告不是实质工程评审，真实观察已结束、not_observed，H1/H2双自然HEAD链未通过 |
| F11 角色/SOP/知识 | [C12]、[C17]、[角色名册][X13]、[SOP CAS][X14]；[RC01][RC01]已追实际索引/embedding/NN/hybrid/权限链 | 稳定handle和版本化角色/SOP，expectedVersion CAS；attested/verified/unknown分开；基础anchor/近期查询/来源展开/ACL是首版目标；完整语义记忆另列范围，不宣称字符串搜索等价；保真+检索适配 | T11 / SOP01–SOP02、MEM01–MEM02 | T11首版基础范围已实现，SOP6/知识8组及[RC01][RC01]知识8组回归通过；本地literal非语义，EXT01仍缺独立召回/排序和实模质量合同，MEM01整体仍未完整通过 |
| F12 上下文/Session | [C03]、[C04]、[C21]、[Session 锁][X02] | delivery/seen/mention_ack独立；seen不抑制增量注入，ACK不完成Action；同波输入冻结；权限收缩冷开或获权摘要重建；SDK原生会话与API重建分别呈现；保真+后端适配 | T07、T12 / CTX01–CTX06、Q04 | T07 已实现；[T07][T07] context 14/Session 13 组 fixture、真实 API 重建与 SDK cold/resume/权限冷开；[T12][T12] 真实 SDK 静止后隔离 HTTP factory 服务 SIGKILL/新 PID 原生续接通过；mid-flight、实际 index 全供应商故障与自动压缩未验 |

## 4 平台与集成差异登记

下表是计划采用的适配和需要验证的影响，并非完成声明。平台差异不能成为放松 K01–K16 的理由。

| 项 | 参考事实 / 本地事实 | 本地目标、可观察影响与边界 | 分类 | 任务包 / 原验收 | 实现 / 验证 |
| --- | --- | --- | --- | --- | --- |
| P01 存储 | [C01]及[生产接线][X12]；本地[SQLite schema](../../apps/server/src/db/schema.sql) | 延用SQLite/WAL和事务；等价持久领取、CAS、outbox及恢复。首批单服务宿主，不宣称复制上游部署/多机能力 | 适配 | T02、T05、T06、T10、T12 / DB01–DB03、REC01–REC06、A01、A07 | RC03仅追加v35共享hold ledger，历史v25–v34源码/descriptor不变；[RC03][RC03]迁移19组含实际a871910 v34→v35、旧timer原时间及活跃旧command保守升级占窗保留、故障回滚/旧worker拒绝；T12历史v34/17组保留，日常库未迁移 |
| P02 Run 适配 | [C01]；本地[Run](../../packages/shared/src/run.ts)、[终态](../../apps/server/src/runtime/terminal.ts)、[runner](../../apps/server/src/execution/runner.ts) | Invocation映射短期Run以复用执行和用量；三个生命周期仍独立，不能伪造旧完成证明。runner抛错不证明子进程静止，不能原样继承finally释放；执行unknown保留Attempt的Session/工作区/容量fence，QuiescenceProof及副作用对账后才释放或换代；仅费用unknown按费用预留处理 | 适配 | T02、T03、T04、T06 / ISO02、ISO05、REC03、Q06、OS01、UI01 | T03/T06/T07 Run/Invocation 及可信后端证据已实现；[T07][T07] 真实响应子项与取消 unknown 围栏通过；T10 Action 独立领域已接 |
| P03 身份/权限 | [C11]；本地[ExecutionBinding](../../packages/shared/src/execution.ts)、[执行授权](../../apps/server/src/execution/authority.ts)、[账号管理会话](../../apps/server/src/accounts/access.ts) | 现有managementOwner是短期管理会话cookie的hash，不是稳定业务owner，cookie仅Path=/api/accounts。T01采用DB稳定instance_owner_id；经管理认证/CSRF的access-session桥签发Path=/api/threaded专用cookie/session，不扩大旧cookie路径。过期只停止新用户请求，执行失权另由authorityEpoch控制；跨Thread及账号撤销真实校验，单用户实例边界不等于多租户支持 | 适配 | T02、T03、T05、T07 / ISO03–ISO04、CTX01–CTX02、M02、MEM02 | 既有身份/ACL不变，T11增加home知识/SOP/历史源撤权与actor指纹游标验证；[T11][T11]，不扩为多租户 |
| P04 混合资源 | [Queue 同槽所有者][X01]、[Session 锁][X02]；本地[成员FIFO](../../apps/server/src/execution/memberAdmission.ts)、[协作配置](../../apps/server/src/config.ts) | 新旧模式共同竞争；旧独占与thread-slot互斥并防饥饿；保留旧mode局部并发上限，新增全模式共同容量，初始全局/Thread/账号容量各为3，Owner可显式配置并冻结，实际账号/供应商限制更低时取更小值。Run与Attempt不重复计量同一次调用；跨模式争用可能增加排队，不承诺旧吞吐量不变 | 适配 | T04、T07 / Q01–Q06、B01–B02 | T04 共享容量与 T07 后端接线已实现；[T07][T07] 请求单计/围栏子项通过，真实新旧并发矩阵未验 |
| P05 后端 | [C19]表明特定carrier有准入条件；本地[驱动](../../apps/server/src/execution/drivers.ts)、[Session](../../apps/server/src/execution/sessions.ts) | 首批模型API+claude-sdk 0.3.288（当前依赖/driver基线）；API重建输入不宣称native resume，SDK须真实验证连续会话、冷开、取消和恢复；真实供应商、模型及测试时版本在授权验收报告中登记。其他driver不自动继承支持 | 适配+范围 | T07、T12 / CTX03–CTX06、REC03、OS01 | T07 已实现；[真实证据][T07]限 glm-5.3 Anthropic-compatible API 与 SDK 0.3.288，同账号；OpenAI 仅 fixture，其他 driver 未开放 |
| P06 操作系统 | [C19]；本地[宿主身份](../../apps/server/src/execution/host.ts)、[进程树限制](../../apps/server/src/execution/process.ts) | macOS首验；Linux后验证，未验前不宣传支持；WSL单独登记，Windows原生需要独立进程归属/终止/恢复工程。不能删除身份检查或伪造退出 | 适配+范围 | T07、T12 / OS01、REC02–REC03、OPS01 | [T12][T12] macOS 注册命令 8 组取消/断 IPC/owner SIGKILL/无关 PID 拒杀、实际 index 关闭恢复及真实 SDK 静止后隔离服务续接通过；mid-flight/全部供应商故障未全过，Linux/WSL/Windows 未验 |
| P07 界面/HTTP/MCP | [C08]、[C24]；本地[web store](../../apps/web/src/store.tsx)、[旧HTTP路由](../../apps/server/src/api/routes.ts)、[旧WebSocket](../../apps/server/src/api/ws.ts) | 旧/ws没有threaded鉴权并广播全bus事件，新模式Run/Trace/events不得经旧HTTP/WS旁路泄露；旧/api/runs等按ID拒绝threaded对象且列表排除。专用/api/threaded的HTTP/WS共用同一ACL；新工具版本独立，鉴权快照后补授权事件，六类进度分开，不追求上游像素复刻 | 适配 | T02、T03、T08、T09、T12 / ISO01、ISO03、CTX02、R01–R02、W02、W06、UI01 | T09 独立 HTTP/WS/UI 与六类进度已验；[T12][T12] 固定成员创建和独立入场/派发运维 UI 5 组实际 Chrome 通过；临时 token 流未发布，日常新入场关闭 |
| P08 工程工作区 | [Session锁][X02]、[RC01][RC01]普通Thread projectPath/Collective attempt策略；本地[隔离工作区](../../apps/server/src/workspaces/isolated.ts) | 写资源独立claim、串行写或隔离worktree且明确合并责任。参考普通Thread用projectPath；本地生产per-owner/thread/agent只读目录是显式差异；选定工程映射/cwd/读写声明交RC03，实际写竞争交RC06 | 适配+已核验差异 | T04、T07、T11 / Q03–Q04、A04、OS01 | [RC03][RC03]已接显式工程根/成员workspace/cwd与完整多read/write声明，拒绝成员/输出目录重叠及路径漂移；选定profile独立产物由宿主核验，资源38组回归通过。通用shell/build与实际工程并发写作未据此验收，后者仍RC06 |
| P09 Evidence/知识 | [C17]；本地[Evidence resolver](../../apps/server/src/runtime/evidence.ts) | 新模式跨Run引用用不可变快照与授权关系；保留旧resolver同Run边界，检索材料不自动变为完成证据；完整语义记忆另列S08 | 适配+范围 | T07、T10、T11 / CTX02、A02、MEM01–MEM02 | [T11][T11] 不可变知识版本/递归来源和typed域事实分离；任意摘要不完成Action；语义检索仍未实现 |
| P10 部署与回滚 | [C18]；本地[启动恢复](../../apps/server/src/index.ts)与[账号控制](../../apps/server/src/accounts/actions.ts) | 新入场/排空/紧急停止独立；前向迁移，保留新表与兼容worker；旧运行房间不原地切换，不默认复用旧Session或私密transcript | 适配 | T02、T03、T12 / DB03、ISO04、OPS01 | [T12][T12] 固定pack、双门禁、threaded-only排空及兼容恢复合同通过；日常激活未执行 |
| P11 根预算与默认策略 | [C10]及Issue K15；[RC01][RC01]核验A2A/上下文容量/provider goal/命令并发各自职责，未证明参考采用本地整套根预算。本地[T01预算决策](./threaded-collaboration-t01-decisions.md) | 新根默认最大输出300000 tokens、单次最大输出24576 tokens、20次Invocation、每Invocation最多2个Attempt（含初次）、累计活动执行30分钟、已知计价下估算费用上限5 USD；24576来自模型默认，非旧scoped单次12288政策。Invocation/Attempt/实际provider request分别计数，每次请求均占额；unknown不盲重试，接力/修订/替换不重置根预算。30分钟非旧Run墙钟超时或绝对deadline；同Attempt活动重叠取并集，不同并行Attempt分别累计后求和；持久等待不扣活动时长且不重置已用时长，显式deadlineAt另按墙钟且hold不延长。新A2A深度按参考15，旧配置12保留原义；限额暂停待决而不关闭Thread，不承诺供应商硬账单封顶 | 本地可靠性增强+适配；A2A阈值保真 | T04、T06、T08 / B01–B02、R04、W01、W03 | T06 根预算及 T07 每个实际请求预留/usage 已实现；[T07][T07] fixture 与所列真实请求子项通过，未知费用仍占额，T08循环及T10 Action同根已接 |
| P12 Action与领域来源 | [C13]、[C14]、[C16]及[T10合同](../architecture/threaded-actions-v1.md) | SQLite canonical subject/family/注册slot与不可变代际替代Redis lease；仅注册平台task_done及GitHub当前HEAD/local published review_delivered。任务单assignee，PR只读加本地交付，GitHub发布不默认授权；上游callback命名适配为普通持久A2A与专用工具，不减少standing/freshness/CAS要求 | 适配 | T10、T11 / A01–A07 | [T11][T11]完整来源/作者A2A/修订/门禁及[RC02][RC02]单principal生产注册保留；[RC04][RC04]新增服务器决定的GitHub私密跟踪audience、原ACL交集及冻结权限/身份复验；38组专验分层通过，真实观察已结束、not_observed，H1/H2双自然HEAD链未通过，不产生远端review/comment，日常未配置 |
| P13 评审政策 | [C15]及[T11合同](../architecture/threaded-workflows-v1.md) | canonical接收消息ID+不可变seq与真实PR HEAD代替artifact revision；本地独立GitHub reviewer门禁不等同ArtifactReview human_required，也不授外部合并或Owner批准 | 适配 | T11 / A04–A06 | [T11][T11] 历史门禁快照只读显示，currentApproval=false；真实域只读交付与阻断验证 |
| P14 命令执行器 | [X10]、[X11]及[T10合同](../architecture/threaded-actions-v1.md) | 仅服务器注册的ActionCommandPort可执行；先持久unknown，恢复只observe，wait/cancel绑定generation与原来源ACL。默认无任意shell/OS执行器；具体端口负责资源及外部副作用对账 | 适配+范围 | T10、T12 / W04、REC03、OS01 | [RC03][RC03]严格可选生产注册已接：仅`project_manifest_v1`、固定program/argv/env/cwd、独立多读写claim与宿主verifier；无注册明确不可用，权限/代际/待发回调均复验，恢复observe不重放。实际production及原生进程范围见报告；通用shell/build未开放，日常未注册 |

P04/P11的数值是本地冻结策略，不宣称与Clowder的全部预算默认值相同。策略在新工作根建立时冻结，Owner后续追加预算/调整期限留下版本化决策；环境变化不能改写已有根。新增全模式容量与累计活动时长是独立计量合同，不能把现有maxConcurrency或runTimeoutMs改个名称便宣告实现。

P04/P05按[T01设计决策](./threaded-collaboration-t01-decisions.md)先在短期元数据锁/CAS下准备Session身份：Claude SDK冷开预分配并持久保存UUID，API仅准备重建绑定；准备阶段不启动模型、不占执行容量。携绑定版本进入领取事务，重验nativeId、版本和权限后一次取得全部执行claim；竞争失败释放元数据锁再排队。意外nativeId或运行中换绑先停止后续resume/工具派发并对账，不在旧claim上静默替换；仅启动后提供ID的扩展载体首批关闭。

T04 实际适配另见[资源合同](../architecture/threaded-resources-v1.md)：新 Threaded 完整集合一次领取；旧模式为保留整个 turn 的 Agent exclusive，使用不占模型容量的父准备 claim 与子资源，root/shared workspace 合组，实际调用只计一次容量。旧 Codex 启动后返回 ID 的提升仅限确切旧 execution，碰撞中断；不据此开放 Threaded 扩展后端。生产仍为单宿主单活动服务进程，主动通知在共享单例内，多进程测试只证明持久竞态安全，跨 worker 通知尚未实现。更低供应商/账号容量需受信配置，不宣称自动发现实际配额。

## 5 可靠性增强的独立用例

E01–E06 是新增用例编号，不属于原 59 项。普通消息/wake/outbox 的可靠性仍是 K03/K14 核心要求；这里的“增强”特指参考 MultiMention 的内存聚合与尚未证明可靠超时汇总唤醒的路径，不泛称上游没有持久队列或 outbox。来源：[C06]、[聚合回调][X15]。已静态抽查的 timeout/flush 分支不足以证明上游自动可靠唤醒 callbackTo，进一步上游核验不得省略本地故障验收。

| 增强用例 | 独立触发与必需证据 | 关联原 ID | 任务包 | 实现 / 验证 |
| --- | --- | --- | --- | --- |
| E01 征询持久恢复 | 已提交group/targets/deadline且仅部分回应后终止服务；恢复同一group与原deadline，保留首个有效响应，不重发已经接受的目标工作。保存重启前后DB快照、逻辑调用计数及settlement记录 | MM01、MM04、REC01、REC05 | T08 | 已实现/受控真实子进程SIGKILL、新worker恢复原group/deadline/首答，零模型重放；[T08][T08] |
| E02 deadline持久结算 | 征询无人或部分回应，服务停机跨过deadline；可控时钟恢复只结算一次timeout/partial，保留逐目标原回答/状态；零额外“统一意见”模型调用 | MM01–MM02、MM04、REC05 | T08 | 已实现/可控时钟跨deadline唯一partial，保留逐目标原答，零合成请求；[T08][T08] |
| E03 最后回复与超时竞争 | 并发屏障同时推进最后回复和deadline；只有一个CAS结算者和同一结果版本；重复、非目标、迟到回复不改变终态或重复回调 | MM02、REC05 | T08 | 已实现/两SQLite IPC writer屏障末答与timeout竞争一个结算，迟到不复活；[T08][T08] |
| E04 汇总outbox崩溃窗口 | settlement已提交但outbox发送前崩溃，或发送后ACK前崩溃；恢复同一可引用汇总、同一逻辑回调wake；凭outbox状态、唯一键及目标Invocation计数证明不丢/不重结算 | MM04、REC01、REC04–REC05 | T05、T06、T08 | 已实现/结算后通知前exit32、发送后ACK前重试，唯一settlement/callback/queue；[T08][T08] |
| E05 callbackTo授权变化 | group进行中caller被暂停、撤权或目标Thread关闭；结算事实保留，回调明确等待/拒绝/取消，不能扩大授权；恢复授权是否可继续按冻结版本合同判断 | MM04、ISO04、CTX02、W02 | T08、T12 | 已实现；[T08][T08] 暂停等待恢复、stop 后 resume 不复活；[T12][T12] 实际组合服务重启/权限变化拒绝并保留事实，供应商传输注入；完整真实发布组合仍未验 |
| E06 增强事务失败 | group/response/settlement/outbox事务每个提交点注入失败，数据库不可写时不返回已持久成功；重试沿原幂等身份恢复，原始响应及终态不分叉。保留独立写入/派发计数 | DB01–DB02、MM02、REC06 | T05、T06、T08 | 已实现/创建9类及终态回调11类写点故障、只读库及原证明重试通过；[T08][T08] |

E项通过不能替代征询目标数、超时范围、anti-cascade等保真规则；原MM项通过也不能自动覆盖全部E项。每项报告记录seed/时钟、并发屏障、调用次数、数据库快照、实际命令、提交和结果。

## 6 发布范围与高级能力

“纳入”是发布目标，“后续”是本批不纳入的范围决定；已交付子项的验证层级见末列，未列证据的组合仍未验证。普通 home Thread 的私密消息/ACL属于首版核心，不能因Collective特殊隔离后续而省略。阶段4只完成消息协作，不作为首版完整验收终点；首版目标还包括阶段5领域责任以及阶段6/7系统和发布验收。

| 项 | 能力与本批范围 | 条件/限制与后续工作 | 原验收 / 任务包 | 实现 / 验证 |
| --- | --- | --- | --- | --- |
| S01 普通home Thread全核心 | 纳入：K01–K16、用户/系统/Agent消息、公开和私密投递、持久唤醒、跨Thread获权接力 | 全部普通入口与ACL边界，不以固定流水线替代；实际策略逐项关联F表 | ISO、DB、Q、REC、CTX、R、M、W、A、MEM、SOP、B、UI组 / T02–T12 | T02–T12 消息/执行/工具/UI、Action、基础知识及发布控制已实现并按[T11][T11]、[T12][T12]分层验证；完整真实故障/并发组合、生产激活与 MEM01 语义子项仍未收口 |
| S02 成员会话 | 纳入：API上下文重建和claude-sdk原生连续会话 | API与SDK分别验证；SDK cold/resume、权限变更、压缩/恢复锚点及真实Session锁；不以全冷会话代替原生连续性目标 | CTX03–CTX06、Q04、OS01 / T07、T12 | T07 已实现；[T07][T07] 真实 API 重建、SDK 同 ID/权限冷开和 runtime/SQLite 重开通过；[T12][T12] 静止后隔离 HTTP factory 全进程重启/原生续接通过；不是 index/mid-flight 证明，自动压缩未验 |
| S03 征询与可靠性 | 纳入：完整multi_mention行为及E项持久增强 | 上游参考限制与本地增强分栏；不能用首个赢家取消其余人的旧consult-any替代 | MM01–MM04、E01–E06 / T08 | T08已实现/参考行为与E01–E06隔离验证分别通过；真实征询首轮失败保留、新场景复验通过；[T08][T08] |
| S04 等待/人类回应 | 纳入：hold、命令终态、正式tracking与ordinary ConversationDecision | 真实tracking生产者、命令权限及用户决定绑定须接通；Decision不是业务批准；不给scoped/read-only扩权 | W01–W06 / T08、T10、T12 | T08 Decision、RC02可选GitHub及[RC03][RC03]选定命令/hold合同保留；[RC04][RC04]显式跟踪分享桥接及所列隔离/进程验证已过，真实观察已结束、not_observed，两次自然HEAD唤醒仍未通过。Decision不授业务批准，在线one-shot非统一硬SLA；真实供应商故障仍RC05，日常未配置 |
| S05 Action与Review/Revision | 纳入：review_delivered/task_done、责任准入/返回/替换、指定版本评审和修订闭环 | T01冻结task_done来自平台任务合法状态转换，review_delivered绑定GitHub PR当前HEAD和合法评审交付；Thread内可交付报告，发布GitHub评论/review另需授权。producer/resolver/freshness及真实领域系统必须接通，业务验收前不宣传可用；详见[设计决策](./threaded-collaboration-t01-decisions.md) | A01–A07 / T10、T11、T12 | T10/T11首版及[T12][T12]分层证据保留；[RC04][RC04]同一Action/root双HEAD注入链、独立复审和4组实际worker进程恢复通过，真实观察已结束、not_observed，H0→H1→H2两次自然HEAD完整闭环未通过；全部生产/供应商故障组合仍未验 |
| S06 角色/SOP | 纳入：稳定成员handle、版本角色/政策、SOP CAS及attested/verified/unknown | 角色提示不等于服务端权限；SOP不自动转让执行槽或完成Action | SOP01–SOP02 / T11 | 首版已实现并验证；[T11][T11] 精确任务verifier，其他检查unknown/attested，不授执行权 |
| S07 基础知识 | 纳入：精确anchor、近期事件查询、摘要到消息/Invocation来源展开、版本/过期状态、ACL | 普通知识溯源和授权不可后移；查询入口、展开读取和衍生摘要都执行权限。语义检索子项与完整系统范围见S08 | MEM01基础子项、MEM02、CTX02 / T07、T11 | T11基础范围已实现并验证；[T11][T11] 平台消息/Invocation来源展开，不含私有native transcript；语义未实现 |
| S08 完整语义记忆 | 后续：完整语义索引、召回/排序及跨会话记忆体验 | [RC01][RC01]确认固定参考有生产索引/独立NN/hybrid RRF，默认或降级可为lexical；本地substring不等价。EXT01冻结本地实模质量合同，不挪用参考词法Recall@5≥80%或semantic scaffold为质量证明；MEM01语义子项与整项未完成保留 | MEM01语义子项未验证；EXT01后续实施并接RC07/RC10组合验收 | 源合同已核验；本地语义待实现 / 未验证 |
| S09 Collective | 后续：Collective特有私有/公共执行隔离 | [C05]专项上下文/权限/Session路径另建覆盖；不影响S01普通home Thread私密消息必须交付 | CTX01–CTX06、MEM02另加Collective专项；后续专项（未定义任务包） | 待实现（后续） / 未验证 |
| S10 macOS/Linux | macOS纳入首验；Linux后验证 | macOS通过只覆盖已测driver/版本；Linux未验前不宣称已支持。同一OS上也分别记录API/SDK及工具组合 | OS01、REC、OPS01 / T07、T12 | [T12][T12] macOS 注册命令 8 组、实际 index 关闭恢复、真实 API/SDK 五工具及静止后隔离 HTTP 服务原生续接通过；mid-flight/全部故障未全过，Linux 未验证 |
| S11 其他driver/平台 | 后续：codex-app-server、codex-exec、claude-cli及其他后端，WSL与Windows原生 | 逐一验证start/resume/cancel/工具/费用/恢复；carrier准入不能由“支持Codex”概括。Windows原生需独立进程归属和恢复实现 | OS01、CTX06、REC03及专项；后续专项（未定义任务包） | 待实现（后续） / 未验证 |
| S12 多机/多租户 | 后续：分布式worker和多租户身份模型 | SQLite首批单宿主与本地可信owner边界明确，不把多成员与多租户等同；后续单独冻结授权/资源协议 | ISO03、DB03、Q、MEM02另加专项；后续专项（未定义任务包） | 待实现（后续） / 未验证 |

## 7 原59项逐行验收映射

下表“场景”“必须观察到”完整保留 Issue §16 原文，新增任务/合同/状态列。涉及多能力的ID保留整项，不能因本批只实现部分而标通过；尤其MEM01包含语义检索，见S08。OS01按实际支持且声明的组合分别记录；未验证组合不能用其他平台结果代替。

59项是选定合同与风险场景，不是Clowder功能总量或复刻百分比。T01设计审查、文档链接检查、旧模式回归均不计为其中任何项通过。T02–T12 当前分层结果如下，未覆盖的能力继续待实施、待验证；“真实后端子项通过”不覆盖同一 ID 中未运行的故障、工具或业务组合。

T01对ISO03、CTX02、UI01补充本地旁路探针，不改写原要求：伪造/过期专用session及owner不能访问Thread；现有账号cookie不能充当新模式持久owner；旧HTTP精确ID和列表、旧/ws及Trace事件均不能读取或广播新模式数据。新/api/threaded的HTTP快照与WS订阅/重连补发使用同一ACL，撤权后不继续补发私密内容，session续期不能更换稳定instance_owner_id。这些探针属于对应原ID的本地适配覆盖，不计作新增上游保证。

Q03/Q05与B01/B02同时验证P04/P11：旧局部上限与新增全局/Thread/账号容量共同生效，同一调用只占一个实际容量claim；20次Invocation、每Invocation最多2个Attempt和实际请求消耗分别断言。可控时钟验证同Attempt模型/嵌套工具重叠取并集、并行Attempt分别累计后求和、hold/Decision持久等待不扣活动时长、恢复不重置额度、独立deadlineAt到期及5 USD估算/未知占额政策，不能只测旧Run墙钟timeout。

T03/T04在REC03/Q06/OS01增加“runner抛错但子进程存活”的fixture：unknown保留原Attempt围栏，人工继续/重试/resume也不得抢占；QuiescenceProof和副作用对账前不释放，旧finally晚到不能释放后继claim。Q04增加Session准备CAS竞争、准备后绑定版本变化及意外nativeId，证明领取使用当前真实身份且无部分资源占用。W01/W06增加hold/Decision注册后继续当前调用、事件早到持久排队、正常响应结束后才启动同槽后继的用例；等待注册本身不伪造调用终态。

| 原 ID | 场景（原文） | 必须观察到（原文） | 任务包 | 核心合同/关联项 | 实现 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| ISO01 | 新模式关闭；提交旧协作、自主和其他模式任务 | 原有入口、权限、完成及恢复契约维持 | T02、T03、T06、T12 | K01、K05、K07、K14、K16 | T02 骨架已实现 | [T12][T12] 隔离/旧边界/共享资源/旧资源回归通过；实际index closed/observe启动及重启通过，完整真实旧新模型并发未验 |
| ISO02 | 新 Invocation 出现在混合历史数据库 | 旧 dispatcher、finalizer 和恢复器不接管 | T02、T03、T06、T12 | K01、K05、K07、K14、K16 | T02–T07 隔离、专用适配与恢复已实现 | [T12][T12] 24个实际组合服务子进程与混合模式root/unknown隔离、actual index关闭恢复通过；完整供应商混跑未验 |
| ISO03 | 客户端伪造 mode、actor、Attempt 或 generation | 服务端拒绝，未发生外部执行 | T02、T03、T06、T12 | K01、K05、K07、K14、K16 | T03 Binding与T08可信工具/HTTP入口已实现 | [T08][T08] 伪造主体/未知字段/CSRF/权限/晚到工具拒绝；关闭生产零执行 |
| ISO04 | 审批期间重启后批准、通用暂停/停止、账号撤销 | 新模式正确恢复或失权；Run 与 Invocation 一致，不能绕旧入口留下可继续的 wake | T02、T03、T06、T12 | K01、K05、K07、K14、K16 | 专用控制/恢复与T12发布门禁已实现 | [T12][T12] 实际组合服务重启后旧审批失效、stop/member/account保持失权、observe控制零写入；模型传输注入 |
| ISO05 | 新 Invocation 成功或失败，与终态事务故障竞争 | Run、Invocation、响应与 outbox 原子一致；无需伪造旧完成输入 | T02、T03、T06、T12 | K01、K05、K07、K14、K16 | T06 响应终态整合及 T07 后端已实现 | T06 原子故障用例与 [T07][T07] 真实 API/SDK 响应终态子项通过；真实故障全窗口待验 |
| DB01 | 同一请求并发提交两次 | 一个消息和一组逻辑工作，回执一致 | T02、T05、T06 | K02–K04、K14、K16 | T05/T06 持久闭环及 T07 投递账本已实现 | 多进程唯一接收/领取 fixture 通过；[T07][T07] 多 HTTP 回执不重复曝光，不据此宣称真实并发请求全验 |
| DB02 | 相同幂等键改内容、目标或 ACL | 明确冲突，无第二份意图 | T02、T05、T06 | K02–K04、K14、K16 | T08路由/工具/消息幂等冲突已接 | [T08][T08] 同键异内容/目标/ACL及工具请求冲突零第二意图通过 |
| DB03 | 旧数据库升级、重复启动、未知新 schema | 迁移幂等；不兼容程序明确拒绝写入 | T02、T05、T06 | K02–K04、K14、K16 | v25–v35前向迁移已实现，历史v25–v34不变 | [RC03][RC03]19组含真实a871910 v34→v35、旧timer原时间及活跃旧command保守升级占窗保留、DDL/登记回滚、旧worker零修改拒绝；[T12][T12]历史17组保留，日常库未迁移 |
| Q01 | 同 Thread 同 Agent 两个 wake 同时领取 | 一个有效执行所有者，其余按策略等待 | T04、T06、T07 | K05–K07 | T04/T06 同槽领取与 T07 执行接线已实现 | 多进程 Wake 同槽唯一领取 fixture 通过；真实后端并发同槽争抢待验 |
| Q02 | 同 Agent 两个 Thread | 可在约束允许时并行，不被旧全局 FIFO 悄悄串行 | T04、T06、T07 | K05–K07 | T04 线程槽与 T07 独立 Session 已实现 | 不同 Thread 同 Agent 并发 fixture 通过；真实模型跨 Thread 并行待验 |
| Q03 | 旧独占与新线程调用竞争 | 互斥矩阵成立，等待的旧独占不饥饿 | T04、T06、T07 | K05–K07 | T04 混合资源及 T06 调度已实现，T07 后端已接 | exclusive 屏障/轮转/混跑 fixture 通过；真实新旧模型并发竞争待验 |
| Q04 | 不同线程误指向相同原生 Session | Session 锁阻止双 resume | T04、T06、T07 | K05–K07 | T04 真实 ID 锁及 T07 兼容边界/锚点已实现 | [T07][T07] 同 ID 原生续接真实通过；共享 ID 锁/CAS/漂移 fixture 通过，实际双 resume 竞争待验 |
| Q05 | drain 运行中再入队、容量刚释放时入队 | 无丢唤醒；正常调度不依赖长周期扫描 | T04、T06、T07 | K05–K07 | T04/T06 主动提示及 T07 后端已接 | repairIntervalMs=0 的空扫描/release/enqueue fixture 通过；实际供应商并发释放窗口待验 |
| Q06 | A/B 并行，只取消 A；旧 A 的 finally 晚到 | B 继续；旧 A 不能释放新 A 的槽 | T04、T06、T07 | K05–K07 | T03/T04 围栏与 T07 后端取消已实现 | [T07][T07] 真实 SDK 取消保留 unknown 且不重放；并行 B 继续/旧 A 晚 finally 为 fixture 范围 |
| REC01 | 消息提交后通知前崩溃 | 重启恢复同一逻辑 wake | T05、T06、T07、T12 | K03–K05、K13–K15 | T05/T06 Wake 修复及 T07 发送意图修复已实现 | [T12][T12] 实际服务组合进程在消息提交后通知前SIGKILL，新SQLite恢复原wake且只执行一次；模型注入 |
| REC02 | 领取后、明确未发请求时崩溃 | 合法重试；没有重复外部调用 | T05、T06、T07、T12 | K03–K05、K13–K15 | T06 未启动恢复及 T07 pre-I/O 事务已实现 | [T12][T12] 实际服务组合prepared退出，重启同Invocation/Run合法新Attempt一次外发；模型注入，真实供应商该窗口未验 |
| REC03 | 请求可能已发、回执未落库 | unknown 保留，不能盲重放和释放未知预算 | T05、T06、T07、T12 | K03–K05、K13–K15 | T06/T07 请求 unknown、资源及预算围栏已实现 | [T12][T12] 实际组合服务可能发送后SIGKILL，重复恢复unknown不重放；真实SDK首轮新增unknown与旧费用占额保留，供应商最终对账未完成 |
| REC04 | 响应和后继已提交后崩溃 | 只修复投影/通知，不重新调用模型 | T05、T06、T07、T12 | K03–K05、K13–K15 | T06 终态修复及 T07 可信投递补账已实现 | [T12][T12] 实际组合服务响应/后继提交后SIGKILL，只修复唯一通知/后继，模型不重放；真实供应商全窗口未验 |
| REC05 | 重复恢复扫描和回调重放 | 不重复写终态、通知、用量或业务完成 | T05、T06、T07、T12 | K03–K05、K13–K15 | T05–T07消息/执行/费用/上下文幂等及RC04同Action双HEAD链恢复已实现 | [T12][T12]既有幂等证据保留；[RC04][RC04]9组注入链/4组实际worker进程恢复保留原Action/root/callback/Review，重复扫描不重放；不外推真实供应商故障 |
| REC06 | 数据库不可写 | 停止承诺新工作成功，内存不冒充持久状态 | T05、T06、T07、T12 | K03–K05、K13–K15 | T05–T07 整体事务及上下文账本故障保护已实现 | [T12][T12] 组合服务query_only存储故障和迁移DDL/注册失败拒绝成功承诺、无部分提交；真实物理磁盘故障未验 |
| CTX01 | 公共、whisper、草稿和私有工具结果混合 | 其他成员只能看到获权已发布内容 | T05、T07 | K02、K07–K09 | 消息/manifest/私密工具结果/衍生受众已实现 | [T08][T08] 工具私有来源缩窄post/final及native anchor通过；真实API私密排除保留T07证据 |
| CTX02 | 精确 messageId、附件和搜索展开读取私密内容 | 所有入口都执行同一授权边界 | T05、T07 | K02、K07–K09 | 查询/工具及T09 UI/事件引用统一来源授权已接 | [T09][T09]只读投影/回放每次重验来源，失去连接或会话清空私密UI；T08既有工具证据保留 |
| CTX03 | 输入超预算、过滤造成序号空洞、游标写失败 | 不漏投；未见内容不记成已暴露 | T05、T07 | K02、K07–K09 | T07 整项预算延期、精确补投及事务游标已实现 | [T07][T07] 序号空洞、源超预算阻塞、cursor 写失败全回滚和可信回执修复 fixture 通过；真实超限故障组合待验 |
| CTX04 | delivery、seen、mention ACK 分别变化 | 三者互不冒充，也不自动完成 Action | T05、T07 | K02、K07–K09 | 三账本及模型seen/ACK工具已接 | [T08][T08] 独立记录、冻结边界与ACL通过；不完成Action |
| CTX05 | 同波并行 A 先回答，B 后开始消费输入 | 独立思考输入边界固定，不吸收 A 本波答案 | T05、T07 | K02、K07–K09 | T07 实际 manifest 截止及 native 历史越界冷开已实现 | [T07][T07] 同波早答排除、预算阻塞旧 Wake 恢复时 cutoff 回退冷开 fixture 通过；真实并行独立思考待验 |
| CTX06 | 原生压缩、seal、权限收缩后继续 | 兼容恢复或明确冷开，摘要来源与 ACL 可查 | T05、T07 | K02、K07–K09 | T07 Session 指纹/原生锚点/seal/压缩来源边界已实现 | [T07][T07] SDK 冷开/同 ID 续接/权限冷开与 runtime+SQLite 重开通过；[T12][T12] 静止后隔离 HTTP factory 整进程原生续接通过；seal/压缩为 fixture，自动压缩、index/mid-flight 全链未验 |
| R01 | 用户点名、正文提及、代码围栏、前缀重叠 handle | 路由与 preview 一致，未误启动其他成员 | T08 | K03、K10、K15；F01–F02 | T08已实现 | [T08][T08] 用户/Agent分解析、代码/引用/URL、长handle、preview/实际接收一致通过 |
| R02 | 多目标、ideate、execute、critique及不同入口 | 符合对应入口政策，而非简单全局串并行开关 | T08、T10 | K03、K10、K15；F01–F02 | T08 普通协作与 T10 专用 Action 入口政策已实现；multi_mention 拒绝 Action metadata，见 F05 | [T08][T08] 默认多目标ideate、显式execute串行、critique提示、后取显式tag、群组/fallback及工具入口政策通过 |
| R03 | 流式半截 @、完整行首 @、parallel 文本 @ | 只在合格提交边界触发允许的后继 | T08 | K03、K10、K15；F01–F02 | 完整post/final边界及并行文本抑制已实现 | [T08][T08] 串/并行及post/final独立触发通过；流式不写正式接力 |
| R04 | A/B 短回复循环、实质工具、新用户输入 | 警告、阻断和重置符合冻结策略 | T08 | K03、K10、K15；F01–F02 | 持久成员对循环/实质工具重置已实现 | [T08][T08] 第2/3警告实际入system、第4阻断，搜索/新用户重置，hold/恢复保留通过 |
| M01 | 显式 post 后 final 再明确提及同一成员 | 两个独立可引用消息，各自有合法逻辑 wake；同一 source 的重试才去重，不跨消息按语义吞掉接力 | T05、T08 | K02–K04、K09–K10；F03 | T08协作工具及完整final文本路由已接 | [T08][T08] 两种API协议与实际SDK MCP/RPC各形成独立post/final后继（注入模型）；真实read/post成功 |
| M02 | cross_post 无目标、越权目标、私密来源 | 拒绝非法路径；不复制私有 transcript | T05、T08 | K02–K04、K09–K10；F03 | T08 cross_post可信工具及来源边界已接 | [T08][T08] 空/越权/私密拒绝、合法跨Thread同根与引用展开通过；不复制native transcript |
| M03 | 请求超时后重发结构化消息 | 稳定回执，逻辑交接幂等 | T05、T08 | K02–K04、K09–K10；F03 | T08工具不可变receipt已接 | [T08][T08] 精确重试/冲突/提交故障通过，实际SDK工具链路通过；真实网络丢回执故障未验 |
| MM01 | 三成员征询，一人超时 | 逐成员状态正确，唯一 partial 汇总 | T08 | K03–K04、K10、K14；F04–F05、E01–E06 | T08持久逐目标状态/结算已实现 | [T08][T08] 三目标一首答+超时唯一partial通过；真实双目标成功复验通过 |
| MM02 | 重复回复、非目标回复、迟到回复、最后回复与超时竞争 | 仅一个结算者，终态不复活 | T08 | K03–K04、K10、K14；F04–F05、E01–E06 | T08首答/终态不可变已实现 | [T08][T08] 真实双SQLite writer屏障竞争、迟到/重扫不复活通过；模型响应为注入 |
| MM03 | 被询问成员继续发同类征询 | anti-cascade 生效，未制造下游级联 | T08 | K03–K04、K10、K14；F04–F05、E01–E06 | T08 anti-cascade及来源链检查已实现 | [T08][T08] 被询问者再征询拒绝通过；不用赢家取消其他成员 |
| MM04 | 征询中服务重启 | 按本项目持久化增强合同恢复，不丢 group 状态 | T08 | K03–K04、K10、K14；F04–F05、E01–E06 | T08持久恢复/唯一回调已实现 | [T12][T12] 实际组合服务SIGKILL后原partial/deadline唯一结算/回调、权限变化拒绝，通过；供应商传输注入，T08取消风险保留 |
| W01 | 等待外部条件或人类回应后重启 | 不占执行槽，按持久条件恢复，无重复提醒 | T08、T10、T12 | K04–K05、K07、K10、K14–K15；F06–F08 | timer/tracking/Decision及RC03生产命令/hold、RC04跟踪分享恢复已实现 | [T12][T12]历史及[RC03][RC03]所列等待证据保留；[RC04][RC04]4组实际worker恢复/7组分享ACL通过，真实观察已结束、not_observed，H1/H2双自然HEAD链未通过，完整供应商故障仍RC05；日常未注册 |
| W02 | 用户答复旧问题、错误版本或无权对象 | 不解除当前合法等待，不产生扩大授权 | T08、T10 | K04–K05、K07、K10、K14–K15；F06–F08 | T08问题修订/回应来源/操作身份已实现 | [T08][T08] 旧/错误版本/错origin trigger拒绝、认证user回应同根及settle后丢回执重试通过 |
| W03 | 同槽第四次 hold、同 job 重试、替换旧 hold | 滑动额度正确；重试不二次扣额；退休 wake 不被误当命令已停止 | T08、T10、T12 | K04–K05、K07、K10、K14–K15；F06–F08 | RC03 timer/command wake共享滑动额度、稳定job幂等及原子替换已实现 | [RC03][RC03]共享3次/小时、重复commandId不重复扣额与原子故障4组通过；等待退休不证明命令停止，独立进程/资源核验另记 |
| W04 | 持有旧 Action generation 的命令等待完成 | 不能唤醒新 holder 或提交旧责任结果 | T08、T10 | K04–K05、K07、K10、K14–K15；F06–F08 | 注册命令及独立资源/Action代际/当前授权回调围栏已实现 | [T12][T12]历史guardian/native/grandchild及旧代际证据保留；[RC03][RC03]生产注册、当前代际/权限及待发回调撤权验证另记，日常未注册 |
| W05 | 注册 PR 跟踪时已有旧事件，之后出现匹配新事件 | 旧事件仅作 baseline；新事件形成幂等 wake | T08、T10 | K04–K05、K07、K10、K14–K15；F06–F08 | 真实GitHub live baseline已接；RC04生产分享桥接及唯一wake恢复已实现，真实观察已结束、not_observed，新HEAD尚未出现 | [T12][T12]48GET/606秒not_observed及[RC02][RC02]provider稳定读取保留；[RC04][RC04]注入双HEAD/唯一wake/进程恢复通过；真实609秒/71GET为not_observed，baseline不误触发、3目标实际SIGKILL恢复且ID/计数不变已验证，H1/H2新事件及完整链未通过 |
| W06 | 调用退役 request_user_input 或普通 ConversationDecision | 退役行为明确；非阻塞决定不会被误当业务审批 | T08、T10 | K04–K05、K07、K10、K14–K15；F06–F08 | T08退役410/非阻塞ordinary Decision已实现 | [T08][T08] 注册后继续、真实origin trigger版本结算及无业务批准通过；原生审批另行保留 |
| A01 | 同业务身份两个 single successor 并发申请 | 仅一个获权；另一个明确等待或复用 | T10、T11 | K04–K05、K10–K14；F09–F10 | canonical subject/family/注册slot及standing已实现 | [T10][T10] 真实双进程一个获权，另一个明确safe_wait并返回原责任引用；无第二派发 |
| A02 | 文本 done、伪造 Evidence、未注册完成谓词 | 不能完成 Action | T10、T11 | K04–K05、K10–K14；F09–F10 | typed candidate与真实领域resolver已实现 | [T10][T10] 文本/伪造证据/未知完成谓词拒绝，task_done只读合法领域转换 |
| A03 | completion 与 replace 竞争、旧 holder 回调晚到 | 只有合法代际提交，历史留存 | T10、T11 | K04–K05、K10–K14；F09–F10 | CAS替换/返回、合法凭证及旧代际隔离已实现 | [T10][T10] 真实双进程completion/replace唯一胜者；历史不覆盖，旧command/timer不复活 |
| A04 | 新 PR HEAD 到来；旧评审为 approved | 旧结果不能满足新版本验收 | T10、T11 | K04–K05、K10–K14；F09–F10 | 新HEAD使旧报告及旧门禁不能满足当前验收，RC04单Action/root链已接 | [T11][T11]既有真实只读门禁证据保留；[RC04][RC04]同Action H0→H1旧approved→stale及H1→H2修订复核的注入/实际worker恢复通过；真实观察已结束、not_observed，两次自然HEAD完整链未通过，不由稳定GET推断通过 |
| A05 | review_delivered 成立但 verdict 为 changes_requested | 评审责任完成，批准门禁未通过 | T10、T11 | K04–K05、K10–K14；F09–F10 | review_delivered、verdict与批准门禁独立，RC04同Action链再次覆盖 | [T11][T11]实际GitHub当前HEAD/本地合法交付completed但blocked保留；[RC04][RC04]同Action注入链中changes_requested交付与blocked门禁分离通过，无远端review或合并批准 |
| A06 | 修订者自报 findings 全部解决 | 不自行覆盖独立评审结论；新版本另行验证 | T10、T11 | K04–K05、K10–K14；F09–F10 | 逐项修订自述只attested，新HEAD不同本地reviewer独立复审后才核验finding | [T11][T11]既有逐项/引用拒绝保留；[RC04][RC04]同Action H1→H2两finding原ID逐项attested、门禁blocked及独立resolvedFindingIds→verified的注入链通过，真实观察已结束、not_observed，H1/H2双自然HEAD闭环未通过 |
| A07 | return 通知丢失、获批派发未完成、task_done 投影中断 | 领域恢复器幂等补齐 | T10、T11 | K04–K05、K10–K14；F09–F10 | task_done恢复及Review事务/历史采用、RC04同Action/root链恢复已实现 | [T10][T10]task_done、[T11][T11]Review及[RC02][RC02]SQLite重建保留；[RC04][RC04]4组实际worker进程恢复及重复扫描保持唯一callback/Review，PR与模型答复注入，真实观察已结束、not_observed，动态新HEAD链未通过 |
| MEM01 | anchor、近期事件、语义检索与会话展开 | 可回到权威来源；过期与替代状态可见 | T07、T11 | K08–K09、K11；F11、S07–S08 | 基础anchor/近期事件/平台会话展开/版本过期替代已实现；语义未实现 | [T11][T11] 8组知识和实际Chrome来源读取通过；literal_substring明确标注，语义子项未验，整项未完整通过 |
| MEM02 | 模型传入任意私有 collection 或他人游标 | 服务端限制访问，不能自授权 | T07、T11 | K08–K09、K11；F11、S07–S08 | home collection、actor/权限绑定游标及递归来源ACL已实现 | [T11][T11] 任意scope/private collection/他人和旧权限游标拒绝；跨Thread撤权与旧receipt读取拒绝 |
| SOP01 | 两成员同时更新 SOP 版本 | 一个成功，另一个收到版本冲突 | T11 | K05、K10–K12；F11、S06 | expectedVersion CAS及不可变历史已实现 | [T11][T11] 两实际IPC成员同版本竞争唯一胜者，另一方明确409版本冲突 |
| SOP02 | 自报 check、切换 stage 或 baton 文字 | 不自动变为 verified、执行所有权或业务完成 | T11 | K05、K10–K12；F11、S06 | 告示状态和精确task_done核验分离 | [T11][T11] 自述/未知谓词/错任务证据拒绝verified；stage/baton不转让Action或资源；失效事实重投影unknown |
| B01 | 重试、接力、修订、替换跨多个 Invocation | 因果链预算持续计算，没有每次重置 | T04、T06、T12 | K13–K15；P04 | 接力/等待/Action返回替换及Review修订继承原root | [T12][T12] 关闭入场后普通后继/Decision回应、队列排空继承同root；Review修订同根回归通过，预算不重置 |
| B02 | 重复费用回调、未知 token/cost、取消后已知消耗 | 精确幂等结算；未知按政策保留占额 | T04、T06、T12 | K13–K15；P04 | T06 预留结算与 T07 可信实际请求 usage 已实现 | [T12][T12] 三轮9请求新增已知27,019、未知预留50,748；账本累计153,094，旧行逐行保留；未知最终对账未完成 |
| UI01 | 刷新、重连、服务重启 | 持久快照恢复正确，无重复消息和假完成 | T09、T12 | K01–K03、K14；P07 | T09授权同步及T12固定名单创建/运维控件已接 | [T12][T12] 实际Chrome5组含真实隔离服务重启、observe整库hash不变、关闭入场/派发分离；1注入模型，无生产启用 |
| OPS01 | 关闭新入场、排空、回滚 | 已接收工作可处理或明确暂停；新数据保留 | T12 | K13–K16；P10 | 独立入场/派发、冻结根/pack、只读排空、迁移/兼容恢复已实现 | [T12][T12] release7/production16/Chrome5/迁移17通过；threaded_only排空不授整库回退；未做日常小流量激活/日常库回退 |
| OS01 | 实际支持平台上取消、断 IPC、主进程崩溃 | 进程身份与终止有证据；不误杀其他进程 | T07、T12 | K05–K07、K13–K14；P05–P06、S10–S11 | macOS受信端口及RC03首批选定生产profile、独立读写资源/宿主副作用核验已实现 | [T12][T12]历史macOS8组及index/静止SDK续接证据保留；[RC03][RC03]本轮实际原生取消/IPC/owner恢复边界见报告；真实供应商mid-flight、全部故障及其他OS仍未验 |

端到端链另行记录：用户持续工作 → A执行 → 公开交接B → 征询C/D → 一人失败或超时 → 有据恢复 → 指定版本评审 → 修订再评审 → 返回原Thread。至少注入一次服务重启、旧回调、权限变化及预算限制；不能只跑理想成功路径。

## 8 设计收口与后续证据

T01设计交付包含本表，不意味着源码核验或真实配置选择已全部完成。[T01设计决策](./threaded-collaboration-t01-decisions.md)冻结本地身份、Run/Attempt、控制、资源、预算、首批Action领域及后端策略；本文不重新打开这些选择。T08 已核实 F01 fallback 和普通意图/循环分支，T10/T12 已落实注册命令及所列 macOS 故障验收；[RC01][RC01]已核验F06、K07、K15、P08和S08指定分支：结构化hold来源/SLA恢复窗口与共享命令准入、首批工程映射已由[RC03][RC03]交付；真实供应商停机组合及工程并发写作仍RC05/RC06，完整语义交EXT01；本地完整Session policy与根预算增强如实登记。源核验完成不等于缺口或真实组合已验。当前Action/PR resolver与日常配置分开登记：RC02已交付可选生产GitHub注册及撤权围栏，日常未配置；[RC03][RC03]已交付严格`project_manifest_v1`生产端口/独立读写资源/宿主verifier及hold语义，通用shell/build未开放，日常未配置；[RC04][RC04]已补生产GitHub私密跟踪分享桥接及同Action/root双轮链的隔离/实际worker恢复证据，真实只读窗口已结束，609秒/71次官方GET、0新HEAD，not_observed，H1/H2完整真实链未通过；API供应商/SDK实际版本及失败记录见阶段报告。核心行为不能因实现困难自动降为范围外。

每次更新至少记录实现提交、schema版本、平台/后端/工具组合、脚本及配置、覆盖ID/子项、计数器和快照、失败/未验证项、兼容差异、外部unknown与下一步。状态分别使用“待实现 / 已实现”以及“未验证 / fixture通过 / 真实后端通过 / 真实业务通过 / 失败”；一个通过层级不能代替另一个。范围外保持独立标签。

发布必须满足普通home Thread全部既定核心合同、旧模式回归、声明平台的取消/恢复、领域producer-resolver闭环、随版本提供的增强用例及迁移/回滚演练。完整语义记忆或Collective尚未纳入时如实列差异，原对应验收仍保留未完成子项，不声称全部Clowder能力复刻或59项全部通过。

## 9 固定源码引用

C01–C25来自Issue固定提交索引，保留其定位；X项是Issue补充入口或此前局部静态核对定位。链接可追溯不等于已经跑过参考产品。若复制源码，保留[C22]要求的许可声明和来源映射。

[T07]: ../reports/threaded-collaboration-t07-context-backends-2026-10-20.md "T07 分层验收证据与未验证范围"
[C01]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L1 "InvocationQueue 的持久账本语义"
[C02]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L534 "响应完成后的独立 message_wake"
[C03]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/visibility.ts#L175 "公共消息与 whisper 可见性"
[C04]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/context/ContextAssembler.ts#L225 "上下文组装与预算"
[C05]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/collective-private-invocation.ts#L51 "Collective 私有执行隔离"
[C06]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts#L39 "MultiMention 聚合器及内存状态"
[C07]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionTerminalPredicateCatalog.ts#L181 "真实启用的 Action 完成能力"
[C08]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts#L114 "用户路由与 fallback"
[C09]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts#L1 "文本 A2A 解析边界"
[C10]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/WorklistRegistry.ts#L1 "Worklist guard 的职责与循环控制"
[C11]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callbacks.ts#L3032 "消息回调中的结构化 Action 准入"
[C12]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/ports/WorkflowSopStore.ts#L1 "SOP 状态的告示牌定位"
[C13]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionSuccessorAdmissionService.ts#L111 "Action 准入与新版本续接"
[C14]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionSuccessorCompletionService.ts#L20 "完成候选与服务端事实解析"
[C15]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/collaborative-content/artifact-review/reducer.ts#L93 "ArtifactReview 的领域评审状态"
[C16]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/ActionSuccessorReplacementAdmission.ts#L154 "责任替换准入"
[C17]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/memory/interfaces.ts#L92 "知识 Evidence 的来源与版本字段"
[C18]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/index.ts#L8000 "启动恢复中的外部存活处理"
[C19]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/config/codex-managed-support.ts#L8 "特定 managed Codex carrier 准入"
[C20]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-hold-ball-routes.ts#L242 "hold_ball 等待准入和参数"
[C21]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/stores/ports/DeliveryCursorStore.ts#L68 "delivery seen mention ACK 的区分"
[C22]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/LICENSE "上游 MIT 许可"
[C23]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/TypedWaitRegistration.ts#L14 "外部跟踪的 baseline 与匹配合同"
[C24]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-runtime-interaction-routes.ts#L85 "旧问答工具退役与 ConversationDecision"
[C25]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L3151 "post 和 final 使用独立持久消息来源"
[X01]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts#L652
[X02]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/invocation/invoke-single-cat.ts#L2595
[X03]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/agents/routing/route-parallel.ts#L2442
[X04]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/mcp-server/src/tools/callback-tools.ts#L2581
[X05]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-multi-mention-routes.ts#L179
[X06]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callbacks.ts#L6385
[X07]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-runtime-interaction-routes.ts#L99
[X08]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/action-terminal-predicate-truth.ts#L41
[X09]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/index.ts#L2945
[X10]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/managed-command-wake-action-lease-admission.ts#L34
[X11]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/WaitLifecycleRecoverySweep.ts#L11
[X12]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/index.ts#L1144
[X13]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts#L358
[X14]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-workflow-sop-routes.ts#L360
[X15]: https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-multi-mention-routes.ts#L540

[T08]: ../reports/threaded-collaboration-t08-tools-waits-2026-10-21.md "T08分层验证与真实工具/征询范围"

[T09]: ../reports/threaded-collaboration-t09-ui-2026-10-21.md "T09实际UI与授权重连范围"

[T10]: ../reports/threaded-collaboration-t10-actions-2026-10-21.md "T10领域、代际和真实只读GitHub验收边界"

[T11]: ../reports/threaded-collaboration-t11-workflows-2026-10-21.md "T11评审修订、SOP与基础知识的分层验收及未实现范围"
[T12]: ../reports/threaded-collaboration-t12-release-2026-10-21.md "T12发布、恢复、macOS与真实验收未决范围"

[RC01]: ../reports/threaded-collaboration-rc01-contracts-2026-10-22.md "RC01固定契约、差异归属、66组隔离回归与来源哈希"

[RC02]: ../reports/threaded-collaboration-rc02-github-2026-10-22.md "RC02生产注册、权限与72组隔离/真实provider分层证据"

[RC03]: ../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md "RC03选定生产命令profile、结构化hold/恢复窗口及共享额度分层证据"

[RC04]: ../reports/threaded-collaboration-rc04-live-review-2026-10-23.md "RC04生产跟踪分享桥接、双HEAD分层验收及真实观察状态"
