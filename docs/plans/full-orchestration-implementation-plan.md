# Agent Gand 完整编排功能实施方案

方案日期：2026-09-18  
方案状态：待评审  
适用范围：Agent Gand 可视化编排、工作流版本、执行引擎、调试、发布与运行治理  
前置成果：P1 计划 1–3 已完成；RunGraph、TraceTree、Task DAG、Supervisor、Collaboration、Approval 已可复用

## 1. 目标与预期结果

本方案将当前只读运行拓扑升级为完整编排 Studio。交付后，用户可以通过画布定义 Agent 团队的确定性流程、主管动态委派和自由协作流程，经静态校验和试运行后发布不可变版本，再通过聊天、API、Cron 或 Webhook 触发。运行中可以暂停、审批、恢复、重试、终止、调整预算并查看节点级 Trace 和产物。

最终用户路径：

```text
新建工作流
  → 从模板开始或使用空白画布
  → 拖入节点并连接控制流/数据流
  → 配置 Agent、工具、变量、权限、预算和失败策略
  → 实时校验
  → 单节点测试或完整试运行
  → 发布不可变版本
  → 通过聊天/API/Cron/Webhook 触发
  → 在实时画布和轨迹中监督
  → 审批、纠偏、重试或终止
  → 查看产物、成本、Trace 和运行历史
```

完成后应达到以下产品结果：

- 编排定义成为版本化资产，不再只存在于运行时分支代码中；
- 画布、JSON/YAML 和执行引擎使用同一份语义契约；
- 一个运行固定引用一个不可变工作流版本，可稳定重放和审计；
- Agent、Task、Tool、Approval、Collaboration、Memory 和 Trigger 都以节点能力接入；
- 每个节点都有输入、输出、状态、尝试次数、checkpoint、Span 和产物；
- 服务重启后从持久化 checkpoint 精确恢复，不重复已完成的副作用；
- 只读运行拓扑继续用于监督，可编辑画布只修改草稿或创建新版本；
- 历史 pipeline、supervisor、collaboration 入口继续工作，并可逐步映射为内置模板。

## 2. 产品边界

### 2.1 本方案包含

1. 工作流草稿、版本、发布、复制、归档和回滚；
2. 可编辑节点画布、属性面板、变量映射和实时校验；
3. 确定性节点执行、条件、并行、聚合、循环和子流程；
4. Agent、Supervisor、Reviewer 与 Collaboration 节点；
5. Tool、MCP、Approval、Wait、Knowledge、Memory、Artifact 节点接口；
6. checkpoint、暂停恢复、节点重试、工具幂等和崩溃恢复；
7. 聊天、API、Cron、Webhook 触发和触发历史；
8. 单节点测试、完整试运行、节点状态查看和图轨联动；
9. JSON/YAML 导入导出和工作流模板；
10. 权限、Secret 引用、预算、并发和资源策略。

### 2.2 暂不包含

- 多租户 RBAC、企业审计和计费结算；
- 多机器分布式队列和跨地域执行；
- 工作流市场和第三方插件市场；
- 任意 JavaScript/Python 表达式直接在服务进程执行；
- 多人同时编辑同一画布的 CRDT；
- 在已发布版本上原地修改定义。

这些能力不阻塞单机自托管版本，但领域模型需为后续扩展保留稳定 ID、版本和审计字段。

## 3. 核心设计原则

### 3.1 定义、版本、运行三层分离

- `Workflow` 是稳定身份和元数据；
- `WorkflowDraft` 是唯一可编辑对象，使用乐观锁；
- `WorkflowVersion` 是发布后的不可变快照；
- `Run` 固定引用 `workflowVersionId`，运行中不读取草稿；
- 运行时 `RunGraph` 是执行事实投影，不能反向覆盖定义。

### 3.2 JSON 为规范存储，YAML 为交换格式

数据库保存规范化 JSON，API 返回类型化 JSON。YAML 仅用于导入、导出和代码评审。导入后必须解析、规范化、校验，再写入草稿；禁止把未经校验的 YAML 直接交给运行时。

### 3.3 编译后执行

运行前把 `WorkflowDefinition` 编译成 `ExecutionPlan`：

```text
WorkflowDefinition
  → Schema 校验
  → 图结构校验
  → 引用与权限校验
  → 类型和变量校验
  → 环路/预算校验
  → 生成不可变 ExecutionPlan
  → 创建 Run 与初始 checkpoint
```

执行器只消费 `ExecutionPlan`，不直接解释画布 UI 数据。

### 3.4 状态驱动调度

