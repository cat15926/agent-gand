# 持续协作 T12：综合恢复、发布控制与宿主命令验收

日期：2026-10-21。基线：T11 `ba438b1` 已提交并推送 `origin/main`；本报告记录 T12 代码、测试及所列分层证据，提交版本以 Git 日志为准；未启用日常生产配置、未迁移日常库、未回写 Issue。状态：发布控制及所列隔离/宿主验收完成，完整真实故障组合与领域发布条件尚未全部通过，不能宣告全部 59 项验收完成。

## 变更和审计结论

新增 v34 发布与 OS 操作迁移，冻结 v25–v33 源码/descriptor。固定公开成员与账号版本的 release pack 由服务端读取，认证 Owner 独立控制新根入场与后续派发；授权 Thread/因果根同消息事务持久化。关闭新入场保留已有工作、历史及原预算；历史 Thread 不自动获得执行授权，成员/账号/backend 配置漂移明确 blocked。

真实后端工厂已接生产服务，但默认 closed、无清单、两个持久许可均关闭。启动统一恢复完成前底层 claim 屏障禁止提前外发；退出有界等待实际静止，超时保留 unknown。`observe` 重启后仅业务读取，不进行协作修复或任何控制写入。`drain.ready` 只覆盖 threaded，整库回退永远不能由它自动批准。具体合同与操作见[架构](../architecture/threaded-release-v1.md)、[发布手册](../operations/threaded-release-runbook.md)。

实现审计与反例测试修复了四个实际问题：订阅/定时器绕过启动屏障、queue/runner 残留隔离执行硬门、backend pin 漂移触发事件循环活锁及原因吞失、observe 旧控制路由仍可写。另补凭据版本缺行及解密失败的准入/稳定阻塞，避免假 ready 和重复解密活锁。测试现在在未设置隔离执行环境的受信生产工厂中验证这些边界。

受信 OS 命令端口限定固定 program/argv/env/cwd，具有独立命令资源、启动身份和进程组证明。Invocation 结束不丢失命令资源，旧 Action generation 的晚到完成不能唤醒新 holder。进程消失后仍需独立副作用核验；默认生产未注册任何命令或 GitHub provider。

## 分层证据

| 命令 | 结果 | 范围与证据 |
| --- | --- | --- |
| `pnpm verify:threaded-migration` | 17 组通过 | 实际 `ba438b1` v33→v34，旧非空工作流/消息/知识/预算哈希保留；中间 DDL/最终注册失败全回滚；重复迁移与旧 v33 worker 零修改拒绝 |
| `pnpm verify:threaded-release` | 7 组通过 | [证据](evidence/threaded-t12-release/isolated.json)：实际 IPC CAS/SIGKILL、冻结授权、角色/账号漂移、只读排空和一致备份恢复；不访问生产库 |
| `pnpm verify:threaded-production` | 16 组通过 | [证据](evidence/threaded-t12-production/isolated.json)：真正生产 factory/settings/HTTP，无 isolated 执行绕过；12 次注入 HTTP。启动屏障、独立门禁、关闭后重试/Decision 同根排空、配置漂移无活锁、有界退出、observe 六类控制零写入 |
| `pnpm verify:threaded-service-recovery` | 9 组、24 个实际子进程通过 | [证据](evidence/threaded-t12-service-recovery/isolated.json)：真实模块组合服务，注入模型；消息提交未提示、prepared 未发送、可能已发 unknown、终态后继、征询部分/超时/撤权、旧审批、停止/账号控制、query_only 与混合旧模式 |
| `pnpm verify:threaded-main-process` | 4 组通过 | [证据](evidence/threaded-t12-service-recovery/main-process.json)：实际 `index.ts` loopback 服务、closed SIGKILL/重启/历史哈希、登录失效、observe 只读、未来 schema 写前拒绝。没有固定 pack 或真实供应商，不能作为完整真实执行主服务验收 |
| `pnpm verify:threaded-os-commands` | macOS 8 组通过 | [证据](evidence/threaded-t12-os-commands/result.json)：真实 guardian/native/grandchild、取消/断 IPC/owner SIGKILL、伪造无关 PID 拒信号、独立资源、unknown 对账和旧代际；0 模型请求，未注册生产命令 |
| `pnpm verify:threaded-production-ui` | 实际 Chrome 5 组通过 | [证据与截图](evidence/threaded-t12-production-ui/report.json)：无 pack 拒建、仅标题创建固定成员、独立门禁、保留历史/已有队列执行一次、observe 实际服务重启及数据库哈希不变；1 次注入模型请求 |

服务组合进程、实际 `index.ts`、注入传输、真实宿主命令、真实供应商和真实 GitHub 分别登记，不互相替代。

## 授权真实后端

沿用用户已授权账号 `Claude-GML-5.3`、`open.bigmodel.cn`、`glm-5.3`，配置/凭据版本 2/1。只读来源库 accounts/account_versions/account_credentials/account_revocations，未读日常对话。密钥解密后仅内存和私有 IPC，隔离 SQLite、SDK home 和工作区；真实工作经认证 HTTP 入场。脚本为 `pnpm verify:threaded-production-real -- --authorized-real --account <授权账号ID> --token-ledger /tmp/agent-gand-t07-authorized-token-ledger.sqlite --token-limit 200000`。

