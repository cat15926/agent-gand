# G5 实施与验证进展

最新接入收尾见[SDK 文件工具与原生 Coordination 报告](scoped-collaboration-native-integration-2026-10-17.md)。下文保留各次实施时的历史状态和计数，不能作为当前准入矩阵。

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

以下为最初本机验收证据：使用临时数据库与夹具，供应商请求为 0。2026-10-17 新增有上限的真实账户验证，结果与原生扩展矩阵另见[收尾报告](scoped-collaboration-closure-2026-10-17.md)，不能将以下历史计数当作最新结论。

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

## 2026-10-17 收尾与未完成项

本机 any、两个原生后端的私密汇总/专用授权/幂等发布、四个拥有者 SIGKILL 场景已通过。当前脚本记录 17 个 SDK 进程、18 个 Codex 夹具进程及 17 次回环 Messages 请求，供应商请求为 0。普通 SDK 权限拒绝和冷目录恢复不读取祖先仓库差异也有独立断言。

鸡腿账户 SDK 的真实冷边界及四种 v3 控制动作通过；Codex 登录账户的冷边界、complete、consult_batch 通过，但后续身份检查超时。累计 13 条平台调用，11 completed、2 unknown；已知输出 2,342，未知占额 24,000。真实混合发布未开始，原生能力包仍未开放。

1. Codex ACK、发布请求及含 Codex 的真实混合发布按用户最新安排暂缓；保留已有失败和未知占额。不含 Codex 的模型 API + Claude SDK 真实发布闭环已补齐，见下文。
2. 原生业务工具及 Coordination 原生成员的新公共 Scope 接入仍未实现；既有 R7 原生静态能力保留原契约。
3. Codex API Key、Claude 原生登录及其他供应商组合没有本轮供应商证据，不能由当前两类账户推广。

原先归入 G6 的 Coordination 普通 UI 与发布端到端验收已完成，见 [G6 报告](scoped-collaboration-g6-acceptance-2026-10-17.md)；这不解除上述原生 G5 门槛。

因此原生能力发现只标记 foundationImplemented，不提升 implementationSupported/configuredAvailable/connectionVerified；独立材料预览继续解释并阻断原生成员。

### nim 角色更新后的补验

另起隔离新轮，明确选择 nim v4 的 Codex app-server / default / 既有登录账户。当前单回合 SDK 配置完成 6 次真实调用；nim 身份检查及会话绑定通过，但模型列表刷新网络超时，600 秒内未返回控制结果。新轮 7 条调用，6 completed、1 unknown；已知输出 1,365 加未知占额 12,000，合计 13,365。旧轮 2 条 unknown 不变；真实混合发布仍未开始。已修复标准请求时限被误记取消，并增加续测角色定义漂移检查，详见 [nim 验收报告](scoped-collaboration-nim-codex-acceptance-2026-10-17.md)。

用户随后要求先跳过 Codex 角色验证。新验收支持显式 `--skip-codex`，不复制 Codex 账户或登录凭据、不启动其客户端；既有含 Codex 的验收不能改用此参数续跑，避免将历史失败改写为跳过。Codex 后续实测列为暂缓，不阻塞其他组合验证。

### 模型 API + SDK 真实闭环

跳过 Codex 的新轮已通过所选范围：2 次模型 API、10 次 SDK，共 12 条 completed，输出 7,131 tokens，无新增 unknown。覆盖 SDK 冷边界和四动作、API 组织者与 SDK 私密成员、SDK 私密汇总、专用 Owner 批准、幂等确切文字发布及发布后结束。原报告仍为私密，业务库 87 条 Run 未变化。旧 3 条 unknown 保留；完整 G5 及原生生产准入不因此放行。详见 [API + SDK 验收报告](scoped-collaboration-api-sdk-acceptance-2026-10-17.md)。

## 本地数据

升级前已创建一致性备份：`/private/tmp/agent-gand-before-g5-20261016.sqlite`，权限 0600。升级前业务 Run 共 83 条：completed 65、failed 16、cancelled 1、waiting_for_user 1。验收不应改变这些业务结果。

2026-10-17 已重启本地后端：`/api/health` 返回正常，前端 `http://localhost:5173/` 返回 HTTP 200。业务库 schema 为 17，外键检查错误 0；83 条 Run 的完整行摘要与升级前备份一致，状态分布未变化。此轮未提交或推送代码。

契约见 [原生冷边界与 Coordination 公共范围](../architecture/scoped-native-coordination-v1.md)。
