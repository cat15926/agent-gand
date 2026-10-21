# 持续协作模式实施状态

状态：**实施中**（T01–T11 已实现并通过所列分层验收；T12 未实施）。更新：2026-10-21。

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
| 合同与能力 | [兼容矩阵](threaded-collaboration-compatibility-matrix.md)：K01–K16、59 项原验收、细化行为、平台差异、E01–E06 独立增强和高级能力范围 |
| 代码接入 | [接入地图](threaded-collaboration-integration-map.md)及[候选检索证据](../reports/evidence/threaded-t01-mode-origin-inventory.json)：全部扫描文件、hash、搜索模式、命中行、职责和局限可复核；不是静态可达性证明 |
| 固定源码 | [基线报告](../reports/threaded-collaboration-t01-baseline-2026-10-19.md)及[来源清单](../reports/evidence/threaded-t01-source-manifest.json)：本地差异、环境、迁移目录、上游定点核验及许可 |
| 本地底座 | T01 固定代码 `b95dc2553405268a9b807b3983fee8f9facc55fa`；T01 文档 `0a2f1b4`、T02 基础 `5298a9d`、T03 `c3b36db`、T04 `12d99e6`、T05 `98b331f`、T06 `79bad41`、T07 `a773698`、T08 `606a8c0`、T09 `72efefd`、T10 `c944c9d` 已推送 origin/main；T11在此基础上实施 |
| Clowder 参考 | `8b373123323aacd7e2047dab94fdc15b8f7567ae`；固定版本，不跟随远端 HEAD |
| 迁移 | 已交付 v25–v33，v25–v32 源码与 descriptor 不变；冻结实际 v32 升级 v33、失败回滚和旧 worker 拒绝新版本通过。未迁移日常业务库，不推断已部署 schema |
| 交付 | T01–T10 已提交推送；T11代码、测试、分层证据及文档已完成，尚未提交推送；未回写 Issue |
| 真实验收边界 | macOS 上选定同一账号的 Anthropic 兼容 API 与 claude-sdk 0.3.288 合成上下文验收通过；不代表全部配置账号/供应商均已验证。只读业务库账号/凭据元数据并在隔离库执行，不读取日常会话。用户授权总 input+output 上限 1000 万 token，本轮累计硬门禁 20 万；实际用量与未知预留见 T08 报告：累计75,327含39,010旧未知预留 |

## 2 T01 退出条件

| 退出条件 | 结果 |
| --- | --- |
| 固定本地、上游、依赖、环境及迁移目录；解释基线变化 | 已完成，保留新 HEAD 的 control_draft 展示规则；源码清单可按固定 URL/hash 复查 |
| Thread、Invocation、Action 分离；明确 Run 与重试 | 已冻结：一 Invocation 对一 Run，多个 Attempt；unknown 不终结或盲重试；Action 独立领域验收 |
| 消息不依赖永久 Run，定义 owner 与版本 | 已冻结：独立 threaded_messages、稳定 instance_owner_id、独立 HTTP/工具/记录版本、前向迁移 |
| 防止旧入口、恢复器、终态及查询误接管 | T01 已分配责任；T02 的旧路径拒绝/跳过及 HTTP/WS 隔离已验证，T03 专用执行/控制端口、T04 资源、T06 调度与 T07 隔离真实后端已接；生产 executor 与工作入场继续关闭 |
| 冻结混合资源、Session、取消和 unknown 语义 | 已完成：旧 exclusive 与新 thread-slot 共用竞争；Session 先解析再验证领取；代际不重置；未知外部执行不被异常 cleanup 释放 |
| 核心合同、平台差异、增强、高级范围各自有台账 | 已完成，保留原 K/验收原文；不把范围外或未验证写成支持，不按通过数量计算复刻比例 |
| 后端与领域来源明确 | API、claude-sdk 0.3.288 在 macOS 的 T07 所列真实后端范围通过；T10已接平台任务和真实GitHub当前HEAD/本地review交付；真实模型与全部业务故障组合仍待T12 |
| T02–T04 可继续实施 | 已给出接口责任、最小 schema 约束、迁移分配、负向用例和退出条件；真实执行保持关闭 |
| 文档及证据可复核 | T01 固定证据保留为历史基线；T02 实际变更及验证另记报告 |

