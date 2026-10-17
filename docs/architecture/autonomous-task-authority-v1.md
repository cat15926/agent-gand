# 自主协作任务契约与授权基础 v1（AC1）

状态：2026-10-17，AC1 已实现，引入 schema 18 与 Tool API/Control Action v4 基础。**本契约的 AC1 根不开放自主调度，不改变普通聊天行为。** 后续[AC2](./autonomous-dynamic-delegation-v1.md)在 schema 19 为新根追加显式 delegationVersion，不升级 AC1 根。对应[实施方案](../plans/agent-autonomous-collaboration-implementation-plan.md)与[AC1 验收记录](../reports/autonomous-collaboration-ac1-acceptance-2026-10-17.md)。

## 根任务与冻结契约

一个自主需求使用一个根 Run。`AutonomousTaskPolicyV1` 冻结主 Agent、参与成员、原始目标引用和 ACL、可转交输入及读者、角色/模型/驱动快照、工具上限、结果默认范围、Token/费用、并发/深度/派发与截止时间。新输入仅取该 Run 的明确来源；AC1 不接受跨 Run 的来源或预算关联。

`freezeAutonomousTask` 是服务端编译服务，没有新增提交 HTTP 接口，也不是 Agent 工具。它只接受尚无 Runtime/普通编排/派发契约的新 Run，要求已存在用户原始消息、角色与账户冻结快照。在一个事务中保存策略、v4 Runtime 契约、根 Subject/Custody 及根 Grant，不创建 Dispatch、不请求模型。

重复调用使用规范化输入摘要核对；相同请求返回相同策略与根 Grant，配置和环境变化不改写冻结内容。不同输入冲突；历史 v2/v3 Run 不升级。策略标识、根 Run 与预算 Run 均由服务端产生；不能通过请求额外字段指定其他根任务或新增预算。

新 Runtime 特征为 `features.autonomousCollaboration`，包括 version=1、capabilityPackage=`autonomous-collaboration-v1`、boundaryVersion=2、policyRevision=1、策略 ID/SHA-256、rootRunId 和 budgetRunId。两种 Run ID 必须等于当前 Run；v4 必须显式采用 execute/explicit_only、消息可见性及完整 Runtime 完成组件，不能与 G2/G3 或 Coordination Scope 契约混用。

`loadRuntimeContract` / `resolveRunPolicy` 可以解释该契约，但普通 Collaboration 执行器与旧动作解析明确拒绝 v4。未知版本、策略缺失、摘要漂移、错误根或混合协议均不降级执行。

## 来源与权限派生

原始目标可见范围约束参与成员。用户明确只给 A 的私密根目标不能被新模式共享给 B。额外输入逐项冻结不可变来源引用与读者，读者必须同时满足原 ACL 与根参与者范围。

输入授权包含“允许转交的引用”，并不意味着协调者读过该内容。例如仅 B 可读的材料可作为不透明引用交给主 Agent 调度，再由 Runtime 验证并交给 B；不会把正文注入主 Agent。执行时的实际输入组装与披露仍由后续 AC2/AC3 接入。

Grant 描述可授权范围，不是本回合“已经读入哪些内容”的证明。AC2/AC3 的执行器必须继续通过实际 Scope/Manifest 与输入账本核对目标、工具和派发正文，不能把 Grant 上限当作干净上下文、直接拼接私密结果后继续公开委派。AC1 仅验证授权基础，不宣称完成 v4 模型上下文的端到端隔离验收。

`AutonomousTaskGrantV1` 绑定根策略、父 Grant、具体 Subject、执行成员、参与者子集、输入引用/读者、工具、动作、输出范围、深度及有效期。派生时：

- 发起者须持有已绑定的真实活动 Attempt，当前 Subject/Custody、执行者、租约及代际必须有效。
- 子 Subject 由调度器提供，必须属于同一个 Run，且父 Subject 必须匹配；模型不能凭空生成 authority。
- 参与者、可转交输入与读者、动作、输出范围、有效期与工具授权只能保持或收窄，不能扩大。
- `allowedTools` 是该执行者实际工具上限；`delegableTools` 是允许交给后继成员的工具上限，二者分开。只读协调者可以安排已授权的写入者，但自身不会因此得到写权限。
- AC1 仅纳入已有受控文件工具；执行工具还须满足角色和平台限制，原生磁盘/shell/网络不因任务授权开放。
- 读取与输出重新核对来源版本及 ACL；不允许用“没有使用秘密”扩大披露。AC1 的 disclosure 固定为 `within_source_access`，不授予自动脱密或外部发送权限。
- 相同命令与相同规范化意图返回同一个 Grant，变更意图冲突；深度、派发上限及自委派检查生效。