节点状态和持久化队列是唯一调度依据。Agent 自由文本、聊天消息或画布标签不能直接改变执行状态。模型控制动作必须通过结构化协议解析和服务端校验后才能生效。

### 3.5 副作用默认至少一次，依靠幂等收口

每个节点执行生成稳定 `nodeExecutionId` 和 `idempotencyKey`。文件、Shell、HTTP、MCP、Webhook 和子流程调用必须声明幂等策略。无法安全重放的操作必须在 checkpoint 前完成确认，崩溃恢复时进入 `needs_attention`，由用户决定重试、跳过或人工补值。

### 3.6 有界动态性

Supervisor 和 Collaboration 可以动态创建任务、选择 Agent 和发起并行征询，但必须受以下边界约束：

- 允许使用的 Agent、工具和子流程白名单；
- 最大动态任务数、深度、并行度、轮数、Token 和成本；
- 动态节点不能修改已发布的工作流版本；
- 动态结构作为运行时 RunGraph 节点记录并接受 Trace 观测。

## 4. 总体架构

```text
┌──────────────────────────── Web Studio ────────────────────────────┐
│ Workflow List │ Node Library │ Editable Canvas │ Inspector/Debug  │
└───────────────────────────────┬────────────────────────────────────┘
                                │ REST + WebSocket
┌──────────────────────────── Server ────────────────────────────────┐
│ Workflow API │ Validator │ Compiler │ Publisher │ Trigger Gateway │
│                              │                                     │
│                    Durable Workflow Runtime                        │
│        Scheduler │ Node Registry │ Checkpoint │ Recovery           │
│                              │                                     │
│ Agent/Supervisor/Collab │ ToolRunner │ Approval │ Memory/RAG       │
│                              │                                     │
│ SQLite │ RunGraph │ TraceTree │ Artifacts │ Trigger History        │
└────────────────────────────────────────────────────────────────────┘
```

新增模块建议：

```text
packages/shared/src/workflow.ts
packages/shared/src/workflow-events.ts

apps/server/src/workflows/
  definitions.ts
  validation.ts
  compiler.ts
  repository.ts
  versions.ts
  templates.ts

apps/server/src/runtime/
  engine.ts
  scheduler.ts
  checkpoint.ts
  recovery.ts
  expressions.ts
  bindings.ts
  nodeRegistry.ts
  idempotency.ts
  nodes/
    start.ts
    agent.ts
    supervisor.ts
    collaboration.ts
    tool.ts
    condition.ts
    parallel.ts
    aggregate.ts
    approval.ts
    wait.ts
    subflow.ts
    output.ts

apps/server/src/triggers/
  cron.ts
  webhook.ts
  api.ts
  store.ts

apps/web/src/workflows/
  WorkflowStudio.tsx
  WorkflowList.tsx
  WorkflowCanvas.tsx
  NodeLibrary.tsx
  NodeInspector.tsx
  VariablePicker.tsx
  ValidationPanel.tsx
  RunConsole.tsx
  VersionHistory.tsx
```

## 5. 共享领域契约

### 5.1 工作流定义

新增 `packages/shared/src/workflow.ts`：

```ts
export interface Workflow {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  draftRevision: number;
  latestVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowDefinition {
  schemaVersion: 1;
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: WorkflowVariable[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  policies: WorkflowPolicies;
  canvas: CanvasMetadata;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  definition: WorkflowDefinition;
  definitionHash: string;
  changelog: string;
  publishedBy: string;
  createdAt: string;
}
```

`canvas` 只保存坐标、分组、便签和视口等展示信息。编译器不得根据坐标推断执行顺序。

### 5.2 节点通用结构

```ts
export interface WorkflowNodeBase {
  id: string;
  type: WorkflowNodeType;
  name: string;
  description?: string;
  disabled: boolean;
  inputBindings: Record<string, ValueBinding>;
  retryPolicy?: RetryPolicy;
  timeoutMs?: number;
  errorPolicy?: 'fail_run' | 'follow_error_edge' | 'continue' | 'wait_for_user';
}
```

节点使用判别联合，禁止用无约束的 `Record<string, unknown>` 代替核心配置。第一阶段节点类型：

```ts
export type WorkflowNodeType =
  | 'start' | 'agent' | 'supervisor' | 'collaboration'
  | 'task' | 'tool' | 'condition' | 'parallel' | 'aggregate'
  | 'approval' | 'wait' | 'transform' | 'subflow' | 'output';
```

后续扩展 `knowledge`、`memory`、`artifact` 时仍通过判别联合和 Node Handler 注册，不修改引擎主循环。

### 5.3 连线契约

