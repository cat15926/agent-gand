下面这份方案基于我在 **2026-09-22** 重新核对的 `agent-gand/main` 与 `clowder-ai/main` 当前代码，而不是只依据前面几轮讨论。

先给结论：

> **agent-gand 不应该重构成 Clowder 的复制品。**
>
> `agent-gand` 已经有 Clowder 不同但很有价值的基础：结构化 Control Tool、SQLite Durable Dispatch/Attempt、幂等键、lease、Checkpoint、Tool Execution Ledger，以及已经成型的 `Protocol → Draft → Plan → Validator → Runtime` Coordination 体系。当前真正缺失的是一套统一的 **责任流 Runtime**。
>
> 因此这次重构的主线应该是：
>
> **保留 agent-gand 的 Durable Dispatch + Structured ControlAction + Coordination Plan，吸收 Clowder 的 Custody、Continuity、Structured Stop Gate、Evidence Context、Successor Obligation 和 Harness Guard 思想。**

---

# 一、先确定当前 agent-gand 真正的问题

当前 Collaboration 的控制面其实已经不错。

模型不是靠自然语言 `@B` 来触发路由，而是调用：

```text
agent.send_message
agent.ask_many
agent.wait_for_user
agent.propose_supervisor_task
```

随后 `parseControlCall()` 把它们编译成：

```ts
type CollaborationControlAction =
  | { type: 'finish' }
  | { type: 'handoff'; ... }
  | { type: 'ask_many'; ... }
  | { type: 'wait_user'; ... }
  | { type: 'propose_task'; ... };
```

`handoff` 还会校验目标必须属于当前 Run、不能把工作交给自己。这个控制面我建议保留。:chatgpt-content-reference{index="0"}

当前 handoff 的真实执行链是：

```text
Agent A
   ↓
agent.send_message(B)
   ↓
ControlAction(handoff)
   ↓
collaboration_handoff Message
   ↓
创建 child CollaborationDispatch
   ↓
queued in SQLite
   ↓
Scheduler claim
   ↓
创建 Attempt(B)
   ↓
重新 buildContext()
   ↓
runAgentTurn(B)
```

并且 Dispatch 有 idempotency/content dedupe；claim 时会创建带 lease 的 Attempt，同时保证同 conversation 下同一个 Agent 不同时运行两个 Attempt。这个 Durable Scheduler 应该继续成为重构后的执行底座。:chatgpt-content-reference{index="1"}

但现在存在五个根本问题。

### 问题 1：`Dispatch` 表达“要执行谁”，却不表达“谁对工作负责”

现在 A handoff B：

```text
A Dispatch → completed
B Dispatch → queued
```

系统没有一个独立对象表达：

```text
这个工作现在正在从 A 向 B 转移
B 尚未真正接球
如果 B 永远没启动怎么办
B 完成后应该返回谁
```

这正是 Clowder 后来引入 ball custody / action successor lease 的原因。当前 Clowder 已经把 holder、predecessor、generation、terminal predicate、evidence refs 和 return transition 做成显式状态，而不只是 Prompt 中的“球权”比喻。:chatgpt-content-reference{index="2"}

---

### 问题 2：`没有 ControlAction` 被直接解释成 `finish`

当前 Collaboration Scheduler 明确：

```ts
const action =
  turn.controlAction
  ?? { type: 'finish' };
```

也就是说：

```text
模型停止生成
≈
当前工作完成
```

然后 `finalizeRun()` 只要看到：

```text
没有 open dispatch
没有 pending decision
至少有一个 completed dispatch
```

就可以把整个 Run 标成 completed。:chatgpt-content-reference{index="3"}

这是目前最应该优先修掉的一处。

因为：

```text
Model Stop
≠
Current Work Completed
≠
Run Goal Completed
```

这三个状态必须拆开。

Clowder F167 后来加入 structured stop gate / forced-pass，就是在修这个类型的问题：reviewer 给完 verdict、模型停了，不代表协作链结束；对于携带 structured custody 的 invocation，如果没有观察到合法状态迁移，Runtime 会阻止其静默结束。:chatgpt-content-reference{index="4"}

---

### 问题 3：handoff 传递的是 Message，不是真正的执行上下文

当前 `buildContext()` 给下一个 Agent 的主要内容仍然是：

```text
团队 roster
发送者
handoff reason
route depth
最近 19 条 conversation messages
当前 source message
```

每条历史消息还会截断到约 2,000 字。:chatgpt-content-reference{index="5"}

所以：

```text
A 实际读了哪些文件
A 的 tool result
测试结果
产物
代码 diff
已经验证过哪些假设
还有什么开放问题
```

并不会自动以结构化方式交给 B。

当前本质还是：

```text
Conversation Context 强
Execution Evidence 弱
Control-flow Context 中等
```

而 Clowder 当前已经将 `directMessageFrom`、`a2aTriggerMessageId`、chain position、A2A depth、ball state 等控制流数据独立放进 Continuity Capsule；这些数据不是从聊天自然语言反推的。:chatgpt-content-reference{index="6"}

---

### 问题 4：`handoff` 和 `ask_many` 有执行差异，但缺少统一“权限/责任语义”

当前 `ask_many` 已经实现得不错：

```text
A
├─ B
├─ C
└─ D
   ↓
Batch barrier
   ↓
aggregate Dispatch
   ↓
A
```

但其“B/C/D只是 consultant、A 仍然负责 root work”目前主要依靠 scheduler 特殊逻辑和 prompt 约束，而不是统一 Authority/Custody 模型。:chatgpt-content-reference{index="7"}

你的 Collaboration 辩论实测已经真正撞到这个问题：多个初始 Agent 同时成为调度中心、角色能被自然语言覆盖、Reviewer 过早参与、没有严格全局终局屏障等。因此报告自己已经提出唯一协调权、Run Contract、角色隔离、因果链上下文等修复方向。:chatgpt-content-reference{index="8"}

---

### 问题 5：Collaboration 与 Coordination 其实在重复发明 Runtime

Coordination 这边已经有非常好的模型：

```text
Capability Snapshot
Protocol
Draft
Plan
Plan Step
Attempt
Artifact
Completion
Validator
Durable recovery
```

目前协议目录甚至已经包括：

```text
single_agent
sequential_pipeline
parallel_fanout
supervisor_aggregation
supervisor_dag
review_revision
debate
consensus
vote
dynamic_collaboration
```

并且 Plan 已支持 required/terminal steps、expected artifacts、reviewer isolation、预算和 revision。:chatgpt-content-reference{index="9"}

所以继续分别增强：

```text
Collaboration Runtime
Coordination Runtime
Supervisor Runtime
Pipeline Runtime
```

长期一定会产生四套相似但不完全一致的完成、恢复、上下文和路由语义。

---

# 二、重构的核心目标

最终我建议把 agent-gand 演进成：

