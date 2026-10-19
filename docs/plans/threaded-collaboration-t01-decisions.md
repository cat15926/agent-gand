# 持续协作 T01 设计决策与实施接口

状态：**已批准的实施基线**（依据用户已确定路线与 T01 实施授权冻结；运行代码尚未实现）。日期：2026-10-19。

本决策服务于[实施指导](threaded-collaboration-implementation-guide.md)中的 T02–T12。“持续协作”为产品名称，内部模式为 `threaded`。核心规则不做简化；平台差异、可靠性增强和高级范围分别登记在[兼容矩阵](threaded-collaboration-compatibility-matrix.md)。这里的类型、表和接口均为待实现合同，不表示当前 API 已可调用。

## 1 模式与生命周期

采用独立 `threaded` 模式，首版一间 Conversation 对应一个 Thread，`conversation_id` 唯一。扩展共享 `RunMode` 的明确分支；既有 pipeline、supervisor、collaboration 值及 HTTP `entryVersion: 2` 均保留原义。Threaded 不创建旧编排请求、旧 Subject 或旧 Batch 来取得执行资格。

HTTP、工具、领域记录分别使用 `threaded-http-v1`、`threaded-tools-v1`、`schemaVersion: 1`；这是独立命名空间，不复用现有 Tool API 版本号。能力快照分别报告实现、配置准入、真实验证，未知版本拒绝。

一个 Invocation 固定关联一个执行 Run；一次重试创建新 Attempt，保留 Invocation、Run、wake 来源和根预算。执行 Run 在第一次领取时与绑定同事务创建，冻结成员、账号和策略版本；同一 Conversation 内并发 Invocation 的 `turnNo` 分配与插入不得跨越事务。可重试的 Attempt 失败不终结 Run。权威状态归 Threaded，Run 是兼容执行、Trace 和用量的投影。

| Threaded 状态 | Run 投影及资源行为 |
| --- | --- |
| queued | 未领取时可无 Run；重试等待时 Run 为 pending；无新外部执行 |
| running | Run running；有有效 Attempt 与资源 claim |
| running 且原生审批待决 | Run awaiting_approval；实际原生进程和 Session 仍受围栏约束，不假装已释放 |
| waiting | 确认执行已静止后的持久暂停/恢复条件；Run waiting_for_user；不占计算槽，保留必要未知副作用围栏 |
| unknown | 无法确认调用或副作用；Run waiting_for_user 加明确对账原因，不当作终态，不自动重试或释放未知占额 |
| completed / failed / cancelled | 以本模式终态证明和当前代际原子提交 Run 对应终态、响应、必要 wake/outbox |

`hold_ball` 与 ConversationDecision 注册持久等待后立即返回工具结果，不阻塞模型等待用户，也不因创建等待而强制终止当前 Invocation。当前调用仍可继续，最终通过正常响应终态提交结束；事件到达后登记继承同一因果根和有效 Action 责任的后继 wake。若事件早于当前调用结束，wake 持久排队，由同槽互斥阻止后继提前启动。技术性审批恢复可继续同一 Invocation，但先核验工具回执、后端恢复锚点与 Attempt 所有权。旧终态不能逆转，新意图创建新 Invocation。

## 2 稳定身份与入口授权

首版明确为**单个部署、单个业务所有者**，不宣称多租户。T02 建立数据库级唯一 `instance_owner_id`（服务端生成 UUID，随数据库保留），Thread owner 由它派生，不能由客户端或模型自由指定。

[accounts/access.ts](../../apps/server/src/accounts/access.ts) 的 `managementOwner` 是短期 cookie 摘要，session 只有八小时且在内存中，cookie Path 为 `/api/accounts`；它只作当前认证凭据和审计主体，不作持久 Thread owner。

冻结以下接入方案：

1. 经现有管理认证和 CSRF 检查的 `POST /api/accounts/threaded/access-session`，签发专用、短期、HttpOnly、SameSite cookie，Path 为 `/api/threaded`；不扩大旧 cookie 路径。共享底层会话验证原语，旧账户接口行为保持不变。
2. 新 `/api/threaded` 下的查询、提交、历史、文件、Trace、控制及 `/api/threaded/ws` 均校验可信 Host/Origin、登录会话及对象 owner；写入另校验 CSRF。管理 session 与专用 session 的创建、续期、注销分别可追踪。过期只停止新用户请求，不取消已授权工作。
3. Agent 工具及原生回调只接受服务端签发的 Invocation/Attempt 绑定，执行前、工具前、提交前都核对 authorityEpoch、owner/generation；不持有或获取浏览器管理凭据。
4. 工作取消、账号撤销、权限收缩增加执行授权 epoch；授权失效与浏览器登录过期分开管理。跨 Thread 发送必须检查目标成员与源内容授权。

