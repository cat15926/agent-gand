# G1 公共契约、Scope 与输入来源验收

日期：2026-10-14。状态：**G1 完成，新增能力包保持关闭；G2–G6 待实施**。
关联：[实施指导](../plans/scoped-collaboration-implementation-guide.md)、[G0 基线](./scoped-collaboration-g0-acceptance-2026-10-13.md)。
开发基线为 `main@d6abb7abba6cfa789d127ab4372160e56bcb3fda`，包含此前未提交的 G0 文件；本阶段变更尚未提交或推送。

## 交付范围

| 项目 | 实现 |
|---|---|
| 公共类型 | `ExecutionScopeV1`、`ContextManifestV1`、`InputProvenanceV1`、`ScopedCollaborationContract`、独立的 `ScopedControlActionV3` |
| 版本冻结 | Tool API / Control Action v3，`features.scopedCollaboration.boundaryVersion=2`，manifest/provenance v1；要求显式 execute 与 explicit_only 策略 |
| 接收语义 | `material` 仅投递、`acknowledged` 仅确认收件、`result` 要求实质完成；规范确认动作命名为 `agent.acknowledge` / `type=acknowledge`，执行器留待 G2 |
| 持久化 | 新增 scopes、manifests、scope_attempts、input_provenance 四表；禁止 UPDATE/DELETE；Attempt 唯一绑定 Scope，输入序号单调递增 |
| manifest 编译 | 服务端解析明确引用，绑定 Run、资源版本、正文和 ACL 指纹；冻结目标、初始/允许追加输入、工具清单与策略版本 |
| Context | 只读取 manifest 白名单，不扫描房间历史，不回退注入根目标；初始 Context 哈希不随动态输入变化；超出预算拒绝而非隐式截断 |
| 读取检查 | 核对成员、根来源、Subject、当前 holder/generation、Attempt、有效 lease 和资源权限；跨 Run、错绑、过期或漂移均拒绝 |
| 动态输入 | 消息补充和受控文件来自冻结引用；工具/MCP 新结果需已完成且绑定同一 Attempt、Agent 和获准工具的执行账本 |
| 暴露账本 | 在返回字节前原子登记 `possibly_exposed`；登记失败不返回；不复制秘密正文，保留来源、哈希、渠道、序号和判定 |
| 输出检查 | 公共 Action Command 接受 Scope 绑定，事务内核对 ledgerRevision、全部已暴露来源与输出范围；幂等指纹绑定 Scope/Attempt/账本/范围 |
| 会话接口 | 冻结 Scope、manifest 哈希、policy、generation、sessionBoundaryId；当前 `resumeAllowed=false`，原生路径明确拒绝新范围 |
| 能力声明 | 区分 foundationImplemented、implementationSupported、configuredAvailable、connectionVerified、verifiedAt；完整能力包均未开放 |

主要实现：[scopedCollaboration.ts](../../apps/server/src/runtime/scopedCollaboration.ts)、[共享类型](../../packages/shared/src/scopedCollaboration.ts)、[动作命令](../../apps/server/src/runtime/actionCommands.ts)。

新增只读接口 `GET /api/runs/:id/collaboration-capabilities` 返回冻结版本、五种后端的能力声明及空的恢复选项。接口不返回材料正文、manifest 或输入账本。Driver 信息也携带新能力声明；检测到客户端可用不代表新范围能力已实现或实测。

新契约可被读取和验证，但 Scheduler、旧 Context 组装器、旧控制工具和原生会话均阻止其误入既有执行路径。未知动作版本不再回退到 v1；现有 v2 的 consult/handoff/hold/complete 语义不变。

## 迁移与本地服务实际影响

本阶段最终追加两个版本，旧迁移不覆盖：

| 版本 | 内容 | SHA-256 |
|---|---|---|
| v12 | Scope/manifest/Attempt/输入账本基础 | `41db07fd6801da02da567691dc328cf771bd8728cdc643f2147ba1b4961d2207` |
| v13 | Action Command 的 `boundary_fingerprint` 列与幂等边界 | `7effb7f2ad7303324b4b8bb44374d4d8c3eb84f8a2762e4ac6ec6c2c0368bcfa` |

