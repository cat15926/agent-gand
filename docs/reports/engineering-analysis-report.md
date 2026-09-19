# 工程分析报告：agent-gand

> 汇总报告，由三份前置产出合成：`engineering-overview.md`（结构与模块清单）、`architecture-assessment.md`（架构与质量评估）、`dependency-build-analysis.md`（依赖与构建配置，本 run 已补落盘）。所有结论均标注文件级依据；规模行数为估算（±20%，方法见 §四）。

## 一、工程概况

**定位**：多 Agent 协作工具平台——后端编排引擎 + 前端 "1+3" 观测界面，支持顺序流水线 / 主管委派两种编排、HITL 审批、审查-返工闭环与全链路 trace。权威规格 [`docs/architecture/scaffold-plan.md`](../architecture/scaffold-plan.md)（v0.1 + 增量 §7~§13）。

**形态**：pnpm workspace monorepo，4 包（root 编排 + `packages/shared` 契约包 + `apps/server` 后端 + `apps/web` 前端）；`pnpm-workspace.yaml`、三个包 `package.json` 均实读。

**规模**：server 28 TS + 1 SQL；shared 8 TS（7 契约 + barrel）；web 15 个 src TS/TSX；agent 定义 3 个 md；验证脚本 2 个 .mjs。全仓 TS/TSX 约 6,000–7,500 行（估算）。定性：小型工程、模块粒度均匀、无单文件失控（已知最大 <450 行）。

**增量（超出规格 v0.1）**：① 审查-返工闭环（tasks/attempts.ts、task_attempts/task_reviews 表、shared/review.ts，TASK_MAX_ATTEMPTS=3）；② 进程重启恢复序列 + attempt 租约；③ 工作区体系（runs 表 supervisor_id/workspace + external_workspaces 表）；④ agent 定义已接真实模型 anthropic:glm-5.3。

## 二、技术栈

