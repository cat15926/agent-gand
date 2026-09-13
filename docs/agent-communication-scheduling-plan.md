# Agent 间通信与调度实施方案

> 状态：核心闭环已实施
> 适用范围：`agent-gand` 主管委派模式及公共 Agent 执行内核
> 目标：实现可持久化、可恢复、可观测的 Agent 通信与任务调度闭环，重点支持 `Coder 实现 → Reviewer 审查 → Coder 修复 → Reviewer 复审`。

已实施范围包括扩展任务状态、TaskAttempt/TaskReview、结构化 Agent 消息、DAG ready-wave 调度、Reviewer 返工循环、显式主管、启动恢复、手工重试、REST/WS 契约和任务时间线。Pipeline 保持固定顺序；Agent 自主调用 `agent.send_message` 等内部工具留作后续增强。

## 1. 背景与现状

当前平台已经具备以下基础能力：

- Agent 定义、模型路由和工具权限；
- Pipeline 与 Supervisor 两种编排器；
- SQLite 任务、消息、审批和 Trace 落盘；
- `pending → in_progress → completed` 三态任务；
- `blockedBy` 依赖和基于 `BEGIN IMMEDIATE` 的任务认领；
- REST hydrate 与 WebSocket 增量通知。

当前消息系统主要承担持久化和 UI 展示。消息不会触发目标 Agent 再次运行，Supervisor 也不会读取 Reviewer 的结论并创建返工任务。

Supervisor 模式还存在两个直接影响协作质量的问题：

1. `blockedBy` 只控制执行顺序，后置任务没有收到前置任务的实际产出；
2. Supervisor 最终汇总只收到任务标题和原始目标，没有收到 worker 的实际结果和 Review 结论。

因此当前系统可以记录 Agent 之间的消息，但尚未形成由通信驱动的调度闭环。

## 2. 目标与边界

### 2.1 本次目标

实现以下完整流程：

```text
Supervisor 拆解任务
    ↓
Scheduler 选择依赖已完成的任务
    ↓
Coder 执行
    ↓
自动提交 Reviewer
    ↓
Reviewer 输出结构化结论
    ├─ PASS → 任务完成
    └─ FAIL → 问题发送给 Coder
                  ↓
              Coder 修复
                  ↓
              Reviewer 复审
                  ↓
          PASS 或达到最大返工次数
    ↓
Supervisor 读取所有真实产出并汇总
```

交付后应满足：

- Agent 消息持久化，并能按 run、task、发送者和接收者检索；
- 任务状态驱动调度，普通聊天文本不能直接改变控制状态；
- Coder 的结果会进入 Reviewer 上下文；
- Reviewer 的问题会进入下一轮 Coder 上下文；
- 后置任务会收到其依赖任务的最终产出；
- 无依赖任务可受控并行；
- 进程重启后可以恢复未完成任务；
- Supervisor 基于真实任务结果和审查结果汇总；
- 只有全部必要任务 Review PASS，run 才能进入 `completed`。

### 2.2 暂不包含

- 跨进程或跨机器的分布式队列；
- Agent 间 A2A 网络协议；
- 动态创建未知 Agent；
- 长期记忆或 RAG；
- Agent 消息替代人工敏感操作审批。

第一版继续以单机 SQLite 为持久化基础，但数据结构需要为后续分布式执行保留迁移空间。

## 3. 核心设计原则

### 3.1 消息负责通信，状态负责调度

消息是 Agent 交流内容和审计记录。任务状态机是唯一调度依据。

例如 Reviewer 发送 `revision_request` 后，服务端同时通过受控状态转换把任务从 `awaiting_review` 更新为 `needs_revision`。Scheduler 只响应任务状态，不解析普通消息中的 `FAIL` 字样。

### 3.2 所有执行结果持久化

每次 Coder 执行、返工、Reviewer 审查和复审都记录为独立 attempt。不能只覆盖 Task 上的最后结果，否则无法审计返工过程，也无法在重启后恢复。

