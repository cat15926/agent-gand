# 持续协作模式实施状态

状态：**实施中**（T01–T11 已交付；T12 发布/恢复/OS 接线及所列隔离验收完成，真实组合和发布条件未全部通过）。更新：2026-10-28（Asia/Shanghai）。RC02已推送 `a871910`，RC03首批选定命令profile及hold合同已推送 `ee751a3`；RC04生产跟踪分享桥接及所列隔离/进程验证已完成，真实只读观察已结束、结果not_observed，完整真实链未通过，RC04已推送 `d831a70`；RC05实现及所列分层验收已推送 `8d1fc75`，仍有明确限制/未定位历史超时；RC06已实施且所列分层41组通过，尚未整体验收关闭，已推送`f03648e`。RC07实现及所列分层验收完成，默认窗口自然压缩/产品seal及实际index完整原生组合仍未验，尚未整体验收关闭，已推送`6ca44fb`。RC08实现及所列分层验收完成，历史取消仍未定位，真实故障组合限制保留，已推送`52d3cc3`。RC09实现及所列分层验收完成，历史只读盘点已完成；原12项未知预留继续保留，RC09已推送`915f106`。RC10验收资产与本轮发布审查已交付，实际index注入链通过、真实综合链未通过，完整放行仍blocked，RC10已推送`ffcbbca`；RC11准备工具与所列隔离演练已交付，目标部署退出未完成。代码schema v35，默认closed，日常未配置/启用、未迁移。

产品名“持续协作”，内部模式 `threaded`。实施遵守已确认目标：**核心协作规则不做简化，平台差异显式登记，新增可靠性能力单独验收，高级能力逐项说明范围。**本表记录任务进度；已批准的设计不等于功能可用。

## 1 当前交付与基线