```text
                   User / API / UI
                          │
                          ▼
                   Task / Follow-up
                          │
                          ▼
                Protocol / Fastpath
                          │
             ┌────────────┴────────────┐
             │                         │
      Dynamic Collaboration      Coordination Plan
             │                         │
             └────────────┬────────────┘
                          ▼
              Collaboration Runtime Kernel
 ┌────────────────────────────────────────────────┐
 │                                                │
 │ RunContract                                    │
 │ WorkSubject                                    │
 │ Custody / Successor Obligation                 │
 │ ControlAction Resolver                         │
 │ Runtime Guards                                 │
 │ Context Assembler                              │
 │ Handoff Capsule                                │
 │ Evidence Resolver                              │
 │ Completion Engine                              │
 │ Wait / Wake                                    │
 │ Durable Scheduler                              │
 │ Checkpoint / Recovery                          │
 │                                                │
 └──────────────────────┬─────────────────────────┘
                        │
                  AgentTurnExecutor
                        │
               ┌────────┼────────┐
               ▼        ▼        ▼
            Claude    GPT      Gemini
```

一句话：

> **Protocol 决定正常流程；Agent 决定需要判断力的动作；Runtime 决定动作是否合法、责任有没有真的转移、工作是否真的完成。**

这就是从 Clowder 应该吸收的核心，而不是 `@mention`。

---

# 三、建议先立下 12 条 Runtime Invariant

这 12 条最好直接写成一个 ADR，并配测试。

| # | Invariant |
|---|---|
| 1 | 一个单持有型 WorkSubject 任意时刻最多一个有效 holder |
| 2 | `handoff requested` 不等于目标 Agent 已接球 |
| 3 | Consultation 默认不转移 root custody |
| 4 | Runtime 状态只能由结构化 ControlAction 改变，普通文本不改变控制流 |
| 5 | Model stop 不等于 Work complete |
| 6 | Work complete 不等于 Run complete |
| 7 | Run complete 必须经过 Completion Engine |
| 8 | Reviewer/Judge independence 必须 Runtime 校验 |
| 9 | Protocol hard constraints 不能被 Agent 消息修改 |
| 10 | 恢复必须恢复 custody / obligation，而不只是 conversation history |
| 11 | 外部等待必须持久化为 Wait，不允许“我稍后再看”这种口头等待 |
| 12 | Evidence 是事实来源；聊天只是上下文来源 |

其中 4、5、8、9 的方向和你现有 Coordination Validator 已经高度一致：现有设计明确要求 Agent capability、hard constraint、Reviewer isolation、completion condition、budget、checkpoint boundary 全部在服务端校验。:chatgpt-content-reference{index="10"}

---

# 四、P0：增加 `WorkSubject`，不要直接把 Dispatch 改名成 WorkItem

这里我会修正之前给你的建议。

**现阶段不要直接建一个 `runtime_work_items` 然后把 CollaborationDispatch 和 CoordinationStep 都删掉。**

迁移风险太高。

先引入一个更小、更关键的抽象：

```ts
export interface WorkSubject {
  id: string;

  runId: string;

  kind:
    | 'root'
    | 'consultation'
    | 'review'
    | 'coordination_step';

  parentSubjectId: string | null;

  source:
    | {
        kind: 'collaboration_dispatch';
        id: string;
      }
    | {
        kind: 'coordination_step';
        planId: string;
        stepId: string;
      }
    | {
        kind: 'run';
        id: string;
      };

  objective: string;

  status:
    | 'active'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled';

  createdAt: string;
  updatedAt: string;
}
```

### 为什么需要 Subject？

因为：

```text
Dispatch A
→ Dispatch B
→ Dispatch A
```

虽然是三个 Dispatch，

其实处理的是：

```text
同一个 logical work
```

所以应该是：

```text
WorkSubject OAuth-Review
      │
      ├── Dispatch #1 Claude
      ├── Dispatch #2 Codex
      └── Dispatch #3 Claude
```

责任是跟着 Subject 流动的。

---

# 五、P0 核心：实现真正的 `WorkCustody`

建议结构：

```ts
export type CustodyState =
  | 'unassigned'
  | 'owned'
  | 'transferring'
  | 'held'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkCustody {
  subjectId: string;
  runId: string;

  state: CustodyState;

  holderAgentId: string | null;

  pendingHolderAgentId: string | null;

  predecessorAgentId: string | null;

  generation: number;

  obligation: SuccessorObligation | null;

  sourceActionId: string | null;

  version: number;

  updatedAt: string;
}
```

其中：

```ts
export type SuccessorObligation =
  | {
      kind: 'continue';
    }
  | {
      kind: 'return_to_predecessor';
      agentId: string;
    }
  | {
      kind: 'return_to_author';
      agentId: string;
    }
  | {
      kind: 'independent_review';
      authorAgentId: string;
    }
  | {
      kind: 'aggregate_to';
      agentId: string;
    }
  | {
      kind: 'none';
    };
```

这就是最关键的新 Domain Model。

---

# 六、handoff 不应该立即修改 holder

这一点建议直接吸收 Clowder 当前源码的经验。

Clowder 源码中特别区分：

```text
handoff event
```

和：

```text
receiver 真正开始 invocation
```

`ball.handed` 被作为显式状态事件记录，而且 structured dispatch 的 wake provenance 里保存 source message、fromCat、holder 等数据。:chatgpt-content-reference{index="11"}

agent-gand 应该这样：

```text
A owns Subject
      │
      ▼
A requests handoff(B)
      │
      ▼
Custody:
state = transferring
holder = A
pendingHolder = B
      │
      ▼
B Dispatch queued
      │
      ▼
Scheduler claims B
      │
      ├── Atomic transaction
      │
      ├─ Attempt(B) created
      ├─ custody generation++
      ├─ holder = B
      ├─ pendingHolder = null
      └─ state = owned
```

也就是说：

```text
A 说“给 B”
```

不等于：

```text
B 已经接到了。
```

如果 B：

```text
disabled
failed
queue 永远无法 dispatch
```

系统仍然知道：

```text
transfer pending
```

而不是出现责任黑洞。

---

# 七、Custody 应采用 Event + Projection，但不要照抄 Clowder 的 best-effort

Clowder 当前 BallCustody 是：

```text
append event
→ projector.apply()
```

并用 `sourceEventId` 做幂等；同 subject 的事件串行化以避免 read-modify-save projection 被覆盖。:chatgpt-content-reference{index="12"}

但 Clowder 当前有些接线点是 fire-and-forget / best effort，这是为了兼容既有系统。

**agent-gand 不建议照抄这一点。**

因为你的 SQLite transaction 已经很强。

建议：

```text
ControlAction
   │
BEGIN IMMEDIATE
   │
   ├─ INSERT custody_event
   ├─ UPDATE custody_projection
   ├─ INSERT dispatch
   ├─ INSERT message
   └─ COMMIT
```

全部原子。

表：

```text
runtime_work_subjects

runtime_custody_events
runtime_custody

runtime_waits
```

`runtime_custody_events` 做 append-only：

```text
custody.created
custody.transfer_requested
custody.acquired
custody.return_requested
custody.held
custody.woken
custody.completed
custody.failed
custody.cancelled
```

每个 Event：

```ts
interface CustodyEvent {
  id: string;
  sourceEventId: string;   // UNIQUE

  runId: string;
  subjectId: string;

  kind: CustodyEventKind;

  generation: number;

  actorAgentId?: string;
  fromAgentId?: string;
  toAgentId?: string;

  dispatchId?: string;
  attemptId?: string;

  evidenceRefs: string[];

  payload: Record<string, unknown>;

  createdAt: string;
}
```

