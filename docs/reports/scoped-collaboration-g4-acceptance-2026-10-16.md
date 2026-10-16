# G4 持久恢复、竞争与费用强化验收记录

实施及验收：2026-10-15 至 2026-10-16。开发基线：`main@88d2532f948d89dde1c72c1e43350a881dca6969`；本报告与 G4 实现同次提交。关联：[实施指导](../plans/scoped-collaboration-implementation-guide.md)、[恢复契约](../architecture/scoped-collaboration-recovery-v1.md)。

## 1. 交付结论

G4 已完成：单批只读 any、失效 Attempt 的可判定恢复、成员占用代际保护、调用/Token/费用关联，以及真实子进程 SIGKILL 和跨进程竞争矩阵。没有使用真实供应商、业务角色或原生客户端运行 G4 测试。

正常聊天室“独立材料协作”可选择“首个有效结果后继续（只读）”。该选项限第一批、最多三项（仍服从配置上限），所有事项必须提交实质结果；胜者之外的项停止。组织者仍只接收固定状态，未胜出项的迟到结果不能进入汇总或发布。

确定业务失败、未知模型消耗或未知外部写入不会自动重开。可恢复的进程中断只重新执行未完成事项，保留成功项、输入范围及共享预算。SDK/CLI、Coordination 新范围支持与更广泛产品灰度仍属于 G5/G6。

## 2. 实际修复

1. **领取后的安全恢复**：原通用 lease Hold 与 scoped 命令的上下文约束不兼容；改为在失效 Attempt 的事务内判定是否重排，下一次领取建立新 generation 与 Scope。
2. **成员占用恢复**：旧进程的 active/done 票据原本会拒绝新的安全重试。恢复现在与调用账本一致，成员 lease 区分 Attempt，旧释放回调不能清理新占用。
3. **调用与费用关联**：一次模型调用的 ID 同时绑定 Token/费用预约。未发出请求结算为零，已发出但未知的请求保留占额；钱与 Token 正常结算同事务。恢复不会修改仍在执行的兄弟成员预约。
4. **派发前围栏**：再次检查 Attempt、Dispatch、Run 和 lease，阻止已取消或失效的等待调用进入供应商。
5. **唯一胜出与固定收敛**：复用既有 Candidate、winner CAS、义务和取消机制。any 的最后一次固定状态核对不再请求模型，避免为收尾突破未知费用围栏。
6. **提交后通知**：完成状态通知在外层事务提交之后发送，事务回滚不广播假完成。

新增 `recoveryVersion=1` 与迁移 v16。v16 是恢复语义和账本关联的兼容标记，未改写既有迁移 descriptor/checksum，也未给历史计划补写新契约。

## 3. 崩溃与竞争矩阵

`pnpm verify:scoped-recovery` 最终 **25 类用例通过**，包括 **16 次 SIGKILL**、**22 个竞争 worker**，网络请求为 **0**。最终矩阵在允许读取本机进程身份的环境中复核通过。使用真实 SQLite 事务、运行契约、Scope、Action Command、完成检查、调度器和发布服务，仅替换模型；故障注入只存在于隔离测试子进程。

完整可机器读取证据：[G4 矩阵及预算记录](evidence/scoped-collaboration-g4-matrix-2026-10-16.json)。

| 故障/竞争 | 断言 |
|---|---|
| 第二个信封创建后、批次事务提交前杀进程 | Batch、信封、子责任及动作回执整体回滚，无半批 |
| 批次事务提交后杀进程 | 复用已提交批次，不重复子任务 |
| 领取后、预约后尚未发出、请求发出后杀进程 | 分别无费用重试、原预约归零、未知占额且不重发 |
| 输出用量已落库、完成命令提交前/后杀进程 | 已付费用保留；仅未完成项重试；已完成项不重做 |
| 一个兄弟成功、另一个中断 | 成功消息与 Attempt 保持，不复制成功输出 |
| 一个兄弟失效、另一个仍在调用 | 活跃调用的 Token/费用预约保持 pending |
| 固定状态投影提交前/后杀进程，并发 reconcile | 唯一父级恢复、无重复状态投影 |
| 两个 worker 同时返回成功结果 | 仅一个 winner，迟到 loser 无可发布输出 |
| 同进程取消 loser | 未知调用费用保留，固定状态收尾不新增模型请求 |
| any 全失败 | join 失败，不能变成父成功 |
| Stop 与 complete 竞争 | 终态后不能提交新的完成命令 |
| 注入未知外部写入账本 | 保留 needs_attention，不自动重放；未实际执行外部写入 |
| 发布提交前/后杀进程 | Grant、消息、ReleaseRecord、唤醒事件一起回滚或保留 |
| Hold 领取后、wake 提交前/后杀进程，两个 worker 唤醒 | 租约失效后可接管，最多一个 resume |
| 发布与发布/Stop/撤销竞争 | 单次消费；停止/撤销先提交则拒绝，发布先提交则保留事实 |
| Stop 与 wake 竞争 | 终态不新增调度；至多一个随后取消的恢复 Dispatch |

