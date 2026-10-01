# Runtime 执行权与终局一致性实施指导

> 状态：实施中；阶段 1–5 已完成，下一步为阶段 6 Agent API v2  
> 基线：2026-09-29，`agent-gand/main` @ `90ccd01d08fbad7882e2a9662071dd581c36178c`  
> 前置成果：[Collaboration Runtime Kernel 实施方案](./collaboration-runtime-kernel-implementation-plan.md)、[Runtime v2 责任闭环实施指导](./runtime-v2-responsibility-closure-implementation-guide.md)  
> 适用范围：Collaboration、Coordination 及后续复用公共 Runtime 的编排入口

## 1. 文档目的

上一阶段已经完成 Runtime Contract、Subject、Custody、CompletionCandidate、类型化义务、EvidenceBundle、Context Contributor、Durable Hold/Wake 和 Coordination Adapter 的第一轮实现。本阶段不再增加另一套调度器，而是收紧已有组件之间的执行权、责任读取、事务和恢复边界。

本阶段的目标是让以下闭环在 Collaboration 和 Coordination 中具有一致语义：

```text
新 Run 入场
  → 冻结执行策略和组件版本
  → Agent/Protocol 产生规范动作或完成候选
  → Runtime 读取同一份责任与阻断事实
  → 原子提交动作、等待或完成结果
  → Completion Engine 决定 Subject/Run 终态
  → 唯一一次提交最终报告和终局状态
```

完成后必须满足：环境变量只决定新 Run 如何入场，已经入场的 Run 始终按照冻结契约执行；重启、并发 Stop、迟到 Attempt 和恢复扫描不能改变这一事实。

## 2. 基线核对与问题定义

### 2.1 已确认的源码事实

| 事实 | 当前风险 | 本阶段处置 |
| --- | --- | --- |
| `collaboration/scheduler.ts`、`store.ts`、`decisions.ts` 在执行阶段继续读取 `runtimeAtomic`、`runtimeShadow`、`completionEngine` | 同一个 Run 在进程配置变化后可能进入不同执行分支 | 冻结 Run Policy，并建立唯一解析入口 |
| Collaboration Contract 记录了组件版本，但没有明确记录 shadow、atomic compatibility 和 execute 的完整入场策略 | 不能只凭 `completionCandidateVersion` 判断历史 Run 的执行权 | 冻结 Admission Profile 及其三个正交维度 |
| ExitGuard 主要读取 Attempt、Dispatch target 和 child Dispatch；Completion 读取 Custody、generation 和 typed obligations | 同一状态可能得到不同的退出或完成结论 | 建立公共 Responsibility Snapshot 和 Blocker Projection |
| Context 只显示 `status='open'` 的义务，Completion 将所有必需且非 `satisfied` 的义务视为阻断 | failed/cancelled 义务可能在提示中消失，但仍阻止完成 | Context、ExitGuard、Completion 和 UI 共用阻断口径 |
| `finishRun()` 无终态条件更新；最终报告、Run 状态、Hold 关闭可分开提交 | Complete、Finalize、Stop 竞争时可能覆盖终态或产生状态/报告不一致 | 新增 `commitRunTerminal()` 和终态 CAS |
| Hold 的 deadline 主要用于排序；恢复异常通常把 claim 重新置为 open | 永久失效 Hold 可能反复扫描，事件或依赖等待可能永久悬挂 | Hold v2、错误分类、退避和超时策略 |
| Capsule 仍使用字符串表达后继义务；工具名称仍偏调度实现；`consult(any)` 未闭环 | 能力已经存在于底层，但尚未形成稳定 Agent API | P1/P2 分阶段开放，不阻塞 P0 收口 |

### 2.2 当前已有保护

下列能力继续复用，不重复建设：

- SQLite `BEGIN IMMEDIATE` 事务和嵌套事务复用；
- `afterCommit()` 事件延迟发送；
- 稳定 `clientMessageId` 与消息唯一索引；
- ControlAction v2、same-turn correction 和 CompletionCandidate；
- Custody generation fencing、ToolExecution Ledger 和故障注入子进程；
- typed obligations、EvidenceBundle、Context Contributor 和 Durable Hold；
- Coordination Plan、Revision、DAG 和 Adapter。

