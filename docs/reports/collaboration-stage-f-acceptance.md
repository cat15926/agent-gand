# Collaboration 阶段 F 验收报告

日期：2026-09-21

结论：阶段 F 的自动化回归、文档收尾通过；未执行真实浏览器人工视觉走查。

## 验收范围与结果

| 范围 | 验证 | 结果 |
|---|---|---|
| 领域、API 与 Stub E2E | `pnpm verify:collaboration` | 通过；覆盖动态路由、并行 Batch、Decision、预算、Trace、blocked、Run Stop、fanout 持久发言与唯一最终报告 |
| 数据库事务与恢复 | `pnpm verify:collaboration-reliability` | 通过；覆盖回滚后不广播、规范化去重、Agent Slot 竞态、安全重试、写工具副作用阻断 |
| 前端视图模型 | `pnpm verify:collaboration-ui`、`pnpm verify:chat-scroll` | 通过；覆盖 Batch/Attempt/Run Stop 状态和切换房间后定位最新消息 |
| 既有模式与工具 | `pnpm verify:p0-tools`、`pnpm verify:agents`、`pnpm verify:scheduler` | 全部通过；MCP/审批/Trace、Agent 管理和 Supervisor 返工链路未出现回归 |
| Provider Stub | `node scripts/verify-llm-stubs.mjs` | 135/135 通过；包含无密钥 Pipeline 与 Supervisor 完成路径 |
| 扩展集成 | `pnpm verify:observability`、`pnpm verify:durable`、`pnpm verify:coordination`、`pnpm verify:coordination-planner`、`pnpm verify:coordination-stage-e` | 全部通过；覆盖恢复、协调协议和规划器 |
| 静态与构建 | `pnpm typecheck`、`pnpm --filter @agent-gand/web build`、`pnpm verify:docs` | 全部通过；构建仅有既有的大包体积提示 |
| 规划器离线评估 | `pnpm evaluate:coordination-planner` | 6 个 mock 样本：selection/decision/hard-constraint/executable/observed-completion 均为 1；这是离线样本结果，不代表真实模型线上准确率 |

## 产品语义核对

Web 新聊天室默认选中“智能匹配”；自由协作、主管委派和顺序流水线仍有显式选项。服务端 API 省略 `mode` 时兼容回退自由协作。fanout 输出既保留在 Attempt 供聚合，又作为非终局 `collaboration_contribution` 消息持久显示；聚合后的最终结果由发起者发布，避免重复最终报告。当前契约见[Collaboration 运行架构](../architecture/collaboration-runtime.md)。

## 验收边界

本轮没有真实浏览器人工视觉走查，也没有将自动化视图模型测试等同于跨浏览器交互测试。Web 构建和现有脚本验证了编译、状态计算及旧模式后端链路；部署后的真实模型输出质量与第三轮并行征询超时问题仍需独立观察。历史 Run 不补写此前缺失的发言。