### 3.3 控制面与 Agent 自由文本分离

Reviewer 的 PASS/FAIL 必须使用结构化协议。模型自由文本用于解释结论，`verdict` 字段用于驱动状态转换。

### 3.4 至少一次执行与幂等恢复

单机进程也可能在模型调用或工具调用中途退出。Scheduler 使用租约识别遗留的 `running` attempt，并安全重试。每个 attempt 有独立 ID，重复恢复不会覆盖已经完成的证据。

## 4. 领域模型改造

### 4.1 Task 状态扩展

修改 `packages/shared/src/task.ts`：

```ts
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'awaiting_review'
  | 'needs_revision'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

Task 增加以下字段：

```ts
export type TaskKind = 'work' | 'review';

export interface Task {
  // 现有字段保持不变
  kind: TaskKind;
  reviewerId: string | null;
  acceptanceCriteria: string[];
  result: string | null;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
}
```

字段含义：

| 字段 | 含义 |
|---|---|
| `kind` | 工作任务或独立审查任务；第一版主要使用 `work` |
| `reviewerId` | 指定审查者；允许为 `null` 表示无需审查 |
| `acceptanceCriteria` | Reviewer 的结构化验收依据 |
| `result` | 最近一次通过审查的最终结果，或无需审查任务的执行结果 |
| `attempt` | 已开始的工作执行次数 |
| `maxAttempts` | 最大工作执行次数，默认 3 |
| `lastError` | 最近一次执行或审查失败原因 |

### 4.2 TaskAttempt

在 `packages/shared/src/task.ts` 增加：

```ts
export type TaskAttemptKind = 'work' | 'review';
export type TaskAttemptStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TaskAttempt {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  kind: TaskAttemptKind;
  attemptNo: number;
  status: TaskAttemptStatus;
  inputContext: string | null;
  output: string | null;
  error: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
```

### 4.3 TaskReview

新增 `packages/shared/src/review.ts`：

```ts
export type ReviewVerdict = 'PASS' | 'FAIL';
export type ReviewSeverity = 'blocking' | 'warning';

export interface ReviewIssue {
  severity: ReviewSeverity;
  file?: string;
  line?: number;
  problem: string;
  suggestion: string;
}

export interface TaskReview {
  id: string;
  taskId: string;
  attemptId: string;
  reviewerId: string;
  verdict: ReviewVerdict;
  summary: string;
  issues: ReviewIssue[];
  createdAt: string;
}
```

### 4.4 Agent 消息扩展

修改 `packages/shared/src/message.ts`：

```ts
export type AgentMessageType =
  | 'assignment'
  | 'result'
  | 'review_request'
  | 'review_result'
  | 'revision_request'
  | 'handoff'
  | 'informational';

export interface Message {
  // 现有字段保持不变
  taskId: string | null;
  replyTo: string | null;
  messageType: AgentMessageType;
  payload: Record<string, unknown> | null;
}
```

`body` 继续用于人类可读内容，`payload` 保存调度和 UI 需要的结构化数据。

## 5. 数据库迁移

### 5.1 tasks 表增量字段

```sql
ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'work';
ALTER TABLE tasks ADD COLUMN reviewer_id TEXT;
ALTER TABLE tasks ADD COLUMN acceptance_criteria TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN result TEXT;
ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN last_error TEXT;
```

### 5.2 task_attempts 表

```sql
CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,
  input_context TEXT,
  output TEXT,
  error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attempts_task
  ON task_attempts(task_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_attempts_status_lease
  ON task_attempts(status, lease_expires_at);
```

### 5.3 task_reviews 表

```sql
CREATE TABLE IF NOT EXISTS task_reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  summary TEXT NOT NULL,
  issues TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_task
  ON task_reviews(task_id, created_at);
```

### 5.4 messages 表增量字段

```sql
ALTER TABLE messages ADD COLUMN task_id TEXT;
ALTER TABLE messages ADD COLUMN reply_to TEXT;
ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'informational';
ALTER TABLE messages ADD COLUMN payload TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_recipient
  ON messages(run_id, to_agent, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_task
  ON messages(task_id, created_at);
```

数据库初始化继续沿用当前幂等轻量迁移模式：启动时检查 `PRAGMA table_info`，仅补不存在的字段。已有三态任务不做破坏性转换，原 `completed` 数据继续有效。

## 6. 服务端模块设计

新增模块：

```text
apps/server/src/
├── orchestration/
│   ├── scheduler.ts
│   ├── stateMachine.ts
│   ├── contextBuilder.ts
│   ├── reviewStep.ts
│   └── supervisor.ts
├── messaging/
│   ├── inbox.ts
│   └── delivery.ts
└── tasks/
    ├── attempts.ts
    └── reviews.ts
```

### 6.1 stateMachine.ts

集中声明合法状态转换：

```text
pending          → in_progress | cancelled
in_progress      → awaiting_review | completed | failed
awaiting_review  → completed | needs_revision | failed
needs_revision   → in_progress | failed | cancelled
completed        → 终态
failed           → 终态；仅显式 retry 可回到 pending
cancelled        → 终态
```

提供领域函数：

```ts
transitionTask(taskId, {
  expectedStatus,
  nextStatus,
  result?,
  error?,
}): Task
```

状态检查与更新必须放在同一个 `BEGIN IMMEDIATE` 事务内。业务模块不得绕过状态机直接修改 `tasks.status`。

### 6.2 scheduler.ts

Scheduler 负责：

1. 查找 `pending` 或 `needs_revision` 的可运行任务；
2. 验证所有 `blockedBy` 任务均为 `completed`；
3. 在事务中占用任务并创建 work attempt；
4. 受并发上限控制地调用 Agent；
5. 根据结果提交 Reviewer 或完成任务；
6. 根据 Review 结果完成、返工或失败；
7. 所有任务进入终态后结束 run。

建议配置：

```env
ORCHESTRATOR_CONCURRENCY=2
TASK_MAX_ATTEMPTS=3
TASK_LEASE_MS=300000
```

Scheduler 可以先实现为进程内事件驱动循环。每次 Task 状态改变后触发一次 `tick(runId)`，同时使用 run 级互斥防止同一 run 的多个 tick 重叠。

领取工作必须依赖数据库条件更新，不能只依赖内存锁：

```sql
UPDATE tasks
SET status = 'in_progress', assignee = ?, attempt = attempt + 1
WHERE id = ? AND status IN ('pending', 'needs_revision');
```

受影响行数必须为 1，否则说明任务已被其他执行器领取。

### 6.3 contextBuilder.ts

统一构建 Agent 输入，避免每个编排器自行拼接导致数据遗漏。

Coder 首次执行上下文：

```text
总体目标
当前任务标题和说明
验收标准
依赖任务的最终结果
工作区规则
```

Coder 返工上下文：

```text
总体目标
原任务和验收标准
上一次 Coder 输出
Reviewer 的 summary 和 issues
相关文件及行号
当前重试次数和剩余次数
```

Reviewer 上下文：

```text
总体目标
任务验收标准
Coder 本次输出
Coder 使用的工具结果
依赖任务结果
当前工作区
```

Supervisor 汇总上下文：

```text
每项任务的最终结果
每项 Review 的 verdict 和 warning
失败任务及原因
实际产物路径
```

上下文必须从数据库中的 Task、Attempt、Review、Message 和 Trace 构建，使断线或重启不影响结果。

### 6.4 reviewStep.ts

Reviewer 必须返回结构化结果：

```json
{
  "verdict": "FAIL",
  "summary": "WebSocket 未执行身份认证",
  "issues": [
    {
      "severity": "blocking",
      "file": "apps/server/src/api/ws.ts",
      "line": 15,
      "problem": "连接升级前没有验证 session",
      "suggestion": "在 WebSocket handler 进入前复用 REST 认证逻辑"
    }
  ]
}
```

校验规则：

- `verdict` 只能是 `PASS` 或 `FAIL`；
- `FAIL` 至少包含一个 `blocking` issue；
- `PASS` 不允许包含 `blocking` issue；
- 每个 issue 必须包含 `problem` 和 `suggestion`；
- 无效 JSON 自动重试一次；
- 第二次仍无效时，本次 review attempt 标记为 `failed`，任务不允许被误判为通过。

第一版复用现有 `chatOnce`，增加专用 `reviewOnce` 和解析函数。后续 Provider 支持结构化输出时再切换为原生 JSON Schema。

### 6.5 inbox.ts 与 delivery.ts

`inbox.ts` 增加：

```ts
sendAgentMessage(input): Message
listForAgent(runId, agentId, options?): Message[]
listForTask(taskId): Message[]
getThread(messageId): Message[]
```

`delivery.ts` 负责产生标准消息：

```text
Supervisor → Coder       assignment
Coder → Reviewer         review_request
Reviewer → Coder         revision_request
Coder → Reviewer         review_request
Reviewer → Supervisor    review_result
```

第一版由编排器和 Scheduler 可靠地产生这些消息。后续可增加以下 Agent 内部工具：

```text
agent.send_message
task.request_review
task.report_blocker
```

内部工具必须限制为当前 run、当前团队和当前任务。它们不能批准外部写入等需要人工确认的操作。

## 7. Supervisor 模式改造

重构 `apps/server/src/orchestration/supervisor.ts`：

1. 使用一次结构化 LLM 调用生成执行计划；
2. 每个 Task 指定 assignee、reviewer、验收标准和依赖；
3. 校验计划后批量落库；
4. 将 run 交给 Scheduler；
5. Scheduler 完成执行、审查和返工循环；
6. 所有任务进入终态后，Supervisor 基于真实结果生成总结；
7. 所有必要任务通过才将 run 标记为 `completed`。

规划协议：

```json
{
  "tasks": [
    {
      "title": "实现身份认证",
      "body": "为 REST 和 WebSocket 增加认证",
      "acceptanceCriteria": [
        "未认证 REST 请求返回 401",
        "未认证 WebSocket 无法连接"
      ],
      "assignee": "coder",
      "reviewer": "reviewer",
      "blockedBy": []
    }
  ]
}
```

计划校验增加：

- 任务数必须为 1～5，超过 5 直接判为无效，不能静默截断；
- assignee 和 reviewer 必须属于当前 run 的 Agent；
- reviewer 不能等于 assignee，只有单 Agent 模式允许自审；
- 标题非空且唯一；
- blockedBy 引用存在且无环；
- acceptanceCriteria 至少一项；
- 没有 reviewer 的任务需要明确标记 `reviewRequired: false`。

API 增加显式 `supervisorId`，不再依赖 `agentIds[0]` 的隐式顺序：

```ts
POST /api/runs
{
  "goal": "...",
  "mode": "supervisor",
  "supervisorId": "planner",
  "agentIds": ["planner", "coder", "reviewer"]
}
```

## 8. Pipeline 模式兼容

Pipeline 保持用户指定顺序的执行语义，不自动创建返工环。

本次改造中 Pipeline 复用：

- `contextBuilder` 的消息格式；
- 扩展后的 Agent 消息结构；
- TaskAttempt、Trace 和错误记录能力；
- 公共工具调用和审批逻辑。

可以在后续版本增加可选参数 `reviewLoop: true`，将最后一个 Reviewer 的结构化结果用于回退到指定 Coder。第一版不改变现有 Pipeline 的完成语义，避免影响已有用例。

## 9. Run 完成规则

Run 状态由 Scheduler 统一计算：

| 条件 | Run 状态 |
|---|---|
| 存在执行中任务 | `running` |
| 存在工具审批 | `awaiting_approval` |
| 全部必要任务 `completed` | `completed` |
| 任一必要任务达到最大尝试次数 | `failed` |
| 存在非终态任务但没有可运行任务 | `failed`，错误为依赖死锁或状态异常 |

禁止出现以下不一致：

```text
Reviewer verdict = FAIL
Task status = completed
Run status = completed
```

## 10. 崩溃恢复

每个运行中的 attempt 写入 `lease_owner` 和 `lease_expires_at`。服务启动时执行恢复：

1. 查找 `status='running'` 且租约已过期的 attempt；
2. 将 attempt 标记为 `failed`，错误注明进程中断；
3. 未达到最大次数的 Task 恢复为 `pending` 或 `needs_revision`；
4. 达到最大次数的 Task 标记 `failed`；
5. 扫描所有 `running` run，重新触发 Scheduler；
6. `awaiting_review` Task 重新创建尚未完成的 Review attempt；
7. 工具审批继续遵守现有 durable pause/resume 的后续改造约束。

模型和工具调用无法保证恰好一次。涉及文件写入时依靠工作区、attempt ID、工具 Trace 和 Agent prompt 尽量实现幂等；外部工作区写入仍保持逐次人工审批。

## 11. API 与 WebSocket

### 11.1 REST API

新增：

```text
GET  /api/tasks/:id
GET  /api/tasks/:id/attempts
GET  /api/tasks/:id/reviews
POST /api/tasks/:id/retry
POST /api/tasks/:id/cancel
GET  /api/messages?runId=&agentId=&taskId=&messageType=
```

`POST /api/tasks/:id/retry` 仅允许终态 `failed` Task 回到 `pending`，并保留原 attempts 和 reviews。

### 11.2 WebSocket 事件

扩展 `packages/shared/src/events.ts`：

```ts
| { type: 'task.attempt.updated'; attempt: TaskAttempt }
| { type: 'review.updated'; review: TaskReview }
| {
    type: 'scheduler.updated';
    runId: string;
    active: number;
    queued: number;
  }
```

现有 `message`、`task.updated`、`run.updated` 和 `run.event` 继续使用。前端按 ID upsert，避免开始和结束事件产生重复记录。

## 12. 前端预期结果

### 12.1 任务卡片

```text
┌ 身份认证                                      ┐
│ Coder · 第 2/3 次执行                         │
│ 状态：等待复审                                │
│                                               │
│ ✓ 第一次实现                                  │
│ ✗ Reviewer：发现 2 个阻塞问题                 │
│ ✓ Coder：已修复 WebSocket 认证和过期处理       │
│ ◌ Reviewer：复审中                            │
└───────────────────────────────────────────────┘
```

### 12.2 消息流

```text
主管 → Coder
请实现身份认证，验收标准共 2 项。

Coder → Reviewer
实现完成，修改 auth.ts、routes.ts 和 ws.ts，请审查。

Reviewer → Coder
FAIL：WebSocket 未验证 session；token 过期测试缺失。

Coder → Reviewer
已修复两个问题，请复审。

Reviewer → 主管
PASS：全部验收标准满足。
```

### 12.3 最终结果

```text
运行状态：completed

任务：实现身份认证
执行次数：2
最终审查：PASS
修改文件：3
遗留警告：0

主管总结：
身份认证已经覆盖 REST 和 WebSocket。Reviewer 第一轮发现
WebSocket 未验证 session，Coder 完成修复后复审通过。
```

前端需要增加：

- Task 状态和执行次数；
- attempt 时间线；
- Review verdict、问题文件和行号；
- “人工重试”和“取消任务”操作；
- 当前 Scheduler 并发数和队列数；
- 显式 Supervisor 选择器。

## 13. 实施阶段

### 阶段 A：契约与持久化

- 扩展 shared 类型；
- 增加 SQLite 幂等迁移；
- 实现 Attempt、Review、Message 查询服务；
- 保持旧数据可读取。

完成标志：领域服务单测通过，旧数据库启动无报错。

### 阶段 B：单任务 Review 闭环

- 实现状态机；
- 实现 contextBuilder；
- 实现结构化 reviewStep；
- 跑通 Coder → Reviewer → 修复 → 复审。

完成标志：Reviewer 首轮 FAIL、第二轮 PASS 时 Task 正确完成，并保留两轮执行证据。

### 阶段 C：Scheduler 与 DAG

- 实现 ready task 选择；
- 增加并发限制和数据库领取；
- 将依赖任务结果传给后置任务；
- 实现失败传播和最大重试次数。

完成标志：独立任务并行，有依赖任务按顺序执行，依赖结果可在后置上下文中验证。

### 阶段 D：Supervisor 汇总与恢复

- 合并 Supervisor 的重复规划调用；
- 增加显式 supervisorId；
- 汇总真实 Task、Attempt 和 Review 数据；
- 增加租约和启动恢复。

完成标志：进程在 Coder 或 Reviewer 执行中退出后，重启可以继续 run。

### 阶段 E：前端和可观测性

- 新增任务详情、Review 和返工时间线；
- 接入新的 WebSocket 事件；
- 显示并发、排队、返工和失败原因；
- 修复事件按 ID upsert。

完成标志：用户可以在 UI 中完整观察指派、交付、审查、返工和复审过程。

## 14. 测试与验收标准

至少覆盖以下测试：

1. Coder 成功且 Reviewer PASS，任务一次完成；
2. Reviewer FAIL，Coder 收到完整 issues，第二次修复后 PASS；
3. Reviewer 连续 FAIL 达到三次，Task 和 Run 进入 `failed`；
4. Reviewer 返回无效 JSON 时重试一次，不得误判为 PASS；
5. 两个无依赖任务在并发上限内并行执行；
6. 后置任务只有在前置任务 Review PASS 后才能运行；
7. 后置任务上下文包含前置任务实际结果；
8. 服务重启后能够恢复租约过期的工作；
9. Supervisor 最终 prompt 包含所有 worker 输出和 Review 结果；
10. Agent 消息不能代替人工工具审批；
11. 重复 Scheduler tick 不会重复领取同一任务；
12. 旧版数据库可自动迁移且原有 run 可查询；
13. `pnpm typecheck`、Web build 和 Provider stub 验证通过。

建议增加以下测试层：

```text
领域单测：状态机、Review 解析、DAG ready 判定
数据库集成测试：并发 claim、租约恢复、幂等迁移
编排集成测试：FAIL → 修复 → PASS、达到重试上限
前端测试：事件 upsert、任务状态和时间线渲染
Stub E2E：OpenAI Compatible 与 Anthropic 两条 Provider 路径
```

## 15. 最终验收场景

使用目标：“实现 REST 与 WebSocket 身份认证”，选择 Planner、Coder、Reviewer，主管指定 Planner。

预期行为：

1. Planner 创建带两个验收标准的实现任务；
2. Scheduler 指派 Coder；
3. Coder 完成第一次实现并请求 Review；
4. Reviewer 发现 WebSocket 缺少认证并返回 FAIL；
5. Task 进入 `needs_revision`，消息流展示 Reviewer 的文件、行号和建议；
6. Scheduler 再次指派 Coder，Coder 的上下文包含第一次输出和 Review issues；
7. Coder 修复后请求复审；
8. Reviewer 返回 PASS；
9. Task 进入 `completed`；
10. Planner 读取两次 Coder 结果和两次 Review，向用户输出真实总结；
11. Run 进入 `completed`；
12. UI 和数据库均可回放完整过程。

达到以上结果后，平台才具备完整的 Agent 间通信、任务调度和代码审查返工能力。