基线核对时，下列现有验证已通过：

- `pnpm verify:runtime-completion-integration`
- `pnpm verify:runtime-durable-holds`
- `pnpm verify:runtime-crash`
- `pnpm verify:docs`

这些结果证明现有路径的基本能力可用，不代表本指导新增的混合版本、原子终局和永久错误场景已经覆盖。

## 3. 目标边界与不变量

### 3.1 本阶段要做

1. 冻结每个 Run 的执行权、Runtime 状态模式、事务能力和工具版本。
2. 统一 ExitGuard、Completion、Context 和 UI 的责任及阻断事实。
3. 将 Run 终态、最终报告和关联 Runtime 关闭动作收口为一个提交单元。
4. 将 handoff、consult、hold、complete、wake 渐进迁移到公共命令边界。
5. 补齐 Hold 超时、永久失效、暂时错误退避和恢复审计。
6. 完成混合版本、跨进程崩溃和竞态验收后，再让新的 Collaboration Run 默认 execute。

### 3.2 本阶段不做

- 不引入第二套调度器、向量库、Blob Store 或通用消息队列。
- 不从聊天正文推断或回填历史 Run 的 Custody。
- 不在运行中修改已冻结 Run 的执行策略。
- 不让 Agent 直接写 Subject 或 Run 终态。
- 不承诺外部工具端到端 exactly-once；无幂等键或查询能力的未知副作用继续进入人工处置。
- P0 完成前不开放 `consult(any)`，不向模型暴露尚无可靠事件源的通用 event hold。

### 3.3 必须保持的不变量

1. 每个 Run/Contract Revision 只有一个冻结的执行策略；进程环境只能影响新 Run 入场。
2. 单持有 Subject 的同一 generation 至多一个有效提交者；相同 agentId 不能绕过 Attempt、lease 和 generation 校验。
3. Agent `complete`、普通正文和 Protocol 输出都只是完成候选；只有 Runtime 能提交 Subject/Run 终态。
4. execute Run 不存在“没有开放 Dispatch 即完成”的旁路。
5. 必需义务的 `failed/cancelled` 不等于 `satisfied`；部分接受必须经过明确授权。
6. `owned/transferring/waiting` 责任必须关联有效 Attempt、后继执行载体、Hold 或明确人工处置原因。
7. Run 终态、终局 disposition、最终报告和应关闭的 Hold/义务必须作为一个提交单元。
8. 终态只能从非终态经一次 CAS 进入；迟到 Complete、Finalize、Wake 或 Stop 不能覆盖已有终态。
9. 恢复扫描可以重复执行，但不能重复完成责任、重复创建后继工作、重复发布最终报告或盲目重放未知副作用。
10. Context、ExitGuard、Completion 和 UI 对同一阻断事实使用相同 reason code 与引用。

## 4. 目标架构

### 4.1 Admission Profile 与冻结策略

`legacy/shadow/atomic_compat/execute` 是部署和入场 Profile，不应直接作为单一“执行权枚举”。冻结策略需要把三个正交维度分开：

```ts
type RuntimeAuthority = 'legacy' | 'runtime';
type RuntimeStateMode = 'off' | 'shadow' | 'authoritative';
type RuntimeAtomicity = 'legacy' | 'custody_v1' | 'commands_v1';

interface RuntimeExecutionPolicyV1 {
  policyVersion: 1;
  profile: 'legacy' | 'shadow' | 'atomic_compat' | 'execute';
  authority: RuntimeAuthority;
  runtimeStateMode: RuntimeStateMode;
  atomicity: RuntimeAtomicity;
  toolApiVersion: 1 | 2;
  implicitAnswerPolicy: 'initial_and_consultation' | 'explicit_only';
}
```

Profile 到冻结策略的标准映射：