交叉复核已修正三项设计风险：Session 身份未解析就领取锁、runner 异常后无条件释放未知执行资源、Decision/hold 创建即终止 Invocation。未知进程与生命周期部分已由 T03 fake 验证，T04 已增加持久资源及 Session 身份准备，T07 已完成所列真实后端验收；非阻塞工具与等待已由 T08 独立验证，T10命令/Action代际已有独立验证，实际OS命令执行器仍待T12。

## 3 任务进度

| 任务 | 当前结果 | 下一交付 |
| --- | --- | --- |
| T01 基线、架构决定、合同与能力矩阵 | **设计交付完成** | 后续实现若改变基线，登记依据和验收影响 |
| T02 类型、模式路由、schema 与迁移 | **实现及隔离验证完成** | 默认 closed；observe/execute 也不可执行 |
| T03 Binding、Run adapter、权限 | **实现及隔离验证完成** | 已接 T04 资源、T05/T06 消息调度与 T07 隔离真实后端；生产入场关闭 |
| T04 混合资源、共享容量、公平性 | **实现及隔离验证完成** | 持久资源、旧模式桥、T06 Wake drain 与 T07 后端证据已接 |
| T05 消息、ACL、Delivery、Wake、Outbox | **实现及隔离验证完成** | 生产历史读取、内部提示、T06 响应终态与 T07 实际上下文投递已接 |
| T06 队列、Invocation、响应提交、恢复 | **实现及隔离验证完成，已推送** | 确定性最小闭环、预算与故障窗口通过；生产 dispatch 关闭 |
| T07 上下文、游标、Session、后端 | **实现及所列隔离/真实验证完成** | API 重建、SDK 冷开/续接、运行时及 SQLite 重建恢复、权限变化冷开、取消 unknown；下一项 T10 |
| T08 路由、工具、等待、持久征询 | **实现及所列分层验证完成，已推送606a8c0** | 17/4/4组及E01–E06独立证据；真实API/SDK工具与双成员征询复验通过；领域依赖留T10，下一项T10 |
| T09 UI、回执、重连、状态面板 | **实现及所列隔离浏览器验证完成，已推送72efefd** | 4组同步/4组投影HTTP/11组Chrome；刷新/断线/实际HTTP进程SIGKILL与新SQLite连接恢复通过，业务发布待后续 |
| T10 Action、完成谓词、替换/返回 | **实现及所列分层验收完成，已推送c944c9d** | 12组Action/多进程/故障；真实平台任务和GitHub只读域通过；新远端事件及实际OS执行器完整验收留T12 |
| T11 Review/Revision、SOP、共享记忆 | **实现及所列分层验收完成，尚未提交** | 9组Review、6组SOP、8组知识、15组实际Chrome；22次真实GitHub GET，仅本地评审交付，无新增模型token；语义检索仍未实现 |
| T12 综合验收、兼容、发布与回滚 | 未开始 | 按实际后端/平台/领域范围收口证据 |

**功能验证总状态：**T02–T11 已实现并通过所列隔离 fixture；DB03 的 v25–v33 范围通过。T06 的 Wake/Invocation、共享资源/预算领取、响应/Run/Outbox 事务与控制恢复已接 T07 实际上下文投递。macOS 上 API 两次请求的重建与私密排除、SDK 冷开/原生续接/权限变化冷开及取消 unknown 验证通过。SDK 补验在同一验收进程中关闭旧数据库连接，重新创建 runtime、SQLite 连接和资源 owner，再从持久锚点恢复同 nativeId 与记忆；每次 Invocation 启动独立 SDK worker，恢复自身不发送请求，见[补验证据](../reports/evidence/threaded-t07-real-sdk-reopen.json)。这不构成整个主服务进程 kill/restart 的验收。

生产仍只有历史读取、内部提示和无 executor 的恢复，`closed`、`observe`、`execute` 均不放行新工作；真实生产业务闭环未执行，T10隔离平台任务及获权GitHub只读领域已验。T08 工具、等待与 E01–E06 征询增强已独立验证，见[T08 报告](../reports/threaded-collaboration-t08-tools-waits-2026-10-21.md)；真实工具成功，征询首轮取消保留失败、新场景复验通过，根因未定位。T09独立UI、授权快照和实际隔离HTTP进程重启已验证，见[T09报告](../reports/threaded-collaboration-t09-ui-2026-10-21.md)；T11已实现并完成所列分层验证，T12未实施，不能把现有结果计为全部59项通过。

