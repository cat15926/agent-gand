# 持续协作 T03 执行边界验收记录

日期：2026-10-20（Asia/Shanghai）。范围：可信 Binding、Invocation/Run 适配、专用生命周期、审批/控制/账户撤销/恢复接线、fake executor。

## 基线与交付

T02 已按用户要求提交并推送 `origin/main`，提交 `5298a9d`（`feat(threaded): establish T02 isolated foundation`）。T03 基于该提交实施，本轮代码和文档留在工作区，尚未提交。T01 固定代码及来源证据保持历史用途，不覆写其 hash。

实际合同见 [T03 架构](../architecture/threaded-execution-boundary-v1.md)。新增 v26，不修改已提交的 v25。生产服务接入专用控制、账户撤销和恢复；执行资源默认拒绝，工作入场仍关闭，runner 仅允许显式注入的隔离 executor。

## 检查与证据

| 检查 | 结果与范围 |
| --- | --- |
| `pnpm verify:threaded-migration` | 通过；9 组。新增真实冻结 v25 升级/兼容拒绝、v26 故障回滚、复合作用域与不可变约束；保留 v24 验证 |
| `pnpm verify:threaded-lifecycle` | 通过；21 组。Binding、冻结快照下的 Run/Attempt 原子适配与重试、unknown、审批/控制、终态回滚、外层事务拒绝与释放故障恢复 |
| `pnpm verify:threaded-controls` | 通过；专用 HTTP 身份/CSRF、跨 Thread 拒绝、幂等控制/审批、兄弟调用隔离、注销独立性、真实账户撤销事务及回滚、生产恢复入口；零外部请求 |
| `pnpm verify:threaded-isolation` | 通过；6 组新模式/未知/错配 fixture，旧执行入口不接管，旧三模式终态正向对照 |
| `pnpm verify:threaded-access` | 通过；专用认证、owner、HTTP/WS、失效与关闭入场 |
| `pnpm verify:threaded-legacy-boundary` | 通过；旧 HTTP/WS、派生 ID 与写入前隔离 |
| `pnpm verify:runtime-terminal` | 通过；保留旧完成证明、原子终态、并发与崩溃恢复 |
| `pnpm verify:runtime-run-policy` | 通过；原冻结策略及历史兼容边界 |
| `pnpm verify:runtime-hold-recovery-v2` | 通过；原持久等待、超时、代际及跨进程竞争 |
| `pnpm typecheck` | 通过；shared/server/web 全量类型检查 |
| `pnpm verify:docs`、`git diff --check` | 通过；本地文档链接与差异空白，新增文件另检查空白 |

数据库、Agent 目录及工作目录均在临时隔离路径；测试没有启动日常服务、迁移日常业务库、读取实际账号凭据、运行 SDK 或调用真实模型。fake executor 逐场景计数；拒绝路径为零次调用。

交叉审查覆盖并修复：重复审批被自身 pending 阻断；账户整体撤销只处理当前身份代际；Thread 恢复覆盖更窄范围的暂停；prepared 恢复重复增加代际；终态提交后资源释放失败；旧 callback/释放证明不能作用于后继 Attempt。同 Run 重试还验证首 Attempt 的成员/权限/账户快照不变，变更时整次 prepare 事务回滚；unknown 不能借一般对账证明伪装成“确认未启动”。

## 原验收 ID 的结论边界

| ID | 本轮证据 | 后续责任 |
| --- | --- | --- |
| ISO02 | 新 Run adapter 与专用恢复；旧 dispatcher/finalizer/recovery 继续隔离 | T04/T06 实际资源及队列完整恢复 |
| ISO03 | 持久 Binding 全字段和成员/账户/epoch/claim 复验，缺失/伪造/失权零 fake 调用 | T07 真实 provider、native session 与工具接线 |
| ISO04 | 专用控制/审批、重启后不盲重放、账户撤销原子生效、Run/Invocation 投影一致 | T05/T06 的 wake/outbox；T07 实际后端恢复锚点 |
| ISO05 | 输出、证明、Run/Invocation/Attempt 同事务，失败整体回滚，重投不重复提交 | T05/T06 加入消息和必要 outbox；本轮不标整项通过 |
| DB03 | v25→v26 幂等升级、历史 checksum 保留、旧程序拒绝新版本 | 后续迁移与发布/回退演练继续逐版验收 |
| Q06、REC03 | executor 抛错但仍 alive 保留围栏、未知结果不重试；旧 proof 不能释放新 claim | T04 实际资源，T07 真实进程/Session，T12 平台组合 |

16 条核心规则、59 项原场景及“必须观察到”不改写。未据本轮计算复刻比例；高级能力与可靠性增强仍保留独立责任。生产预算预留、消息/Outbox、Action、语义记忆、其他平台均没有由 fake 验证升级为可用。

## 下一步

T04：接入持久资源 tickets/claims/epochs，全模式 exclusive/thread-slot 竞争、共享容量与公平性、真实 Session 身份及恢复释放协议。消费 T03 的 claim 与 QuiescenceProof 合同，证明 DB 提交、资源释放与故障重启之间的幂等关系。T05 可按既定依赖并行；T06 等待 T03–T05，不提前开放真实执行。