[旧 `/ws`](../../apps/server/src/api/ws.ts) 无鉴权且广播全部 bus 事件。Threaded Message、Run、Trace、工具事件不得从旧广播输出；共享 emit 入口需识别归属并交给获权投影。旧 `/api/runs`、conversation history/task-state、搜索、产物及观测查询也必须过滤或拒绝 Threaded 对象，避免通过 ID 或列表绕过新鉴权。没有 executionBinding 的 Threaded 执行一律拒绝，不能落入 [authority.ts](../../apps/server/src/execution/authority.ts) 的历史兼容放行。

这项认证适配在 T02 建查询边界，T03 完成执行边界；ISO03、CTX02、UI01 增加旧 HTTP/WS 旁路用例。界面登录可复用现有连接体验，已授权消息不逐条弹确认。

## 3 消息存储与版本迁移

采用独立 `threaded_messages`，不修改旧 `messages.run_id NOT NULL`。Threaded 用户、系统、Agent 消息均可独立引用 Thread；只有实际执行产物带 sourceInvocation/sourceAttempt。跨模式历史只通过显式选择与授权导入，保存不可变来源，不自动复用原生 transcript。

| 表组 | T01 冻结的最低约束 |
| --- | --- |
| `threaded_instances`、`threaded_threads` | 稳定 owner；Conversation 唯一；mode/policy/schema 版本、authority epoch、状态和控制请求 |
| `threaded_members` | `(thread_id, agent_id)` 唯一；角色/账号/权限版本、稳定 handle、加入/退出状态 |
| `threaded_invocations`、`threaded_attempts` | Invocation 到根预算、wake 来源的关系；`(invocation_id, attempt_no)` 唯一；当前 Attempt、owner、generation、执行确认阶段 |
| `threaded_run_bindings` | invocation_id 与 run_id 各自唯一；mode 和 origin 可验证，禁止多个 Run 承担同一 Invocation |
| `threaded_messages`、`threaded_deliveries` | `(thread_id, seq)` 唯一且事务内分配；sender、受众、正文 hash、请求身份、因果来源、投递用途及路由版本 |
| `threaded_wakes`、`threaded_invocation_wakes`、`threaded_outbox` | 来源到目标与路由用途唯一；原 wake 映射不丢失；事件消费幂等；领取 owner/generation 可审计 |
| `execution_resource_tickets`、`execution_resource_claims`、`execution_resource_epochs` | 所有模式共用竞争入口；资源集合原子领取；释放不删除单调代际来源；历史 owner 不可修改新 claim |
| Session、context delivery、Action、wait、consultation、budget 表组 | 按 T07/T08/T10 的独立实体推进；当前只冻结责任、版本、来源和原子边界，不提前建空能力注册表 |

所有新记录明确模式归属与 schema version，保留创建/更新时间和审计因果 ID。行版本、租约 generation、授权 epoch、协议版本分开，不能用同一整数代替。

T02 采用前向增量迁移。当前源码最高 v24，若基线不变下一版本为 v25；实施时由集成负责人分配实际下一个编号，禁止并行占用或修改历史 descriptor/checksum。先执行兼容检查，再建表、补列与索引，最后登记迁移。重复启动幂等；旧 v24 worker 遇新版本明确拒绝写入。T03/T04 的字段扩展各用后续迁移，不回写已发布 v25。

业务库不在 T01 读写范围。后续迁移验收使用独立 SQLite，覆盖空库、v24 合成历史、重复迁移、失败回滚及旧 reader/writer 拒绝；不能把 CREATE TABLE IF NOT EXISTS 当作已有列升级。回滚保留新表与兼容 worker，不删数据、不改回旧 mode。

## 4 持久接收与响应终态

用户提交键为 `owner/thread/clientRequestId`，工具消息为 `attempt/toolCallId`，wake 为 `sourceMessage/target/routingPurpose/routingRevision`，响应为 `attempt/responseCommitKey`。同键不同正文、目标或受众返回 `IDEMPOTENCY_CONFLICT`；新 toolCallId 仍须通过 Action 业务身份去重。

