# 持续协作 RC06：并发、Session 与工程工作区分层验收

日期：2026-10-24（Asia/Shanghai）。基线为已提交并推送的 RC05 `8d1fc75e586ee05de738d04349702e47e088b619`。RC06 本轮代码及所列分层验收已实施，新增变更尚未提交；**RC06 整体验收尚未关闭**。专验 41 组、相关回归 88 组通过，共 129 组；不按组数估算核心合同完成比例。生产工程源文件写入/合并、真正资源冲突后 command 的自动持久等待，以及完整旧模式与 threaded 真实供应商混跑仍未交付或未验。

默认仍为 closed，代码 schema 保持 35，历史迁移未修改；本轮没有迁移日常数据库、改变日常配置、启用房间或启动 RC07。完整合同见[并发与工作区验收合同](../architecture/threaded-concurrency-workspace-acceptance-v1.md)，后续工作见[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。

## 1 实际生产改动

`productionCommands.ts` 为受保护的命令注册增加可选 `workspaceMode:shared_project` 与 `artifactRoot`。同一工程所有成员须显式选该模式，workspace 必须逐字等于规范工程 root。模型 Session 与资源 claim 保持整个工程 root 的 read 范围，不通过缩窄声明绕开读写冲突。artifactRoot 必须与工程根双向不交叠，每个命令仅写其严格子目录；所有输出互不交叠，且与所有成员 workspace 不交叠。配置与目录身份、输入及程序继续固定，artifactRoot 纳入 pin 与共享映射指纹，替换/符号链接漂移拒绝；原三字段 isolated 注册兼容。

这使多个成员可以共同读取真实工程并生成独立外部产物。仍只接受服务器固定 `project_manifest_v1`、空模型参数和固定程序/环境；没有新增任意 shell、build、Git 写入或工程源写/merge 工具。工作区 fixture 的唯一 merge owner、baseVersion 和内容哈希检查仅是验收协议，不是已交付的生产合并工作流。

`coordinator.ts` 修复一项实际复现的命令准入问题：A 模型已运行时申请独立文件资源，较早排队但不冲突的 B 模型占据全局服务轮次首位，会令命令单次 reserve 失败，留下业务 unknown。现在合法 `threadedCommand` 的 `capacity:false` 补充资源不领取第二个模型服务轮次，也不更新公平计数；完整实际资源/权限检查仍执行，任何较早且有效的非容量冲突任务继续阻挡，包括当时尚不能取得资源的旧 writer。legacy 准备子 claim 行为保留。

此修复仅消除**无关排队工作造成的额外阻挡**。真正冲突仍单次拒绝，当前命令路径不会自动持久等待并重试；保留 unknown，不能说已经交付完整 command 排队器。详细开发失败与更正见[工作区开发记录](./evidence/threaded-rc06/workspace-development-findings.json)。

## 2 分层证据与通过范围

| 层 | 通过组数 | 实际执行 | 证据及边界 |
| --- | ---: | --- | --- |
| 协调器 | 16 | 8 个独立 Node PID、真实 SQLite 连接 | [concurrency.json](./evidence/threaded-rc06/concurrency.json)：同键/异内容、同槽、旧 finally、跨 Thread、旧 exclusive、持久公平、容量单计、释放再入队、命令资源补充；生命周期和 nativeId 是受信合成元数据，没有供应商或实际 SDK resume |
| 原生 Session | 6 | 3 个实际 SDK/guardian PID、另 2 个资源 worker | [native.json](./evidence/threaded-rc06/native.json)：并行 A/B 定向取消、B 继续、实际 checkpoint 同 nativeId resume、不同 policy 同 native 锁；factory 使用隔离执行开关，HTTP 响应注入，不是实际 index/供应商证明 |
| 工程工作区 | 9 | 9 个文件/资源 worker 与 2 个实际注册命令 guardian | [workspace.json](./evidence/threaded-rc06/workspace.json)：真实临时工程父子路径 read/write 互斥、独立文件、共享 read、fixture 合并版本；另 4 组生产 factory 无执行旁路，整根 Session/read claim、双 native manifest 同时启动、独立产物核验释放、12 类无效配置及路径漂移拒绝。3 次模型响应注入，未提供生产源写/merge |
| 实际服务入口，注入传输 | 5 | 5 个实际 `apps/server/src/index.ts` PID | [main-injected-final.json](./evidence/threaded-rc06/main-injected-final.json)：HTTP、发布、授权、生产单例及 dispatcher 均真实；模型传输注入，执行时不保留 fixture bypass |
| 实际服务入口，配置供应商 | 5 | 5 个实际 index PID，真实 API 与 SDK | [main-live-first.json](./evidence/threaded-rc06/main-live-first.json)：同样五场景，真实发送前逐请求共享账本门禁。账号及版本范围见下文 |
| 相关回归 | 88 | 既有资源、legacy 桥接、队列、后端、生产和命令组合 | [verification-summary.json](./evidence/threaded-rc06/verification-summary.json)：19+8+11+7+16+11+10+2+4。注入供应商；涉及原生命令和 loopback 的套件在相应宿主权限下执行 |

以上分层不混加 PID 来声称部署规模。协调器多连接 CAS 不证明多机 worker、跨 worker 通知或分布式公平；生产仍按同一数据库单个活跃 index 范围说明。有限序列的公平/旧 exclusive 通过不构成无限负载下的数学无饥饿证明。

## 3 五组真实主入口场景

范围为 macOS、同一既有托管账号 `Claude-GML-5.3`（ID `267c2e27-b25f-43cf-acaa-143327f7f714`）、模型 `glm-5.3`、`open.bigmodel.cn` 的 Anthropic-compatible 接口，API `threaded-http-v1` 与 `claude-sdk 0.3.288`。其他 driver、供应商、Linux、WSL/Windows 不据此支持。

| 场景 | 核对事实 |
| --- | --- |
| retry | 8 个并发已认证 HTTP 同键请求，唯一来源消息、逻辑 wake、claim、请求和正式响应；回执一致 |
| slot | 同 Thread 同 Agent 的两个逻辑消息保留各自 root；A 持有槽时 B 没有真实发送，A 释放后 B 继续，各完成一次 |
| parallel | 同 Agent 两个 Thread 各有独立槽；两次真实请求发送至响应头区间正重叠 **1185ms**，随后各自完成；不是仅用人工延迟读取 body 冒充供应商并发 |
| cancel | 同 Thread 两个不同 SDK 成员各有实际 guardian，同时抵达生成响应头；认证 Invocation 控制只停止 A，核实其进程组停止，B driver 仍注册/运行并继续完成。A 的可能发送请求、claim 与 Invocation 保持 unknown，零伪造终态 |
| capacity | 全局/Thread/账号容量 2、供应商容量 1；A 只占一次容量，B 排队，释放后唤醒 B，随后 C 唯一入场 |

parallel 真实原始时间戳另由[独立计算证据](./evidence/threaded-rc06/main-live-positive-overlap.json)重算。初脚本采用非严格区间比较，最终收紧为两段均正时长、且严格正重叠；[单独注入复验](./evidence/threaded-rc06/main-injected-strict-overlap.json)通过。未为这项断言重复产生付费调用。

取消 B 继续证明的是原生 driver/持久执行：供应商 body 在取消 A 前可能已缓冲，原始 networkEndedAt 单列，不宣称取消瞬间供应商仍在生成。初始证明后只移除 B 的后续测试闸门，不扩大 B 权限；SDK 的任何 helper/continuation HTTP 分别核对请求身份并独立预留，不把一轮 Invocation 当成单次 HTTP。

不同 policy 同 nativeId 的冲突由 fixture 刻意种入 ready Session，实际竞争的是协调器锁；未宣称正常生产 prepare 自然产生相同 nativeId 后两个 SDK 实际同时尝试 resume。真实 cold/resume 的连续性由独立原生套件补证，不能互相替代。

## 4 隔离、授权及账本

所有验收先设置临时 DB、私有目录和 agents 路径再导入单例。实际 index preload 只在初始化隔离数据时使用隔离开关，执行前删除该开关，生产权限检查正常生效。凭据来源只读加载选定账号元数据、加密凭据及撤销状态，不读取日常消息；来源凭据在父进程内解密并经私有 IPC 传输；子测试库以全新随机内存密钥加密隔离副本，实际 index 按正常凭据端口读取。不将密钥写入 argv/env/report，SDK 只持 relay token。真实 HTTP body 的 SHA256 与唯一未消费的持久 sending receipt 精确匹配，不能取最新一条请求猜归属。

沿用用户已授权的全部配置账号及 1000 万 token 总授权，本轮仍明确选择更小的**累计 50 万 token** 门禁，使用原 `/tmp/agent-gand-t07-authorized-token-ledger.sqlite`，每次发送前事务预留。账本没有重置、替换或释放未知预留。

| 口径 | 确认 token | 未知预留 token | 保守合计 |
| --- | ---: | ---: | ---: |
| RC06 前 | 65,181 | 187,029 | 252,210 |
| RC06 新增 10 请求（9 已知、1 未知） | 5,362 | 19,803 | 25,165 |
| 当前共享累计 | 70,543 | 206,832 | **277,375** |

累计门禁余量 **222,625** token。原 47 行按本次 authorization ID 集合排除新增后逐字段重建，摘要与运行前 digest 一致，见[ledger.json](./evidence/threaded-rc06/ledger.json)。RC05 前 89,758 与 RC05 新增 97,271 未知预留都不变。被中断 SDK 的 19,803 继续占额，进程停止不能证明供应商费用；确认 token 也不自动证明货币价格已知。

合成根通过正规 Owner CAS 选 10,000ms 活动片，生产默认仍为 1,000ms，其他根预算和绝对期限不放宽。RC05 默认片长对同步长准备只能失败闭合的可用性限制仍在；两轮真实诊断超时未知预留与 RC04 `not_observed` 均保持历史事实，不由本轮成功消除。

## 5 失败、修正与回归

- 初轮注入 parallel 因响应头即时同步返回，没有正重叠区间而失败；注入传输显式增加 50ms 异步延迟后通过。这是 fixture 时间模型修正，不拿注入延迟当真实供应商证据。[第一轮](./evidence/threaded-rc06/main-injected-first.json)保留。
- 第二轮 cancel 中仍获权 B 的后续 SDK 请求被测试闸门卡住；初始 A/B 取消证明后取消对 B 后续请求的测试阻挡，[单例复验](./evidence/threaded-rc06/main-injected-cancel-third.json)及最终五组通过。[第二轮](./evidence/threaded-rc06/main-injected-second.json)保留。
- 工作区开发中真实复现无关模型服务轮次阻挡命令补资源，修复后 16 组协调器与实际生产双命令回归通过。开发记录另保留宿主 `ps` 沙箱限制和最初对 settleDelay 的解释更正；最终 fixture 显式选 30,000ms（原允许范围 0–60,000），未改生产默认。
- backend-runtime 初次未提权并行执行在第 156 行出现 `unknown != completed`，原临时库已清理，不能复原内部 cause。沙箱 loopback 监听 `EPERM` 可单独复现，仍只列候选原因，不归因 `ps`/CPU 或代码修复。[原失败](./evidence/threaded-rc06/regressions/backend-runtime-first-failure.json)与[单独宿主权限重跑 7 组通过](./evidence/threaded-rc06/regressions/backend-runtime-retry.json)分别保存。

9 套回归为 resources 19、resource-integration 8、queue 11、backend-runtime 7、production 16、legacy-resources 11、production-commands 10、rc03-production 2、rc03-command-admission 4。所有新证据放入 RC06 目录，没有覆盖历史报告。严格并发单组复验不再增加 129 的去重组数。服务端 typecheck、文档链接与 diff 检查结果见[交付清单](./evidence/threaded-rc06/delivery.json)。

## 6 剩余退出条件

| 待完成 | 当前限制与下一步 |
| --- | --- |
| 生产工程源写/合并 | 定义受信写入 profile、完整副作用范围、合并责任与版本 CAS、重启/失败核对，再验真实工程竞争；当前 fixture owner/baseVersion 不能替代 |
| 真正资源冲突的命令等待 | 定义持久资源等待与恢复/取消/失权协议，避免已持只读根申请重叠写造成死锁；当前拒绝后保留 unknown，不盲重放 |
| 完整旧新供应商混跑 | 同时运行实际 legacy driver 与 threaded 供应商，验证 exclusive、公平、单计、取消及释放；协调器/桥接层已测但不等于该组合 |
| nativeId 冲突生产层 | 选择可控实际 Session 准备/冲突注入边界，补实际 resume 竞争证据，保留完整信息边界和 stale-release 检查 |
| 其他原待验 | RC04 双自然 HEAD、RC05 历史未定位超时与默认片长可用性、RC09 可信费用对账、RC10–RC12 发布及其他高级/平台范围按原计划继续 |

K01–K16 与 59 个原场景/期望文本保持不变，状态和证据按上述层次更新，逐字摘要见[原文不变性证明](./evidence/threaded-rc06/original-text-invariance.json)。本报告不授予日常启用、远端评论/review、生产迁移或扩大命令权限。
