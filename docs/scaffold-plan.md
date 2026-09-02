# agent-gand 脚手架规格说明（v0.1）

> 本文档是脚手架搭建的**唯一权威规格**。由 manager 制定，worker 按 §4 实现 server，manager 实现 §5 web。所有类型契约以 `packages/shared`（已由 manager 落盘）为准，不得擅自修改；如确需变更，先在 squad 中发给 manager 确认。
> 需求来源：`多Agent协作平台需求调研报告.md` §7.2 P0 清单、§7.4 技术选型。

## 1. 技术栈与约定

| 项 | 选择 |
|---|---|
| 运行时 | Node >= 22（本机 v22.23.1），pnpm 9 workspace monorepo |
| 语言 | TypeScript 5 strict（`verbatimModuleSyntax`、`noUncheckedIndexedAccess`）|
| 后端 | Fastify 5 + @fastify/cors + @fastify/websocket + better-sqlite3 + yaml |
| 前端 | React 19 + Vite 6 + Tailwind CSS 4（@tailwindcss/vite，无需 config 文件）|
| 包结构 | `packages/shared`（纯类型）+ `apps/server` + `apps/web` |
| 端口 | server **3010**，web dev **5173**（vite proxy `/api`、`/ws` → 3010）|
| 数据 | SQLite：`apps/server/data/agent-gand.sqlite`（WAL，gitignore）|
| Agent 定义 | `agents/*.agent.md`：YAML frontmatter + 正文=system prompt |
| 模型路由 | model 字符串前缀路由：`mock:*` → MockProvider（演示可跑通）；`openai:*` / `anthropic:*` → 留 TODO 骨架 |
| MCP | `@modelcontextprotocol/sdk` stdio client 骨架（可连、可列出工具、标注 TODO）|

## 2. 目录树（全仓库）

```
agent-gand/
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  .gitignore  README.md
├── docs/scaffold-plan.md            # 本文档
├── 多Agent协作平台需求调研报告.md
├── agents/                          # agent 定义（入库共享）
│   ├── planner.agent.md  coder.agent.md  reviewer.agent.md
├── packages/shared/                 # ★契约（manager 已完成，勿动）
│   ├── package.json  tsconfig.json
│   └── src/ index.ts agent.ts message.ts task.ts run.ts approval.ts events.ts
└── apps/
    ├── server/                      # ★worker 负责（§4）
    │   ├── package.json  tsconfig.json  .env.example
    │   └── src/
    │       ├── index.ts  config.ts  seed.ts
    │       ├── db/ database.ts  schema.sql
    │       ├── agents/ loader.ts  registry.ts
    │       ├── messaging/ bus.ts  inbox.ts  tasks.ts   # tasks.ts：任务三态+claim 事务锁领域服务（worker 提案，已批准）
    │       ├── orchestration/ types.ts  pipeline.ts  supervisor.ts
    │       ├── llm/ provider.ts  router.ts
    │       ├── tools/ types.ts  builtin/index.ts  mcp/client.ts
    │       ├── hitl/ approvals.ts
    │       ├── runs/ trace.ts
    │       └── api/ routes.ts  ws.ts
    └── web/                         # ★manager 负责（§5）
        ├── package.json  tsconfig.json  vite.config.ts  index.html
        └── src/ main.tsx App.tsx styles.css
            ├── services/ api.ts ws.ts
            └── components/ TopBar.tsx SideNav.tsx RightPanel.tsx ApprovalCard.tsx
                └── views/ RunView.tsx FleetView.tsx ObserveView.tsx CanvasView.tsx
```

## 3. 数据库 schema（apps/server/src/db/schema.sql）

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, definition TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, goal TEXT NOT NULL, mode TEXT NOT NULL,
  status TEXT NOT NULL, agent_ids TEXT NOT NULL,  -- JSON array
  created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, run_id TEXT, title TEXT NOT NULL, body TEXT,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|in_progress|completed
  assignee TEXT, created_by TEXT,
  blocked_by TEXT NOT NULL DEFAULT '[]',          -- JSON array of task ids
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
  from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, -- agent id | 'user' | 'system'
  kind TEXT NOT NULL, body TEXT NOT NULL, meta TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT,
  span_kind TEXT NOT NULL, name TEXT NOT NULL,    -- llm|tool|agent|message|approval|orchestration
  input TEXT, output TEXT, status TEXT NOT NULL,  -- running|ok|error
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, input TEXT, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending|approved|rejected|edited
  edited_input TEXT, decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
