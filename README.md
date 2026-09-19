# agent-gand · 多 Agent 协作工具平台

基于《[多 Agent 协作工具平台需求调研](./docs/requirements/multi-agent-platform-requirements-research.md)》§7.2 的 **P0 需求清单**搭建的脚手架（v0.1）。
架构规格见 [P0 权威架构规格](./docs/architecture/scaffold-plan.md)，完整文档索引与归属规则见 [docs/README.md](./docs/README.md)。

## 快速开始

```bash
pnpm install        # Node >= 22 / pnpm 9
pnpm dev            # 并行启动 server(3010) + web(5173)
```

打开 http://localhost:5173 ：

1. 首次启动自动 seed（3 个 agent、1 条演示 run、1 条待审批）；
2. 在“运行”视图创建聊天室；新聊天室默认使用自由协作，可选择最多 3 位初始 Agent，也可切换主管委派或顺序流水线；
3. 右侧面板处理**审批卡**（批准 / 拒绝 / 编辑后继续）；
4. 在“舰队 → 角色管理”从模板创建、复制、编辑或停用 Agent；点击头像可选择或拖入本地图片，也可使用预设 Emoji、短文字或 HTTPS 图片 URL；保存后无需重启即可用于新聊天室；
5. “舰队 → 执行状态”查看各 Agent 状态（待输入置顶），“观测”查看运行历史与事件时间线。

其他命令：`pnpm typecheck`（全仓类型检查）、`pnpm verify:p0-tools`（验证 MCP 发现、审批、Trace、重连和模型计价）、`pnpm verify:agents`（验证角色 CRUD、版本与运行快照）、`pnpm verify:scheduler`（验证 Reviewer FAIL → Coder 返工 → Reviewer PASS）、`pnpm verify:collaboration`（验证动态交接、并行路由、等待用户、预算扩容和正式任务提议）、`pnpm db:reset`（清空 SQLite 重 seed）。

自建角色保存在 SQLite，文件角色继续由 `agents/*.agent.md` 提供且在界面中只读，可复制为自建角色。角色通过“执行 / 审查 / 协调”能力参与调度，主管和默认评审者不再依赖固定 ID。每个 Run 创建时会保存成员配置快照，因此之后编辑或停用角色不会改变已经排队、执行中或历史 Run 的行为。

主管委派模式会把任务、每轮执行和结构化审查结果落库。Reviewer 返回 FAIL 时，调度器会把 issues 发送给原执行者并自动返工，默认最多执行 3 次；无依赖任务最多并行 2 个。可通过 `TASK_MAX_ATTEMPTS`、`ORCHESTRATOR_CONCURRENCY` 和 `TASK_LEASE_MS` 调整。

自由协作模式使用结构化控制工具让 Agent 动态交接、并行征询队友、等待用户或提议创建正式 Supervisor Run。不同 Agent 可以并行，同一 Agent 在同一聊天室保持串行。达到 Token、成本、时长或 Dispatch 预算时会进入 `waiting_for_user`，用户可接受部分结果或按比例增加预算。

聊天室包含多轮 Run，并绑定稳定工作区。Collaboration 中的新消息可启动并行 Run；无显式目标时优先交给最近成功回复的 Agent。消息使用客户端 ID 幂等写入，主消息流展示引用关系、动态路由、用户决策、审查问题和处理状态，完整 Trace 在右侧查看。实现计划见 [Collaboration 模式实施计划](./docs/plans/collaboration-mode-implementation-plan.md)。

### 接入真实 LLM（可选）

默认 `mock:*` 模型走 MockProvider，无 key 即可演示。要接真实模型：把 agent 定义（`agents/*.agent.md`）的
`model` 改为 `openai:<model>` 或 `anthropic:<model>`，并在 `apps/server/` 下复制 `.env.example` 为 `.env` 配置：

```bash
# OpenAI 兼容端点（以 DeepSeek 为例）
LLM_OPENAI_API_KEY=sk-xxx
LLM_OPENAI_BASE_URL=https://api.deepseek.com/v1

# 或 Anthropic
LLM_ANTHROPIC_API_KEY=sk-ant-xxx

# 可选：出站代理
LLM_PROXY=http://127.0.0.1:7897
```

未配置 key 时启动与 `mock:*` 路径不受影响；`openai:*` / `anthropic:*` 的 run 会在 LLM 调用时明确报缺哪个 key。
无 key 的本地验证：`node scripts/verify-llm-stubs.mjs`（起一个本地 stub 端点，全链路验证两个 Provider 的
请求格式、tool_calls/tool_use 解析、usage 记账与 supervisor 结构化拆解/fallback）。

真实模型成本由 `LLM_PRICING_JSON` 配置，单位为美元/百万 token。完整模型路由优先，`provider:*` 可作为同一 Provider 的兜底；未配置价格的模型成本记为 0，避免把未知价格当成真实账单。示例见 `apps/server/.env.example`。

### 接入 MCP 工具（可选）

在 `apps/server/.env` 配置一个 stdio MCP Server：