---

# 八、不要把完整 A context 复制给 B，建立 `HandoffCapsule`

这是这轮重构第二重要的部分。

不要做：

```text
A 50k token context
↓
复制
↓
B 50k token context
```

那会带来：

```text
成本
污染
角色混淆
旧信息
隐式状态
```

应该建立：

```ts
export interface HandoffCapsule {
  version: 1;

  runId: string;
  subjectId: string;

  fromAgentId: string;
  toAgentId: string;

  sourceDispatchId: string;
  sourceAttemptId: string;

  objective: string;

  reasonCode:
    | 'NEED_SPECIALIST'
    | 'NEXT_STAGE'
    | 'INDEPENDENT_REVIEW'
    | 'REVISION_REQUIRED'
    | 'CAPABILITY_BLOCKED'
    | 'RETURN_RESULT';

  summary: string;

  completedWork: string[];

  openQuestions: string[];

  expectedOutcome: string;

  evidenceRefs: EvidenceRef[];

  successorObligation?: SuccessorObligation;

  createdAt: string;
}
```

真正传给 B 的不是：

```text
A 所有聊天
```

而是：

```text
为什么找你
A 已经做了什么
哪些事实已经被验证
哪些东西仍然没解决
你应该交付什么
做完应该把球给谁
```

---

# 九、Evidence 不要再重新造一套 Blob Store

agent-gand 已经有：

- `Message`
- `ToolExecution`
- `RunEvent`
- `CoordinationArtifact`
- workspace file
- Attempt output

而且 `ToolExecution` 已经有稳定 idempotency key、input/output/status/span；RunCheckpoint 也明确只保存可恢复状态而不是模型内部状态。:chatgpt-content-reference{index="13"}

所以先增加：

```ts
export type EvidenceRef =
  | {
      kind: 'message';
      id: string;
    }
  | {
      kind: 'tool_execution';
      id: string;
    }
  | {
      kind: 'coordination_artifact';
      id: string;
    }
  | {
      kind: 'run_event';
      id: string;
    }
  | {
      kind: 'workspace_file';
      uri: string;
      hash?: string;
    }
  | {
      kind: 'attempt_output';
      id: string;
    };
```

再增加：

```text
EvidenceResolver
```

而不是一开始上：

```text
Vector DB
Embedding
Knowledge Graph
```

---

# 十、Handoff 时 Runtime 自动生成 `AttemptEvidenceBundle`

不要完全依赖 LLM 手工挑 evidence。

例如 A 这一轮：

```text
read oauth.ts
write oauth.ts
run tests
git diff
```

Runtime 可以在 Attempt 结束时生成：

```ts
interface AttemptEvidenceBundle {
  attemptId: string;

  substantiveToolExecutions: EvidenceRef[];

  artifacts: EvidenceRef[];

  outputRef: EvidenceRef;

  workspaceChanges: EvidenceRef[];

  testResults: EvidenceRef[];
}
```

handoff 默认携带：

```text
本 Attempt 的 material evidence
+
Agent 显式要求附带的 evidence
```

于是即使 A 的 handoff message 很短：

```text
“请 review。”
```

B 也不会完全从零开始。

---

# 十一、把 `buildContext()` 重构成 `AgentTurnContext`

现在这一个大字符串：

```ts
buildContext(...)
```

应该逐渐废掉。

新增：

```ts
interface AgentTurnContext {
  run: {
    id: string;
    goal: string;
    protocol?: string;
    stage?: string;
  };

  self: {
    agentId: string;
    role: string;
    capabilities: string[];
    authority: AgentAuthority;
  };

  team: AgentSummary[];

  contract: RunContractView;

  subject: {
    id: string;
    objective: string;
    kind: string;
  };

  custody: {
    holderAgentId: string | null;
    state: CustodyState;
    generation: number;
    predecessorAgentId: string | null;
  };

  causal: {
    sourceAgentId?: string;
    sourceDispatchId?: string;
    sourceAttemptId?: string;
    triggerMessageId?: string;
  };

  obligation?: SuccessorObligation;

  handoff?: HandoffCapsule;

  evidence: EvidencePresentation[];

  conversation: ConversationNavigation;

  limits: RuntimeLimits;
}
```

这相当于 agent-gand 版的 Clowder `InvocationContext + CollaborationContinuityCapsule`。

Clowder 当前 `InvocationContext` 已经显式带 `directMessageFrom`、routing policy、SOP stage hint 等，而 Continuity Capsule 单独带 invocation、parent、chain、trigger message、A2A depth 和 ball state。:chatgpt-content-reference{index="14"}

---

# 十二、不要复制 Clowder 的 46-hook 复杂度，做一个“小型 Context Pipeline”

Clowder 当前 `SystemPromptBuilder` 已经逐步退化成 Facade，真正注入通过 HookPipeline 分 session-init / per-turn，并保留 injection trace。:chatgpt-content-reference{index="15"}

这是好思想，但 agent-gand 没必要一上来复制 46 个 hook。

建议：

```ts
interface ContextContributor {
  id: string;

  phase:
    | 'static'
    | 'per_turn';

  order: number;

  required: boolean;

  maxTokens?: number;

  applies(ctx: AgentTurnContext): boolean;

  render(ctx: AgentTurnContext): string;
}
```

第一批只做：

```text
identity
team
run-contract
protocol-stage
custody
causal-handoff
evidence
conversation-navigation
runtime-actions
```

最后：

```text
AgentTurnContext
      ↓
ContextAssembler
      ↓
ContextSegments[]
      ↓
Token budgeting
      ↓
LLM messages
```

同时保存：

```ts
ContextAssemblyTrace {
  contributorId;
  included;
  tokenEstimate;
  reason;
}
```

这样以后能回答：

> “为什么 Codex 这一轮不知道它应该返回 author？”

而不是只能看最终 Prompt 猜。

---

# 十三、Conversation History 从主体降级成“导航层”

当前：

```text
最近 19 条消息
```

不应该再承担：

```text
记忆
事实
handoff
控制流
```

全部职责。

新 Prompt 顺序建议：

```text
1 Identity
2 Immutable Run Contract
3 Current Protocol Stage
4 Current Subject + Custody
5 Handoff Capsule
6 Evidence Bundle
7 Team / Capabilities
8 Relevant Conversation Excerpts
9 Available Control Actions
```

Conversation 只是第 8 层。

---

# 十四、ControlAction v2

这是核心 API。

当前：

```ts
finish
handoff
ask_many
wait_user
propose_task
```

建议升级为：

```ts
export type CollaborationControlActionV2 =
  | ContinueAction
  | HandoffAction
  | ConsultAction
  | HoldAction
  | WaitUserAction
  | CompleteAction
  | EscalateAction;
```

---

## `continue`

```ts
interface ContinueAction {
  type: 'continue';
  reason: string;
}
```

含义：

> 球仍在我手上，我还有可执行工作。

主要用于需要下一 invocation / continuation 的长任务。

---

## `handoff`

```ts
interface HandoffAction {
  type: 'handoff';

  targetAgentId: string;

  reasonCode: HandoffReasonCode;
  reason: string;

  objective: string;
  summary: string;

  completedWork?: string[];
  openQuestions?: string[];

  expectedOutcome: string;

  evidenceRefs?: EvidenceRef[];
}
```