```

规则：所有时间戳用 ISO 字符串（`new Date().toISOString()`）；JSON 数组存 TEXT；ID 用 `crypto.randomUUID()`。

## 4. Server 规格（worker 任务）

### 4.1 依赖（apps/server/package.json）

- deps：`fastify@^5.2.0`、`@fastify/cors@^10.0.0`、`@fastify/websocket@^11.0.0`、`better-sqlite3@^12.0.0`、`yaml@^2.6.0`、`@agent-gand/shared`（workspace:`*`）、`@modelcontextprotocol/sdk@^1.10.0`
- devDeps：`tsx@^4.19.0`、`typescript@^5.6.0`、`@types/node@^22`、`@types/better-sqlite3@^7.6.12`
- scripts：`dev: tsx watch src/index.ts`、`start: tsx src/index.ts`、`typecheck: tsc --noEmit`
- `"type": "module"`

### 4.2 模块职责

| 模块 | 职责 | 要点 |
|---|---|---|
| `config.ts` | 环境变量 | PORT(默认3010)、DB_PATH、AGENTS_DIR(默认 `<repo>/agents`)、LLM_* 透传；路径用 `fileURLToPath(import.meta.url)` 解析，兼容 tsx |
| `db/database.ts` | SQLite 单例 | `pragma journal_mode=WAL`；`executescript(schema.sql)`；导出 `all/get/run` 与 `tx(fn)`（`BEGIN IMMEDIATE` 事务）|
| `agents/loader.ts` | 解析 `*.agent.md` | 手写 frontmatter 拆分（`---` 围栏）+ `yaml.parse`；body=systemPrompt；缺省 id=文件名去扩展名 |
| `agents/registry.ts` | 注册表 | `syncFromFiles()` upsert 进 agents 表（definition 存 JSON）；`list()`/`get(id)` |
| `messaging/bus.ts` | EventBus 单例 | `emit(event: ServerEvent)`；`subscribe(fn)`（ws.ts 订阅后广播）|
| `messaging/inbox.ts` | 收件箱 | `post(msg)` 落库+emit `message` 事件；`listByRun(runId)` |
| `orchestration/types.ts` | 契约 | `interface Orchestrator { start(run: Run, agents: AgentDefinition[], goal: string): Promise<void> }` |
| `orchestration/pipeline.ts` | 顺序流水线 | **可端到端跑通**：按 agentIds 顺序，每个 agent 一次 LLM 调用（messages 累积传递），记录 span（llm/agent）、usage；工具调用由 mock 响应触发一条 tool span 走权限门控 |
| `orchestration/supervisor.ts` | 主管委派 | supervisor（第一个 agent）"拆解"目标为 tasks（mock：按 goal 关键词生成 2-3 条）、逐个 claim→执行→complete，最后汇总一条 message |
| `llm/provider.ts` | Provider 接口 | `interface LLMProvider { chat(req: LlmRequest): Promise<LlmResponse> }`（类型自定，含 usage）；`MockProvider`：确定性文案+假 token 数+~200ms 延迟 |
| `llm/router.ts` | 路由 | `mock:` → Mock；其他前缀 throw `LLM provider not configured (TODO)` |
| `tools/types.ts` | 工具契约 | `interface Tool { name; run(input, ctx) }`；`checkPermission(agent, toolName): 'allow'|'deny'|'need_approval'`（readonly→只读类工具；auto→allowlist 内直过；confirm→非 allowlist 需审批）|
| `tools/builtin/index.ts` | 内置工具 | `fs.read`/`fs.write`（沙箱限定 `apps/server/data/sandbox/`）、`http.get`、`shell.run`（仅白名单 echo/date/pwd）、`search.files`（对 data/ 做 grep）；每次调用记 tool span |
| `tools/mcp/client.ts` | MCP 骨架 | 用 SDK stdio transport 连一个配置的 server，listTools + callTool 薄封装；未配置时返回空；TODO 标注 |
| `hitl/approvals.ts` | 审批 | `create/list/decide(id, {decision, editedInput?, by})`；decide 后 emit `approval.updated`；编排器轮询 pending 审批（500ms，scaffold 级；TODO: durable pause/resume）|
| `runs/trace.ts` | 运行与观测 | createRun/startSpan/endSpan/finishRun；usage 按 run 汇总（SUM tokens/cost + llm/tool 调用数）|
| `api/routes.ts` | REST | 见 §4.3 |
| `api/ws.ts` | WS | `/ws` 升级；连接即发 `hello`；订阅 bus 全量转发 |
| `seed.ts` | 种子数据 | DB 为空时：同步 agents/、造 1 条 completed 的演示 run（含 events+usage）、1 条 pending approval、2 条示例 task、若干 message |
| `index.ts` | 启动 | config→db→seed→registry→fastify(cors,ws,routes)→listen；graceful SIGINT |

### 4.3 REST API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok:true, agents, runs}` |
| GET | `/api/agents` | AgentDefinition[] |
| GET | `/api/tasks?runId=` | Task[] |
| POST | `/api/tasks` | `{title, body?, createdBy}` → Task |
| POST | `/api/tasks/:id/claim` | `{agentId}` → Task；**必须** `BEGIN IMMEDIATE` 事务内：仅 pending 可领，置 in_progress+assignee（防竞态锁）|
| POST | `/api/tasks/:id/complete` | `{agentId}`（须为 assignee）→ Task |
| GET | `/api/messages?runId=` | Message[]（runId 必填——消息必属于某次运行，与领域模型一致） |
| POST | `/api/messages` | `{runId, from, to, kind, body}` → Message |
| POST | `/api/runs` | `{goal, mode:'pipeline'|'supervisor', agentIds}` → `{run}`；**异步执行**立即返回，进度走 WS/GET |
| GET | `/api/runs` | Run[] |
| GET | `/api/runs/:id` | `{run, events, tasks, messages, approvals}` |
| GET | `/api/approvals?status=` | ApprovalRequest[] |
| POST | `/api/approvals/:id/decide` | `{decision:'approve'|'reject'|'edit', editedInput?, by}` → ApprovalRequest |
| GET | `/api/usage` | UsageSummary[] |

