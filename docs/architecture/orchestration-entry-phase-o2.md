# 编排入口阶段 O2：执行绑定与外部成员步骤准入

状态：**本地实现完成**。日期：2026-10-06。总方案见[实施计划](../plans/orchestration-entry-convergence-implementation-plan.md)，测试证据见[O2 验收记录](../reports/orchestration-entry-phase-o2-acceptance.md)。

## 生效范围

Coordination Plan 现在可以绑定模型 API、Claude SDK、Codex app-server 成员执行步骤与独立评审。图调度、步骤 attempt、CompletionCandidate 和 Run 终局继续由现有 Coordination/Public Runtime 管理。原生回合的输出是步骤候选；不能自行跳过依赖或关闭整个 Run。

O1 的共同提交事务、纯读取比较预览和旧入口响应继续使用。新的每轮策略执行与任务入口改版属于 O3–O5；`/api/orchestration/preview` 仍是 `comparisonOnly: true`。

## ExecutionBinding

[共享类型](../../packages/shared/src/execution.ts) 定义三种互斥来源：

| origin | 引用的已有执行尝试 | 授权检查 |
|---|---|---|
| collaboration_attempt | collaboration_attempts | Run、主体、contractRevision、holder、generation、状态与有效租约 |
| coordination_step_attempt | coordination_step_attempts | 上述责任检查，加当前 plan/revision/step、attemptNo、startedAt、步骤期限与评审目标代际 |
| task_attempt | task_attempts | Run、task、actor、attemptNo、startedAt、leaseOwner、有效租约与状态 |

`execution_bindings` 只保存引用元数据及回合完成时的 Git 快照，不维护第二个状态机、队列或 attempt。Coordination claim 在同一事务内取得 Runtime custody 并保存绑定。原生 execution 记录嵌入绑定，便于审批、过程与恢复追溯；真正权限始终读取原 scheduler 和 Runtime 表。

没有 attempt 的旧手动流水线仍保留既有 Run 执行边界，不为兼容入口创建虚假的 stub attempt；这部分派发入口的进一步收敛属于 O3。Coordination 新步骤必须持有真正的步骤绑定。

[authority.ts](../../apps/server/src/execution/authority.ts) 提供共同权限查询。来源来自服务端 attempt 行，不按 `Run.mode` 猜测。未知来源、错误 actor、已关闭 attempt、失效 generation、contract、lease 或计划版本都拒绝执行。Coordination 不会查询 task_attempts 来判定自己的权限。

绑定覆盖模型调用前、模型返回后、原生消息/工具权限请求、平台 MCP、审批批准、会话准备、证据和结果提交。API 工具循环也在模型与工具边界检查同一绑定。原生监听定时撤销失权执行并收敛进程；迟到输出不再提交为步骤消息。

Coordination 步骤期限由已有 `startedAt + step.timeoutMs` 计算；原生回合超时取账户/默认超时与剩余步骤期限中较小值。租约失效只能拒绝副作用。仍持有同一 attempt/责任代际的 scheduler 可以将超时步骤失败收尾；已换代或已换计划的旧 worker 不能改写新步骤。

## 准入矩阵

| 协议 | 模型 API | Claude SDK / Codex app-server | 额外条件 |
|---|---|---|---|
| single_agent | 支持 | 支持 | 成员具备 execute |
| sequential_pipeline | 支持 | 支持 | 依照固定成员顺序 |
| parallel_fanout | 支持 | 支持 | 只读共享锁、写入独占锁；实际写入按工作区串行 |
| supervisor_aggregation | 支持 | 支持执行/汇总 | 必须组合在分支协议之后；协调角色使用内置 API |
| review_revision | 支持 | 支持实现/独立评审 | Reviewer 与目标执行者不同；FAIL 进入既有返工流程 |
| debate | 支持 | 支持发言/独立裁判 | 外部发言需平台 fs.write 与写入权限，以冻结声明产物 |
| supervisor_dag / dynamic_collaboration 的 Coordination 展开 | 原有行为 | 本阶段拒绝 | 等待后续协议专项验证 |
| consensus / vote | 不可执行 | 不可执行 | 原有协议限制保留 |

只在这些协议的 **execute Runtime** 下开放外部步骤；关掉 execute 或移出允许协议清单会拒绝准入。只读 CLI 继续使用手动流水线。外部角色不能承担 coordinate/主管规划。既有原生自由协作的 complete/handoff/consult/hold 是独立旧路径，继续受原有责任与控制工具约束；本阶段不向 Coordination 步骤暴露这些控制工具。

能力快照捕获 execution 配置，具体准入错误进入 `validationIssues`。启动时再用 Run 的冻结成员复核驱动、协议和工具，不能凭旧草案绕过限制。原生端无法提供硬 token 限制的事实不变。

## 工作区与独立评审

原生 coding cwd 与平台产物 namespace 分开解析：编码从注册 Git 根映射到已有隔离工作区，不把 planId 子目录当成 Git 根。外部编码步骤要求 isolated 工作区；不会放宽 Git 根、路径包含性或私有账户路径检查。

API 与原生成员共用同一 Run 的 managed 工作区。写步骤持独占租约；完成原生进程收敛或 API 工具循环后，保存不可变 Git 快照。平台产物工具保留既有路径映射，声明产物仍须实际存在且满足最小字节检查。外部辩论通过平台 fs.write/MCP 冻结产物，原生工具不能绕过平台产物账本。

评审绑定目标 attempt 和责任代际，读取目标步骤完成时的固定快照。原生 cwd、平台文件读取与 API 工具读取都指向该快照，评审权限强制 readonly。多个依赖存在快照时选最后完成目标的快照；工作区独占写锁确保它包含此前已完成的写入。没有 managed 工作区的文本任务读取冻结的前序输出。目标返工或换代使旧评审绑定失效，旧 PASS 不能关闭新一轮返工义务。

## 账户、审批、会话与恢复

继续使用 Run 已冻结的账户配置和凭证/身份版本；立即撤销账户会停止原生执行。没有新增隐藏 Key、全局环境回退或静默账户切换。

原生审批现在携带真正的 Coordination attemptId，复用 Durable Hold/Wake。批准时查询当前 execution 与绑定，批准后等待 Hold 收尾。旧 generation、旧执行的审批不能授权新的写入。MCP 回调使用同一服务端绑定，模型参数不能提供权威字段。

原生会话原有绑定包含账户、角色版本、模型、驱动版本、工作区、权限和系统提示词。Coordination 新增 planId、planRevision、stepId 和评审目标；跨步骤或换计划版本重新建会话，避免分支上下文污染另一职责。

用户暂停保持已有安全步骤边界语义：当前步骤可以等待有效审批并完成，后续步骤停止；恢复不会重放已完成的写入。重启时先收敛旧原生进程，关闭旧 attempt 的 running 状态并释放旧责任代际。未知原生执行或尚未提交步骤的原生结果使计划进入 paused/Run waiting_for_user，不自动重放；直接恢复返回 HTTP 409，检查实际变更后创建新运行。API 的既有检查点和工具账本恢复继续保留。

## 页面交互

建房页“智能匹配”可选择 SDK/app-server，点击成员不会切换模式；请求把选择的成员交给服务端规划，只有通过准入的计划才能确认执行。只读 CLI 显示流水线限制，并可“移除只读 CLI 成员”，保留已选择的 SDK/app-server。默认自动团队仍沿用模型 API 成员，原生成员由用户明确选入。

本地验收只验证 fixture 协议和交互，不代表某个真实账户、GLM 模型或原生客户端版本已通过供应商连接测试。