语义：

> **责任转移。**

不能再把它理解成普通“发消息”。

---

# 十五、`ask_many` 改名为 `consult`

你现有 fanout/fan-in 实现可以保留，但领域语义改清楚：

```ts
interface ConsultAction {
  type: 'consult';

  targets: string[];

  question: string;

  reason: string;

  collect:
    | 'all'
    | 'quorum'
    | 'first';

  expectedOutcome?: string;
}
```

最重要的 invariant：

```text
Consult ≠ Handoff
```

即：

```text
A owns root subject
│
├── consultant B
└── consultant C
        │
        ▼
consult results
        │
        ▼
        A
```

A 的 custody 不转移。

consult children 拥有自己的：

```text
child WorkSubject
```

但没有 root authority。

---

# 十六、给 Agent 加 `Authority`

建议：

```ts
export type AgentWorkAuthority =
  | 'root_owner'
  | 'delegated_owner'
  | 'consultant'
  | 'reviewer'
  | 'judge'
  | 'observer';
```

例如 consultant：

```text
可以：
read
search
analyse
run readonly tools
produce evidence

默认不可以：
complete root subject
改变 Run Contract
转移 root custody
改变 protocol
修改 reviewer identity
```

这直接解决你 Debate 实测里“每个 Agent 都逐渐变成 scheduler”的问题。:chatgpt-content-reference{index="16"}

---

# 十七、增加 `hold`

这是 Clowder 最值得吸收的机制之一。

Clowder 现在明确区分：

```text
能继续
→ 继续

需要别人动作
→ handoff

需要人判断
→ operator/user

只是等待短暂外部条件，之后仍由自己继续
→ hold
```

而且同 `(thread, agent)` 的 hold 是单槽 replacement，防止 stale wake 累积。:chatgpt-content-reference{index="17"}

agent-gand 可先实现最小版本：

```ts
interface HoldAction {
  type: 'hold';

  reason: string;
  nextStep: string;

  wake:
    | {
        kind: 'timer';
        afterMs: number;
      }
    | {
        kind: 'event';
        eventKey: string;
      };
}
```

数据库：

```text
runtime_waits

id
run_id
subject_id
holder_agent_id
generation
kind
payload
status
wake_at
created_at
resolved_at
```

---

# 十八、`generation` 必须进入 Custody

例如：

```text
generation = 5

hold wake #5
```

之后用户补充了信息：

```text
generation → 6
```

旧 wake 到达：

```text
wake.generation = 5
custody.generation = 6

→ stale
→ ignore
```

Clowder 当前 action successor lease 也将 generation 作为 preflight 条件之一，专门拒绝 stale generation。:chatgpt-content-reference{index="18"}

---

# 十九、废弃 `finish`，增加 `complete`

`finish` 最大的问题是语义不明确：

```text
我的一句话说完了？
我的 Dispatch 完成？
我的工作完成？
整个 Run 完成？
```

应该改成：

```ts
interface CompleteAction {
  type: 'complete';

  summary: string;

  evidenceRefs?: EvidenceRef[];
}
```

语义只有：

> “我认为当前 WorkSubject 已满足其 CompletionContract，请 Runtime 验证。”

注意：

```text
Agent 请求 complete
≠
Runtime 接受 complete
```

---

# 二十、增加 Completion Engine

建议：

```ts
interface CompletionContract {
  requiredEvidence?: EvidenceRequirement[];

  requiredArtifacts?: ArtifactRequirement[];

  requiredSuccessors?: SuccessorRequirement[];

  reviewPolicy?: ReviewPolicy;

  terminalPredicate?: TerminalPredicate;

  allowImplicitCompletion: boolean;
}
```

执行：

```text
agent.complete()
      │
      ▼
CompletionEngine
      │
      ├─ outputs complete?
      ├─ expected artifacts exist?
      ├─ tool/test evidence valid?
      ├─ review completed?
      ├─ reviewer independent?
      ├─ open successor?
      ├─ active wait?
      └─ protocol terminal barrier?
      │
     yes / no
```

失败不是直接 fail：

```text
CompletionRejected {
  reasons: [...]
}
```

可以让 Agent：

```text
继续
修复
handoff
replan
```

---

# 二十一、直接复用 Coordination 已经做好的 completion 能力

不要重写。

目前 Coordination 已经有：

```ts
CoordinationPlanStep.expectedArtifacts
CoordinationPlanCompletion.requiredSteps
CoordinationPlanCompletion.terminalSteps
```

而实际 Runtime 已经修复过：

```text
expected artifact 必须真实存在且非 stub
review/aggregate 前必须校验祖先产物
max_tokens 截断不能成功完成
```

这些已经过真实 debate 故障驱动。:chatgpt-content-reference{index="19"}

因此：

```text
CompletionEngine
```

第一版应该直接把这些规则抽出来成为公共模块。

而不是 Collaboration 再写一遍。

---

# 二十二、`finalizeRun()` 必须重写

当前：

```ts
if (hasOpenDispatches(runId)) return;

if (hasPendingDecision(runId)) return;

const succeeded =
  dispatches.some(d => d.status === 'completed');

finishRun(
  succeeded ? 'completed' : 'failed'
);
```

这一段应该最终消失。:chatgpt-content-reference{index="20"}

替换：

```text
RunCompletionEngine.evaluate(run)
```

要求：

```text
root Subject completed
AND
root custody terminal
AND
no pending transfer
AND
no required successor
AND
no active wait
AND
no pending decision
AND
protocol completion contract satisfied
AND
required evidence exists
```

然后才能：

```text
Run = completed
```

这是整个重构最重要的行为变化之一。

---

# 二十三、Review 要从 Prompt 规则升级成 Successor Policy

Clowder F167 最典型的真实故障就是：

```text
Reviewer:
P1...
P2...
LGTM / REQUEST_CHANGES

然后停止。
```

模型认为：

```text
review 做完 = 工作结束
```

但 Runtime 需要知道：

```text
review verdict → author 必须看到并行动
```

因此 Clowder后来增加 forced-pass guard。:chatgpt-content-reference{index="21"}

agent-gand 不必先做关键词猜测。

你已经拥有 `review_revision` Protocol，所以可以更干净地实现：

```ts
SuccessorPolicy {
  event: 'review.completed',

  when: {
    verdict: 'changes_required'
  },

  next: {
    kind: 'return_to_author'
  }
}
```

以及：

```text
author revise completed
→ reviewer

review PASS
→ completion gate
```

Agent 只负责判断：

```text
PASS
CHANGES_REQUIRED
+
findings
```

Runtime 决定下一棒。

---

# 二十四、动态 Collaboration 也可以使用 Successor Obligation

开放任务不一定有 Plan。

例如 A 自主 handoff B 做 review：

```text
A
  handoff(B,
          reasonCode=INDEPENDENT_REVIEW)
```

Runtime 可以创建：

```ts
obligation = {
  kind: 'return_to_author',
  agentId: A
}
```

B 接球后 Prompt 明确看到：

```text
Successor obligation:
完成 review 后返回 A。
```

即使 B 忘了：