```bash
MCP_SERVER_CMD=npx
MCP_SERVER_ARGS=-y @modelcontextprotocol/server-filesystem /tmp
MCP_HEARTBEAT_MS=30000
```

服务启动时发现 MCP 工具，并以 `mcp.<远端工具名>` 注册到统一工具目录。它们会出现在“舰队 → 角色管理”的工具列表中，执行时复用内置工具的权限门控、人工审批和 Trace。角色管理页会显示连接状态、工具数量、最近心跳和失败原因，也可手动刷新。对应接口为 `GET /api/tools/mcp/status` 与 `POST /api/tools/mcp/refresh`。

连接关闭或心跳失败后，下一次调用或手动刷新会创建新连接。系统不会自动重放已经失败的 MCP 调用，避免重复外部副作用。

## 架构

```
packages/shared   领域类型契约（Conversation / Agent / Message / Task / Run / Approval / WS 事件协议）
apps/server       Fastify + better-sqlite3：聊天室、编排引擎、收件箱+共享任务列表、统一工具注册+MCP 生命周期、HITL 审批、trace/用量、REST+WS
apps/web          React 19 + Vite + Tailwind 4：聊天室消息流、会话列表、运行详情与审批面板
agents/           agent 定义（Markdown + YAML frontmatter，正文=system prompt，入库共享）
```

### P0 → 模块映射

| P0 需求（报告 §7.2） | 模块 |
|---|---|
| 1 Agent 定义（人设/模型/工具白名单/权限三档） | `agents/*.agent.md`、`apps/server/src/agents/` |
| 2 编排引擎（pipeline + supervisor + collaboration）、任务三态+依赖落盘 | `orchestration/`、`collaboration/`、SQLite tasks/dispatches 表 |
| 3 agent 通信（收件箱 + 共享任务列表 + 认领锁） | `messaging/`、`POST /api/tasks/:id/claim`（IMMEDIATE 事务） |
| 4 工具（内置 fs/http/shell/search + MCP Client） | `tools/` |
| 5 HITL（中断审批 + 权限三档） | `hitl/`、`tools/types.ts` 权限门控 |
| 6 运行可视化（消息流/任务状态/用量） | WS 事件、web RunView / RightPanel / TopBar |
| 7 会话与运行历史 | `runs/trace.ts`、run_events/messages 表、ObserveView |

### UI 布局（报告 §7.3 "1+3"）

顶栏（状态/用量/连接）+ 左侧导航（**运行** · 编排(P1) · **舰队** · **观测**）+ 主视图 + 右侧面板（**审批卡 / Trace / 用量**）。
对应调研报告 §5.1 六模式中的：模式 2（聊天+工作区）、模式 4（Trace 观测）、模式 5（审批卡）、模式 6（舰队看板）；画布（模式 1）为 P1。

## 约定

- **契约优先**：跨端类型一律改 `packages/shared`，不得在 server/web 私有定义；
- **模型路由**：`mock:*` 走 MockProvider（无 key 演示），`openai:*` 走 OpenAI 兼容端点、`anthropic:*` 走 Anthropic（`llm/router.ts`，纯 fetch 实现，支持 `LLM_PROXY` 代理）；
- **后续演进点**：以 `// TODO:` 标注（durable pause/resume、Docker ToolRunner、触发器等）；
- 数据库为本地 SQLite（`apps/server/data/`，已 gitignore），**只增不删**；
- **沙箱工作区（§9/§10）**：无前缀路径 = 当前工作区（默认每次 run 独立 `sandbox/runs/<runId>/`，或 `POST /api/runs` 指定命名工作区 `sandbox/workspaces/<name>/` 跨 run 复用）；`shared/` = 团队共享区（写入强制人工审批）；`archive/` = 根级历史归档只读。并发写同一命名工作区在 MVP 下接受（单用户场景），不设锁。

## 路线图

- **P1**：按 [P1 实施路线](./docs/plans/p1-implementation-roadmap.md) 的 8 个计划推进；计划 1–4 已完成，下一项为 Docker ToolRunner
- **完整编排**：可编辑画布、版本化 DSL、Durable Runtime、发布与触发见 [完整编排功能实施方案](./docs/plans/full-orchestration-implementation-plan.md)
- **通用协作规划**：根据输入选择协议并编译 Coordination Plan 的设计见 [通用协作规划器方案](./docs/plans/coordination-planner-design.md)
- **Coordination 实测问题**：阶段 C 后两场辩论实测暴露的产物冻结失效、max_tokens 截断与跨 run 工作区污染等 7 项问题见 [实测问题报告](./docs/reports/coordination-debate-test-problem-report.md)
- **Collaboration 实测问题**：三轮辩论的调度、上下文、终局、预算和聊天体验分析见 [实测问题报告](./docs/reports/collaboration-debate-test-problem-report.md)
- **P2**：RBAC/多租户、评测体系、回放分享、time-travel 调试（详见调研报告 §7.2）

## 团队协作

本项目由 squad 多 agent 团队协作搭建：manager（架构/规格/前端）、worker（server 实现）、inspector（验收）。
