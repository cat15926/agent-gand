# 持续协作 RC10：综合链验收与发布审查

日期：2026-10-27（Asia/Shanghai）。基线为本轮已提交并推送的 RC09 `915f106`。RC10 的综合验收资产与发布审查已建立，本轮8组专验＋52组有组数回归，共60组通过，另3套完整suite通过；真实综合链三次未通过。**完整模式发布门槛仍未满足，59 项未全部通过，日常仍默认 closed。** 本轮不启动 RC11/RC12，不修改日常数据库、发布配置或生产 schema 35；RC10 变更尚未提交。

原 K01–K16、59 项场景/预期与 E01–E06 非状态文字保持不变。当前结果回填[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。本阶段交付的是可重跑综合验收、分层证据和发布阻断清单；没有通过缩小原合同使发布门槛变绿。

## 1. 冻结的验收范围

| 维度 | 本轮范围 | 不替代的证明 |
| --- | --- | --- |
| 平台和后端 | macOS；API `threaded-http-v1` 与 Claude SDK `0.3.288`；独立临时 SQLite，实际 `apps/server/src/index.ts` | 其他操作系统、全后端笛卡尔组合、日常配置启用 |
| 消息与协作 | A 在原 Thread 公开接力 B；B 跨到工作 Thread；征询 C/D；C 原答保留、D 暂停到期；服务重启后唯一回调 | 发送中真实供应商超时、网络失联的所有组合 |
| Action 与评审 | 工作 Thread 内一个 canonical PR review Action；两代评审、逐 finding 修订；通过后显式跨回原 Thread | 自然 GitHub HEAD 变化、真实代码审查或远端 review/merge |
| PR 来源 | 生产 GitHub 注册、身份和权限核验；精确 GET `/user` 与单个 PR 响应在 transport 注入 H1→H2 | RC04 两次自然新 HEAD `not_observed` |
| 可靠性 | 同根预算与状态持久化；旧回调/权限变化/耗尽拒绝分别验收 | 通过数量不能合并成未执行的真实故障交叉组合 |

跨 Thread 接力由 `cross_post_message` 完成。Action 的 home Thread 和冻结 predecessor 规则不变；不能在另一 Thread 重建同一 canonical 责任代替返回路线。评审交付完成责任与批准门禁分开核验；`changes_requested` 可以完成 Action，但 gate 必须 blocked。新 HEAD 修订是 attested，只有独立 reviewer 的证据才能把 finding 变为 verified。任何本地 approved 都明确 `externalApprovalGranted:false`。

实际 index 的合成根通过 Owner CAS 使用明确测试政策，原版本与新版本保留在 budgetVersions/finalAudit：

| 政策 | 生产默认 | 本轮隔离根 |
| --- | ---: | ---: |
| Invocation 上限 | 20 | 30 |
| A2A 深度上限 | 15 | 25 |
| 根货币预算上限 | 5美元 | 100美元 |
| 活动片 | 1秒 | 10秒 |
| 未知费用 | stop | 每请求保守预留1美元 |

上述货币上限/预留是应用内预算策略，不是供应商实际账单；共享token账本还有独立100万累计门禁。生产默认没有修改，不能据此证明默认政策下完整链可用。

## 2. 分层验收

| 层级 | 结果 | 证据与说明 |
| --- | --- | --- |
| 工厂综合链与负向分支 | **7 组通过** | [chain.json](evidence/threaded-rc10/chain.json)：16 次注入 HTTP、2 个独立恢复 worker PID、零真实外呼 |
| 实际 index 注入链 | **1组通过** | [main-injected-delivery.json](evidence/threaded-rc10/main-injected-delivery.json)：3个实际index PID、29个注入请求；合成账号和实际SDK进程；[强化审计](evidence/threaded-rc10/main-injected-delivery-chain-audit.json)精确核对返回/原答/修订/唯一派发链 |
| 实际 index 真实模型链 | **三次未通过，0组通过** | [第一轮](evidence/threaded-rc10/main-live-first.json)、[第二轮](evidence/threaded-rc10/main-live-second.json)、[第三轮](evidence/threaded-rc10/main-live-third.json)均保留；第三轮已验证局部SDK回答/新PID恢复，但无两代修订及返回原Thread，不计整链通过 |
| 旧模式/发布旁路回归 | **52 组＋3 套完整回归通过** | [coexistence-summary.json](evidence/threaded-rc10/regressions/coexistence-summary.json)，零供应商请求 |
| 验收文档审计 | **119 行逐项映射** | [acceptance-audit.json](evidence/threaded-rc10/acceptance-audit.json)：K16/F12/P14/S12/E6/原59；不计行为测试组 |
| 文档防伪检查 | **5 个负例拒绝** | [audit-negative-checks.json](evidence/threaded-rc10/audit-negative-checks.json)，不得改核心、伪报 MEM01 通过、改 E 合同或留缺失证据链接 |

工厂 CHAIN01–05 是同一双 Thread 链：A→B、C 原始独立回答、D 到期、SIGKILL 后恢复、评审修订、回原 Thread。第一代 reviewer 登记的 grounded timer 在第二代产生后到期，被 `THREADED_ACTION_STALE_GENERATION` 拒绝，没有回调 message/wake。独立 reviewer 权限版本变化后 gate 为 unverifiable。返回原 Thread 后原根预算耗尽，零请求派发；Owner CAS 调整额度不删除旧请求账本；跨 Thread 重建同 PR Action 被拒绝。CHAIN06 的单目标 HTTP400 和 CHAIN07 的暂停回调撤权是独立旁支，不伪称与主链同一执行。

实际 index 层使用生产 singleton、发布成员 pack、Thread grant、认证 HTTP 管理及消息入口；预加载器只配置合成数据、受限 transport/时钟与观测点，不启用 factory execution bypass。测试调度屏障等待 reviewer 完成责任和 gate 检查后，才放行作者读取评审的模型请求；这是确定性验收控制，不证明产品能自动处理所有并发到达顺序。负向旧 callback/权限/预算由工厂层覆盖，不伪报为真实供应商故障。

## 3. 费用与失败取证

沿用 `/tmp/agent-gand-t07-authorized-token-ledger.sqlite`，本轮起点 89 行（77 known、12 reserved）：确认 220,478＋未知预留 206,832＝保守占额 427,310 token。用户原授权 1000 万 token 不变；本轮内部累计保护线从 50 万调整为 **100 万 token**，新请求发送前按精确持久 request hash 原子预留。原 89 行须逐行保持一致，不复用新成功来消除旧 unknown。

三次真实运行新增22笔账本记录，其中21次到达供应商外呼起点（20 API、1 SDK），1笔停留在本地测试屏障、没有进入网络发送。18个完整回执确认 **74,649 token**，4笔保留预留 **87,123 token**（3笔可能已发送＋1笔明确未外发的本地预留）。最终111行：95 known、16 reserved；已知 **295,127**＋保留预留 **293,955**＝保守占额 **589,082 token**，内部100万门禁余 **410,918**。原89行逐行保持不变；[逐笔诊断](evidence/threaded-rc10/real-failure-diagnostics-final.json)给出身份关联和缺失事实，未退款或重放。token 统计不等于供应商金额对账。测试账号配置和凭据只读读取；凭据经私密 IPC 到隔离进程，临时副本按仅存于本轮父/子进程内存的密钥加密（父进程保留供同轮重启）；原始 key 不进入命令参数、日志或报告。GitHub 使用纯合成 token，不读取或写入真实 GitHub。

每次 actual index 结束先停止本轮服务及核验受管 SDK 进程组，再从白名单安全表导出最终请求、用量、预算、回执、进程、消息及 Action 事实到报告，最后删除临时库。不导出账号/凭据/管理会话表。即使运行失败或新增 unknown，也保留最终审计快照；导出失败本身使验收失败。

开发证据保留且不重复计数：工厂首跑 `budget.usage` 拼写错误，修正为公开 `getUsage` 后通过；第二次工厂通过未包含增强的旧 generation timer，最终以 chain.json 为准。actual index 首跑预加载路径误指 RC08、第二跑注入 `/user` 缺少整数 id，被生产校验拒绝；第三跑把征询与Action完成回调混为一计，断言失败。前三次均零供应商请求，是验收夹具/统计错误；第四次通过及最终通过各为重复证据，只计最终1组。回归 `legacy-resources` 首跑因 sandbox 不能读取自身进程身份失败，批准 ps 后原脚本通过。

## 4. 三次真实运行的失败与边界

| 运行 | 已观察事实 | 未通过原因及处置 |
| --- | --- | --- |
| 第一轮 | 1个完整API回执，随后第二请求已登记发送 | 模型给 `post_message` 的可见性参数冲突，服务器拒绝。测试中断下一请求；新增已知2783、预留20106。原工具输入未记录，不能反推具体参数值。后续测试提示明确省略可选隐私参数，并在工具错误后禁止继续外呼 |
| 第二轮 | 公开接力工具成功；两个请求约10252/10166ms后、未收响应头进入unknown | 当时活动授权仍余9733/9425ms，排除活动片到期；Node默认10秒建连超时与时序吻合，但没有cause code，只能标推断。最终`RC10_TIMEOUT_facts`来自测试终止阶段，不是这两次网络失败的根因。新增已知2831、预留42704 |
| 第三轮 | A→B、工作Thread征询、真实SDK原答；SIGKILL后新index保留原答/原deadline；受控到期产生唯一partial callback | reviewer在同一binding/代际1先提交changes_requested，再以另一idempotencyKey提交approved并解决finding；没有新HEAD、revision attestation、代际2或返回原Thread。验收等待的首代blocked gate未出现，B的预发送屏障请求最终unknown；新增已知69035、本地未外发预留24313 |

第三轮的同HEAD reviewer更新是当前评审工具允许的操作，不能只凭此测试认定为生产权限绕过；它违反的是本轮预定的两代修订验收路径。完整综合链的失败必须保留，不能因为局部gate显示approved便宣布场景通过。后续需提高角色提示的代际区分与场景偏离诊断，再在同账本内独立验证；不得重放旧未知Invocation或把模型行为改写成脚本代答来宣称真实通过。本轮已停止付费重试。交付脚本随后增加同代际错误verdict的快速场景失败诊断，明确reviewer只按`review_context.generation`选一次分支，并把共享账本预留移到本地屏障放行后、真实发送前；[最终注入回归](evidence/threaded-rc10/main-injected-delivery.json)及其强化审计通过。这些验收脚本改进未再运行真实供应商，不能升级真实层结果。

强化离线审计另外有6个篡改负例，拒绝错误返回触发、空finding、错误verdict、重复wake、缺修订响应和重置root；不增加行为组数。服务器类型检查通过。首次误用npm workspace命令失败的日志和随后pnpm成功日志均保留，不算产品失败。

## 5. 发布决策与剩余门槛

| 门槛 | 继续保留的缺口 | 后续应取得的证据 |
| --- | --- | --- |
| RC10 真实综合链 | 三次均未完成两代修订/返回原Thread | 保留失败原因、原答与账本，取得真实模型完整两代链及精确关联审计 |
| RC04 自然事件链 | 两次自然新 HEAD 未观察到 | 同 Action/root 的合法 H0→H1→H2、新事件唯一唤醒、旧批准失效、独立复审及返回 |
| RC06 工程协作 | 源写/merge 未交付；冲突 command 持久等待未实现 | 受信写入 profile、完整副作用资源声明、merge 责任/CAS、等待与恢复不丢唤醒 |
| RC06 旧新混跑 | 真实供应商混跑组合未验 | 共享 exclusive/Thread/Session/账号/工作区约束及不饥饿 |
| RC07 原生上下文 | 默认自然压缩、产品 seal、实际 index 完整原生组合未验 | 每种声明组合的续接或明确冷启、权限和来源保留 |
| RC08 可靠性组合 | 实际供应商取消/失联/outbox 竞争未全组合验收 | 按声明组合逐项补验；原取消原因未定位不得覆盖 |
| MEM01 / EXT01 | 语义检索未实现，MEM01 **整项未完成** | 独立召回、索引/排序版本、ACL 撤销闭合及真实质量证据 |
| RC09 历史未知 | 12 笔未知保留 206,832 token | 原请求身份桥接、完整可信回执及费用/副作用/静止证据；无依据不清零 |
| RC11 / RC12 | 日常迁移准备和灰度启用尚未执行 | 先满足发布门槛，再独立执行清单、授权和灰度验收 |

[机器审查](evidence/threaded-rc10/acceptance-audit.json)分别登记业务/核心实现/后端组合阻断、延期高级能力范围与历史保留处置；`fullContinuousCollaborationAccepted`、`dailyReleaseReady`、`all59Passed` 均为 false。RC10 的验收资产交付不等于 RC10 完整退出条件通过，也不构成开启持续调度的指令。

运行约束和重跑入口见[综合验收合同](../architecture/threaded-composite-acceptance-v1.md)。最终文件、哈希和验证项见[交付清单](evidence/threaded-rc10/delivery.json)。