```ts
export type WorkflowEdgeKind =
  | 'control' | 'condition' | 'error' | 'approval'
  | 'dependency' | 'message';

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  kind: WorkflowEdgeKind;
  fromPort?: string;
  toPort?: string;
  condition?: SafeExpression;
  priority: number;
  label?: string;
}
```

数据不通过隐式全局变量传递。节点输入由 `inputBindings` 显式引用：

```ts
export type ValueBinding =
  | { kind: 'literal'; value: JsonValue }
  | { kind: 'workflow_input'; path: string }
  | { kind: 'variable'; variableId: string; path?: string }
  | { kind: 'node_output'; nodeId: string; path?: string }
  | { kind: 'secret'; secretId: string }
  | { kind: 'template'; template: string };
```

控制条件使用受限表达式语法，建议采用 JSON Logic 或自研 AST，不使用 `eval`、`new Function` 或宿主 Shell。

### 5.4 变量作用域

| 作用域 | 生命周期 | 示例 |
|---|---|---|
| `workflow_input` | 单次 Run 创建时固定 | 用户需求、Webhook body |
| `run` | 当前运行共享 | 当前预算、全局汇总 |
| `node` | 单次节点执行 | 节点输入、输出、错误 |
| `task` | Task 与返工尝试 | 验收标准、Reviewer 反馈 |
| `agent` | Agent 当前调用 | 角色上下文、模型参数 |
| `artifact` | 产物引用 | 文件、报告、PR、URL |
| `secret` | 运行时只读引用 | API Key、Webhook Secret |

Secret 不进入 Trace input/output、不进入导出的 YAML，也不通过 WebSocket 下发。

### 5.5 工作流策略

```ts
export interface WorkflowPolicies {
  maxDurationMs: number;
  maxNodeExecutions: number;
  maxParallelism: number;
  maxDynamicDepth: number;
  maxTokens: number;
  maxCostUsd: number;
  onBudgetExceeded: 'fail' | 'wait_for_user';
  allowedAgentIds: string[];
  allowedTools: string[];
  workspacePolicy: 'run' | 'named' | 'external';
}
```

## 6. 节点能力定义

### 6.1 Start 节点

- 每个工作流只能有一个启用的 Start；
- 定义输入 JSON Schema 和默认值；
- 记录触发来源、调用者和幂等键；
- 支持 chat、manual、api、cron、webhook 入口。

### 6.2 Agent 节点

配置 Agent 版本、模型覆盖、Prompt 模板、工具白名单、权限、输出 Schema、预算和 Reviewer。运行时复用现有 `runAgentTurn`，并将节点输入转换成消息上下文。输出先完成 Schema 校验，再允许后继节点消费。

### 6.3 Supervisor 节点

配置可委派 Agent、默认 Reviewer、最大动态任务数和任务深度。复用现有 Task DAG、Scheduler、Attempt、Review，并将动态 Task 映射为 RunGraph 节点。Supervisor 输出必须包含结构化任务计划或最终汇总。

### 6.4 Collaboration 节点

配置初始成员、默认发言者选择、轮次/dispatch/Token/成本预算，以及是否允许提议正式 Supervisor Task。节点结束条件包括：明确结论、用户终止、预算终止、结构化控制动作或超时。

### 6.5 Task 节点

用于显式声明任务、依赖、执行者、Reviewer、验收标准和最大尝试次数。编译时把依赖边转换为任务 DAG；运行时继续使用现有 Task/Attempt/Review 数据结构。

### 6.6 Tool 节点

配置工具名、输入绑定、权限和幂等策略：

- `read_only`：允许自动安全重试；
- `idempotency_key`：调用方提供稳定键；
- `detect_then_apply`：重试前检查目标状态；
- `manual_recovery`：崩溃后进入人工处理；
- `never_retry`：失败后直接走错误边或终止。

Docker ToolRunner 完成后，Tool 节点增加镜像、挂载、网络、CPU、内存和超时配置。节点契约不随运行器变化。

### 6.7 Condition 节点

- 按边优先级从高到低求值；
- 第一条为真的边获胜；
- 可声明 default 边；
- 表达式只能读取显式输入和已完成节点输出；
- 求值错误进入节点错误策略。

### 6.8 Parallel 与 Aggregate 节点

Parallel 产生一个 batch，受工作流并发上限约束。Aggregate 支持 `all`、`any`、`quorum`、`best_effort` 四种收敛策略，并明确超时、部分失败和取消剩余分支行为。

### 6.9 Approval 节点

展示动作、理由、参数、diff 和风险，提供批准、拒绝、编辑、继续四类结构化结果。审批必须持久化 waiter 和 checkpoint；用户决定后由恢复队列唤醒，不依赖内存 Promise 轮询。

