# agent-gand 文档中心

本目录按文档的**职责和生命周期**分类。仓库根目录只保留项目入口与 Agent 运行约定；产品、架构、计划、调研和报告统一放在这里。

## 目录与归属

| 目录 | 负责回答的问题 | 应包含 | 不应包含 |
|---|---|---|---|
| [`requirements/`](./requirements/) | 为什么做、用户需要什么 | 需求调研、产品目标、范围、用户场景、优先级 | 具体代码设计、阶段性测试结论 |
| [`architecture/`](./architecture/) | 当前系统如何工作、必须遵守什么契约 | 权威架构、协议、数据模型、跨模块约束、架构概览 | 尚未批准的未来方案、竞品调研 |
| [`plans/`](./plans/) | 接下来如何实施 | 实施计划、迁移方案、路线图、验收标准 | 已发生问题的证据报告、当前架构真相 |
| [`research/`](./research/) | 外部项目或技术提供了什么参考 | 竞品调研、源码研究、方案比较、引用来源 | agent-gand 的最终设计决策 |
| [`reports/`](./reports/) | 某次检查或测试发现了什么 | 测试报告、差距分析、架构评估、问题证据 | 规范性架构契约、没有证据的设想 |
| [`prototypes/`](./prototypes/) | 计划中的交互如何操作 | 无真实副作用的评审原型、模拟用户旅程 | 已实现功能宣告、真实账户与业务调用 |

## 当前索引

### 需求基线

- [多 Agent 协作工具平台需求调研](./requirements/multi-agent-platform-requirements-research.md)

### 架构与协议

- [持续协作 T05：消息、授权与持久通知 v1](./architecture/threaded-messaging-v1.md)
- [持续协作 T04：共享资源与 Session 围栏 v1](./architecture/threaded-resources-v1.md)
- [持续协作 T03：可信执行与生命周期边界 v1（真实执行关闭）](./architecture/threaded-execution-boundary-v1.md)
- [持续协作 T02：模式、身份与存储基础 v1（执行关闭）](./architecture/threaded-foundation-v1.md)
- [自主协作 AC1：任务契约、授权派生与根预算](./architecture/autonomous-task-authority-v1.md)
- [自主协作 AC4：普通入口、同任务补充与持久暂停](./architecture/autonomous-default-entry-v1.md)
- [自主协作 AC5：可校验多轮流程与自动规则公告](./architecture/autonomous-validated-flows-v1.md)
- [自主协作 AC6：托管 SDK、房间准入与排空](./architecture/autonomous-managed-sdk-rollout-v1.md)
- [自主协作 AC3：自动收集、合法交付与必要决策](./architecture/autonomous-result-delivery-v1.md)
- [自主协作 AC2：动态委派、独立上下文与依赖唤醒](./architecture/autonomous-dynamic-delegation-v1.md)
- [P0 权威架构规格](./architecture/scaffold-plan.md)
- [工程架构概览](./architecture/engineering-overview.md)
- [Collaboration 运行架构](./architecture/collaboration-runtime.md)
- [统一观测协议 v1](./architecture/observability-protocol-v1.md)
- [外部 Code Agent 阶段 A：架构与使用](./architecture/external-code-agent-phase-a.md)
- [外部 Code Agent 阶段 B：双向执行、审批与使用](./architecture/external-code-agent-phase-b.md)
- [外部 Code Agent 阶段 C：Runtime 协作控制与 MCP](./architecture/external-code-agent-phase-c.md)
- [外部 Code Agent 阶段 D：持久恢复、编码隔离与会话](./architecture/external-code-agent-phase-d.md)
- [账户与密钥阶段 E1：架构与使用](./architecture/accounts-and-keys-phase-e1.md)
- [账户与密钥阶段 E2：逐账户调用与原生登录](./architecture/accounts-and-keys-phase-e2.md)
- [阶段 E3：选择账户的三步角色向导](./architecture/accounts-and-agent-creation-phase-e3.md)
- [阶段 E4：账户迁移、运行恢复与回滚](./architecture/accounts-migration-phase-e4.md)
- [编排入口 O1：共同请求契约与比较预览](./architecture/orchestration-entry-phase-o1.md)
- [编排入口 O2：执行绑定与外部成员步骤准入](./architecture/orchestration-entry-phase-o2.md)
- [编排入口 O3 执行准入、队列与任务动作](./architecture/orchestration-entry-phase-o3.md)
- [编排入口 O4 策略、工作流与图修订](./architecture/orchestration-entry-phase-o4.md)
- [编排入口收敛 O5：每轮任务交互](./architecture/orchestration-entry-phase-o5.md)
- [编排入口 O6：迁移、灰度与故障恢复](./architecture/orchestration-entry-phase-o6.md)
- [编排入口 O7：整体验收与演示工具](./architecture/orchestration-entry-phase-o7.md)
- [编排 API 迁移说明](./architecture/orchestration-api-migration.md)
- [任务阶段与业务验收 v1](./architecture/business-acceptance-v1.md)
- [逐阶段执行与用户验收门禁 v1](./architecture/business-stage-execution-v1.md)
- [阶段续跑检查点与交付归档 v1](./architecture/business-stage-continuation-v1.md)
- [公开只读阶段返工 v1](./architecture/business-stage-rework-v1.md)
- [私密交互与受控文件权限 v1](./architecture/private-interaction-artifact-acl-v1.md)
- [私密及写入阶段恢复 v1](./architecture/private-write-stage-recovery-v1.md)
- [Run 与阶段费用预算治理 v1](./architecture/cost-budget-governance-v1.md)
- [Run 失败关系诊断 v1](./architecture/run-failure-diagnostics-v1.md)

