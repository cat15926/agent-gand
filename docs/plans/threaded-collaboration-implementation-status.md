# 持续协作模式实施状态

状态：**实施中**（T01–T04 交付完成；T05–T12 未实施）。更新：2026-10-20。

产品名“持续协作”，内部模式 `threaded`。实施遵守已确认目标：**核心协作规则不做简化，平台差异显式登记，新增可靠性能力单独验收，高级能力逐项说明范围。**本表记录任务进度；已批准的设计不等于功能可用。

## 1 当前交付与基线

| 项目 | 状态与证据 |
| --- | --- |
| 实施路线 | [实施指导](threaded-collaboration-implementation-guide.md)，保留 Issue #16 的 T01–T12 顺序及原验收编号 |
| T01 设计 | [设计决策与接口](threaded-collaboration-t01-decisions.md)：模式、身份、存储、生命周期、资源、会话、控制、预算、领域来源和平台范围已冻结 |
| T02 实现 | [基础架构合同](../architecture/threaded-foundation-v1.md)与[验收报告](../reports/threaded-collaboration-t02-foundation-2026-10-19.md)：类型、关闭策略、身份/认证、旧路径隔离、v25 迁移和最小存储 |
| T03 实现 | [执行边界合同](../architecture/threaded-execution-boundary-v1.md)与[验收报告](../reports/threaded-collaboration-t03-execution-2026-10-20.md)：可信 Binding、首次 Run/Attempt 原子适配、专用控制/审批/撤权/恢复，fake executor 与 v26 |
| T04 实现 | [共享资源合同](../architecture/threaded-resources-v1.md)与[验收报告](../reports/threaded-collaboration-t04-resources-2026-10-20.md)：持久资源、公平竞争、共享容量、Session CAS、unknown 围栏、旧模式兼容桥与 v27 |
| 合同与能力 | [兼容矩阵](threaded-collaboration-compatibility-matrix.md)：K01–K16、59 项原验收、细化行为、平台差异、E01–E06 独立增强和高级能力范围 |
| 代码接入 | [接入地图](threaded-collaboration-integration-map.md)及[候选检索证据](../reports/evidence/threaded-t01-mode-origin-inventory.json)：全部扫描文件、hash、搜索模式、命中行、职责和局限可复核；不是静态可达性证明 |
| 固定源码 | [基线报告](../reports/threaded-collaboration-t01-baseline-2026-10-19.md)及[来源清单](../reports/evidence/threaded-t01-source-manifest.json)：本地差异、环境、迁移目录、上游定点核验及许可 |
| 本地底座 | T01 固定代码 `b95dc2553405268a9b807b3983fee8f9facc55fa`；T01 文档 `0a2f1b4`、T02 基础 `5298a9d` 已推送 origin/main；T03 `c3b36db` 也已推送 origin/main；T04 在此基础上实施 |
| Clowder 参考 | `8b373123323aacd7e2047dab94fdc15b8f7567ae`；固定版本，不跟随远端 HEAD |
| 迁移 | 已交付 v25/v26/v27，隔离 SQLite 验证通过；未读取/迁移日常业务库，不推断已部署 schema |
| 工作区 | T01–T03 已提交推送；T04 运行代码、测试与文档留在工作区，未提交/推送 T04，未回写 Issue |

## 2 T01 退出条件

