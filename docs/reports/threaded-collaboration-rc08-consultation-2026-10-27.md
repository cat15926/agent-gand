# 持续协作 RC08：持久征询故障与恢复验收

日期：2026-10-27（Asia/Shanghai）。基线为本轮已提交并推送的 RC07 `6ca44fb`。RC08 实现及所列分层验收完成，**专验 23 组、相关回归 84 组，共 107 组通过**，当前新变更未提交。原 T08 首轮 SDK 征询取消的原因仍未定位；本轮没有用后续成功覆盖原失败，也不宣称全部后端、平台和故障交叉组合已验。

代码 schema 保持 35，历史迁移、日常数据库和发布配置未改变，默认仍为 closed；未启动 RC09。核心规则不简化，新增可靠性能力分别验收，完整边界见[征询验收合同](../architecture/threaded-consultation-acceptance-v1.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。

## 1 两项生产改动

**修复结算后回调在恢复调用者时不再派发的问题。** 首轮实际 `index.ts` 注入验收先通过部分失败和超时重启，随后复现：征询已结算，暂停的调用者对应 callback 为 waiting；服务 SIGKILL、新 PID 恢复后，认证 member resume 已成功返回，但 callback 一直 waiting，直至 180 秒验收超时。原[失败报告](./evidence/threaded-rc08/main-injected-all-first.json)保留。

原因是 `collaboration.notifyCommitted()` 只重新设置未来计时器。征询 settled 后已经没有原 deadline 待处理，若也没有其他活动 wait，resume 不会安排一次回调权限重验。现在提交通知合并为微任务，先按持久事实执行 cooperation recovery，再设置下一计时器；不能恢复权限的 callback 仍拒绝或等待。持久写失败记录 `lastError` 并独立延迟 1 秒重试，不依赖新的消息或剩余 deadline。无变化的 waiting 检查不再次通知；已调用 `close()` 的协作实例、数据库关闭和事务内调用有边界检查，observe 仍关闭 collaboration。配置模式 closed 仍可按合法既有 grant 处理事实，不等于实例已关闭。

新 PID 直接 resume、不显式调用 recovery 的独立用例通过；另注入首次 callback 写入失败，仅撤除故障、不补新通知，独立 retry 自动完成原回调且清除诊断。修复后实际 index 的注入和真实供应商两层均自动继续，唯一 settlement、callback 和原始回答保持。

**补充 SDK 安全错误码诊断。** `claudeSdk.ts` 原先在 relay/原生进程异常后统一返回 generic failed，丢掉已知平台原因。现在只接受真正的 `ThreadedAuthorityError`、`ThreadedBudgetError`、`ResourceCoordinatorError` 实例的有限长度 code；不记录任意 SDK/provider 异常原文、伪造 code 对象或仅匹配 `THREADED_` 前缀的字符串。取消仍遵循 runner 已捕获的 signal 原因，不能被随后错误覆盖。实际 SDK 的预算到期、可信错误及敏感/伪前缀负例通过。没有增加 schema 或放宽重试、资源释放、费用和权限规则。

## 2 原 T08 取消：已知与未知

[历史诊断](./evidence/threaded-rc08/history-diagnosis.json)重新核对原报告、首次 JSON、独立复验 JSON 和脱敏审计的 SHA。可确认当时 API 工具 3 请求、SDK 工具 3 请求成功；首次征询另 3 请求后留下 collecting group、一个 cancelled target 和一个 pending target，零 settlement/callback，原生进程已核实停止。原报告只有 `cancelled != completed` 断言，没有可还原触发原因的请求/Invocation 时间线或取消 code。

原两个临时取证目录目前仅剩空目录，SQLite、WAL 和 SDK 文件不再存在。本轮没有重新构造“原现场”。后来的新场景 5 请求征询成功是另一轮证据，不能解释首次取消。预算活动片到期等机制本轮可受控复现且能留下明确 code，但**未证实它就是历史原因**。这项限制继续保留，不通过删失败、释放未知或重跑成功宣称根因已修复。

## 3 分层结果

| 层 | 通过组数 | 执行与边界 | 证据 |
| --- | ---: | --- | --- |
| 持久征询可靠性 | 8 | 18 个独立 worker PID、真实 SQLite/IPC/SIGKILL，19 次注入 HTTP；工厂组合，不是实际 index/供应商 | [cooperation-final](./evidence/threaded-rc08/cooperation-final.json) |
| 实际 SDK | 5 | SDK 0.3.288、实际 guardian/CLI/MCP，8 个 guardian PID 核实停止、42 次注入 HTTP；隔离执行开关 | [sdk](./evidence/threaded-rc08/sdk.json) |
| 实际 index，注入传输 | 5 | 7 个实际服务 PID；生产单例、认证 HTTP、发布准入和调度真实，执行前移除初始化 bypass | [main injected](./evidence/threaded-rc08/main-injected-final.json) |
| 实际 index，配置供应商 | 5 | 7 个实际服务 PID及5个实际SDK guardian，21 次真实 HTTP；另有1次故意本地 HTTP400，不计远端调用 | [main live](./evidence/threaded-rc08/main-live-first.json) |
| 相关回归 | 84 | collaboration17、collaboration-api4、collaboration-backends4、backends14、queue11、runtime18、production16 | [验证汇总](./evidence/threaded-rc08/verification-summary.json) |

23 是“用例×证据层”的去重组数，不是原核心合同完成百分比。开发轮次、重复通过、同组变体、静态审查和账本聚合不额外加组；PID 分层统计，不相加为部署规模。原 T08 E01–E06、K01–K16 与 59 个场景的正文继续有效。

独立可靠性层新增跨 PID 同 Binding/key 工具回执重试与冲突、三 writer 末答/原 deadline 竞争、callback outbox 拒写后原可信终态跨 PID 恢复、settlement 提交后 SIGKILL、通知已发送但 ACK 前 SIGKILL/租约接管、暂停期间跨 Thread 来源撤权、间接来源链 anti-cascade，以及本次自动恢复修复。真实物理通知可重复两次，逻辑 callback/wake/queue 仍各一份；不能把物理重复提示误判为第二个模型调用。末答竞争本轮观察到 complete 胜出，重复扫描和迟到处理不改原结算；有限竞态序列不等于全部调度交错证明。

SDK 层通过真实 MCP 发出不合法的嵌套征询，服务端拒绝 cascade；原成员回答继续保留。HTTP400、预算到期和安全错误码是明确注入条件，不是自然供应商失败。工厂/SQLite 重建后 deadline 结算只证明该载体，完整服务重启由实际 index 层另证。

## 4 五组实际主入口场景

| 场景 | 已验证事实 | 注入与限制 |
| --- | --- | --- |
| partial_failure | API 调用者实际注册征询；SDK 成员成功原答，另一 API 成员 failed；partial 逐字保留成功原答，唯一 callback 后调用者完成，失败不取消成功成员 | 失败成员的 HTTP400 在 guard 内产生，未发送供应商；其余4次请求真实。不能称该400来自供应商 |
| timeout_restart | 三个目标中的 SDK/API 两成员独立原答，第三成员被认证控制暂停。SIGKILL 后新 PID 保留同 group、原 deadline、原回答；越原 deadline 唯一 partial，恢复第三成员不复活旧征询 | 只在无 running attempt、无 sending request 且全部原生进程 verified_stopped 后推进隔离 Date.now；不是等待真实3分钟 |
| callback_pause | 成员回答后暂停调用者，期限到达生成 waiting callback；再次 SIGKILL、新 PID 保留该状态；认证 resume 自动派发原 callback，调用者只执行一次 | 修复前真实复现卡住，修复后不显式调用恢复器帮助首次派发；重复恢复只用于之后的幂等断言 |
| callback_revoke | 保留原回答和 partial，调用者权限版本变化后 callback rejected，没有 system 回调消息或额外调用 | 权限版本修改是隔离 fixture 注入，不是产品成员编辑 UI；当前冻结身份/来源检查仍由生产代码执行 |
| lost_receipt | multi_mention 已提交的工具结果被 guard 暂扣；同一仍有效 Binding、同参数/key 在真实 broker 精确重试，返回相同结果且 group/target/tool receipt/wake/outbox 数量不变；正常完成唯一汇总回调 | 模拟的是 broker 回执交付丢失；不是自然网络断线，也不是自动重放已崩溃的 unknown Invocation |

每份 settlement 都核对逐目标状态和 `responseMessageId`，成功 body 必须逐字等于对应原消息；缺答不编造正文。所有消息/Invocation 保持同一 causal root，callback 不创建额外聚合模型请求；调用者读取结果后的正常响应有独立真实请求。末答、重复恢复、迟到或恢复被暂停目标不能复活 settled group。

## 5 账号、隔离和共享账本

真实范围限 macOS、既有托管账号 `Claude-GML-5.3`（`267c2e27-b25f-43cf-acaa-143327f7f714`）、模型 `glm-5.3`、`open.bigmodel.cn` 的 Anthropic-compatible API及SDK 0.3.288。只有合成新任务和隔离 SDK 历史进入模型，不读取日常消息；其他平台/driver/供应商不继承通过结论。

先设置临时 DB/agents/private 路径再导入单例。来源库仅只读取得选定账号/版本/加密凭据/撤销状态；密钥在父进程内解密，经私有 IPC 到子测试库，以新的内存密钥加密。SDK 仅持短期 relay token，密钥不进入 argv/env/report。远端请求限配置 HTTPS origin、精确路径、POST 与 redirect:error；完整正文 SHA256 对应唯一尚未消费的持久 sending receipt，每次真实发送前在原账本事务预留。故意本地400单独标记，既不发送远端，也不向真实费用账本新增行。

用户原授权 1000 万 token 保留，本轮继续选择更小的**累计 500,000 token 门禁**，使用原 `/tmp/agent-gand-t07-authorized-token-ledger.sqlite`，未重置账本或释放 unknown。

| 口径 | 已确认 token | 未知预留 token | 保守累计 |
| --- | ---: | ---: | ---: |
| RC08 前 | 187,283 | 206,832 | 394,115 |
| RC08 新增21次真实请求 | 33,195 | 0 | 33,195 |
| 当前累计 | **220,478** | **206,832** | **427,310** |

剩余门禁 **72,690 token**。原 68 行按本轮真实 authorization 集合排除新增后逐字段重建，摘要与运行前一致；21 个新增请求全部 known，详见[账本核对](./evidence/threaded-rc08/ledger.json)。历史未知 89,758＋RC05 97,271＋RC06 19,803 全部保留。token 已知不等于货币价格已知，进程停止也不能替代原未知供应商费用对账。

本次合成根经正规 Owner CAS 选 10,000ms 活动片，生产默认 1000ms、其他总限额和绝对期限不变。原 RC04 not_observed、RC05 历史超时与片长限制、RC06 工程写入/merge和命令资源等待/旧新混跑缺口、RC07 默认窗口压缩/产品seal/index完整原生组合均保留。

## 6 开发记录、核验与剩余范围

[开发记录](./evidence/threaded-rc08/development-findings.json)保留实际 index 修复前失败、代码基线哈希及修复后独立结果。cooperation 第一轮因夹具遗漏跨 Thread 来源的合法成员而被 ACL 正确拒绝，修正夹具后通过，原失败保留；中间6/7/8组成功及SDK扩充预算类之前的成功快照不重复计数。包含混合开发代码时序的中间用例已标明，不能冒充旧代码失败证据。

服务端 typecheck、文档本地链接、diff、独立只读代码/真实请求 guard 审查通过。K01–K16 与原59场景/期望原文不变，见[原文证明](./evidence/threaded-rc08/original-text-invariance.json)；完整文件摘要与结果见[交付清单](./evidence/threaded-rc08/delivery.json)。

| 继续保留的范围 | 当前结论 |
| --- | --- |
| T08 首轮 SDK cancelled 根因 | 原诊断不足且现场文件已不在，仍未定位；新增可信 code 提升后续取证，不倒推历史 |
| 自然供应商失败/网络丢回执 | 真实供应商成功路径和生产故障注入分别通过；未制造或观察全部自然取消、网络中断和未知执行组合 |
| 完整入口×SDK×故障交叉矩阵 | 多 PID 竞态、通知/ACK、存储注入主要为工厂层；不把这些结果全部提升为实际 index/供应商证明 |
| 综合链、对账及发布 | RC09 原未知对账、RC10 综合链、RC11–RC12 发布继续按计划，未因本轮成功关闭原限制或启用日常模式 |