| 项目 | 状态与证据 |
| --- | --- |
| 实施路线 | [实施指导](threaded-collaboration-implementation-guide.md)，保留 Issue #16 的 T01–T12 顺序及原验收编号 |
| T01 设计 | [设计决策与接口](threaded-collaboration-t01-decisions.md)：模式、身份、存储、生命周期、资源、会话、控制、预算、领域来源和平台范围已冻结 |
| T02 实现 | [基础架构合同](../architecture/threaded-foundation-v1.md)与[验收报告](../reports/threaded-collaboration-t02-foundation-2026-10-19.md)：类型、关闭策略、身份/认证、旧路径隔离、v25 迁移和最小存储 |
| T03 实现 | [执行边界合同](../architecture/threaded-execution-boundary-v1.md)与[验收报告](../reports/threaded-collaboration-t03-execution-2026-10-20.md)：可信 Binding、首次 Run/Attempt 原子适配、专用控制/审批/撤权/恢复，fake executor 与 v26 |
| T04 实现 | [共享资源合同](../architecture/threaded-resources-v1.md)与[验收报告](../reports/threaded-collaboration-t04-resources-2026-10-20.md)：持久资源、公平竞争、共享容量、Session CAS、unknown 围栏、旧模式兼容桥与 v27 |
| T05 实现 | [消息合同](../architecture/threaded-messaging-v1.md)与[验收报告](../reports/threaded-collaboration-t05-messaging-2026-10-20.md)：独立消息、统一 ACL、附件、逻辑投递、冻结 wave、Outbox/收据、历史 HTTP 与内部提示、v28 |
| T06 实现 | [运行时合同](../architecture/threaded-runtime-v1.md)与[验收报告](../reports/threaded-collaboration-t06-runtime-2026-10-20.md)：持久 Wake/Invocation、资源/预算原子领取、响应终态事务、no-lost-wake drain、根预算和恢复、v29 |
| T07 实现 | [上下文与后端合同](../architecture/threaded-context-backends-v1.md)与[验收报告](../reports/threaded-collaboration-t07-context-backends-2026-10-20.md)：冻结输入 manifest、独立游标、可信投递/用量/静止证据、Session 恢复锚点与权限/压缩边界、API 重建及 SDK 原生续接、v30 |
| T08 实现 | [路由/工具/等待合同](../architecture/threaded-collaboration-v1.md)与[验收报告](../reports/threaded-collaboration-t08-tools-waits-2026-10-21.md)：用户/文本路由、15工具、私密读取provenance、持久征询/唯一结算/回调、timer/tracking/Decision，v31；17/4/4组新增验证及真实工具/征询子场景 |
| T09 实现 | [Thread UI与同步合同](../architecture/threaded-ui-v1.md)与[验收报告](../reports/threaded-collaboration-t09-ui-2026-10-21.md)：独立入口/认证、只读投影/精确回执、路由/Decision/控制、快照与事件引用同步，4/4/11组及实际隔离服务进程重启验证；仍为v31 |
| T10 实现 | [Action与领域合同](../architecture/threaded-actions-v1.md)及[验收报告](../reports/threaded-collaboration-t10-actions-2026-10-21.md)：独立责任、平台任务、真实GitHub GET/本地交付、替换/返回与命令代际，v32；12组Action、12组Chrome及分层真实域验证 |
| T11 实现 | [工作流合同](../architecture/threaded-workflows-v1.md)及[验收报告](../reports/threaded-collaboration-t11-workflows-2026-10-21.md)：完整来源/版本/作者评审合同、finding/修订/独立门禁、SOP CAS与可信任务核验、基础知识/ACL，v33；9/6/8组隔离验证、15组Chrome及22次真实GitHub GET |
| T12 实现 | [发布合同](../architecture/threaded-release-v1.md)、[运维手册](../operations/threaded-release-runbook.md)及[报告](../reports/threaded-collaboration-t12-release-2026-10-21.md)：v34、固定发布名单/根授权、独立入场/派发控制、只读演练、启动屏障/有界退出及 macOS 注册命令；7/16/9/4/8/5组分层验收 |
| RC01 合同核验 | **已完成**：[报告](../reports/threaded-collaboration-rc01-contracts-2026-10-22.md)与[来源清单](../reports/evidence/threaded-rc01-source-manifest.json)，五域实际链对照、113文件固定blob/SHA256、64分域引用、66组隔离回归；hold来源/SLA/命令准入及工程映射交RC03，工程实证交RC06，语义交EXT01；源核验不等于后续实现完成 |
| RC02 生产GitHub | **实现及所列分层验收完成，已推送a871910**：[合同](../architecture/threaded-github-production-v1.md)及[报告](../reports/threaded-collaboration-rc02-github-2026-10-22.md)；18组新隔离+54组回归、7项/8次真实官方只读GET；无真实模型调用。生产单例可选注册，日常未配置；RC04真实事件仍待验，RC03首批OS/hold交付另列 |
| RC03 生产命令与hold | **首批选定profile实现及所列验收完成，已推送ee751a3**：[合同](../architecture/threaded-commands-hold-production-v1.md)及[报告](../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md)；严格`project_manifest_v1`注册、固定program/argv/env/cwd、工程/成员/输出目录映射、独立多read/write资源及宿主副作用verifier；结构化hold、missed-timer SLA恢复/退休、timer/command共享3次/小时及撤权回调围栏。通用shell/build不在该profile范围，完整真实组合仍待RC04–RC08 |
| RC04 真实领域闭环 | **实现及所列隔离/进程验收完成，真实观察已结束、not_observed，完整真实链未通过，已推送d831a70**：[合同](../architecture/threaded-live-review-acceptance-v1.md)及[报告](../reports/threaded-collaboration-rc04-live-review-2026-10-23.md)；生产GitHub跟踪由caller-only改为受信private audience政策，与原来源ACL取交集，冻结grant/identity并在派发复验；generic与旧wait保持caller-only。38组专验及70组相关回归通过；完整真实链要求单Action、同root的H0→H1→H2两次自然HEAD，不以隔离通过或稳定GET判通过 |
| RC05 真实故障验收 | **实现及所列分层验收已推送8d1fc75，仍有明确限制/未定位历史超时**：[故障验收合同](../architecture/threaded-fault-recovery-acceptance-v1.md)及[RC05报告](../reports/threaded-collaboration-rc05-fault-recovery-2026-10-23.md)；恢复timer原fireAt、首个unknown/预算哈希保留及周期恢复tick存储故障三项修复。新增51组及相关回归99组、合计150组通过；新增通过范围实际index 58 PID。默认1秒长同步准备仅阻断、可用性仍有限；两次真实extended历史超时未定位，SDK持久停止事实/未知费用交RC09；不等于完整模式或生产发布通过 |
| RC06 并发与工程工作区 | **已实施且所列分层41组通过，尚未整体验收关闭，已推送`f03648e`**：[并发/工程合同](../architecture/threaded-concurrency-workspace-acceptance-v1.md)及[RC06报告](../reports/threaded-collaboration-rc06-concurrency-2026-10-24.md)。41＝协调器16＋原生宿主6＋工作区9＋实际index注入5＋实际index真实供应商5。新增显式`shared_project`整工程根read与外部分离`artifactRoot`，兼容原`isolated`；命令补充资源不占第二模型轮次，旧冲突写者/相同command/legacy屏障保留。生产源写/merge未交付，唯一owner/baseVersion合并仅fixture；真正冲突command单次reserve失败仍unknown、无自动资源等待重试，legacy实供应商混跑尚未验收，均作为未完缺口保留 |
| RC07 上下文验收 | **实现及所列分层验收完成，默认窗口自然压缩/产品seal及实际index完整原生组合仍未验，尚未整体验收关闭，已推送`6ca44fb`**：[上下文验收合同](../architecture/threaded-context-acceptance-v1.md)及[RC07报告](../reports/threaded-collaboration-rc07-context-2026-10-26.md)。修复API envelope准入拒绝提前曝光；保留SDK本地prompt前曝光；压缩元数据持久登记来源与SDK报告值。31组专验及83组回归、合计114组通过；受控窗口真实SDK压缩后精确续接，低层seal与来源撤权后冷开分层验收，不能外推默认自然压缩或生产seal入口 |
| RC08 征询诊断与可靠性 | **实现及所列分层验收完成；原T08取消仍未定位，真实故障组合限制保留，已推送`52d3cc3`**：[征询验收合同](../architecture/threaded-consultation-acceptance-v1.md)及[RC08报告](../reports/threaded-collaboration-rc08-consultation-2026-10-27.md)。修复无deadline的waiting回调resume后不派发；补SDK可信白名单错误码。23组专验＋84组回归通过；原T08临时证据仅余空目录，历史取消原因不能补造。实际入口5场景与低层竞争/outbox故障分层记录 |
| RC09 历史对账与恢复 | **实现及所列分层验收完成，历史12项未知预留保留，已推送`915f106`**：[对账合同](../architecture/threaded-reconciliation-acceptance-v1.md)与[RC09报告](../reports/threaded-collaboration-rc09-reconciliation-2026-10-27.md)。原89行只读盘点通过；完整receipt预算投影和closed宿主事实的恢复分别验收，不重放、不发布旧正文、不自动释放claim或更改外部账本；新增24组＋相关101组、合计125组通过 |
| RC10 综合验收与发布审查 | **验收资产与本轮审查交付，完整退出未通过**：[工厂综合链7组](../reports/evidence/threaded-rc10/chain.json)和[52组回归＋3套完整suite](../reports/evidence/threaded-rc10/regressions/coexistence-summary.json)通过；[119行逐项审查](../reports/evidence/threaded-rc10/acceptance-audit.json)保留未完成退出条件。实际index注入1组通过，三次真实整链未通过；不据此启用日常模式 |
| RC11 发布准备 | **准备工具及所列隔离演练交付，目标退出未完成**：[报告](../reports/threaded-collaboration-rc11-release-preparation-2026-10-28.md)；18组预检＋7组恢复＋6组实际index模式通过，0真实供应商。候选日常WAL库未打开，目标schema/库存/宿主未验；匹配恢复和迁移尚未执行，RC10门槛保留 |
| 剩余计划 | [剩余实施与验收计划](threaded-collaboration-remaining-plan.md)：RC01–RC12负责合同核验、生产接线、真实验收、对账及发布；EXT01–EXT05保留后续能力范围，不新增T13或自动开工 |
| 合同与能力 | [兼容矩阵](threaded-collaboration-compatibility-matrix.md)：K01–K16、59 项原验收、细化行为、平台差异、E01–E06 独立增强和高级能力范围 |
| 代码接入 | [接入地图](threaded-collaboration-integration-map.md)及[候选检索证据](../reports/evidence/threaded-t01-mode-origin-inventory.json)：全部扫描文件、hash、搜索模式、命中行、职责和局限可复核；不是静态可达性证明 |
| 固定源码 | [基线报告](../reports/threaded-collaboration-t01-baseline-2026-10-19.md)及[来源清单](../reports/evidence/threaded-t01-source-manifest.json)：本地差异、环境、迁移目录、上游定点核验及许可 |
| 本地底座 | T01 固定代码 `b95dc2553405268a9b807b3983fee8f9facc55fa`；T01 文档 `0a2f1b4`、T02 基础 `5298a9d`、T03 `c3b36db`、T04 `12d99e6`、T05 `98b331f`、T06 `79bad41`、T07 `a773698`、T08 `606a8c0`、T09 `72efefd`、T10 `c944c9d`、T11 `ba438b1`、T12 `b99997a`、RC01文档 `35804a1`、RC02 `a871910` 已推送 origin/main；RC03 `ee751a3` 已推送；RC04 `d831a70` 已推送；RC05 `8d1fc75` 已推送；RC06已推送`f03648e`；RC07已推送`6ca44fb`；RC08已推送`52d3cc3`；RC09已推送`915f106`；RC10已推送`ffcbbca`，原始阶段证据保留 |
| Clowder 参考 | `8b373123323aacd7e2047dab94fdc15b8f7567ae`；固定版本，不跟随远端 HEAD |
| 迁移 | RC03仅追加v35共享hold准入ledger，v25–v34的17个历史迁移片段与descriptor不变；实际a871910 v34→v35、旧timer额度/时间精确回填，旧awaiting/paused-command wake因无注册时间按升级时刻保守占窗且重启不续期；失败全回滚、重复启动及旧worker零修改拒绝19组通过。T12历史v34/17组证据保留；日常业务库未迁移，不推断已部署schema |
| 交付 | T01–T12 的代码/阶段文档及所列证据已提交推送，T12为 `b99997a`；T12完整验收与生产发布未完成；RC01/进度文档已提交推送35804a1；RC02实现/文档/证据已提交推送a871910；RC03实现/文档/证据已推送ee751a3；RC04已推送d831a70，真实领域退出条件未全部满足；RC05实现及所列分层验收已推送8d1fc75、仍有限制；RC06已实施且所列分层41组通过，尚未整体验收关闭，已推送`f03648e`；RC07实现及所列分层验收完成、已推送`6ca44fb`，默认窗口自然压缩/产品seal及实际index完整原生组合仍未验；RC08实现及所列分层验收完成、已推送`52d3cc3`，历史取消未定位及真实组合限制保留；RC09实现及所列125组验收完成、已推送`915f106`，12项历史未知未收敛且保留处置已登记；未回写Issue |
| 真实验收边界 | macOS选定同一账号、Anthropic兼容API与claude-sdk 0.3.288的合成上下文及所列真实故障/并发范围通过，不外推全部账号/供应商/组合。源账号配置只读、隔离库执行，不读日常会话。用户总授权1000万input+output token；T12旧runner限定20万，RC05–RC08在原共享账本上选择累计50万保守门禁。RC05结束时确认65,181/未知187,029，保守累计252,210；RC06新增确认5,362/未知19,803，RC06结束时确认70,543/未知206,832，保守累计277,375，门禁余222,625。RC07新增11个实际请求全部获得已知用量，新增确认116,740＝主入口9,482＋原生受控压缩107,258 token，新增unknown为0；累计确认187,283＋历史未知206,832＝保守占额394,115，累计50万门禁余105,885。原57行账本保持不变，历史未知不因本轮成功释放；原89,758未知及历史行保留，失败与未定位超时不被成功覆盖，准确分层见RC05/RC06/RC07报告；RC08新增21次真实HTTP，另1次本地HTTP400未发往供应商；新增确认33,195 token、unknown为0。原68行账本未改，截至RC09累计确认220,478＋历史未知206,832＝保守占额427,310，累计50万门禁余72,690；历史unknown不自动释放，见[RC08报告](../reports/threaded-collaboration-rc08-consultation-2026-10-27.md) |