真实 SDK 短会话未触发自动压缩；压缩事件、摘要来源与 seal 目前只有确定性证据。完整主服务退出/启动、其他供应商/驱动与实际平台组合仍按 T12 和矩阵逐项验收。

完整语义检索、Collective 特殊隔离、扩展载体、多租户/多机按矩阵单列后续或范围外；普通私密 ACL、核心 Action、基础知识和 SOP 仍在首版目标。MEM01 包含语义检索，基础部分完成时仍不能将整项标为全部通过。Linux 与 WSL 分别待验证，Windows 原生首批范围外。

## 4 验证记录

| 检查 | 结果与能证明的范围 |
| --- | --- |
| `pnpm typecheck` | T11后通过（shared、server、web） |
| 固定源码 hash、Git 差异、迁移 descriptor 清单 | 已核对；不证明部署数据库状态或上游全产品行为 |
| K01–K16、原 59 项逐条比对 | 通过；ID 和原文全部保留，不执行行为 |
| T01 生产检索清单重现及 hash | T01 时通过；296 个源文件 hash、1,225 条分类命中完全重现；22 个本地基线文件及 34 个上游引用条目（33 个唯一文件）已核对。T02 改动后不再把旧 hash 当当前源码保证 |
| `pnpm verify:threaded-migration` | 通过16组，冻结实际 `c944c9d` v32 升v33、完整失败回滚、旧消息hash重试及旧guard拒写 |
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
| 旧运行策略、终态、动作命令及前端构建 | T02 已通过；T04 重跑运行策略、动作命令、终态、持久等待恢复及旧原生/双账户隔离回归，均通过。前端未改，无需重跑 T02 构建 |
| `pnpm verify:threaded-view` / `verify:threaded-view-api` | 各4组通过：客户端epoch/隐私清空、只读投影/当前ACL/精确回执/有界事件回放、认证与WS失效 |
| `pnpm verify:threaded-ui` | 11组真实Chrome，本机临时库；路由CAS、丢回执重试、离线隐私清空、实际HTTP子进程SIGKILL/重启和桌面/手机截图 |
| T09构建/旧聊天UI | Web build通过；既有message-presentation真实Chrome五组通过、零supplier请求 |
| `pnpm verify:docs` | 通过，全仓文档本地链接有效 |
| `git diff --check` | 通过；新增未跟踪文件另检查行末空白 |

T02–T06 只在隔离 SQLite、注入式 Fastify、fake provider/executor 和受控子进程 fixture 中验证。T07 在用户授权后首次只读业务库的选定账号、配置及加密凭据记录，用隔离数据库、独立 SDK 配置目录和新建合成上下文执行真实模型验收；未迁移业务库、未读取日常会话、未启用生产新模式。外发内容限定为合成验收消息及其隔离历史。实际用量、未知占额和累计门禁续记于 T08 报告，隔离证据与真实后端证据分别登记。

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

## 5 下一项：T12

输入：已推送T10 `c944c9d`、当前T11工作区、[工作流合同](../architecture/threaded-workflows-v1.md)及[报告](../reports/threaded-collaboration-t11-workflows-2026-10-21.md)、T01冻结的首版目标和兼容矩阵。开始时检查HEAD、工作区及迁移，不改历史descriptor。

1. 按实际支持的后端、平台和领域组合收口集成证据；包含真实PR等待中新HEAD、具体OS命令、主服务/真实模型完整故障组合。
2. 保留普通A2A与责任授权、可见受众、因果根预算及私密来源闭包；每个未验证组合明确登记。
3. 复核生产入口/executor接线、迁移/版本不兼容拒绝、可回滚发布步骤，完成具体审阅结果后再处理发布。
4. 语义检索、Collective、多租户/多机及扩展载体逐项保留范围；MEM01整体不能标全过。

T11新增模型token为0，累计占额仍75,327（含未知预留39,010）；T11成功真实GitHub验收22 GET、远端写0。生产入口/executor继续关闭，T08首次征询取消未定位风险保留。
