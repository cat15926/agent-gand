# 持续协作模式实施状态

状态：**已批准**（T01 设计交付完成；运行实现尚未开始）。更新：2026-10-19。

产品名“持续协作”，内部模式 `threaded`。实施遵守已确认目标：**核心协作规则不做简化，平台差异显式登记，新增可靠性能力单独验收，高级能力逐项说明范围。**本表记录任务进度；已批准的设计不等于功能可用。

## 1 当前交付与基线

| 项目 | 状态与证据 |
| --- | --- |
| 实施路线 | [实施指导](threaded-collaboration-implementation-guide.md)，保留 Issue #16 的 T01–T12 顺序及原验收编号 |
| T01 设计 | [设计决策与接口](threaded-collaboration-t01-decisions.md)：模式、身份、存储、生命周期、资源、会话、控制、预算、领域来源和平台范围已冻结 |
| 合同与能力 | [兼容矩阵](threaded-collaboration-compatibility-matrix.md)：K01–K16、59 项原验收、细化行为、平台差异、E01–E06 独立增强和高级能力范围 |
| 代码接入 | [接入地图](threaded-collaboration-integration-map.md)及[候选检索证据](../reports/evidence/threaded-t01-mode-origin-inventory.json)：全部扫描文件、hash、搜索模式、命中行、职责和局限可复核；不是静态可达性证明 |
| 固定源码 | [基线报告](../reports/threaded-collaboration-t01-baseline-2026-10-19.md)及[来源清单](../reports/evidence/threaded-t01-source-manifest.json)：本地差异、环境、迁移目录、上游定点核验及许可 |
| 本地 HEAD | `b95dc2553405268a9b807b3983fee8f9facc55fa`；相对 Issue 基线 `996513c673498811bed894b3eecf64382e71af3f` 多 1 个提交 |
| Clowder 参考 | `8b373123323aacd7e2047dab94fdc15b8f7567ae`；固定版本，不跟随远端 HEAD |
| 迁移 | 源码已登记 v1–v24；本轮没有新增或应用迁移，未读取业务库，不推断已部署 schema |
| 工作区 | 开始时已有实施指导和 docs/README.md 变更；本轮继续更新这些文档并新增 T01 附件。未修改运行代码，未提交 Git，未回写 Issue |

## 2 T01 退出条件

| 退出条件 | 结果 |
| --- | --- |
| 固定本地、上游、依赖、环境及迁移目录；解释基线变化 | 已完成，保留新 HEAD 的 control_draft 展示规则；源码清单可按固定 URL/hash 复查 |
| Thread、Invocation、Action 分离；明确 Run 与重试 | 已冻结：一 Invocation 对一 Run，多个 Attempt；unknown 不终结或盲重试；Action 独立领域验收 |
| 消息不依赖永久 Run，定义 owner 与版本 | 已冻结：独立 threaded_messages、稳定 instance_owner_id、独立 HTTP/工具/记录版本、前向迁移 |
| 防止旧入口、恢复器、终态及查询误接管 | 已盘点并分配 T02/T03/T06/T09 责任；包括旧 HTTP/WS 派生数据泄漏与无 Binding 放行边界；行为仍待实现验证 |
| 冻结混合资源、Session、取消和 unknown 语义 | 已完成：旧 exclusive 与新 thread-slot 共用竞争；Session 先解析再验证领取；代际不重置；未知外部执行不被异常 cleanup 释放 |
| 核心合同、平台差异、增强、高级范围各自有台账 | 已完成，保留原 K/验收原文；不把范围外或未验证写成支持，不按通过数量计算复刻比例 |
| 后端与领域来源明确 | 首批 API、claude-sdk 0.3.288 与 macOS；平台任务 task_done、GitHub PR 当前 HEAD 的 review_delivered；具体真实适配在 T07/T10/T12 验收 |
| T02–T04 可继续实施 | 已给出接口责任、最小 schema 约束、迁移分配、负向用例和退出条件；真实执行保持关闭 |
| 文档及证据可复核 | 检查结果见第 4 节；所有功能验收仍未通过 |