| Profile | authority | runtimeStateMode | atomicity | 用途 |
| --- | --- | --- | --- | --- |
| `legacy` | legacy | off | legacy | 历史执行路径 |
| `shadow` | legacy | shadow | legacy | 同一输出和快照上的纯判定对比 |
| `atomic_compat` | legacy | authoritative | custody_v1 | 兼容已有原子 Custody/Candidate，但旧路径仍拥有 Run 终局权 |
| `execute` | runtime | authoritative | commands_v1 | Runtime 拥有责任与完成权 |

新增 `runtime/runPolicy.ts`，负责：

- 解析和校验冻结 Contract；
- 区分合法历史缺省、损坏 JSON、未知版本和能力缺失；
- 校验 Profile 与组件版本依赖；
- 向 scheduler、store、decisions、recovery 和 adapters 提供同一读取入口；
- 在 worker claim 前判断当前二进制是否支持该 Run；
- 仅在新 Run admission 时读取旧环境变量或新的统一 admission mode。

除 admission 兼容适配器外，业务模块不得直接读取 `COLLAB_RUNTIME_SHADOW`、`COLLAB_RUNTIME_ATOMIC`、`COLLAB_COMPLETION_ENGINE`。

### 4.2 公共 Responsibility Snapshot

新增 `runtime/responsibilitySnapshot.ts`。它是同步读取模型，不新增异步维护的真相表。

最小结构：

```ts
interface ResponsibilitySnapshot {
  runId: string;
  contractRevision: number | null;
  subjectId: string;
  subjectStatus: string;
  custody: {
    state: string;
    holderAgentId: string | null;
    pendingHolderAgentId: string | null;
    generation: number;
    rowVersion: number;
  };
  attempt: {
    id: string;
    actorId: string;
    generation: number;
    status: string;
    leaseValid: boolean;
  } | null;
  requiredObligations: Array<{
    id: string;
    generation: number;
    kind: string;
    status: 'open' | 'satisfied' | 'failed' | 'cancelled';
  }>;
  openHoldIds: string[];
  completionBlockers: Array<{ code: string; refId?: string }>;
}
```

使用规则：

- Collaboration Adapter 根据 Dispatch/Attempt 映射 Subject；
- Coordination Adapter 根据 Plan/Revision/Step/Attempt 映射 Subject；
- ExitGuard 使用快照决定是否允许退出、等待或要求纠偏；
- Context 以 blocker projection 展示 pending、failed、cancelled 和人工处置原因；
- SubjectCompletion 在最终提交事务内重新加载快照，不能信任模型调用前的旧快照；
- UI 使用相同 reason code 和引用，避免前后端对完成状态给出相反解释。

### 4.3 公共命令与提交边界

新增或渐进抽取 `runtime/commands.ts`。每个命令至少携带：

- `runId`
- `subjectId`
- `attemptId`
- `expectedGeneration`
- 稳定 `commandKey`
- 规范化且已校验的 payload

命令事务必须执行：

1. 读取冻结策略和最新责任快照。
2. 校验 Run 非终态、Attempt/lease、holder 和 generation。
3. 校验幂等键；同键同 payload 返回已提交结果，同键不同 payload 报冲突。
4. 原子更新领域状态和对应执行载体。
5. 写入持久化审计引用。
6. commit 后再发送 WebSocket 事件或唤醒调度。

LLM 调用、外部网络工具和非受控文件 IO 不进入 SQLite 写事务。

### 4.4 Run 终局提交

新增 `commitRunTerminal()`，由 Collaboration 和 Coordination Adapter 调用。终局 disposition 至少包括：

- `accepted`
- `authorized_partial`
- `delegated`
- `failed`
- `cancelled`

同一事务内完成：

1. 读取冻结 Policy 和最终 Completion Snapshot。
2. 重新执行 Completion 判定。
3. 使用 `WHERE status IN (...)` 或 row version 执行终态 CAS。
4. CAS 成功后写入最终报告、disposition 和 Completion Evaluation。
5. 关闭应关闭的 Hold、义务和执行载体。
6. commit 后发送 Run、Message 和 Runtime 更新事件。

若 CAS 未成功，调用方读取已存在的终态并返回，不再写报告或覆盖状态。已有 `runtime:completion:<runId>` 稳定消息键继续作为幂等保护，但不能替代事务一致性。

### 4.5 Hold v2