### 6.10 Wait 节点

支持等待指定时间、绝对时间或外部事件。等待期间不占用执行 worker。唤醒记录必须有唯一键，重复定时事件或 Webhook 不得重复推进节点。

### 6.11 Transform 节点

提供 JSON 映射、字段选择、数组投影和模板渲染。复杂转换应使用受限表达式或 Tool 节点；不在服务进程执行用户代码。

### 6.12 Subflow 节点

必须引用已发布的不可变版本。父 Run 记录 child Run ID；取消、预算和 Trace 通过明确策略向下传播。禁止子流程在同一调用链中递归引用自己，跨流程循环也必须由编译器检测。

### 6.13 Output 节点

按工作流输出 Schema 汇总字段和 Artifact，标记 Run 完成。缺少必填输出时不能进入 completed。

## 7. 持久化设计

新增表建议：

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  draft_definition TEXT NOT NULL,
  draft_revision INTEGER NOT NULL DEFAULT 1,
  latest_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  changelog TEXT NOT NULL DEFAULT '',
  published_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_id, version),
  UNIQUE(workflow_id, definition_hash)
);

ALTER TABLE runs ADD COLUMN workflow_id TEXT;
ALTER TABLE runs ADD COLUMN workflow_version_id TEXT;
ALTER TABLE runs ADD COLUMN trigger_id TEXT;
ALTER TABLE runs ADD COLUMN input TEXT;
ALTER TABLE runs ADD COLUMN output TEXT;
ALTER TABLE runs ADD COLUMN checkpoint_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workflow_node_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(run_id, node_id, attempt_no),
  UNIQUE(idempotency_key)
);

CREATE TABLE workflow_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  waiting_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE workflow_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_execution_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE workflow_triggers (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_version_id TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  secret_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_trigger_events (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT,
  run_id TEXT,
  error TEXT,
  received_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(trigger_id, idempotency_key)
);
```

迁移继续使用 `database.ts` 的幂等 `ensureColumn` 模式。表结构迁移与业务数据回填分开执行，避免启动事务长时间锁库。

## 8. 编译与静态校验

发布和运行前都必须调用同一个 validator。校验结果结构：

```ts
interface WorkflowDiagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
  suggestion?: string;
}
```

至少覆盖：

1. 单一入口、至少一个可达 Output；
2. 节点、边、端口 ID 唯一且引用存在；
3. 不可达节点、悬空边、无默认分支；
4. 非 Loop 结构中的控制流环；
5. Loop 必须有最大次数或明确超时；
6. Subflow 直接和间接递归；
7. 输入绑定来源存在且先于消费节点完成；
8. JSON Schema 类型兼容；
9. Agent、Reviewer、Tool、MCP、子流程版本存在并启用；
10. 权限模式与工具副作用冲突；
11. Secret 引用存在但不返回明文；
12. 并行写工作区的冲突风险；
13. 最大执行次数、并发、Token、成本和动态深度有效；
14. Approval/Wait 后存在可恢复路径；
15. errorPolicy 为 `follow_error_edge` 时存在错误边。

发布要求没有 error；warning 由用户明确确认后允许发布。试运行也不能绕过 error。

## 9. Durable Runtime

### 9.1 运行状态

扩展 Run 状态：

```text
pending → running
running → awaiting_approval | waiting_for_user | waiting_for_event
running → completed | failed | cancelled
waiting_* → running | failed | cancelled
```

如不希望立即修改公共 `RunStatus`，`waiting_for_event` 可先保存在 checkpoint 状态，并保持 Run 为 `waiting_for_user`；正式发布前应统一为明确状态。

### 9.2 节点执行状态

```text
queued → running → completed
                 → retry_scheduled → queued
                 → waiting
                 → failed
                 → needs_attention
                 → cancelled
```

每次状态转换和 checkpoint 写入必须在同一 SQLite 事务中完成。进程崩溃后不得出现“节点已完成但 checkpoint 未推进”的不可判断状态。

### 9.3 调度循环

```text
读取最新 checkpoint
  → 计算 ready 节点
  → 原子领取可执行节点
  → 按并发上限运行 Node Handler
  → 持久化输出/错误/Artifact/Span
  → 更新执行状态
  → 生成下一 checkpoint
  → 推送 workflow.node.updated 与 run.updated
  → 继续调度或进入等待/终态