RC11以已推送RC10 `ffcbbca` 为基线完成准备工具及所列隔离演练，目标部署退出未完成，见[发布准备合同](../architecture/threaded-release-preparation-v1.md)与[RC11报告](../reports/threaded-collaboration-rc11-release-preparation-2026-10-28.md)。18组预检、7组匹配恢复、6组实际index模式检查通过：一致备份/原路径恢复、v34→v35和旧兼容门零修改拒绝、新数据/unknown保全；observe的100张threaded表、9张共享资源表与unknown claim保持，closed旧HTTP入口及新入场拒绝。原生文件/密钥和数据均为合成夹具，旧worker仅执行兼容函数，旧模式为历史读写，无真实供应商请求。候选日常库WAL在SQLite打开前被预检拒绝，实际schema/库存/宿主尚未核实；未创建配套目录或执行日常迁移/启用。RC10完整放行仍blocked，RC11目标匹配备份/恢复和模式验收仍待执行，不自动进入RC12。

## 2 T01 退出条件

| 退出条件 | 结果 |
| --- | --- |
| 固定本地、上游、依赖、环境及迁移目录；解释基线变化 | 已完成，保留新 HEAD 的 control_draft 展示规则；源码清单可按固定 URL/hash 复查 |
| Thread、Invocation、Action 分离；明确 Run 与重试 | 已冻结：一 Invocation 对一 Run，多个 Attempt；unknown 不终结或盲重试；Action 独立领域验收 |
| 消息不依赖永久 Run，定义 owner 与版本 | 已冻结：独立 threaded_messages、稳定 instance_owner_id、独立 HTTP/工具/记录版本、前向迁移 |
| 防止旧入口、恢复器、终态及查询误接管 | T01 已分配责任；T02 的旧路径拒绝/跳过及 HTTP/WS 隔离已验证，T03 专用执行/控制端口、T04 资源、T06 调度与 T07 隔离真实后端已接；T12生产factory已接，日常配置与工作入场保持关闭 |
| 冻结混合资源、Session、取消和 unknown 语义 | 已完成：旧 exclusive 与新 thread-slot 共用竞争；Session 先解析再验证领取；代际不重置；未知外部执行不被异常 cleanup 释放 |
| 核心合同、平台差异、增强、高级范围各自有台账 | 已完成，保留原 K/验收原文；不把范围外或未验证写成支持，不按通过数量计算复刻比例 |
| 后端与领域来源明确 | API、claude-sdk 0.3.288 在 macOS 的 T07 所列真实后端范围通过；T10已接平台任务和真实GitHub当前HEAD/本地review交付；真实主服务、并发/压缩及全部业务故障组合尚未全部验证，见剩余计划RC04–RC08 |
| T02–T04 可继续实施 | 已给出接口责任、最小 schema 约束、迁移分配、负向用例和退出条件；真实执行保持关闭 |
| 文档及证据可复核 | T01 固定证据保留为历史基线；T02 实际变更及验证另记报告 |

交叉复核已修正三项设计风险：Session 身份未解析就领取锁、runner 异常后无条件释放未知执行资源、Decision/hold 创建即终止 Invocation。未知进程与生命周期部分已由 T03 fake 验证，T04 已增加持久资源及 Session 身份准备，T07 已完成所列真实后端验收；非阻塞工具与等待已由 T08 独立验证，T10命令/Action代际已有独立验证，实际macOS注册命令端口保留T12历史8组；RC03新增首批选定生产profile与hold合同见本轮报告，日常默认未注册。

## 3 任务进度

