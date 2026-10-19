# 持续协作 T04：共享执行资源 v1

更新：2026-10-20。继承 [T01 资源决策](../plans/threaded-collaboration-t01-decisions.md)和 [T03 执行边界](threaded-execution-boundary-v1.md)。持久资源已接入，新模式工作入场、自动调度和真实 executor 仍关闭。

## 持久竞争与容量

[协调器](../../apps/server/src/execution/resources/coordinator.ts)接受服务端构造的 `TrustedResourceRequest`；没有公开的 HTTP/model claim 签发接口。[共享单例](../../apps/server/src/execution/resources/service.ts)让旧模式实际调用和持续协作使用同一 SQLite 账本及进程内释放通知。

| 资源 | 冲突及计量 |
| --- | --- |
| Agent | 旧模式 exclusive；新模式按 owner/Thread/Agent 槽。同 Agent 不同 Thread 可并行，仍受下列约束 |
| 原生 Session | 后端、账号身份代际、宿主、真实 nativeId 的独立锁；不同配置 binding 指向同一 ID 仍冲突 |
| 工作区 | canonical path；写与读/写互斥，只读可共享；父子目录重叠也检查 |
| 容量 | 每个实际 model/native call 一个 operationId/claim；全局、Thread、账号和供应商共同限制，取适用的更小值 |

策略在初次创建时从协作配置初始化，默认全局/Thread/账号均为 3。已有策略不被后来的环境变量覆盖；Owner 的受信配置端口用版本 CAS，存在等待/活动 ticket，或仍可恢复的旧模式父准备 ticket 时拒绝变更。本阶段未增加公开管理 UI，也不自动探测供应商配额。配置的更低账号/供应商上限由同一领取事务执行；旧模式自身的局部并发限制保留。

新 Threaded ticket 声明完整资源集合，`BEGIN IMMEDIATE` 中一次检查并取得；失败不占部分资源或容量。[资源入场适配器](../../apps/server/src/threaded/resourceAdmission.ts)把领取与 Run/Attempt/Binding 创建包在同一事务中，任意失败一起回滚。T06 再接持久调度和预算准入，本端口不自动执行模型。

同槽 FIFO、最早合格旧 exclusive 屏障、持久 Thread last-served 轮转共同生效。新 lane 以当前轮次入场，避免无限创建新 Thread 抢占旧 Thread；同优先级按 seq。不可执行 ticket 不占容量，恢复 eligibility 保留原 seq。取消不需要排在执行队列后面。

## Session 身份与权限复核

[Session 准备](../../apps/server/src/execution/resources/sessions.ts)只做短事务/CAS：重读成员、角色、权限、Agent 定义 hash、账号版本/身份、模型/后端版本、canonical workspace 和信息边界。相容时复用；配置或权限变化重新冷开。Claude SDK 预分配 UUID；API 记录重建绑定且 nativeId 为空，不能标作原生 resume。旧版本记录只追加、不可删除，不用新快照抹去旧边界。

准备阶段没有模型调用或容量占用。领取和启动再次核对绑定版本、nativeId、权限与目录身份，准备与领取之间的变更会拒绝整组领取。意外 nativeId 使当前绑定进入 reconciling，保留原 ID；适配器停止后续工具/resume 并保留 unknown claim，不能静默换绑。本阶段只验证身份准备与资源合同；实际 SDK cold/resume、内容注入与恢复锚点仍由 T07 验证。

## 围栏、静止证明与恢复

v27 保存 tickets、claims、逐资源 epochs、fairness、策略、Session 版本、不可变静止收据和 availability 序列。领取递增 generation；claimId、ownerNonce、fencingToken 独立随机生成。续租、启动、证明和释放比较完整身份；释放后保留 epoch 和记录，旧 finally 不能释放后继。

`assertCurrent` 只核对围栏，允许 unknown 进入对账；`assertExecutable` 还核对当前权限/Session/父 claim 和可执行状态。T03 start/control/recovery 与资源 started/unknown 状态共事务。已签发静止收据可用于记录响应/终态，不允许继续外部副作用。静止证明与控制/撤权并发时保留已知静止状态，生命周期仍可按当前权限完成取消或等待对账。

过期只标 unknown，不授权接管。确认未启动可生成 not_started 收据；已启动必须经可信进程/副作用验证器。生产 Threaded 暂不提供已启动证明生产者，保持关闭。旧 provider 只有实际 Promise 结束才产生进程内受信收据；外层超时或 abort 返回不足以归还容量，重启丢失证据后保守保留 unknown。原生调用依赖确切 execution 的进程登记/停止和 recovery 证据，未知或 attention 不释放。

有活动子 claim 的父 claim 不能签发静止证明或释放。旧内置工具仍 running/needs_attention 时，准备资源也不能凭 not_started 释放；工具账本提交后仅重试已有待释放记录。释放须位于最外层事务，持久终态提交之后才归还；T03 的 pending cleanup 支持重试同一证明。旧资源恢复在外部进程恢复之后、旧成员恢复之前进行，子资源先于父资源，不将已停止原生进程和未证实的 provider 请求混为一谈。

## 明确登记的旧模式适配

旧模式维持整个 Agent turn 的 exclusive 占用；为保留 K16，兼容桥先领不占模型容量的父准备 claim，再准备工作区/Session，实际调用独立占一次容量。工作区 root 与 shared 以一组领取，Session 元数据不持锁等待执行资源。子 claim 只能复用确切旧父身份，不能任意重入，Threaded 禁止这类分阶段父子请求。

这与新模式完整资源一次领取有明确差异：旧模式等待准备时可持有 Agent exclusive，但不提前占模型容量。旧 Codex 后端仍可能在启动后返回 nativeId；其提升只允许确切旧 execution、同父已启动容量 claim 和独立 Session 互斥，碰撞中断并保留恢复围栏。该兼容能力不开放给 Threaded，也不声称完成新模式扩展后端准入。

旧 turn 和 Scoped 冷会话也准备真实 ID 锁；turn 仍不复用/持久化 transcript，Scoped 仍使用自己的 home 和原有工具轮次，不把两者改成 conversation Session。旧 lease 与新 claim 相互检查，未知原生进程继续阻塞冲突资源；旧 lease 释放也比较宿主 owner，防晚到 cleanup 误删后继。新旧全局容量争用可能增加旧模式等待，这是平台差异，不承诺吞吐量不变。

## 通知与验收边界

正常释放、入队和 eligibility 改变持久记录 availability seq，并通知同一服务进程的旧/新订阅者；重入 enqueue 可继续被观察。持久 scan/cursor 和等待端短周期修复处理丢通知/重启。首批仍是一宿主、一活动服务进程；多进程测试证明数据库竞态安全，不能据此宣称跨 worker 自动通知 transport 已实现。

证据见 [T04 验收报告](../reports/threaded-collaboration-t04-resources-2026-10-20.md)。Q01–Q06 仅资源子场景通过；Wake drain、完整响应/Outbox、真实后端与操作系统进程行为仍分别由 T05/T06/T07/T12 验证。费用/token/因果根预算不属于本轮容量计量，不将 B01/B02 或可靠性增强 E01–E06 标为通过。
