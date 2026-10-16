# G5 实施与验证进展

首次记录：2026-10-16；更新：2026-10-17。结论：G5 已交付原生冷边界、控制动作与本地混合调度验证，以及有限 Coordination 接入，仍处于进行中，不能标记完整原生能力包可用。

## 本次交付

- 每次原生启动独立 home/workspace；SDK 关闭持久会话、自动记忆及 CLAUDE.md，Codex 使用临时线程；同 audience 与私密→公开均不复用。
- 托管 API relay 继续隔离密钥；Codex 登录账户实现短期令牌的进程内认证通道，未复制刷新凭据。
- v3 候选适配、执行桥范围检查、工具结果来源账本、原生未知用量占额和执行后目录清理。
- 修复 Codex 在同一 stdout 批次收到 turn/start 响应和完成通知时的关联竞态；先获得并验证 turn ID，再处理排队通知。
- 控制候选提交后封闭正文与工具，最多等待 1.5 秒收集最终用量。SDK 使用查询级 modelUsage；Codex 只使用封闭后收到、且伴随结束回执的用量。缺少可靠最终回执保留 unknown，中间用量不冒充结算。
- 无工具、只读模型 API 的 R7 静态步骤接入公共 Scope；来源漂移阻断；结果与完成验收原子提交；已完成步骤可以进入 G3 授权汇总服务。
- 已授权的观察者进入冻结 audience，但不增加执行节点；检查点返工在冻结契约时明确排除新 Scope 路径，保留独立成员的既有结果。
- Schema 17：支持两类 Attempt 的范围绑定，历史记录保持不变。

## 验证证据

全部自动验收使用临时数据库与夹具。没有向真实供应商模型发送请求，没有使用业务账户创建测试 Run。

| 验证 | 结果与证据范围 |
|---|---|
| `pnpm verify:scoped-native` | 真实安装的 Claude SDK 对接回环 Messages 服务；Codex 使用 stdio 夹具；四种 v3 动作、混合批次、运行中取消/来源漂移、最终用量缺失阻断、迟到正文拒绝及目录清理 |
| `pnpm verify:scoped-native-codex-protocol` | 真实安装 Codex app-server 两次启动；临时线程跨进程不可恢复；账户使用 0，模型回合 0 |
| `pnpm verify:scoped-attempt-migration` | 历史绑定/账本逐字保留，重复升级幂等，外键完整，provenance 仍不可修改 |
| `pnpm verify:stage-scheduling` | R7 全矩阵与新增公共 Scope 用例；不读房间历史，保留 Owner 验收和观察者权限，支持授权汇总来源，依赖漂移后不发布结果；无工具检查点返工仅重做 B 与汇合并保留 A |
| `pnpm verify:scoped-collaboration` | G1 范围、来源、拒绝非法版本与新 schema |
| `pnpm verify:scoped-delivery` | G2 17 项，44 次 mock 调用，外部网络 0 |
| `pnpm verify:information-release` | G3 15 项，30 次 mock 调用，外部网络 0 |
| `pnpm verify:scoped-recovery` | G4 25 项、16 次 SIGKILL、22 个竞争 worker |
| `pnpm verify:runtime-coordination-adapter` / `verify:runtime-coordination-closure` | 原公共责任适配与完成闭环回归 |
| `pnpm verify:external-agents-d` | 原有工作区隔离、SIGKILL 恢复、会话恢复与增量上下文回归通过 |
| `pnpm typecheck` | shared、server、web 全部通过 |

协议夹具证明的是协议和平台约束；本机 SDK + 本地模型响应不等同于供应商实测。Codex 临时线程试验也不证明登录账户推理或多模型兼容性。

2026-10-17 最终原生矩阵：10 个本机 SDK 进程、12 个 Codex 夹具进程、10 次回环 Messages 请求，真实供应商模型请求 0。SDK 使用 PostToolUse 在控制工具返回时结束，再收取最终用量；主动取消与来源漂移仍按未知调用处理。

混合调度用例仅在临时数据库中构造冻结的原生角色快照，随后运行真实调度器、责任事务和预算服务。生产预览没有新增绕过准入的开关。API＋Codex 夹具、API＋Codex 夹具＋本机 SDK 的 all 批次可完成；没有最终用量的组合应失败并保留未知占额，此为负向验收的预期结果。

## 尚未完成的 G5 验收

1. 获准账户、明确次数/时间上限下，验证 Claude SDK 和 Codex 登录/Key 组合；当前没有这部分新证据。
2. 补齐原生端到端发布授权、any 竞争取消和崩溃恢复矩阵。四种控制动作的适配、all 混合调度、主动取消/来源漂移及缺少最终 usage 的阻断已有本地证据，不能代替以上剩余组合。
3. 原生业务工具及 Coordination 原生成员的新公共 Scope 接入；当前不开放。既有 R7 原生静态能力保留原契约。
4. 新 Coordination 发布入口的普通 UI 交互和完整端到端验收归入 G6。

因此原生能力发现只标记 foundationImplemented，不提升 implementationSupported/configuredAvailable/connectionVerified；独立材料预览继续解释并阻断原生成员。

## 本地数据

升级前已创建一致性备份：`/private/tmp/agent-gand-before-g5-20261016.sqlite`，权限 0600。升级前业务 Run 共 83 条：completed 65、failed 16、cancelled 1、waiting_for_user 1。验收不应改变这些业务结果。

2026-10-17 已重启本地后端：`/api/health` 返回正常，前端 `http://localhost:5173/` 返回 HTTP 200。业务库 schema 为 17，外键检查错误 0；83 条 Run 的完整行摘要与升级前备份一致，状态分布未变化。此轮未提交或推送代码。

契约见 [原生冷边界与 Coordination 公共范围](../architecture/scoped-native-coordination-v1.md)。