### 实施计划

- [持续协作模式实施指导（Issue #16，T01–T05 交付，T06 待实施）](./plans/threaded-collaboration-implementation-guide.md)
- [持续协作实施状态与下一项任务](./plans/threaded-collaboration-implementation-status.md)
- [持续协作 T01 设计决策与实施接口](./plans/threaded-collaboration-t01-decisions.md)
- [持续协作核心合同、兼容矩阵与能力范围](./plans/threaded-collaboration-compatibility-matrix.md)
- [持续协作模式接入盘点与 T02–T04 接口地图](./plans/threaded-collaboration-integration-map.md)
- [Agent 自主协作与单一任务入口实施方案（AC1–AC6 已验收，业务房间灰度已切换）](./plans/agent-autonomous-collaboration-implementation-plan.md)
- [通用私密协作与受控信息发布实施指导（Issue #15，G0–G6 当前开放组合已交付，Codex 真实补验暂缓）](./plans/scoped-collaboration-implementation-guide.md)
- [平台协作剩余内容实施计划（R1–R8 已完成适用范围实现与验收）](./plans/platform-collaboration-remaining-implementation-plan.md)
- [P1 实施路线与验收状态](./plans/p1-implementation-roadmap.md)
- [完整编排功能实施方案](./plans/full-orchestration-implementation-plan.md)
- [通用协作规划器与 Coordination Plan 设计](./plans/coordination-planner-design.md)
- [聊天室追问路由与任务级编排方案](./plans/followup-routing-plan.md)
- [编排入口收敛实施计划（O1–O7 本地完成，真实账户待验收）](./plans/orchestration-entry-convergence-implementation-plan.md)
- [编排兼容分支清理清单（盘点完成，待用户验收确认）](./plans/orchestration-compatibility-cleanup-checklist.md)
- [Collaboration 模式实施计划](./plans/collaboration-mode-implementation-plan.md)
- [Agent 通信与调度方案](./plans/agent-communication-scheduling-plan.md)
- [Agent 角色管理实施指导](./plans/agent-role-management-implementation-guide.md)
- [账户与密钥、Agent 创建体验实施指导（E1–E4 本地完成，真实供应商待验收）](./plans/accounts-and-agent-creation-implementation-guide.md)
- [外部 Code Agent 接入方案（本地 A–D 已完成）](./plans/external-code-agent-integration-plan.md)
- [聊天体验优化方案](./plans/agent-chatroom-experience-plan.md)
- [聊天气泡方向优化方案](./plans/chat-bubble-direction-optimization-plan.md)
- [观测模块优化方案](./plans/observe-module-optimization-plan.md)

### 外部调研

- [Clowder AI Agent 交互模式调研](./research/clowder-agent-interaction-research.md)
- [Clowder AI 协作模式管理与调度源码核对](./research/clowder-collaboration-dispatch-research.md)
- [Clowder AI 外部 Code Agent 接入源码调研](./research/clowder-external-code-agent-integration-research.md)
- [DeepSeek Harness 轨迹模块调研](./research/deepseek-harness-trajectory-research.md)

### 测试与评估报告

- [持续协作 T05 消息账本验收（2026-10-20）](./reports/threaded-collaboration-t05-messaging-2026-10-20.md)
- [持续协作 T04 共享资源验收（2026-10-20）](./reports/threaded-collaboration-t04-resources-2026-10-20.md)
- [持续协作 T03 执行边界验收（2026-10-20）](./reports/threaded-collaboration-t03-execution-2026-10-20.md)
- [持续协作 T02 基础边界验收（2026-10-19）](./reports/threaded-collaboration-t02-foundation-2026-10-19.md)
- [持续协作 T01 固定源码基线与参考证据（2026-10-19）](./reports/threaded-collaboration-t01-baseline-2026-10-19.md)
- [AC1 任务契约、授权与根预算验收（2026-10-17）](./reports/autonomous-collaboration-ac1-acceptance-2026-10-17.md)
- [AC4 默认单入口验收（2026-10-18）](./reports/autonomous-collaboration-ac4-acceptance-2026-10-18.md)
- [AC5 可校验多轮流程验收（2026-10-18）](./reports/autonomous-collaboration-ac5-acceptance-2026-10-18.md)
- [AC6 托管 SDK 与上线准备验收（2026-10-18）](./reports/autonomous-collaboration-ac6-acceptance-2026-10-18.md)
- [AC6 真实狼人杀完整回放（2026-10-18）](./reports/autonomous-collaboration-ac6-werewolf-replay-2026-10-18.md)
- [自主协作业务服务灰度切换记录（2026-10-18）](./reports/autonomous-collaboration-service-cutover-2026-10-18.md)
- [狼人杀入口与消息显示异常复盘（2026-10-18）](./reports/werewolf-entry-and-stream-anomalies-2026-10-18.md)
- [狼人杀入口修复后的真实游戏回放（2026-10-18）](./reports/werewolf-entry-fix-real-replay-2026-10-18.md)
- [AC3 自动收集与交付验收（2026-10-18）](./reports/autonomous-collaboration-ac3-acceptance-2026-10-18.md)
- [AC2 动态委派与依赖唤醒验收（2026-10-17）](./reports/autonomous-collaboration-ac2-acceptance-2026-10-17.md)
- [SDK 受控文件与原生 Coordination 接入收尾（2026-10-17）](./reports/scoped-collaboration-native-integration-2026-10-17.md)

- [跳过 Codex：模型 API + Claude SDK 真实协作与发布验收（2026-10-17）](./reports/scoped-collaboration-api-sdk-acceptance-2026-10-17.md)
- [nim 切换 Codex 后的 G5 真实验收（2026-10-17）](./reports/scoped-collaboration-nim-codex-acceptance-2026-10-17.md)
- [普通入口、无效等待与 G5 原生验收收尾（2026-10-17）](./reports/scoped-collaboration-closure-2026-10-17.md)
- [Issue #15 私密咨询后连续调度阻断分析](./reports/issue-15-private-consultation-analysis-2026-10-13.md)
- [G0 基线与私密协作阻断验收记录](./reports/scoped-collaboration-g0-acceptance-2026-10-13.md)
- [G1 Scope、输入来源与版本边界验收](./reports/scoped-collaboration-g1-acceptance-2026-10-14.md)
- [G2 独立材料分批协作验收](./reports/scoped-collaboration-g2-acceptance-2026-10-14.md)
- [G3 私密汇总与授权发布验收](./reports/scoped-collaboration-g3-acceptance-2026-10-15.md)
- [G4 持久恢复、只读 any 与费用验收](./reports/scoped-collaboration-g4-acceptance-2026-10-16.md)
- [G4 恢复契约](./architecture/scoped-collaboration-recovery-v1.md)
- [G5 原生隔离与 Coordination 实施进展](./reports/scoped-collaboration-g5-progress-2026-10-16.md)
- [G6 通用界面、灰度与恢复验收](./reports/scoped-collaboration-g6-acceptance-2026-10-17.md)
- [模型 API 真实狼人杀验证（白天超时，未完成终局）](./reports/scoped-werewolf-real-acceptance-2026-10-17.md)
- [同一轮真实狼人杀：扩大时限与预算后继续](./reports/scoped-werewolf-continuation-2026-10-17.md)
- [日常服务回复时限与 Token 默认上限调整](./reports/execution-default-limits-2026-10-17.md)
- [本地普通聊天室狼人杀失败分析](./reports/local-werewolf-chatroom-failure-2026-10-17.md)
- [独立协作支持矩阵与产品契约](./architecture/scoped-collaboration-support-v1.md)
- [独立协作灰度、排空与恢复手册](./operations/scoped-collaboration-runbook.md)
- [G5 原生冷边界与 Coordination 范围契约](./architecture/scoped-native-coordination-v1.md)
- [外部 Code Agent 阶段 A 验收记录](./reports/external-code-agent-phase-a-acceptance.md)
- [外部 Code Agent 阶段 B 验收记录](./reports/external-code-agent-phase-b-acceptance.md)
- [外部 Code Agent 阶段 C 验收记录](./reports/external-code-agent-phase-c-acceptance.md)
- [外部 Code Agent 阶段 D 验收记录](./reports/external-code-agent-phase-d-acceptance.md)
- [账户与密钥阶段 E1 验收记录](./reports/accounts-and-keys-phase-e1-acceptance.md)
- [账户与密钥阶段 E2 验收记录](./reports/accounts-and-keys-phase-e2-acceptance.md)
- [角色创建体验阶段 E3 验收记录](./reports/accounts-and-agent-creation-phase-e3-acceptance.md)
- [账户迁移与验收阶段 E4 记录](./reports/accounts-phase-e4-acceptance.md)
- [GLM 连接测试认证与超时修复记录](./reports/accounts-glm-connection-fix.md)
- [编排入口 O1 验收报告](./reports/orchestration-entry-phase-o1-acceptance.md)
- [编排入口 O2 验收记录](./reports/orchestration-entry-phase-o2-acceptance.md)
- [编排入口 O3 验收记录](./reports/orchestration-entry-phase-o3-acceptance.md)
- [编排入口 O4 验收记录](./reports/orchestration-entry-phase-o4-acceptance.md)
- [编排入口收敛 O5：验收记录](./reports/orchestration-entry-phase-o5-acceptance.md)
- [编排入口 O6：迁移与故障恢复验收](./reports/orchestration-entry-phase-o6-acceptance.md)
- [编排入口 O7：整体验收与收尾记录](./reports/orchestration-entry-phase-o7-acceptance.md)
- [长链路协作能力差距分析（真实混合后端测试）](./reports/platform-collaboration-gaps-2026-10-08.md)
- [平台协作修复进度（第一批）](./reports/platform-collaboration-repair-progress-2026-10-08.md)
- [平台协作修复进度（第二批：阶段与业务验收）](./reports/platform-collaboration-repair-progress-2026-10-09.md)
- [平台协作修复进度（第三批：活动时限与失败诊断）](./reports/platform-collaboration-repair-progress-2026-10-10-batch3.md)
- [平台协作修复进度（第四批：逐阶段执行与验收门禁）](./reports/platform-collaboration-repair-progress-2026-10-10-batch4.md)
- [平台协作修复进度（第五批：阶段续跑与交付归档）](./reports/platform-collaboration-repair-progress-2026-10-11-batch5.md)
- [平台协作修复进度（第六批：公开只读阶段返工）](./reports/platform-collaboration-repair-progress-2026-10-11-batch6.md)
- [声明产物与独立工作树快照](./architecture/artifact-worktree-snapshots-v1.md)
- [平台协作剩余计划 R3：完整产物与工作树快照](./reports/platform-collaboration-r3-acceptance-2026-10-11.md)
- [平台协作剩余计划 R4：私密及写入恢复](./reports/platform-collaboration-r4-acceptance-2026-10-11.md)
- [平台协作剩余计划 R5：费用预算治理](./reports/platform-collaboration-r5-acceptance-2026-10-12.md)
- [平台协作剩余计划 R2：私密入口与受控文件权限](./reports/platform-collaboration-r2-acceptance-2026-10-11.md)
- [平台协作剩余计划 R1：失败诊断与联合回归](./reports/platform-collaboration-r1-acceptance-2026-10-11.md)
- [模型活动时限与失败诊断](./architecture/execution-activity-timeouts.md)

- [Collaboration 阶段 F 验收报告](./reports/collaboration-stage-f-acceptance.md)
- [并行辩手发言短暂出现后消失：缺少持久聊天消息](./reports/collaboration-fanout-output-disappears.md)
- [Coordination 辩论实测问题报告（阶段 C 验收后）](./reports/coordination-debate-test-problem-report.md)
- [Collaboration 三轮辩论实测问题报告](./reports/collaboration-debate-test-problem-report.md)
- [架构评估](./reports/architecture-assessment.md)
- [依赖与构建分析](./reports/dependency-build-analysis.md)
- [工程分析报告](./reports/engineering-analysis-report.md)

## 文档状态规则

新增方案类文档应在标题后标注以下状态之一：

- `草案`：仍在讨论，不能作为实现依据。
- `已批准`：评审通过，可以开始实施。
- `实施中`：已有代码工作，尚未达到验收标准。
- `已完成`：代码和验证均已交付；后续架构事实应同步到 `architecture/`。
- `已废止`：决策已被替代；保留历史背景，并明确链接到替代文档。

权威性优先级为：当前代码与自动化验证 → `architecture/` 生效契约 → 已批准计划 → 调研和历史报告。报告描述的是特定时间点的证据，不自动成为产品规范。

## 新文档放置规则

1. 先判断文档要回答“为什么、当前如何、准备怎么做、外部有什么参考、实际发现了什么”中的哪一个问题。
2. 一份文档只承担一个主要职责；调研结论转化为实施决策时，新建或更新计划，不直接把调研当规格。
3. 文件名使用小写英文和连字符；中文标题保留在文档内部，避免跨平台路径问题。
4. 链接使用相对路径；移动文档时必须运行链接检查并同步 README、Issue 和引用文档。
5. 已完成计划中的稳定协议应提炼到 `architecture/`，计划本身继续保留作为决策和验收记录。

提交文档迁移或链接修改前运行 `pnpm verify:docs`，确保仓库内 Markdown 相对链接仍然有效。