| 任务 | 当前结果 | 当前接续与限制 |
| --- | --- | --- |
| T01 基线、架构决定、合同与能力矩阵 | **设计交付完成** | 后续实现若改变基线，登记依据和验收影响 |
| T02 类型、模式路由、schema 与迁移 | **实现及隔离验证完成** | T02当时骨架不执行；T12已接受信生产执行，仍须固定pack及持久许可，默认closed |
| T03 Binding、Run adapter、权限 | **实现及隔离验证完成** | 已接 T04 资源、T05/T06 消息调度与 T07 隔离真实后端；生产入场关闭 |
| T04 混合资源、共享容量、公平性 | **实现及隔离验证完成** | 持久资源、旧模式桥、T06 Wake drain 与 T07 后端证据已接 |
| T05 消息、ACL、Delivery、Wake、Outbox | **实现及隔离验证完成** | 生产历史读取、内部提示、T06 响应终态与 T07 实际上下文投递已接 |
| T06 队列、Invocation、响应提交、恢复 | **实现及隔离验证完成，已推送** | 确定性最小闭环、预算与故障窗口通过；生产 dispatch 关闭 |
| T07 上下文、游标、Session、后端 | **实现及所列隔离/真实验证完成** | API 重建、SDK 冷开/续接、运行时及 SQLite 重建恢复、权限变化冷开、取消 unknown；真实主服务故障/并发/压缩剩余见RC05–RC07 |
| T08 路由、工具、等待、持久征询 | **实现及所列分层验证完成，已推送606a8c0** | 17/4/4组及E01–E06独立证据；真实API/SDK工具与双成员征询复验通过；Action领域已由T10/T11承接，征询取消风险见RC08 |
| T09 UI、回执、重连、状态面板 | **实现及所列隔离浏览器验证完成，已推送72efefd** | 4组同步/4组投影HTTP/11组Chrome；刷新/断线/实际HTTP进程SIGKILL与新SQLite连接恢复通过，业务发布待后续 |
| T10 Action、完成谓词、替换/返回 | **实现及所列分层验收完成，已推送c944c9d** | 12组Action/多进程/故障；真实平台任务和GitHub只读域通过；macOS注册命令已由T12验8组；生产GitHub/OS注册及真实新HEAD见RC02–RC04 |
| T11 Review/Revision、SOP、共享记忆 | **实现及所列分层验收完成，已推送ba438b1** | 9组Review、6组SOP、8组知识、15组实际Chrome；22次真实GitHub GET，仅本地评审交付，无新增模型token；语义检索仍未实现 |
| T12 综合验收、兼容、发布与回滚 | **接线及所列隔离/宿主验收完成，真实组合未全部通过** | 17组迁移、7组release、16组production、9组24恢复进程、4组index、8组macOS、5组Chrome；真实SDK补验已通过；远端新HEAD及完整发布条件见T12报告 |
| RC01 固定参考合同核验 | **已完成，差异已登记并分配** | Session分层/本地policy适配、根预算增强、hold/SLA/命令准入缺口、普通工程/Collective差异、真实语义链及质量边界；RC02已推送，RC03已按本轮指令完成所列范围，其他RC/EXT未自动开工 |
| RC02 生产PR来源、tracking及Review接线 | **实现及所列分层验收完成，已推送a871910** | 固定文件/凭据/身份/范围，来源撤权结算/派发围栏；72组隔离及7项真实只读通过，日常未配置，真实新HEAD链仍RC04 |
| RC03 生产命令、工程映射及hold合同 | **首批选定profile及所列验收完成，已推送ee751a3** | `project_manifest_v1`非通用shell/build；固定进程输入、完整独立读写资源与可信副作用核验；结构化来源/SLA仅约束错过timer的恢复窗口，共享timer/command wake额度；实际宿主与回归的准确范围见RC03报告，日常未配置/迁移 |
| RC04 真实PR跟踪、修订与独立复审 | **实现及所列隔离/进程验收完成，真实观察已结束、not_observed，完整真实链未通过** | 38组专验及70组相关回归通过，生产分享桥接守原来源ACL及当前权限；单Action/同root的两次自然HEAD、旧approved失效、changes_requested交付与门禁分离、逐项attested及独立复核须分别留证。配置600秒的只读窗口实测609秒/71次官方GET，0新HEAD/0tracking callback，结果not_observed，H1/H2真实链未通过；不以RC05/RC06其他成功覆盖 |
| RC05 实际入口与真实故障组合 | **实现及所列分层验收已推送8d1fc75，仍有明确限制/未定位历史超时** | 新增51组及相关99组通过，新增通过scope有58个实际index PID；未发有据重试、已发unknown不重放、终态/后继、API/SDK在途、审批/撤权、I/O与SLA/PID边界分层留证。默认1秒同步长准备可用性、未定位真实extended超时及SDK持久registered/未知费用收敛保留限制，详见RC05报告 |
| RC06 真实并发与工程组合 | **已实施且所列分层41组通过，尚未整体验收关闭，已推送`f03648e`** | 协调器16/原生宿主6/工作区9/实际index注入5/实际index真实供应商5分别通过；分层证据见RC06报告，不与待汇总回归混算。`shared_project`映射完整工程根read及外部分离artifactRoot，旧isolated兼容；命令补充资源不额外抢模型轮次，更早真实冲突仍优先。生产源写/merge工具、真正资源冲突command的自动持久等待重试未交付，legacy实供应商混跑尚未验收；唯一owner/baseVersion合并只验fixture协议 |
| RC07 输入与压缩组合 | **实现及所列分层验收完成，默认窗口自然压缩/产品seal及实际index完整原生组合仍未验，尚未整体验收关闭，已推送`6ca44fb`** | 来源超限/精确集合与空洞/同波冻结/游标失败恢复/envelope拒绝后续执行、压缩来源/精确续接或冷开已分层留证；31组专验＋83组回归通过。实际SDK受控窗口真实压缩与注入合成usage分别记录，默认窗口自然压缩、产品seal和实际index完整原生组合仍未验 |
| RC08 征询故障与原始诊断 | **实现及所列分层验收完成；原T08取消仍未定位，真实故障组合限制保留，已推送`52d3cc3`** | 23组专验＋84组回归通过；原答、唯一结算/回调、anti-cascade、重启/失权及精确重试已按层留证。原T08取消未定位；真实供应商请求与本地400、受控时钟、broker扣留回执明确区分，低层多PID/outbox故障不外推实际index与供应商全组合 |
| RC09 用量、进程与副作用对账 | **实现及所列分层验收完成；历史只读盘点完成，12项未知继续保留；已推送`915f106`** | 完整receipt/预算写入缺口及closed进程停止补记按原身份核验；factory9＋预算9＋实际index6及相关101组，合计125组通过。历史89行原账本不变，9项有精确映射、3项缺桥接，0次真实供应商请求 |

| RC10 综合链与发布审查 | **验收资产与本轮审查交付，完整退出未通过** | [工厂综合链7组](../reports/evidence/threaded-rc10/chain.json)通过；[回归52组＋3套完整suite](../reports/evidence/threaded-rc10/regressions/coexistence-summary.json)通过；[119行逐项审查](../reports/evidence/threaded-rc10/acceptance-audit.json)保留所有未完成退出条件。实际index注入1组通过、三次真实整链未通过，报告与用量已留证；不自动进入RC11/RC12 |

**功能验证总状态：**T02–T11 已实现并通过所列隔离 fixture；DB03追加v35验证通过，v25–v34历史源码与事实保留。T06 的 Wake/Invocation、共享资源/预算领取、响应/Run/Outbox 事务与控制恢复已接 T07 实际上下文投递。macOS 上 API 两次请求的重建与私密排除、SDK 冷开/原生续接/权限变化冷开及取消 unknown 验证通过。SDK 补验在同一验收进程中关闭旧数据库连接，重新创建 runtime、SQLite 连接和资源 owner，再从持久锚点恢复同 nativeId 与记忆；每次 Invocation 启动独立 SDK worker，恢复自身不发送请求，见[补验证据](../reports/evidence/threaded-t07-real-sdk-reopen.json)。这不构成整个主服务进程 kill/restart 的验收。

T12已接真实生产factory与受信pack，但默认closed、未配置名单、未打开持久许可；日常生产仍未启用。所列主服务烟测、模块组合故障恢复、macOS命令和真实Chrome通过；它们不等于真实供应商的全部主服务故障窗口通过。真实API五类知识/SOP工具通过；两次SDK失败保留，活动心跳修复后真实SDK五工具和隔离HTTP服务SIGKILL原生续接复验通过。T12报告逐项记录未通过及未验证项，不能计为全部59项通过。

T08首次征询取消根因未定位，旧未知费用与围栏保留。RC07已取得实际SDK合成usage及受控窗口真实供应商的自动压缩证据，默认窗口自然压缩仍未验；低层seal不能充当产品HTTP/UI入口。完整主服务真实执行及其他供应商/驱动和平台组合按矩阵补验。RC04已修复caller-only跟踪回调阻断合法独立复审的生产桥接缺口，真实新HEAD双轮闭环仍未通过：本轮609秒/71次官方GET未出现新HEAD，结果not_observed，仍待H1/H2两次自然事件，最终分层结果以RC04报告为准。

完整语义检索、Collective 特殊隔离、扩展载体、多租户/多机按矩阵单列后续或范围外；普通私密 ACL、核心 Action、基础知识和 SOP 仍在首版目标。MEM01 包含语义检索，基础部分完成时仍不能将整项标为全部通过。Linux 与 WSL 分别待验证，Windows 原生首批范围外。

## 4 验证记录