T05 默认不做跨来源 wake 合并；同一成员按持久 seq 处理独立消息，重复逻辑投递复用原回执。显式多目标输入冻结同一 wave 的上下文截止位置，各成员有独立 Invocation；先完成者的答案不能进入本波独立思考输入。后续若增加合并优化，必须保留全部来源与逐条投递事实，并另登记兼容结果。

事务端口分三处：接收 Message/Delivery/Wake/Outbox；领取 Invocation/Attempt/Run/claim；提交响应/终态/后继 wake/outbox。网络、文件外部副作用、模型等待均在事务外。显式 post 已提交内容不随 final 失败消失；final 对同一成员的合法提及另有消息身份与 wake。

`InvocationTerminalProof` 由服务端在事务内验证：mode/origin、当前 Attempt、owner、fencingToken、authorityEpoch、可用响应或已核实失败/取消证据、工具与费用对账状态，以及所有必要 outbox。普通响应完成只证明此次调用合法结束，Action 完成另走领域解析器。已知响应而费用未知可记录待结算并按冻结策略处理，不能把费用未知误作执行未知或直接当免费。

共享终态入口按证明类型显式分派；旧完成路径仍要求 accepted Completion Evaluation。禁止创建虚假旧评估、把 Threaded 送入旧 closeExecution、使用兼容 finishRun 跳过新账本。响应、Run、Invocation、后继通知必须同事务一致。

公共 [runner](../../apps/server/src/execution/runner.ts) 当前的异常处理会写 failed/cancelled，finally 会释放 Session 和成员资源；Threaded 不得原样继承。适配器在状态提交和 cleanup 前区分“确认未启动、确认静止、执行未知、仅费用未知”。执行未知保留原 Attempt 的真实 Session、工作区及容量 fence，只有 `QuiescenceProof` 和副作用对账允许释放或换代；人工继续、重试、resume 也不能绕过。仅费用未知按费用预留处理，不无故保留已静止进程的执行锁。T03/T04 必须覆盖“runner 抛错但子进程仍活着”的 fixture，并证明旧 finally 不能释放后继 claim。

## 5 混合资源与公平性

旧模式取得 Agent exclusive claim；Threaded 取得 `(instance_owner, thread, agent)` slot，同时检查是否存在旧 exclusive claim。同 Agent 不同 Thread 可并发。真实原生 Session 按后端/账号身份/宿主/nativeId 单独互斥，不能只锁配置 hash。工作区、账号容量、平台容量为独立资源。

执行资源以一个持久 ticket 声明完整集合，在 BEGIN IMMEDIATE 中一次取得；拿不到则不保留部分执行资源，避免多个等待者互相占住资源。授权、预算检查后才允许外部启动。运行中的未知进程作为受控占用保留，不因租约到期直接抢占。

Session 身份在执行领取前准备：先在策略绑定的短期元数据锁/CAS 下重读配置与 nativeId；首批 Claude SDK 冷开预分配并持久记录 UUID，API 仅记录重建上下文绑定。形成带绑定版本的资源集合后，领取事务重新校验版本、权限和 nativeId，再原子取得 thread-slot、实际 Session、容量及工作区资源。准备阶段不启动模型、不占执行容量；竞争失败释放元数据锁后排队，不持锁等待其他执行资源。版本改变则重新解析，不能拿着旧 nativeId 的锁启动。收到意外 nativeId 或运行中旋转身份时，先停止后续 resume/工具派发并进入身份对账；合法换绑须重新经过互斥与 CAS，不能在旧 claim 上静默替换。只有启动后才提供 ID 的扩展载体首批关闭，后续须单独验证冷开身份预留、绑定提升与冲突恢复协议。

冻结的公平规则为：同 Agent 同槽 FIFO；最早待执行的旧 exclusive ticket 是该 Agent 的屏障，后到的新 thread-slot 不得插队；不同 Thread 由持久 last-served 次序轮转，每轮最多启动一个合格 ticket，同优先级再按入队 seq。等待权限/预算而不可执行的 ticket 不占计算槽；恢复可执行时保留原排队年龄。紧急取消不排队，普通用户消息不能自报优先级绕过屏障。

共享容量由实际 model call/native invocation 的唯一 claim 计量，一次逻辑调用不因 Run 与 Attempt 同时存在被重复扣额。保留旧模式局部并发限制，增加全模式共同上限；默认初始全局容量、Thread 容量和账号容量均取当前协作配置值 3，可由 Owner 显式配置并随策略冻结。账号与提供商实际限制更低时取更小值。跨模式争用引起等待是登记的平台差异，不承诺旧模式吞吐量不变。