根 Grant 的输出上限为原始任务范围；策略中的 `outputAccess` 另记录最终答复默认范围，默认仅 Owner 与主 Agent 可读。该默认值不阻止在原授权范围内安排独立子工作。

## Attempt、撤销和停止

`bindAutonomousAttempt` 将 Grant 关联到真实 Collaboration Attempt 的 Subject 与当前责任代际，并以不可变行保存。Grant ID 自身不是可直接执行的凭据。

`assertAutonomousGrant` 每次重新检查根策略、运行状态、截止时间、来源、祖先撤销、真实责任及已绑定代际。任务必须处于 running；终态、过期、失效租约、代际变化或撤销后拒绝效果及后续模型调用。

模型 API 请求发出后也检查流式片段和最终返回的当前授权。授权失效后不继续转发片段、不交付最终回复；供应商已返回的已知 Token/费用照常结算，完成的调用不因结果被拒绝而改记为 unknown。AC1 尚无 v4 原生执行器，此项迟到回复验收使用模拟模型 API。

`revokeAutonomousAuthority` 仅是服务端/Owner 操作，不在 Agent 动作名单内。可撤销整个根授权或某个 Grant；父 Grant 撤销使其所有后继失效，审计行只追加不删除。

## 根任务统一预算

所有内部工作继续使用现有 `orchestration_model_calls`、`orchestration_token_reservations` 和 `execution_cost_reservations`，使用相同 callId 关联。没有为每个 Grant 新建余额或独立费用账本。

`withAutonomousExecution` 绑定可信服务端执行上下文。模型准入必须匹配根 Run、Attempt、Grant、执行成员、冻结模型与驱动；不能靠更换 runId、模型、驱动或绕过上下文触发付费调用。每次真正开始调用时在事务中重验，并落实根并发上限。

模型 API 每次输出上限取请求、冻结单次上限和根剩余额度的最小值；并发分支原子预留，等待后重新验证权限。原生请求沿用独占预留根剩余额度的办法，与 API 共用同一表；这仍是准入记账，不保证供应商内部推理的硬 Token 上限。

费用继承房间政策；未指定时冻结现有协作 USD 估算上限、未知费用预留与空价格表。严格费用模式拒绝。已知用量结算，缺少用量保留 unknown 及原占额并阻断根后续请求；未发出的调用阻断则结算为零，不把已发出未知调用清零。

本阶段不提供根预算增加或跨 Run 继承的 Agent 接口。后续合法跨 Run 延续必须先实现预算继承，不能通过创建新 Run 绕过本根未知用量。

## 存储与能力发现

迁移 18 追加以下表，不重写任何历史数据或既有迁移：

| 表 | 权威内容 |
|---|---|
| `autonomous_task_policies` | 每根 Run 的不可变策略、规范摘要及创建记录 |
| `autonomous_task_grants` | Subject 绑定的父子授权、幂等命令与意图摘要 |
| `autonomous_attempt_grants` | 实际 Attempt 与 Grant、Run、责任代际绑定 |
| `autonomous_task_revocations` | 全根或单 Grant 的追加式撤销记录 |

表包含绑定检查、父子血缘与跨 Run 检查、唯一根 Grant，以及禁止更新/删除的触发器。普通角色、账户密钥、原始材料正文不复制到授权记录中；原有账户 relay、加密产物与访问服务继续负责它们的边界。

新增只读管理接口 `GET /api/accounts/autonomous-collaboration/capabilities`，沿用管理会话、Host/Origin 和 no-store，不返回策略、材料或密钥。AC1 时 executionAvailable=false；当前接口随 AC2 增加委派版本、支持驱动、配置执行状态和默认入口不可用声明，详见 AC2 契约。AC1 根自身始终不可执行。

`AUTONOMOUS_COLLABORATION_MODE=closed|preview|execute` 默认 closed。**仅设置 execute 仍不开放没有 delegationVersion 的 AC1 根**；AC2 为新根接入显式准入与动态工具，单入口仍依赖后续阶段。既有模型 API/SDK 的已开放 v3 能力不受该新开关影响。

v17 worker 不能读取迁移 18，必须在写入前拒绝新库。保持兼容 worker 排空历史任务；回退使用匹配源码和一致性备份，不删迁移号。当前日常服务是否已升级，以验收报告中的实际记录为准。