```text
Completion/Exit Guard
```

也可以阻止它静默终止。

---

# 二十五、增加 `ExitGuard`

这正是 Clowder structured stop gate 最值得借鉴的地方。

每次 `runAgentTurn()` 返回后：

```text
LLM stopped
```

先进入：

```text
ExitGuard
```

判断：

```text
该 invocation 是否携带 active custody？

如果没有：
    普通 fastpath，可正常停止

如果有：
    是否发生合法 control transition？
```

合法 transition 可以是：

```text
continue
handoff
consult + hold root
hold
wait_user
complete accepted
protocol successor
```

没有：

```text
→ corrective nudge once
```

仍没有：

```text
→ blocked / needs_attention
```

而不是：

```text
→ finish
```

Clowder 当前 stop decision 已经明确区分 `covered_active / covered_empty / unknown_legacy`，active custody 且没有 observation 时会 block。:chatgpt-content-reference{index="22"}

---

# 二十六、兼容旧行为时不要 Big Bang

第一阶段可以：

```text
COLLAB_RUNTIME_V2=false
```

旧 behavior。

然后：

```text
COLLAB_RUNTIME_V2_SHADOW=true
```

执行旧逻辑，但同时计算：

```text
ExitGuard v2
CompletionEngine v2
Custody projection v2
```

只记录：

```text
legacy=allow
v2=block
```

或者：

```text
legacy=finish
v2=incomplete
```

先跑现有真实用例。

这和 Clowder 自己采用 shadow comparison 逐步接管 turn custody 的方式很相似；当前代码仍保留 old/new stop decision comparison telemetry。:chatgpt-content-reference{index="23"}

---

# 二十七、Ping-Pong Guard 必须升级

当前 agent-gand 的：

```ts
pingPongCount()
```

只看最近的：

```text
A→B→A→B
```

次数。:chatgpt-content-reference{index="24"}

这会误伤合法的：

```text
implement
→ review
→ revise
→ re-review
```

Clowder 已经踩过完全相同的问题，并改成：

```text
same pair
+
没有 substantive tool work
+
短文本
→ streak +1
```

如果中间产生真实工作：

```text
read
edit
write
test
git
search_evidence
...
```

则 streak reset。

而 `post_message / multi_mention / hold_ball` 等纯路由工具不算 substantive work。:chatgpt-content-reference{index="25"}

agent-gand 正好已经有 ToolExecution Ledger，所以很好实现。

建议：

```ts
interface ProgressEvidence {
  substantiveToolCalls: number;
  artifactsCreated: number;
  artifactsModified: number;
  testsExecuted: number;
  newEvidenceRefs: number;
  outputLength: number;
}
```

判断：

```text
有 material progress
→ reset streak

只有 routing + 短 ACK
→ increment
```

---

# 二十八、Run Contract 提升成公共 Runtime 对象

你的 Collaboration 实测报告已经要求 Run Contract；Coordination 的 `TaskBrief` 和 Plan 实际已经包含它的大量内容。:chatgpt-content-reference{index="26"}

建议公共化：

```ts
interface RunContract {
  runId: string;
  version: number;

  goal: string;

  hardConstraints: Record<string, unknown>;

  participantPolicy: {
    allowedAgentIds: string[];
    fixedRoles?: Record<string, string>;
  };

  authorityPolicy: AuthorityPolicy;

  reviewPolicy?: ReviewPolicy;

  completion: CompletionContract;

  budget: BudgetPolicy;

  workspace: WorkspacePolicy;

  createdAt: string;
}
```

对于 Coordination：

```text
TaskBrief + Plan
→ compile RunContract
```

对于 Dynamic Collaboration：

```text
User goal + room config
→ lightweight RunContract
```

---

# 二十九、Protocol 与 Contract 必须分开

例如 Debate：

### Contract

```text
正方是谁
反方是谁
不能互换
Reviewer 独立
必须 3 轮
必须六条真实独立发言
```

这些是：

```text
immutable / revision-controlled
```

### Plan

```text
Round 1 Pro
Round 1 Con
Round 2 Pro
...
Judge
```

这个可以 revision。

你的 Coordination 目前已经要求用户 hard constraints 不得被规划器改写，Plan revision 也不能改写已完成步骤和已发布证据。:chatgpt-content-reference{index="27"}

应该把这个能力下沉给所有协作模式。

---

# 三十、不要急着建立完整 Skill 系统

Clowder 最近自己的 Skill 复盘非常值得注意：

> 规则很多不是问题；问题是关键规则没有进入真正执行路径。修法是 subtraction + toolification，而不是再加更多 Prompt。:chatgpt-content-reference{index="28"}

所以 agent-gand 现在不应该先建设：

```text
skills/*.md
几十套规则
动态 skill loader
```

优先做：

```text
RunContract
ProtocolStage
Authority
SuccessorPolicy
CompletionEngine
Custody
```

这些 Runtime 机制。

等稳定以后再做：

```ts
SkillHint {
  skillId;
  reason;
  required;
}
```

---

# 三十一、Prompt 中需要给 Agent 一个很小的“协作决策树”

真正需要模型判断的部分保留给模型：

```text
当前事项下一步：

1. 你能直接继续推进？
   → continue / 继续使用工具

2. 你只是需要别人提供信息或第二意见？
   → consult

3. 下一步责任确实应该交给别人？
   → handoff

4. 你只是在等待一个外部条件，
   而条件满足后仍由你继续？
   → hold

5. 必须由用户判断？
   → wait_user

6. 你认为当前 WorkSubject 已完成？
   → complete
```

但：

```text
reviewer != author
当前允许的 successor
预算
route depth
artifact 是否存在
```

不要让 LLM 记。

Runtime Guard。

---

# 三十二、Guard Chain

建议新增：

```ts
interface RuntimeGuard {
  evaluate(
    action: CanonicalControlAction,
    context: RuntimeGuardContext
  ): Promise<GuardDecision>;
}
```

执行：

```text
ControlAction
    ↓
SchemaGuard
    ↓
MembershipGuard
    ↓
AuthorityGuard
    ↓
CapabilityGuard
    ↓
ProtocolGuard
    ↓
IndependenceGuard
    ↓
CustodyGuard
    ↓
PingPongGuard
    ↓
BudgetGuard
    ↓
WorkspaceGuard
    ↓
CompletionGuard
    ↓
Commit
```

其中你现有：

```text
target membership
route depth
budget
review isolation
artifact validation
tool permissions
```

都不是重写，而是迁入统一 Guard 接口。

---

# 三十三、Handoff 的新完整链应该是这样

```text
Agent A owns Subject S
        │
        ▼
agent.handoff(...)
        │
        ▼
parseControlCall
        │
        ▼
Canonical HandoffAction
        │
        ▼
GuardChain
        │
        ├─ Membership
        ├─ Capability
        ├─ Authority
        ├─ Protocol
        ├─ Budget
        └─ PingPong
        │
        ▼
build HandoffCapsule
        │
        ▼
BEGIN TX
        │
        ├─ custody.transfer_requested
        │
        ├─ custody:
        │     holder=A
        │     pendingHolder=B
        │     state=transferring
        │
        ├─ Message
        │
        ├─ Dispatch(B)
        │
        └─ Commit
        │
        ▼
Scheduler
        │
        ▼
claim B
        │
BEGIN TX
        │
        ├─ Attempt(B)
        ├─ custody.acquired
        ├─ holder=B
        ├─ pendingHolder=null
        └─ generation++
        │
        ▼
AgentTurnContext
        │
        ├─ Contract
        ├─ Custody
        ├─ Handoff Capsule
        ├─ Evidence
        ├─ Obligation
        └─ Conversation navigation
        │
        ▼
Agent B
```

