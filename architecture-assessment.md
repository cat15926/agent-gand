# 代码架构与质量评估报告：agent-gand（v2 修订版）

> 本轮为 Reviewer 返工后的修订落盘版。相对上一轮（仅存于对话文本）的修订：
> ① 落盘至本 run 工作区 `architecture-assessment.md`（blocking issue 1）；
> ② 修正债务 G 的事实错误：`apps/web/src/store.tsx` 实际存在，本轮已实读全文核实（warning issue 2）；
> ③ 修正 web 文件数统计，并对全部规模数字标注核实方法与估算口径（warning issue 3）；
> ④ 补写依赖任务产物 `engineering-overview.md` 至工作区。

---

## 1. 模块分层与主要调用关系

### 1.1 分层结构（server 侧自上而下单向依赖）

```
┌─ 装配层    index.ts（组合根：config→db→registry→seed→启动恢复→fastify→listen）
├─ 传输层    api/routes.ts（REST）· api/ws.ts（WS 事件转发）
├─ 编排层    orchestration/：pipeline.ts（顺序）· supervisor.ts（主管委派）
│            · scheduler.ts（DAG wave 调度）· agentStep.ts（LLM+工具循环，两种模式共用）
│            · reviewStep.ts（审查步）· contextBuilder.ts（上下文组装）· types.ts（Orchestrator 接口）
├─ 领域层    messaging/（inbox·tasks·bus）· tasks/（attempts·reviews）· hitl/approvals
│            · runs/trace · agents/（loader·registry）· workspaces/（external·manager）
├─ 基础设施  db/（database·schema.sql）· llm/（provider·router）· tools/（builtin·mcp）· config.ts
└─ 契约包    packages/shared（8 个领域契约模块，server/web 双端唯一类型来源）
```

**依赖方向健康**：api → orchestration → 领域服务 → db/llm/tools，未见反向依赖或跨层直穿；`@agent-gand/shared` 被两端共同依赖（正确的依赖倒置，杜绝了契约双份定义）。

**前端侧结构（本轮经 main.tsx / App.tsx / store.tsx 实读确认）**：`main.tsx`（createRoot + StoreProvider）→ `store.tsx`（单文件全局状态：useReducer + 判别联合 Action；初始 hydrate 走 REST，增量走 WS 事件；只保留 activeRun 的明细防内存膨胀）→ `App.tsx`（"1+3" 布局壳，视图切换 useState 本地状态）→ 7 个组件 + 4 个视图；services 层 api/ws/notify 三个客户端模块。

### 1.2 关键调用链

**启动恢复链**（index.ts）：`interruptRunningAttempts → recoverInterruptedTasks → resumeSupervisorRun(runId)`——新进程接管中断 run，`activeSchedules` Set 防重入。

**主管模式主链**（supervisor.ts）：`decomposePrompt → chatOnce → parseDecomposition（严格校验+拓扑排序）→ 失败则 fallbackTasks 降级 → createTask×N（blockedBy 关联）→ runTaskSchedule → executeTask（claim→createAttempt→runAgentTurn→审查→transition）→ chatOnce 汇总 → finishRun`。

**agent 执行循环**（agentStep.ts）：`resolveProvider → provider.chat(流式，llm.delta→bus.emit→ws 广播) → toolCalls 逐个权限门控（审批并行创建等全部决策）→ 通过的 Promise.all 并行执行 → 结果以 user 消息回传下一轮 → 无 toolCalls 或达轮数上限（closingCall 收尾）`。

**前端状态链**（store.tsx，本轮新增确认）：`StoreProvider 挂载 → hydrateAll(REST 并行拉 agents/runs/tasks/approvals/usage + 活动明细) → onServerEvent 增量 dispatch → reducer 按 activeRunId 过滤写入 → span endedAt 非空时折叠 streams 流式段落`；断线重连由 `onWsStatus(connected) → hydrateAll` 全量回补。

**数据一致性**：messaging/tasks.ts 的 claim/complete/transition 均在 `tx()`（BEGIN IMMEDIATE）内完成「读-判-写」，`transitionTask` 采用期望状态 CAS 式校验防重复 scheduler tick。

### 1.3 关键设计模式

| 模式 | 落点 |
|---|---|
| 策略模式 | `Orchestrator` 接口 + pipeline/supervisor 双实现，routes 按 mode 选择 |
| Provider 抽象 + 前缀路由工厂 | `LLMProvider` 接口 + Mock/OpenAI/Anthropic 三实现，单例懒建 |
| 观察者（事件总线） | bus.ts subscribe/emit → ws.ts 全量转发 ServerEvent → 前端 store reducer 消费 |
| 状态机 + 悲观锁 | 任务三态+扩展态（needs_revision/awaiting_review），事务内 CAS 转换 |
| 模板方法式复用 | agentStep.runAgentTurn 被 pipeline/supervisor 共用（注释明言"避免两份工具逻辑漂移"） |
| 优雅降级 | 拆解失败→fallbackTasks；SSE 解析容错；流式异常增量不回收 |
| 中断恢复 | 入口恢复序列 + attempt 租约（leaseMs） |
| 前端单向数据流 | 单文件 store：reducer 纯函数 + ServerEvent 判别联合，视图不直接持有服务端状态 |