首轮[原始失败报告](evidence/threaded-t12-service-recovery/real-production.json)：API 3 请求完成知识 publish/read/search 和 SOP update/read 五类工具，来源 ACL 与 attested 边界通过；SDK 首请求进入 unknown，整轮 4 请求，不能把 SDK 或整服务重启续接标为通过。原 harness 未保留底层异常且清理了临时执行库，当前只能复核原报告与独立费用账本，不能恢复该轮完整执行现场或归因于网络/模型。后续真实失败默认保留0700隔离现场。已增加定向补验诊断，复验结果须另文件保留，不能覆盖本失败。

首轮新增确认 7,988 token、未知预留 26,041；累计确认 44,305、未知预留 65,051，保守占额 109,356。原账本 24 条已知/未知记录逐行不变，旧 39,010 未知继续保留。用户总限额 1000 万 token，本次仍使用更严累计 20 万硬门禁，不重置账本或把未知当免费。

随后只跑 SDK 的[定向诊断](evidence/threaded-t12-service-recovery/real-production-sdk-only-2026-10-21T14-29-22-514Z-23b3eb69.json)仍失败：HTTP 200 SSE 收到 21,580 字节后，活动预算 `THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED` 中止流；实际进程组确认停止，不能因此确认供应商用量。新增 1 请求、未知预留 24,707；累计确认 44,305、未知 89,758，保守占额 134,063。它定位了本次失败，不足以断言没有诊断的首轮同因。失败现场保留在报告指定的 0700 临时目录，未重放旧 unknown。诊断端口另有完整响应、连接超时、流失败和取消竞争 4 组无网络检查，不记录请求/响应正文或 headers。

修复通过[6组活动心跳证据](evidence/threaded-t12-activity-heartbeat/result.json)确定性复现：连续缓冲SSE使定时器未及时调度，受信进度原先没有续期入口。现在由Runner在原窗仍有效时原子续期，再执行完整权限/上下文检查；SSE、SDK记录和工具端口仅触发节流提示。默认1000ms活动许可、根30分钟总量及过期拒绝规则未改变，过期gap/硬总量/撤权仍unknown且不重放。命令为 `pnpm verify:threaded-activity-heartbeat`；另有 `pnpm verify:threaded-real-diagnostics` 4组诊断验证。

修复后的[真实SDK复验](evidence/threaded-t12-service-recovery/real-production-sdk-only-2026-10-21T14-44-03-392Z-0c7afeb4.json)通过2组、4请求：SDK完成五工具；在首个SDK执行已完成且进程verified_stopped后，SIGKILL整个隔离HTTP factory服务，新PID/SQLite和新资源owner从原nativeId/anchor续接。恢复阶段零请求，旧预算和anchor字节不变，模型精确记住增量manifest未重放的随机marker，登录会话失效。该服务使用生产factory/routes/settings，**不是index.ts，也不是mid-flight SDK崩溃自动恢复证明**。

复验新增确认19,031 token、无新增未知。T12合计9请求，新增确认27,019、未知预留50,748；总账本确认63,336、未知89,758、保守占额153,094，低于200,000门禁。三轮旧行逐行不变，两个失败报告和旧未知不被本成功覆盖。

## 真实 GitHub 只读等待

`pnpm verify:threaded-tracking-github-live -- --authorized-git-credential` 使用已明确授权的 GitHub Git 凭据，只在内存访问官方 GET。首次连接失败后重试；成功窗口 606 秒、48 次 GET，观察 3 个公开 PR 的 live baseline 和真实 `track_event` 等待，**0 个自然 HEAD 变化，结果为 `not_observed`**，见[证据](evidence/threaded-t12-github-live/result.json)。重建 runtime/SQLite 零模型重放、零重复回调。未创建/修改 PR、branch、commit、评论或 review。

新增 `headChanged` 稳定事实和 6 个注入 producer 检查：baseline false、无变化不触发、单独 updated_at 不触发、新 HEAD 一次 true、重复无事件、仅 state 变化 false。它们不替代 W05 真实新 HEAD 唤醒成功证据。

## 回归、未决与发布限制

全量 typecheck 和 Web build 通过。运行时18、队列11、协作17、Action12、Review9、SOP6、知识8、后端14、backend-runtime7、协作后端4、协作HTTP4、投影HTTP4及隔离/旧边界/控制回归通过；共享资源19、旧资源11、资源组合8和晚到 Session3通过。Action 回归另存[T12 记录](evidence/threaded-t12-regression/actions.json)，保留历史报告。Web 构建仍有既有大 chunk 提示。

- 真实 SDK 五工具及隔离HTTP服务在静止执行后SIGKILL的原生续接补验通过；mid-flight SDK崩溃、真实 `index.ts` 带供应商的完整故障窗口未全部覆盖。
- W05 等待中的真实新远端 HEAD 未观察；新 HEAD 完整修订链仍只有注入传输证据。生产默认 GitHub/OS provider 未注册。
- 原生自动压缩、未知供应商费用最终对账、实际并发工程写作未完成；T08 首次征询取消根因未定位，不能被本次成功子项抵消。
- 语义检索未实现，MEM01 整项未通过；Collective、Linux/WSL/Windows、其他 driver、多租户/多机逐项保留原范围。
- 未做日常小流量放行、日常数据库迁移或整库回退。保留新库及匹配 worker 是回退合同；不得清理 unknown 或降低 schema。

K01–K16 与 59 项原场景/预期保持不变，实际状态见[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)。下一步按未决真实组合补证、对账和选定发布范围处理，不把本报告视为整体发布通过。
