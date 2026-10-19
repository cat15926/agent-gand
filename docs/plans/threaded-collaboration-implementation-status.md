# 持续协作模式实施状态

状态：**实施中**（T01 设计与 T02 基础边界完成；T03–T12 未实施）。更新：2026-10-19。

产品名“持续协作”，内部模式 `threaded`。实施遵守已确认目标：**核心协作规则不做简化，平台差异显式登记，新增可靠性能力单独验收，高级能力逐项说明范围。**本表记录任务进度；已批准的设计不等于功能可用。

## 1 当前交付与基线

| 项目 | 状态与证据 |
| --- | --- |
| 实施路线 | [实施指导](threaded-collaboration-implementation-guide.md)，保留 Issue #16 的 T01–T12 顺序及原验收编号 |
| T01 设计 | [设计决策与接口](threaded-collaboration-t01-decisions.md)：模式、身份、存储、生命周期、资源、会话、控制、预算、领域来源和平台范围已冻结 |
| T02 实现 | [基础架构合同](../architecture/threaded-foundation-v1.md)与[验收报告](../reports/threaded-collaboration-t02-foundation-2026-10-19.md)：类型、关闭策略、身份/认证、旧路径隔离、v25 迁移和最小存储 |
| 合同与能力 | [兼容矩阵](threaded-collaboration-compatibility-matrix.md)：K01–K16、59 项原验收、细化行为、平台差异、E01–E06 独立增强和高级能力范围 |
| 代码接入 | [接入地图](threaded-collaboration-integration-map.md)及[候选检索证据](../reports/evidence/threaded-t01-mode-origin-inventory.json)：全部扫描文件、hash、搜索模式、命中行、职责和局限可复核；不是静态可达性证明 |
| 固定源码 | [基线报告](../reports/threaded-collaboration-t01-baseline-2026-10-19.md)及[来源清单](../reports/evidence/threaded-t01-source-manifest.json)：本地差异、环境、迁移目录、上游定点核验及许可 |
| 本地底座 | T01 固定代码 `b95dc2553405268a9b807b3983fee8f9facc55fa`；T01 文档提交 `0a2f1b4` 已推送 origin/main；T02 在此基础上实施 |
| Clowder 参考 | `8b373123323aacd7e2047dab94fdc15b8f7567ae`；固定版本，不跟随远端 HEAD |
| 迁移 | 新增 v25，隔离 SQLite 验证通过；未读取/迁移日常业务库，不推断已部署 schema |
| 工作区 | T01 已提交推送；T02 运行代码、测试与文档留在工作区，未提交/推送 T02，未回写 Issue |

## 2 T01 退出条件

| 退出条件 | 结果 |
| --- | --- |
| 固定本地、上游、依赖、环境及迁移目录；解释基线变化 | 已完成，保留新 HEAD 的 control_draft 展示规则；源码清单可按固定 URL/hash 复查 |
| Thread、Invocation、Action 分离；明确 Run 与重试 | 已冻结：一 Invocation 对一 Run，多个 Attempt；unknown 不终结或盲重试；Action 独立领域验收 |
| 消息不依赖永久 Run，定义 owner 与版本 | 已冻结：独立 threaded_messages、稳定 instance_owner_id、独立 HTTP/工具/记录版本、前向迁移 |
| 防止旧入口、恢复器、终态及查询误接管 | T01 已分配责任；T02 的旧路径拒绝/跳过及 HTTP/WS 隔离已验证，生产新执行仍待 T03/T06 |
| 冻结混合资源、Session、取消和 unknown 语义 | 已完成：旧 exclusive 与新 thread-slot 共用竞争；Session 先解析再验证领取；代际不重置；未知外部执行不被异常 cleanup 释放 |
| 核心合同、平台差异、增强、高级范围各自有台账 | 已完成，保留原 K/验收原文；不把范围外或未验证写成支持，不按通过数量计算复刻比例 |
| 后端与领域来源明确 | 首批 API、claude-sdk 0.3.288 与 macOS；平台任务 task_done、GitHub PR 当前 HEAD 的 review_delivered；具体真实适配在 T07/T10/T12 验收 |
| T02–T04 可继续实施 | 已给出接口责任、最小 schema 约束、迁移分配、负向用例和退出条件；真实执行保持关闭 |
| 文档及证据可复核 | T01 固定证据保留为历史基线；T02 实际变更及验证另记报告 |

交叉复核已修正三项设计风险：Session 身份未解析就领取锁、runner 异常后无条件释放未知执行资源、Decision/hold 创建即终止 Invocation。修正后的设计文本复核通过；对应负向用例进入后续任务，尚未执行。

## 3 任务进度