## 2. 代码规模统计

> 口径说明：以下分三档标注——**【实读】**本轮或上轮读取过全文/大部分；**【import 链】**从已读文件的 import 语句确认存在；**【清单】**仅来自依赖任务清单、本轮未复核。行数为估算值，方法与样本量随附。

| 维度 | 数值 | 核实方法 |
|---|---|---|
| 工作区包 | 4（root + shared + server + web） | 【实读】三个 package.json + pnpm-workspace.yaml |
| server 源文件 | **28 TS + 1 SQL ≈ 29** | 【实读】17 个 +【import 链】其余 11 个交叉点数 |
| shared 源文件 | 8 TS（7 契约 + barrel） | 【实读】 |
| web 源文件 | **15 个 src TS/TSX + vite.config.ts**（上轮口径 ≈13–15 含疑问，本轮修正） | 【实读】3 个（main/App/store）+【import 链】11 个（7 组件 + 4 视图中 TopBar/SideNav/RightPanel/RunView/FleetView/ObserveView/CanvasView 由 App.tsx 确认；api/ws/notify 由 store.tsx 确认）+【清单】1 个（ApprovalCard） |
| agent 定义 / 脚本 | 3 md / 2 mjs | 【实读】 |

**行数（估算，非精确统计）**：

| 范围 | 估算行数 | 方法与样本 |
|---|---|---|
| 已实读文件精确子集 | ≈3,300 行 | 上轮实读 17 个 server/shared 文件可见 ≈3,000 行 + 本轮 3 个 web 文件（main ≈14、App ≈33、store ≈245，合计 ≈292 行） |
| 全仓 TS/TSX 总量 | **≈6,000–7,500 行（中位 ≈6,800）** | 外推法：未读 14 个 server 文件按已读同层文件均值（150–250 行/文件）估 2,100–3,500 行；web 未读 12 个按组件 80–200 行/视图 150–250 行估 1,200–1,800 行；误差 ±20% |

规模定性：**小型工程，模块粒度均匀**，单文件无失控（已知最大 <450 行，store.tsx ≈245 行亦在健康区间）。

## 3. 技术债务与改进点（按影响排序）

**A. 工具结果以 user 消息模拟协议原生 tool 消息（债务链已发酵）**
- 证据：agentStep.ts 文件头与 router.ts 均有 TODO「协议原生 tool 消息（openai role:tool / anthropic tool_result block，当前 user 消息模拟回传）」；runAgentTurn 中占位文案注释自认「真机实证 GLM 会从 transcript 模仿占位句式输出伪调用文本」，为此又加了 `PSEUDO_TOOL_CALL_RE` 正则启发式（agentStep.ts:53 一带）。
- 影响：协议语义偏差已实际引发模型行为异常，当前是「补丁上叠补丁」——正则启发式绑定特定模型行为，换模型即失配。
- 建议：优先实现原生 tool 消息回传，随后可删除伪调用启发式。

**B. scheduler.ts 轮询式调度存在 O(N²)+N+1 查询**
- 证据：`runTaskSchedule` 的 `for(;;)` 每轮 `listTasks(runId)` 调用两次全量查询；失败依赖检测中 `task.blockedBy.map((id) => getTask(id))` 逐条 N+1；wave 推进靠串行循环无事件驱动唤醒。
- 影响：当前 MAX_TASKS=5 可容忍，是隐含的扩展天花板。
- 建议：blocker 状态一次性 `IN` 查询；ready 任务由 task.updated 事件驱动而非轮询。

**C. database.ts import 副作用重 + 双轨 schema 迁移**
- 证据：模块顶层即 `new Database + db.exec(schema) + 迁移`（index.ts 注释自认「import 时自初始化」）；迁移代码存在三种风格并存——workspace 列直写、title/deleted_at 块、`ensureColumns` 通用函数，schema.sql 与代码内 ALTER 需人工保持同步。
- 影响：任何模块 import 即触发建库，测试隔离只能靠换 DB_PATH 规避；两轨漂移风险随增量演进累积。
- 建议：初始化收敛为显式 `initDatabase()` 调用；迁移统一走 ensureColumns 或独立迁移文件。

