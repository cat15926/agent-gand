# 通用私密协作与受控信息发布实施指导

状态：**实施中（正式实施指导 v1.2，G0/G1 已完成，新增契约在对应阶段冻结）**。
编制日期：2026-10-13。关联：[Issue #15](https://github.com/cat15926/agent-gand/issues/15)。
已提交代码基线：`main@d6abb7abba6cfa789d127ab4372160e56bcb3fda`；G1 工作区迁移清单至 **v13**。
阶段状态：**G0/G1 已完成，G2–G6 待实施**；详见 [G0 验收记录](../reports/scoped-collaboration-g0-acceptance-2026-10-13.md)。当前私密协作阻断尚未修复。

本文规定实施范围、契约、改造位置、交付顺序和验收门槛。阶段交付、真实账户验收、现有故障任务迁移及发布分别记录实际执行结果。文中的新类型、工具、路由、能力包和表名均为拟定设计，不能作为当前已可用 API 使用。

## 1. 实施结论与首版目标

### 1.1 需要解决的问题

当前 Collaboration 把私密子任务正文汇总与父任务恢复合并为一条来源链。协调者读取结果后，后继执行继承更窄的输出范围，不能继续向范围外成员派发任务。这会阻断独立征询、盲评、分组协商和公开/私密交替等任务。

首要目标为：**A 完成私密任务后，父任务继续 B；B 的上下文、文件、日志和会话均不包含 A 的私密内容。**

实现必须同时提供两条路径：

1. **状态回流**：父调度只读取获准的机器状态，按冻结计划继续工作。
2. **正文处理与发布**：有权处理私密正文的执行者独立工作；扩大接收范围时使用专用发布授权。

现有权限交集、Owner 验收、Runtime 责任、费用和副作用约束继续生效。删除目标权限检查、把所有成员加入私密范围、用提示词要求模型自行保密，都不构成本计划的实现。

### 1.2 版本交付承诺

| 交付批次 | 阶段 | 可以承诺 | 尚不承诺 |
|---|---|---|---|
| 第一批：独立协作 | G0–G2 | 在模型 API 后端连续处理已授权、预先准备的独立材料；父级只接收获准状态 | 任意私密结果自动公开、完整自主暗牌游戏、外部后端新能力 |
| 第二批：受控发布 | G3–G4 | 确切内容批准、有限确定性发布规则、独立私密汇总、持久恢复和故障治理 | 任意自然语言自动脱密、外部动作绝对一次执行 |
| 第三批：多后端与发布 | G5–G6 | 逐后端实测通过的 SDK/Codex 能力、Coordination 接入、通用场景与界面验收 | 未验证后端、任意共享写入、跨主机强一致 |

完整自由文本狼人杀存在额外产品要求：玩家必须根据私密身份公开发言。逐条人工批准与“用户只当观众”存在冲突。首期采用获准的结构化动作、固定目标映射和确定性公开结果验证多轮流程；任意自然语言自动披露策略列为后续独立需求，不纳入 G0–G6 的完成承诺。

### 1.3 与 R1–R8 的关系

| 现有基础 | 本次复用方式 | 本次新增内容 |
|---|---|---|
| Subject/Custody、义务、Action Command、持久 Hold | 继续作为责任与状态权威 | 独立投递、确认、结果与发布义务的绑定 |
| R2 私密消息和受控文件权限 | 保留读取、引用与默认输出边界 | 显式执行范围、来源清单和受控披露 |
| R3/R4 产物快照与私密写入核对 | 复用不可变版本和未知副作用处理 | 新工作组恢复与范围核验，不放宽旧限制 |
| R5 费用预算 | 使用同一准入与未知占额账本 | 新批次/发布命令的幂等预算关联 |
| R6 后继与契约修订 | 保留原 Run 和来源关系 | 仅显式批准的跨范围后继；未经实现验证继续阻断 |
| R7 冻结阶段图、逐成员范围及汇合 | 复用范围检查、调用统计与步骤回执 | 动态 Collaboration 的独立返回契约和父恢复 |
| R8 真实验收设施 | 复用隔离账户、次数/时限控制与证据格式 | 新能力的独立真实场景；旧报告不能替代新验收 |

依据：[R7 契约](../architecture/scoped-stage-batch-scheduling-v1.md)、[R8 真实验收契约](../architecture/real-collaboration-acceptance-v1.md)、[R1–R8 计划](platform-collaboration-remaining-implementation-plan.md)。

## 2. 基线、证据与实施准入

### 2.1 已确认与未确认

本地代码核对及隔离函数级复现见[分析记录](../reports/issue-15-private-consultation-analysis-2026-10-13.md)。当前公开父任务私密咨询 A 后，汇总范围变为“协调者＋房主”，继续咨询 B 被拒；即使保留 A 的汇总权限，B 仍不在范围内。

Issue 记录的 Windows 源码包、5173 部署及原始 Run 不是当前仓库基线的同一环境。本地数据库没有该故障 Run；现场四次错误的次数和时间线来自 Issue，此次未独立重验。不得用本机迁移 v11 推断现场部署也是 v11。

### 2.2 G0 必须登记的基线清单

- 开发源码目录、完整 Git SHA、工作区变更及依赖锁文件指纹。
- 验收实例的前端/后端实际进程、工作目录、端口、数据库路径及迁移版本。
- Node/pnpm、Claude SDK、Codex 客户端版本；当前支持矩阵。
- 非敏感配置摘要：功能准入、任务数量限制、会话策略、工具与预算能力。
- 现场可访问时，只读登记 Run、Dispatch、Attempt、消息范围及错误事件 ID；不可访问则明确保留证据限制。

端口相同不代表环境相同；模型输出中的路径也不是进程归属证据。记录配置名和必要指纹，不记录密钥、认证文件内容、玩家身份或业务正文。

### 2.3 开发与验收环境

开发使用经确认基线的分支或隔离副本。所有可写验证必须使用临时 SQLite、独立角色/私有目录、合成材料及独立端口。隔离 worker 禁止自动加载日常服务 `.env`；供应商与原生驱动默认使用测试桩。

当前 `config.sandboxDir` 使用固定项目路径；不能仅设置 `SANDBOX_DIR` 就宣称隔离成立。G0 检查每个脚本的实际配置和副作用，验证数据库、受控文件、普通工作区、原生 home、日志和快照全部指向验收目录。

日常 3010/5173 服务、业务数据库及原游戏进度不作为可写测试环境。真实账户验证沿用 R8 的隔离办法；明确所选账户和预算后，才使用真实请求入口。

## 3. 不可破坏的设计约束

| 约束 | 实现要求 |
|---|---|
| 执行权、阅读权、披露权分别校验 | 担任协调者、能读材料或能调用工具，均不自动获得扩大披露的权限 |
| 原始范围不可变 | 新发布创建新版本；原消息、文件、证据、Context 及既有批准指纹保持原含义 |
| 默认输出取来源交集 | 模型不能通过删 provenance、换文案、换收件人或改 visibility 扩权 |
| 控制状态也需授权 | 子项存在、数量、参与者、状态、路由和引用选择可能携带信息，不能默认公开 |
| 同 audience 不等于同 Scope | 独立事项必须有独立上下文身份，不能因成员相同自动共享历史或原生会话 |
| 一个回合一个最终控制动作 | 新批量工具原子提交后结束回合；不顺带引入无限非终止通知循环 |
| 一个状态权威 | WorkGroup 演进现有 Batch，责任归 Subject/obligation；不得另造独立完成引擎 |
| 核心正确性随功能交付 | 权限、幂等、停止、唯一恢复和预算从 G1/G2 开始生效，G4 是强化验证 |
| 能力不静默降级 | 不支持时在预览阻断；不自动换引擎、公开化或忽略范围配置 |
| 历史契约冻结 | 新能力仅作用于明确采用新版本的 Run；旧 Run 不随全局开关改变语义 |

Owner 的房间审计权限继续保留。消息、Trace 和授权元数据是否加密必须按实际存储说明；ACL 不等于端到端加密。受控文件沿用现有加密方案。

## 4. 目标结构与版本策略

### 4.1 保留主干，分离两类执行

```text
Owner 确认材料、执行成员、进度接收者与发布规则
                         |
                冻结 Run 契约与预算
                 /                 \
       control：调度范围        content：私密处理范围
       只读获准状态与模板       读取获准正文、文件与证据
              |                         |
       独立信封 → 子 Subject       私密结果/私密汇总草稿
              |                         |
       服务端投影完成状态        确切内容批准/确定性规则
              |                         |
       新 Context 恢复父任务       新发布版本 → 指定目标
```

同一 Agent 可以承担两类工作，但每次执行都有独立 Scope、manifest 和会话边界。清洁的父恢复不能复制私密执行生成的“下一步建议”或自由文本总结。

### 4.2 契约演进

G1 已冻结 Tool API / Control Action v3 和 `features.scopedCollaboration.boundaryVersion=2`；新增动作使用独立 `ScopedControlActionV3`，已有 v2 动作保持原语义。版本读取及能力接口已更新，v3 解析和执行明确阻断，待 G2 整包开放。

继续使用现有 Runtime `execute` 与命令事务机制，不新增顶层协作模式。G1 读取器能验证完整的 v3 冻结声明；`assertExecutableCollaborationPolicy` 对其返回能力包不可用。旧版本兼容保持，未知版本明确拒绝，禁止把 v3 降格为 v2。

新能力按完整能力包准入，拟定：

| 能力包 | 必备能力 | 最早可开放 |
|---|---|---|
| `scoped-control-v1` | Scope、manifest、输入来源、独立信封、状态投影、干净父恢复、原子命令及预算 | G2；模型 API |
| `scoped-release-v1` | 上述能力＋草稿版本、Policy/Grant/Record、专用批准、提交前复核和撤销 | G3；适用范围 |

Run 冻结能力包、策略及版本。部署开关只控制新 Run 准入，不能运行中关闭一半检查。能力 API 分别报告“实现支持”“当前配置可用”“真实连接已验证”，附版本和证据时间，不合并成一个布尔值。

## 5. 核心契约与持久化

### 5.1 ExecutionScope 与 ContextManifest

拟定 Scope 关键字段：`id/runId/subjectId/kind/contextManifestId/contextManifestRevision/defaultOutputAccess/policyRevision/sessionBoundaryId/recoveryGeneration`。

manifest 由服务端编译，冻结以下内容：

- 当前目标、可注入根目标、不可变材料和结果引用。
- 允许的历史/证据版本、受控文件、已批准控制投影。
- 允许工具、结果接收范围、后继模板和路由规则。
- 来源版本与哈希、能力包、策略版本及会话边界。

`scopeId` 是定位符，不是授权令牌。解析时仍核对 Run、成员、Subject、权限和资源版本。新范围模式的历史选择采用 manifest 白名单；不能继续用“同一 Run 且 audience 相容”替代独立任务的输入边界。

根任务权限仍参与判定。私密根任务的 clean_control 也只能在获准的控制范围内恢复。范围外的新执行者需要获准的新目标及显式关联的新 Run，不把原 Run 改为公开，也不携带原私密根目标、旧会话或完整历史。

### 5.2 输入来源账本

初始 Context 保持不可变；新增单调追加的 `InputProvenance` 记录实际暴露的输入，包括 prompt、文件读取、工具/MCP 返回、补充输入、恢复会话中的既有材料。

每条输入至少记录：Attempt、序号、Scope、来源类型/不可变引用、版本与哈希、访问判定、暴露状态及时间。正文留在有 ACL 的原存储，账本不复制全部秘密。确实暴露过的旧会话输入必须纳入；无法重建来源清单的会话强制冷启动。

工具返回字节前，原子完成权限检查与来源登记。发送后崩溃但无法确认模型是否收到时，按“可能暴露”保守处理；登记失败禁止发送。提交动作绑定 `ledgerRevision`，并在提交事务中核对没有未覆盖的新输入。

G1/G2 保持严格读取：范围不兼容的读取直接拒绝。G3 如允许在私密 content 范围追加更窄来源，必须收窄默认输出且更新账本，不能原地重写初始 Context 哈希。模型无权自行删减来源或声明“本次输出没有用到某段秘密”。

### 5.3 DeliveryEnvelope 与回执

拟定信封字段：`id/runId/sourceAttemptId/recipientIds/payloadRef/payloadAccess/expectation/idempotencyKey/fingerprint/status/releaseRecordId`。

`payloadRef` 绑定不可变内容版本和哈希；引用本身不赋予阅读或投递权限。多项材料各有信封，不能先拼成一个共享 objective 再要求接收者只读自己的段落。

| 回执层次 | 精确定义 | 与业务完成的关系 |
|---|---|---|
| prepared/queued | 批次、信封和待派发工作已原子持久化 | 尚未证明接收者得到材料 |
| delivered | 服务端已记录该成员获准收件箱中的持久消息引用 | 不代表模型已读取或理解 |
| acknowledged | 被指定接收者通过规范确认动作满足对应 ACK 义务 | 仅满足接收确认，不满足实质交付 |
| result | Subject 完成验收通过，结果引用有效 | 按该子项冻结标准满足工作义务 |

`result` 由 Subject/obligation 权威表达，不额外用信封单独推断。需要 ACK 时在 G1/G2 定义版本化接收确认动作或 ACK 专用 Subject；不能靠匹配“收到”正文判成功，更不能削弱 R7 实质交付对纯 ACK 的拒绝。

相同幂等键和相同指纹返回原结果；内容、收件人、来源或策略不同则冲突。授权盲投递使用 Owner 预先登记的内容—目标映射，调度者只拿不透明引用；引用选择和数量也必须符合获准计划。

### 5.4 Batch/WorkGroup 与 ReturnContract

WorkGroup 扩展现有 Batch 的逐项内容和返回规则；Batch/Subject/obligation 保持一致，避免重复状态机。拟定返回契约：

```ts
interface WorkGroupReturnContractV1 {
  join: 'all' | 'any';
  resultHandling: 'references_only' | 'scoped_aggregate';
  parentResume: 'clean_control' | 'content_bound';
  controlProjectionPolicyId: string;
  controlPlanRevision: number;
  requiredItemIds: string[];
  failurePolicy: 'needs_attention' | 'continue_optional';
}
```

`all` 按必需项的约定义务判定；`any` 保留首个通过验收的 winner，不采用首个返回文本。`continue_optional` 只能跳过预先声明的非必需项。首版 G2 新接口只开放 `all`；旧 v2 `any` 语义保持。新范围的 `any` 在 G4 完成竞争验证后再开放。

`references_only` 不保证所有引用都可见：索引、标题、状态和数量分别经过投影授权。`scoped_aggregate` 创建独立汇总 Subject。父恢复与正文汇总若同时需要，分别登记义务和唯一派发键，不能将两种完成事件混用。

### 5.5 ReleasePolicy / Grant / Record

| 对象 | 职责 |
|---|---|
| Policy | Owner 批准的规则：来源及版本选择、目标映射、动作、输出形式、有效期、次数和撤销版本 |
| Grant | 本次发布实例：完整输入账本摘要、草稿版本、输出字节/模板、目标、策略版本、命令键和消费状态 |
| Record | 已提交发布事实：新内容版本、来源、Grant、目标和命令关联；不可变 |

首期只支持：

- `exact_content`：Owner 查看确切正文、附件/元数据、目标和来源摘要后批准；批准绑定实际将发布的全部字节。
- `deterministic_projection`：服务端注册、带版本的有限字段选择或变换；来源选择与目标映射一并获批，不执行任意代码、网络请求或模型表达式。

JSON schema 合规、敏感词过滤、另一模型审查，均不能把自由文本变成确定性脱密。模型生成的新秘密先进入私密 content 草稿，流式片段、reason、工具参数和日志也继承该范围；不能先公开输出再补 ACL。

G2 只处理 Owner 预先准备或已明确授权的材料。需要模型生成多份秘密时在 G3 设计其私密生成范围与逐项发布规则；不把“根请求公开”视为生成内容可以全部公开。对于可能受多个秘密影响的模型输出，批准覆盖完整受限输入集合，不能仅凭字段名宣称独立。

批准、发布、继续执行是不同动作。普通用户回答不签发 Grant。撤销阻断未来发布，不能收回已被阅读的信息，也不重写既有发布事实。

### 5.6 持久化映射与约束

以下为逻辑表，G1 优先扩展现有可复用结构；确需新增时追加迁移，避免同义状态重复存储。

| 逻辑数据 | 存储方向 | 最小约束 |
|---|---|---|
| ExecutionScope、manifest | 新增范围/清单记录，Context Assembly 关联 | 冻结版本，Attempt 绑定不可漂移 |
| InputProvenance | 新增追加账本 | UNIQUE(attempt_id, sequence)，提交核对 revision |
| WorkGroup item、返回契约 | 扩展 Batch 与关联表 | UNIQUE(batch_id, item_key)，冻结契约 |
| DeliveryEnvelope | 新增或扩展消息关联记录 | UNIQUE(run_id, idempotency_key)，指纹冲突拒绝 |
| 状态投影 | 新增有权限的投影记录 | 来源事件＋策略版本＋目标范围幂等 |
| Policy/Grant/Record | 专用授权存储 | 策略版本校验、单次消费 CAS、发布 command_key 唯一 |
| 父恢复 | 复用 Action Command 与可恢复派发 | group＋generation＋恢复类型唯一 |
| 原生边界 | Session Binding 扩展 | Scope/manifest/policy/恢复代际变化强制冷启动 |

发布记录、获准新消息版本、Grant 消费在同一 SQLite 事务提交。对外通知走现有 afterCommit 与可恢复队列；若新增 outbox，必须有唯一投递键和消费恢复协议，不能只新增一张状态表。

## 6. 工具、API 与错误契约

### 6.1 新工具及兼容

| 工具 | 最早阶段 | 语义 |
|---|---|---|
| `agent.consult_batch` | G2 | 提交独立内容引用、逐项 expectation 和已批准 returnProfile；原子创建后结束本回合 |
| `agent.acknowledge`（G1 冻结名称，尚未开放） | G2 | 仅确认指定信封；服务端绑定接收成员和义务 |
| `agent.request_release` | G3 | 提交私密草稿引用、目标和用途，创建专用审批/等待；不由模型签发授权 |
| `agent.notify` | G3 后按需 | 只投递或要求明确 ACK；不隐式转移业务责任，采用冻结 continuation |

保留 v2 `consult/handoff/hold/complete`。旧 consult 仍使用共同 objective 与共同可见范围，不自动转成独立盲投递。新接口首版最多 3 项，实际还受当前服务器更低上限约束；五份材料按获准控制计划分批，保持房间同 Agent 串行规则。

拟定请求示例：

```json
{
  "items": [
    {"key": "review-a", "target": "reviewer-a", "payloadRef": "approved-envelope-a", "expectation": "result"},
    {"key": "review-b", "target": "reviewer-b", "payloadRef": "approved-envelope-b", "expectation": "result"}
  ],
  "join": "all",
  "returnProfile": "independent-results-status-only"
}
```

示例中的引用和 profile 必须先由服务端创建并授权。Actor、Run、Attempt、Scope、来源账本由执行绑定提供，不接受模型覆盖。任何一项无权时整个创建动作拒绝，返回获准的逐项错误，不留下半批任务。

### 6.2 管理和能力 API

复用 accounts 管理边界的 Owner 会话、Host、Origin、远程认证和 CSRF。路径如下为拟定值：

| 路由 | 用途 |
|---|---|
| `POST /api/accounts/information-releases/preview` | 冻结草稿、来源、目标和策略，生成短期 previewId/fingerprint |
| `POST /api/accounts/information-releases/confirm` | 核对批准指纹、次数与有效期；明确返回待发布/已发布状态 |
| `POST /api/accounts/information-release-policies/:id/revoke` | 撤销策略并递增版本，阻断尚未提交的发布 |
| `GET /api/accounts/information-releases/:id` | Owner 审计批准与发布事实 |
| `GET /api/runs/:id/collaboration-capabilities` | 按调用者范围返回本 Run 已冻结能力和真实恢复选项 |

Confirm 只接受 previewId、fingerprint、clientRequestId 等必要字段，不能偷偷替换正文或目标。批准即发布的快捷路径也必须在一个命令事务内提交 Grant 和 Record。涉及未来数据的预授权展示选择规则、最大次数、时限和目标映射，不能仅展示一个样例。

### 6.3 结构化错误与纠偏

拟定错误：`SCOPE_NOT_READABLE`、`PRIVATE_OUTPUT_REQUIRES_RELEASE`、`RETURN_CONTRACT_UNSATISFIABLE`、`CONTROL_PROJECTION_DENIED`、`ENVELOPE_IDEMPOTENCY_CONFLICT`、`RELEASE_STALE`、`RELEASE_REVOKED`、`RELEASE_EXPIRED`、`RELEASE_ALREADY_CONSUMED`、`SESSION_SCOPE_MISMATCH`、`BACKEND_SCOPE_UNSUPPORTED`。

错误包含 `code/retryable/message/allowedRecovery/diagnosticRef`。相同范围与目标的权限失败标记不可通过改文案重试，进入有界纠偏或既有 needs_attention/用户等待路径。恢复选项只能来自该 Run 的冻结能力，不能建议尚未实现的“解除授权”按钮。

Owner 可查看详细来源；Agent 和未获准页面只看到最小诊断。错误、审计 ID、内容哈希和隐藏成员信息本身也需访问校验。

## 7. 调度、原子性、停止与预算

### 7.1 创建工作组

在已有 Runtime Action Command 事务中依次：

1. 核对 Run 未终止、Attempt lease、Subject holder 和 generation。
2. 校验 Scope、manifest、ledgerRevision、策略版本和全部投递项。
3. 验证返回契约可满足，父范围有权接收需要的控制投影。
4. 执行现有任务数量、时长、调用与费用准入；登记唯一预算关联。
5. 创建 Batch、子 Subject/义务、信封、待派发记录，并使父责任进入等待。
6. 保存命令结果并提交；提交后才唤醒 worker 和投递获准事件。

LLM、网络和原生调用不进入数据库事务。相同命令重试返回原结果，不重复创建、不重复预留。实际模型调用仍通过现有逐调用准入；如批次需要额外预留，必须从同一账本分配/转用，禁止“批次扣一次、成员启动再扣一次”。

### 7.2 子结果与父恢复

结果通过 SubjectCompletion 后按原范围保存。服务端依照冻结策略生成机器状态投影；不包含自由文本总结、未授权标题或错误正文。满足 join/失败策略后，仅创建一个父恢复命令。

clean_control 从批准的模板、根目标和投影编译新 manifest，并使用新的执行边界。后继目标、引用选择与分支只依据获准状态和预先批准的路由。content_bound 继续按来源交集处理正文，不具备隐式公开能力。

如需要私密汇总，单独创建可读全部输入的 Subject；其输出保留交集或走发布服务。禁止为了恢复父调度而注入该私密摘要。

### 7.3 发布提交

提交事务重新核对 Run/Subject/停止状态、完整输入账本、Policy/Grant 版本、撤销/过期、确切输出及目标。成功时原子消费授权、创建新版本和 ReleaseRecord；重复命令返回同一发布事实。模型生成期间撤销授权，迟到结果不得发布。

停止与发布通过同一终局序列约束：若发布先提交，保留已发生事实；若停止先提交，拒绝后续新发布。不能把已提交外部动作描述成取消后撤回。

### 7.4 失败、等待和费用

- timer/dependency/普通 answer 仅改变调度状态，不扩大权限。恢复重新核对绑定与策略。
- 成功、失败、未知副作用、等待分别保留；只重试明确允许且未确认完成的项。
- G2 即覆盖重复确认、停止后迟到完成、提交后未派发的恢复；G4 扩展系统化崩溃与竞争矩阵。
- `any` 的 loser 取消不能撤销已发生写入。新范围 any 初期只开放纯文本/只读任务，写入竞争继续拒绝。
- 已发出且结果未知的模型调用保留费用占额；重启、后继和授权重试不得重置预算。
- Scope 冷切换造成的新增输入 Token、原生启动和时延纳入计量。平台调用数与原生内部请求数分开，不承诺严格供应商账单上限。

## 8. 后端、工具与会话边界

| 引擎/后端 | 新能力启用门槛 | 当前计划状态 |
|---|---|---|
| Collaboration＋模型 API | G1/G2 输入白名单、回执回流和工具来源验证 | 待实施 |
| Collaboration＋Claude SDK/Codex app-server | G5 会话、home、目录、记忆、桥工具与真实连接验证 | 待实施；已有私密文本能力不等于新范围能力 |
| Coordination | G5 对接共同 Scope/Return/Release 服务，保留 R7 图与 Owner 门禁 | 待实施；已有静态逐成员范围继续按现契约 |
| 兼容 Pipeline/Supervisor | 无可靠独立上下文时拒绝新能力 | 本计划不承诺支持 |
| 只读 CLI | 无可靠私密隔离时预览阻断 | 保持拒绝 |

G1 定义并验证公共 Scope/session 契约；G2 只开放模型 API。G5 完成原生实现与实测前，SDK/Codex 的新能力准入保持关闭，避免会话绑定“类型已存在”就被当成驱动已支持。

原生会话绑定在既有账户、角色版本、模型、工具、工作区、驱动、Run 和 audience 上追加 Scope、manifest revision、policy revision、恢复代际。control/content 切换、独立事项切换、来源不再相容、授权撤销或无法核验旧来源时强制冷启动。

还需隔离 native home 中的 transcript、项目记忆、缓存和可读工作目录。仅更换 sessionId 或提示模型忽略旧文本不合格。共享登录身份与执行上下文分别管理；如隔离副本刷新 OAuth，沿用 R8 同身份、同代次、源文件 CAS 同步，不能覆盖用户的新登录。

私密执行继续关闭普通原生文件、shell、网络等旁路；文件经获准的平台受控工具。声明工具能力与实际执行均校验 Scope。搜索、列表、错误和流式事件不得泄露未授权资源；模型参数不能替换 viewer 或扩大 ACL。

## 9. 预期交互与产品边界

### 9.1 创建与预览

沿用现有任务入口，不新增顶层协作模式。新增的普通设置使用业务词汇：

| 设置 | 用户看到的选项 | 服务端含义 |
|---|---|---|
| 材料分配 | 共同处理 / 每人独立材料 | 共同 objective 或独立信封 |
| 进度可见 | 房主 / 获准协调者及成员 | 固定状态投影目标 |
| 结果返回 | 房主分别查看 / 指定成员汇总 | references_only / scoped_aggregate |
| 后续推进 | 按已确认步骤继续 / 遇到分歧等待房主 | 冻结控制计划与失败策略 |
| 对外发布 | 每次确认 / 使用已批准规则 | exact_content / deterministic_projection；G3 开放 |

预览展示执行成员、材料范围、谁能看进度、谁读正文、哪些发布自动进行、预算与后端阻断项。Scope/Grant 等技术字段放在详情中。选项变化使预览指纹失效；未实现的后端明确显示原因。

G2 提供最小独立材料表单和预览，不把所有可用界面推迟到 G6。后端也必须执行同一能力校验，前端隐藏控件不能替代准入。

### 9.2 运行过程示例

1. 房主为 A/B/C/D/E 准备独立材料，确认协调者仅查看状态和两批处理计划。
2. 页面显示第一批三项的投递/确认/结果状态；协调者看不到正文。
3. 必需结果满足后，父调度收到获准状态，继续第二批。
4. 某项失败时，仅展示该查看者获准的原因及“重试失败项/补充材料/结束”等真实能力。
5. 所有工作完成后，显示实际交付和业务验收；机器回执不代替 Owner 对质量的确认。

### 9.3 发布卡

卡片展示确切内容或确定性规则、接收者、适用来源版本、次数、时限和撤销限制。按钮区分“批准并发布”“拒绝”；普通“继续执行”不等价于批准发布。Owner 编辑草稿产生新版本，旧确认失效。

所有者视图与 Agent 可见视图分别渲染。未获准正文不能预先进入浏览器状态、WebSocket payload 或折叠卡片中。授权请求原因、Trace、通知摘要也继承权限。

### 9.4 自动化程度说明

G2 的“自动继续”仅指既定计划内的状态调度。涉及秘密决定下一收件人、选择模板或公开自然语言时，需要相应发布策略。无人干预游戏的验收只涵盖批准的结构化规则，界面不得标记为“任意暗牌游戏全自动”。

## 10. 代码改造地图

路径相对仓库根；“新增”是建议文件，不代表当前存在。

| 模块 | 当前文件/拟新增位置 | 主要改造与验证 |
|---|---|---|
| 共享契约 | `packages/shared/src/{message,collaboration,runtime,orchestration}.ts`；新增 `informationFlow.ts` | Scope、引用、返回、动作及能力版本；严格解码旧/新类型 |
| 版本准入 | `runtime/{runPolicy,controlAction,subjectContract}.ts`，`db/orchestrationMigrations.ts` | 更新 v2-only guard、冻结能力包、拒绝部分实现及未知版本 |
| 公共信息流 | 新增 `apps/server/src/informationFlow/` | manifest、provenance、默认输出、投影和发布统一实现 |
| 工具解析与调度 | `collaboration/{controlTools,scheduler,store}.ts` | 独立项；拆分 maybeCompleteBatch 的正文/状态/恢复；解析及提交双重校验 |
| 责任与原子命令 | `runtime/{actionCommands,subjectContract,obligations,subjectCompletion}.ts` | 信封回执、子结果、汇总和父等待义务；唯一恢复 |
| 上下文与证据 | `runtime/{context,capsule,evidence}.ts`，`messaging/{access,inbox}.ts` | manifest 白名单、来源版本、旧引用不可扩权、按调用者读取 |
| 等待与决策 | `runtime/holds.ts`，`runs/recovery.ts`，`collaboration/decisions.ts` | 专用发布等待、策略版本复核，普通 answer 不签发授权 |
| 产物与工具 | `artifacts/store.ts`，`tools/`，`execution/` 中的平台工具桥 | 动态输入登记、不可变发布版本、所有出口同一权限服务 |
| 模型调用与会话 | `orchestration/agentStep.ts`，`execution/{runner,sessions,nativeDrivers}.ts` | Scope 绑定、输入账本、原生冷切换和目录隔离 |
| 预算与统计 | `orchestration/{executionBudget,costBudget,modelCalls}.ts`，`collaboration/store.ts` | 唯一命令/实际调用关联、未知费用保留、状态投影不调用模型 |
| 编排接入 | `orchestration/{service,resolver}.ts`，`coordination/runtime.ts`，`runtime/coordinationAdapter.ts` | 预览和能力矩阵；复用 R7 范围及 Owner 门禁 |
| API | 复用 `api/{accountRoutes,artifactRoutes}.ts` 管理边界；新增 `informationReleaseRoutes.ts` | preview/confirm/revoke/audit 与按调用者能力查询 |
| UI | `TaskComposer`、`BusinessContractEditor`、`TaskCard`、`RightPanel`；新增发布卡/逐项材料组件 | G2 最小闭环、G3 发布交互、G6 完整桌面/窄屏验收 |
| 数据与文档 | `db/schema.sql`、迁移；`docs/architecture/`、`docs/reports/` | 追加迁移、旧 worker 拒绝；每阶段生效契约和证据 |

## 11. 阶段执行清单与完成门槛

主线为 **G0 → G1 → G2 → G3 → G4 → G5 → G6**。同一阶段可拆成小提交，但能力包必须整体通过准入门槛后才能开放。以下提交标题为建议，不代表已经创建。

### G0：核实基线并固化失败

**已完成（2026-10-13）**：[基线与验收报告](../reports/scoped-collaboration-g0-acceptance-2026-10-13.md)。仓库命令 `pnpm verify:scoped-collaboration-baseline` 通过正常准入和真实调度复现 v2 拒绝、timer/answer 继承及公开成功对照；17 次模型桩调用，零网络请求/原生执行，业务库快照不变。原现场不可访问的限制保留，未交付新的连续私密协作能力。

建议提交：`test: capture private consultation continuation failures`。

交付：基线清单、隔离复现脚本、旧行为断言、现有能力盘点、与新增行为分开的预期用例。

- 将分析中的函数级复现固化到仓库，并扩展为测试桩驱动的真实 Action Command/调度链。
- 覆盖 C→A→汇总→B 拒绝、改文案无效、再次咨询 A 的实际范围。
- 通过真实 Hold/decision 路径验证 timer 和普通 answer 不扩权。
- 保留 v2 行为回归；新预期暂不宣称通过，不用真实角色、身份牌或供应商密钥。

完成门槛：开发/验收基线明确；隔离可重跑；首次阻断判定定位；零供应商请求；业务库没有变动。原现场不可访问时记录限制，本机复现不得冒充现场全链路证据。

### G1：公共契约、Scope 与输入来源

**已完成（2026-10-14）**：[G1 验收报告](../reports/scoped-collaboration-g1-acceptance-2026-10-14.md)。Scope、manifest、输入账本、输出事务检查、会话边界接口及能力声明已落库；完整 v3 能力包保持关闭，G2 才接入实际连续调度。本机热重载导致业务库升级至 v13，实际影响见报告。

建议提交：`feat: add scoped collaboration contracts and provenance`。

交付：共享类型、迁移、冻结能力包、manifest 编译器、输入账本、读取/输出检查、会话边界接口和结构化错误。

- 一次性更新全部版本推导、执行 guard、历史读取与 Driver 能力声明。
- 明确 material/result/ACK 三种义务，避免新增确认语义削弱实质完成验收。
- 新范围功能默认关闭；只用隔离测试对象验证存储和边界。
- 验证同 audience 独立事项不共享 manifest；新 Scope 不能从房间全文检索私密历史。

完成门槛：来源可追踪、Context 不漂移、动态输入可追加、旧契约可解释、新未知版本拒绝；静态权限测试通过。尚不宣称父级协作可持续。

### G2：独立信封与干净父恢复

建议拆分：`feat: create isolated consultation items`、`feat: resume control tasks from authorized receipts`。

交付：模型 API 的 consult_batch/all、逐项信封和 ACK/结果义务、返回契约、固定状态投影、父级唯一恢复、最小材料表单/预览/运行面板。

- 支持预先授权材料，最多三项及冻结的分批计划；返回契约不满足时创建前拒绝。
- 创建批次、责任、预算关联和命令结果同事务；执行前再验权。
- 覆盖重复提交、第二项无权、Stop 与迟到结果、提交后未派发的恢复。
- 显式拒绝新范围 any、外部后端、任意私密正文发布；既有 v2 能力按原契约执行。

完成门槛：A→B/C 和五项两批连续推进；各项材料相互隔离；父级只有获准状态；重复命令不增派发或预算；Owner 可从正常界面完成预览和查看结果。

**第一批可交付版本在此结束。** 产品承诺为连续组织隔离子任务。

### G3：正文汇总与授权发布

建议拆分：`feat: approve exact content releases`、`feat: apply deterministic release policies`。

交付：独立汇总 Subject、私密草稿、Owner preview/confirm、Policy/Grant/Record、有限投影规则、专用 Hold、撤销/过期和发布卡。

- 先交付 exact_content，再交付有固定字段/目标映射的投影；两者分别验收。
- 所有受限输入和输出字段进入批准指纹，编辑、来源变更或新增读取使不匹配批准失效。
- 授权消费与发布同事务，提交时复核停止和撤销状态。
- 如引入 notify，仅使用有界、冻结 continuation；不作为私密路由绕行入口。

完成门槛：A/B 的私密报告由获准汇总者读取；Owner 可仅发布指定总评给第三人；原报告保持原范围；普通回答“全部授权”无效；撤销、过期、内容漂移和单次并发消费均正确。

### G4：持久恢复、竞争与费用强化

建议提交：`test: harden scoped recovery release races and budgets`，确有实现缺口时配套修复提交。

交付：系统化崩溃注入、Stop/complete/release/wake 竞争测试、适用只读 any、工作组部分失败恢复、费用对账证据。

- 覆盖事务前/后、发布提交前/后、worker 领取后、输出返回后等故障窗口。
- 验证父恢复唯一、已完成项不重做、未知外部写入不重放。
- 两个成功项同时竞争时仅一个 winner；loser 迟到不进入后续发布。
- 多次恢复不重复预约，实际调用和未知占额仍保留。

完成门槛：无半批状态、双发布或双父恢复；相同命令结果一致；终态不新增动作；预算余额与调用记录可解释。G4 不承担补上此前缺失的基础权限/事务检查。

### G5：外部 Agent 与 Coordination

建议拆分：`feat: isolate native collaboration scopes`、`feat: integrate scoped returns into coordination`。

交付：Claude SDK/Codex app-server 冷边界实现、协议夹具、Scope 目录/记忆隔离、受控工具输入账本；Coordination 复用公共服务。

- 先协议和本机驱动测试，再按获准账户、明确上限进行真实验收。
- 同角色、同房间、同 audience 的独立私密事项仍不共享会话；私密→公开不带旧正文或原生记忆。
- 不因新能力增加而旁路 R7 阶段门禁、文件 ACL、R4 副作用核对或 R5 预算。
- 将“支持”“配置可用”“实测通过”分别呈现，不把模型 API 结果推广给 SDK/Codex。

完成门槛：每个开放组合均有独立证据；不支持组合预览阻断；原生会话和工作目录隔离负向验证通过。

### G6：通用验收、灰度与文档发布

建议提交：`docs: publish scoped collaboration contracts and acceptance`。

交付：第 12 节完整矩阵、正常 UI 入口端到端、桌面/390px 浏览器视口、重连、迁移与排空演练、运维手册及支持矩阵。

完成门槛：实施承诺内的场景全通过；每种未支持行为可解释；当前生效契约更新到 architecture，证据落 reports，计划逐项记录提交与通过范围。Issue #15 的远程状态由明确的远程操作处理，不随文档自动关闭。

## 12. 验收设计与验证命令

### 12.1 必测业务场景

| 场景 | 核心断言 | 阶段 |
|---|---|---|
| 五份独立材料分两批处理 | 父级只获状态，后批不含前批正文，跨批预算累计 | G2 |
| 投递与接收确认 | delivered、ACK、实质结果分别判定，不提前满足业务目标 | G2 |
| 两份盲评与私密汇总 | 评审互不可见；汇总者有权；只发布获批总评 | G3 |
| 持续协商与部分失败 | 成功、失败、等待分别保留；只恢复允许的项 | G4 |
| 多轮公开/私密交替 | 使用获准结构化动作/公开投影，任意文本无授权仍拒绝 | G3–G6 |
| 混合 SDK/Codex/API | 同一规范跨后端成立，Scope 切换与原生记忆隔离 | G5 |
| 原故障的通用替身 | 无游戏专有逻辑的“独立审查者 A/B”连续调度通过 | G0/G2/G6 |

狼人杀仅作结构化多轮场景夹具；完整自由文本自动披露另立范围。

### 12.2 必测负向和故障矩阵

| 分类 | 用例与期望 |
|---|---|
| 范围 | 私密 A 不进入公开 Context、私密 B、搜索、文件、证据、错误及 WS；同 audience 独立事项不混入历史 |
| 计划 | 第二项无权整批拒绝；未经批准的目标、次序、引用数量和状态分支不能传出 |
| 状态投影 | 无投影授权创建前拒绝；自由文本摘要不能充当机器回执 |
| 来源 | 模型删改来源无效；工具读取先登记；新增来源不能沿用旧 ledgerRevision 的授权 |
| 发布 | 正文/附件/标题/目标/来源版本变化失效；批准过期或撤销拒绝；并发单次消费只成功一次 |
| 普通恢复 | timer、answer、重新创建 Attempt 不扩权；缺 manifest/未知版本拒绝 |
| 会话 | 私密→公开、同范围不同事项、旧来源未知、缓存复用均验证；仅换 ID 不足 |
| 幂等 | 双击、网络响应丢失、客户端重连、重复 worker 唤醒无双信封/双消息/双父恢复 |
| 停止/故障 | Stop 与 complete/release/wake 竞争；提交前后崩溃；恢复不自动重放未知外部动作 |
| 预算 | 多项准入、排队、取消、重试、后继累计；不双重扣预留、不把未知当免费 |
| 旧契约 | v2 私密回流仍按原规则拒绝越界；新/旧 Run 混读可解释；旧 worker 拒绝新库 |
| 非干扰对照 | 改变未授权秘密且保持获准投影相同，确定性控制输入/路由/可见输出保持一致 |

非干扰测试使用固定桩和真实服务端权限/来源逻辑；单次 LLM 输出相同不能证明保密。平台首期约束内容和显式元数据，不宣称消除模型耗时等全部时序信道。

### 12.3 验证脚本及实施状态

G0/G1 脚本已落库；其余为后续阶段拟新增入口，尚不可运行。

| 脚本 | 内容 |
|---|---|
| [verify-scoped-collaboration-baseline.mjs](../../scripts/verify-scoped-collaboration-baseline.mjs) | 已实施：G0 实际调度复现、timer/answer、旧契约保护 |
| [verify-scoped-collaboration.mjs](../../scripts/verify-scoped-collaboration.mjs) | 已实施：Scope/manifest/来源、版本与迁移准入 |
| `scripts/verify-independent-delivery.mjs` | 独立项、ACK/结果、整批准入和幂等 |
| `scripts/verify-control-resume.mjs` | 状态回流、唯一父恢复、元数据边界与非干扰 |
| `scripts/verify-information-release.mjs` | exact/projection、撤销/过期、漂移和单次消费 |
| `scripts/verify-scoped-collaboration-recovery.mjs` | 崩溃、Stop、any、预算和副作用 |
| `scripts/verify-scoped-collaboration-ui.mjs` | 正常创建、发布卡、权限视图、桌面/窄屏与重连 |

G5 增加每个 Driver 的协议用例与真实场景；沿用 R8 预算/时限控制，不把 mock 结果写成供应商实测。

### 12.4 现有回归入口

按模块变化选择相应回归；发布候选执行全部受影响矩阵。执行前审查环境和副作用，不因脚本名为 verify 就认定只读。

```sh
pnpm typecheck
pnpm verify:scoped-collaboration-baseline
pnpm verify:scoped-collaboration
pnpm verify:message-visibility
pnpm verify:private-interaction
pnpm verify:runtime-action-commands
pnpm verify:runtime-consult-any
pnpm verify:runtime-obligations
pnpm verify:runtime-context
pnpm verify:runtime-completion
pnpm verify:runtime-completion-integration
pnpm verify:runtime-durable-holds
pnpm verify:runtime-hold-recovery-v2
pnpm verify:runtime-external-waits
pnpm verify:runtime-compatibility-retirement
pnpm verify:collaboration
pnpm verify:collaboration-reliability
pnpm verify:private-write-recovery
pnpm verify:cost-budget
pnpm verify:branch-recovery
pnpm verify:stage-scheduling
pnpm verify:platform-real-acceptance
pnpm verify:docs
```

每阶段报告记录 SHA、契约/迁移版本、测试命令、断言范围、未支持项、真实供应商调用数及证据目录。原生内部推理次数未知时明确标注；不在报告中包含密钥或业务秘密。本文列出的是执行要求，实际已运行范围以对应阶段报告为准。

## 13. 迁移、灰度与运维

### 13.1 迁移

G1 当前清单至 v13；后续迁移从 v14 追加，实际编号以落库前基线为准。既有 migration descriptor/checksum 不得修改。

先停止新准入并等待活动工作到安全边界，按[账户备份规范](../architecture/accounts-migration-phase-e4.md)保存数据库、主密钥、认证目录；同时保留适用产物、工作区、部署配置及匹配源码。验证备份完整性，并在隔离位置演练恢复。

迁移采用追加表/字段/索引；历史消息不重分类、不补造披露授权。新代码先能读取旧/新契约，再开放新能力包。迁移失败保留诊断并阻止半完成启动，不靠忽略版本门禁继续运行。

### 13.2 灰度和观测

顺序为：隔离桩 → 模型 API 新建独立 Run → 小范围 exact_content → 有限确定性规则 → 经实测的 SDK/Codex → Coordination。

监测独立子项完成率、父恢复成功/重复数、权限阻断及恢复成功率、未授权字节测试、用户确认次数、冷启动次数、调用/费用未知占额与队列时延。投影和门禁本身不得增加模型调用。

G0 留下 API/事务/调度基线，G2/G3/G5 同环境比较；若关键无模型接口 P95 明显恶化，定位后再放量。阈值在基线采样后冻结，不用减少校验来降低阻断率或延迟。

### 13.3 回滚和排空

关闭新能力准入，保留能理解新契约的兼容 worker；安全排空或转入明确的待处理状态。不能回到不认识新增迁移的旧二进制，也不能用旧数据库覆盖发布后的真实动作。

已经发布或写出的信息不能靠代码回退撤回。灾难恢复使用匹配备份并核对增量和外部副作用；真正执行恢复作为独立运维操作记录。

### 13.4 当前卡住的任务

保留原 Run 的权限、等待和错误事实。新能力完成后，如需继续，由 Owner 预览显式关联的新 Run，仅引入获准版本和完成事实；不直接改旧 audience、等待状态或复制完整私密历史。

G0–G6 不自动承诺迁移任意旧私密 Run。若旧 Run 缺少可验证来源/发布授权，明确拒绝自动承接，允许用户提供新的材料与目标。

## 14. 开发协作与阶段交付规范

每个阶段开始先核对本指导、代码和当前迁移号；按现有 AGENTS.md 使用项目约定。若采用多人/多 Agent 并行实现，先冻结共享类型和文件归属，再按公共契约、Runtime/持久化、UI、验证拆分，避免同时修改 scheduler 或迁移描述。

每个可审查提交说明具体触发场景、行为变化、兼容边界和验证命令。功能不可用时保持新能力准入关闭；文档不能先标为已完成。已经通过的检查仅在代码变化、失败或未消除疑虑时重跑相应范围。

阶段交付包括：代码/迁移、最小可用交互、适用测试、当前生效契约和报告。计划记录下一阶段依赖；一次受控复现、工具初始化或登录成功不等价于业务流程验收通过。

## 15. 完成定义与实施入口

- [x] G0：实际开发/验收基线明确，隔离完整调度复现及旧行为回归落库。
- [x] G1：Scope、manifest、输入来源、动作版本、能力包和默认权限检查完成。
- [ ] G2：模型 API 独立材料分批、明确回执和干净父恢复，最小 UI 与基础竞态通过。
- [ ] G3：确切发布、有限投影、私密汇总、专用批准/撤销/过期闭环通过。
- [ ] G4：崩溃、Stop、只读 any、未知副作用和费用矩阵通过。
- [ ] G5：每个宣称支持的 SDK/Codex/Coordination 组合分别完成适用验证。
- [ ] G6：通用场景、正常界面、灰度、兼容排空、文档和证据完成。
- [ ] 原始消息/文件/证据权限保持原含义；所有新发布可追溯。
- [ ] 未实现能力及自由文本自动披露边界在 UI、API 和文档中一致。

**下一实施入口：G2。** 接入模型 API 的逐项材料、接收义务、获准状态投影、干净父恢复和最小 UI，完成整包验收后再开放，并保留 G0 的 v2 基线。最终产品验收同时检查协作能继续、信息没有越界、责任没有提前完成，以及重试没有重复副作用。
