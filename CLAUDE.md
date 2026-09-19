# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

agent-gand：多 Agent 协作工具平台（pnpm workspace monorepo）。后端编排引擎（Fastify 5 + better-sqlite3）+ 前端 "1+3" 观测界面（React 19 + Vite 6 + Tailwind 4）。权威架构规格在 `docs/architecture/scaffold-plan.md`，文档索引与归属规则在 `docs/README.md`。

## 常用命令

```bash
pnpm install        # Node >= 22 / pnpm 9
pnpm dev            # 并行启动 server(3010) + web(5173)
pnpm dev:server     # 只起后端（tsx watch）
pnpm dev:web        # 只起前端（Vite，/api 与 /ws 代理到 3010）
pnpm typecheck      # 全仓 tsc --noEmit（唯一的静态检查，无 eslint）
pnpm db:reset       # 删除 SQLite，下次启动重新 seed
```

真实 LLM / MCP 工具为可选配置：复制 `apps/server/.env.example` 为 `apps/server/.env`。不配置 key 时 `mock:*` 模型全功能可用。

### 验证脚本（本项目的"测试"）

没有单元测试框架。每个 `scripts/verify-*.mjs` 是独立的端到端验收测试：自建临时目录、临时 SQLite 和 agent 定义，在随机端口 spawn 真实 server，断言后清理——不触碰开发数据库，无需先手动起服务。改动后的最小验证是 `pnpm typecheck` + 相关 verify 脚本：

- `pnpm verify:scheduler` — Reviewer FAIL → 返工 → PASS 调度闭环
- `pnpm verify:agents` — 角色 CRUD、版本与运行快照
- `pnpm verify:p0-tools` — MCP 发现、审批、Trace、重连和模型计价
- `pnpm verify:collaboration` — 动态交接、并行征询、等待用户、预算扩容
- `pnpm verify:observability` / `pnpm verify:durable` / `pnpm verify:coordination`
- `node scripts/verify-llm-stubs.mjs` — 无 key 全链路验证两个 LLM Provider（自带 stub 端点）
- `pnpm verify:docs` — Markdown 相对链接检查（移动文档或改链接后必跑）

## 架构

### 布局

- `packages/shared` — 跨端类型契约（Conversation / Agent / Message / Task / Run / Approval / WS 事件协议）
- `apps/server` — 编排引擎 + 持久化 + REST/WS API
- `apps/web` — SPA：`store.tsx` 单文件全局状态（useReducer + WS 事件写入），"1+3" 布局（TopBar + SideNav + 主视图 + RightPanel 审批/Trace/用量）
- `agents/` — agent 定义：Markdown + YAML frontmatter，正文即 system prompt；文件角色界面只读，可复制为 SQLite 自建角色

### 契约优先（最重要的约定）

跨端类型一律改 `packages/shared`，不得在 server/web 私有定义。架构规格变更需同步 `docs/architecture/scaffold-plan.md`。

### Server 内部（apps/server/src/）

入口 `index.ts`：config → db → registry 同步 → seed → **启动恢复序列** → listen。恢复语义关键：新进程接管会把运行中 attempt 标记 interrupted、重排遗留任务、恢复 supervisor / collaboration / durable / coordination 各类 run——改动启动逻辑时必须保持这些语义。

四种协作/编排路径：

1. `orchestration/pipeline.ts` — 顺序流水线
2. `orchestration/supervisor.ts` — 主管委派：拆任务落库，`reviewStep` FAIL 时把 issues 发回原执行者自动返工（`TASK_MAX_ATTEMPTS` 默认 3，`ORCHESTRATOR_CONCURRENCY` 控制无依赖任务并行）
3. `collaboration/` — 自由协作：结构化控制工具（`controlTools.ts`）实现动态交接、并行征询、等待用户、提议 Supervisor run；dispatch 队列 + attempt 租约；Token/成本/时长预算耗尽进入 `waiting_for_user` 等用户决策
4. `coordination/` — 通用协作规划器：用户输入 → TaskBrief → 模型从协议目录（`single_agent` / `parallel_fanout` / `review_revision` / `debate`）选方案 → `validator.ts` 确定性校验 → 编译为持久化 Coordination Plan → `runtime.ts` 按依赖与并发限制执行

其他核心模块：

- `conversations/dispatcher.ts` — 聊天室（conversation）内的多个 run 串行 drain；新消息可启动并行 run
- `messaging/` — bus（进程内事件 → WS 广播）、inbox（agent 收件箱）、tasks（任务三态 + claim 锁，SQLite `BEGIN IMMEDIATE` 事务）
- `llm/router.ts` — 模型串前缀路由 `mock:*` / `openai:*`（兼容端点）/ `anthropic:*`，纯 fetch 实现，支持 `LLM_PROXY` 出站代理；未配置价格的模型成本记 0
- `tools/` — 内置 fs/http/shell/search + MCP stdio client（`mcp.<远端工具名>` 注册进统一目录）；`tools/types.ts` 权限三档门控；MCP 失败调用不自动重放
- `hitl/approvals.ts` — 中断审批，`APPROVAL_TIMEOUT_MS` 超时按拒绝处理，不遗留 pending
- `runs/` — trace（run_events 落库）、checkpoints、recovery、observability
- `workspaces/` — 沙箱路径规则：无前缀 = 当前 run 工作区（`sandbox/runs/<runId>/`，或命名工作区 `sandbox/workspaces/<name>/` 跨 run 复用）；`shared/` = 团队共享区（写入强制人工审批）；`archive/` = 只读归档

### 数据

本地 SQLite（`apps/server/data/`，gitignored），WAL 模式，表结构见 `apps/server/src/db/schema.sql`。**只增不删**：不删数据库文件、不做破坏性变更。

## 文档治理

`docs/` 按职责分五类：`requirements/`（为什么做）、`architecture/`（当前契约）、`plans/`（怎么实施）、`research/`（外部参考）、`reports/`（测试证据）。权威性优先级：当前代码与自动化验证 → `architecture/` 生效契约 → 已批准计划 → 调研和历史报告。方案类文档须标注状态（草案 / 已批准 / 实施中 / 已完成 / 已废止）。提交文档变更前跑 `pnpm verify:docs`。

## Squad Collaboration

This project uses squad for multi-agent collaboration. Run `squad help` for all commands and usage guide.