本地日常后端原来运行 `tsx watch src/index.ts`。实施过程中热重载已自动将业务库升级至 v12；随后编辑同一迁移描述导致校验拒绝重启。发现后恢复**已落库的 v12 原始描述与指纹**，将字段变化追加为 v13。没有修改数据库中的旧 checksum、删除迁移记录或回滚业务库。

恢复后 `127.0.0.1:3010/api/health` 返回 `ok=true`、8 个 Agent、83 个 Run。只读核对确认业务库当前至 v13，指纹匹配，命令字段存在，Scope 和输入账本业务记录均为 0。Run 状态数量仍为 completed 65、failed 16、cancelled 1、waiting_for_user 1。

**不能宣称业务库整体未变化**：迁移增加了结构、索引/触发器和版本记录。未向业务房间提交验证任务；未迁移、修复或继续原 Issue 的任务。未测量短暂停机的持续时间，也未对所有业务表作前后逐行一致性证明。

测试增加了已落库 v12 升级 v13 的回归：固定原 v12 指纹，保留旧命令记录及空指纹，拒绝未知 v14。后续新增迁移从 v14 起，实施时仍应重新核对基线。

## 验证结果

测试入口：[verify-scoped-collaboration.mjs](../../scripts/verify-scoped-collaboration.mjs)。该脚本用临时 SQLite、合成消息/文件和隔离 private 目录，直接构造运行中的 v3 存储对象；这是 G1 静态边界验收，不是已经开放的 v3 调度链。

| 检查 | 结果 |
|---|---|
| 相同 audience、相同成员的两个独立事项 | manifest/sessionBoundary 不同，各自 Context 只有白名单材料 |
| 同房间未列出的私密历史、根目标 | 不进入新 Context |
| 补充消息、文件、执行后新产生的工具结果 | 合法来源可追加；初始 Context 哈希不变 |
| 其他 Attempt 的工具结果、未授权工具/材料 | 拒绝 |
| 来源变更、跨 Run、私密根转公开、错误成员/Scope、过期及非法 lease | 拒绝 |
| 账本写入失败 | 无返回字节，序号不增加 |
| 过期 ledgerRevision、私密输入后公开输出 | 动作回调不执行 |
| 事务内新增输入 | 动作与输入一并回滚；合法完成 Subject 的事务可以提交 |
| 相同动作键重放 / 改 Scope 重放 | 相同请求复用原结果；边界变化冲突 |
| 同 Attempt 重组 Context、修改 manifest/删除来源账本 | 重组幂等；持久历史修改拒绝 |
| 未知版本、缺失 v3 策略、未知能力包 | 拒绝；无效契约冻结事务回滚 |
| v3 工具执行、ACK 被当作 complete、旧 Context/原生会话接管 | 拒绝；没有静默降为 v2/v1 |
| HTTP 能力查询 | 五种后端均报告未开放/未实测；不包含合成材料正文 |
| v2 G0 调度复现 | 保持 17 次 mock 调用、0 网络尝试、0 原生执行；拒绝与成功对照均符合原行为 |

通过的命令：

```sh
pnpm typecheck
pnpm verify:scoped-collaboration
pnpm verify:scoped-collaboration-baseline
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-action-commands
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-run-policy
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:message-visibility
pnpm verify:docs
git diff --check
```

动作命令回归覆盖既有跨进程竞态和 SIGKILL；这不代表 G4 的新增能力故障矩阵已经完成。本阶段未调用真实供应商，也未执行 SDK/Codex 的新范围会话。

## 下一阶段的边界

G2 必须把这些基础接到实际模型 API 调度、工具输入/结果路径和预算准入，再交付独立信封、逐项义务、状态投影及唯一的干净父恢复。调用方不得绕过 Scope 的读取/输出入口；工具返回需有可追踪的执行账本，无法表示来源的返回禁止进入模型。

G1 不提供材料 UI、可执行的 consult_batch/acknowledge、专用发布审批或原生会话恢复。新工具名称和接收语义已冻结，但解析、原子投递和 ACK 义务执行在 G2 完成后才能启用。当前狼人杀及其他连续私密咨询的阻断仍保留，不能用本阶段通过作为业务流程已修复的证明。
