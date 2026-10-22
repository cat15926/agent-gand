# 持续协作 T08：路由、工具、征询与等待 v1

状态：已实现并通过所列隔离与真实后端子场景；生产工作入场仍关闭。更新：2026-10-21。

本合同建立在 [T07 上下文与后端](threaded-context-backends-v1.md)、[T06 运行时](threaded-runtime-v1.md)和[消息合同](threaded-messaging-v1.md)之上。实现位于 `apps/server/src/threaded/` 的 routing、tools、cooperation、tracking 与 collaboration；新增 v31，不改写 v25–v30 迁移。验证与局限见 [T08 报告](../reports/threaded-collaboration-t08-tools-waits-2026-10-21.md)。

## 路由与循环

Owner 为 Thread 以 expectedVersion CAS 配置 preferred、duty、defaultAgent 及项目群组。没有配置时明确拒绝路由，不任意选择首位成员。preview 与接收共用决策，原用户请求及目标计划持久化；同请求改正文、目标或 ACL 冲突。

用户正文点名与 Agent 行首提及分别解析，长 handle 优先，排除代码、用户引用和 URL。用户群组展开后与单独点名按位置合并；内置 all/全体/thread/本帖/全体参与者表示当前可用成员，其他群组由 Owner 配置，保留稳定成员 ID。群组名不能覆盖内置名称或成员 handle。

与固定上游 [IntentParser](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/cats/services/context/IntentParser.ts)对齐：最后一个显式 `#ideate`/`#execute` 生效；无显式意图且目标至少两个时默认 ideate，否则 execute。`#critique` 注入批判性分析提示，不改变路由或授权。串行目标按持久计划逐次续接，后者可见已授权前者结果；独立并行沿冻结 wave 消费输入，final 文本提及不启动新接力。无明确目标时按 explicit ideate 的 preferred 列表、duty、最近用户点名、最近健康回答者、preferred、defaultAgent 回退。

Agent 完整 post/final 的合法行首提及最多两个目标，自身过滤；结构化目标与文本目标冲突时拒绝。post 与 final 保持不同可引用消息及 wake。普通接力不创建业务 Action；多目标 Agent 接力采用独立并行，半截流式输出不路由。

同一成员对短回复接力第 2、3 次给可信系统提示，第 4 次阻断；超过 200 字符或成功的实质工具工作重置连续计数。路由、征询、等待、状态读取与 ACK 不算实质工具。新用户输入只重置循环计数，等待和恢复保留原成员对计数；根预算不随 wake 重置。串行续接、timer/tracking/Decision 回调不额外计作 A2A 跳数，调用和请求费用仍累计在原根。

## 工具与信息边界

工具清单是后端配置 `applicationTools` 与当前角色定义 tools 的交集，进入 Session 配置指纹；每次调用重验 started Attempt、Binding、资源、来源 ACL。模型不能提供 owner、Agent、Attempt 或 generation。未知字段拒绝，存储错误向执行边界传播；已知输入/ACL 错误返回结构化拒绝。

| 工具 | 约束 |
| --- | --- |
| post_message / cross_post_message | 显式幂等键；post/final 不互相吞并。cross_post 必须指定其他 Thread 及非空目标，发送者、来源和目标分别获权 |
| read_message / search_messages | 精确消息或字面搜索；限定当前 Thread 与冻结 inputMaxSeq；不是语义记忆 |
| read_attachment / message_sources | 附件单次最多 65,536 字节并返回完整 hash；跨 Thread 来源只展开获权引用 ID，不返回源正文 |
| mark_seen / acknowledge_mentions | 与 transport delivery 分账；不改变 Action 状态 |
| multi_mention / multi_mention_status | 持久征询及逐目标状态；状态查询不算实质工作 |
| hold_ball / track_event | 持久 timer 或带 live baseline 的事件等待，立即返回 |
| conversation_decision / settle_decision / withdraw_decision | ordinary interactive once 问题、版本化结算/撤回，不授予业务批准 |

绑定内工具请求写不可变 receipt，精确重试复用原结果，同键异内容冲突。读取的实际来源在返回模型前原子登记 `threaded_tool_context_exposures`，加入 native anchor 和以后 resume 的 ACL 检查；撤权后冷开，不能让旧 native transcript 保留已失权工具结果。当前 manifest、native 历史和工具读取中的私密来源取可见受众交集，所有衍生 post/final/征询/回调继承来源并缩小受众。

API 使用现有逐请求预算的 tool_use/tool_result 循环。SDK 0.3.288 使用实际 worker 内的 MCP server，经 IPC/RPC 回到可信 broker；原生只允许 Read/Grep/Glob，成功回执可作为实质工作。SDK 进程与 API 仍遵守 T07 可信发送、用量和静止证据合同。

