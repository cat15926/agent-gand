# 持续协作 T12：发布控制、排空与宿主命令 v1

T12 在已推送的 T11 `ba438b1` 上追加 v34。v25–v33 源码及 descriptor 保持不变。操作步骤见[发布手册](../operations/threaded-release-runbook.md)，分层证据见[T12 报告](../reports/threaded-collaboration-t12-release-2026-10-21.md)。代码接线不表示日常服务已启用。

## 发布与身份

`THREADED_COLLABORATION_MODE` 默认 `closed`。无 `THREADED_RELEASE_MEMBERS_FILE` 时不安装真实后端。文件只接受固定 macOS、API/claude-sdk 版本、成员、角色/权限版本、模型及托管 API-key 账号版本，以及应用工具白名单和请求/输入/输出限额；不能指定密钥、任意路径或模型命令。服务按 Thread/Agent 创建规范化工作区和私有 SDK 目录，账号凭据在实际准备请求时从受信端口读取。

`execute` 还需认证 Owner 用持久 CAS 控制打开 `admissionOpen`。仅服务端固定完整名单能创建新 Thread，同时冻结成员、角色定义哈希和账号版本。历史 Thread 不自动获得授权。消息及 `threaded_release_roots` 在同一事务落库；接力、等待回应及 Action 后继继续消费原根，不因发布控制重建预算。关闭新入场后的同一已提交请求重试返回原回执，不接收第二份新根。

`admissionOpen` 与 `dispatchOpen` 独立。关闭新入场保留已接收队列；关闭派发阻止后续领取，不中断正在执行的请求。暂停、停止、审批和撤权仍走原生命周期端口。已接收根必须保留匹配的 release pack，当前角色/账号/成员或 backend pin 漂移使其明确 blocked，不静默切换后端，也不通过 queued/blocked 循环消耗事件循环。恢复匹配配置仍需重新核验当前权限。

`closed` 可在保留固定配置及派发许可时排空已有根。`observe` 需重启进入：不恢复/领取工作，不开启协作修复定时器，不确认业务通知；HTTP 除会话管理和无写入的路由预览外仅允许读取。认证内存会话不属于业务数据库。进程内动态切换模式不是支持合同。

## 启动与退出

所有模式恢复完成前 dispatcher 底层领取屏障保持关闭；显式 `startDispatch` 后才响应资源通知、提交提示和定时器。构造 runtime 或 `autoStart:false` 本身不是这道屏障。

有界 `shutdown` 先关派发、终止修复器并请求取消，等待实际 Invocation 静止。超时不宣称停止成功：持久化 unknown 并保留资源/费用围栏。合法晚到静止证据可以继续对账，但不能发布已失权响应或复活后继。服务退出不能当作供应商请求未发生的证明。

Runner 的定时器与受信 SSE/SDK 进度共同维护有界活动许可，提示节流后先在旧窗有效时原子续期，再核对完整权限和上下文。模型不能调用该端口；它不改变默认许可、根总活动预算或过期拒绝规则。取消后的晚到正文不能绕过此检查形成发布或自动释放证明。

## 排空与恢复

`GET /api/threaded/release` 是只读快照，显示 queued/running/waiting/unknown、未派发 Wake、资源、Action、命令、Outbox、等待、征询、回调、审批、进程与未知用量。仅新入场关闭且这些项全部为零时 `drain.ready=true`。其范围明确是 `threaded_only`，`wholeDatabaseRollbackReady` 始终为 false；不能据此覆盖仍有旧模式写入的整库。

v34 前向迁移记录发布 CAS、冻结授权和 OS 命令意图/事件，事件及身份不可覆写。旧 v33 worker 遇到 v34 在写入前拒绝。回退应用时保留新表、新数据和匹配的兼容 worker；一致备份必须与匹配应用、账号密钥、原生会话/工作区一起处理，并先核对外部副作用。不能降低迁移版本、删除未知预留、靠租约过期释放资源或盲重放外部请求。

## 注册的 OS 命令

`createThreadedOsCommandPort` 仅供受信宿主注册固定绝对程序、argv、环境和 cwd，并核验当前 Action/holder/generation 及注册授权。模型只可触发登记的端口，不能传任意 shell。独立命令 claim 不占 Invocation 执行槽，但仍参与旧成员独占和共享工作区冲突。

进程 token、启动时间、PGID 和宿主归属证据在发信号前校验，拒绝伪造无关 PID。取消、IPC 断开或主拥有者退出后，进程消失不等于副作用成功/未发生；unknown 保留，可信副作用核对后才能结算。旧 Action 代际的完成只记历史，不唤醒新 holder。

生产单例没有默认命令或 GitHub 来源注册；缺少 provider 的业务保持不可用。当前实际宿主命令证据仅 macOS，不构成任意代码沙箱、Linux/Windows 支持或完整语义记忆支持。