Hold v2 明确区分：

- `wakeAt`：timer 正常满足的时间；
- `timeoutAt`：外部等待最大截止时间；
- `onTimeout`：失败、需要人工处理或以超时结果恢复；
- `retryCount/nextRetryAt`：暂时恢复错误的持久化退避；
- `failureClass`：永久失效、暂时失败、并发丢失或 Run 已终态。

错误处置：

| 情况 | 处理 |
| --- | --- |
| Run 已终态 | 取消开放 Hold，迟到事件仅保留审计 |
| holder/generation 过期 | 永久关闭旧 Hold，resolution=`stale_generation` |
| claim token 已被接管 | 当前 worker 放弃，不释放其他 worker 的 claim |
| 暂时 DB/恢复错误 | 增加 retryCount，按 nextRetryAt 退避 |
| 依赖已失败且无法满足 | 按冻结策略失败或转人工处置 |
| 超过 timeoutAt | 执行冻结的 onTimeout，不伪装成正常唤醒 |

扫描器同时发现“可唤醒”和“应超时/永久关闭”的 Hold，不能只检查已有 WakeEvent 的记录。

## 5. P0 实施阶段

### 阶段 1：冻结执行策略

交付：

- 扩展 `RuntimeRunContract`，冻结 `RuntimeExecutionPolicyV1`。
- 新增 `runtime/runPolicy.ts` 和统一 parser。
- Admission 原子写入 Run 状态、Contract、Subject 和初始 Dispatch。
- scheduler/store/decisions/recovery/adapters 改为读取 Run Policy。
- 加入静态检查，禁止 admission 外直接读取 Collaboration 三个语义开关。
- Coordination Plan Revision 继承原 Run 的执行策略，只改变图和 required steps。

验收：

- legacy、shadow、atomic_compat、execute Run 混合存在时，重启并改变环境变量仍保持原语义。
- execute Run 在新进程关闭旧 completion 开关后仍由 Completion Engine 决定终局。
- legacy Run 不因新默认值访问不存在的 Subject/Candidate。
- 损坏 Contract、未知 policyVersion 和缺失必要 feature 会阻止 claim 并留下明确原因。

### 阶段 2：统一责任与阻断口径

交付：

- 新增 [Responsibility Snapshot 和 Completion Blocker Projection](../architecture/runtime-responsibility-snapshot.md)。
- ExitGuard 不再以 child Dispatch 数量代替 typed obligations。
- Context 展示所有必需未满足义务，并区分 pending/failed/cancelled。
- Completion 使用同一快照语义，但在提交事务内重新加载。
- UI/API 暴露同一 blocker code 和引用。
- 区分“只需补控制动作”“需要补实际工作”“等待外部条件”“责任已失效”。

验收：

- 没有 child Dispatch 但存在必需 review obligation 时仍阻止完成。
- 必需义务 failed/cancelled 时 Context 与 Completion 给出相同阻断原因。
- 非必需 consultation 不因 child 数量阻塞父 Subject。
- 相同 agentId 的旧 Attempt 在 generation 更新后仍不能提交。
- initial/fanout 只有在冻结策略、协议门禁、责任、义务和证据均允许时才能走 implicit answer。

### 阶段 3A：原子终局（已完成）

先单独实施 `commitRunTerminal()`，不要与全部动作迁移合并。

交付：

- 新增 [Runtime 原子终局](../architecture/runtime-atomic-terminal.md) 作为事务、兼容和故障恢复边界说明。
- 终态 CAS 和明确的并发胜负规则。
- Completion Snapshot、Evaluation、最终报告、Run 状态、disposition 和 Runtime 关闭动作同事务提交。
- execute 路径禁止直接调用低层 `finishRun()`；保留 legacy/Supervisor 兼容名单。
- Stop、Finalize 和恢复入口统一调用终局命令或兼容适配器。

验收：

- Complete、两个 Finalize 与用户 Stop 竞争时只产生一个终态。
- 最终报告至多一份，且其 disposition 与 Run 一致。
- 报告写入或 Run 更新中间 SIGKILL 后，数据库只出现事务前或事务后完整状态。
- 回滚不发送描述未提交状态的通知。