## 征询与可靠结算

`multi_mention` 接受 1–3 个其他成员，默认 8 分钟、范围 3–20 分钟，callbackTo 仅原调用者。工具入口要求 searchEvidenceRefs 或 overrideReason；服务端内部 HTTP 适配端口不套用该组合要求，当前没有对外暴露匿名或 Agent 自报身份的征询 HTTP 入口。Action metadata 明确拒绝，review、parallel successor、returnToPredecessor 由 T10 单独接入。

group、targets、原 deadline 和提问消息同事务写入；每目标仅首个合法 final 被记录。原文、不同意见及 failed/cancelled/timeout 状态保留，不选赢家取消其他人，也不额外调用模型合成统一意见。被询问者的同类征询和沿来源链绕行的级联被拒绝。

末个响应或 deadline 在 IMMEDIATE 事务内竞争唯一 settlement。响应终态、逐目标状态、settlement、callback、消息、Delivery/Wake 和 Outbox 原子提交。恢复读取原 deadline，已排队但到期未启动的目标工作退休；已在途的迟到响应可正常结束其 Invocation，但不复活征询。callback 是普通明确请求的后继 Invocation，继承根预算。

回调冻结成员、角色、账号、来源和控制边界；当前 pause 保留 waiting，相同身份 resume 可继续；任何中途 stop 即使随后 resume 也永久取消旧回调。失权、Thread 关闭或来源撤权明确拒绝/取消，结算历史保留。timers 只是唤醒提示，SQLite 为真相；恢复有幂等扫描，通知可重复提示而不能重复逻辑工作。单宿主生产服务范围不变，不宣称多 worker 实时通知。

## 非阻塞等待与人类回应

注册工具立即返回，当前 Invocation 可继续并正常 final；不在工具内伪造终态或释放未知执行。后继事件早到只持久排队，同槽仍受资源互斥。hold 支持 5–3600 秒及 waitSourceRef，同 Thread/Agent 滑动一小时最多三次；同 job 精确重试不再扣额。新 wait 与旧 wait 的退休同事务，失败保留旧等待；退休等待不表示外部命令已停止。timer_elapsed 明确 `businessConditionVerified=false`。

2026-10-22 [RC01源码核验](../reports/threaded-collaboration-rc01-contracts-2026-10-22.md)确认：当前waitSourceRef为字符串，尚不等价参考的结构化kind/value/expectedSignal/SLA来源。错过timer的SLA恢复窗口/过期处置，以及专用命令wake对应的共享hold准入仍待RC03补齐；在线one-shot语义不一律改为SLA硬截止。本段记录当前实现，不表示上述缺口已通过。

tracking 由服务端安装来源及获权传输，模型不能提供 URL 或凭据。注册前读取 live facts，冻结授权指纹、baseline、subject 和 match，历史事件不触发。内置当前 Thread 消息 producer；可选 GitHub PR adapter 仅访问获权仓库固定 pull path，HEAD/state/merge 的实质变化生效，单独 updated_at 不生效。网络读取在事务外，返回后重验；来源权限改变退休等待。GitHub 目前仅注入传输验收，真实仓库业务闭环待 T10/T12。

Decision 只允许 ordinary interactive once；退役 request_user_input 返回 410。Owner 通过专用认证/CSRF/version API 向准确问题修订提交回应，产生规范 user 消息并继承原因果根及隐私。Agent settle 必须证明 responseMessageId 是自己当前 Invocation 的实际 user origin trigger，且对应当前 wait/revision、Thread、用户、创建时序和可见状态；任意另找的消息不能结算。重复操作和丢回执后的重试稳定；replace/withdraw/stop 不允许旧问题复活。该决定与原生执行审批、业务批准分开。

## 接入与范围

专用 HTTP 增加 routing-policy GET/PUT、routing-preview POST、waits GET 及 Decision responses POST；沿用稳定 owner、专用 session、CSRF、版本和 ACL。生产 service 安装 metadata collaboration 恢复端口，不安装 executor，`closed|observe|execute` 仍不放行新工作。隔离工厂显式注入后端和工具。

T09 承接 UI/回执/事件重连；T10 承接 Action、真实领域 producer、命令代际与业务完成；T11 承接 Review/Revision、SOP、知识。上游的品种群组与 custody-recognition skill 政策由本项目稳定成员配置及后续责任域适配登记，不用 T08 普通工具推断 Action 已可用。K01–K16、59 项原场景继续保留，T12 统一验收发布组合。