| 退出条件 | 结果 |
| --- | --- |
| 固定本地、上游、依赖、环境及迁移目录；解释基线变化 | 已完成，保留新 HEAD 的 control_draft 展示规则；源码清单可按固定 URL/hash 复查 |
| Thread、Invocation、Action 分离；明确 Run 与重试 | 已冻结：一 Invocation 对一 Run，多个 Attempt；unknown 不终结或盲重试；Action 独立领域验收 |
| 消息不依赖永久 Run，定义 owner 与版本 | 已冻结：独立 threaded_messages、稳定 instance_owner_id、独立 HTTP/工具/记录版本、前向迁移 |
| 防止旧入口、恢复器、终态及查询误接管 | T01 已分配责任；T02 的旧路径拒绝/跳过及 HTTP/WS 隔离已验证，T03 专用执行/控制端口已交付，持久资源已接 T04，真实执行仍待 T06/T07 |
| 冻结混合资源、Session、取消和 unknown 语义 | 已完成：旧 exclusive 与新 thread-slot 共用竞争；Session 先解析再验证领取；代际不重置；未知外部执行不被异常 cleanup 释放 |
| 核心合同、平台差异、增强、高级范围各自有台账 | 已完成，保留原 K/验收原文；不把范围外或未验证写成支持，不按通过数量计算复刻比例 |
| 后端与领域来源明确 | 首批 API、claude-sdk 0.3.288 与 macOS；平台任务 task_done、GitHub PR 当前 HEAD 的 review_delivered；具体真实适配在 T07/T10/T12 验收 |
| T02–T04 可继续实施 | 已给出接口责任、最小 schema 约束、迁移分配、负向用例和退出条件；真实执行保持关闭 |
| 文档及证据可复核 | T01 固定证据保留为历史基线；T02 实际变更及验证另记报告 |

交叉复核已修正三项设计风险：Session 身份未解析就领取锁、runner 异常后无条件释放未知执行资源、Decision/hold 创建即终止 Invocation。修正后的设计文本复核通过；未知进程与生命周期部分已由 T03 fake 验证，T04 已增加持久资源及 Session 身份准备，真实后端和非阻塞工具仍待后续任务。

## 3 任务进度

| 任务 | 当前结果 | 下一交付 |
| --- | --- | --- |
| T01 基线、架构决定、合同与能力矩阵 | **设计交付完成** | 后续实现若改变基线，登记依据和验收影响 |
| T02 类型、模式路由、schema 与迁移 | **实现及隔离验证完成** | 默认 closed；observe/execute 也不可执行 |
| T03 Binding、Run adapter、权限 | **实现及隔离验证完成** | 资源已接 T04；消息/Outbox 与调度接入 T05/T06；真实后端 T07 |
| T04 混合资源、共享容量、公平性 | **实现及隔离验证完成** | 持久资源与旧模式桥已接；Wake drain 待 T06，真实后端待 T07 |
| T05 消息、ACL、Delivery、Wake、Outbox | 未开始 | 消息持久接收与幂等投递事务 |
| T06 队列、Invocation、响应提交、恢复 | 未开始 | 可恢复最小闭环及故障窗口证据 |
| T07 上下文、游标、Session、后端 | 未开始 | API 与 SDK 分别验证上下文和会话 |
| T08 路由、工具、等待、持久征询 | 未开始 | 全部核心协作行为与独立增强用例 |
| T09 UI、回执、重连、状态面板 | 未开始 | 鉴权快照/事件、六类进度、实际控制状态 |
| T10 Action、完成谓词、替换/返回 | 未开始 | 真实领域 producer/resolver/freshness 闭环 |
| T11 Review/Revision、SOP、共享记忆 | 未开始 | 版本化评审与修订、SOP CAS、基础知识/ACL |
| T12 综合验收、兼容、发布与回滚 | 未开始 | 按实际后端/平台/领域范围收口证据 |

**功能验证总状态：**T02–T04 已实现并通过隔离 fixture；DB03 的 v25–v27 范围通过，ISO02–ISO05 增加授权/适配/控制与输出终态子场景，ISO01、CTX02/UI01 保留基础边界结果。T04 已增加 Q01–Q06 的持久资源子场景和旧模式兼容桥；消息/Outbox、Wake 调度与真实后端尚未接入，完整验收仍待后续任务。真实模型和真实业务未执行，E01–E06 未验证，不能把基础测试计为全部 59 项通过。

完整语义检索、Collective 特殊隔离、扩展载体、多租户/多机按矩阵单列后续或范围外；普通私密 ACL、核心 Action、基础知识和 SOP 仍在首版目标。MEM01 包含语义检索，基础部分完成时仍不能将整项标为全部通过。Linux 与 WSL 分别待验证，Windows 原生首批范围外。

## 4 验证记录

