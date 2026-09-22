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

## 当前索引

### 需求基线

- [多 Agent 协作工具平台需求调研](./requirements/multi-agent-platform-requirements-research.md)

### 架构与协议

- [P0 权威架构规格](./architecture/scaffold-plan.md)
- [工程架构概览](./architecture/engineering-overview.md)
- [Collaboration 运行架构](./architecture/collaboration-runtime.md)
- [统一观测协议 v1](./architecture/observability-protocol-v1.md)

### 实施计划

- [P1 实施路线与验收状态](./plans/p1-implementation-roadmap.md)
- [完整编排功能实施方案](./plans/full-orchestration-implementation-plan.md)
- [通用协作规划器与 Coordination Plan 设计](./plans/coordination-planner-design.md)
- [聊天室追问路由与任务级编排方案](./plans/followup-routing-plan.md)
- [Collaboration 模式实施计划](./plans/collaboration-mode-implementation-plan.md)
- [Agent 通信与调度方案](./plans/agent-communication-scheduling-plan.md)
- [Agent 角色管理实施指导](./plans/agent-role-management-implementation-guide.md)
- [聊天体验优化方案](./plans/agent-chatroom-experience-plan.md)
- [聊天气泡方向优化方案](./plans/chat-bubble-direction-optimization-plan.md)
- [观测模块优化方案](./plans/observe-module-optimization-plan.md)

### 外部调研

- [Clowder AI Agent 交互模式调研](./research/clowder-agent-interaction-research.md)
- [DeepSeek Harness 轨迹模块调研](./research/deepseek-harness-trajectory-research.md)

### 测试与评估报告

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
