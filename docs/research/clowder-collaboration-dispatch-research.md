# Clowder AI 协作模式管理与调度源码核对

核对日期：2026-10-05。

基线：公开仓库 main 的 [`6860fe8616240e5400c92782294cbb25a5e47f9d`](https://github.com/zts212653/clowder-ai/commit/6860fe8616240e5400c92782294cbb25a5e47f9d)，通过 `git ls-remote` 和临时目录浅克隆交叉核对。本次为静态源码分析，没有安装或运行 Clowder，也没有调用供应商模型。以下讨论普通聊天协作主链路，不将游戏、定时任务、集体参与等专用功能都归入同一种模式。

## 1. 核心分层

Clowder 的普通协作主链路可以归纳为四层：

| 层 | 管理的内容 | 主要实现 |
| --- | --- | --- |
| 线程与参与者 | 公共消息、候选成员、最近回复者、线程临时路由偏好 | ThreadStore、AgentRouter |
| 本轮调用策略 | execute / ideate 意图及 serial / parallel 路由 | IntentParser、routeSerial、routeParallel |
| 协作责任与运行 | 执行槽、待处理输入、交接、并行征询、等待、停止判定 | InvocationTracker、InvocationQueue、QueueProcessor、WorklistRegistry、BallCustody |
| 工作流程与业务规则 | 阶段、负责人、恢复摘要、检查状态、推荐 skill 和风险规则 | WorkflowSop、SOP YAML、评估与工具门控 |

源码没有在普通主路由中分别启动“辩论引擎”“代码评审引擎”“投票引擎”。这些业务行为可以通过角色、技能、结构化动作和阶段规则形成；不能据此宣称 Clowder 拥有与 agent-gand 的固定辩论轮次或独立投票协议完全等价的执行保证。

## 2. 每轮确定目标，再选择调用策略

[IntentParser](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/context/IntentParser.ts#L82) 使用确定性规则：

| 消息情况 | 意图 | 普通路由策略 |
| --- | --- | --- |
| 显式 `#ideate`，且目标至少两位 | ideate | parallel |
| 显式 `#execute` | execute | serial |
| 无显式标签，目标至少两位 | ideate | parallel |
| 单目标 | execute；显式 ideate 也可保留该意图 | serial |

`#critique` 是提示词标签，不改变串并行策略。这里的自动推断主要由标签与目标人数完成，不能解释为一个自动理解任意目标、生成完整任务 DAG 的规划模型。

[AgentRouter](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/routing/AgentRouter.ts#L1407) 的普通目标选择：当前显式提及优先；没有显式目标时结合最近用户提及、健康回复者、线程候选成员和默认成员回退。显式 `#ideate` 可以选取多位线程候选。review / architecture 的临时路由偏好可配置 prefer / avoid 和过期时间。

`preferredCats` 是候选范围，不意味着每次消息都唤醒所有成员。当前源码的回退规则比早期报告所述“最近回复者优先”更丰富，应以本基线实现为准。

## 3. 串行接力与并行思考共享执行抽象

[routeSerial](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L659) 注册当前 invocation 的 Worklist；后续交接可扩展待执行目标。Worklist 保存来源成员、触发消息、已经执行的位置和链深度。待执行目标去重；同一对成员反复交接受到乒乓检测；队列有用户输入时通过公平性判断将后续工作延后入队。

[routeParallel](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/routing/route-parallel.ts#L572) 对同一输入建立各成员的独立调用并合并流式输出。它不是按 Worklist 依次接力的路线。初始并行思考本身不等于自动产生一个综合结论。

运行中需要独立征询时使用 [`cat_cafe_multi_mention`](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/mcp-server/src/tools/callback-tools.ts#L4037)，最多三个目标，记录 requestId、callbackTo、响应、超时与失败。当前 [MultiMentionOrchestrator](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/routing/MultiMentionOrchestrator.ts#L39) 的请求状态保存在进程内 Map；[结果处理](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/routes/callback-multi-mention-routes.ts#L828) 会将响应集合写入线程。不能仅因工具使用 callbackTo 就宣称所有路径都保证重启后的自动综合与续跑。

## 4. 谁在跑、谁在等、谁还负责，分开记录

- [InvocationTracker](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts#L1) 按 threadId + catId 管理执行槽；不同成员可并行，同一成员同线程的调用需经过占用、取消和准入处理。
- [InvocationQueue](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts#L1) 与 QueueProcessor 处理待执行输入、目标、来源、状态及延后派发。Queue 的本体是进程内结构；部分 durable carrier 的恢复依靠持久消息中的 queueCustody 和 [PersistedQueueCarrier](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/invocation/PersistedQueueCarrier.ts#L35)，不能把所有内存工作表等同于持久任务 DAG。
- [TurnCustodyProjectionService](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/ball-custody/TurnCustodyProjectionService.ts#L89) 对已覆盖的责任检查是否有可验证的迁移。对应 [回合停止门](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/routing/route-serial.ts#L292) 要求完成、交接或登记等待等结构化动作，口头 ACK 或纯文本提及不能代替这些协议动作。不同唤醒来源和历史兼容路径仍有差异。

这些机制让“收到请求”“当前执行”“责任完成”成为不同事实，而不是从一条聊天回复推断全部状态。

## 5. SOP 管理流程信息，后端适配独立于协作策略

[WorkflowSop 类型](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/shared/src/types/workflow-sop.ts#L1) 保存 stage、batonHolder、resumeCapsule、checks、nextSkill、version。注释明确其告示牌职责：存信息，成员据此决定行动。当前 [development.yaml](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/sop-definitions/development.yaml#L4) 也说明阶段按风险选择，不要求每个任务顺序经过全部阶段。规则中的 manual_only 仍需语义判断；不能将每条声明都解释为机器自动阻断。

Claude、Codex、Gemini、ACP 等分别注册成 [AgentService](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/types.ts#L988)，供同一个 [AgentRegistry](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/domains/cats/services/agents/registry/AgentRegistry.ts#L1) 管理。实际载体在 [服务组装](https://github.com/zts212653/clowder-ai/blob/6860fe8616240e5400c92782294cbb25a5e47f9d/packages/api/src/index.ts#L1954) 中选择；本基线 Claude 默认仍为 CLI `-p`，Codex 默认仍为 exec JSON，其他载体依配置选择。共同接口并不代表每种后端的工具、权限和会话能力完全相同。

## 6. 对 agent-gand 的建议（设计建议，尚未实施）

agent-gand 已有 Runtime Contract、责任、证据与持久调度基础，应在这些基础上收敛调用入口；不应新增一个 Clowder Worklist 作为另一份任务状态来源。

| 当前概念 | 建议归属 |
| --- | --- |
| 智能匹配 | 当前任务的策略选择器；选择后仍走共同执行接口 |
| 单成员、顺序、并行 | 本轮派发策略，成员选择不决定永久房间模式 |
| 代码实现与评审、固定轮次辩论、主管拆解 | 有依赖、角色和完成条件的工作流模板 |
| 交接、征询、等待、完成 | 统一 Runtime 动作及证据校验 |
| Claude SDK、Codex、模型 API | 执行后端适配与能力声明 |

普通页面可聚焦团队、工作区和本轮目标，提供“自动 / 并行分析 / 顺序执行”等简洁策略；固定流程模板放入任务配置。已有 Plan / Step / Attempt 继续提供严格依赖和重启恢复。模板中的步骤统一派发到内置或外部执行器，同时保留权限、工作区、审批、取消、版本与证据约束。

接入外部成员首先需要补齐 Coordination 的能力描述和步骤授权，再修复智能匹配中的 dynamic_collaboration / supervisor_dag 简化路径。仅合并前端选项不能解决当前多入口的语义差异。
