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

Collaboration 使用 `COLLAB_RUNTIME_MODE=legacy|shadow|atomic_compat|execute` 选择新 Run Profile；阶段 5 起默认是 `execute`。旧变量按以下优先级映射，仅用于 admission 兼容：

1. `COLLAB_COMPLETION_ENGINE=true` → `execute`
2. `COLLAB_RUNTIME_ATOMIC=true` → `atomic_compat`
3. `COLLAB_RUNTIME_SHADOW=true` → `shadow`
4. 未设置 → `execute`

显式 `COLLAB_RUNTIME_MODE` 优先于旧变量。

Coordination 继续使用 `COORDINATION_RUNTIME_KERNEL` 和协议 allowlist 选择首次入场模式；之后的 Plan Revision 继承原 Run Policy，不重新读取环境变量决定执行权。

## Contract 读取和历史兼容

所有组件版本读取统一经过 `loadRuntimeContract()`：

- 无 Contract 的历史 Run 固定为 `legacy`；
- 显式 `executionPolicy` 必须通过版本和字段组合校验；
- 旧 Coordination Contract 可由 `coordinationKernel` 可靠推断；
- 旧 `completionEngine=true` Contract 可可靠推断为 `execute`；
- 只有 Runtime 组件版本、无法区分 shadow/atomic 的旧 Contract 返回 `RUNTIME_POLICY_AMBIGUOUS_HISTORY`；
- 损坏 JSON、Run ID 错绑和未知版本明确失败，不静默降级。

无法可靠识别的活跃 Run 不会被 worker claim。对应 Dispatch 转为 `blocked` 并保存 reason code，等待兼容版本排空或人工绑定；不能使用重启后的环境变量猜测。

## 执行约束

- Admission 在创建初始 Dispatch 前冻结 Policy。
- 权威模式的 Custody/Candidate 与 Dispatch/Attempt 在同一事务中写入。
- Shadow 在 legacy 事务提交后观察，不拥有 Run 终局权；它对同一份已生成输出和判定前 Responsibility Snapshot 运行 Runtime 判定，并把分类、原因和指纹写入独立审计账本，不重跑模型、工具或 Dispatch。
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