| 检查 | 结果与能证明的范围 |
| --- | --- |
| `pnpm typecheck` | T04 后通过（shared、server、web） |
| 固定源码 hash、Git 差异、迁移 descriptor 清单 | 已核对；不证明部署数据库状态或上游全产品行为 |
| K01–K16、原 59 项逐条比对 | 通过；ID 和原文全部保留，不执行行为 |
| T01 生产检索清单重现及 hash | T01 时通过；296 个源文件 hash、1,225 条分类命中完全重现；22 个本地基线文件及 34 个上游引用条目（33 个唯一文件）已核对。T02 改动后不再把旧 hash 当当前源码保证 |
| `pnpm verify:threaded-migration` | 通过，10 组迁移/版本/owner/绑定约束场景，含冻结 v25/v26 拒绝后继版本 |
| `pnpm verify:threaded-isolation` | 通过，6 组新模式/未知/错配 fixture；恢复无写入，零 executor/callback；旧三模式正向终态通过 |
| `pnpm verify:threaded-access` | 通过，管理桥接、专用会话/CSRF、owner、版本、HTTP/WS、注销/过期和关闭入场 |
| `pnpm verify:threaded-legacy-boundary` | 通过，旧 HTTP/WS 列表/派生 ID/写入前隔离，既有记录仍可用，零外部调用 |
| `pnpm verify:threaded-lifecycle` | 通过，21 组；可信 Binding、Run/Attempt、unknown、审批、终态故障、控制和资源释放的 fake 验证；完整范围见 T03 报告 |
| `pnpm verify:threaded-controls` | 通过；专用 HTTP、作用域/CSRF/幂等、真实账户撤销事务与回滚、生产恢复入口 |
| `pnpm verify:threaded-resources` | 通过；19 组真实多连接/多进程 SQLite 竞争、公平性、实际 nativeId 锁、全资源事务、容量、proof/epoch 与主动通知 |
| `pnpm verify:threaded-resource-integration` | 通过；8 组真实 Session CAS、目录变更、领取与 Attempt 同事务、unknown 与意外 nativeId |
| `pnpm verify:legacy-resources` | 通过；11 组临时库生产单例与旧调用桥，具体范围见 T04 报告 |
| 旧运行策略、终态、动作命令及前端构建 | T02 已通过；T04 重跑运行策略、动作命令、终态、持久等待恢复及旧原生/双账户隔离回归，均通过。前端未改，无需重跑 T02 构建 |
| `pnpm verify:docs` | 通过，全仓文档本地链接有效 |
| `git diff --check` | 通过；新增未跟踪文件另检查行末空白 |

T02–T04 只在隔离 SQLite、注入式 Fastify、fake provider/executor 和受控子进程 fixture 中验证，没有启动日常服务、读写业务库、调用真实模型或发布外部消息。后续继续使用隔离数据库、可控时钟、fake provider 和并发屏障。

## 5 下一项：T05

输入：已推送的 T03 `c3b36db`、工作区 T04、[共享资源合同](../architecture/threaded-resources-v1.md)、[设计决策](threaded-collaboration-t01-decisions.md)与[兼容矩阵](threaded-collaboration-compatibility-matrix.md)。开始时复核 HEAD、工作区和迁移目录；新字段追加 v27 之后的版本，不改写既有 descriptor。

1. 建立独立 Threaded 消息、origin、ACL、Delivery、Wake 与 Outbox 记录，消息不依赖永久 Run。
2. 用户请求幂等键与 payload/目标/ACL 的冲突校验，同一事务提交消息及必要逻辑工作。
3. HTTP/MCP 后续工具只接受获权身份；私密正文、附件、搜索与精确 ID 查询遵守同一边界。
4. 确定性验证 DB01/DB02、M01–M03 与持久消息/通知故障窗口，保留原验收编号及预期。
5. T06 消费 T03–T05，补 Wake drain、Invocation/响应提交与恢复闭环；T07 才接真实后端。

T04 的资源证明不等于消息交付、根预算、真实 SDK Session 或端到端恢复通过。新模式工作入场继续关闭。