| 检查 | 结果与能证明的范围 |
| --- | --- |
| RC01指定隔离回归 | Session13、资源集成8、预算14、协作17、知识8、活动心跳6，共66组通过；无真实模型或外部fixture网络。心跳两次沙箱失败由内存诊断确认listen EPERM，允许loopback后原脚本通过，原失败及历史证据保留；见[RC01结果](../reports/evidence/threaded-rc01-local-checks.json) |
| RC02新增与相关回归 | 新18组＋生产16/协作17/Action12/Review9共72组隔离通过；真实provider7项/8次官方GET另记，真实模型0，无日常发布或远端写；见[RC02证据](../reports/threaded-collaboration-rc02-github-2026-10-22.md) |
| RC03新增与相关回归 | 等待合同14组、命令共享准入4组、实际production接线2组、迁移19组、资源19＋集成8＋旧资源11组，以及协作17/Action12组通过；新增macOS原生、既有OS/production/GitHub/Review回归以[RC03报告](../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md)最终记录为准，不沿用历史组数冒充本轮已验。0真实模型/供应商请求，无日常发布 |
| RC04新增与相关回归 | 38组专验通过：transport12、生产delivery授权6、实际cooperation/ACL分享7、同Action双HEAD注入链9、实际worker进程恢复4；PR事实和模型答复在这些用例中为注入。相关协作17/生产GitHub18/Action12/Review9/RC03等待14共70组回归通过，合计108组，见[RC04报告](../reports/threaded-collaboration-rc04-live-review-2026-10-23.md)；真实窗口实测609秒/71次官方GET、17轮poll/66次PR事实，3目标均0新HEAD/0tracking callback，结果not_observed；无真实模型调用，H1/H2完整真实链未通过 |
| RC04真实只读观察与恢复 | [真实结果](../reports/evidence/threaded-rc04/live-2026-10-23.json)：609秒/71次官方GET、17轮poll、66次PR事实；3目标`#1698/#1701/#1505`均0新HEAD/0tracking callback，not_observed。baseline无误触发；每目标实际SIGKILL一次、共6 PID，恢复0额外GET/0脚本重放，ID及计数保持。该层只证明真实基线/静态恢复，H1/H2两次自然新事件及修订复审完整链仍未通过；0真实模型/远端写 |
| RC05新增与相关回归 | 新增51组通过：等待9组/20用例、存储10、活动5、注入实际index 10、实际index等待6、慢SSE拒写1、真实核心故障7、真实活动2、真实回执I/O 1；相关预算14/运行时18/RC03等待14/协作17/production16/release7/实际入口4/服务恢复9共99组通过，合计150。分层结果及失败保留见[RC05报告](../reports/threaded-collaboration-rc05-fault-recovery-2026-10-23.md)，注入传输/时钟结果不冒充真实供应商，默认1秒活动片不改 |
| RC05实际入口进程范围 | 新增通过范围实际index 58 PID＝注入主入口19＋停机等待18＋慢SSE拒写2＋真实核心14＋真实活动3＋真实回执I/O 2；不是包含失败尝试或历史回归的全局进程总数。两次真实extended超时各12,918未知预留仍保留，未证明与本地timer EXIT1同根因；首轮terminal旧断言误判后继文本，未据此认定生产重复提交 |
| RC06已完成分层专测 | 41组通过：[协调器16组](../reports/evidence/threaded-rc06/concurrency.json)使用8个真实PID，含同键/同槽/容量/旧独占/服务轮次与命令冲突边界；[原生宿主6组](../reports/evidence/threaded-rc06/native.json)验证所列SDK guardian取消隔离、B续接及原生资源围栏，模型传输注入；[工作区9组](../reports/evidence/threaded-rc06/workspace.json)验证真实本地工程父子路径互斥、分离产物及生产工厂/注册命令共享工程read；[实际index注入5组](../reports/evidence/threaded-rc06/main-injected-final.json)与[实际index真实供应商5组](../reports/evidence/threaded-rc06/main-live-first.json)分别验证同键重试/同槽/跨Thread/取消A保留B/容量释放再入队。唯一合并者/baseVersion仅fixture协议，legacy实供应商混跑未验收；不声明RC06整体关闭，相关回归另记 |
| RC06相关回归及合计 | 相关88组＝resources19＋resource integration8＋queue11＋backend runtime7＋production16＋legacy resources11＋production commands10＋RC03 production2＋command admission4，与专验41组合计129组。strict overlap重复补验1组不额外计数。backend-runtime[未提权首轮失败](../reports/evidence/threaded-rc06/regressions/backend-runtime-first-failure.json)为unknown不等于completed，独立loopback探针EPERM仅候选、原因为未证实；[单独提权7组通过](../reports/evidence/threaded-rc06/regressions/backend-runtime-retry.json)与首轮失败并存，不宣称根因定位或生产修复 |
| RC06账本历史核对 | [ledger](../reports/evidence/threaded-rc06/ledger.json)：按原授权ID集合只读重建原47行，exact JSON SHA256与main运行前digest一致，原行未改；新增10行＝9个已知请求＋1个unknown预留。RC06结束时确认70,543、未知206,832、保守占额277,375，50万门禁余222,625；此历史完整性核对不等于未知供应商费用收敛 |
| RC07新增分层专验 | 31组专验＝context7＋admission5＋原生SDK注入7＋实际index注入5＋实际index真实5＋受控窗口原生注入1＋受控窗口原生真实1；相关83组＝context14＋session13＋resource integration8＋queue11＋backend runtime7＋backends14＋production16，合计114组通过。证据分别为[context](../reports/evidence/threaded-rc07/context.json)、[admission](../reports/evidence/threaded-rc07/admission.json)、[原生注入](../reports/evidence/threaded-rc07/native.json)、[index注入](../reports/evidence/threaded-rc07/main-injected-final.json)、[index真实](../reports/evidence/threaded-rc07/main-live-first.json)、[受控原生注入](../reports/evidence/threaded-rc07/native-injected-live-runner.json)及[受控原生真实](../reports/evidence/threaded-rc07/native-live-first.json)；开发失败保留、不计通过组数 |
| RC07实际进程与压缩边界 | 实际index每层7 PID＝5场景＋cursor/envelope各重启一次；wave故意串行化容量以核验B晚准备仍排除A本波答案。受控窗口真实供应商验收使用SDK 0.3.288/CLI 2.1.288，4次Invocation、5次HTTP、4个guardian；前两轮100,000窗口，第3/4轮仅在隔离验收环境设置`CLAUDE_CODE_MAX_CONTEXT_TOKENS=32000`，44,999字节合成参考文本的实际用量与压缩摘要均来自供应商，auto事件后按同nativeId及精确boundary续接。该层使用factory隔离执行bypass，不是实际index或默认窗口自然压缩；生产模型正常窗口未改，seal仅通过可信低层端口验收，无HTTP/UI入口 |
| RC07累计账本 | RC07新增11个实际请求全部获得已知用量，新增确认116,740＝主入口9,482＋原生受控压缩107,258 token，新增unknown为0；累计确认187,283＋历史未知206,832＝保守占额394,115，累计50万门禁余105,885。原57行账本保持不变，历史未知不因本轮成功释放。见[账本核对](../reports/evidence/threaded-rc07/ledger.json)；已知用量不等于未知价格或历史供应商费用已收敛 |
| `pnpm typecheck` | T12后通过（shared、server、web） |
| 固定源码 hash、Git 差异、迁移 descriptor 清单 | 已核对；不证明部署数据库状态或上游全产品行为 |
| K01–K16、原 59 项逐条比对 | 通过；ID 和原文全部保留，不执行行为 |
| T01 生产检索清单重现及 hash | T01 时通过；296 个源文件 hash、1,225 条分类命中完全重现；22 个本地基线文件及 34 个上游引用条目（33 个唯一文件）已核对。T02 改动后不再把旧 hash 当当前源码保证 |
| `pnpm verify:threaded-migration` | RC03通过19组，保留T12历史17组并追加实际`a871910` v34→v35、17个历史片段字节不变、旧timer原时间及活跃旧command保守升级占窗保留、DDL/登记失败回滚及旧worker零修改拒绝；见RC03报告 |
| `pnpm verify:threaded-isolation` | 通过，6 组新模式/未知/错配 fixture；恢复无写入，零 executor/callback；旧三模式正向终态通过 |
| `pnpm verify:threaded-access` | 通过，管理桥接、专用会话/CSRF、owner、版本、HTTP/WS、注销/过期和关闭入场 |
| `pnpm verify:threaded-legacy-boundary` | 通过，旧 HTTP/WS 列表/派生 ID/写入前隔离，既有记录仍可用，零外部调用 |
| `pnpm verify:threaded-lifecycle` | 通过，21 组；可信 Binding、Run/Attempt、unknown、审批、终态故障、控制和资源释放的 fake 验证；完整范围见 T03 报告 |
| `pnpm verify:threaded-controls` | 通过；专用 HTTP、作用域/CSRF/幂等、真实账户撤销事务与回滚、生产恢复入口 |
| `pnpm verify:threaded-resources` | 通过；19 组真实多连接/多进程 SQLite 竞争、公平性、实际 nativeId 锁、全资源事务、容量、proof/epoch 与主动通知 |
| `pnpm verify:threaded-resource-integration` | 通过；8 组真实 Session CAS、目录变更、领取与 Attempt 同事务、unknown 与意外 nativeId |
| `pnpm verify:legacy-resources` | 通过；11 组临时库生产单例与旧调用桥，具体范围见 T04 报告 |
| `pnpm verify:threaded-messages` | 通过；19 组多进程消息幂等、ACL/来源/附件、冻结 wave、各写点回滚、只读/崩溃、Outbox 代际与重试 |
| `pnpm verify:threaded-message-api` | 通过；6 组，增加 paused 接收/回执且零 Run/Attempt；生产入场仍关闭 |
| `pnpm verify:threaded-message-notifications` | 通过；9 组提交后提示、listener 错误/异步/重入、分批、关闭与重启修复 |
| `pnpm verify:threaded-queue` | 通过；11 组持久顺序、控制 epoch/边界、ACL 与权限漂移、blocked FIFO、控制终态投影 |
| `pnpm verify:threaded-budget` | 通过；14 组独立根/请求预留、累计活动/等待、窗口/Owner 版本、unknown 与可信结算验收 |
| `pnpm verify:threaded-runtime` | 通过；18 组真实多进程竞争、无定时器重入、三个真实退出窗口、27 个事务写点故障、控制/预算阻塞、同根普通接力 |
| `pnpm verify:threaded-context` | 通过；14 组，ACL/附件、预算空洞、冻结输入、独立游标、可信投递、未知发送与历史收据修复 |
| `pnpm verify:threaded-session-context` | 通过；13 组，Session CAS、可信锚点、权限/账号/输入边界漂移、unknown 围栏、压缩来源与故障回滚 |
| `pnpm verify:threaded-backends` | 通过；14 组，注入 HTTP 与 SDK 协议、逐请求预算、精确收据、取消/unknown、进程静止核验边界；退出正例为显式注入，不计为真实模型或宿主退出验收 |
| `pnpm verify:threaded-backend-runtime` | 通过；7 组真实组合代码的隔离验证，含 manifest/预算/投递接线、输入阻塞、失败保留 unknown、投递修复与外发前 token 门禁 |
| `pnpm verify:threaded-collaboration` | 通过17组；路由/循环、消息工具、征询、timer/tracking/Decision、真实IPC崩溃竞争及E01–E06，注入HTTP41次，零真实模型 |
| `pnpm verify:threaded-collaboration-backends` | 通过4组；Anthropic/OpenAI工具循环、实际SDK worker/CLI/MCP/RPC与宿主静止、私密工具来源撤权冷开，模型响应为注入 |
| `pnpm verify:threaded-collaboration-api` | 通过4组；专用鉴权/CSRF、策略CAS、preview、关闭入场与规范Decision回应 |
| T08 授权真实工具/征询 | API/SDK read/post成功；首轮征询取消保留，新场景复验4Invocation/5HTTP、唯一结算回调，见[T08报告](../reports/threaded-collaboration-t08-tools-waits-2026-10-21.md) |
| 授权真实 API/SDK 验收 | 通过所列 macOS 范围；API 重建/隐私与 SDK 冷开/续接/权限变化冷开/取消 unknown 分别记录，另完成 runtime/SQLite 重建补验；命令、请求/用量及限制见 [T07 报告](../reports/threaded-collaboration-t07-context-backends-2026-10-20.md) |
| 旧运行策略、终态、动作命令及前端构建 | T02 已通过；T04 重跑运行策略、动作命令、终态、持久等待恢复及旧原生/双账户隔离回归，均通过；“当时前端未改”仅为T04历史范围。T09–T12前端及构建另有验证，不据此免除当前构建 |
| `pnpm verify:threaded-view` / `verify:threaded-view-api` | 各4组通过：客户端epoch/隐私清空、只读投影/当前ACL/精确回执/有界事件回放、认证与WS失效 |
| `pnpm verify:threaded-ui` | 11组真实Chrome，本机临时库；路由CAS、丢回执重试、离线隐私清空、实际HTTP子进程SIGKILL/重启和桌面/手机截图 |
| T09构建/旧聊天UI | Web build通过；既有message-presentation真实Chrome五组通过、零supplier请求 |
| `pnpm verify:docs` | 通过，全仓文档本地链接有效 |
| `git diff --check` | 通过；新增未跟踪文件另检查行末空白 |