这才是真正的 handoff。

---

# 三十四、Scheduler：保留你现在的 Durable Queue，不需要立即复制 Clowder Worklist

这一点我现在给一个更明确的建议：

**Clowder 的 WorklistRegistry 不应该在第一阶段照搬。**

Clowder 使用 per-invocation Worklist 的主要原因，是希望同一 `routeSerial()` 调用中直接延伸 A2A chain，共享 Abort、previousResponses 和 final semantics。:chatgpt-content-reference{index="29"}

而 agent-gand 现在：

```text
Message
→ Durable Dispatch
→ scheduler
→ Attempt
```

反而是很好的特性。

而且：

```text
create dispatch
→ current executeDispatch finally
→ kickCollaboration
```

本来就能很快继续下一棒。

所以第一阶段：

> **DB Queue 是唯一执行真相。**

不要同时维护：

```text
in-memory worklist
+
DB dispatch
```

两套状态。

---

# 三十五、以后如果真有延迟问题，再增加 Inline Admission，但必须“先持久化”

未来 P3 可以：

```text
handoff
   ↓
persist Dispatch
   ↓
target slot free?
   /        \
 yes        no
  │          │
  ▼          ▼
immediate   queued
claim       waiting
```

也就是：

```ts
type HandoffAdmission =
  | { disposition: 'immediate'; dispatchId: string }
  | { disposition: 'queued'; dispatchId: string }
  | { disposition: 'rejected'; reason: string };
```

但无论 immediate 还是 queued：

```text
Dispatch 先落 SQLite
```

这样你吸收了 Clowder “fast continuation + durable queue”的优点，却没有引入两套 truth source。

Clowder 自身现在也在推动所有来源统一进 InvocationQueue，而不是让某些 urgent path 绕过队列。:chatgpt-content-reference{index="30"}

---

# 三十六、Recovery 从“恢复 Dispatch”升级到“恢复责任”

当前 agent-gand 已经有：

```text
RunCheckpoint
Attempt lease
recoverCollaborationRuns()
```

这是很好的基础。:chatgpt-content-reference{index="31"}

重启后新增：

```text
CustodyReconciler
```

检查：

```text
owned custody
+
不存在 running Attempt

→ recreate/resume Dispatch
```

```text
transferring custody
+
pending Dispatch queued

→ 保持等待
```

```text
transferring custody
+
Dispatch 丢失

→ reconstruct Dispatch from custody event
```

```text
held custody
+
wake 已过期

→ enqueue wake Dispatch
```

而不是只问：

```text
数据库有没有 queued Dispatch？
```

---

# 三十七、Continuity Capsule 也要进入 Checkpoint

建议：

```ts
interface ContinuityCapsule {
  version: 1;

  runId: string;
  subjectId: string;

  agentId: string;

  dispatchId: string;
  attemptId?: string;

  custodyGeneration: number;

  predecessorAgentId?: string;

  triggerMessageId?: string;

  obligation?: SuccessorObligation;

  handoffCapsuleId?: string;

  evidenceBundleId?: string;

  waitId?: string;

  plan?: {
    planId: string;
    revision: number;
    stepId: string;
  };
}
```

Clowder 的核心教训就是：

```text
记得发生过什么
≠
恢复了协作控制流
```

它的 Continuity Capsule 正是为 compact / seal / resume 保留 control-flow metadata。:chatgpt-content-reference{index="32"}

---

# 三十八、Coordination 和 Collaboration 的统一方式

不要删掉 Coordination Planner。

相反：

```text
Coordination
```

应该成为最重要的上层消费者之一。

最终：

```text
CoordinationPlanStep
          │
          ▼
   WorkSubject
          │
          ▼
    Runtime Kernel
          │
          ▼
   AgentTurnExecutor
```

而：

```text
Dynamic Collaboration
          │
          ▼
    WorkSubject
          │
          ▼
    Runtime Kernel
```

差别仅在：

```text
谁决定 Successor？
```

---

## Dynamic Collaboration

```text
Agent 决定
+
Runtime Guard
```

## Coordination

```text
Plan/Protocol 决定
+
Agent 只能在允许范围内选择
+
Runtime Guard
```

---

# 三十九、Pipeline / Supervisor 不再拥有自己的底层执行语义

中长期：

```text
Pipeline
→ protocol compiler

Supervisor
→ coordination authority policy

Collaboration
→ dynamic protocol

Coordination
→ composed protocols
```

最终共享：

```text
AgentTurnExecutor
Custody
ControlAction
Evidence
Completion
Wait
Recovery
```

这样：

```text
pipeline
supervisor
collaboration
coordination
```

不再是四台发动机，

而是：

```text
四种驾驶策略
+
一台发动机
```

---

# 四十、目录结构建议

```text
packages/shared/src/
├── runtime/
│   ├── subject.ts
│   ├── custody.ts
│   ├── control-action.ts
│   ├── handoff-capsule.ts
│   ├── evidence.ts
│   ├── completion.ts
│   ├── run-contract.ts
│   ├── continuity.ts
│   └── authority.ts
│
├── collaboration.ts
├── coordination.ts
└── ...


apps/server/src/
├── runtime/
│   ├── custody/
│   │   ├── custodyService.ts
│   │   ├── custodyStore.ts
│   │   ├── custodyEvents.ts
│   │   └── recovery.ts
│   │
│   ├── context/
│   │   ├── contextAssembler.ts
│   │   ├── contributors/
│   │   └── contextTrace.ts
│   │
│   ├── control/
│   │   ├── actionResolver.ts
│   │   ├── guardChain.ts
│   │   └── guards/
│   │
│   ├── evidence/
│   │   ├── evidenceResolver.ts
│   │   └── attemptEvidence.ts
│   │
│   ├── completion/
│   │   ├── completionEngine.ts
│   │   └── contracts.ts
│   │
│   ├── waits/
│   │   ├── waitService.ts
│   │   └── wakeScheduler.ts
│   │
│   └── continuity/
│       └── continuityService.ts
│
├── collaboration/
│   ├── scheduler.ts
│   ├── controlTools.ts
│   └── ...
│
├── coordination/
│   └── ...
│
└── orchestration/
    └── agentStep.ts
```

---

# 四十一、具体 PR 实施顺序

我建议拆成 **14 个 PR**，不要 Big Bang。

