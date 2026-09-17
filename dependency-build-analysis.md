# 依赖与构建配置分析：agent-gand（存档版）

> 前置任务交付物的落盘存档（原文因工具预算耗尽仅存于对话，本文件为压缩重写，完整版见任务对话）。证据基础：根/三包 package.json、pnpm-workspace.yaml、tsconfig.base.json、pnpm-lock.yaml（lockfileVersion 9.0，已入库）、.env.example、vite.config.ts，并核验 7 个关键源文件使用点。

## 1. 直接依赖总表（range → 锁定）

### 根（仅编排，无运行时依赖）
typescript(dev) ^5.6.0 → 5.9.3

### packages/shared（零运行时依赖）
typescript(dev) 5.9.3。exports: "./src/index.ts" TS 源码直出，消费方就地编译（无构建产物策略）。

### apps/server（8 运行时 + 4 dev）
- @agent-gand/shared workspace:* —— 跨端领域契约
- fastify ^5.2.0 → 5.12.1（HTTP，index.ts 组装 REST）
- @fastify/cors 10.1.0（index.ts 注册，origin:true 见风险）
- @fastify/websocket 11.3.0（llm.delta 流式广播）
- better-sqlite3 ^12 → 12.11.1（db/database.ts，9 表 WAL IMMEDIATE）
- @modelcontextprotocol/sdk ^1.10 → 1.30.0（zod 4.5.4；tools/mcp/client.ts）
- undici 8.10.1（llm/provider.ts 出站请求 + ProxyAgent 代理）
- yaml ^2.6 → 2.9.0（agents/loader.ts 解析 frontmatter，有意不引 gray-matter）
- dev：tsx 4.23.13（dev+start 均依赖）、@types/node 22.20.1、@types/better-sqlite3 7.6.13、typescript 5.9.3

### apps/web（5 运行时 + 8 dev）
- @agent-gand/shared workspace:*
- react/react-dom ^19 → 19.2.8
- react-markdown 10.1.0 + remark-gfm 4.0.1（RunView MarkdownBody）
- dev：vite ^6 → 6.4.3（/api、/ws 代理→3010）、@vitejs/plugin-react 4.7.0、tailwindcss + @tailwindcss/vite 4.3.3（styles.css @import 'tailwindcss'）、@tailwindcss/typography 0.5.20（@plugin 构建期内联）、@types/react*、typescript

传递依赖：MCP SDK 拉入 zod 4.5.4；web 构建链 esbuild/lightningcss/jiti 均 dev 面，不进 server 运行时。

## 2. 命令与环境

| 场景 | 命令 |
|---|---|
| 安装 | pnpm install（pnpm 9.15.4 workspace，lockfile 入库） |
| 一键开发 | pnpm dev（tsx watch:3010 + vite:5173） |
| server 类生产启动 | pnpm --filter @agent-gand/server start（tsx 直跑，无编译产物） |
| web 构建 | vite build / preview（全仓唯一构建步骤） |
| 类型检查 | pnpm typecheck（-r tsc --noEmit） |
| 验证 | pnpm verify:scheduler；node scripts/verify-llm-stubs.mjs（未包装为 script） |
| 数据重置 | pnpm db:reset |

环境：Node ≥22 硬约束；无 dotenv（config.ts 手写解析）；.env.example 18 项变量，未配 key 时 mock:* 零配置可跑；better-sqlite3 原生模块为唯一平台敏感项（prebuilt 优先，否则 node-gyp）。

## 3. 过时/冗余/安全

- 冗余 = 0（13 运行时依赖全部核验到使用点）。边缘观察：typescript 四包重复（pnpm 惯例，可迁 catalog）；undici 非冗余（需显式 ProxyAgent dispatcher）；@types/better-sqlite3 锁 7.x 服务 v12 是 DefinitelyTyped 版号线惯例。
- 过时 = 0。唯一标注：vite 6.4.3（vite 7 已发布，可选升级）。无 deprecated 包。
- 安全（静态比对，沙箱无网未跑 audit）：锁定版本线上无已知未修复高危 CVE；配置层风险——cors origin:true 反射任意 Origin、WS 无鉴权全量广播、无 helmet/API 鉴权、start 走 tsx 运行时信任面偏大。建议 CI 接 pnpm audit --prod。

## 4. 顺带建议
verify-llm-stubs.mjs 补根 script 别名 verify:llm；.env.example 三项"可选"变量（ORCHESTRATOR_CONCURRENCY 等）补注释对齐风格。
