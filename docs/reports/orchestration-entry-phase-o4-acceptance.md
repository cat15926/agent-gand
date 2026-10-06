# 编排入口 O4 验收记录

日期：2026-10-06。状态：本地实现与隔离 fixture 验收完成。对应 [O4 架构与接口指南](../architecture/orchestration-entry-phase-o4.md)及 [实施计划](../plans/orchestration-entry-convergence-implementation-plan.md)。

## 交付

统一执行预览/确认/提交入口、确定性策略解析、版本化工作流模板、显式模型主管规划、实际任务 DAG、开发评审返工、固定轮次辩论、持久输出预算、冻结截止时间、已确认图修订。动态协议委托现有 Collaboration scheduler，停止假单人 fallback；旧主管两步模板停止准入，未实现协议不公开执行。

规则预览不调用模型。复杂或写任务提交需要确认凭据，角色/账户/目标/工作区配置变化会使预览失效。普通只读常规任务可直接提交；自动选择按能力允许 API、SDK、Codex app-server。新任务采用冻结的执行政策，不依据聊天室旧模式临时改派。

## O4 专项

`pnpm verify:orchestration-o4` 使用临时 SQLite、临时 Git 仓库和角色、mock Provider、真实 stdio MCP 与 SDK/Codex 协议 fixture。网络守卫拒绝真实供应商请求，统计结果为 **0**。

| 检查组 | 已验证行为 |
|---|---|
| 规则与能力 | 零模型/零执行派发；自动 SDK/Codex；硬上限优先选择可执行的 API 成员；目标、策略、含糊任务冲突拒绝 |
| 基础策略 | 并行只读、无隐式汇总；顺序保持成员次序并提供前序结果；必需分支失败不能整体完成 |
| 分析与汇总 | API+SDK 分析后等待全部分支再汇总；可写 SDK 角色被本轮只读政策收窄，写入被拒绝 |
| 开发评审 | API、SDK→Codex 两条链均 FAIL→返工→新固定快照→PASS；注册源仓库保持干净 |
| 主管图 | 一次显式无工具模型规划；API/SDK/Codex 真实三任务图；下游等待前置评审；明确顺序增加依赖；非法图无假降级 |
| 提交确认 | 相同请求返回原 Run 且不改写消息；冲突拒绝；角色改变使预览失效；一个预览可创建独立 Plan 的 Run |
| 辩论 | 无裁判时 2×轮数个发言；可选独立裁判等待全部发言；正文与参数轮次冲突拒绝 |
| 预算与期限 | 并发不重复分配余额；退出纠偏、工具收尾计入 Run 预算；零/缺失用量保守扣除；API/native 超时停止并拒绝迟到结果 |
| 动态调度 | API 接力、SDK→Codex 接力；旧 dynamic 使用同一 scheduler，无 Coordination StepAttempt；首次准入前暂停可以恢复 |
| 公共入口 | 旧未实现协议/假 DAG 不公开执行；专用聊天室 requests API 正常提交及幂等返回 |
| 图修订 | 安全暂停后的确认生成新 revision；旧绑定失权；重复确认不增加版本；恢复执行新图；已开始写任务拒绝重建图重放 |

专项 **11 组通过**。每组包含多条边界断言；真实模型认证、供应商输出质量和真实额度消耗不属于 fixture 结论。

## 回归与检查

| 命令 | 结果 |
|---|---|
| `verify:orchestration-o1` | 12 组通过；旧提交幂等、能力读取、预览脱敏与兼容入口有效 |
| `verify:orchestration-o2` | 14 组通过；固定快照、原生审批、绑定代际/版本/租约、取消和未知结果围栏有效 |
| `verify:orchestration-o3` | 12 组通过；成员 FIFO、独立任务并发、终态 CAS 与多进程恢复有效 |
| `verify:coordination` | 图依赖、产物屏障、返工、辩论、截断、暂停恢复与观察通过 |
| `verify:coordination-planner` | 模型提案、修复、旧兼容回退、明确覆盖、风险确认与审计通过 |
| `verify:external-agents-c` | 原生 MCP 接力/咨询、退出纠偏、用户/定时 Hold、审批/账本与 Stop 通过 |
| `verify:runtime-terminal` | 原子终态、并发 CAS、崩溃及回滚通知通过 |
| `verify:runtime-action-commands` | 公共动作命令、幂等、跨进程竞态及 SIGKILL 通过 |
| `verify:runtime-coordination-adapter` | Step Adapter、Revision、关闭语义与旧协议灰度通过 |
| `pnpm typecheck` / Web production build | 通过；构建仍有已有大包体提示 |
| `verify:docs` / `git diff --check` | 通过 |

O1 的 HTTP 预览断言更新为新执行预览；缺少幂等键的新执行请求仍拒绝。旧无新字段的提交继续保留 O1 比较快照。Coordination 目录断言更新为只公开已有可执行协议，历史定义没有删除。

## 验收方式与边界

本阶段的具体请求示例和确认流程在 [接口指南](../architecture/orchestration-entry-phase-o4.md)。现有图观察与公共任务动作可读取新 Run；完整的每轮策略/工作流选择、详细计划按钮、确认卡和修订交互等待 O5。

硬预算限定生成输出 Token，输入用量及供应商费用另计。SDK/Codex 无法保证该硬上限时明确拒绝；它们可以在不声明硬 Token 上限的任务中参与。详细规划是另一次用户显式模型调用，单独报告用量。原生执行保留服务器与账户的超时约束，任务截止时间进一步收紧窗口。

图修订保留本轮冻结成员、账户、工作区、工作流和预算。只读图允许重新执行并验收；写入图只允许在尚未开始时修订，已开始写入或结果未知时需检查制品并创建新任务。旧调整器不能覆盖 O4 图。

没有调用用户的真实账户，没有重置本地业务数据库。O5–O7 尚未实施，真实 Claude SDK 和 Codex app-server 服务验收留到 O7。