T02–T06 只在隔离 SQLite、注入式 Fastify、fake provider/executor 和受控子进程 fixture 中验证。T07 在用户授权后首次只读业务库的选定账号、配置及加密凭据记录，用隔离数据库、独立 SDK 配置目录和新建合成上下文执行真实模型验收；未迁移业务库、未读取日常会话、未启用生产新模式。外发内容限定为合成验收消息及其隔离历史。实际用量、未知占额和累计门禁已续记至 T12 报告，隔离证据与真实后端证据分别登记。

| 检查 | T10补充结果 |
| --- | --- |
| `pnpm verify:threaded-actions` | T10 12组，真实平台task facade、双进程CAS、producer SIGKILL及5写点回滚；PR/命令传输注入 |
| `pnpm verify:threaded-actions-github -- --authorized-git-credential` | 获权真实GitHub只读、本地评审交付/完成、真实旧HEAD拒绝、live baseline；远端新事件未观察 |
| T10 Chrome/UI | 12组，真实领域投影及原有UI/授权/实际隔离HTTP进程重启；见T10报告 |

| 检查 | T11补充结果 |
| --- | --- |
| `pnpm verify:threaded-reviews` | 9组、11故障点、真实双进程CAS；逐项finding回复与独立核验、旧receipt门禁重验、v32旧finding采用与首次旧工具绕过拒绝、只读Owner投影 |
| `pnpm verify:threaded-sop` | 6组，双成员双进程CAS、3写点回滚、可信精确task_done、只读快照及SIGKILL |
| `pnpm verify:threaded-knowledge` | 8组，7工具真实allowlist/来源曝光、版本/过期/替代、跨Thread撤权、双进程CAS、SIGKILL及3写点回滚 |
| `pnpm verify:threaded-reviews-github -- --authorized-git-credential` | 22次官方GET；旧HEAD/错误来源版本拒绝、精确普通A2A作者唤醒、交付completed而门禁blocked，零远端写 |
| T11 Chrome/UI | 15组、5张截图，真实来源认证GET、390px和实际隔离HTTP进程SIGKILL恢复；见T11报告 |