交叉复核已修正三项设计风险：Session 身份未解析就领取锁、runner 异常后无条件释放未知执行资源、Decision/hold 创建即终止 Invocation。修正后的设计文本复核通过；对应负向用例进入后续任务，尚未执行。

## 3 任务进度

| 任务 | 当前结果 | 下一交付 |
| --- | --- | --- |
| T01 基线、架构决定、合同与能力矩阵 | **设计交付完成** | 后续实现若改变基线，登记依据和验收影响 |
| T02 类型、模式路由、schema 与迁移 | 未开始 | 第 5 节默认关闭的模式骨架 |
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

**功能验证总状态：**运行代码未实现；模拟验收未执行；真实模型未执行；真实业务未执行。原 59 项及 E01–E06 全部待验证，不能把文档或类型检查记入这些功能通过数。

完整语义检索、Collective 特殊隔离、扩展载体、多租户/多机按矩阵单列后续或范围外；普通私密 ACL、核心 Action、基础知识和 SOP 仍在首版目标。MEM01 包含语义检索，基础部分完成时仍不能将整项标为全部通过。Linux 与 WSL 分别待验证，Windows 原生首批范围外。

## 4 本轮验证

| 检查 | 结果与能证明的范围 |
| --- | --- |
| `pnpm typecheck` | 通过（shared、server、web）；只证明未改动的运行代码基线，不证明新模式 |
| 固定源码 hash、Git 差异、迁移 descriptor 清单 | 已核对；不证明部署数据库状态或上游全产品行为 |
| K01–K16、原 59 项逐条比对 | 通过；ID 和原文全部保留，不执行行为 |
| 生产检索清单重现及 hash | 通过；296 个源文件 hash、1,225 条分类命中完全重现；另核对 22 个本地基线文件及 34 个上游引用条目（33 个唯一文件）的 SHA256/Git blob 内容标识。文本候选盘点不等于 AST 或运行覆盖 |
| `pnpm verify:docs` | 通过，全仓文档本地链接有效 |
| `git diff --check` | 通过；另检查全部 8 份未跟踪 T01 文档/证据的行末空白和结尾换行 |

本轮没有启动应用、读写业务库、运行迁移、调用真实模型或发布外部消息。后续行为验证采用隔离 SQLite、可控时钟、fake provider 和并发屏障；不使用日常业务库或 db:reset。

## 5 下一项：T02

输入：[实施指导](threaded-collaboration-implementation-guide.md)、[设计决策](threaded-collaboration-t01-decisions.md)、[接入地图](threaded-collaboration-integration-map.md)、[兼容矩阵](threaded-collaboration-compatibility-matrix.md)和固定证据。开始时复核 HEAD、工作区、依赖及迁移目录；源码有变化先更新受影响接入项。

1. 统一扩展共享 mode/版本类型，收窄旧入口为 LegacyRunMode，逐个处理隐式 fallback；未知 origin/mode 拒绝进入旧编排，不为新模式构造旧 Subject/Batch。
2. 建默认 `closed` 的新准入配置与独立路由；稳定单实例 owner、短期专用访问 session、HTTP/WS 授权和旧读取/广播隔离同步建立，避免仅保护新入口。
3. 建 Thread/Member/Invocation/Attempt/Run binding 最小 schema 与唯一约束。按实施时最新目录分配迁移编号；当前若仍为 v24，则下一号 v25。后续表组按任务新增迁移，不提前注册空能力。
4. 在隔离 SQLite 验证空库、v24 合成历史、重复迁移、失败回滚、未知版本拒绝；旧历史及模式语义不变，不用真实业务库做测试。
5. 验证 closed 无外部调用、预算扣除或工作区副作用，旧 HTTP/WS 无 Threaded 数据旁路；类型检查和受影响旧模式回归通过，更新实际 ID/证据及 T03–T05 输入。

T02 退出门槛为：新模式骨架与迁移已实现、版本/入场/查询边界可验证、DB03 及本阶段 ISO01–ISO03 适用子场景有明确证据；未涵盖的原 ID 继续保留未完成。不得为了让新模式“可演示”而提前接通真实 executor。
