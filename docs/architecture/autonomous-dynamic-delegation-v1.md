# 自主动态委派 v1（AC2）

状态：2026-10-17，模型 API 的动态委派闭环已实现，schema 19。[实施计划](../plans/agent-autonomous-collaboration-implementation-plan.md)、[AC1 授权基础](./autonomous-task-authority-v1.md)、[AC2 验收](../reports/autonomous-collaboration-ac2-acceptance-2026-10-17.md)。普通聊天入口仍未切换，默认配置仍为 closed。

## 显式准入与兼容

服务端调用 `admitAutonomousCollaboration(runId, draft)` 为一个新 Run 冻结 AC1 策略及 `features.autonomousCollaboration.delegationVersion=1`，原子登记根工作并交给现有 Collaboration 调度器。它不是 HTTP Owner 接口或 Agent 工具，AC4 前普通发送不调用它。

执行同时要求新根的 delegationVersion=1 和 `AUTONOMOUS_COLLABORATION_MODE=execute`。仅改开关不能升级历史 AC1 根，也不重解释 v2/v3。当前执行驱动仅 `builtin-llm`（已有模型 API 路由）；原生 Claude SDK/Codex 不能借此获得自主工具准入，既有 v3 SDK 能力保持原含义。管理能力接口声明支持的驱动与 `defaultEntryAvailable=false`，不把服务基础可执行等同于默认产品入口已开放。

## 模型实际工具与计划调整

AC2 暴露 `agent.delegate` 和 `agent.complete`，并按冻结权限暴露受控文件工具。`agent.aggregate`、`agent.emit` 和业务问题工具随 AC3 接入，不提供空实现。

委派参数是 `commandKey` 与 `items`。每个 item 有领域 `key`、执行者、独立 objective、输入句柄、依赖 key，可选的子团队、文件工具和输出接收者；Run、Scope、Attempt、Grant、代际、根预算与来源指纹由服务端绑定，模型传入这些字段会被拒绝。

模型可以自行决定成员、不同目标和输入，以及一批内或既有同级工作之间的依赖。也可以在收到真实完成状态后追加新的回合和任务，形成运行中的计划修订。计划调整采用追加事实；不修改或取消已提交工作，不提供失败工作“改名即成功”的替换规则。读写失败、未知用量和未完成义务继续阻止终局；后续阶段扩展合法恢复与交付时须保留这些事实。

图必须无循环，依赖必须是当前父责任内已有工作或本次新工作。拒绝自委派、向祖先执行者回委派、未知依赖和重复工作 key。权限、深度、成员、工具和来源都在根上限内收窄。派发上限同时计算已派发、等待依赖的工作、已登记但未发生的父唤醒和本次新增计划，避免用完最后一个派发位置后无法恢复父责任。

## 原子动作与真实运行状态

`agent.delegate` 的命令回执、子 Subject/Custody、Grant、目标消息、依赖边、必需义务、父责任等待及委派回合在同一事务提交。任一校验失败全部回滚。相同幂等键不能用不同 Attempt、实际输入账本或意图重放；旧 Attempt 失效后不能靠重试绕过执行绑定。

只有依赖全部完成的工作才创建真实 Dispatch 和成员排队票据；依赖阻塞工作不占住成员队列。开始时复用现有领取、租约和成员并发控制，再绑定不可变 Grant/Attempt。没有第二套工作状态：图只存事实，执行进度来自 Subject/Custody、Dispatch/Attempt 与候选验收。

父 Agent 提交委派后结束本轮 Attempt，将同一 Subject 置为 waiting；不会留住模型调用或成员资源，也不会靠模型轮询。所有子工作终态后，按回合与等待代际在事务中唯一创建父 resume Dispatch；父继续持有同一 Grant、Subject 和根预算。来源失效导致未领取子工作被阻断时，也会将义务转为失败并唤醒父责任，避免无效等待。

父返回仅包含本来由父提交的 key 和固定状态 completed/failed/cancelled。此 `autonomous-status-only-v1` 是 delegationVersion=1 契约内的服务端固定投影；不复制子结果、异常或模型自由文本。投影范围沿用父委派时的实际 Scope，原消息引用记入父续回合输入账本。依赖只表示执行顺序，不自动授予读取前置结果的权限；正文收集与汇总由 AC3 实现。

## 独立上下文与效果边界

每个 Attempt 使用实际 Scope/Manifest 与输入来源账本，只注入当前目标、明确选定输入、冻结角色、可用句柄和合法固定状态。主 Agent 可以持有不透明转交句柄，而不读取独立材料正文；不会注入房间历史、未选材料、别的成员结果或旧原生会话。

再次承担同一个责任时，保守继承该责任所有先前实际读入的来源，包括文件/工具结果，并重新核对 ACL、指纹和当前范围。换一轮或生成新摘要不能抹掉既有暴露。同一个成员被分配新的独立责任时，使用新的白名单上下文，不继承其他责任的历史。

每个新目标及工具效果都受当前实际来源范围约束。允许委派的成员上限并不允许把已读私密内容写进新的公开目标；即使子团队包含 B，A 已读取只给 A 的材料时，也不能向 B 发出携带该内容的自由文本目标。文件工具只处理当前选定或本 Attempt 写入的受控产物，保留工具回执与来源账本，不开放原生磁盘、shell 或网络。

## 预算、恢复与终局

所有分支、嵌套工作和父续回合仍用一个根 Run、原有 Token/费用账本及 callId。真实开始模型请求前重验权限、模型、驱动、并发和截止时间；已知用量结算，未知消耗保留占额并阻断后续调用。

冷启动从不可变图、义务和等待代际重建已就绪工作与唯一父唤醒，不重发已完成子工作。中断后的未发出、安全只读工作沿用有界恢复；已发出未知模型、未知副作用、已完成的手动写入或原生调用不会自动重放。成员租约以 Attempt 隔离，旧释放回调不能释放新尝试的成员资源。

用户停止时同时关闭等待中的父 Subject、已排队工作以及尚无 Dispatch 的依赖阻塞节点。关闭动作仍追加 Custody 事件，完成或失败历史不改写；旧回合的等待代际不能在停止后再次触发唤醒。

`agent.complete` 提交真实完成候选，必需子义务、有效绑定、证据与已知用量须满足条件；不能仅回复“收到”。Run 完成复用 Completion Engine 和唯一终局提交。AC2 只保存合法范围内的内部交付，不自动汇总子正文或发布最终报告；自动交付属于 AC3。

## 追加存储

迁移 19 仅追加 `autonomous_work_items`、`autonomous_work_dependencies`、`autonomous_dispatch_work`、`autonomous_delegation_rounds`。记录禁止更新/删除，并检查 Grant/来源/Subject/派发与同根血缘。此前迁移和历史行不重写。v18 worker 拒绝 v19；部署须先备份并排空旧 worker，按匹配源码恢复，不删迁移号降级。