### 阶段 3B：公共动作命令（已完成）

按 `complete → wake → hold → handoff → consult(all)` 的顺序迁移，先覆盖风险最高且边界最明确的动作。

实现说明见 [Runtime 公共动作命令](../architecture/runtime-action-commands.md)。命令层以稳定 `commandKey`、`BEGIN IMMEDIATE` 和持久化结果账本统一控制重复提交；模型调用和外部工具调用仍位于命令事务之外。

| 动作 | 同一事务内保持一致的状态 |
| --- | --- |
| complete | Candidate、EvidenceBundle、Subject/Custody、Attempt、义务结算 |
| wake | claim token、恢复载体、映射、Hold resumed、责任关联 |
| hold | Attempt 动作、Custody waiting、Hold、Decision/订阅关联 |
| handoff | Attempt、Custody transferring、接球义务、目标 Dispatch、映射、Capsule |
| consult(all) | 父等待状态、Batch、子 Subjects/Dispatches、consult_result obligations |

验收：动作事务前后注入 SIGKILL；两个进程提交同一命令时只有一个后继工作和一条有效领域转换。

### 阶段 4：Hold 恢复闭环（已完成）

交付：

- Hold schema/capability v2 和 v1 兼容读取。
- wakeAt、timeoutAt、onTimeout、retryCount、nextRetryAt。
- 类型化恢复错误和永久关闭路径。
- dependency failed、event never arrives、Stop/Wake、claim lease 竞争的结案语义。
- 责任恢复审计，记录 run/subject/generation/hold/reason。

验收：永久错误不会反复入队；关闭旧 generation Hold 不满足新义务；临时错误退避后可恢复；事件接收时间与超时边界具有确定规则。

实现说明见 [Runtime Durable Hold/Wake](../architecture/runtime-durable-hold-wake.md)。新 Run 冻结 `durableHoldVersion=2`，v1 行由同一读取器兼容；恢复审计通过 REST/WS/右侧面板可见。专项命令 `pnpm verify:runtime-hold-recovery-v2` 覆盖超时边界、永久/临时错误、代际隔离、Stop/Wake 与跨进程 claim 竞争。

### 阶段 5：混合版本验收与 Collaboration 默认接管（已完成）

Coordination 当前已默认 execute，本阶段的默认切换只针对新的 Collaboration Run。

发布顺序：

1. 确定性 mock、进程故障和混合版本测试。
2. Shadow 对比：对同一输出和快照运行纯判定，不产生第二次模型调用、工具调用或 Dispatch。
3. 指定测试会话进入 execute。
4. 扩大到 handoff、consult(all)、审批和恢复场景。
5. 全部新 Collaboration Run 默认 execute。
6. 排空存量后再移除 atomic_compat/legacy 执行分支。

回退只停止新的 execute 入场。已冻结为 execute 的 Run 必须由兼容 worker 排空；不得通过关闭进程开关使其落回 legacy finalization。

实现说明见 [Collaboration Runtime 默认接管与回退](../architecture/runtime-collaboration-default-takeover.md)。未显式配置时，新 Collaboration Run 默认冻结为 `execute`；显式 `COLLAB_RUNTIME_MODE=legacy` 仅回退后续新 Run。新增 Shadow Comparison 审计账本，对同一输出和判定前 Responsibility Snapshot 记录 `match/runtime_stricter/runtime_looser/projection_only/observer_error`，并通过 REST、WS 和右侧面板展示。专项命令 `pnpm verify:runtime-default-takeover` 覆盖混合进程读取、回退隔离、分类、幂等及无第二次 Dispatch/消息/工具执行；四 Profile Collaboration E2E 与 Coordination 审批恢复、review_revision 回归通过。

## 6. P1 能力建设

### 阶段 6：Agent API v2

按冻结 `toolApiVersion` 暴露工具：

| 新工具 | 领域语义 | 旧名称兼容 |
| --- | --- | --- |
| `agent.complete` | 提交完成候选 | 保留原名 |
| `agent.handoff` | 转移同一 Subject 的责任 | `send_message` |
| `agent.consult` | 创建子工作，父责任保留 | `ask_many` |
| `agent.hold` | 等待具备恢复条件的事项 | `wait_for_user` |