| PR | 工作 | 风险 |
|---|---|---:|
| PR-01 | Runtime ADR + shared domain types | 低 |
| PR-02 | WorkSubject + Custody Event/Projection，Shadow mode | 中 |
| PR-03 | Handoff 时 dual-write custody + legacy Dispatch | 中 |
| PR-04 | AgentTurnContext + modular ContextAssembler | 中 |
| PR-05 | HandoffCapsule + EvidenceRef/Resolver | 中 |
| PR-06 | ControlAction V2：handoff/consult/continue/complete | 高 |
| PR-07 | ExitGuard，取消 Collaboration `null => finish` | 高 |
| PR-08 | CompletionEngine + 重写 finalizeRun | **高** |
| PR-09 | Evidence-aware PingPongGuard | 低 |
| PR-10 | Review SuccessorPolicy + reviewer isolation runtime | 中 |
| PR-11 | Hold / Wait / Wake + generation fencing | 中 |
| PR-12 | Continuity Capsule + crash recovery | 高 |
| PR-13 | Coordination 接入公共 Runtime Kernel | **高** |
| PR-14 | Pipeline/Supervisor runtime 收敛 + legacy cleanup | 高 |

---

# 四十二、PR-01：只建立语言，不改变行为

增加 shared types：

```text
WorkSubject
WorkCustody
CustodyEvent
EvidenceRef
HandoffCapsule
AgentTurnContext
CompletionContract
RunContract
SuccessorObligation
```

所有现有测试必须完全不变。

验收：

```text
pnpm typecheck
所有 verify scripts green
runtime v2 无行为影响
```

---

# 四十三、PR-02：Custody Shadow

每个 Collaboration Run 创建：

```text
root WorkSubject
```

每个 initial Dispatch 对应：

```text
initial custody
```

但旧 scheduler 仍是真正执行源。

新 Custody 只观察。

记录：

```text
legacy dispatch owner-ish state
vs
custody projection
```

输出指标：

```text
custody_shadow_disagreement_total
orphaned_subject_total
transfer_without_receiver_total
```

---

# 四十四、PR-03：Handoff 原子化

当前：

```text
post message
create dispatch
```

改成：

```text
transferRequested()
+
post message
+
create dispatch
```

同一 SQLite transaction。

目标 Agent 被 claim 时：

```text
Attempt create
+
custody acquire
```

同一 transaction。

验收至少包括：

```text
handoff -> queued
holder仍A / pendingHolder=B

claim B
holder=B

duplicate handoff
不重复 custody event

crash between request/claim
可恢复
```

---

# 四十五、PR-04：ContextAssembler 替换 `buildContext()`

先保持内容语义相同。

也就是仍然给模型：

```text
roster
sender
reason
depth
recent chat
current item
```

只是内部改成：

```text
typed AgentTurnContext
+
ContextContributor
```

做到 **zero behavior change**。

这一步非常重要，因为后面所有信息注入都从这里扩展。

---

# 四十六、PR-05：HandoffCapsule + Evidence

handoff 新 Tool schema 可以先兼容旧参数：

```ts
agent.send_message({
  target,
  message,
  reason,

  // optional v2
  objective?,
  summary?,
  openQuestions?,
  expectedOutcome?,
  evidenceRefs?
})
```

如果模型没填：

Runtime 自动构造最小 Capsule：

```text
objective = message
summary = turn.content
evidence = AttemptEvidenceBundle
```

这样迁移平滑。

---

# 四十七、PR-06：ControlAction v2

新增新 Tool 名更干净：

```text
agent.handoff
agent.consult
agent.complete
agent.continue
agent.hold
agent.wait_for_user
```

旧：

```text
agent.send_message
agent.ask_many
```

暂时映射：

```text
send_message → handoff
ask_many → consult
```

并记录 deprecated metric。

不要一次删除。

---

# 四十八、PR-07：先解决最大的 bug —— `no action = finish`

改为：

```text
controlAction == null
        │
        ▼
      ExitGuard
```

兼容策略：

```text
普通简单单 Agent direct answer
→ implicit completion allowed

dynamic collaboration
→ corrective nudge once

structured protocol / active custody
→ 必须结构化 disposition
```

先保留：

```text
implicit_complete
```

telemetry。

最终删除。

---

# 四十九、PR-08：Completion Engine

这是整个重构的第一个大里程碑。

把：

```text
Coordination expectedArtifacts
terminalSteps
requiredSteps
review policy
truncated handling
```

抽进公共 Completion Engine。

同时重写：

```text
finalizeRun()
```

验收场景：

```text
有 completed Dispatch
但 root subject 未 complete
→ Run 不能完成

review 有 CHANGES_REQUIRED
→ Run 不能完成

required artifact missing
→ Run 不能完成

max_tokens truncated
→ Run 不能完成

所有 contract satisfied
→ Run completed
```

---

# 五十、PR-09：Evidence-aware Ping-Pong

当前计数逻辑保留 fallback。

新算法：

```text
same pair?
    │
    ├─ no → 1
    │
    └─ yes
         │
         ▼
material progress since last transfer?
       /       \
     yes        no
      │          │
    reset       +1
```

material progress 从：

```text
ToolExecution
Artifact
workspace change
test
new evidence
```

计算。

---

# 五十一、PR-10：Review Successor Policy

先接 `review_revision`。

以后 review Agent 看到：

```text
Role: reviewer

Current obligation:
review work by Claude

On CHANGES_REQUIRED:
return to Claude

On PASS:
advance to Completion Gate
```

Agent 不再需要凭 Prompt 记：

> review 后该找谁。

Runtime 直接决定。

---

# 五十二、PR-11：Hold / Wake

第一版只支持：

```text
timer
```

和：

```text
internal event
```

之后再做 CI/webhook。

Invariant：

```text
每个 Subject + holder + generation
最多一个 active wait
```

第二个 hold：

```text
replace previous
```

不要 append。

这与 Clowder 后来修正 stale hold 的经验一致。:chatgpt-content-reference{index="33"}

---

# 五十三、PR-12：真正解决 Continuity

服务重启时恢复：

```text
Run
Subject
Custody
generation
predecessor
obligation
wait
handoff capsule
evidence refs
plan step
```

然后才创建 Agent Turn。

不要再只恢复：

```text
messages
queued dispatch
```

测试：

```text
A → B
B running
server crash
restart
→ B 知道自己从 A 接的什么
→ B 知道做完应该回 A
```

---

# 五十四、PR-13：Coordination 接公共 Kernel

当前 Coordination 继续管理：

```text
Plan
DAG
Step Ready
Barrier
Revision
```

但 Step execution 改成：

```text
Coordination Step
      ↓
create Subject
      ↓
Runtime Kernel
      ↓
Agent Turn
      ↓
Completion Engine
      ↓
Step outcome
```

这样：

```text
工具执行
Evidence
Custody
Context
Completion
Retry
```

终于只有一套。

---

# 五十五、PR-14：收敛旧 runtime

最终：

```text
pipeline executor
supervisor executor
collaboration executor
coordination executor
```

逐步退化成：

```text
Protocol Adapter
```

底层全部：

```text
Runtime Kernel
```

---

# 五十六、测试体系

这次重构不能只靠单测。

建议四层。

### Runtime Contract Tests

完全 Mock LLM。

覆盖：

```text
A handoff B
transfer request
B acquire
duplicate request
stale generation
consult root ownership
hold replacement
return obligation
completion rejection
review independence
```

### Behavior Eval

真实 LLM：

```text
需要 specialist 时是否 handoff

只需第二意见时是否 consult

是否过度 handoff

是否忘记 complete

review 是否正确返回 author
```

### Failure Injection