| 检查 | T12补充结果 |
| --- | --- |
| 发布/生产接线隔离 | release 7组、production 16组；固定pack、双门禁、失效配置稳定阻塞及observe业务零写入 |
| 服务恢复/实际入口 | 组合服务9组/24子进程，实际index 4组；后者无真实供应商/execute pack，不替代完整真实主服务恢复 |
| macOS/Chrome | OS命令8组、生产UI 5组；默认生产未注册GitHub/OS端口 |
| 真实工具/原生续接 | API五工具与修复后SDK五工具、静止后的隔离HTTP服务SIGKILL续接通过；两次失败与unknown保留 |
| 新增可靠性 | 活动心跳6组、传输诊断4组；不改变默认许可/根预算，过期/硬限额/撤权仍拒绝 |
| 真实PR跟踪 | 606秒/48 GET未观察新HEAD，not_observed；真实动态唤醒尚未通过 |

## 5 T12交接与剩余退出条件

输入为已推送 T12 `b99997a`、[发布合同](../architecture/threaded-release-v1.md)、[运维手册](../operations/threaded-release-runbook.md)及[分层报告](../reports/threaded-collaboration-t12-release-2026-10-21.md)。日常配置/数据库未改。剩余工作统一列入[剩余计划](threaded-collaboration-remaining-plan.md)，RC01已完成固定来源核验并细化RC03/RC05–RC07/EXT01用例，RC02已推送可选生产GitHub来源及权限/恢复围栏，RC03已完成首批选定命令profile和hold合同并推送ee751a3；RC04已完成生产跟踪分享桥接及所列隔离/进程验证，真实观察已结束、not_observed，完整真实链未通过；RC05实现及所列分层验收已推送8d1fc75，仍有明确限制/未定位历史超时；RC06已实施且所列分层41组通过，尚未整体验收关闭，已推送`f03648e`；RC07实现及所列分层验收完成，默认窗口自然压缩/产品seal及实际index完整原生组合仍未验，尚未整体验收关闭、已推送`6ca44fb`；此处仅概括尚余退出条件。

1. 真实SDK知识/SOP及静止执行后的隔离HTTP服务SIGKILL同nativeId续接已补验通过，两个失败/unknown原样保留；RC05已补实际index及真实API/SDK在途等所列故障边界；SDK进程组停止事实不自动把持久registered/unknown或未知费用收敛，完整任意故障组合未据此通过。
2. T12的W05观察606秒/48 GET仍保留not_observed；RC04本轮609秒/71次官方GET、17轮poll/66次PR事实，3目标均0新HEAD/0tracking callback，结果not_observed，完整真实链未通过。完整退出要求同一canonical Action及root的H0→H1→H2两次自然HEAD，分别走唯一wake、旧批准失效、逐项修订和独立复审，不写远端制造事件。
3. RC05所列实际index真实供应商故障范围已有分层证据；RC07受控窗口真实SDK自动压缩及精确续接已有证据，默认窗口自然压缩、产品seal、实际index完整原生组合和未知费用/副作用对账仍按范围验收；RC02已交付可选GitHub注册代码，日常未选择注册；RC03已交付`project_manifest_v1`生产端口与结构化hold/SLA恢复合同；通用shell/build未开放，完整真实组合仍按RC04–RC08补验。
4. 实际小流量启用和日常迁移未执行。保留匹配pack与兼容worker；threaded-only drain不允许整库回退，不能删除unknown。
5. RC01确认的hold结构化来源/SLA恢复窗口/命令共享准入和首批工程目录映射已由RC03交付；RC05已补所列停机/SLA组合。RC06新增显式shared_project整工程根read及外部artifactRoot、原isolated兼容与所列分层41组通过；生产源写/merge工具尚未交付，唯一owner/baseVersion仅fixture协议，真正冲突command单次reserve失败仍unknown、无自动持久资源等待重试，legacy实供应商混跑尚未验收。RC06尚未整体验收关闭。本地Session完整policy与根财务/活动预算按适配/增强登记。MEM01语义、Collective和扩展平台/载体保持原范围，K01–K16及59项场景/预期不改。

T12三轮共9实际请求，新增确认27,019 token、未知预留50,748，当时累计153,094（确认63,336/未知89,758），历史报告保留。RC05沿用用户1000万总授权及同一共享账本，显式选择累计50万保守门禁；新增确认1,845、未知预留97,271，RC05结束时确认65,181、未知187,029、保守累计252,210。RC06新增确认5,362、未知预留19,803，RC06结束时累计确认70,543、未知206,832、保守占额277,375，门禁余222,625。原89,758未知及历史账本行保留，新增unknown与SDK持久停止事实交RC09核验，不自动释放或重放。两次真实extended超时根因与T08取消风险仍未定位。RC07新增11个实际请求全部获得已知用量，新增确认116,740＝主入口9,482＋原生受控压缩107,258 token，新增unknown为0；累计确认187,283＋历史未知206,832＝保守占额394,115，累计50万门禁余105,885。原57行账本保持不变，历史未知不因本轮成功释放。准确分层证据见RC05/RC06/RC07报告。


## RC08 当前验收范围

RC08 以已推送 RC07 `6ca44fb` 为基线，实现及所列分层验收完成；原T08取消仍未定位，真实故障组合限制保留，已推送`52d3cc3`。修复征询已结算且callback处于waiting、已无deadline时，resume仅重装timer而不恢复回调的缺口；合并提交通知后先recover再arm，存储失败保留独立1秒重试，observe及已调用close()的协作实例不执行恢复。SDK仅保留可信Authority/Budget/Resource错误类的白名单平台码，拒绝原始错误文本及伪前缀。原 T08 首轮报告未记录可信取消触发原因和准确 Invocation/request 身份，原临时目录只余空目录，不能补造证据。新修复解决本轮可复现问题，不构成历史取消根因已定位；原失败、独立复验与本轮诊断均保留。

23组专验＝协作/持久恢复8＋实际SDK注入5＋实际index注入5＋实际index真实5；相关84组＝collaboration17＋collaboration API4＋collaboration backends4＋backends14＋queue11＋runtime18＋production16，合计107组通过。准确结果见[RC08报告](../reports/threaded-collaboration-rc08-consultation-2026-10-27.md)与[征询验收合同](../architecture/threaded-consultation-acceptance-v1.md)。

| 本轮证据层 | 通过范围与进程 |
| --- | --- |
| [协作与持久恢复](../reports/evidence/threaded-rc08/cooperation-final.json) | 8组、18个worker PID、19次注入HTTP；跨PID精确重试、末答/deadline竞争、settlement/outbox故障与唯一回调、来源ACL、anti-cascade及无deadline的resume自动修复 |
| [实际SDK注入](../reports/evidence/threaded-rc08/sdk.json) | 5组、8个guardian PID、42次注入HTTP；实际MCP/宿主、原答与anti-cascade、可信失败诊断及伪错误文本排除；factory隔离bypass，无真实供应商 |
| [实际index注入](../reports/evidence/threaded-rc08/main-injected-final.json) | 5场景、7个index PID；部分失败、超时重启、暂停回调自动恢复、失权及已提交工具回执精确重试 |
| [实际index真实供应商](../reports/evidence/threaded-rc08/main-live-first.json) | 同5场景、7个index PID；21次真实HTTP，5次原生SDK调用均已核实停止；1次本地400不计远端请求 |