**D. ws.ts 全量无差别广播 + 无鉴权（自带 TODO）——本轮新增客户端侧佐证**
- 证据：服务端文件头 TODO「心跳保活、鉴权、按 runId 过滤订阅」；实现为 `subscribe((event) => socket.send(...))` 无任何过滤。**本轮实读 store.tsx 进一步证实浪费是真实的**：前端 reducer 对每类事件先判 `e.runId === state.activeRunId`（message/llm.delta/run.event/task.attempt.updated/scheduler.updated 五类均如此），即客户端收下全部 run 的高频 `llm.delta` 增量后，再在本地丢弃非活动 run 的部分。
- 影响：多 run 并发时带宽与服务端序列化开销随连接数×run 数放大；本机任意进程可连接订阅全部事件；无心跳则 stale 连接检测缺失（断线回补目前靠 hydrate 兜底）。
- 建议：订阅握手携带 runId 列表，服务端按订阅过滤后再 send。

**E. 职责过载：runs/trace.ts 与 routes.ts**
- 证据：trace.ts 同时承担 run CRUD（create/list/rename/softDelete/detail/count）+ span 生命周期 + usage 汇总三类关注点（从 routes.ts 的 import 集合可证）；routes.ts 集中全部 REST 端点（读至 230 行未完，估 300+ 行），每端点手写 `typeof` 校验，未用 fastify 原生 JSON schema 能力。
- 影响：仓储与可观测性耦合；校验逻辑重复且无声明式保障。
- 建议：trace.ts 拆 runs 仓储与 trace/usage 两块；路由校验迁 fastify schema。

**F. reviewer 角色靠 `/review/i` 正则推断命名约定**
- 证据：supervisor.ts 的 parseDecomposition 与 fallbackTasks 两处用 `/review/i.test(agent.id)` 推断审查者；agent frontmatter 无显式 role 字段。
- 影响：改名即静默失去审查者推断，属于隐式契约。
- 建议：frontmatter 增加显式 role/flags 字段。

**G.（本轮改写）交接清单对前端状态层的表述漂移 + 评估过程自身的核对教训**
- 上轮表述（「store 三种路径均不存在、结构待确认」）**事实错误**：实为单文件 `apps/web/src/store.tsx`（本轮实读全文核实，main.tsx:4 以 `'./store'` 导入）。上轮仅尝试 `.ts` 后缀与目录形式，漏检 `.tsx` 扩展名。
- 改写后的事实：代码本身**无债务**——store.tsx 是一个质量良好的单文件实现（reducer 纯函数、判别联合 Action、按 activeRunId 过滤、streams 折叠、断线 hydrate 回补，注释直接引用规格条款）；真正的漂移在**交接文档**：依赖任务清单把 store 标注为「store（模块）」暗示目录，且 services 清单漏了 notify.ts。
- 影响：跨任务交接信息与实际结构不一致，会误导后续任务（本次已实际误导一次）。
- 建议：engineering-overview.md 本轮已按实读结果修正该两处标注；后续清单对「目录 vs 单文件」「.ts vs .tsx」应逐项点数确认。

**H. 次要项**：① costUsd 恒记 0（provider.ts TODO「需按模型维护价格表」）——用量面板美元成本失真；② **全仓无单元测试**——根 package.json 仅有 typecheck/verify 脚本，而 `parseDecomposition` 这类已导出的纯函数（字符串输入/确定性输出）是零成本可测对象，当前仅靠 2 个 .mjs 集成脚本覆盖；③ 魔法数散落（MAX_TASKS=5、maxToolRounds=6 附带「P1 支持 frontmatter 配置」TODO、各工具截断长度）。

## 4. 风险点小结

- `POST /api/runs` 中 `void orchestrator.start(...).catch(log)` 异步执行：run 终态依赖编排器内部 finishRun 兜底；若 startSpan 等前置调用抛错，run 可能滞留 running（进程内无 watchdog，仅重启时被恢复序列接住）。
- 综合评价：**架构骨架优秀**（分层清晰、契约集中、并发与恢复设计扎实、防御性编程密度高；本轮补充的前端状态层同样规整），债务集中在**协议适配层的权宜实现**与**可观测性/扩展性的早期简化**，均属可控且多数已被代码内 TODO 显式登记——团队对债务有自觉，这是好信号。

## 5. 验收对照与数据可信度

| 验收标准 | 状态 |
|---|---|
| 1. 分层与调用关系概览 | ✅ §1（分层图 + 5 条关键链路含前端状态链 + 模式清单） |
| 2. 代码规模统计 | ✅ §2（文件数逐项标注核实方法；行数标注估算方法+样本量，实读子集给出精确值） |
| 3. ≥3 个技术债务 + 事实依据 | ✅ §3 给出 8 项（A–H），每项附文件级证据；债务 G 已按本轮实读改写 |

可信度声明：分层/调用关系/债务证据来自两轮共 20 个文件的直接读取（上轮 17 个 server/shared + 本轮 main.tsx/App.tsx/store.tsx）；文件数按「实读 / import 链 / 清单」三档标注；**行数为估算**（工具预算不足以执行 wc 类命令），估算方法与误差（±20%）已随附。本轮已完成工作区落盘：本报告 + 依赖任务产物 engineering-overview.md。