```

同一 Run 只允许一个 scheduler lease owner。Node Handler 可以并行，但提交状态必须校验预期版本和 lease。

### 9.4 checkpoint 内容

```ts
interface WorkflowCheckpointState {
  planHash: string;
  completedNodeIds: string[];
  activeExecutionIds: string[];
  readyNodeIds: string[];
  waiting: WaitingDescriptor | null;
  variables: Record<string, JsonValue>;
  nodeOutputs: Record<string, JsonValue>;
  budgets: BudgetSnapshot;
  dynamicGraph: DynamicGraphSnapshot;
}
```

checkpoint 不重复保存大文件或完整 LLM 文本，只保存引用；正文继续存 NodeExecution、RunEvent、Message 和 Artifact。

### 9.5 启动恢复

启动时：

1. 查找非终态 workflow Run；
2. 中断租约过期的节点执行；
3. 读取最新 checkpoint 并校验 `planHash`；
4. 已完成且幂等键存在的节点不重放；
5. 安全重试节点重新入队；
6. 不可安全重试节点进入 `needs_attention`；
7. Approval/Wait 重新注册持久化 waiter；
8. 恢复 scheduler，并产生 recovery Span。

## 10. API 与 WebSocket

### 10.1 工作流管理

```text
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/:id
PATCH  /api/workflows/:id                 revision 乐观锁
DELETE /api/workflows/:id                 软归档
POST   /api/workflows/:id/validate
POST   /api/workflows/:id/publish
GET    /api/workflows/:id/versions
GET    /api/workflows/:id/versions/:version
POST   /api/workflows/:id/versions/:version/restore-draft
POST   /api/workflows/import
GET    /api/workflows/:id/export?format=json|yaml
```

### 10.2 测试与运行

```text
POST /api/workflows/:id/test-node
POST /api/workflows/:id/test-run
POST /api/workflow-versions/:versionId/runs
GET  /api/workflow-runs/:runId/state
POST /api/workflow-runs/:runId/pause
POST /api/workflow-runs/:runId/resume
POST /api/workflow-runs/:runId/cancel
POST /api/workflow-runs/:runId/nodes/:nodeId/retry
POST /api/workflow-runs/:runId/nodes/:nodeId/skip
POST /api/workflow-runs/:runId/nodes/:nodeId/provide-output
```

暂停、跳过和人工补值均属于受审计控制操作。终态 Run 不允许原地恢复，应 Fork 新 Run。

### 10.3 触发器

```text
GET    /api/workflows/:id/triggers
POST   /api/workflows/:id/triggers
PATCH  /api/workflow-triggers/:id
DELETE /api/workflow-triggers/:id
GET    /api/workflow-triggers/:id/events
POST   /api/hooks/:triggerId
```

### 10.4 WebSocket 事件

新增：

```ts
type WorkflowServerEvent =
  | { type: 'workflow.updated'; workflow: Workflow }
  | { type: 'workflow.published'; version: WorkflowVersion }
  | { type: 'workflow.run.updated'; runId: string; status: string; checkpointSeq: number }
  | { type: 'workflow.node.updated'; execution: WorkflowNodeExecution }
  | { type: 'workflow.artifact.created'; artifact: WorkflowArtifact }
  | { type: 'workflow.trigger.updated'; trigger: WorkflowTrigger };