旧 checkpoint 继续解析旧名称；新 Run 的模型默认只看到一套词汇。模型只填写目标和意图参数，subjectId、generation、obligationId、claimToken 和 commandKey 由 Runtime 生成或校验。

### 阶段 7：Capsule 引用与关键 Context 预算

Capsule 增加独立 `schemaVersion`，保留现有 `version` 作为内容修订序号：

```ts
interface HandoffCapsuleV2 {
  schemaVersion: 2;
  version: number;
  successorObligationRefs: Array<{
    obligationId: string;
    generation: number;
  }>;
}
```

Runtime 在 handoff 命令事务中创建义务并写入引用；模型不能编造 ID。旧字符串只作为说明文字，不自动翻译成机器状态。

Context 为当前目标、holder/generation、允许动作、完成阻断项和最近拒绝原因保留受保护预算。聊天与证据使用剩余预算，不能静默截断关键 JSON 或义务引用。

### 阶段 8：外部等待最小闭环

开放顺序：timer → 同 Run dependency → 已注册外部 event。approval 和 lease recovery 继续由系统触发。

外部事件必须具有：可信接收器、作用域、correlation/generation、来源事件 ID 去重、event-before-hold 匹配、payload 校验和超时策略。没有真实事件源时只开放 timer/dependency，不向模型暴露空壳 event tool。

## 7. P2 扩展与清理

### 阶段 9：consult(any)

定义为“首个通过 SubjectCompletion 的成功候选”。至少实现：

- Batch 冻结 joinPolicy、winner、settledAt 和 generation；
- 并发成功时用 CAS 选择一个 winner；
- 父级只生成一个 aggregate；
- 取消未胜出 queued 工作，协作中止 running 工作；
- 迟到结果不能改变 winner；
- 以显式 join resolution 结算未胜出义务；
- 全失败、超时、Stop 和 crash 重放具有确定结果。

第一版不实现 quorum。

### 阶段 10：进展指纹与兼容清理

- 用 ProgressDigest 区分“新增证据记录”和“实际新进展”。
- 排除重复只读结果、普通日志和时间戳噪声。
- 存量排空后停止向模型暴露旧 alias，删除 legacy finalization 和 atomic_compat 执行分支。
- 保留历史读取与版本解释。
- 文档统一使用“已编码、已测试、灰度中、默认启用、已弃用”状态。

## 8. 历史 Run 与迁移策略

| 存量情况 | 处理 |
| --- | --- |
| Contract 或可信 admission 记录能明确证明 Profile | 固定为对应兼容策略，继续排空 |
| completionEngine=true 且执行记录一致 | 校验后归入 execute 兼容路径 |
| 相同 feature 组合可能来自 shadow 或 atomic | 使用原部署配置/admission 记录识别 |
| 活跃 Run 无法可靠识别 | 暂停 claim，记录待处理原因；不得按当前环境猜测 |
| 已终态历史 Run | 只读保留，不重新执行，不推导缺失 Custody |

优先让有歧义的活跃 Run 在原版本排空。只有必须让长等待 Run 跨版本恢复，且存在可靠来源证据时，才增加 `runtime_execution_bindings`。该表是一次性兼容绑定，不得成为第二个可变执行权来源。

数据库变更仅做增量迁移；旧 Contract、Hold 和 Capsule 必须保留兼容读取，不原地改写历史 payload。

## 9. 验收矩阵

