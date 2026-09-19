# 工程结构与模块清单梳理：agent-gand（依赖任务产物补写）

> 定位：多 Agent 协作工具平台（pnpm workspace monorepo），后端编排引擎 + 前端 "1+3" 观测界面；支持顺序流水线 / 主管委派两种编排、HITL 审批、审查-返工闭环与全链路 trace。权威规格为同目录的 [`scaffold-plan.md`](./scaffold-plan.md)。
> 核实方式：依赖任务直接读取约 22 个关键文件交叉验证；本次补写按架构评估轮新增实读（main.tsx/store.tsx/App.tsx）修正前端口径。

## 1. 目录树（含职责）

```
agent-gand/
├── package.json / pnpm-workspace.yaml / tsconfig.base.json   # 工作区根：dev/typecheck/verify:scheduler/db:reset
├── README.md
├── docs/requirements/                   # 需求与产品范围
├── docs/architecture/scaffold-plan.md   # 权威规格（v0.1 + 增量 §7~§13）
├── agents/                              # Agent 定义：Markdown+YAML frontmatter（正文=system prompt）
│   ├── planner.agent.md                 # 规划者（当前配 anthropic:glm-5.3）
│   ├── coder.agent.md                   # 执行者
│   └── reviewer.agent.md                # 检查者（PASS/FAIL+问题列表）
├── scripts/
│   ├── verify-scheduler.mjs             # FAIL→返工→PASS 调度闭环验证
│   └── verify-llm-stubs.mjs             # 14 阶段 LLM stub 全链路验证
├── packages/shared/src/                 # 跨端类型契约包（唯一权威，禁私有定义）
│   └── index.ts barrel + agent/message/task/run/approval/review/events.ts
└── apps/
    ├── server/                          # 后端：编排+持久化+API（.env.example；data/ 运行时数据 gitignored）
    │   └── src/
    │       ├── index.ts                 # 入口：config→db→registry→seed→启动恢复→fastify→listen:3010
    │       ├── config.ts / seed.ts
    │       ├── db/                      # database.ts（SQLite 单例·WAL·BEGIN IMMEDIATE）+ schema.sql（9 表）
    │       ├── agents/                  # loader.ts（解析 *.agent.md）+ registry.ts
    │       ├── messaging/               # bus.ts 事件总线 / inbox.ts / tasks.ts（三态+claim 锁）
    │       ├── tasks/attempts.ts        # 执行凭证（租约/重启恢复/attempt 计数）
    │       ├── orchestration/           # types / pipeline / supervisor / scheduler / agentStep / reviewStep / contextBuilder
    │       ├── llm/                     # provider.ts（接口+Mock）/ router.ts（mock:|openai:|anthropic: 前缀路由）
    │       ├── tools/                   # types.ts（权限门控）/ builtin / mcp/client.ts
    │       ├── hitl/approvals.ts · runs/trace.ts
    │       └── api/                     # routes.ts（REST）+ ws.ts（WS 转发）
    └── web/                             # 前端 SPA（vite dev:5173，/api、/ws 代理→3010）
        ├── index.html / vite.config.ts
        └── src/
            ├── main.tsx                 # 入口：createRoot+StoreProvider
            ├── App.tsx                  # "1+3" 布局壳
            ├── store.tsx                # 全局状态（单文件：useReducer+WS 事件写入；已实读确认，非目录）
            ├── styles.css
            ├── services/                # api.ts + ws.ts + notify.ts（store.tsx import 证实 notify 存在）
            └── components/
                ├── TopBar / SideNav / RightPanel / ApprovalCard
                └── views/               # RunView / CanvasView（P1 占位）/ FleetView / ObserveView
```

## 2. 技术栈

TS 5 strict（ES2022、noUncheckedIndexedAccess、verbatimModuleSyntax，全仓 ESM）；Node ≥22 + pnpm 9.15.4；后端 Fastify 5（cors/websocket）；SQLite better-sqlite3（WAL，9 表）；LLM 自研 Provider + 模型串前缀路由（mock/openai 兼容/anthropic，支持出站代理、llm.delta 流式、单轮并行工具）；工具协议 MCP（stdio）；前端 React 19 + Vite 6 + Tailwind 4 + react-markdown；通信 REST+WS；开发工具 tsx + 原生 .mjs 验收脚本。

## 3. 入口与运行

- server：`apps/server/src/index.ts`（config→db→registry→seed→启动恢复 interruptRunningAttempts/recoverInterruptedTasks/resumeSupervisorRun→fastify→3010，SIGINT/SIGTERM 优雅退出）
- web：`apps/web/index.html`→`src/main.tsx`（5173，代理→3010）
- 一键：`pnpm install && pnpm dev`；单端 `pnpm dev:server` / `pnpm dev:web`
- 验证：`pnpm typecheck` / `pnpm verify:scheduler` / `node scripts/verify-llm-stubs.mjs` / `pnpm db:reset`

## 4. 超出规格 v0.1 的增量

1. 审查-返工闭环：tasks/attempts.ts、task_attempts/task_reviews 表、shared/review.ts；FAIL 自动返工（TASK_MAX_ATTEMPTS 默认 3）
2. 进程重启恢复序列 + attempt 租约
3. 工作区体系：runs 表 supervisor_id/workspace/title/deleted_at + external_workspaces 表
4. 依赖增量：server 增 undici（代理）；web 增 react-markdown/remark-gfm/typography
5. agent 定义已接真实模型（anthropic:glm-5.3）

## 5. 勘误（相对依赖任务原结论）

- 原清单标注 "store（模块）"：**实际为单文件 `apps/web/src/store.tsx`**（本轮实读证实：main.tsx:4 `import { StoreProvider } from './store'`，store.tsx 导出 StoreProvider/useStore）。属清单表述漂移，非代码缺失。
- services 目录为 3 文件（api/ws/notify），原清单漏 notify.ts。
