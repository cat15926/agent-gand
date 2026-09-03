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

---

## 7. 增量需求 v0.2：真实 LLM Provider + Supervisor 结构化拆解

> 2026-09-02 追加。目标：把 P0 中两处骨架级实现做实。契约（packages/shared）**不变更**。

### 7.1 真实 LLM Provider（`llm/provider.ts` + `llm/router.ts` + `config.ts`）

**环境变量（同步更新 `.env.example` 与 README）：**

| 变量 | 说明 |
|---|---|
| `LLM_OPENAI_API_KEY` / `LLM_OPENAI_BASE_URL` | openai-compatible 提供方；BASE_URL 默认 `https://api.openai.com/v1`，接 DeepSeek/GLM/Qwen 等兼容端点时改此值（如 `https://api.deepseek.com/v1`） |
| `LLM_ANTHROPIC_API_KEY` / `LLM_ANTHROPIC_BASE_URL` | Anthropic；BASE_URL 默认 `https://api.anthropic.com` |
| `LLM_PROXY` | 可选（如 `http://127.0.0.1:7897`）；设置后 LLM 出站请求走代理（undici ProxyAgent dispatcher），不设则直连 |

**实现要求：**

- 纯 `fetch` 实现，不引入官方 SDK；可新增 `undici` 依赖用于代理支持。
- **OpenAICompatibleProvider**：`POST {base}/chat/completions`；请求含 `model/messages/tools`（工具 schema）；响应解析 `choices[0].message`（含 `tool_calls`）与 `usage` 记账；60s 超时；非 2xx 抛出含 status 与 response body 的错误。
- **AnthropicProvider**：`POST {base}/v1/messages`；headers `x-api-key` + `anthropic-version: 2023-06-01`；system 提示放独立 `system` 字段；`tools` 与响应 `tool_use` content block 解析；`usage.input_tokens/output_tokens` 记账。
- 模型串路由不变：`openai:<model>` / `anthropic:<model>` / `mock:<x>`。
- 未配置所需 key 时调用 → 明确错误信息（指明缺哪个 `LLM_*_API_KEY`，提示看 `.env.example`）。
- MockProvider 保留为默认演示路径，**零回归**。

### 7.2 Supervisor 结构化拆解（`orchestration/supervisor.ts`）

- `decompose(goal, team)` 用 supervisor agent 的真实 LLM 产出 JSON：`{"tasks":[{"title","body","assignee","blockedBy"(标题引用,可选)}]}`，任务数 ≤5。
- prompt 需附团队成员名单（id + description），要求 assignee 从中选。
- 解析后校验：assignee ∈ 团队、标题去重、blockedBy 引用存在且无环；**非法输出 → fallback 到现有 mock 拆解**，并发一条 system message 说明"结构化拆解失败已降级"。
- 并行执行与失败重试**不在本次范围**（保留 TODO）。

### 7.3 验收标准（无需真实 key）

1. `pnpm -r typecheck` 三包绿；不带任何 key 启动，mock 路径零回归（pipeline/supervisor run 照常）。
2. **本地 stub 验证 openai-compatible**：写一个临时 node stub HTTP server 返回固定 chat/completions 响应（含 tool_calls + usage），`LLM_OPENAI_BASE_URL` 指向 stub 跑 pipeline —— 验证请求体格式（model/tools/messages）、tool_calls 正确触发工具执行并过权限门控、usage 从响应记账。
3. **本地 stub 验证 anthropic**：stub 返回 messages API 格式 —— 验证 headers、system 独立字段、tool_use block 解析与 usage 记账。
4. **supervisor stub**：合法 JSON tasks → 正确创建/认领/完成；非法 JSON → fallback 生效且有 system message。
5. `.env.example`、README 快速开始补真实 LLM 配置示例（含 DeepSeek 示例）。
6. inspector 复核：strict 无 any、TODO 清单同步更新、中文注释、stub 脚本不留在 src/（放 scripts/ 或临时目录）。

> 真机 e2e（验收通过后可选）：由用户提供一个真实 key（如 DeepSeek）跑一次端到端 run。

### 7.4 工具 schema 可见性决策（2026-09-02 真机 e2e 后裁定）

`toolsForAgent`（下发给 LLM 的工具 schema 集合）按权限三档决定：

| 权限档 | 下发集合 | 执行时门控 |
|---|---|---|
| `readonly` | 只读工具集 | 只读集直过 |
| `auto` | 白名单 | 白名单直过 |
| `confirm` | **全量注册表** | 白名单直过，**其余一律审批** |

**理由**（真机 Run2 实证）：若 confirm 档只下发白名单 schema，真实 LLM 永远无法请求白名单外工具，"非白名单需审批"这一档对真实模型不可达（仅 mock 可演示）。schema 可见 ≠ 执行授权——与 Claude Code 的工具模型一致（工具全可见、权限在使用时把关）。执行侧门控不变，人类仍批准每个敏感动作。