| 编号 | 场景 | 类型 | 必须断言 |
| --- | --- | --- | --- |
| T01 | execute Run 重启后关闭旧开关 | 新增 | authority 和 Candidate/Completion 仍有效 |
| T02 | legacy Run 重启后默认 execute | 新增 | 不假定 Runtime Subject，不改变旧完成语义 |
| T03 | shadow/atomic 历史特征相同 | 新增 | 可靠绑定或明确阻断，不猜测 |
| T04 | 无 child 但有必需 review obligation | 新增 | ExitGuard 不允许完成 |
| T05 | 必需 obligation failed/cancelled | 新增 | Context/UI/Completion 显示相同阻断 |
| T06 | 同 agent 的旧/新 Attempt | 扩展 atomic/crash | 旧 generation/lease 不能提交 |
| T07 | 仅缺 disposition | 扩展 ExitGuard | 只补控制动作，不重复普通工具 |
| T08 | 缺产物/依赖未就绪 | 新增 | 分别进入工作重试/等待 |
| T09 | 动作提交中 SIGKILL | 新增 | 只有事务前或事务后完整状态 |
| T10 | Complete/Stop/Finalize 竞争 | 扩展 completion/holds | 一个终态、最多一份最终报告 |
| T11 | Hold generation 失效 | 新增 | 旧 Hold 永久关闭，不影响新代际 |
| T12 | 依赖失败/事件不到达 | 新增 | 进入失败或超时结案 |
| T13 | claim 后崩溃和双 worker wake | 扩展 holds/crash | 一个恢复载体，租约到期可接管 |
| T14 | Capsule 旧引用与新义务代际 | 新增 | 旧引用不能满足新义务 |
| T15 | 长 Context 与 same-turn 恢复 | 扩展 context | 关键段保留，调用序号可追溯 |
| T16 | 外部事件先到、重复、跨 Run、旧修订 | 新增 | 只匹配正确订阅一次 |
| T17 | consult(any) 两子项同时成功 | 新增 | 单 winner、单 aggregate |
| T18 | Coordination review FAIL→修订→PASS | 扩展 coordination | 旧 PASS 不关闭新义务 |

P0 最终门槛至少运行：

```bash
pnpm typecheck
pnpm verify:runtime-run-policy
pnpm verify:runtime-responsibility
pnpm verify:runtime-control-actions
pnpm verify:runtime-exit-guard
pnpm verify:runtime-subject-completion
pnpm verify:runtime-obligations
pnpm verify:runtime-review-obligations
pnpm verify:runtime-atomic
pnpm verify:runtime-crash
pnpm verify:runtime-durable-holds
pnpm verify:runtime-completion-integration
pnpm verify:runtime-terminal
pnpm verify:runtime-action-commands
pnpm verify:runtime-context
pnpm verify:runtime-coordination-closure
pnpm verify:collaboration
pnpm verify:coordination
pnpm verify:docs
```

PR 1/5 完成后，端到端命令改为使用统一 admission mode；在此之前继续显式覆盖 legacy、shadow、atomic 和 completion-engine 旧配置组合。

## 10. PR 拆分

| PR | 范围 | 依赖 | 完成定义 |
| --- | --- | --- | --- |
| 1 | 冻结 Policy、统一解析、历史绑定和静态检查 | 无 | 重启改配置不改变存量 Run 语义 |
| 2 | Responsibility Snapshot、Blocker Projection、Exit/Context/Completion 统一 | 1 | 同一事实得到相同责任和阻断结论 |
| 3A | `commitRunTerminal()`、终态 CAS、最终报告原子提交 | 1–2 | Stop/Finalize/Complete 竞态无覆盖和半状态 |
| 3B | complete/wake/hold/handoff/consult(all) 公共命令 | 3A | 故障注入无重复后继工作 |
| 4 | Hold v2、超时、错误分类、退避和恢复审计 | 1、3A | 永久错误有结局，暂时错误有退避 |
| 5 | 混合版本验收和 Collaboration 默认 execute | 1–4 | 发布门槛通过，存量按冻结语义排空 |
| 6 | Agent API v2 | 5 | 新词汇端到端，旧 checkpoint 可恢复 |
| 7 | Capsule 引用和关键 Context 预算 | 2、6 | 无双份机器义务，关键段不丢失 |
| 8 | timer/dependency/external event 等待入口 | 4、6–7 | 至少一个真实事件源完整闭环 |
| 9 | consult(any) | 3B、5–6 | 单 winner、单 aggregate、义务正确结算 |
| 10 | ProgressDigest 与兼容分支清理 | 存量排空 | 重复执行不算进展，历史仍可读取 |