每次有效取得资源递增持久 generation，并绑定 claimId、ownerNonce、Attempt。续租和释放同时比较这些字段；释放活跃 claim 后保留 epoch。代际编号不能因删行而回到 1。容量释放后主动通知可执行队列，周期扫描只作修复；验证“释放与新入队竞争”不丢唤醒。

## 6 上下文与成员会话

稳定 Session 策略键包含 instance owner、Thread、Agent、角色/system prompt 版本、后端及版本、模型、账号 identity generation、工作区 canonical path、工具/权限版本和信息边界。相容时跨 Invocation 续接；权限收缩、账号变更、Thread 改变或安全边界变化冷开，原有暴露事实不可删除。

Context manifest 保存消息/附件 ID、版本/hash、ACL 判断、用途、token 估算、截断及摘要来源。delivery、seen、mention_ack 各自落账；最大 seq 不代替单条投递集合。先记发送意图，再根据实际后端确认边界登记 delivered；没有可靠 ACK 时记 unknown，恢复依赖后端锚点，不能无条件重投。

API 使用服务端维护的成员上下文和来源账本，明确报告 `sessionKind: reconstructed`；claude-sdk 使用真实 native session 并报告 resume/cold 原因。两者均保留核心上下文合同，但不宣传同一种原生续会话能力。精确查询、检索展开、附件和跨线程读取都先授权；现有同 Run Evidence 安全边界保留，由独立 Threaded 引用授权跨 Run 使用。

写入使用获权工程工具。共享工作区以 canonical workspace claim 串行写入；需要并行写时使用每工作分支的隔离 worktree，显式合并和版本验收。只读与写入冲突按资源声明处理，不能让 shell 的未声明写入绕过 claim。工具允许列表、账户私有目录与执行配置保护继续生效。

## 7 控制与等待

| 操作 | 冻结语义 |
| --- | --- |
| 暂停 Thread/成员 | 可以保存获权新消息并排队，停止新领取；在途调用收敛到安全边界，显示 pausing/paused 的实际控制进度 |
| 停止 Invocation | 撤销当前执行代际，取消该 Invocation 未启动工作；确认外部结束后释放资源，不能影响其他成员；保留 Action 待处理责任 |
| 关闭 Thread | 立即关闭入场与领取，明确取消排队工作，撤销在途执行；外部静止和 outbox/费用对账收敛前显示 closing，不能提前声称 closed |
| 归档/重开 | 仅已关闭且外部状态已处置可归档；取消归档回到 closed，Owner 显式重开后再接受新工作；旧 Action/等待不自动重放 |
| 退出成员/账号撤销 | 增加授权 epoch，停止其新工作并对账在途执行；未完成责任可见，合法替换走独立 Action 合同 |
| 模式 closed / drain | closed 拒绝新意图；既有工作是否排空由独立 drain 策略决定，outbox 和必要对账不随入场开关停止 |

Thread 持久主状态为 open/paused/closed/archived，另存 control request 的 desiredState、version、quiescence（pending/confirmed/unknown）表达异步收敛。恢复、领取同时检查主状态与未完成控制请求。

Hold/timer、获权命令等待、PR/issue tracking、ConversationDecision 分别建记录。timer 只证明时间到；外部 tracking 冻结 live baseline；Decision 回答版本和真实用户消息绑定，不能替代批准。等待到达后先检查源授权和 Action generation，再登记唯一 wake；旧代际结果可留审计，不能复活责任。

## 8 预算与防循环

用户独立新工作建立 causal root；同意图幂等重试、Decision 回答、post/cross_post、征询、Action 替换/修订及定时唤醒继承原 root。用户显式开启新工作才获得新根预算，模型不能自建预算根。根的暂停、增加预算和期限调整留下 Owner 决策及版本。

