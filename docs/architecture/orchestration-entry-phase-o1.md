# 编排入口阶段 O1：共同请求契约与比较预览

状态：**已完成 O1 本地实现与验证**。日期：2026-10-05。总方案见[编排入口收敛计划](../plans/orchestration-entry-convergence-implementation-plan.md)，验证记录见[O1 验收报告](../reports/orchestration-entry-phase-o1-acceptance.md)。

## 生效范围

O1 为旧入口建立共同规范化、配置预检、幂等提交与持久比较记录。新预览结果明确标注 `comparisonOnly: true`，新快照标注 `executionAuthority: legacy`。现有 Runtime、RunMode、Coordination Plan 与 dispatcher 仍然决定实际执行。

O1 完成时没有启用新的每轮策略执行、空房创建、外部成员 Coordination 步骤执行或前端改版。2026-10-06 的 [O2](./orchestration-entry-phase-o2.md) 已按验证组合开放 SDK/app-server 的 Coordination 步骤与评审；其他内容由 O3–O5 实施。比较预览自身仍不构成执行授权。

## 协议

shared 的 [orchestration.ts](../../packages/shared/src/orchestration.ts) 新增：

- `OrchestrationRequest`：规范化内容、候选团队、明确目标、策略/工作流、引用、约束与旧入口上下文。
- `OrchestrationCapabilitySnapshot`：角色版本/摘要、驱动、工具与权限、账户版本元数据、已注册工作区摘要。
- `OrchestrationDecision`：基本确定性目标选择、策略、协议、原因、冲突及后续阶段门禁。
- `RunOrchestrationSnapshot`：已提交请求的比较记录、真实 legacy 执行设置、Run/聊天室关联及提交摘要。

`CapabilitySnapshot` 原有名称仍属于 Coordination，不把新执行描述直接塞入旧快照，也不把 `auto` 添加到 `RunMode`。

`nativeTools` 是角色配置中的免审/白名单，不是完整原生工具目录。驱动提供的固定读取能力仍受后端政策管理。`driverDetection: not_performed` 表示没有检查客户端二进制；账户 `configured` 仅表示配置元数据齐备，不保证凭证可解密、原生登录文件有效或真实模型可调用。

## 只读预览 API

`POST /api/orchestration/preview` 返回 HTTP 200：

```json
{
  "goal": "@coder 只读检查接口",
  "agentIds": ["coder", "planner"],
  "recipientIds": ["coder"],
  "strategy": "auto",
  "workflow": "routine",
  "constraints": { "readonly": true }
}
```

已有聊天室传 `conversationId`，团队、成员版本、工作区和默认角色从当前聊天室读取。若同时提供团队或工作区，必须与该聊天室一致；不隐式修改房间。新预览接口拒绝未知字段和未知约束。

返回 `request`、`capabilities`、`decision`、`fingerprint`，同时返回：

```json
{
  "comparisonOnly": true,
  "testedModel": false,
  "dispatchCreated": false
}
```

预览不保存 Draft/Plan/Run，不创建 Subject 或执行槽，不调用 planner、模型、SDK、CLI，不验证原生登录文件，不解密账户 Key。它只读取角色、账户版本、既有测试记录、工具目录和工作区注册元数据。不存在/停用/能力不足等情况由结构化错误或 decision issues 表达。

账户测试状态仅匹配当前角色的 backend/model，并校验配置、凭证和身份版本；其他模型的历史 PASS 不代表当前模型已经通过测试。

规则优先处理明确目标、有效 @、回复来源、全队请求，再从配置可用的执行成员中选候选。名字重复、@ 未识别、目标冲突、CLI 不兼容、硬 token 限制等都有明确 issue。自动多人并行仅在显式只读约束下建议；复杂任务识别、健康排序、工作流展开与实际执行将在 O4 收敛。

## 指纹与过期检查

SHA-256 指纹覆盖规范化语义、成员版本、角色配置摘要、账户配置/凭证/身份版本及状态、工具权限、工作区注册摘要、resolver 和模板版本。来源名称、客户端请求 ID 不影响同义预览。

旧提交接口可附 `orchestrationFingerprint`。服务在提交事务内重新准备请求并校验，过期返回 HTTP 409、`code: PREVIEW_STALE`。成员、账户、工作区或任务内容变化后需要重新预览。

O1 新工作流只是比较建议。旧执行接口收到 `strategy`、`workflow`、`constraints` 等新执行字段时返回 `COMPARISON_ONLY`，不会忽略硬约束后继续调用模型。旧策略兼容预览应使用与旧执行相同的输入；带新约束的预览不能作为旧执行已落实约束的证明。

## 入口映射

