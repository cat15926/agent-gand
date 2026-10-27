# 持续协作：征询与可靠性验收合同 v1

更新：2026-10-27（Asia/Shanghai）。RC08 以已推送 RC07 `6ca44fb` 为基线，承接 [T08 协作合同](threaded-collaboration-v1.md)、[RC05 故障恢复合同](threaded-fault-recovery-acceptance-v1.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。本轮实现及所列分层验收完成，原 T08 取消仍未定位，真实故障组合限制保留；当前变更未提交，结论以 [RC08 报告](../reports/threaded-collaboration-rc08-consultation-2026-10-27.md)为准。代码 schema 保持 35，日常保持 closed，未配置、启用或迁移；本合同不授予发布许可。

## 原始诊断与本轮证据

[T08 首次真实报告](../reports/evidence/threaded-t08-real-tools.json)记录双成员征询中的 SDK 成员 cancelled，断言原预期 completed，但没有可信的取消触发原因。该次执行仍有 collecting group、cancelled/pending 目标；后续新隔离场景成功不是该失败实例的恢复。原报告、[脱敏审计](../reports/evidence/threaded-t08-real-audit.json)和[新场景复验](../reports/evidence/threaded-t08-real-consultation.json)各自保留，不改写历史结果。本轮[历史诊断](../reports/evidence/threaded-rc08/history-diagnosis.json)只读核对发现原临时取证目录均只余空目录，已无 SQLite 或 SDK 原生记录；原报告也未导出准确 Invocation、Binding、request 身份和错误原因。因此本轮不能复核原始触发点，历史取消根因继续未定位。

诊断必须区分原运行的事实、对当前版本的可复现问题及新成功路径。当前代码可复现相同终态并不证明原运行由同一原因触发；没有原 request、Binding、权限/预算/控制版本或可信错误码的证据链时，历史根因继续标为未定位。SDK 宿主静止只证明所述本地进程停止，不能补造未收到的供应商用量、原响应或回执。

SDK 新诊断仅接收实际 `ThreadedAuthorityError`、`ThreadedBudgetError` 或 `ResourceCoordinatorError` 实例中不超过 160 字符、符合 `THREADED_`/`RESOURCE_` 大写代码格式的首个 code，在失败结果及运行时事实中保留。普通 Error 的原始文本、伪装前缀和任意 SDK/供应商字符串不作为可信诊断；取消与静止证明的原有终态语义不变。这只改善当前可复现失败的诊断，不能恢复历史缺失原因。

新诊断只保存必要的白名单错误码与绑定事实，不能导出密钥、请求头、模型私有 transcript 或日常消息。失败、重试、注入类型和清理结果都单独记录，不能覆盖失败 JSON，不能把 runner 的预期或补写字段当作生产事实。

## 不变的征询规则

`multi_mention` 保持 1–3 个其他成员，默认 8 分钟，范围 3–20 分钟；callbackTo 只允许原调用者。工具入口要求 searchEvidenceRefs 或 overrideReason，服务端内部适配端口与工具入口的政策差异显式登记；引用存在不证明搜索结论正确。Action、review、parallel successor 和 returnToPredecessor 仍按各自责任合同处理，不借普通征询绕过准入。

group、目标、提问、来源边界及原 deadline 原子持久化。每个目标只收首个有效 final，逐字保留获权原答和 failed、cancelled、timeout 等目标状态，不用赢家取消其他成员，也不追加模型调用合成统一意见。部分完成只形成一个 partial 结果；同一 group 的结算终态和结果版本不可变。

被询问成员不能发起同类征询或沿来源链绕行级联。非目标响应、重复响应和过 deadline 的迟到响应不改变已结算结果；已在途的 Invocation 可以独立结束，但不复活征询或增加第二个 callback。后继工作继承原 causal root 与预算，不能通过新键、新 group 或重启获得新额度。

## 丢回执与精确重试

M03 要求消息/工具的逻辑身份在请求超时或回执丢失后稳定。相同受信 Binding、工具请求 ID、幂等键和完全相同的内容应查回原不可变 receipt，原消息、group、目标工作、settlement 和 callback 各自保持唯一；同键异内容必须冲突。不得因客户端没收到结果就推断服务端未提交，也不能靠改键强制创建第二份征询。

服务端已提交但返回路径失败，与供应商发送前拒绝、发送后未知是不同故障。验收分别记录数据库提交、工具返回/传输中断和后续重试边界；隔离 broker 抛错不等于真实网络丢包，工具端口测试不等于实际 index 或 SDK MCP 全链通过。无法证明已发生的输出继续保留 unknown，不补造最终回复。

## 独立可靠性增强

E01–E06 是本地持久增强，不属于原 59 项，不能混入核心行为通过数量。下表冻结本轮补验要求；实际通过范围由报告逐项标注。

| 编号 | 必须保留的事实及验收边界 |
| --- | --- |
| E01 持久恢复 | group 已提交且部分目标回应后终止服务；恢复同一 group、首答、目标状态与原 deadline，不重发已经接受的目标工作。记录原/新 PID、数据库快照和逻辑调用身份 |
| E02 deadline | 停机跨过原 deadline 后只结算一次 timeout/partial，保留逐目标原答与状态；不追加合成“统一意见”的请求。可控时钟与真实经过完整等待分别声明 |
| E03 末答竞争 | 最后有效响应和 deadline 竞争唯一 settlement；重复、非目标、迟到响应及恢复扫描不改变结果版本，不生成第二 callback。并发屏障、参与进程和时钟来源可复核 |
| E04 outbox 窗口 | 结算已提交而通知未发、或通知发出而 ACK 未落盘时崩溃，恢复同一可引用结果与逻辑 callback。通知可重复提示，逻辑 Invocation 不重复；凭 outbox 状态、唯一键和调用身份核验 |
| E05 回调授权 | pause 只保留 waiting，相同冻结身份 resume 才可继续；中途 stop 即使再 resume 也不复活旧 callback。成员/角色/账号/来源失权、Thread 关闭或身份漂移后明确拒绝/取消，原结算事实不删除 |
| E06 事务故障 | group/响应/结算/outbox/回调各提交点失败须整体回滚，不能返回已持久成功。按原身份重试不分叉；已有可信结果的持久恢复不重复请求供应商。失败写点、前后快照和派发计数单列 |

本轮发现并修复一个当前生产缺陷：征询已经 settled、callback 因调用者暂停而 waiting，且没有其他 deadline 时，resume 原来只调用 arm；没有可重装的 timer，回调会永久停留。现在合并提交后的 microtask 先执行 cooperation recovery，再安排 timer，重新检查冻结授权并派发合法 callback。修复事务遭遇存储失败时单独保留 1 秒重试，避免再次因没有 deadline 而失去修复机会；关闭实例时取消 timer，observe及已调用close()的协作实例不执行恢复。本轮分别在低层注入存储故障及实际 index 的认证 resume 路径验证，未通过额外调用恢复端口掩盖问题。该缺陷与 T08 首轮 SDK cancelled 没有已证明的因果联系。

生产恢复只使用可信持久事实，计时器或通知只是提示。数据库不可写与停止执行的结论不能混同；重启不释放未知执行，也不自动补造静止证明、供应商回执或原成员原答。

## 证据分层与退出口径

| 层级 | 可证明的内容 | 不能据此宣称 |
| --- | --- | --- |
| 历史取证 | 原 T08 报告、保留库或脱敏审计确有记录的取消、请求、目标和回调状态 | 缺失的原因可由当前推测补齐，或新成功已修复旧失败 |
| 隔离 SQLite/事务与受控时钟 | 首答、唯一结算、幂等、授权冻结和各故障写点的确定性行为 | 整个实际服务、真实完整等待或真实供应商均已通过 |
| 实际 SDK/宿主及注入传输 | SDK MCP/RPC、实际进程、工具 receipt、停止与来源链行为 | 注入模型结果或注入 transport 故障是供应商真实行为 |
| 实际 index 与注入故障 | 正规生产入口、release/authority、重启及恢复接线 | 模型响应真实，或所有生产配置和故障组合均已通过 |
| 实际 index 与真实供应商 | 指定平台/账号/模型/SDK 版本下的实际请求、原答及所述故障组合 | 其他供应商/平台自然继承通过，或与注入层未组合的 E 项也已验 |

每组记录入口、执行/故障注入点、实际请求数、SDK/index 进程、时钟、精确群组/目标/回调身份与未验范围。选择 factory 隔离执行 bypass 的测试必须显式登记，不能称作实际 index；人工预置提问或目标也不能记成模型实际创建。对失权后历史修复、停止证明和未知费用分别验收，不因一种事实存在自动推出另一种事实。

RC08 退出要求是原问题有可复核解释，或明确列明原证据不足及仍未定位；当前发现的生产缺陷有复现和修复回归；核心 MM01–MM04/M03 与 E01–E06 增强各自具有足够范围证据。未覆盖的实际组合继续留在剩余计划，不能以总通过组数或单条新成功替代整体验收。K01–K16、原 59 项场景与预期原文保持不变。

## 本轮分层结果

| 层级 | 结果 | 证据范围 |
| --- | --- | --- |
| [协作/持久恢复](../reports/evidence/threaded-rc08/cooperation-final.json) | 8组，18个worker PID，19次注入HTTP | 跨PID同身份工具重试；三PID末答/deadline竞争；outbox写失败按原终态修复；settlement提交后SIGKILL；通知发出但ACK前SIGKILL及重复物理提示、唯一逻辑回调；跨Thread来源失权；来源链anti-cascade；无deadline的resume自动修复与存储失败重试。生产factory、隔离库和受控时钟，无实际index/供应商 |
| [实际SDK注入](../reports/evidence/threaded-rc08/sdk.json) | 5组，8个guardian PID，42次注入HTTP | 实际SDK/MCP、原答与anti-cascade、受控取消/失败与可信代码诊断、原始/伪错误文本拒绝；factory隔离执行bypass，零真实供应商 |
| [实际index注入](../reports/evidence/threaded-rc08/main-injected-final.json) | 5组，7个index PID | 正规生产release/authority及入口，无factory执行bypass；模型传输和指定故障注入 |
| [实际index真实供应商](../reports/evidence/threaded-rc08/main-live-first.json) | 5组，7个index PID，21次真实HTTP | macOS、已授权选定账号、glm-5.3 Anthropic-compatible API及Claude SDK 0.3.288；5次原生SDK调用均核实停止。另1次本地HTTP400未发往远端，不计供应商请求 |

实际 index 的两层均使用下列五个场景；真实层的回答和用量来自供应商，故障注入仍按本表声明。

| 场景 | 已证明的行为 | 故障/时钟边界 |
| --- | --- | --- |
| partial_failure | 一个目标失败时，另一SDK成员仍完成并保留原答，唯一partial与callback | 失败由本地HTTP400注入，该次未请求真实供应商；不是自然供应商取消 |
| timeout_restart | 三目标保留两份原答、一个暂停目标timeout；SIGKILL后新PID沿原group/deadline唯一结算和回调 | 无running Attempt、无sending request且原生进程均verified_stopped后才以受控时钟越过原deadline；没有真实等待3分钟，不把时钟变化用于证明进程静止 |
| callback_pause | 新PID恢复后旧callback仍waiting；认证resume后自动派发唯一回调 | 通过正式控制入口，不额外手动调用recover；修复无deadline情况下的自动恢复 |
| callback_revoke | 原settlement与成员原答保留，冻结权限变化后拒绝旧callback | permission version由隔离fixture调整，不宣称产品UI撤权全链已验 |
| lost_receipt | 已提交工具结果未返给调用端，同一仍有效Binding精确重试查回原receipt，无第二group或逻辑交接 | 在broker处扣留已提交结果，非自然网络丢包，也不证明任意过期Binding可恢复执行 |

专验23组＝8＋5＋5＋5，相关回归84组＝collaboration17＋collaboration API4＋collaboration backends4＋backends14＋queue11＋runtime18＋production16，合计107组通过。开发失败和重复补验均保留，不额外计入通过组数。原 K01–K16 与59项场景/预期继续原文。

本轮实现及所列分层验收完成；原T08取消仍未定位。多PID竞争和outbox故障只在低层factory完成，没有与实际index/真实供应商逐项全交叉；自然供应商取消、自然网络丢回执及真实经过完整3分钟等待未复刻。当前复现的resume回调缺陷及诊断增强有独立修复证据，不能据此宣称历史根因已修复或整个模式已经可发布。

## 授权、账本与未完边界

真实验收沿用用户已授权账号及 1000 万 input+output token 总上限，本轮继续选择原共享累计 50 万保守门禁。RC08 开始前已确认 187,283、历史未知预留 206,832，保守累计 394,115，门禁余 105,885 token。每次实际发送前在原账本预留，只有匹配可信回执才能记实际用量；不重置账本、覆盖历史行或自动释放 unknown。RC08 新增21次真实HTTP，另1次本地HTTP400未发往供应商；新增确认33,195 token，新增unknown为0。原68行账本未改，当前累计已知220,478＋历史未知206,832＝保守占额427,310，累计50万门禁余72,690。实际请求和重试由本轮报告单列；已知token不代表价格或历史供应商费用已收敛。

来源凭据由受信父进程在内存解密，经私有IPC传至临时子库，以新的内存密钥加密；SDK只持短期relay token，密钥不入argv/env/report。访问既有账号配置须只读，实际凭据仅用于获权端点；模型只接收隔离合成内容。既有 RC04 not_observed、RC05 未定位超时、RC06 工程源写/merge、冲突 command 自动资源等待与 legacy 实供应商混跑，以及 RC07 默认窗口自然压缩、产品 seal、实际 index 完整原生组合的限制继续有效。RC09 对账和 RC10–RC12 综合验收/发布仍为独立任务。