**配套实现**：`orchestration/agentStep.ts` 共享模块（runAgentTurn 工具循环：门控→审批中断→执行→span/usage→结果回传，maxToolRounds 防失控）；pipeline 与 supervisor worker 统一走它，避免两份实现漂移；llm span input 记 `{messages, tools:[名单]}` 便于事后诊断。

---

## 8. 增量需求 v0.3：响应性能优化（流式 / 审批 / 权限 / 并行工具）

> 2026-09-04 追加，源于真机 run 32b19e2a 的耗时分析：总 1518s = 审批等待 49% + LLM 生成 50% + 工具 0%。本节含两处 shared 契约变更（已由 manager 落盘）：`events.ts` 新增 `llm.delta`；`approval.ts` 的 `ApprovalStatus` 新增 `'expired'`。§7.4 confirm 档执行门控行由 §8.3 修订（下发集合不变）。

### 8.1 LLM 流式输出（体感优化主项）

- **Provider 层**：`chat(req, onDelta?)` 增加可选增量回调 `onDelta(text: string)`；两个 Provider 均以流式请求（openai: `stream:true` + SSE 解析 `choices[0].delta`；anthropic: `stream:true` + `content_block_delta`，thinking 增量直接丢弃）。
- **难点点名**：流式下的工具调用分片重组——openai 按 `tool_calls[index]` 增量拼接 name/arguments；anthropic 按 `content_block` 的 `input_json_delta` 收集完整后组装 `tool_use`。usage 取流末块（openai `stream_options:{include_usage:true}`；anthropic `message_delta.usage`）。
- **转发**：agentStep 在 llm span 运行期间把增量经 bus 发 `llm.delta` 事件（runId + spanId + text）；span 结束仍记完整 output。
- **Web**：运行视图对活动 span 显示流式文本（"⟳ agent 名"渐增段落，span 结束后折叠为正式消息）；增量丢失可容忍（断线重连已有 hydrate 回补）。
- **stub**：stub server 需支持 SSE 分片响应，用例覆盖增量顺序、tool_calls 分片重组、usage 记账。

### 8.2 审批提醒强化 + 超时状态修复

- **超时可配**：`APPROVAL_TIMEOUT_MS`（默认 300_000；0 = 不超时）。
- **超时状态**：超时按拒绝处理时 approval 置 **`expired`**（decidedBy='system:timeout'），不得遗留 `pending`（run 32b19e2a 实证遗留 2 条）。
- **Web 提醒**：顶栏待审批数 >0 时 amber 高亮 + pulse 常驻；首次交互请求浏览器 Notification 权限，审批到达发系统通知（点击聚焦）；FleetView needs_input 判定仅看 pending；pending 卡按 createdAt 置顶。

### 8.3 权限策略调优：只读工具直过

- **新判定顺序**（执行侧）：`disallowedTools` 命中 → deny；**只读类**（`fs.read` / `search.files` / `http.get`）→ readonly 与 confirm 档直过；confirm 档非只读 → 审批（agent 白名单内仍直过）；auto 档 → 白名单内直过、白名单外 deny。
- §7.4 的"confirm 下发全量注册表"**不变**；仅执行侧门控按此修订。
- 依据：真机 3 次审批中 2 次为 fs.read（只读零风险），全可免。
- stub：confirm 档 fs.read 直过 + fs.write 仍审批；auto 档白名单外 deny。

### 8.4 并行工具调用

- **Provider 契约**（server 内部类型）：`LlmResponse.toolCall: ToolCall | null` → **`toolCalls: ToolCall[]`**（openai 多 `tool_calls`、anthropic 多 `tool_use` block 原生支持）；agentStep 同步消费。
- **执行**：一轮多个 toolCalls 逐个过门控（审批创建可并行），通过后 **Promise.all 并行执行**，每个工具独立 tool span（时间可重叠）；结果统一回传下一轮。
- **prompt**：TOOL_CALL_DIRECTIVE 追加"如需多个工具，请在同一轮并行发起全部调用"。
- **验收**：stub 断言一轮 2 个 tool_use 并行执行（span 时间重叠）、结果齐回传。

### 8.5 验收标准

1. `pnpm -r typecheck` 绿；stub 全绿（含新增流式/并行/权限/超时用例）。
2. 真机（repo DB，GLM，.env 已配好）：① 调研类 pipeline run，web 可见逐字流式输出；② 只读工具零审批；③ 审批→approved 与超时→expired 两路径全链路（超时路径可调小 APPROVAL_TIMEOUT_MS 验证）；④ 顶栏提醒 + 浏览器通知；⑤ 至少一轮并行工具（span 时间重叠证据）。runId 成对留存。
3. 回归：supervisor 模式、空正文/伪调用防御、usage 记账准确。
4. inspector 复核：代码 + stub 交叉 + DB 取证。
