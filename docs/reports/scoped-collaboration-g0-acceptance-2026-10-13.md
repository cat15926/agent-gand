# G0 基线与私密协作阻断验收记录

日期：2026-10-13。状态：**G0 完成；G1–G6 待实施**。
关联：[实施指导](../plans/scoped-collaboration-implementation-guide.md)、[Issue #15](https://github.com/cat15926/agent-gand/issues/15)、[先前分析](./issue-15-private-consultation-analysis-2026-10-13.md)。

本阶段把函数级复现扩展为仓库内的真实调度集成测试，固化现有 v2 行为。没有修改生产调度器、权限规则、数据库迁移或 UI；连续私密咨询的产品能力仍待 G1/G2 实现。

## 1. 开发和本机验收基线

| 项目 | 实际核对结果 |
|---|---|
| 源码 | `/Users/ruhonglin/lhz/agent-gand`，分支 `main` |
| 已提交基线 | `d6abb7abba6cfa789d127ab4372160e56bcb3fda` |
| 开始时工作区 | `docs/README.md` 已修改；实施指导和先前分析报告尚未跟踪，均予以保留 |
| G0 新增变更 | 隔离验证脚本、package 命令、本报告及文档状态更新；未提交或推送 |
| 锁文件 SHA-256 | `789e526fb1e2650c8096f31342824d4dc94b9dfe216840281f751c1b384e3afe`，本阶段未改依赖 |
| Node / pnpm | `v22.23.1` / `9.15.4` |
| 已安装 Claude Agent SDK | `0.3.288`，读取安装包版本；没有调用模型 |
| Codex 客户端 | `codex-cli 0.159.2`，仅版本检查 |
| 数据库迁移 | 源码、业务库和新建隔离库均至 v11；未新增迁移 |
| 当前协作契约 | Runtime Contract v1；Control Action v2 / Tool API v2；messageVisibility v1；durableHold v2 |
| 后端进程 | PID `86810`，cwd 为项目 `apps/server`，监听 `127.0.0.1:3010` |
| 前端进程 | PID `86874`，cwd 为项目 `apps/web`，监听 `[::1]:5173` |
| 后端实际打开的库 | 项目 `apps/server/data/agent-gand.sqlite`，包含该路径的 WAL/SHM |
| 本机健康检查 | `/api/health` 返回 `ok=true`、8 个 Agent、83 个 Run；MCP 未配置 |

进程和健康状态仅代表本次检查时刻。本机服务保持运行，没有重启或将测试任务提交到日常房间。进程目录和打开文件经只读检查；下述配置摘要来自当前源码加载 `apps/server/.env` 后的配置，未对运行进程内存作配置转储。

非敏感配置：新入口为 `execute`，旧格式准入仍开启；Collaboration 和 Coordination kernel 为 `execute`。每次最多 3 个咨询目标，默认并发 3、深度 12、Dispatch 上限 20、Attempt 上限 2，单 Run token 上限 100,000、费用上限 5 美元。原生工作区采用 `isolated`；默认会话策略为 `turn`，显式复用按账户、角色、模型、运行范围及信息边界绑定，当前尚无拟新增的 Scope/manifest 身份。

### 当前能力盘点

以下为代码声明和本阶段验证范围，不能当作所有后端本次均通过真实供应商验收。

| 路径 | 当前能力 | G0 证据 / 未交付项 |
|---|---|---|
| 模型 API / builtin-llm | v2 控制工具、私密消息、真实命令提交、完成验收、Hold 恢复 | 用 mock Provider 跑实际 Scheduler；私密汇总后跨范围咨询仍拒绝 |
| Claude SDK 0.3.288 | Driver 声明 Runtime 控制、原生审批；readonly/confirm/auto | 本阶段只核对源码和版本；未做真实调用、新范围会话验收 |
| Codex app-server 0.159.2 | Runtime 控制、原生审批；readonly/confirm；限定协议版本 | 本阶段只核对源码和版本；未做登录或模型调用 |
| Claude CLI / Codex exec | 只读执行；能力声明不支持 Runtime 控制 | 不承诺动态咨询链；本阶段未启动 CLI 任务 |
| R7 冻结阶段调度 | 预设分工、依赖和成员范围 | 不能替代动态 Collaboration 的干净父恢复 |
| Scope / 输入 manifest / 独立信封 | 本指导的新增设计 | G1/G2 待实施 |
| 状态回流 / 专用发布批准 | 本指导的新增设计 | G2/G3 待实施；普通 answer 不等于发布许可 |

## 2. 可重复的隔离验证

仓库入口：[verify-scoped-collaboration-baseline.mjs](../../scripts/verify-scoped-collaboration-baseline.mjs)。

```sh
pnpm verify:scoped-collaboration-baseline
```

脚本用合成 C/A/B 成员及 mock 模型，从 `createConversation`、`createRun`、`admitCollaborationRun` 开始。模型桩仅返回控制工具调用；实际生产代码负责领取 Attempt、组装 Context、校验控制参数、提交 Action Command、验收 complete、汇总 Batch、持久化 Hold、恢复 Dispatch 及处理 decision。

没有直接播种已完成的子任务或汇总结果，没有伪造定时到期时间。timer 使用真实的一秒等待与 `recoverDurableHolds` 扫描；answer 使用 `resolveCollaborationDecision` 的正常领域入口。该测试不经过 HTTP 路由、浏览器或原生 SDK/CLI，不代表这些入口的端到端验收。

隔离措施：

- `AGENT_GAND_ISOLATED_WORKER=1` 禁止加载日常 `.env`，清除模型、账户、协作和外部驱动相关环境覆盖。
- 临时 SQLite、角色目录、private、data、sandbox、原生 home 和 workspace 全部位于临时根目录；检查实际配置路径，不依赖无效的 `SANDBOX_DIR` 覆盖。
- 仅注册无业务工具、无账户引用的内部 mock 角色；外部命令指向临时目录中不存在的可执行文件。
- 同时拦截全局 fetch 与 Provider 所用 undici dispatcher；出站计数必须为 0，原生执行账本必须为空。
- 无端口监听；退出时取消未完隔离任务、关闭库和清除临时文件，并断言目录已删除。

## 3. 实测结果

下表中的“通过”表示现有边界行为被正确复现，并不表示产品阻断已修复。

| 场景 | 实际断言 | 结果 |
|---|---|---|
| C 公开起步，私密咨询 A | initial Context 为 public；问题及 A Attempt 范围为 C/A/user；A complete 经真实完成验收 accepted | 通过 |
| A 完成后 C 汇总 | 汇总来源及 C Attempt 范围收窄到 C/user，正文包含合成 A 结果 | 通过 |
| 继续咨询 B | 生产控制解析器返回目标不在私密范围内；没有 B Dispatch，也没有第二条咨询命令 | 通过 |
| 改写 objective 后再次咨询 B | 即使强调独立材料、不引用其他成员，仍被拒；一轮纠偏后 aggregate blocked，Run failed | 通过 |
| timer 后再咨询 B | timer 到期后真实 wake/resume；来源仍为冻结恢复消息，Context 仍为 C/user；B 仍拒绝 | 通过 |
| 普通用户回答后再咨询 A | answer 文案含“允许向所有成员公开”，但回答和恢复 Context 仍是 C/user；A 也拒绝，没有重跑 | 通过 |
| 重复回答和恢复扫描 | 未增加命令或重复恢复；共两个 wake/resume，对应 timer 和 user_decision | 通过 |
| B 可见消息 | 不包含合成 A 私密结果标记 | 通过 |
| 公开咨询成功对照 | 新的公开 Run 依次咨询 A、B，完成两次汇总并正常 completed | 通过 |
| 保留 A 权限的辅助反事实 | parser 输入范围改为 C/A/user 后，B 仍拒绝；仅取消汇总收窄不够 | 通过，函数级辅助断言 |

首次拒绝位于 [controlTools.ts](../../apps/server/src/collaboration/controlTools.ts) 的 `validateRecipientAccess`，发生在后继咨询命令提交之前。错误为：“私密来源不在目标成员的可见范围内，即使再次声明 private 也不能扩大授权”。

三组实际调度的稳定输出如下（状态在清理前采集）：

| 场景 | Dispatch 数 | Action Command 顺序 | 桩调用数 | Run 状态 |
|---|---:|---|---:|---|
| private-rewrite | 3 | consult_all → complete | 4 | failed |
| private-timer-answer | 5 | consult_all → complete → hold → wake → hold → wake → hold | 8 | waiting_for_user |
| public-control | 5 | consult_all → complete → consult_all → complete → complete | 5 | completed |

合计 **17 次 mock 调用、0 次网络尝试、0 条原生执行记录**。等待场景生成 3 个 Hold：timer 和首个 user_decision 已 resumed，末个 user_decision 在采集时 open；有 2 条 WakeEvent。最终由测试清理尚未结束的隔离任务。

### 独立列出的新增预期

| 新契约预期 | 实施阶段 | 当前状态 |
|---|---|---|
| A 私密完成后，父级仅凭获准状态继续向 B 投递独立材料 | G1/G2 | 未实现，不计为测试通过 |
| B 的 Context/文件/日志/会话不含 A 原始内容，同时协作可继续 | G2/G5 | 尚无完整跨后端证据 |
| 有权限的正文处理与专用信息发布审批 | G3 | 未实现；不得放宽 v2 拒绝断言代替实现 |
| 崩溃、Stop、并发提交、未知外部副作用的新增能力矩阵 | G4 | 未运行；本次重复扫描不代表该矩阵通过 |
| SDK/Codex/Coordination 新能力及真实业务 UI 验收 | G5/G6 | 未运行 |

## 4. 回归、业务库与证据限制

本次通过的检查（G0 最终脚本在两个独立进程中重跑，结构化输出完全一致）：

```sh
pnpm verify:scoped-collaboration-baseline
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:message-visibility
node --check scripts/verify-scoped-collaboration-baseline.mjs
pnpm verify:docs
git diff --check
```

现有 message-visibility 脚本经审阅后运行：使用其临时 SQLite/角色目录，验证历史消息兼容、Context/证据边界、会话边界及排队超时；排队超时在模型调用前返回。未运行整套真实后端验收或生产 API 压测。G2 开始前应针对届时确定的新增 API 固定性能采样口径；本阶段的调度命令数/调用数可用于后续比较，不是 HTTP P95 数据。

业务库在 G0 验证前后均只读打开，以 `better-sqlite3` 的 `serialize()` 取得一致性快照并计算 SHA-256；两次均为：

```text
fdb293bb6564204d27525f7de7dc8950fb54b604a0046535721115a564876d30
```

Run 数量和状态均未变化：completed 65、failed 16、cancelled 1、waiting_for_user 1，共 83；迁移版本仍为 11。证据记录的是逻辑 SQLite 快照相同，不要求 WAL 文件布局相同。

原 Issue Run `f5f6e3b2-b660-4f4e-bdaf-557472f91d76` 不存在于本机业务库。原 Windows 源码包、部署和四次拒绝时间线未独立复验；本报告不能代表原现场的完整复现。临时日志及前后只读摘要在本次主机 `/tmp/agent-gand-g0-*`，可随系统清理；持久证据为本报告和可重复运行的仓库脚本，不依赖临时文件。

## 5. 下一入口

进入 **G1：公共契约、Scope 与输入来源**。新增功能默认关闭，先冻结版本/能力声明、独立输入来源和读取/输出边界，并继续保留本阶段 v2 回归；随后 G2 才交付连续独立咨询与干净父恢复。
