# 持续协作 T05：消息、授权与持久通知 v1

更新：2026-10-20。继承 [T01 消息决策](../plans/threaded-collaboration-t01-decisions.md)、[执行边界](threaded-execution-boundary-v1.md)及[共享资源](threaded-resources-v1.md)。本阶段交付持久接收和历史读取，生产工作入场与真实执行继续关闭。

## 接收与来源

[消息仓库](../../apps/server/src/threaded/messages.ts)接受服务端主体；用户、系统及 Agent 消息独立于旧 `messages` 表。用户消息无需创建 Run。正文、来源、序号、附件、原始回执和逻辑投递只追加，不按相似正文跨来源去重。

| 来源 | 幂等身份与权限 |
| --- | --- |
| 用户 | owner / Thread / clientRequestId；owner 来自认证会话 |
| Agent 显式 post | Attempt / toolCallId；来自当前受信 Binding，Attempt 必须处于已启动状态 |
| Agent response | Attempt / responseCommitKey；已启动且静止证明有效，必须由外层事务调用专用端口 |
| 系统 | owner / producer key / requestId；生产者校验默认拒绝，不能由浏览器自报 |

同一身份的正文、目标、受众、来源或附件内容变化返回冲突；数组规范排序去重，正文保留原始字节。重复请求返回持久冻结回执，后续 Wake 状态、成员退出或暂停不改写原接收事实。Agent 重试仍须当前 Binding 有权；owner 对历史的读权与新入场分开检查。

普通接收必须拥有最外层 `BEGIN IMMEDIATE`，一次保存序号、Message、附件、Delivery、Wake 和 Outbox；任意写点失败全部回滚。响应端口 `appendResponseWithinTransaction` 要求外层事务，内部 savepoint 防止调用者捕获异常后提交半份消息。**响应与 Run/Invocation 终态的真正整合由 T06 完成**；本阶段不接模型 final 回调。已提交 post 不随后续响应失败消失。

多目标输入共享 waveId 和 inputMaxSeq，各目标独立保存 Delivery/Wake，不合并跨来源消息。后来的同波回答不能改变已冻结的输入上界；T07 再把它应用于真实 context manifest。消息目标数组是结构化获权目标，文本 mention、fallback、parallel 意图和工具入口政策由 T08 接入。

## 统一授权与附件

[ACL](../../apps/server/src/threaded/acl.ts)供写入、精确 ID、历史、搜索、附件和来源展开共用。首批仍为一个业务 owner；浏览器只有 owner 主体，不能选择 Agent 读者。Agent 读者来自服务器执行上下文，必须是当前加入、启用且角色版本有效的成员。

收件人只决定逻辑 Wake；公开消息面向获权 Thread 成员，私密消息由显式 audience 限制。私密目标必须已在 audience，Agent 作者也必须包含在私密受众中。草稿仅 owner 和 Agent 作者可读，禁止目标，不创建 Delivery/Wake；发布后正文不是草稿的静默改写。

显式 sourceRefs 逐层检查当前权限；私密来源不能转公开或扩大受众，草稿不能作为已发布来源。跨 Thread 发送要求作者和目标均获权、显式目标，私密/草稿来源不得跨线程复制；公开引用也不能使读者绕过来源 Thread 的权限。来源链上限 32 层，新增节点也计入上限，拒绝接收后不可读的第 33 层。失效非目标成员不参与当前公开读者集合，恢复后每次读取重新检查来源权限。

sourceRefs 是显式来源账本，T05 不解析或自动复制原生 transcript，也不声称仅凭正文能追踪模型的全部信息来源。T07/T08 继续接获权 context、工具和私密信息边界。

附件为本消息拥有的不可变 BLOB 与 hash，不接受任意文件路径、旧 artifact 或 URL。核心端口每份不超过 8 MiB、合计 16 MiB，最多 16 份；HTTP 接收另受 2,000,000 字节请求上限约束。历史只返元数据，下载重查母消息 ACL，固定 attachment 下载、application/octet-stream 与 nosniff，不把上传类型直接当作可执行网页。搜索先授权再计可见 limit，隐藏序号不吞掉可见页。来源递归在单次授权决定内缓存共享节点，防止多条来源汇合时指数重复查询；每次新读取重新检查权限。

## Outbox、恢复和通知

[v28 迁移](../../apps/server/src/db/threadedMessagingMigration.ts)新增消息/序号、附件、Delivery、Wake、Outbox 和消费收据；不改写 v25–v27 checksum。每个逻辑目标保存一份 Delivery 和 Wake。它们表示已接收的逻辑工作，**不等于后端 delivered、seen、mention_ack 或业务完成**。

[Outbox](../../apps/server/src/threaded/outbox.ts)仅支持 `message.created` / `wake.available` 内部 ID 提示，无正文、外部发布或执行指令。领取、续租、释放和 ACK 比较事件身份、ownerNonce、generation 与 fencingToken；到期可重领可重复的通知，原行与代际保留。旧 ACK 不能确认后继领取；未知事件、schema 或不匹配来源拒绝发送。

Wake 提示及扫描重查源消息、Delivery、Thread epoch、成员/权限版本、角色和递归来源 ACL。失权 Wake 保留为 blocked，原接收回执保持不变。paused 允许保存获权新消息；提示不赋予执行资格。关闭/退出/撤权后的取消、重新授权和实际领取由 T06 统一接线，不能靠 Outbox ACK 复活旧工作。

发送在数据库事务外，以至少一次方式提示；ACK/消费收据在事务内幂等保存。发出后 ACK 前崩溃会重发同 eventId，消费者按事件/来源去重。消息已提交但通知未发时，重启沿原回执、Wake 和 Outbox 恢复。扫描每轮从低 seq 检查重试项，分页游标不成为永久越过延迟事件的水位。

[本地通知服务](../../apps/server/src/threaded/messaging.ts)在 COMMIT 后立即排水，按批次让出事件循环，短周期扫描只作修复。坏订阅者不阻止其他订阅者收到提示；失败或异步订阅者使原事件保留重试。关闭后停止通知、定时器和 ACK。HTTP/WS 订阅在每次提示前重查会话和 Thread，WS 只发送 ID 提示，内容仍经授权读取。旧全量消息总线不承担此通道。

生产仍是一宿主、一活动服务进程。本阶段没有跨机通知传输、Wake 到 Invocation 的领取映射、根预算或真实模型上下文投递。相关证据和后续责任见 [T05 验收记录](../reports/threaded-collaboration-t05-messaging-2026-10-20.md)。