```

客户端重连后仍以 REST 快照为准，WebSocket 只负责低延迟增量。

## 11. Studio 前端设计

### 11.1 页面布局

```text
┌────────────────────────────────────────────────────────────────────┐
│ 返回 │ 工作流名称 │ Draft v12 │ 校验 │ 试运行 │ 发布 │ 历史       │
├──────────────┬───────────────────────────────┬─────────────────────┤
│ 节点库       │ 可编辑画布                    │ 节点属性            │
│ 搜索         │ Start → Supervisor → Agent   │ 基础配置            │
│ Agent        │                ↘ Approval     │ 输入映射            │
│ Control      │ MiniMap / Zoom / Fit          │ 输出 Schema         │
│ Tool         │                               │ 权限/重试/错误策略  │
│ HITL         │                               │                     │
├──────────────┴───────────────────────────────┴─────────────────────┤
│ 校验结果 / 运行控制台 / Trace / 变量 / 产物                       │
└────────────────────────────────────────────────────────────────────┘
```

### 11.2 画布交互

- 从节点库拖入画布或使用快捷添加；
- 端口只允许兼容的边类型连接；
- 连接时即时提示类型和作用域错误；
- 多选、复制、粘贴、删除、撤销、重做；
- 自动布局、适配窗口、小地图、框选；
- 节点分组、便签和锁定位置；
- 未保存、校验失败、已发布版本状态常驻可见；
- 键盘可完成新增、连接、选择、删除和打开属性；
- 已发布版本使用只读模式打开。

第一版不需要协同编辑，但必须提供离开页面时未保存提醒和 revision 冲突处理。

### 11.3 属性面板

属性面板按节点类型加载配置表单，使用共享 JSON Schema/类型生成基础字段，复杂节点使用专用编辑器。输入映射必须使用变量选择器，允许预览解析后的示例值。

### 11.4 调试面板

提供五个标签：

- **运行**：输入表单、开始、暂停、终止、状态；
- **节点**：每个节点输入、输出、尝试和错误；
- **变量**：当前 checkpoint 变量快照；
- **Trace**：复用现有 TrajectoryPanel；
- **产物**：文件、URL、报告和子 Run。

运行时画布根据 `workflow.node.updated` 着色：queued 灰、running 蓝、waiting 黄、completed 绿、failed 红、needs_attention 橙。

### 11.5 图轨联动

- 点击定义节点，运行控制台筛选该节点全部执行尝试；
- 点击运行节点或 Span，反向选择定义节点；
- 动态 Task/Dispatch 显示在运行图的展开层，不写回定义图；
- 同一节点多次循环执行时，在右侧展示 attempt 列表。

## 12. 发布与触发

### 12.1 发布流程

1. 保存最新草稿；
2. 完整校验；
3. 用户填写 changelog；
4. 规范化定义并计算 SHA-256；
5. 事务内创建不可变版本并更新 `latestVersion`；
6. 推送发布事件；
7. 已启用触发器继续引用原版本，用户明确升级后才切换。

相同 definition hash 不重复创建新版本。

### 12.2 触发幂等

- 手工和聊天触发使用客户端生成的 request ID；
- Webhook 优先读取上游事件 ID，否则按受控字段计算 hash；
- Cron 使用 `triggerId + scheduledAt`；
- API 使用 `Idempotency-Key` 请求头；
- 相同 trigger 和 idempotency key 只创建一个 Run。

### 12.3 Cron

使用明确时区和服务端计算的下一触发时间，保存错过策略：`skip`、`fire_once`、`catch_up_limited`。服务重启后根据持久化计划恢复，不依赖进程内唯一计时器。

### 12.4 Webhook

支持签名校验、请求体大小限制、速率限制和响应策略。第一版收到事件后快速返回 `202`，运行结果通过查询接口获取，避免长连接等待 Agent 完成。

## 13. 权限、安全与资源治理

- 工作流定义只引用 Secret ID，不保存 Secret 明文；
- Agent 节点不能扩大其 AgentDefinition 的工具权限；
- 工作流 allowedTools 与 Agent tools 取交集；
- Approval 节点不能被模型自由文本绕过；
- 外部工作区和 Docker 挂载需显式声明；
- Webhook 输入通过 Schema、大小和内容类型校验；
- Transform/Condition 使用安全表达式；
- 子流程继承父级预算上限并设置局部上限；
- 每次控制操作记录 actor、时间、旧状态、新状态和原因；
- Trace 中对 Secret、认证头和配置的敏感字段统一脱敏。

## 14. 与现有模式的兼容和迁移

### 14.1 保持现有入口

现有 `/api/conversations`、pipeline、supervisor、collaboration 不立即删除。新增 Workflow Runtime 后，旧入口继续调用原编排器，直至模板运行路径通过回归。

### 14.2 内置模板

提供三个只读系统模板：

1. `system:pipeline`：Start → Agent 1 → … → Agent N → Output；
2. `system:supervisor`：Start → Supervisor → Task Schedule → Summary → Output；
3. `system:collaboration`：Start → Collaboration → Optional Supervisor Task → Output。

第二阶段让新创建的旧模式 Run 通过这些模板运行，但 API 响应保持兼容。历史 Run 不回填虚假的 workflow version，只保留 RunGraph/TraceTree 读取能力。

### 14.3 Agent 快照

发布版本保存 Agent ID 和版本约束；创建 Run 时继续生成 `run_agent_snapshots`。运行过程中即使角色被编辑，当前 Run 仍使用快照。

## 15. 实施阶段

### 阶段 0：决策冻结与契约

工作内容：

- 冻结节点清单、表达式语言、变量绑定和版本语义；
- 新增共享类型与 JSON Schema；
- 编写有效/无效 workflow fixtures；
- 确认历史模式迁移边界。

完成判据：共享包可以解析、规范化和序列化全部第一版节点；破坏性契约问题在写数据库前解决。

### 阶段 1：草稿、版本与校验器

工作内容：

- 新增 workflows/workflow_versions 表和 repository；
- 实现 CRUD、乐观锁、软归档、发布和恢复草稿；
- 实现结构、引用、类型、环路、权限和预算校验；
- 实现 JSON/YAML 导入导出。

完成判据：两个客户端并发保存不会静默覆盖；无效图不能发布；版本不可修改；导出再导入保持语义一致。

### 阶段 2：可编辑 Studio

工作内容：

- 工作流列表、模板入口和 Studio 外壳；
- 节点库、React Flow 编辑画布、端口和边；
- ELK 自动布局、撤销重做、复制粘贴、便签分组；
- 节点属性、变量选择器和校验面板；
- 未保存提醒和 revision 冲突 UI。

完成判据：用户无需编辑 JSON 即可构建并保存包含条件、并行、审批的有效工作流；键盘可完成核心操作。

### 阶段 3：确定性执行内核

工作内容：

- compiler、ExecutionPlan、Node Registry；
- Start、Condition、Parallel、Aggregate、Transform、Output；
- 节点执行、变量、错误边、重试和预算；
- NodeExecution、Artifact 和 Span；
- 运行画布和调试面板。

完成判据：确定性工作流可执行、失败、重试和聚合；RunGraph/TraceTree 与节点执行一致。

### 阶段 4：Agent 与动态协作节点

工作内容：

- Agent、Task、Supervisor、Collaboration、Subflow Handler；
- 复用 runAgentTurn、Scheduler、Review 和 Collaboration 控制协议；
- 动态任务/dispatch 映射到运行图；
- 模板化现有三种模式。

完成判据：Pipeline、Supervisor 返工、Collaboration 并行征询和正式任务升级均能在 Workflow Runtime 中完成，结果与旧入口回归一致。

### 阶段 5：Durable execution 与 HITL

工作内容：

- checkpoint、scheduler lease、恢复队列；
- Approval/Wait 持久化唤醒；
- Tool 幂等策略与 needs_attention；
- 暂停、继续、取消、节点重试、跳过和人工补值；
- 崩溃注入测试。

完成判据：在 Agent、Tool、Approval、Parallel、Subflow 各阶段强制杀进程后，重启能精确恢复；已完成副作用不重复。

### 阶段 6：工具隔离和平台节点

工作内容：

- Tool 节点接入 Docker ToolRunner；
- Knowledge、Memory、Artifact Handler 接口；
- 网络、挂载、资源和超时策略；
- 节点级产物收集。

完成判据：工具在容器策略内执行并可靠清理；知识和记忆节点可被编排但不泄露跨作用域数据。

### 阶段 7：发布与触发

工作内容：

- Trigger 管理、Cron scheduler、Webhook gateway、API 触发；
- 幂等键、启停、重试和历史；
- 版本升级和触发器固定版本策略。

完成判据：重复事件不重复创建 Run；服务重启不丢计划；触发历史可以定位对应 Run 和失败原因。

### 阶段 8：体验收口与迁移

工作内容：

- 单节点测试、完整试运行、模板和示例；
- 1,000 节点定义校验、1,000 Span 运行观测和大图性能；
- 可访问性、窄屏只读监督和错误文案；
- 新建 pipeline/supervisor/collaboration 切换到系统模板；
- 旧运行路径进入兼容维护期。

完成判据：新用户可从模板完成创建、测试、发布和触发；旧 API 回归通过；性能与恢复验收全部通过。

## 16. 测试策略

### 16.1 契约与校验

- 所有节点配置的解析、默认值和序列化；
- 非法节点、边、端口、变量和 Schema；
- 循环、Subflow 递归和不可达节点；
- 导入导出 round-trip；
- 定义 hash 稳定性。

### 16.2 Runtime

- 顺序、分支、并行、聚合、循环和错误边；
- Agent 输出 Schema 失败；
- Reviewer FAIL → 返工 → PASS；
- Collaboration handoff/fanout/aggregate；
- 子流程成功、失败、取消和预算传播；
- 超时、重试和最大执行次数。

### 16.3 Durable 与幂等

在以下时间点强制终止服务：

- 节点领取后、执行前；
- LLM 调用中；
- Tool 副作用完成后、状态提交前；
- Approval 等待中；
- Parallel 部分分支完成时；
- checkpoint 写入前后；
- 子流程运行中。

验证重启后无重复完成、无永久 running、无丢失审批、无预算倒退。

### 16.4 前端

- 画布 CRUD、连接、撤销重做和自动布局；
- 属性表单与变量映射；
- revision 冲突；
- 运行实时着色和断线恢复；
- 图轨联动；
- 键盘、ARIA、焦点和窄屏；
- 1,000 节点只读图与 1,000 Span 轨迹。

### 16.5 回归命令

新增：

```text
pnpm verify:workflow-contract
pnpm verify:workflow-validation
pnpm verify:workflow-runtime
pnpm verify:workflow-recovery
pnpm verify:workflow-triggers
pnpm verify:workflow-ui
```

并持续运行现有：

```text
pnpm typecheck
pnpm verify:scheduler
pnpm verify:collaboration
pnpm verify:p0-tools
pnpm verify:observability
pnpm --filter @agent-gand/web build
```

## 17. 验收场景

### 场景 A：固定研发流水线

Start → Planner → Coder → Reviewer → Approval → Output。Reviewer 首轮 FAIL，Coder 自动收到结构化问题并返工，第二轮 PASS，用户批准后输出 Artifact。

验收：画布状态、Task、Attempt、Review、Approval、Trace、成本和最终输出一致。

### 场景 B：并行调研

Start → Parallel(3 Agent) → Aggregate(quorum=2) → Writer → Output。

验收：一个分支超时仍可按 quorum 收敛；取消的分支有明确状态；聚合输入可追溯。

### 场景 C：自由协作升级正式任务

Start → Collaboration → Supervisor Task Proposal → 用户批准 → Subflow(supervisor) → Output。

验收：讨论消息、dispatch、用户决定、linked Run 和产物关联完整。

### 场景 D：Durable Approval

Tool → Approval 等待时关闭服务，数小时后重启并批准。

验收：原 Run 从同一节点继续；工具不重复；审批和 checkpoint 可审计。

### 场景 E：Webhook 幂等

同一外部事件重复发送三次。

验收：只创建一个 Run，触发历史记录三次接收和一次实际执行。

### 场景 F：版本隔离

发布 v1 后启动长 Run，同时修改草稿并发布 v2。

验收：旧 Run 始终使用 v1；新触发器升级后使用 v2；两个版本可独立查看和导出。

## 18. 风险与控制

| 风险 | 控制 |
|---|---|
| 画布模型与运行模型逐渐分叉 | WorkflowDefinition 单一契约，编译器生成 ExecutionPlan，RunGraph 只做事实投影 |
| 动态 Agent 行为无法画成固定图 | 定义图展示能力边界，运行图展开动态 Task/Dispatch |
| 任意表达式带来安全风险 | 受限 AST/JSON Logic，禁止 eval 和宿主代码 |
| 崩溃后副作用重复 | 稳定幂等键、节点事务、detect-then-apply、needs_attention |
| 大图难读 | 分组、子流程、自动布局、搜索、小地图、折叠和只读运行视图 |
| 版本修改影响运行中任务 | Run 固定 workflowVersionId 和 Agent 快照 |
| 实时事件丢失 | WebSocket 增量、REST 快照校准、checkpoint 序号 |
| 节点类型持续膨胀 | Node Registry + 判别联合，平台能力通过 Handler 扩展 |
| 一次性改造破坏旧模式 | 双运行路径、系统模板对照回归、分阶段切换 |
| ELK 和编辑器增加首屏体积 | Studio、React Flow、ELK 按路由和功能动态加载 |

## 19. 建议的实施顺序与评审门

完整编排依赖 durable execution，因此建议按以下顺序执行：

1. 先完成阶段 0–1，冻结契约并交付版本化定义；
2. 阶段 2 Studio 与阶段 3 确定性 Runtime 可以在契约稳定后并行推进；
3. 阶段 4 接入现有 Agent 能力；
4. 阶段 5 完成 durable execution，作为正式发布硬门槛；
5. 阶段 6–7 接入 Docker、Knowledge、Memory、Cron 和 Webhook；
6. 阶段 8 完成旧入口迁移和整体验收。

每个阶段必须满足自己的完成判据，并保留可演示的端到端路径。阶段 1 评审重点是 DSL 和版本模型；阶段 3 评审重点是执行语义；阶段 5 评审重点是崩溃恢复和副作用安全；阶段 8 才认定完整编排正式可用。

## 20. 最终完成定义

只有同时满足以下条件，完整编排功能才算完成：

- 用户可以通过画布创建、校验、测试、发布和版本化工作流；
- 确定性、Supervisor 和 Collaboration 三种语义可以组合使用；
- 条件、并行、聚合、循环、审批、等待和子流程可执行；
- Run 固定不可变版本，历史可以完整回看；
- 服务崩溃后从 checkpoint 精确恢复，副作用不重复；
- 聊天、API、Cron、Webhook 触发具备幂等和历史；
- 节点状态、Trace、消息、审批、预算和产物统一关联；
- 图轨双向联动，千节点/千 Span 数据集通过性能验收；
- 旧 Pipeline、Supervisor、Collaboration API 与历史数据保持兼容；
- 全部新增回归与现有回归通过，文档和内置模板可供新用户直接使用。

