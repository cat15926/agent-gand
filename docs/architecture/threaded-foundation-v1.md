# 持续协作 T02：模式、身份与存储基础 v1

状态：已实现基础边界，执行未开放。更新：2026-10-19。实现依据为 [T01 决策](../plans/threaded-collaboration-t01-decisions.md)，后续进度见[实施状态](../plans/threaded-collaboration-implementation-status.md)。

## 当前能力

共享 `RunMode` 增加 `threaded`；原 pipeline、supervisor、collaboration 单独组成 `LegacyRunMode`。旧编排 DTO、默认房间偏好和前端旧入口继续使用旧模式集合。新模式暂无前端创建入口、模型执行器、消息队列或协作工具。

[策略](../../apps/server/src/threaded/policy.ts)读取 `THREADED_COLLABORATION_MODE=closed|observe|execute`，缺省 closed，未知值拒绝注册路由。**三个配置值在 T02 均不能接收新的执行工作**：closed 返回 `THREADED_MODE_CLOSED`，observe/execute 返回 `THREADED_ADMISSION_NOT_IMPLEMENTED`。配置值不代表已实现对应能力。

`threaded-http-v1`、`threaded-tools-v1`、记录 `schemaVersion: 1` 独立于旧编排协议。显式未知版本返回 409；未提供版本时使用唯一已实现的 HTTP v1。能力快照分别列 implemented、configured、verified；真实后端/业务验证没有由 fixture 自动升级。

## 认证与读取

持久身份为数据库唯一 `instance_owner_id`，适用单部署、单业务所有者。浏览器 cookie 只是短期凭据；重新登录或服务重启不改变业务 owner。

| 接口 | 当前行为 |
| --- | --- |
| `POST /api/accounts/threaded/access-session` | 必须先通过既有管理登录、Host/Origin 与 CSRF；签发 Threaded 专用 cookie/CSRF |
| `GET /api/threaded/session`、`DELETE /api/threaded/session` | 查看当前凭据有效期或注销；注销要求专用 CSRF |
| `GET /api/threaded/capabilities` | 返回版本、实现和配置范围 |
| `GET /api/threaded/threads` | 按认证 owner 查询 Thread |
| `GET /api/threaded/threads/:id`、`GET /api/threaded/threads/:id/members` | 返回 owner 过滤的持久快照和成员；无权限/不存在均拒绝 |
| `GET /api/threaded/ws?threadId=...` | 鉴权后发送该 Thread 快照；不订阅旧 bus，不提供客户端写命令 |
| `POST /api/threaded/threads` 及尚未实现写路径 | 明确拒绝；不会产生 Run、模型调用、预算扣除或工作区 |

cookie 使用 HttpOnly、SameSite=Strict、Path=/api/threaded；HTTPS 时附 Secure。有效期不超过八小时和母管理 session 的剩余期限。专用注销、母管理注销、会话到期会关闭相应 WebSocket；服务重启后重新认证。所有新 HTTP/WS 均验证可信 Host/Origin/本机边界，写请求还验证 CSRF。客户端不得提供 owner、Attempt 或执行代际来获取权限。

当前 WebSocket 只有初始快照和失效检查，**没有消息增量、断线补事件或 UI 状态机**；这些仍属于 T05/T09。会话过期不代表取消已授权工作，执行授权 epoch 的实际处理属于 T03。

## 旧路径隔离

[旧传输边界](../../apps/server/src/threaded/legacyBoundary.ts)在处理请求前检查 Run、Conversation 和任务/审批/Trace/产物等派生 ID；Threaded 资源返回 404，不能借旧接口读取、改题、完成任务、批准或停止。旧集合查询过滤新记录；旧 `/ws` 仅允许已明确列入旧协议且不含 Threaded 引用的事件，新事件类型默认不公开。响应投影再检查一次归属。

旧 dispatcher、恢复、终态、公共模型/native runner、执行 Binding 校验及成员领取显式拒绝或跳过新模式。`ThreadedBinding` 已有数据类型，但它本身不授予执行权；T02 不生成可执行的新 Binding。旧终态证明和已有账号撤销等行为保留，T03 再通过专用生命周期接入新模式。

## v25 前向迁移

[迁移](../../apps/server/src/db/threadedMigration.ts)新增六张表：

| 表 | 不变量 |
| --- | --- |
| threaded_instances | 唯一、不可改写/删除的实例 owner |
| threaded_threads | Conversation 唯一对应，mode 固定 threaded，持久 owner、策略/授权/行版本 |
| threaded_members | Thread/Agent、Thread/handle 唯一，角色/账号/权限版本及成员状态 |
| threaded_invocations | 因果根、成员归属、当前 Attempt 及独立状态；当前 Attempt 必须属于本 Invocation |
| threaded_attempts | Invocation/attemptNo 唯一，代际、执行确认阶段及状态 |
| threaded_run_bindings | Invocation 与 Run 双向唯一，Thread/owner/Conversation/mode 一致，绑定不可改写或删除 |

旧 messages 表及 `run_id NOT NULL` 保持不变。消息、Delivery、Wake、Outbox、资源 claim、预算及 Action 表组尚未实现，不能以空表或类型存在表示可用。

迁移先检查旧版本与 checksum，在 IMMEDIATE 事务内再次检查，随后建表、生成 owner、登记 v25；失败整体回滚。v1–v24 descriptor 保持原文，旧 v24 worker 明确拒绝含 v25 的库。回退应用版本前必须保留认识新 schema 的 worker，不能删表或把 threaded 改回旧 mode。

[存储仓库](../../apps/server/src/threaded/store.ts)通过注入 SQLite 句柄使用，要求外键启用。内部 `createThread` 原子创建 closed Thread、Conversation 和成员，服务端派生 owner；相同 clientRequestId 返回原记录，载荷不同冲突。它是后续实施/fixture 的服务端接口，当前未作为用户创建入口开放；不生成 Invocation、Attempt、Run 或工作区。

## 验证与限制

本阶段的迁移、认证、旧路径隔离和兼容检查由 [T02 报告](../reports/threaded-collaboration-t02-foundation-2026-10-19.md)记录。测试仅用隔离数据库和确定性 fixture，没有迁移日常业务库、启动日常服务或调用真实模型。

新执行 Binding 的生产接线、Invocation Run adapter、审批/取消/撤权/恢复状态机由 T03 完成；资源与公平性由 T04 完成。任何后续开放都须继续通过相应验收，不能仅设置 execute 即宣称支持持续协作。
