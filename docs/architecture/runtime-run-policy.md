# Runtime Run Policy

## 目的

Run Policy 冻结每个 Run 的执行权和 Runtime 能力，解决进程重启或环境变量变化后，同一个 Run 进入不同执行分支的问题。环境变量只参与新 Run admission；scheduler、store、decisions、recovery 和 adapters 在执行阶段只读取 `RuntimeRunContract.executionPolicy`。

实现入口：`apps/server/src/runtime/runPolicy.ts`。

## 策略模型

入场 Profile 是部署配置，冻结语义由三个正交字段组成：

| Profile | authority | runtimeStateMode | atomicity |
| --- | --- | --- | --- |
| `legacy` | `legacy` | `off` | `legacy` |
| `shadow` | `legacy` | `shadow` | `legacy` |
| `atomic_compat` | `legacy` | `authoritative` | `custody_v1` |
| `execute` | `runtime` | `authoritative` | `commands_v1` |

- `authority` 决定谁拥有 Run 完成权。
- `runtimeStateMode` 决定 Runtime 状态关闭、影子记录还是权威提交。
- `atomicity` 冻结当前 Run 使用的提交能力版本。
- `toolApiVersion` 和 `implicitAnswerPolicy` 同样按 Run 冻结。

`toolApiVersion=2` 只向模型暴露 `agent.complete/handoff/consult/hold` 领域工具；旧名称只保留历史动作解释，不再暴露给模型，详见 [Runtime Agent API v2](./runtime-agent-api-v2.md)。

可选领域能力继续按 Contract 独立冻结：`externalWaitVersion=1` 扩展 Hold，`consultAnyVersion=1` 扩展 consult join，`progressDigestVersion=1` 使用规范化实质进展驱动 loop guard。缺少字段的历史 Run 仍按原 schema 只读解释，不能按当前二进制默认值补开或继续执行退役 Profile。

阶段 10 清理后，Collaboration 新 Run 只允许 `execute`。`COLLAB_RUNTIME_MODE` 未设置或为 `execute` 时均以 `execute` 入场；`legacy|shadow|atomic_compat`、`COLLAB_RUNTIME_ATOMIC=true` 和 `COLLAB_RUNTIME_SHADOW=true` 在启动时被拒绝。`COLLAB_COMPLETION_ENGINE` 不再控制入场。退役 Profile 的 Contract 仍可只读解释，但 worker 不再接球执行。

Coordination 继续使用 `COORDINATION_RUNTIME_KERNEL` 和协议 allowlist 选择首次入场模式；之后的 Plan Revision 继承原 Run Policy，不重新读取环境变量决定执行权。

## Contract 读取和历史兼容

所有组件版本读取统一经过 `loadRuntimeContract()`：

- 无 Contract 的历史 Run 固定为 `legacy`；
- 显式 `executionPolicy` 必须通过版本和字段组合校验；
- 旧 Coordination Contract 可由 `coordinationKernel` 可靠推断；
- 旧 `completionEngine=true` Contract 可可靠推断为 `execute`；
- 只有 Runtime 组件版本、无法区分 shadow/atomic 的旧 Contract 返回 `RUNTIME_POLICY_AMBIGUOUS_HISTORY`；
- 损坏 JSON、Run ID 错绑和未知版本明确失败，不静默降级。

无法可靠识别或使用退役 Profile 的活跃 Run 不会被 worker claim。对应 Dispatch 转为 `blocked` 并保存 reason code；不能使用重启后的环境变量猜测或升级。

## 执行约束

- Admission 在创建初始 Dispatch 前冻结 Policy。
- 权威模式的 Custody/Candidate 与 Dispatch/Attempt 在同一事务中写入。
- 历史 Shadow Comparison 保持只读；新 Collaboration 执行不再运行 Shadow observer。
- Completion Engine 必须同时满足 `authority=runtime` 和 Contract `completionEngine=true`。
- Durable Hold 恢复只 claim `runtimeStateMode=authoritative` 的 Run。
- Coordination Revision 可改变图和 required steps，不得改变 Run Policy。

## 验收

专项命令：

```bash
pnpm verify:runtime-run-policy
pnpm verify:runtime-default-takeover
pnpm verify:runtime-atomic
pnpm verify:runtime-crash
pnpm verify:runtime-coordination-adapter
pnpm typecheck
```

Collaboration 端到端继续覆盖旧配置映射的 legacy、shadow、atomic compatibility 和 execute 四种组合。专项脚本还静态检查执行模块不得读取旧三开关。

旧 Profile 已弃用但尚未物理删除。删除前必须运行 `pnpm runtime:compatibility-inventory` 并得到 `readyForCompatibilityRemoval=true`；门禁规则见 [Runtime ProgressDigest 与兼容清理门禁](./runtime-progress-digest-compatibility-retirement.md)。
