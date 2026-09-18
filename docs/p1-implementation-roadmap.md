# P1 实施路线与验收状态

更新时间：2026-09-18

本路线按依赖顺序推进。每次只实施最早未完成的计划；前一项达到完成判据后再进入下一项。

| 计划 | 内容 | 状态 | 完成判据 |
|---|---|---|---|
| 1 | 收口 P0 工具链 | **已完成** | MCP 工具完成发现、注册、Agent 配置、权限审批、Trace、连接恢复；真实 Provider 可配置计价；端到端回归通过 |
| 2 | 建立统一观测协议 | **已完成** | RunGraph、TraceTree 与结构化 Span 属性形成共享契约，pipeline/supervisor 均产出一致数据 |
| 3 | 实现只读编排画布与完整 Trace | **已完成** | 只读拓扑、实时轨迹、虚拟账本、Span 详情、图轨联动与千 Span 回归均已交付 |
| 4 | 实现 durable execution | **已完成** | checkpoint、持久化审批唤醒、精确恢复与工具幂等策略通过崩溃恢复测试 |
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

## 计划 2 验收记录

- `@agent-gand/shared` 已冻结 v1 契约：`RunGraph` 表达编排拓扑，`TraceTree` 表达 Span 父子关系与耗时，`SpanAttributes` 使用点分语义键。
- `run_events.attributes` 通过幂等启动迁移加入；旧事件保留可读，并按 `agent:*`、`llm:*`、`tool:*` 名称尽力回填检索属性。
- pipeline、supervisor 任务执行/审查、LLM、工具、审批及 collaboration dispatch 均写入统一属性；服务端自动注入 `run.id`、`run.mode` 和协议版本。
- 新增 `GET /api/runs/:id/observability`，一次返回同版本的 RunGraph 与 TraceTree；缺失父节点或循环父链作为标记过的根节点返回，不阻断整条 Trace。
- 观测页可在 TraceTree 与 RunGraph 之间切换，并直接查看结构化属性；完整拓扑画布、瀑布时间轴和 Span 详情留在计划 3。
- `pnpm verify:observability` 覆盖 pipeline next 边、supervisor 指派/审查/依赖边、嵌套 Trace、旧 Span 兼容与孤立父链。

## 计划 3 验收记录

- 独立“编排”页面已由占位说明替换为 React Flow + ELK 只读拓扑，支持自动布局、状态着色、缩放、平移、小地图、适配窗口和文本关系列表。
- “观测”默认使用四泳道执行轨迹，支持真实耗时/等宽顺序、滚轮缩放、拖动区间、搜索、类型/状态筛选、分组与节点折叠。
- 摘要与详情分离，完整 Input/Output 按需加载；详情面板支持复制、键盘关闭、窄屏抽屉和桌面拖动调宽。
- 活动 Run 订阅 WebSocket：已有 Span 直接幂等更新，新 Span 与图结构通过防抖快照校准，断线重连后重取摘要；历史终态 Run 不维持订阅。
- 账本使用虚拟列表，只有用户位于底部时才自动跟随；用户向上检查历史后显示“回到最新”。
- 拓扑节点可筛选相关 Agent/Task/Approval Span；选择 Span 会反向高亮对应拓扑节点。
- `pnpm verify:observability` 增加 1,000 Span 数据集，连同 typecheck、Web build、scheduler、collaboration 和 P0 tools 回归通过。

## 计划 4 验收记录

- 新增 `run_checkpoints` 按序保存 Pipeline、Supervisor、Approval 的恢复边界；Pipeline 会持久化下一位 Agent、已完成转写与用户消息状态，重启从最近 Agent 边界继续。
- 审批通过稳定幂等键绑定逻辑工具调用。服务重启后保留同一 pending 审批，用户决策会按 Run 模式唤醒 Pipeline、Supervisor 或 Collaboration。
- 新增 `tool_executions` 执行账本。只读调用可安全重放，`fs.write` 按幂等语义重放，未知副作用工具在结果不确定时进入 `needs_attention`，已完成调用直接复用持久化输出。
- Supervisor 重启恢复会回滚仅由任务 claim 增加的计数，复用原逻辑 attempt 编号，避免服务故障消耗返工预算；Collaboration 使用 dispatch ID 作为稳定执行范围。
- 新增 `GET /api/runs/:id/checkpoints` 与 `GET /api/runs/:id/tool-executions`，可审计恢复边界、等待对象、重放策略及执行结果。
- `pnpm verify:durable` 会在 Pipeline 等待 `fs.write` 审批时终止服务，使用同一 SQLite 重启、批准原审批，并验证 Run 完成、审批不重复、工具账本唯一和文件内容正确。

计划 4 完成后，下一项是计划 5：Docker ToolRunner。