每个 PR 必须同时提交：schema/contract 变更、兼容读取、验证用例、观测字段和回退说明。禁止先合入默认开关，再补事务或恢复测试。

## 11. 观测与发布门槛

最小观测字段：

- admission profile、authority、policy version、worker 支持版本；
- runId、subjectId、attemptId、generation、obligationId 的 trace 关联；
- blocker/recovery reason code、correction 次数、Candidate 拒绝原因；
- stale commit、非法终态覆盖尝试、orphan responsibility；
- Hold wake 延迟、超时、永久关闭、退避和事件去重；
- 最终报告幂等命中、恢复成功率、模型调用次数、tokens、成本和延迟。

内部 ID 用于日志和 Trace 关联，不作为高基数监控标签。用户界面优先回答“为什么还没完成、谁在等待什么”，排障界面再展示版本与内部标识。

默认接管门槛：

1. 无双 holder、旧 generation 成功提交或孤立责任。
2. 无截断/空回复误完成，无必需义务绕过。
3. 无重复最终报告、终态重开或终态覆盖。
4. 改变环境配置后，存量 Run 执行语义不变。
5. Shadow 差异均有分类和解释。
6. initial/fanout 合法 fastpath 保留。
7. 至少完成一次跨进程 handoff、等待/审批、review_revision 恢复验收。
8. 成本和延迟相对同类任务基线没有不可解释回归。

## 12. 实施跟踪

| 阶段 | 状态 | 验收记录 |
| --- | --- | --- |
| 1 冻结执行策略 | 已完成 | 冻结正交 Policy、统一 Contract parser、旧开关 admission 映射、歧义历史阻断、Coordination Revision 继承；四模式 Collaboration E2E、Runtime Policy/Atomic/Crash/Coordination 专项及 typecheck 通过 |
| 2 统一责任与阻断 | 已完成 | 公共 Responsibility Snapshot 与四类 Blocker Projection；ExitGuard、Context、Subject/Run Completion、API/UI 共用 reason code 和引用；必需 failed/cancelled 义务、非必需 consultation、旧 generation Attempt 专项验收通过 |
| 3A 原子终局 | 已完成 | `commitRunTerminal()` 以 `BEGIN IMMEDIATE` + 终态 CAS 收口 Completion Evaluation、报告、Run/disposition、Hold/义务和执行载体关闭；Collaboration/Coordination execute、Stop 共用命令；并发 Complete/Fail/Cancel、事务回滚通知和 SIGKILL 前后专项验收通过 |
| 3B 公共动作命令 | 已完成 | 新增 complete/wake/hold/handoff/consult(all) 命令与持久化幂等账本；Collaboration 各冻结 Profile 共用命令提交，Coordination execute 接入 complete/hold/wake；同命令跨进程竞态、事务前后 SIGKILL、四模式 Collaboration 与 execute Coordination E2E 通过 |
| 4 Hold 恢复闭环 | 已完成 | Durable Hold v2 拆分 wake/timeout，增加类型化错误、指数退避、重试耗尽和永久关闭；v1 兼容读取、责任恢复审计及 API/WS/UI 展示完成；事件/超时边界、依赖失败、旧 generation 隔离、Stop/Wake、SIGKILL 后租约接管和跨进程 claim 竞争验收通过 |
| 5 Collaboration 默认接管 | 已完成 | 新 Collaboration 默认冻结 `execute`，显式 legacy 回退仅影响新 Run；Shadow Comparison 对同输出/同快照分类并审计，且不重跑模型、工具或 Dispatch；混合版本、四 Profile、handoff、consult(all)、Hold/Wake、Stop、审批恢复、review_revision、崩溃与竞态验收通过 |
| 6 Agent API v2 | 未开始 | — |
| 7 Capsule/Context | 未开始 | — |
| 8 外部等待 | 未开始 | — |
| 9 consult(any) | 未开始 | — |
| 10 兼容清理 | 未开始 | — |

第一批开发只启动 PR 1–4。P0 代码、混合版本测试和竞态验收全部通过后，才能启动 PR 5 的默认接管。P1/P2 可提前完成纯类型或纯函数设计，但不得提前向模型暴露未闭环能力。
