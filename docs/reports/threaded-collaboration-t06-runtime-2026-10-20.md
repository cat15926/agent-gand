# 持续协作 T06：持久运行时验收

日期：2026-10-20。基线：T05 `98b331f`，已推送 `origin/main`。本次 T06 变更留在工作区，未提交或推送；没有回写 Issue、启动日常服务、读取或迁移日常业务库、调用真实模型或发布外部消息。

## 交付

追加 v29，保留 v25–v28 descriptor。Wake 独立排队并一对一映射 Invocation；完整资源 claim、预算预留、首个 Run、Attempt、Binding 和 dispatch 原子提交。完成时响应及后继 Message/Delivery/Wake/Outbox、预算、输出证据、Run/Invocation/Attempt 和队列投影共同提交，资源只在最外层 COMMIT 后释放。mapped Invocation 的独立 terminal 旁路被拒绝。

根预算分别记录 Invocation、Attempt、实际 request、活动区间和未知消耗。默认 300000/24576 输出 tokens、20 Invocation、2 Attempt、30 分钟累计活动、5 USD、A2A 深度 15；Owner 决策追加版本。活动许可提前 checkpoint，重叠工具区间按 Attempt 取并集；未知价格默认停止，未知 usage 按维度保留预留。执行未知和费用未知独立；已确认静止不因费用未知占住进程资源。usage 验证器默认拒绝，fake 证明不能用于真实供应商验收。

暂停仍接收消息；队列领取重验来源 ACL、成员/权限/角色/账户及作用域控制。Owner resume 的准确 epoch、消息接收时控制边界单独留证，原回执不改写。生产启动先原生/账户对账，再按持久事实恢复 Threaded。证明未启动可在同 Run/root 安全重试；started/unknown 不因租约到期重放。已提交终态只修复通知、投影和精确释放。

合同及接口范围见[持久调度与根预算 v1](../architecture/threaded-runtime-v1.md)。

## 确定性证据

| 检查 | 结果与边界 |
| --- | --- |
| `pnpm verify:threaded-runtime` | 18 组；真实双进程 SQLite/IPC 争同 Wake，仅一 Invocation/Run/Attempt；同文不同来源不合并；同槽 FIFO |
| Q05，无周期修复 | `repairIntervalMs=0`，最后空扫描期间入队以及 release/enqueue 重入均正常 drain |
| REC02–REC04，真实退出 | worker 在 prepared 后 exit24、started 后 exit23、终态 COMMIT 后 release 前 exit25；分别验证安全重试、unknown 保留、只修 cleanup，不二次模型 |
| DB01/REC06 写点故障 | 16 个终态写点和 11 个 admission 写点 trigger abort，整体事实回滚；只读库拒绝终态成功 |
| B01 普通接力 | 一次 aa 执行中 post 和 final 同文、均指向 bb，产生两个独立后继；三次 Invocation/Attempt/实际 fake request 共一个根，累计 21 output tokens、33 微美元 |
| 控制/预算 | cancel A 保留 B；paused 消息持久保存、零领取；closed/left/revoke 阻新领；预算 blocked 零执行资源/Run/request，Owner 恢复保持 root/FIFO |
| `pnpm verify:threaded-queue` | 11 组；原来源/顺序、Owner resume epoch、控制边界、权限与来源撤回、blocked FIFO、控制终态恢复投影；不按 TTL 推断静止 |
| `pnpm verify:threaded-budget` | 14 组；预留/结算、实际请求计数、活动并集/并发和等待、窗口/Owner 版本、未知与可信对账；未启动副请求退预留、未知副请求费用阻止自动重试 |
| `pnpm verify:threaded-migration` | 12 组；从实际冻结 `98b331f` registry/messages/outbox 建立 v28 消息、附件及消费 ACK，再升级 v29，DDL 故障整体回滚、重复升级不改旧事实，实际 v28 guard 拒绝 v29 |
| `pnpm verify:threaded-message-api` | 6 组；增加 paused 接收/稳定回执/历史读、一个 pending Wake 且零 Run/Attempt；closed 新输入拒绝 |
| 既有边界回归 | lifecycle 21 组、resource-integration 8 组、message-notifications 9 组，以及 access、controls、isolation 6 组、legacy-boundary；验证新接线不绕旧隔离/权限/终态边界 |
| 构建与文档 | `pnpm typecheck`、`pnpm verify:docs`、`git diff --check` 通过；16 条核心规则及 59 项原场景/预期与 T05 逐条比对不变；已发布 v25–v28 源文件不变 |

测试先设 isolated 环境，再导入应用模块，显式设置临时 sandboxDir。所有数据库均为临时 SQLite；并发/崩溃使用真实 IPC worker，网络与真实模型调用为零，最终外键检查干净。post 已提交消息与之后的 final 独立持久化，事务失败不撤回先前合法 post。

并发测试发现并修复了旧 eligibility 快照覆盖另一进程已领取状态的窗口：ticket eligibility 与最新队列/预算状态在同一 IMMEDIATE 事务重验，竞争失败者只返回空领取。交叉审阅另外补齐来源 ACL 的每效果重验、无 Invocation 的 resume 主动提示、控制终态的恢复投影和有界空扫描重入。

接线回归还验证了无周期修复时，Owner resume、根预算修订和 owner 窗口修订会主动唤醒被阻塞工作。真实 runner 持有 barrier 期间，外层 stop control 或账户撤权事务回滚后，AbortSignal 保持未取消，原调用继续正常完成。

## 验收范围与下一步

K01–K16 和 59 项原场景/预期原文保持不变。Q05、REC01–REC06、B01/B02 仅登记已执行的确定性范围；真实 provider、上下文游标、供应商 usage、原生进程恢复和 Action 修订/替换仍由后续任务分别验收。E01–E06 的征询 group/settlement 没有被普通 response 事务代替，仍待 T08 独立验证。平台差异和高级能力继续保留原范围登记。

下一项 T07：实际输入 manifest、三类游标/单条补投、权限/压缩边界及 API/SDK 后端；真实退出和 usage producer 必须接可信证据。当前生产 dispatchEnabled=false、没有 executor，closed/observe/execute 均不能开放真实新工作。
