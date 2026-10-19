# 持续协作 T03：可信执行与生命周期边界 v1

更新：2026-10-20。基于已交付 [T02 基础](threaded-foundation-v1.md)和 [T01 决策](../plans/threaded-collaboration-t01-decisions.md)。本阶段提供隔离执行端口与生产控制/恢复接线；真实模型、工作入场和调度保持关闭。

## 持久关系与授权

`createThreadedLifecycle`、`createThreadedAuthority` 都接受注入的 SQLite 句柄，不通过导入模块打开业务库。内部创建 Invocation 时预分配 Run ID；首次领取在同一 IMMEDIATE 事务中建立 Run、唯一适配关系、Attempt 和 Binding。聊天室的 turnNo 在同事务内分配。重试新增 Attempt，沿用原 Invocation、Run 和因果根；不伪造旧 Completion Evaluation，也不调用旧 finishRun。

Binding 的随机 ID 来自服务端，保存 owner、Thread、Invocation、Run、Attempt、成员/角色/权限版本、Agent 定义 hash、账户配置/凭据/身份代际、Thread 与 Invocation 授权 epoch，以及 claimId/generation/fencingToken。序列化 Binding 不是自授权对象；运行前、工具/请求前、事件和响应提交前都重新验证持久记录及资源端口。当前 Attempt、作用域、账户撤销、成员变化或围栏失配均拒绝。

旧公共 executor 和旧模式 Binding 校验仍拒绝 threaded；新模式只能通过专用端口。浏览器 session 到期只影响新 HTTP/WS 请求，不撤销已获授权的执行；工作授权由持久 epoch 和账户状态控制。

## 资源与执行端口

[资源合同](../../apps/server/src/threaded/contracts.ts)接受受信协调器签发的完整 claim，提供 `assertCurrent`、`verifyQuiescence` 和 `release`。T03 交付时生产实现全部拒绝；T04 已替换为[持久共享协调器](threaded-resources-v1.md)，并增加可执行状态检查、started/unknown 事务接线。T03 的 fake 证据仍保留为该阶段历史记录，真实后端证明生产者尚未开放。

[独立 runner](../../apps/server/src/threaded/runner.ts)只接受显式注入 executor，并要求 `AGENT_GAND_ISOLATED_WORKER=1`。生产服务没有 executor；设置模式为 execute 仍不能执行。上下文、Session 与预算引用在本阶段只验证端口参数，实际解析及预算预留属于 T04/T06/T07。

启动通过持久 CAS 将 prepared Attempt 转为 running/started，重复启动不能再次调用 executor。执行器收到 AbortSignal 及 `assertAuthorized` 回调；每次工具或新请求须先复验授权，事件回调也复验。抛错或拒绝的 Promise 只形成 unknown，不证明外部进程已停止。

## 控制、审批与恢复

专用接口均要求 Threaded session、Host/Origin 和 CSRF。owner 来自 session；主体作用域由 URL 和持久记录共同核验。请求需要 requestId，相同请求重投幂等，改载荷冲突。

| 接口 | 作用域及行为 |
| --- | --- |
| `POST /api/threaded/threads/:id/controls` | Thread 的 pause / stop / resume |
| `POST /api/threaded/threads/:id/members/:agentId/controls` | 指定成员的 pause / stop / resume |
| `POST /api/threaded/threads/:id/invocations/:invocationId/controls` | 指定 Invocation 的 pause / stop / resume |
| `POST /api/threaded/threads/:id/approvals/:approvalId/decision` | 同 Thread 审批的 approve / reject |

控制先持久撤权，再在提交后发送 AbortSignal。单 Invocation/成员控制不能顺带撤销同 Thread 的其他成员；Thread 恢复也不覆盖更窄范围的独立暂停。停止请求与已停止事实分开：未确认静止时 Run 不写 finished_at，Invocation 仍保持等待核实的非终态。resume 不重放 unknown；恢复或审批决定本身不启动 executor。

真实 `accounts/actions.revokeAccount` 在账户撤销事务内同时收紧 Threaded 授权，提交后通知在途调用。旧账户接口继续只返回旧模式 Run ID，避免泄露新数据。启动入口调用专用 `recoverAll`：按持久事实恢复投影，运行中且失去进程确认的 Attempt 转 unknown，不借旧恢复器重放。

## 终态与不确定结果

响应、InvocationTerminalProof、Invocation/Attempt/Run 终态在同一事务内提交。证明重新核验当前作用域、所有者、代际、授权、响应或失败/取消原因，以及资源协调器验证过的 QuiescenceProof。费用 unknown 单独记录；已经确认静止的进程不因费用待结算而继续占执行围栏。

unknown 保留原 Attempt 的围栏，不允许重试、继续或用 finally 释放。只有可核验的静止证明与副作用对账才可收敛到暂停、取消、失败或允许安全重试。资源释放在持久状态提交之后，旧回调不能释放后继 claim。T03 输出账本是本阶段响应证据；消息、Wake 和 Outbox 原子闭环仍由 T05/T06 完成，因此不能把本阶段终态测试写成 ISO05 整项通过。

静止与可重试分别记录。已完成但因暂停/撤权而未提交的正文不会在 resume 时盲目重做；需要后续专用对账或恢复锚点。默认最多两个 Attempt；只有确认未启动、明确可重试且费用已结算的失败，或确认无副作用的取消才可进入新的 Attempt。生产根预算和可配置策略仍由后续任务实现。

资源释放失败保留持久 `resource_release_state=pending`，包含终态 Invocation 的恢复扫描会返回 `await_resource_release`。`releaseResources` 使用原始 claim/proof 幂等补偿；资源已释放但 DB 确认失败时也不能释放后继 claim。未确认释放前拒绝重试。执行结果/终态/资源释放入口拒绝嵌套外层事务，避免 savepoint 返回后在真正提交之前释放资源。

## v26 与验证范围

[v26 迁移](../../apps/server/src/db/threadedExecutionMigration.ts)追加执行 Binding、控制请求、审批、输出与终态证明账本，并为 Invocation/Attempt 增加控制和围栏字段。v1–v25 descriptor 保持原样；升级事务失败回滚，不兼容的旧 worker 必须拒绝 v26。

验收证据见 [T03 报告](../reports/threaded-collaboration-t03-execution-2026-10-20.md)。实际后端、真实资源、消息投递、Action 完成和高级能力均不由 fake executor 测试推定通过。下一任务见[实施状态](../plans/threaded-collaboration-implementation-status.md)。
