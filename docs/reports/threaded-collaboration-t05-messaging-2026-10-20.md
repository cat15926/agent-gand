# 持续协作 T05 消息账本验收记录

日期：2026-10-20（Asia/Shanghai）。基线：T04 `12d99e6` 已推送 `origin/main`。本轮新增 T05 实现、测试与文档，留在工作区，未提交/推送，未回写 Issue。

## 实现及证据

交付[消息合同](../architecture/threaded-messaging-v1.md)：独立不可变消息及来源、用户/Agent/系统幂等身份、统一 ACL、owned 附件、冻结 wave、接收事务、持久 Outbox 与消费围栏。生产历史 HTTP、认证 WS 的 ID 提示及启动修复已接入；新意图入场和真实 executor 继续关闭。

| 检查 | 结果及范围 |
| --- | --- |
| `pnpm verify:threaded-messages` | 19 组通过；真实多进程并发同请求、同键异内容/目标/ACL 冲突、post/response 来源分离、Agent started/Binding/证明、私密/草稿/附件/派生 ACL、32 层上限、失效非目标成员、冻结 wave、接收各写点与 response savepoint 故障、只读库、提交后真实进程退出、Outbox 双 worker/旧 ACK/通知与 ACK 间崩溃、递归撤权与通知重试 |
| `pnpm verify:threaded-message-api` | 5 组通过；共享来源图查询有界且每次重验、真实认证桥、HTTP/CSRF/版本/主体伪造、历史/搜索/来源/附件、跨对象拒绝、默认三种模式仍关闭入场、隔离注入端口回执稳定、WS ID 提示及注销隔离 |
| `pnpm verify:threaded-message-notifications` | 9 组通过；真实提交先于提示、外事务回滚、坏/异步 listener、重入入队、205 事件分批排水、关闭与重启、关闭中断 fanout/ACK、延迟通知修复 |
| `pnpm verify:threaded-migration` | 11 组通过；真实冻结 T04/v27 → v28、迁移中途故障回滚、旧资源/Session/Thread/Invocation 保留、历史 checksum 和旧 worker 拒写 |
| `pnpm verify:threaded-access`、`verify:threaded-isolation`、`verify:threaded-controls` | 通过；既有认证、关闭入场、执行/控制与恢复边界 |
| `pnpm verify:threaded-legacy-boundary` | 通过；增加真实 T05 私密消息/附件，旧 HTTP/搜索/WS 不暴露；旧记录和消息计数保持原契约 |
| `pnpm verify:threaded-lifecycle`、`verify:threaded-resources`、`verify:runtime-terminal` | 通过；T03 生命周期 21 组、T04 资源 19 组与旧原子终态回归 |
| `pnpm typecheck`、`pnpm verify:docs`、`git diff --check` | 通过；shared/server/web、文档本地链接及差异空白，新增文件另检 |

测试使用临时 SQLite、目录、fake executor 和可控 IPC。消息、HTTP、通知专项均拦截外网；无供应商推理、日常业务库访问或真实业务副作用。Outbox 进程退出测试发生在临时消息事务提交后，未启动原生模型进程。

交叉复核修复：prepared Binding 不能发布 Agent 消息；not_started 证明不能伪造响应；外层捕获故障仍不会留下半份 response；第 33 层来源整笔拒绝；disabled/stale-role 非目标成员不误阻公开派生；关闭通知服务后不继续调用后续订阅者或 ACK。HTTP socket 测试清理同时关闭 injectWS 的客户端和服务端测试连接。

## 原验收 ID 的范围

| ID | 本轮结论 | 后续责任 |
| --- | --- | --- |
| DB01、DB02、M03 | 持久接收稳定回执及内容/目标/ACL/附件冲突通过 | T06/T08 将原身份贯穿调度和真实工具 |
| DB03 | v28 前向升级、故障回滚、重复启动和旧程序拒绝通过 | 后续迁移及发布回退逐版演练 |
| M01 | 不同 post/response 来源的消息与 Wake 身份分离通过 | T06 真正 final/终态事务；T08 合法文本提及路由 |
| M02、CTX01、CTX02 | 显式跨 Thread 来源、普通私密/草稿/附件/搜索/来源展开 ACL 子场景通过 | T07 context 与私密工具来源；T08 cross_post 入口及真实接线 |
| CTX03、CTX05 | ACL 空洞不消耗可见页；多目标 wave/inputMaxSeq 不被后续回答改写 | T07 实际 token 预算、manifest、投递与游标 |
| CTX04 | 平台逻辑投递与内部通知收据明确分开，未冒充后端事实 | T07 delivered/seen/mention_ack 分别落账 |
| REC01、REC05、REC06 | 消息/通知故障、重启同身份、代际与数据库不可写子场景通过 | T06 领取/响应/根预算完整闭环；T07 后端 unknown |
| Q05、ISO05、UI01 | 持久提示、授权只读 HTTP/WS、响应事务接入端口已提供 | T06 drain 和响应终态、T09 UI/重连/进度完整验收 |

消息仓库的 response 端口只有 savepoint 和来源/证明校验；本轮没有将其自动接入 T03 Run/Invocation 终态。系统生产者默认拒绝，工具/MCP 尚未开放。根预算、等待/征询、Action、三类后端游标、完整语义记忆以及真实后端/平台均不由本轮模拟验证推定通过。

K01–K16 和原 59 项场景/“必须观察到”保留，E01–E06 持久征询增强仍单独待验。下一项为 T06，详见[实施状态](../plans/threaded-collaboration-implementation-status.md)。
