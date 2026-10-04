# 外部 Code Agent 阶段 C 验收

日期：2026-10-04。Runtime 协作控制与执行绑定 MCP 已交付，专项和本机真实协议检查通过。真实供应商模型的完整协作 smoke 尚未执行。当前契约与本地使用见[阶段 C 架构与使用](../architecture/external-code-agent-phase-c.md)。

## 专项集成验证

`pnpm verify:external-agents-c` 使用临时 SQLite、一次性 Git 仓库、真实 Fastify 路由和当前 Collaboration Scheduler。两个原生推理进程由 fixture 替代，但 fixture 通过真实 MCP Client、stdio transport 和本项目真实 Bridge worker 调用平台，未使用直接构造 AgentTurnResult 的捷径。

已通过：

| 场景 | 断言与证据 |
|---|---|
| Claude SDK / Codex 各自 complete | 控制候选进入现有 Runtime，每次只有一条完成动作命令 |
| SDK → Codex / Codex → SDK handoff | 两种方向均完成，handoff 事务提交瞬间原生父进程及忽略 SIGTERM 的同组子进程均已退出，没有迟到文件写入 |
| 同一回合纠偏 | 接收方首次只返回普通文本，第二片段只使用控制工具；保持同一 execution、scope、Attempt，纠偏次数为 1 |
| 纠偏耗尽 | 持续返回普通文本时在冻结上限后停止，未产生 complete 命令，不能跳过 Completion Engine |
| 混合咨询 | SDK 发起 consult(all/any)，Codex 和内置 mock 成员参与，结果回到 aggregate 派发；咨询命令只提交一次 |
| 用户 Hold | 两个后端均进入持久用户决策；原生执行已收敛，重复回答只创建一次 resume |
| 定时 Hold | Codex 进入 timer Hold，现有恢复流程唤醒并只创建一次 resume |
| 平台业务工具 | SDK 通过 MCP 调用 fs.write，批准前文件不存在，批准后真实文件与 ToolExecution 账本各产生一次 |
| 成员 Stop | Codex 等待中停止成员，API 返回后执行不再 running |
| 伪造身份 | 错误凭据、额外 Subject/代际字段被拒绝；合法领域参数仍可完成 |
| 回调幂等与候选边界 | 相同请求共享结果；相同 ID 替换参数和第二个冲突动作被拒绝；MCP 接收候选时 Runtime 动作账本仍为空 |
| 责任代际失效 | custody generation 改变后，旧凭据立即返回 403 |
| 原生恢复防重放 | 已存在 native execution 的过期 Attempt，即使 ToolExecution 账本为空，也置失败而非重新排队 |

测试使用单个执行桥的真实 HTTP 回调补充身份/重试竞态，并在真实 Runtime Subject/Attempt/custody 上验证，不把伪造模型参数当作服务端身份。

## 本机真实协议检查

`pnpm verify:claude-sdk-mcp-protocol` 启动安装的 Claude SDK 0.3.288 与真实 SDK worker，将模型 API 指向本地 Messages fixture。fixture 返回一个 MCP tool_use；透明子进程协议观测断言真实 `PreToolUse` 请求到达平台权限门控，随后真实 MCP worker 完成回调、平台受控中断原生执行。使用临时 Claude 配置目录和无效占位 key；真实供应商模型推理次数为 0。

`pnpm verify:codex-mcp-protocol` 启动真实 Codex CLI 0.159.2，在临时、未登录 CODEX_HOME 中传入单个 `agent_gand` MCP 配置。通过实际 `mcpServerStatus/list` 验证 server、工具 schema、`env_vars` 凭据转发与 `toolsError: null`。没有发送模型 turn，真实供应商模型推理次数为 0。

这两个检查分别覆盖真实 SDK 的工具前 hook/调用与真实 Codex 的 MCP 配置/发现。Codex 的模型选择工具、原生审批和完整 handoff/hold 仍由模拟 app-server 集成测试覆盖，不能据此声明真实模型端到端通过。

## 回归与构建

以下检查通过：

- `pnpm verify:external-agents`、`pnpm verify:external-agents-b`、`pnpm verify:external-agents-c`
- `pnpm verify:claude-sdk-mcp-protocol`、`pnpm verify:codex-mcp-protocol`
- `pnpm verify:collaboration`
- `pnpm verify:runtime-agent-api-v2`、`pnpm verify:runtime-control-actions`、`pnpm verify:runtime-exit-guard`、`pnpm verify:runtime-action-commands`
- `pnpm verify:runtime-consult-any`、`pnpm verify:runtime-durable-holds`、`pnpm verify:runtime-hold-recovery-v2`、`pnpm verify:runtime-crash`
- `pnpm typecheck`、`pnpm --filter @agent-gand/web build`、`pnpm verify:docs`、`git diff --check`

前端构建保留已有的大 chunk 提示，不阻止构建。测试均使用临时数据库，未重置开发数据库或调用真实供应商推理。

## 实际限制与人工验收

控制候选先中断和清理原生执行，再进入现有 Runtime 事务。macOS/Linux 进程组只覆盖同组子进程；主动脱离的 daemon、宿主 SIGKILL 后旧进程所有权和跨进程工作区租约仍属阶段 D。

纠偏使用新原生片段而非热 resume。SDK 可精确关闭内置工具；Codex 使用禁用 shell 等能力、readonly/never 和事件拒绝，未证明所有原生工具在目录中完全移除。平台字节限制与 SDK 上游输出设置也不能宣称是精确供应商 token 账单上限。控制中断后的未知 usage/cost 保留未知。

人工验收需配置真实 SDK key 和独立 Codex 登录目录，在可检查的 Git 仓库中新建自由协作，验证两个后端各一次 complete、互相 handoff、混合 consult、用户 Hold 回答、原生工具审批及 Stop，并检查运行页的控制候选、实际 diff、工具输出和责任变化。本阶段没有自动消费真实推理额度。