| 任务 | 当前结果 | 下一交付 |
| --- | --- | --- |
| T01 基线、架构决定、合同与能力矩阵 | **设计交付完成** | 后续实现若改变基线，登记依据和验收影响 |
| T02 类型、模式路由、schema 与迁移 | **实现及隔离验证完成** | 默认 closed；observe/execute 也不可执行；下一步 T03 |
| T03 Binding、Run adapter、权限 | 未开始 | 可信执行、生命周期与终态，fake executor |
| T04 混合资源、共享容量、公平性 | 未开始 | 全模式资源竞争、真实 Session 锁、代际和释放通知 |
| T05 消息、ACL、Delivery、Wake、Outbox | 未开始 | 消息持久接收与幂等投递事务 |
| T06 队列、Invocation、响应提交、恢复 | 未开始 | 可恢复最小闭环及故障窗口证据 |
| T07 上下文、游标、Session、后端 | 未开始 | API 与 SDK 分别验证上下文和会话 |
| T08 路由、工具、等待、持久征询 | 未开始 | 全部核心协作行为与独立增强用例 |
| T09 UI、回执、重连、状态面板 | 未开始 | 鉴权快照/事件、六类进度、实际控制状态 |
| T10 Action、完成谓词、替换/返回 | 未开始 | 真实领域 producer/resolver/freshness 闭环 |
| T11 Review/Revision、SOP、共享记忆 | 未开始 | 版本化评审与修订、SOP CAS、基础知识/ACL |
| T12 综合验收、兼容、发布与回滚 | 未开始 | 按实际后端/平台/领域范围收口证据 |

**功能验证总状态：**T02 骨架已实现并通过隔离 fixture；DB03 的 v25 范围通过，ISO01–ISO03、CTX02/UI01 仅所列基础边界子场景通过；完整验收仍待后续任务。真实模型和真实业务未执行，E01–E06 未验证，不能把基础测试计为全部 59 项通过。

完整语义检索、Collective 特殊隔离、扩展载体、多租户/多机按矩阵单列后续或范围外；普通私密 ACL、核心 Action、基础知识和 SOP 仍在首版目标。MEM01 包含语义检索，基础部分完成时仍不能将整项标为全部通过。Linux 与 WSL 分别待验证，Windows 原生首批范围外。

## 4 验证记录

| 检查 | 结果与能证明的范围 |
| --- | --- |
| `pnpm typecheck` | T02 后通过（shared、server、web） |
| 固定源码 hash、Git 差异、迁移 descriptor 清单 | 已核对；不证明部署数据库状态或上游全产品行为 |
| K01–K16、原 59 项逐条比对 | 通过；ID 和原文全部保留，不执行行为 |
| T01 生产检索清单重现及 hash | T01 时通过；296 个源文件 hash、1,225 条分类命中完全重现；22 个本地基线文件及 34 个上游引用条目（33 个唯一文件）已核对。T02 改动后不再把旧 hash 当当前源码保证 |
| `pnpm verify:threaded-migration` | 通过，7 组迁移/版本/owner/绑定约束场景 |
| `pnpm verify:threaded-isolation` | 通过，6 组新模式/未知/错配 fixture；恢复无写入，零 executor/callback；旧三模式正向终态通过 |
| `pnpm verify:threaded-access` | 通过，管理桥接、专用会话/CSRF、owner、版本、HTTP/WS、注销/过期和关闭入场 |
| `pnpm verify:threaded-legacy-boundary` | 通过，旧 HTTP/WS 列表/派生 ID/写入前隔离，既有记录仍可用，零外部调用 |
| 旧运行策略、终态、动作命令及前端构建 | 通过，具体命令与边界见 T02 报告；构建存在非阻断的 chunk 大小提示 |
| `pnpm verify:docs` | 通过，全仓文档本地链接有效 |
| `git diff --check` | 通过；新增未跟踪文件另检查行末空白 |

T02 只在隔离 SQLite 和注入式 Fastify fixture 中验证，没有启动日常服务、读写业务库、调用真实模型或发布外部消息。后续继续使用隔离数据库、可控时钟、fake provider 和并发屏障。

## 5 下一项：T03

输入：T02 代码、[基础架构合同](../architecture/threaded-foundation-v1.md)、[设计决策](threaded-collaboration-t01-decisions.md)、[接入地图](threaded-collaboration-integration-map.md)、[兼容矩阵](threaded-collaboration-compatibility-matrix.md)和实际报告。开始时复核 HEAD、工作区、依赖及迁移目录；新字段使用 v25 之后的迁移，不改写已交付历史 descriptor。

1. 从服务端持久事实生成可信 ThreadedBinding，运行前/工具前/提交前复查 owner、当前 Attempt、authorityEpoch 与资源代际；不能将类型存在当授权。
2. 实现一个 Invocation 对一个 Run 的 adapter；重试保留 Run 并新增 Attempt，unknown 不伪造终态。保留旧 guard，只有明确的新端口可执行新模式。
3. 专用 lifecycle 覆盖审批、暂停、停止、账号撤销与恢复；终态证明在事务内提交，不能借旧 finishRun/Completion Evaluation 绕过账本。
4. fake executor 验证无绑定拒绝、旧回调无效、Attempt 重试不终结 Run、异常但外部仍存活时不释放围栏；与 T04 的 claim 协议联调。
5. 保持真实执行关闭，运行相关旧模式回归和 ISO02–ISO05 子场景，更新后续 T04/T05/T06 的接口与缺口。

T03 退出门槛为：新执行和控制端口有独立可信授权、Invocation/Attempt/Run 关系与终态原子性可验证、fake 调用计数和拒绝边界有证据；不伪造旧完成输入，也不提前开放真实 executor。