重点：

```text
handoff 后 server crash

B claim 后 crash

tool 完成但 checkpoint 前 crash

wake 到来时 holder generation 已变化

Dispatch duplicate

provider timeout

max_tokens

Agent disabled
```

### E2E Regression

直接复用现有失败案例：

```text
三轮 Debate
review → revision → review
parallel fanout
预算耗尽
follow-up
外部 workspace
truncated answer
```

你的现有 Debate 实测报告就是最好的 regression corpus。:chatgpt-content-reference{index="34"}

---

# 五十七、建议新增几个最重要指标

```text
runtime_active_custody

runtime_orphaned_subject_total

runtime_transfer_pending_seconds

runtime_transfer_failed_total

runtime_exit_guard_block_total

runtime_completion_rejected_total

runtime_implicit_completion_total

runtime_stale_wake_total

runtime_pingpong_without_progress_total

runtime_review_independence_violation_total

runtime_context_evidence_count

runtime_context_tokens_by_segment

runtime_resume_success_total
```

特别关注：

```text
implicit_completion_total
```

目标最终应该趋近：

```text
0
```

---

# 五十八、UI 最终应该展示什么

现在用户主要看到：

```text
谁说了什么
谁正在运行
```

以后应该看到：

```text
当前负责人：Claude

当前阶段：
implementation_revision

当前事项：
OAuth Callback 修复

来自：
Codex Review

当前责任：
修复 P1/P2 后返回 Codex

已验证：
✓ tests 17/18
✓ callback implementation
✗ replay test

等待：
无

完成条件：
✓ implementation artifact
✓ unit tests
□ reviewer PASS
```

并把线区分：

```text
────── Handoff / responsibility transfer

- - - Consult / information flow
```

这样用户第一次能直观看懂：

> 谁在聊天

和

> 谁真的负责

不是一回事。

---

# 五十九、哪些 Clowder 设计不要照搬

这是很重要的边界。

| Clowder 机制 | agent-gand 建议 |
|---|---|
| 文本行首 `@mention` 主路由 | **不作为主协议** |
| Structured MCP routing | 吸收，映射到 ControlAction |
| WorklistRegistry | 暂不复制 |
| Durable InvocationQueue | 已有 Dispatch，保留 |
| Ball Custody | **重点吸收** |
| Continuity Capsule | **重点吸收** |
| Prompt Hook Pipeline | 吸收思想，做轻量版 |
| Skill 大量规则 | 暂缓 |
| Forced Pass | 吸收成 ExitGuard / SuccessorPolicy |
| Hold Ball | **重点吸收** |
| Evidence-aware ping-pong | **重点吸收** |
| Cross-model review | 吸收为 reviewer preference |
| Event-sourced custody | 吸收，但用 SQLite 强事务 |

---

# 六十、重构之后的 handoff 应该是什么样

现在：

```text
Agent A
  ↓
send_message(B)
  ↓
Message
  ↓
Dispatch B
  ↓
Attempt B
```

重构后：

```text
                  Agent A
                     │
                     ▼
             structured handoff
                     │
                     ▼
                GuardChain
                     │
                     ▼
              Handoff Capsule
                     │
                     ▼
         custody.transfer_requested
                     │
                     ▼
               Dispatch B
                     │
                     ▼
                Scheduler
                     │
                     ▼
              Attempt B claim
                     │
                     ▼
             custody.acquired
                     │
                     ▼
              AgentTurnContext
        ┌────────────┼────────────┐
        │            │            │
    Contract      Evidence     Obligation
        │            │            │
        └────────────┼────────────┘
                     ▼
                  Agent B
                     │
                     ▼
              ControlAction
                     │
                     ▼
                ExitGuard
                     │
                     ▼
             CompletionEngine
```

这个链路才真正达到：

> **Agent A 不需要把自己的完整 context 复制给 B，但 A 已完成工作的“有效事实”和责任关系不会丢。**

---

# 六十一、我会把整个重构压缩成五个真正的 P0

如果你的开发资源有限，不要同时做 14 个 PR。

首先只做这五项：

### P0-1 — Custody

```text
谁负责当前 WorkSubject
```

从隐含状态变成第一等数据。

### P0-2 — Handoff Capsule + Evidence

从：

```text
“B，你看看”
```

升级到：

```text
任务 + 已完成工作 + 证据 + 未决问题 + 预期产出
```

### P0-3 — ExitGuard

彻底消灭：

```text
controlAction == null
→ finish
```

这个隐式等价。

### P0-4 — Completion Engine

彻底消灭：

```text
没有 queued Dispatch
→ Run completed
```

这种完成判断。

### P0-5 — AgentTurnContext

彻底消灭：

```text
最近 19 条消息
≈
完整协作上下文
```

---

# 六十二、最终的产品架构定位

重构前可以描述为：

> agent-gand 是支持 Pipeline / Supervisor / Collaboration / Coordination 的多 Agent 编排平台。

重构以后，我认为更准确的定位应该是：

> **agent-gand 是一个 Durable Multi-Agent Collaboration Runtime：模型拥有判断力，Protocol 提供结构，Custody 保存责任，Evidence 保存事实，Completion Engine 判断是否真正完成，Guard 保证 Agent 的自主动作不会破坏系统约束。**

它最终最有价值的分层会变成：

```text
┌──────────────────────────────┐
│ Cognitive Plane              │
│                              │
│ Agent identity               │
│ Prompt                       │
│ Context                      │
│ LLM reasoning                │
└──────────────┬───────────────┘
               │ intent
               ▼
┌──────────────────────────────┐
│ Control Plane                │
│                              │
│ handoff                      │
│ consult                      │
│ complete                     │
│ hold                         │
│ wait_user                    │
│ continue                     │
└──────────────┬───────────────┘
               │ validated action
               ▼
┌──────────────────────────────┐
│ Responsibility Plane         │
│                              │
│ Subject                      │
│ Custody                      │
│ Obligation                   │
│ Contract                     │
│ Completion                   │
└──────────────┬───────────────┘
               │ work
               ▼
┌──────────────────────────────┐
│ Execution Plane              │
│                              │
│ Dispatch                     │
│ Attempt                      │
│ Scheduler                    │
│ Tool Execution               │
│ Checkpoint                   │
└──────────────┬───────────────┘
               │ facts
               ▼
┌──────────────────────────────┐
│ Evidence / Continuity Plane  │
│                              │
│ Evidence refs                │
│ Handoff capsule              │
│ Runtime events               │
│ Recovery                     │
└──────────────────────────────┘
```

**Clowder 对 agent-gand 最重要的启发，不是“Agent 能 @Agent”，而是把“协作”从聊天行为升级成一个有状态、可验证、可恢复的 Runtime 协议。**

而 agent-gand 比较好的地方是，你已经有 Structured ControlAction、SQLite、Attempt/Lease、Checkpoint、Tool Ledger 和 Coordination Plan，所以并不需要推倒重来。真正最合理的路径是：

```text
现有 Durable Execution
        +
现有 Coordination Contract/Plan
        +
Clowder Custody/Continuity 思想
        ↓
统一 Collaboration Runtime Kernel
```

这条路线的工程风险远低于重写，也最容易利用你当前已经完成的代码。