三目标超时场景保留两份原答，第三目标暂停；只有无running Attempt、无sending request且原生进程均verified_stopped后，才用受控时钟跨过原deadline。暂停回调场景由新index PID恢复后，通过认证resume自动派发；失权场景由隔离fixture改permission version后拒绝旧callback。丢回执场景由broker扣留已提交结果，再在同一仍有效Binding内精确重试，不冒充自然网络丢包。T08首轮cancelled仍未定位；多PID末答竞争和outbox故障属于低层factory验收，未与实际index/真实供应商做全交叉。受控时钟跨原deadline、broker扣留已提交工具结果和本地HTTP400均显式注入，不代表自然供应商取消、真实网络丢回执或真实经过3分钟等待。

RC08新增21次真实HTTP，另1次本地HTTP400未发往供应商；新增确认33,195 token、unknown为0。原68行账本未改，截至RC09累计确认220,478＋历史未知206,832＝保守占额427,310，累计50万门禁余72,690；历史unknown不自动释放。RC04 not_observed、RC05未定位超时、RC06工程源写/merge及资源等待缺口、RC07默认窗口自然压缩/产品seal及实际index完整原生组合均继续保留。日常closed、schema35未改，未配置/启用/迁移，本轮按用户指令实施RC11发布准备，日常未发布。

## RC09 当前验收范围

RC09 以已推送 RC08 `52d3cc3` 为基线，实现及所列分层验收完成，历史12项未知仍未收敛且逐项保留处置已登记，RC09已推送`915f106`，见[对账验收合同](../architecture/threaded-reconciliation-acceptance-v1.md)及[RC09报告](../reports/threaded-collaboration-rc09-reconciliation-2026-10-27.md)。本轮处理完整不可变 backend receipt 已提交、后续 budget.settleRequest 未持久成功的恢复窗口，按原 Binding/authorization 幂等补记已存在的可信事实；输出用量、货币费用、进程停止、资源围栏和业务终态分别核验。SDK 仅在原 closed、同宿主且 ps 确认原进程组停止时补记 verified_stopped；registered 缺少原 close 继续保留。修复不重放、不发布旧正文、不自动释放 claim，也不补调 onRequestSettled 改写外部账本；observe 不修复写入。新增24组＝factory恢复9＋预算专项9＋实际index6，相关101组＝backend-runtime7＋backends14＋budget14＋context14＋production16＋queue11＋release7＋runtime18，合计125组通过。factory层16个独立worker PID、4个本地进程组、0次HTTP；预算层10次注入HTTP、1个短命Node进程（非SDK）；实际index层12个PID、2个实际SDK guardian、6次注入HTTP。主入口额外覆盖closed且无发布pack仍修复原账务事实、同时不开放新任务；observe零修复。历史只读盘点不另计验收组，所有层真实供应商请求为0。

[历史只读盘点](../reports/evidence/threaded-rc09/history-ledger-audit.json)已经核对原 89 行：77 known、12 reserved；9 项精确映射原 request/Binding，3 项缺少身份桥接，0 项具有可安全转 known 或退款的完整可信事实。逐轮原 68/57/47/33 行摘要保持一致，本轮 0 次真实供应商请求，未修改共享账本：确认 220,478＋未知预留 206,832＝保守累计 427,310 token，所选累计 50 万门禁余 72,690。不能按金额/先后配对原请求，不能由 SDK 停止推断费用已知。历史项的处置为保留原预留/状态，不恢复未知执行；后续恢复须补齐原身份、可信回执和各域事实。T08 原取消与 RC04–RC08 未完边界继续保留，schema 35、日常 closed 且未配置/迁移，本轮按用户指令实施RC11发布准备，日常发布仍不自动开始。

## RC10 当前验收范围

RC10以已推送RC09 `915f106` 为基线进行综合验收与发布审查。已有[工厂综合链7组](../reports/evidence/threaded-rc10/chain.json)通过：生产factory/broker与真实SQLite/queue/budget/actions/reviews/cooperation接线，API响应和PR事实注入；A公开接力B、B跨Thread征询C/D、暂停未发D的受控deadline、恢复worker提交后SIGKILL及新PID恢复、同Action修订/独立复审、旧generation回调拒绝、权限版本变化、返回原Thread和同causal root预算限制分别留证。目标失败和撤权回调另为两个旁支fixture，不能合称一个真实供应商完整场景。

[旧模式与旁路回归](../reports/evidence/threaded-rc10/regressions/coexistence-summary.json)为52组有明确组数的回归（legacy resources11/runtime18/release7/production16）及3套完整suite（isolation/access/legacy-boundary），全部通过；不把无组数suite的内部变体另算组数。旧HTTP/WS、ACL与旧运行边界的隔离证据不替代完整legacy实供应商混跑。

[逐项发布审查](../reports/evidence/threaded-rc10/acceptance-audit.json)覆盖119行：K16/F12/P14/S12/E6及原59项，保留实现、验证原文、证据引用和分项阻断；原16/59文本及E非状态列不变。文档检查和5个防伪负例不计产品验收组数；审查通过不等于全部59项或完整模式通过。RC04两次自然HEAD仍not_observed；RC06生产源写/merge、冲突command持久等待及完整legacy实供应商混跑缺口，RC07默认自然压缩/产品seal/index完整原生组合，RC08历史取消和真实故障交叉限制全部保留。MEM01语义未交付，整项仍未完成；12笔历史unknown保持明确保留处置，不能自动退款或重放。

[RC10报告](../reports/threaded-collaboration-rc10-release-review-2026-10-27.md)：工厂综合链7组、[实际index最终注入链1组](../reports/evidence/threaded-rc10/main-injected-delivery.json)及其[精确关联审计](../reports/evidence/threaded-rc10/main-injected-delivery-chain-audit.json)通过；真实综合链三次均失败，未计通过。第三次保留真实SDK原答并完成新index恢复与唯一征询回调，但reviewer在同一generation1提交changes_requested后再次approved，没有新HEAD修订和返回原Thread；不能代替两代修订验收。前两次分别为模型隐私参数拒绝、约10秒无响应头的网络失败（活动片未到期，建连超时仅推断）。累计本轮已知74649、保留预留87123，其中3笔可能已发送、1笔明确在测试屏障前未外发仍保留；[诊断](../reports/evidence/threaded-rc10/real-failure-diagnostics-final.json)逐笔留证。原89行未变；最终已知295127＋预留293955＝589082 token，内部累计保护线100万、用户原授权1000万不变。完整发布继续blocked；RC10验收资产与本轮审查已交付，完整退出未通过，已推送`ffcbbca`。

实际index注入最终1组通过，三次真实整链均未通过；注入与真实结果分开登记。初轮实际index注入的preload路径与`/user`请求缺少id为验收fixture错误，失败记录保留，不计通过或生产故障。schema仍35，日常closed、未配置/迁移；RC10阶段未自动进入后续发布；本轮按用户指令实施RC11准备工具与隔离演练，不跳过RC10门槛，不自动进入RC12或启用日常模式。
