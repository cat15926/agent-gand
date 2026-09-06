# agent-gand · 多 Agent 协作工具平台

基于《[多Agent协作平台需求调研报告](./多Agent协作平台需求调研报告.md)》§7.2 的 **P0 需求清单**搭建的脚手架（v0.1）。
架构规格见 [docs/scaffold-plan.md](./docs/scaffold-plan.md)（唯一权威规格）。

## 快速开始

```bash
pnpm install        # Node >= 22 / pnpm 9
pnpm dev            # 并行启动 server(3010) + web(5173)
```

打开 http://localhost:5173 ：

1. 首次启动自动 seed（3 个 agent、1 条演示 run、1 条待审批）；
2. 在"运行"视图输入目标 → 选模式（顺序流水线 / 主管委派）→ 勾选 agent → 启动；
3. 右侧面板处理**审批卡**（批准 / 拒绝 / 编辑后继续）；
4. "舰队"视图看各 agent 状态（待输入置顶），"观测"视图看运行历史与事件时间线。

其他命令：`pnpm typecheck`（全仓类型检查）、`pnpm db:reset`（清空 SQLite 重 seed）。

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

## 架构

```
packages/shared   领域类型契约（Agent / Message / Task / Run / Approval / WS 事件协议）
apps/server       Fastify + better-sqlite3：编排引擎、收件箱+共享任务列表、工具+权限门控+MCP 骨架、HITL 审批、trace/用量、REST+WS
apps/web          React 19 + Vite + Tailwind 4："1+3"布局壳（顶栏/左侧导航/运行视图/右侧面板）
agents/           agent 定义（Markdown + YAML frontmatter，正文=system prompt，入库共享）
```

### P0 → 模块映射

| P0 需求（报告 §7.2） | 模块 |
|---|---|
| 1 Agent 定义（人设/模型/工具白名单/权限三档） | `agents/*.agent.md`、`apps/server/src/agents/` |
| 2 编排引擎（pipeline + supervisor）、任务三态+依赖落盘 | `orchestration/`、SQLite tasks 表 |
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
- **骨架点**：全部以 `// TODO:` 标注（durable pause/resume、MCP 完整接入、只读画布、瀑布 trace 等）；
- 数据库为本地 SQLite（`apps/server/data/`，已 gitignore），**只增不删**；
- **沙箱工作区（§9/§10）**：无前缀路径 = 当前工作区（默认每次 run 独立 `sandbox/runs/<runId>/`，或 `POST /api/runs` 指定命名工作区 `sandbox/workspaces/<name>/` 跨 run 复用）；`shared/` = 团队共享区（写入强制人工审批）；`archive/` = 根级历史归档只读。并发写同一命名工作区在 MVP 下接受（单用户场景），不设锁。

## 路线图

- **P1**：只读编排画布（React Flow + elkjs）、trace 瀑布图、长期记忆/RAG、定时与事件触发、Docker 沙箱、durable pause/resume
- **P2**：可编辑画布、多渠道发布、RBAC/多租户、评测体系、回放分享、time-travel 调试（详见调研报告 §7.2）

## 团队协作

本项目由 squad 多 agent 团队协作搭建：manager（架构/规格/前端）、worker（server 实现）、inspector（验收）。