首版策略采用现有配置中的数值作为新模式初始选择并单独冻结：根最大输出 300000 tokens、单次最大输出 24576 tokens、最多 20 次 Invocation、每个 Invocation 最多 2 个 Attempt（含初次）、根累计活动执行时长 30 分钟、已知计价下估算费用上限 5 USD。24576 来自模型级默认值，不是沿用当前 scoped 单次 12288 的政策；旧模式不因此改变。重试须满足确认未启动或已核实可重试的条件，不能重放 unknown。Invocation 数、Attempt 数、实际 provider request 数分别记录，每次实际请求都预留并结算 tokens、费用和活动时间；一个 Attempt 内的工具循环不视为免费请求。新 Threaded 文本 A2A 深度按参考默认 15，不沿用旧协作的 12。具体配置可由 Owner 在新工作前修改，已有根不随环境改变；达到限额暂停待决，不关闭 Thread。这里的活动时长是新模式的累计计量合同，不直接复用旧 Run 的墙钟超时。

持久 timer/Decision 等待不扣活动执行时长，但已经消耗的时长不重置；实际模型和工程执行的计时持续落账。时长按各实际 Attempt 的活动区间求和；同 Attempt 中模型与嵌套工具的重叠区间取并集，不重复累计 Run/Attempt/native call 投影；不同并发 Attempt 各自计量后相加。Owner 另外设置绝对 deadlineAt 时按墙钟执行，暂停或 hold 不自动延长；恢复发现到期时请求合法预算修订。未知费用和未知执行独立占额；没有价格/usage 时按冻结未知预留政策处理，不能免费放行。默认记录 owner 的 24 小时时间窗用量，额外时间窗上限为显式配置；只承诺预留和停发，不承诺供应商硬账单封顶。

防空转根据持久因果链重建，区分实质工具与路由/hold；警告、阻断和新用户输入的重置条件按参考 Worklist 规则移植。预算、链深度、反级联是不同限制；不能只用总 tokens 限额代替路由循环判断。

## 9 Action 权威来源与首批范围

普通 home Thread 的 Action 责任、Review/Revision、SOP、基础知识与 ACL 是首版最终交付目标；阶段 4 的核心协作里程碑仍不代表这些已经完成。

`task_done` 首批接入本平台任务存储：服务端领域 facade 校验可信 actor、任务身份、责任代际、当前状态版本与冻结验收条件，再接受合法状态转换。完成候选解析持久转换事实；不能直接信任模型传 status，也不能让旧 task API 修改被 Threaded 绑定的任务而绕过校验。原任务服务继续服务旧任务。

`review_delivered` 首批接入明确 GitHub PR 版本的评审交付：以 `repository + PR number + current HEAD SHA` 定位；服务端读取获权 GitHub 事实确认 HEAD，绑定经认证 reviewer、published review delivery、verdict/findings 和 accepted-source。评审报告可合法交付到当前 Thread；向 GitHub 发布评论或 review 是另一个需授权的副作用，不作为默认必做动作。领域适配器冻结 producer、resolver、freshness 和权限映射，连通真实系统并完成 A04/A05 前不得进入 active registry。无凭据、远端不可达或版本未知时明确不可验收，不用缓存旧 HEAD 通过。

本平台任务和 GitHub PR 是冻结的首批领域来源，T10 负责具体适配合同和真实闭环。ArtifactReview 可在后续追加已注册 subject kind，不能拿它替代已经承诺的 PR 新鲜度验收。未经实现的完成谓词拒绝，完成候选不会直接改变任务或 PR 状态。

SOP 用 expectedVersion CAS；模型 attested 与机器 verified 分开。基础知识提供可授权的 anchor、近期事件、来源展开、过期/替代标识；完整语义检索为单列高级能力。MEM01 含多种访问方式，未完成语义部分时整项不能标为全通过。

## 10 后端与平台准入

| 组合 | 发布定位 | T01 证据与后续门槛 |
| --- | --- | --- |
| builtin-llm API，macOS | 首批实现/真实验收目标 | 现有 provider/tool loop 可复用；Threaded 适配未实现。验证精确上下文、取消、usage、unknown、协作工具和真实业务 |
| claude-sdk 0.3.288，macOS | 首批原生连续会话目标 | 版本来自当前依赖及 driver；现有 start/resume/cancel 机制可复用，Threaded 连续会话、ACL 与恢复须重新验证 |
| 上述两类，Linux | 后续平台验证目标 | 源码有 POSIX 路径，不等于当前验证；完成 OS01、驱动/会话、权限与恢复证据才开启 |
| codex-app-server 0.159.2、claude-cli、codex-exec | 扩展后端，首批关闭 | 既有 driver 不代表支持新工具/Session；按载体另审准入，不改变旧模式当前支持 |
| WSL / Windows 原生 | WSL 单列待验证；Windows 原生首批范围外 | WSL 不从 Linux 推定通过；Windows 需独立宿主身份、进程树取消与恢复合同 |
| Collective 特殊隔离、完整语义记忆、多租户/多机 | 首批范围外或后续专项 | 普通 Thread 的公开/私密 ACL 和基本知识仍为核心，不能被这一行排除 |

