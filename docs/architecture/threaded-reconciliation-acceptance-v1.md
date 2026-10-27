# 持续协作：用量、进程与副作用对账验收合同 v1

更新：2026-10-27（Asia/Shanghai）。RC09 以已提交并推送的 RC08 `52d3cc3` 为基线，承接[预算与运行时合同](threaded-runtime-v1.md)、[故障恢复合同](threaded-fault-recovery-acceptance-v1.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。实现及所列分层验收完成；历史12项未知仍未收敛，逐项保留处置已登记。历史只读盘点与新增生产恢复用例分别记证，准确结果见[RC09 报告](../reports/threaded-collaboration-rc09-reconciliation-2026-10-27.md)。本轮变更未提交，schema 保持 35、日常 closed，未配置、启用或迁移，不自动开始 RC10 或发布。

## 1 分开核验的事实

RC09 的目标是按原身份核对可信事实、补齐已有事实的持久投影，并为仍未知的执行保留明确处置。不能将“进程停止”“完整传输回执”“用量已知”“费用已知”“业务完成”合并为一个成功状态。核心 K13、B02、REC03 与原 K01–K16/59 项场景原文继续有效。

| 事实域 | 可接受的证据 | 单独不能推出的结论 |
| --- | --- | --- |
| 原请求身份 | authorization、request、Binding、Attempt、claim 与代际/围栏的精确对应，原 receipt 引用 | 仅金额相同、时间相邻、同模型或同账号就能配对 |
| 请求传输 | 受信 transport 持久化的不可变 complete receipt，与原 Binding/authorization 相符 | HTTP 200、收到部分 SSE、进程退出即代表 complete |
| 用量与费用 | receipt 中分别存在且通过原 verifier 的输出 token/费用；外部总账 input+output 需自身可信完整事实 | 已知 token 可推算实际货币费用，未知值可补零，预算预留就是供应商账单 |
| 宿主停止 | 原 closed 事实、同一 host/token/PID 的持久对应及本地进程组核验 | 单次 PID 查无、registered、换宿主查询能代替原 close 事实或完整静止证明 |
| 资源与副作用 | 原 claim 代际下的完整资源静止及领域副作用证据 | 进程状态或费用已知就可自动释放 claim、重放请求、完成 Invocation/Action |

历史当前账本与生产 `threaded_budget_requests` 是不同层次的记录。生产 request 预算修复不能通过补调 `onRequestSettled` 自动改变外部操作者账本；该回调可能产生额外副作用，必须按自身可信原请求事实另行对账。

## 2 不可变回执与预算投影恢复

故障窗口是 transport 已提交 complete receipt，而后续 `budget.settleRequest` 尚未持久成功。该时刻重启不能丢掉已知用量，也不能把原传输再发一次。恢复使用原 request 的不可变 receipt、原 Binding 和 authorization，经过既有用量 verifier 幂等补记预算；不创建新请求、Attempt、causal root 或预算额度。

校验须覆盖 owner、Thread、Invocation、Attempt、claim、generation、fencing token、authorization 与 receipt 引用，不按“最新一条”猜归属。相同事实重复扫描保持原预算结果，同身份冲突事实明确拒绝；事务失败不能留下半份对账。已过期或撤销的执行权限不能成为恢复发送资格；历史账务补记也不能复活 driver、发布旧正文、生成终态或获得新执行授权。

complete 只证明原 transport 已完整结束。输出 token 和费用分别按已有可信值补记，缺失维度保持 unknown；没有完整 receipt 的 sending/unknown 请求继续保留，不因为有 input 数字、HTTP 200 或后来成功请求而填补旧项。恢复原请求模型活动段与整个 Attempt 的静止、资源释放、业务终态保持独立。

## 3 原生进程状态恢复

仅当已有持久 `closed`、记录 host 与当前宿主一致，并由本地 `ps` 核验原进程组无存活成员时，才将该原记录补为 `verified_stopped`。更新须限定原 token/Binding/host/PID 与旧状态，不能用另一个进程的停止事实或复用 PID 的新身份代替。跨宿主、仍有活成员、检查不可用或检查失败均保留原状态，不通过补写成功掩盖核验失败。

`registered` 缺少原 close 事实时，即使当前未观察到 PID，也继续保留。RC05 的同轮停止观察有审计价值，但不能绕过上述持久证据条件改写旧记录。进程被核实停止也不改变供应商 receipt、费用、Invocation、claim 或领域副作用；后台对账不自动生成静止证明并释放原 unknown claim。

observe 不执行这些修复写入。配置 closed 与原生进程表中的 closed 含义不同：前者是发布准入模式，后者是原宿主 close 事件的持久状态；不得把两者混作允许修复的条件。实际 index 已验证发布模式为 closed 且未配置 pack 时，既有原回执仍可修复账务事实，同时新任务准入保持关闭；这不是打开日常模式。

## 4 历史未知的盘点与处置

[历史只读审计](../reports/evidence/threaded-rc09/history-ledger-audit.json)核对原共享账本 89 行：77 known、12 reserved；确认 220,478 token、未知预留 206,832，保守累计 427,310，所选累计 500,000 门禁余 72,690。原用户总授权 1000 万 token 不变。逐轮按精确新增 ID 排除 RC08、RC07、RC06、RC05 后，原 68/57/47/33 行摘要均与历史记录一致；本轮未改原账本。

| 历史组 | 未知项与预留 | 当前可用事实 | 处置 |
| --- | --- | --- | --- |
| RC05 前 | 4 项，89,758 token | T12 定向诊断 1 项有原 request/Binding；另外 3 项仅账本 ID 和阶段聚合，缺少原请求身份桥接 | 全部保留预留。两笔 19,505 与一笔 26,041 不能仅按金额对应某次运行；不伪造缺失身份 |
| RC05 | 7 项，97,271 token | 精确 request/Binding 及所列故障快照；两次 extended timeout 各 12,918。SDK 同事件 guardian 停止观察与原 registered 记录分开保留 | 保留原 unknown、围栏及未定位超时，不将本轮恢复能力倒推为旧项已修复 |
| RC06 | 1 项，19,803 token | 精确 request/Binding/claim generation，持久 verified_stopped；原执行/claim/request 仍 unknown | 停止事实不能结算费用或释放执行围栏，继续保留 |

9 项可精确映射原 request/Binding，3 项缺少身份桥接；12 项均缺完整 token/货币回执，当前可安全转 known 或退款的项数为 0。原 T12 留存目录元数据检查未发现 SQLite/WAL，未读取凭据或原生私密内容。审计通过只表示盘点与证据边界准确，不代表未知费用已收敛。

对未决项，保留原 ID、预留、状态和证据；原 unknown 不自动重放，后续操作按暂停恢复派发处置（本轮不修改历史或日常控制记录）。后续只有取得对应原请求的可信供应商回执、宿主/资源代际事实和领域副作用核验，才能分别处理对应维度。没有供应商请求关联 ID、原 close/claim 代际或业务回执时明确列缺失，不补零、不更换幂等键绕过，也不把人工填表当可信证据。

## 5 分层验收与退出条件

| 层级 | 本轮验收目标 | 不能外推的范围 |
| --- | --- | --- |
| 历史只读盘点 | 完整 89 行、12 未知逐项、9 精确映射/3 桥接缺失、历史行摘要、原账本未变 | 历史 12 项已收敛或宿主/供应商新事实已取得 |
| factory/SQLite 与预算专项 | 完整 receipt 后预算写入缺口、重复/冲突/缺失值、原身份与代际、closed/registered/跨宿主/活进程、故障回滚、恢复计数与外部账本 hook 边界 | 实际主服务恢复或真实供应商账单已验 |
| 实际 index 与注入 transport | API/SDK complete 后预算写入前 SIGSTOP/SIGKILL、新 PID 恢复；SDK closed 后 confirm 前重启；unknown 保留；observe 零修复；closed 且无 pack 仍可修复原账务事实但不开放新任务 | 注入用量是供应商真实回执，或全部平台/自然故障已复现 |
| 原生宿主 | 实际 SDK guardian 和原进程组核验；记录版本、PID、close 与恢复事实 | PID 停止可以证明供应商没有费用或命令没有副作用 |

测试中的注入用量、故障屏障与受控进程操作必须明确标注；不重置历史证据，不把开发失败或重复补验额外计组。新增24组＝factory恢复9＋预算专项9＋实际index6，相关101组＝backend-runtime7＋backends14＋budget14＋context14＋production16＋queue11＋release7＋runtime18，合计125组通过。历史盘点不另计验收组，测试中的开发失败和重复补验不额外计入。


本轮新增验收证据：

| 证据 | 通过组数 | 载体与范围 |
| --- | ---: | --- |
| [factory 恢复](../reports/evidence/threaded-rc09/recovery.json) | 9 | 16 个独立 worker PID、4 个实际本地进程组、0 次 HTTP；旧代码缺口、跨 PID 竞争/幂等、维度缺失、事务回滚、身份冲突、unknown 保留、closed/registered/跨宿主/活进程及恢复计数/外部账本 hook 边界 |
| [预算专项](../reports/evidence/threaded-rc09/budget.json) | 9 | 10 次注入 HTTP、1 个短命 Node 子进程；原身份与可信 verifier、价格缺失/全未知、事务原子性、幂等与冲突、静止不补远端事实、退休代际与后继隔离、24 小时窗口和同 Attempt 多请求分别记账；该子进程不是 SDK |
| [实际 index](../reports/evidence/threaded-rc09/main-final.json) | 6 | 12 个 index PID、2 个实际 SDK guardian、6 次注入 HTTP；实际入口与生产恢复接线，正常执行无隔离执行 bypass；供应商响应和崩溃屏障显式注入，真实供应商请求 0 |

此处的进程数按层记录，不相加宣称部署规模。已知回执修复不能使旧终态或正文重新发布；历史 12 项没有 complete 用量回执，继续保留，不进入新测试的已知结算统计。

RC09 的退出记录须分别列明新增恢复代码的实现/验证结果、历史未知的逐项处置、仍缺失的可信事实、真实请求数与未验范围。本轮不调用真实供应商，不改共享账本或日常数据库；进程、费用和终态保持独立，历史 unknown 不被新测试成功消除。RC04 自然双 HEAD、RC05 原超时和片长可用性、RC06 工程写入/merge/资源等待/legacy 混跑、RC07 默认窗口自然压缩/产品 seal/index 完整原生组合、RC08 历史 T08 取消和真实故障交叉限制继续有效。RC10 综合链、RC11–RC12 发布是独立后续任务。
