# P1 实施路线与验收状态

更新时间：2026-09-15

本路线按依赖顺序推进。每次只实施最早未完成的计划；前一项达到完成判据后再进入下一项。

| 计划 | 内容 | 状态 | 完成判据 |
|---|---|---|---|
| 1 | 收口 P0 工具链 | **已完成** | MCP 工具完成发现、注册、Agent 配置、权限审批、Trace、连接恢复；真实 Provider 可配置计价；端到端回归通过 |
| 2 | 建立统一观测协议 | 待开始 | RunGraph、TraceTree 与结构化 Span 属性形成共享契约，pipeline/supervisor 均产出一致数据 |
| 3 | 实现只读编排画布与完整 Trace | 待开始 | 拓扑实时高亮，支持树形、瀑布和 Span 详情，刷新后可恢复展示 |
| 4 | 实现 durable execution | 待开始 | checkpoint、持久化审批唤醒、精确恢复与工具幂等策略通过崩溃恢复测试 |
| 5 | 引入 Docker ToolRunner | 待开始 | 工具运行具备隔离挂载、网络策略、资源限制、超时和可靠清理 |
| 6 | 实现 cron/webhook | 待开始 | 幂等触发、启停、失败重试和触发历史可配置、可追踪 |
| 7 | 实现长期记忆与知识库 | 待开始 | 支持摄取、分块、Embedding、检索、引用与作用域隔离 |
| 8 | 升级舰队监督台 | 待开始 | 展示多会话状态、摘要、时长和产物，并支持 peek 与 attach |

## 计划 1 验收记录

- MCP stdio Client 已接入统一工具注册表，工具统一命名为 `mcp.<name>`；Agent 文件校验、角色管理界面和模型工具 schema 使用同一目录。
- MCP 工具沿用 `checkPermission` 和通用 `runTool` 调用链，因此 readonly、confirm、auto、显式禁用、人工审批及工具 Span 行为与内置工具一致。
- 连接采用懒创建、心跳探测和失效清理；启动连接失败不阻断主服务。状态接口和角色管理页支持诊断与手动刷新。
- 连接中断时不自动重放当前 MCP 调用，后续调用重新连接，避免重复执行有副作用的远端操作。
- OpenAI 兼容与 Anthropic Provider 根据 `LLM_PRICING_JSON` 记录成本，支持完整路由和 `provider:*` 兜底；未知模型保持 0。
- `pnpm verify:p0-tools` 覆盖动态发现、Agent 校验、人工审批、调用结果、工具 Trace、子进程断线重连和计价规则。

计划 1 完成后，下一项是计划 2：统一观测协议。第一步应冻结 RunGraph、TraceTree 和 Span attributes 的共享类型与兼容迁移规则。
