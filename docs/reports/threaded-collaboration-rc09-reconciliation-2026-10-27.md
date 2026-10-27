# 持续协作 RC09：可信事实恢复与历史未知对账

日期：2026-10-27（Asia/Shanghai）。基线为本轮已提交并推送的 RC08 `52d3cc3`。RC09 实现、历史只读审计及所列分层验收完成：**24 组专验＋101 组相关回归，共 125 组通过**。历史 12 笔未知预留仍未收敛，逐项保留及恢复前提已登记；没有以新的通过记录抵消旧失败。RC09 当前变更未提交。

代码 schema 保持 35，默认 closed，日常数据库与配置未改变；本轮未启动 RC10 或发布。原 K01–K16、59 项场景/预期及 E01–E06 非状态文字保持不变。详细约束见[对账合同](../architecture/threaded-reconciliation-acceptance-v1.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。

## 1. 当前生产缺口与修复

### 完整回执已写入，预算结算未写入

实际 transport 先持久化 `threaded_backend_requests.state=complete`，随后调用预算 `settleRequest`。如果第二步因存储故障或服务终止而缺失，原恢复器只修上下文投递，不会依据已保存回执补记用量。结果是可验证的已知用量仍留在预留状态。

[恢复专验](evidence/threaded-rc09/recovery.json)第 1 组保留 `52d3cc3` 原恢复器的源哈希和复现：只改写临时副本的相对 import 路径，原代码运行后预算 hash 未变、known_output 仍为空；新恢复器经两个独立 PID 竞争后只产生一份结算回执。修复前证据来自该隔离重放，没有改写原历史报告。

现在恢复器枚举未结算的完整不可变回执，以原 binding、authorization 和 receipt 引用调用生产预算接口。原 Owner/Thread/Invocation/Attempt/claim/generation/fencing 身份及精确数值仍由真实 verifier 核对；同键幂等，矛盾已知数值拒绝，存储失败整体回滚。输出 token 和货币费用分开补记；缺少任何一维继续保留该维预留。完整传输回执即使没有用量，也只能证明该请求完成，不能填零。

该修复只处理原请求账本，不生成 Invocation 结果、输出正文或新模型请求，不恢复旧权限，也不释放 claim。无发布配置的 closed 服务仍能依据历史可信回执修账本；observe 在进入恢复器前返回，只读检查不执行这些修复。配置了 backend 的 production 直接沿用其恢复计数，避免旧代码第二次调用覆盖计数。

### 已持久关闭，尚未完成本地进程组核验

SDK 原始 `onProcessStopped` 回调已经将进程行写为 closed，但在确认进程组停止前退出时，新恢复器可在**同宿主、可信进程检查确认组内无活成员**后将该行补为 verified_stopped。进程检查在事务外执行，写入时再次核对 token/PID/host/closed，失败不宣称已持久成功；调用方处于事务内则直接拒绝恢复。

registered 缺少原始 close 事实时继续保留。异宿主、进程组仍活跃、检查失败均不推进。当前查不到 PID、同轮测试观察到守护进程停止，不能补造遗失的原关闭记录。即使本地停止已确认，未决远端请求、未知用量、Invocation 和资源围栏仍分别保留。

## 2. 历史账本逐项审计

[审计脚本](../../scripts/audit-threaded-rc09-history.mjs)只读打开原共享账本，检查归档证据及指定临时目录元数据，不加载应用单例、不读凭据或日常会话、不请求供应商，也不写旧账本。完整逐请求身份、证据路径、状态和缺失项见[历史审计 JSON](evidence/threaded-rc09/history-ledger-audit.json)。

| 来源 | 未知请求数 | 保留 token 预留 | 当前处置 |
| --- | ---: | ---: | --- |
| RC05 前原记录 | 4 | 89,758 | 1 项可关联归档请求，3 项缺少 authorization 到原 request/binding 的身份桥接；全部保留 |
| RC05 | 7 | 97,271 | 可关联原请求；包含两次 extended 超时各 12,918，缺少可信完整用量，全部保留 |
| RC06 | 1 | 19,803 | 可关联原 request/binding/claim generation；本地 verified_stopped 不清除远端 unknown |
| 合计 | **12** | **206,832** | **无一项具备安全转 known 或补记货币费用的证据** |

89 行中 77 行 known、12 行 reserved。当前确认 **220,478**＋未知预留 **206,832**＝保守占额 **427,310 token**，本轮沿用的累计 500,000 门禁余 **72,690**；用户原 1000 万 token 总授权不变。本轮真实供应商请求 **0**，新增确认 **0**、新增未知 **0**。已知 token 不是供应商金额结算证明。

原 68、57、47、33 行摘要按 RC08→RC05 新增集合逐层核对，与归档完全匹配；账本全文件和逻辑行前后 hash 均未改变。178 份历史 JSON 搜索没有找到三个缺失身份桥接的 authorization ID，不能按金额或先后顺序配对。T12 指定留存隔离目录存在，但目录元数据中已无 SQLite/WAL；未读取其凭据或原生历史内容。

RC05 的某笔 SDK 请求有同事件 guardian token/PID 和 groupStopped 观察，原持久行仍 registered；RC06 有 verified_stopped 且原执行/资源仍 unknown；这些来源事实分别登记。归档中未出现未决 command/Action 不能证明所有外部副作用不存在，相关快照缺失继续按未知处理。

## 3. 分层验收

| 层级 | 组数 | 已验证范围及边界 |
| --- | ---: | --- |
| [恢复专验](evidence/threaded-rc09/recovery.json) | 9 | 原恢复器基线、双 PID 精确回执竞争、分维用量、SQL 回滚、身份/冲突拒绝、unknown 保留、closed/registered/异宿主/活进程/检查失败。16 个独立恢复 worker PID、4 个普通本地进程组；transport 证据经生产 writer 人工持久化，零 HTTP；不称实际 SDK/index |
| [预算专验](evidence/threaded-rc09/budget.json) | 9 | 生产预算/verifier/coordinator、12 类身份或伪证据变更、未知价格、同键冲突、事务回滚、原绑定晚到对账、24 小时窗口、同 Attempt 双请求不可互用。10 次注入 HTTP、1 个短命 Node 子进程；工厂重建不是 OS 进程重启 |
| [实际 index 专验](evidence/threaded-rc09/main-final.json) | 6 | 12 个实际 index PID、2 个实际 Claude SDK 0.3.288 guardian，合成账号与 6 次注入 HTTP；正规 release/authority/认证入口，无 factory 执行 bypass；零供应商 |

实际 index 逐组结果：

| 场景 | 原窗口与新 PID 自动恢复结果 |
| --- | --- |
| api-receipt | complete 写入后、budget settle 前固定窗口；新 PID 补原输出 token，未知价格保留，Invocation/claim 仍 unknown |
| sdk-receipt | 实际 SDK 同窗口；补请求账本，原 registered 行保留，即使同轮观察已无守护进程组 |
| sdk-closed | 原 SDK close 已持久、确认停止前固定窗口；新 PID 仅补 verified_stopped；不猜原结果、不释放 claim |
| unknown-request | transport 抛错留下 unknown；重启不生成 complete、用量或重放 |
| observe | 同一缺失结算库以 observe 启动，预算、回执、进程和对账记录均保持原值 |
| closed-no-pack | 同一缺失结算库以 closed 且无发布配置启动，可补可信原用量；新入场继续关闭 |

故障窗口以 preload 中 SIGSTOP 固定，再由父进程 SIGKILL 实际 index；这是显式故障注入。模型响应与用量来自本地注入，不能记为供应商账单核验。原请求/绑定/claim 身份逐项不变，修复后的原请求恢复扫描无新增回执；所有新 PID 的 HTTP effect 为零，没有输出、终态或新 quiescence 证明。

相关回归 **101 组**：backend-runtime 7、backends 14、budget 14、context 14、production 16、queue 11、release 7、runtime 18，证据存于本目录的 `evidence/threaded-rc09/regressions/`。独立只读审计、重复运行、检查数及测试内部变体均不额外计入组数。服务端类型检查和文档本地链接另行验证。

开发记录全部保留：恢复首跑 ps EPERM 正确保留 closed；第二跑无关临时单例库冲突，改为每 PID 独立库后通过；预算脚本初版表名修正及旧 delivery 未修复时 successor 不能执行的范围记录见[说明](evidence/threaded-rc09/budget-development-findings.json)。预算 RB07 只证明 successor 已持有资源时，旧绑定对账不会改变它，不声称 successor 已执行成功。main 首个单场景及 5 组重复通过不计入最终 6 组之外。

## 4. 未知记录的保留与后续条件

1. 原 12 笔保留全部预留、原原因及已有围栏，不退款、不自动重放。映射缺失的三笔先补原 authorization/request/binding 身份链；已有映射的九笔仍须原供应商请求相关性及完整可信用量/费用证据。
2. 原 registered 缺关闭事实的记录不能由新版本回填成功。后续如需修复，须取得原 token/宿主/绑定/代际的可信过程证据；本轮未新增 guardian 持久退出协议。
3. 用量补记不等于恢复执行许可。资源释放和恢复旧责任还需原请求、工具/命令副作用及静止证据，重新检查冻结身份、权限、控制、预算和期限；失权正文不能补发布。
4. 本轮只自动消费已有生产完整回执，没有提供任意供应商账单导入或人工“填零”接口。历史缺失证据无法自动补造，最终供应商费用尚未对齐。
5. RC04 自然事件 not_observed、RC05 未定位超时与默认片长可用性、RC06 工程写/合并/等待与混跑、RC07 默认窗口压缩/产品 seal/完整原生组合、RC08 历史取消与完整故障交叉限制均保留。RC10 综合验收及 RC11–RC12 日常发布继续独立推进，本报告不构成启用指令。

最终检查、文件哈希和交付边界见[交付清单](evidence/threaded-rc09/delivery.json)。
