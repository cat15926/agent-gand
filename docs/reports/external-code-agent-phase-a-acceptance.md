# 外部 Code Agent 阶段 A 验收

日期：2026-10-03。阶段 A 的实现及离线协议验收完成；尚未运行真实模型 smoke，不声明已验证两个供应商的真实认证、推理和原生工具行为。

## 已验证

`pnpm verify:external-agents` 通过假 Claude/Codex 可执行文件和实际 Fastify 路由、流水线、SQLite、事件总线验证：

- 两个 Driver 读取临时仓库 README，产生一条持久分析消息、会话绑定、工具轨迹及用量；目标仓库文件保持不变。
- 分段 JSON、UTF-8 字符内断开、Claude partial + assistant + result 去重，以及 Codex 非单调 item 快照替换。
- 缺失 usage/cost 保留未知值；平台汇总带未知标记，界面不显示成已确认的零成本。
- missing_binary、unsupported_cli、auth_required、invalid_json、protocol_error、nonzero_exit、policy_rejected、timeout、cancelled、interrupted 状态。
- 成功事件后再非零退出仍失败；缺少终态或正文不能当成功；认证诊断脱敏，错误 result 不进入流式分析正文。
- 四个并发房间会话独立；重复 scope 只启动一次；重启留下的未完成 scope 不自动重放。
- API/YAML 拒绝写权限、平台工具、自定义 CLI 参数；拒绝外部 Agent 的自由协作和 Coordination 准入。
- MCP 名单非法或逐个禁用后仍启用时，在推理进程启动前拒绝。
- 停止和超时清理 CLI 及忽略 SIGTERM 的子进程；停止后不发布迟到输出、不启动后续流水线成员。

本机离线检查确认 Claude Code `2.1.220` 和 Codex CLI `0.159.2` 支持必需的选项；实际 Codex MCP 名单检查和逐个禁用复查通过，未调用模型。

回归验证通过：`pnpm typecheck`、`pnpm verify:agents`、`pnpm verify:scheduler`、`pnpm verify:followup-stage3`、`pnpm verify:durable`、`pnpm verify:runtime-exit-guard`、`pnpm verify:collaboration-ui`、`pnpm verify:coordination-planner`、`pnpm verify:observability`、`pnpm verify:docs`、前端生产构建。需要监听本机端口的已有测试在获准的执行环境中运行；专项测试使用 `app.inject()`，不需要端口。

## 验证边界

假 CLI 验证进程/协议/平台集成及配置参数，不验证供应商实现的实际权限效果、账户可用性或模型质量。真实 smoke 应在单独明确授权后，对一次性仓库分别运行 Claude/Codex 只读分析并检查文件 diff、原生工具/usage、终态及停止。

Claude 读工具白名单不提供 OS 读取范围隔离；阶段 A 也不支持多租户隔离、Windows、热恢复和写入。详细契约见 [阶段 A 架构与使用](../architecture/external-code-agent-phase-a.md)。