相同 Grant 重放返回完全相同的发布结果。既有 G2 动作幂等回归继续验证重复命令返回原结果、改变意图冲突且不增加预算。

## 4. 费用对账

矩阵审计了 23 个 Run：79 条调用准入记录，其中 78 条记录到已发出状态；这不是供应商真实调用。按每次桩响应输入 3、输出 8 Token，配置报价为输入 1 / 输出 2 USD 每百万 Token；一次正常响应计 0.000019 USD。

| 场景 | 调用准入 / 已发出 | 已计入输出 Token | 已计入 USD |
|---|---:|---:|---:|
| 领取后崩溃，安全恢复 | 4 / 4 | 32 | 0.000076 |
| 预约后尚未发出即崩溃 | 5 / 4 | 32 | 0.000076 |
| 输出已持久化、业务完成前崩溃并重试 | 5 / 5 | 40 | 0.000095 |
| 完成提交后崩溃 | 4 / 4 | 32 | 0.000076 |
| 请求已发出但结果未知 | 3 / 3 | 4112 | 0.009986 |
| any 胜出后取消仍在执行的 loser | 3 / 3 | 4112 | 0.009986 |

未知场景保留 4096 输出 Token 预约，另有两次已知响应共 16 Token。费用按冻结报价和请求估算保留，未把取消或进程退出当成免费。每条预约都核对对应调用 ID；多次恢复不增加预约，已知成功调用不被重新计费。重新请求模型的未完成事项会产生一笔新的真实准入和估算费用。

上述金额来自测试报价，证明账本处理，不代表任何真实供应商收费或账单硬上限。

## 5. UI 与回归

`pnpm verify:scoped-delivery-ui`：5 组交互检查、10 次模型桩调用、0 外部请求、0 页面错误。覆盖默认 all、连续批次、私密结果、编辑使预览失效、刷新、停止，以及只读 any 的预览/唯一结果。1440px 桌面及 390px 窄屏验证无水平溢出；窄屏表单截图已检查。截图及 UI JSON 留在忽略目录 `apps/server/data/scoped-g2-ui-qa/`。

已通过的相关检查：

```sh
pnpm typecheck
pnpm verify:scoped-recovery
pnpm verify:scoped-delivery
pnpm verify:scoped-delivery-ui
pnpm verify:information-release
pnpm verify:scoped-collaboration
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:scoped-collaboration-baseline
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-hold-recovery-v2
pnpm verify:runtime-action-commands
pnpm verify:runtime-consult-any
pnpm verify:cost-budget
pnpm verify:stage-scheduling
pnpm verify:docs
git diff --check
```

G2 仍为 17 类用例、44 次模型桩调用，G3 为 15 类、30 次模型桩调用，均零网络。阶段调度回归覆盖其原有 SDK/Codex 本地协议桩，不能据此宣称 G5 的外部后端新 Scope 已实现。修正了该脚本滞留在 v11 的迁移断言，改为核对当前迁移清单。

## 6. 本地服务与业务库

开始改动前创建 SQLite 一致性备份 `/private/tmp/agent-gand-before-g4-20261015.sqlite`，权限 0600；停止旧后端后实施及隔离测试。完成后已重新启动后端：`http://127.0.0.1:3010`；前端维持 `http://localhost:5173/`，健康接口与页面均正常。

业务库从 v15 追加升级至 v16，Run 数维持 **83**：completed 65、failed 16、cancelled 1、waiting_for_user 1；独立材料任务数仍为 0。`PRAGMA integrity_check` 返回 ok。没有创建真实验收任务、调用真实模型或改写历史计划；启动本身会更新正常服务运行元数据，因此不宣称数据库字节完全未变。

服务日志：`/private/tmp/agent-gand-g4-server-20261016.log`。