### 4.4 验收标准（worker 完成定义）

1. `pnpm install`（根目录）成功；`pnpm -r typecheck` 全绿。
2. `pnpm dev:server` 启动在 3010；`GET /api/health` 返回 200 且 agents=3（seed 后）。
3. `POST /api/runs {"goal":"演示","mode":"pipeline","agentIds":["planner","coder","reviewer"]}` → run 最终 `completed`，`GET /api/runs/:id` 有 events（含 llm/agent span）与 usage>0。
4. `POST /api/tasks` + 两次并发 `claim` 只有一次成功（锁生效）。
5. 审批 decide 接口三种 decision 均可用并广播 WS 事件。
6. supervisor 模式能跑通（任务被创建、认领、完成，最终有汇总 message）。
7. 代码 TS strict 无 `any` 滥用；骨架点全部 `// TODO:` 标注；注释中文简明。

完成后：`squad send worker manager "<runId 与验证结果摘要>"`。

## 5. Web 规格（manager 自实现，worker 无需关心）

- 布局采用报告 §7.3 的"1+3"壳：TopBar（运行状态/用量/权限模式）+ SideNav（运行/编排/舰队/观测）+ 主区（RunView=消息流时间线+步骤折叠+输入框；工作区占位）+ RightPanel（审批卡/Trace/用量 tab）。
- FleetView：一行一 agent（状态+摘要+时长），ObserveView：runs 列表+events 详情，CanvasView：P1 占位说明。
- services/ws.ts 自动重连，事件写入本地 store（React state + context）。
- 仅依赖已装依赖，不新增。

## 6. P0 → 模块映射（验收对照）

| P0 需求 | 模块 |
|---|---|
| 1 Agent 定义（人设/模型/工具白名单/权限）| agents/loader+registry、shared/agent.ts |
| 2 编排引擎（supervisor+pipeline）、任务三态+依赖落盘 | orchestration/*、db tasks、SQLite |
| 3 agent 通信（收件箱+共享任务列表+锁）| messaging/*、tasks claim(IMMEDIATE 事务) |
| 4 工具（内置+MCP Client）| tools/* |
| 5 HITL（中断审批+权限三档）| hitl/*、tools 权限门控 |
| 6 运行可视化（消息流/任务状态/用量）| api/ws、web RunView+RightPanel |
| 7 会话与运行历史 | runs/trace、run_events/messages 表、ObserveView |
