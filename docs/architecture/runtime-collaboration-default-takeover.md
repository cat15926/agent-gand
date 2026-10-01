# Collaboration Runtime 默认接管与历史兼容

## 当前行为

新建 Collaboration Run 只允许 `execute` Profile。Runtime 拥有 Subject 完成验收和 Run 终局提交权。未设置 `COLLAB_RUNTIME_MODE` 与显式设置 `execute` 等价；配置 `legacy`、`shadow` 或 `atomic_compat` 会在服务启动时被拒绝。`COLLAB_RUNTIME_ATOMIC=true` 和 `COLLAB_RUNTIME_SHADOW=true` 同样被拒绝；`COLLAB_COMPLETION_ENGINE` 不再决定入场语义。

每个 Run 在初始 Dispatch 前冻结 `RuntimeExecutionPolicyV1` 与组件版本。worker 只接球 `execute` Run，用户决策只恢复 `execute` Run；退役 Profile 的 Contract、动作和审计记录仍可只读解释。历史数据不被自动改写或升级。

## 清理门禁与回退

阶段 10 清理前，`pnpm runtime:compatibility-inventory` 已确认本地数据库没有非终态的旧 Profile 或旧 alias checkpoint。唯一停在 `waiting_for_user` 的 2026-09-16 历史 Run，经用户明确授权使用现有 Stop 语义终止，保留了消息与 Trace。随后删除旧 alias 的模型暴露、legacy finalization 和 `atomic_compat` 执行分支；终态历史读取和版本解释保留。详见 [Runtime ProgressDigest 与兼容清理门禁](./runtime-progress-digest-compatibility-retirement.md)。

若需要回退新版本，必须部署仍支持冻结 `execute` Contract 的兼容 worker，或暂停新入场并处理活跃 Run。不能仅把环境变量改成 `legacy`，更不能将活跃 `execute` Run 降级为旧执行权。

历史 `runtime_shadow_comparisons` 仍可通过运行详情、WebSocket 和右侧协作面板读取；新 Run 不再产生 Shadow Comparison。

## 验收

```bash
pnpm runtime:compatibility-inventory
pnpm verify:runtime-default-takeover
pnpm verify:runtime-run-policy
pnpm verify:runtime-agent-api-v2
pnpm verify:runtime-compatibility-retirement
pnpm verify:collaboration
pnpm verify:coordination
```
