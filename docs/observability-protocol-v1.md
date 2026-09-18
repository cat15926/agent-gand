# 统一观测协议 v1

## 目标

同一个 Run 同时提供两种互补视图：`RunGraph` 描述编排关系，`TraceTree` 描述实际调用层级和耗时。pipeline、supervisor 与 collaboration 共用同一套 Span 数据，不再由各模式定义私有观测格式。

## HTTP 契约

`GET /api/runs/:id/observability` 返回完整协议；`?payload=summary` 返回不含完整 input/output 的轻量轨迹，选择 Span 后通过 `GET /api/runs/:runId/spans/:spanId` 按需读取详情。

```json
{
  "protocolVersion": 1,
  "graph": { "protocolVersion": 1, "runId": "...", "mode": "supervisor", "nodes": [], "edges": [] },
  "trace": { "protocolVersion": 1, "runId": "...", "roots": [], "totalSpans": 0, "maxDepth": 0 }
}
```

共享 TypeScript 类型位于 `packages/shared/src/run.ts`。协议只允许以可选字段方式向后兼容扩展；删除字段、改变字段语义或收窄取值需要升级主版本。

## RunGraph

节点类型为 `run | agent | task | approval`。边类型为：

| 边 | 含义 |
|---|---|
| `contains` | Run 包含 Agent 或审批 |
| `next` | pipeline 的下一执行者 |
| `coordinates` | 主管协调 Agent |
| `creates` | 主管或 Run 创建任务 |
| `assigned_to` | 任务指派给执行者 |
| `reviewed_by` | 任务由 Reviewer 审查 |
| `depends_on` | 任务依赖另一任务 |

节点 ID 使用 `<kind>:<entityId>`，便于客户端稳定定位。RunGraph 表达逻辑拓扑，不代替 Trace 的时间关系。

## TraceTree

TraceTree 由 `run_events.parent_id` 聚合。每个节点包含原始 Span、子节点、深度、总耗时、自耗时和 `orphaned` 标记。运行中的 Span 耗时为 `null`。父节点缺失、自引用或循环引用时，该节点作为根节点返回并标记 `orphaned=true`，其余 Trace 仍可读取。

## Span 属性约定

属性是扁平、可检索的 JSON 对象；键使用小写点分命名，值限制为字符串、数字、布尔值、`null` 或这些原始值的数组。完整输入输出仍写入 `input/output`，避免属性无限膨胀。

所有新 Span 自动包含：

- `observability.version`
- `run.id`
- `run.mode`

各类 Span 使用以下标准键：

- Agent：`agent.id`、`agent.role`、`orchestration.phase`
- 任务：`task.id`、`task.attempt.id`、`task.attempt.no`
- LLM：`llm.model`、`llm.round`
- 工具与审批：`tool.name`、`approval.id`
- Collaboration：`collaboration.dispatch.id`、`collaboration.batch.id`

LLM Span 额外记录 `firstTokenAt`。有流式正文时它表示第一个正文增量到达时间，可用于计算 TTFT 和 decoding；未流式、无正文或历史记录保持 `null`。

## Trajectory 分组

观测响应的 `groups` 将同一 Trace 投影为适合账本展示的业务分组：pipeline 按 Agent 步骤，supervisor 按执行/审查 attempt，collaboration 按 dispatch。无法识别语义属性的历史 Span 进入 system 分组，不丢弃原始事件。

## 兼容规则

启动时通过幂等迁移为旧库增加 `run_events.attributes TEXT NOT NULL DEFAULT '{}'`。读取旧 Span 时，会从名称前缀尽力恢复 `agent.id`、`llm.model` 或 `tool.name`；损坏的属性 JSON 回退到该兼容路径。历史数据不重写，原始证据链保持不变。
