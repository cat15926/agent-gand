# 持续协作 T09：Thread 界面与授权同步 v1

状态：已实现，生产新工作入场仍关闭。更新：2026-10-21。依赖 [T08 协作合同](threaded-collaboration-v1.md)、[消息合同](threaded-messaging-v1.md)及[上下文合同](threaded-context-backends-v1.md)。证据见 [T09 报告](../reports/threaded-collaboration-t09-ui-2026-10-21.md)。

## 独立入口与身份

侧栏“持续”打开产品“持续协作”，URL 使用 `?surface=threaded&thread=<id>`，保留浏览器前进/返回及刷新所选空间。直接进入该视图不挂载旧 StoreProvider，不读取旧房间、任务、Run 或旧 `/ws`；切回旧工作台才加载原有状态。旧 Conversation/Run 类型、草稿和消息模型不被重新解释。

`ThreadedApi` 通过专用 session 读取，用户显式连接时才使用管理认证桥签发 `/api/threaded` cookie；CSRF 只保存在当前挂载视图的内存。请求带协议版本、same-origin 凭据与 no-store，写操作使用服务端现有 CSRF/version/ACL。401 不自动签发新会话或重放写操作；远程管理未认证时可转到账户与访问设置。消息、token 和私密来源不写 localStorage。

## 只读投影

`createThreadedView` 是注入数据库的只读 Owner 投影，HTTP `GET /api/threaded/threads/:id/view` 同步当前授权事实。它不安装 executor，不修改消息、游标、Run、预算或等待；无新增 schema，仍为 v31，既有迁移源码/descriptor 不变。

| 投影 | 内容与边界 |
| --- | --- |
| 时间线 | 每页扫描最近100条存储消息并逐条重验 ACL；按原seq显示，nextBeforeSeq跨空洞继续更早页；可返回最新页 |
| 调用日志 | 最近200条 Invocation及其Attempt状态、stage、原因、时间；无原生transcript、账号凭据、执行fence或可重用Binding |
| 回执 | messageId/Agent精确delivery、seen、mention ACK事实分别显示，不用maxSeq冒充全部已读 |
| 排队与成员 | 计算持久Wake/queue，包括尚未创建Invocation的工作；暂停/停止/恢复投影与执行状态分开 |
| 等待与征询 | timer/tracking/Decision、已保存回应数、group逐目标状态、结算种类及回调等待/拒绝/取消；重新核验来源，不暴露冻结权限指纹 |
| 原生审批 | pending执行审批单列，沿T03专用审批入口，不与普通Decision或业务批准合并 |
| 业务状态 | 明确待接入；调用结束、队列清空、timer_elapsed、普通回应均不显示业务已完成 |

回放通过现有持久Outbox seq：query `afterEventSeq` 返回至多100个变化引用、throughSeq及hasMore；被当前授权拒绝的来源不返回引用，游标仍跨过被过滤的行。未来游标拒绝，不能任意选owner、Agent或内部执行身份。消息正文仅从本次授权快照/查询取得，变化引用不是执行授权或新的用户消息。

snapshot revision覆盖时间线、调用/等待/控制/回执、路由版本及能力；部分状态不产生消息Outbox，所以不能仅以消息seq判断全部界面已同步。快照的eventCursor覆盖其读取时点；客户端可以用全量授权投影替换已覆盖的失效引用，不必按旧事件重建敏感正文。

## 同步与撤权

`ThreadedSync` 先获取当前快照，再连接专用 `/api/threaded/ws?threadId=…&view=timeline&afterEventSeq=…`。服务端只发失效元数据，不广播正文、私密transcript或旧bus事件。订阅首帧和提交后提示触发重读；每秒核验权限及投影revision，捕捉控制、回执或策略等没有消息事件的变化。此周期用于只读UI投影，不承担工作调度正确性。

每次HTTP、回放、WS握手/提示/周期刷新都验证专用session、稳定owner和来源ACL；输出前再检查session。客户端收到hint重新读取获权快照并整体替换，不把旧私密缓存与新数据合并。Hint到达读请求途中安排后续读取；连接epoch防止旧socket/迟到HTTP覆盖新空间。

浏览器offline事件、socket断开或读失败立即移除私密展示。online/可重试网络错误用有上限的退避重建快照；401/403/404/409或WS1008停驻，要求用户重新连接。离开视图清理socket、timer及网络监听。断线后不沿用旧界面状态推断完成，也不自动重放模型或写操作。

## 界面与交互

时间线区分公开/私密/草稿、收件人/可见受众、独立post/final、来源和附件，完整Markdown正文保持原消息内容。查看来源是显式获权查询；浏览器阅读本身不记录Agent的seen或mention ACK。新消息在跟随底部时滚动，阅读旧内容时提示跳到最新；更早消息独立分页，避免无界私密缓存。

输入器使用服务端路由preview，支持点名、项目群组、自动/独立思考/依次执行及批判性提示；默认/值班/优先成员和群组在可访问设置抽屉中CAS保存。路由版本变化重新加载政策并刷新preview。私密消息的收件人不自动扩大受众。

提交、普通问题回应及控制各有明确请求身份；同一仍挂载交互的丢回执重试复用原ID，成功后才清空输入。回应显示“已保存，等待成员处理”，不自动结算问题。暂停/停止范围明确为空间、成员或单调用；请求成功不冒充外部进程已停止。unknown仍显示待核实与原执行围栏语义。

桌面显示成员/调用侧面板，手机使用可关闭覆盖面板避免与输入区重叠；路由设置使用具备焦点约束、Escape及滚动的原生dialog。界面显示保存/排队/执行/上下文交付/等待/业务完成的区别，计数标注当前页或日志范围。

## 发布边界

新建空间和真实执行尚未开放；前端按实际能力禁用新消息/Decision，服务端`closed|observe|execute`仍拒绝新工作。仅隔离UI fixture明确安装允许入场的注入端口，不修改生产开关。历史、路由配置及合法控制可使用已有专用端口。

T09验收覆盖实际Chrome、临时SQLite与真正的隔离HTTP进程SIGKILL/重启；模型响应为注入，不构成真实供应商或日常业务验收。UI呈现正式消息与持久状态，未发布原生token流；不能把临时流式正文当正式接力。T10 Action/领域完成、T11 Review/Revision/SOP/知识与T12完整发布、平台及真实故障组合仍按兼容矩阵验收。