真实模型和业务验收在 T07/T10/T12 使用隔离实例、明确账号与预算执行。T01 只核对源码与环境，不读取或调用日常业务账号。

## 11 T02 至 T04 的接口草案

以下签名表示责任边界，实际代码可拆分文件；序列化客户端 DTO 不包含可自授权字段。

```ts
type ThreadedBinding = {
  schemaVersion: 1; id: string;
  origin: 'threaded_invocation_attempt';
  threadId: string; invocationId: string; runId: string; attemptId: string;
  ownerId: string; agentId: string; authorityEpoch: number;
  claimId: string; generation: number; fencingToken: string;
};

interface ThreadedLifecyclePort {
  requestControl(command: TrustedControlCommand): ControlReceipt;
  resumeAfterApproval(approvalId: string): void;
  revokeAccount(accountId: string, identityGeneration: number): void;
  reconcile(invocationId: string): RecoveryPlan;
}

interface InvocationExecutionPort {
  execute(input: {
    binding: ThreadedBinding; contextManifestId: string;
    sessionBindingId: string; budgetAuthorizationId: string;
    signal: AbortSignal;
    onEvent: (event: ScopedExecutionEvent) => void;
  }): Promise<ExecutionOutcome>;
}

interface ExecutionResourcesPort {
  enqueue(input: TrustedResourceRequest): ResourceTicket;
  tryAcquire(ticketId: string): ResourceClaim | WaitingReason;
  heartbeat(claim: ResourceClaimIdentity): void;
  release(claim: ResourceClaimIdentity, proof: QuiescenceProof): void;
}
```

这些类型名称尚未存在。Binding 保留共享 ExecutionBinding 的必需字段；id 由服务端为当前 Attempt/执行代际签发并持久保存，不接受调用者任意选择。trusted command/request 从服务器身份与持久记录构造；状态、Epoch、Run 归属必须从数据库重新检查。取消通过 AbortSignal 加持久 fence 双重实现，回调不能仅凭尚未中止的 signal 提交。

| 包 | 可独立评审的交付 | 退出门槛 |
| --- | --- | --- |
| T02 | shared `threaded` 分支；默认 closed 配置；专用认证及查询边界；Thread/Member/Invocation/Run binding 最小 schema；迁移/能力版本检查；旧入口显式拒绝/排除；无真实 executor | 旧模式类型检查/回归；旧 HTTP/WS 不泄露新数据；DB03；关闭入口不能产生执行、预算或工作区副作用 |
| T03 | 可信 Binding 捕获与校验；Run adapter、生命周期与终态证明端口；审批/控制/撤销/恢复接线；fake executor；所有无绑定新执行拒绝 | ISO02–ISO05；Fake 模型调用数为可断言计数；Attempt 重试不终结 Run，旧回调不提交；无需虚假旧完成输入 |
| T04 | 全模式资源 tickets/claims/epochs；Agent 独占与线程槽兼容；真实 Session 锁；共享容量、公平轮转、释放通知、未知进程 fence | Q01–Q06 的资源场景；同 Agent 跨 Thread 能并行、混跑不越权、旧 exclusive 不饥饿；对外真实执行仍关闭 |

T05 可在 T02 契约冻结后并行实现消息与 Outbox，T06 必须等待 T03–T05。T02 不通过填假响应提前公开运行；T03/T04 可用隔离 fixture 和 fake executor 验收边界。

## 12 状态与变更规则

本决策冻结实现路线与行为合同，不代表任何 Threaded 验收 ID 已通过。T02 起因源码证据需要改变方案时，记录具体差异、原因、受影响合同和用例；核心规则不得以平台适配为由静默删减。参考版本升级单独审阅，不自动追随远端 HEAD。

与本决策配套的[接入地图](threaded-collaboration-integration-map.md)、[兼容矩阵](threaded-collaboration-compatibility-matrix.md)、[基线报告](../reports/threaded-collaboration-t01-baseline-2026-10-19.md)和[实施状态](threaded-collaboration-implementation-status.md)构成 T01 交接。运行契约实现并验收后，再提炼到 `architecture/`。