| 入口 | 规范化来源 | O1 处理 | 实际执行 |
|---|---|---|---|
| `POST /api/conversations` | room_create | 共同预检、事务、可选创建幂等键、比较快照 | 仍按旧 mode / plan |
| `POST /api/runs` | direct_run | 同上，保留旧 Run 响应结构 | 仍按旧 mode |
| `POST /api/conversations/:id/messages` | conversation_message | 同上，必需消息幂等键、回复/任务引用检查 | 仍按现有追问规则与 plan |
| `POST /api/coordination/preview` | coordination_preview | 先用共同契约规范化，再调用原有规划器 | 原有模型规划/保存 Draft 行为保留 |
| `POST /api/conversations/:id/followup-preview` | followup_preview | 先共同预检，再按原规则推荐 | 原有响应字段与路由规则保留 |
| `POST /api/orchestration/preview` | unified_preview | 纯读取、规则比较 | 不执行 |

内部 seed、Run 恢复、Runtime 控制动作、PlanRevision 和步骤尝试不是新的用户任务提交入口。本阶段不替换它们的冻结契约；动作服务与派发收敛属于 O2/O3。

## 提交与幂等

共同提交服务位于 [orchestration/service.ts](../../apps/server/src/orchestration/service.ts)。事务顺序：幂等查找 → 规范化/配置预检 → 可选指纹复核 → 原有准入/计划校验 → 创建房间（如需）与 Run → 用户消息 → 激活已有计划（如需）→ 比较快照 → commit。commit 后旧 dispatcher 才接到入队请求。

SQL 唯一索引与 `BEGIN IMMEDIATE` 保证跨进程竞争时只接纳一次。既有事件总线在 afterCommit 才广播，回滚不会留下一条仅界面可见的假任务。

| 入口 | 客户端幂等键 | 作用范围 |
|---|---|---|
| 已有聊天室消息 | `clientMessageId`，必需，8–100 字符 | `conversation:<id>` |
| 创建聊天室 | `clientRequestId`，可选，8–100 字符 | `entry:room_create` |
| 直接 Run | `clientRequestId`，可选，8–100 字符 | `entry:direct_run` |

建房前没有 room ID，因此采用入口范围；调用方应生成唯一随机 ID。未提供创建幂等键时维持旧接口“每次创建新房”的行为。

提交摘要只记录调用方意图，不含后续可变的账户/团队版本。同键同内容返回原 Run，配置变化也不会导致重新派发；同键不同内容返回 409 `IDEMPOTENCY_CONFLICT`。初次接纳时检查指纹，既有已接纳请求重试不再次进行准入。

旧消息没有 O1 摘要时，通过内容、目标、回复、任务、路由标记及可验证的计划引用判断；无法确认一致则返回 409，请调用方使用新 ID。不会重新执行旧消息，也不会伪造历史能力快照。

首轮消息也在提交事务中保存，带服务器写入的 `meta.orchestrationSource` 和稳定消息 ID。dispatcher 对无定向的首轮继续使用旧编排，避免把“消息已经落库”误判为追问；首轮有明确目标时保留原有定向行为。后续恢复从持久消息读取，不依赖路由进程内的输入 Map。

## 查询与迁移

`GET /api/runs/:runId/orchestration` 返回 `{ snapshot, comparisonOnly: true }`。未知 Run 返回 404；前 O1 的 Run 返回 `snapshot: null`。

增量表 `orchestration_requests` 保存请求/比较记录，schema_version=1，run_id 唯一，作用范围与 client_request_id 组成部分唯一索引。启动 schema 幂等创建；没有修改旧 RunMode、Runtime 契约或账户冻结结构，没有 backfill 当前角色到历史请求。

新房可能自动获得 `room-...` 工作区。预览记录保持用户提交时的输入；真实接纳的模式、成员、工作区、主管、评审者与计划 ID 在 `legacyExecution` 中单独冻结。当前执行不从比较快照读取配置。

回退 O1 入口代码时保留新增表和用户消息；旧二进制不认识首轮来源标记可能改变恢复分类，因此已有 pending 首轮应使用支持 O1 来源标记的 worker 收尾。后续正式灰度/跨版本回滚由 O6 给出完整方案。

## 验证命令

```sh
pnpm verify:orchestration-o1
pnpm typecheck
pnpm verify:coordination-planner
pnpm verify:followup-stage3
pnpm verify:coordination
pnpm verify:accounts-e3
pnpm verify:runtime-run-policy
pnpm verify:docs
```

专项测试使用临时 SQLite、模拟角色/凭证和 mock 模型，包含两个独立进程同时提交、重启后重试、凭证文件暂不可读取时预览仍不解密、失效指纹、失败事务以及首轮流水线语义。它不验证真实供应商可用性。
