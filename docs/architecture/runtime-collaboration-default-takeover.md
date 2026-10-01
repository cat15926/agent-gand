# Collaboration Runtime 默认接管与回退

## 结论

从阶段 5 开始，新建 Collaboration Run 在没有显式配置时默认以 `execute` Profile 入场。Runtime 拥有 Subject 完成验收和 Run 终局提交权；`legacy`、`shadow`、`atomic_compat` 继续作为存量排空、差异观测和应急回退的兼容 Profile。

默认值只参与新 Run admission。每个 Run 创建初始 Dispatch 前都会把 `RuntimeExecutionPolicyV1` 和组件版本冻结进 Runtime Contract；后续 worker、恢复扫描和重启都只读取冻结 Contract。

## 入场与回退

| 配置 | 新 Run | 已冻结 Run |
| --- | --- | --- |
| 未设置 `COLLAB_RUNTIME_MODE` | `execute` | 不变 |
| `COLLAB_RUNTIME_MODE=execute` | `execute` | 不变 |
| `COLLAB_RUNTIME_MODE=shadow` | `shadow` | 不变 |
| `COLLAB_RUNTIME_MODE=atomic_compat` | `atomic_compat` | 不变 |
| `COLLAB_RUNTIME_MODE=legacy` | `legacy` | 不变 |

应急回退使用 `COLLAB_RUNTIME_MODE=legacy`，其含义是停止新的 execute 入场，不是把运行中的 execute Run 降级。已经冻结为 execute 的 Run 必须继续由支持其 Policy 和组件版本的 worker 排空；若兼容 worker 不可用，应明确阻断并告警，不能走 legacy finalization。

旧的 `COLLAB_COMPLETION_ENGINE`、`COLLAB_RUNTIME_ATOMIC` 和 `COLLAB_RUNTIME_SHADOW` 只保留 admission 兼容映射。设置统一模式后，`COLLAB_RUNTIME_MODE` 始终优先。

## Shadow 对比契约

Shadow 仍由 legacy 路径拥有业务执行权，但每个正常完成的 Attempt 会写入一条 `runtime_shadow_comparisons` 审计记录：

- 输入是同一份已生成 Agent 输出，不再次调用模型；
- 判定前冻结 Responsibility Snapshot，并保存快照指纹；
- 不创建第二次工具执行、消息或 Dispatch；
- 每个 Attempt 使用唯一账本记录，重放保持幂等；
- 审计失败只记为 `observer_error` 并告警，不改变已提交的 legacy 结果。

分类口径：

| 分类 | 含义 |
| --- | --- |
| `match` | legacy 接受输出，Runtime 完成判定也接受 |
| `runtime_stricter` | legacy 已接受，但 Runtime 因阻断事实拒绝或判定候选过期 |
| `runtime_looser` | legacy 阻断，但 Runtime 判定接受 |
| `projection_only` | handoff、consult、hold 等非终局动作只比较责任投影 |
| `observer_error` | Shadow 观察或判定失败，需要排障 |

REST 运行详情、WebSocket 事件和右侧协作面板均暴露该记录。发布门槛要求所有差异都有分类与原因，且不得出现无法解释的 `observer_error`。

## 验收

```bash
pnpm verify:runtime-default-takeover
COLLAB_RUNTIME_MODE=shadow pnpm verify:collaboration
pnpm verify:collaboration
COLLAB_RUNTIME_MODE=legacy pnpm verify:collaboration
COLLAB_RUNTIME_MODE=atomic_compat pnpm verify:collaboration
pnpm verify:runtime-action-commands
pnpm verify:runtime-crash
pnpm verify:runtime-hold-recovery-v2
pnpm verify:coordination
```

专项测试覆盖默认 execute、显式回退、跨进程混合 Profile 读取、Shadow 分类和幂等、无第二次外部副作用，以及 handoff、consult(all)、hold/wake、Stop、审批恢复和 review_revision 回归。