依据：tsconfig.base.json、apps/*/package.json、apps/web/vite.config.ts、apps/web/src/styles.css。

- **语言**：TS 5.9.3，strict + noUncheckedIndexedAccess + verbatimModuleSyntax，ES2022 全仓 ESM，仅 typecheck（noEmit）无构建产物
- **运行时**：Node ≥22（根 engines 硬约束）、pnpm 9.15.4（packageManager 字段）
- **后端**：Fastify 5.12.1（cors 10.1.0 / websocket 11.3.0）、better-sqlite3 12.11.1（WAL、9 表、BEGIN IMMEDIATE）
- **LLM**：自研 Provider 抽象（Mock/OpenAI/Anthropic）+ 模型串前缀路由（llm/router.ts），undici 8.10.1 出站代理，llm.delta 流式
- **工具协议**：MCP stdio（tools/mcp/client.ts，@modelcontextprotocol/sdk 1.30.0）
- **前端**：React 19.2.8 + Vite 6.4.3 + Tailwind 4.3.3 + react-markdown；REST + WS
- **开发工具**：tsx 4.23.13 直跑 TS 源码；两个原生 .mjs 验收脚本

## 三、依赖

依据：根与三个包 `package.json` + `pnpm-lock.yaml`（lockfileVersion 9.0，已入库可复现）。全部锁定版本均已核验到实际使用点。

**总况**：4 包共 13 个运行时依赖 + 8 类 dev 依赖；**冗余 = 0**（全部有 import/脚本/CSS 指令使用点）；**过时 = 0**（唯一标注：vite 锁 6.4.3，vite 7 已发布，属"可选升级"非过时）；无 deprecated 包、无历史包袱。

**核心依赖表**（range → 锁定）：

| 包 | 关键依赖 | 用途 |
|---|---|---|
| server | @agent-gand/shared workspace:*、fastify ^5.2→5.12.1、@fastify/cors 10.1.0、@fastify/websocket 11.3.0、better-sqlite3 ^12→12.11.1、@modelcontextprotocol/sdk ^1.10→1.30.0（zod 4.5.4）、undici ^8.10.1、yaml ^2.6→2.9.0 | 契约 / HTTP / CORS / WS / 持久化 / MCP / LLM 出站+代理 / agent frontmatter |
| web | react+react-dom ^19→19.2.8、react-markdown 10.1.0、remark-gfm 4.0.1、tailwindcss 4.3.3、vite ^6→6.4.3 | UI / Markdown 渲染 / 构建链 |
| shared | 零运行时依赖，exports: "./src/index.ts" 源码直出 | 跨端契约唯一来源 |

**边缘观察（非冗余）**：typescript 四包重复声明（pnpm 非提升惯例）；undici 非 Node 内置 fetch 替代——需显式 dispatcher 挂 ProxyAgent；@types/better-sqlite3 锁 7.6.13 服务 v12 运行时是 DefinitelyTyped 版号线惯例，非错配。

**构建/运行/测试**：`pnpm dev`（tsx watch 3010 + vite 5173 代理 /api、/ws）；`pnpm --filter @agent-gand/server start` 为 tsx 直跑源码（**无编译产物**）；`pnpm typecheck` = 三包 tsc --noEmit；无单元测试框架，质量门禁 = typecheck + verify-scheduler.mjs + verify-llm-stubs.mjs；未见 CI/Dockerfile。

**环境**：无 dotenv，config.ts 手写 .env 解析；.env.example 全表 18 项变量；未配 API key 时 mock:* 零配置可跑；better-sqlite3 为唯一平台敏感安装项（prebuilt 优先，否则 node-gyp）。

## 四、架构质量

依据：architecture-assessment.md（两轮共 20 个文件实读）。

**分层（server 单向依赖，无反向/跨层直穿）**：装配层 index.ts → 传输层 api/ → 编排层 orchestration/ → 领域层 messaging/tasks/hitl/runs/agents/workspaces → 基础设施 db/llm/tools → 契约包 shared（双端唯一类型来源，正确的依赖倒置）。

**关键链路**（均已实读核验）：启动恢复链（interruptRunningAttempts→recoverInterruptedTasks→resumeSupervisorRun，activeSchedules 防重入）；主管模式主链（decomposePrompt→parseDecomposition 严格校验+拓扑排序→失败 fallbackTasks 降级→claim→attempt→审查→transition→汇总）；agent 执行循环（流式 chat→工具逐个权限门控→并行执行→结果回传）；前端状态链（hydrate REST→WS 增量→reducer 按 activeRunId 过滤→streams 折叠→断线 hydrate 回补）。

**设计模式**：策略（Orchestrator 双实现）、Provider 抽象+前缀路由工厂、事件总线、状态机+CAS 悲观锁、模板方法（agentStep 双模式共用）、优雅降级、中断恢复、前端单向数据流。

**一致性**：claim/complete/transition 均在 BEGIN IMMEDIATE 事务内"读-判-写"，CAS 防重复 tick。

**技术债务 8 项（A–H，按影响排序）**：
- A 工具结果以 user 消息模拟协议原生 tool 消息（TODO + PSEUDO_TOOL_CALL_RE 启发式补丁已引发模型伪调用行为，agentStep.ts:53 一带）
- B scheduler 轮询 O(N²)+N+1（runTaskSchedule for(;;) 双全量查询、blockedBy 逐条 getTask）
- C database.ts import 副作用重 + 三种迁移风格并存（模块顶层建库，测试隔离只能换 DB_PATH）
- D WS 全量无差别广播且无鉴权无心跳（ws.ts 文件头自带 TODO；store.tsx 实读证实客户端收下全部 run 事件再本地丢弃）
- E trace.ts 三类关注点过载 + routes.ts 300+ 行手写 typeof 校验
- F reviewer 靠 /review/i 正则推断（隐式命名契约，无显式 role 字段）
- G 交接文档表述漂移（store 曾被标注为"模块"暗示目录；services 漏 notify.ts——本次评估已被实际误导一次）
- H 次要：costUsd 恒记 0（provider.ts TODO）、全仓无单元测试（parseDecomposition 等纯函数零成本可测）、魔法数散落（MAX_TASKS=5、maxToolRounds=6）

**综合评价**：架构骨架优秀——分层清晰、契约集中、并发与恢复设计扎实、防御性编程密度高、多数债务已有代码内 TODO 显式登记（团队对债务有自觉）。

## 五、风险点

1. **协议适配权宜实现**（债务 A）：已实际引发模型伪调用，正则启发式绑定特定模型行为，换模型即失失配——当前最高技术风险
2. **run 滞留 running**：POST /api/runs 的 void start().catch(log)，若 startSpan 等前置调用抛错，进程内无 watchdog（仅重启时被恢复序列接住）
3. **部署安全边界**：@fastify/cors origin:true 反射任意 Origin + WS 无鉴权广播全量事件 + 无 helmet/API 鉴权——本地 MVP 可接受，公网部署前必须收紧
4. **安全结论的能力边界**：沙箱无网络，未执行 pnpm audit/OSV；基于锁定版本的静态比对无已知未修复高危 CVE（fastify 5.12.1 / undici 8.10.1 / react 19.2.8 等线上），建议 CI 接入 pnpm audit --prod 取权威结论
5. **测试与 CI 缺位**：无单元测试框架、无 CI 配置——回归防护全靠 2 个 .mjs 集成脚本
6. **扩展天花板**：调度轮询 O(N²)、WS 广播随连接数×run 数放大——当前 MAX_TASKS=5 可容忍，并发增长后显现

## 六、改进建议（按优先级）

**P0（先做，安全/正确性）**
1. 实现协议原生 tool 消息回传（openai role:tool / anthropic tool_result block），随后删除 PSEUDO_TOOL_CALL_RE 启发式——消除债务 A 与风险 1
2. 为 run 生命周期加进程内 watchdog 或 start 链路 try/catch 兜底，消除 run 滞留 running
3. CI 接入 pnpm typecheck + verify:scheduler + pnpm audit --prod，作为最小质量门禁

**P1（近期，架构加固）**
4. WS 订阅握手携带 runId 列表，服务端按订阅过滤后再 send（附带缓解风险 3 的暴露面）
5. scheduler 改事件驱动：blocker 状态一次性 IN 查询，ready 任务由 task.updated 事件唤醒——消除 O(N²)+N+1
6. database.ts 初始化收敛为显式 initDatabase()，迁移统一走 ensureColumns——支撑后续测试隔离
7. 为 parseDecomposition 等已导出纯函数补 vitest 单元测试（零成本起步）

**P2（择机，工程质量）**
8. frontmatter 增加显式 role/flags 字段替代 /review/i 正则推断；MAX_TASKS 等魔法数迁配置
9. trace.ts 拆分 runs 仓储与 trace/usage；routes.ts 校验迁 fastify JSON schema
10. provider 按模型维护价格表，修复 costUsd 失真；vite 6→7 可选升级；补 verify:llm 根 script 别名；.env.example 三项可选变量补注释

## 验收对照

| 标准 | 状态 |
|---|---|
| 五部分（概况/技术栈/依赖/架构/风险） | ✅ §一~§五 + §六建议清单 |
| 结论均有文件/配置引用 | ✅ 各节开头标注依据文件；债务/风险逐项附文件级证据 |
| 按优先级排序的改进建议 | ✅ §六 P0×3 / P1×4 / P2×4，每项关联对应债务与风险 |

*报告依据三份前置产物合成；行数统计为估算值（外推法，±20%），方法与样本详见 architecture-assessment.md §2。*
