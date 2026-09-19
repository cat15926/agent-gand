# agent-gand 观测模块优化实施方案

方案日期：2026-09-18  
前置条件：统一观测协议 v1 已完成  
参考报告：[DeepSeek Harness 轨迹模块调研](../research/deepseek-harness-trajectory-research.md)

实施状态：阶段 A、B、C、D 已完成，计划 3 已收口。

最终验收版本已实现：摘要/详情分离、TTFT 持久化、三种运行模式分组、历史数据语义恢复、四泳道时间轴、区间选择与缩放、筛选折叠、虚拟账本、尾部跟随、详情检查器、WebSocket 增量与断线校准、键盘和窄屏交互、React Flow + ELK 只读拓扑，以及图轨双向联动。ELK 按需加载，聊天主入口不承担布局引擎体积。

## 1. 预期结果

优化后的观测模块默认进入“执行轨迹”视图，页面由运行选择器、运行摘要、时间概览、事件账本和详情检查器组成。用户可以在数秒内回答：

- 哪个 Agent 正在工作或发生失败；
- 哪个模型/工具最耗时；
- Supervisor 的任务经历了几次执行和审查；
- Collaboration 的消息被派给谁、在哪个 dispatch 中继续；
- 某个 Span 的完整输入、输出、属性、用量和时间数据是什么。

RunGraph 作为“编排拓扑”视图保留，并与轨迹共享选择状态。它不再以左右两列节点/边文本展示，而是展示可定位的逻辑关系图。

## 2. 目标页面结构

```text
┌────────运行列表────────┬──────────────────当前 Run─────────────────────────┐
│ 搜索/状态筛选          │ 状态  总耗时  Token  成本  错误数                 │
│ Run A                  ├───────────────────────────────────────────────────┤
│ Run B                  │ [执行轨迹] [编排拓扑]   搜索  类型筛选  折叠      │
│ Run C                  ├───────────────────────────────────────────────────┤
│                        │ 编排  ━━━━━                                        │
│                        │ Agent    ━━━━━━━━━  ━━━━━                           │
│                        │ 模型       ━━━━━      ━━━                           │
│                        │ 工具          ━━        ━                           │
│                        ├──────────────────────────────┬────────────────────┤
│                        │ 事件账本                     │ Span 详情          │
│                        │ Task 1 / Attempt 1           │ 概览/输入/输出     │
│                        │   Agent coder       12.4s    │ 属性/Timing/Usage │
│                        │     LLM model        8.2s    │                    │
│                        │     Tool fs.read     0.1s    │                    │
└────────────────────────┴──────────────────────────────┴────────────────────┘
```

窄屏时详情检查器改为右侧抽屉，运行列表可以收起。轨迹仍是主区域。

## 3. 数据契约调整

保持 observability v1 向后兼容，以可选字段和新接口扩展。

### 3.1 Span 摘要与详情拆分

新增共享类型：

```ts
interface SpanSummary {
  id: string;
  runId: string;
  parentId: string | null;
  spanKind: SpanKind;
  name: string;
  status: SpanStatus;
  attributes: SpanAttributes;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: string;
  firstTokenAt?: string | null;
  endedAt: string | null;
  inputBytes: number;
  outputBytes: number;
  hasInput: boolean;
  hasOutput: boolean;
}

interface SpanDetail extends SpanSummary {
  input: string | null;
  output: string | null;
}
```

新增接口：

- `GET /api/runs/:id/observability?payload=summary`：轨迹首屏只返回摘要；
- `GET /api/runs/:runId/spans/:spanId`：选择记录后加载完整 input/output；
- 原 `GET /api/runs/:id/observability` 在过渡期保持完整返回，避免破坏已有调用。

验收数据集上，摘要响应体相对完整响应至少减少 60%。

### 3.2 Trajectory 投影

新增 `TrajectoryGroup`：

```ts
interface TrajectoryGroup {
  id: string;
  kind: 'pipeline_step' | 'task_attempt' | 'review_attempt' | 'dispatch' | 'system';
  label: string;
  status: string;
  agentId?: string;
  taskId?: string;
  attemptId?: string;
  dispatchId?: string;
  spanIds: string[];
}
```

聚合规则：

- pipeline：按顶层 Agent Span 分组；
- supervisor：按 `task.id + task.attempt.id` 分组，执行和审查分别显示；
- collaboration：按 `collaboration.dispatch.id` 分组；
- 找不到语义属性的历史 Span 放入“未分组事件”。

### 3.3 TTFT 与阶段时间

为 LLM Span 增加 `first_token_at`。服务端收到同一 Span 的第一个 `llm.delta` 时只写入一次，用于计算：

- TTFT = firstTokenAt - startedAt；
- decoding = endedAt - firstTokenAt；
- total = endedAt - startedAt。

没有 first token 或仍在运行时保持 `null`，前端不得伪造数值。

## 4. 前端功能拆分

### 4.1 运行摘要

顶部展示状态、总耗时、Span 数、错误数、Token、成本和活动 Agent 数。状态和错误可以点击，点击后应用对应筛选。

### 4.2 TrajectoryToolbar

- 全文搜索：名称、输入输出摘要和 attributes；
- 类型筛选：编排、Agent、模型、工具、审批、消息；
- 状态筛选：运行中、成功、失败；
- 真实耗时/等宽顺序切换；
- 全部折叠/展开；
- 清除时间范围和筛选。

### 4.3 TrajectoryTimeline

- 四条泳道：编排、Agent、模型、工具/审批；
- Span 宽度按真实持续时间绘制，运行中显示开始标记；
- Hover 显示精确时刻、总耗时、自耗时；LLM 增加 TTFT/decoding；
- 单击 Span 选择并滚动到账本记录；
- 拖动区间筛选账本；
- 滚轮缩放、双击复位；
- 选中、搜索命中、错误、区间外记录使用不同视觉状态。

首版不加入右键平移；如果缩放后确有强需求，再增加拖拽平移。

### 4.4 TrajectoryLedger

- 使用紧凑行，不在行内直接展开 attributes 和完整 output；
- 分组标题显示任务/尝试/dispatch、Agent 和状态；
- 行展示层级、类型、名称、内容摘要、开始时间和耗时条；
- 单节点折叠、分组折叠、全部折叠；
- 搜索时自动显示匹配记录，并保留必要祖先上下文；
- 100 行以上启用虚拟列表；
- 新记录到达且用户位于底部时继续跟随，用户向上滚动后暂停跟随并显示“回到最新”。

### 4.5 SpanInspector

右侧详情检查器标签：

- 概览：状态、父子关系、Agent/Task/Attempt/Dispatch、总耗时、自耗时；
- Input：格式化 JSON/文本，支持复制；
- Output：格式化 JSON/Markdown/文本，支持复制；
- Attributes：可折叠 JSON 树，支持复制键、值和全部 JSON；
- Timing：开始、首 token、结束、TTFT、decoding；
- Usage：输入/输出 Token、成本、模型和 stop reason。

支持拖拽调整宽度；窄屏使用抽屉。切换相邻 Span 时保留最近使用的详情标签。

### 4.6 RunGraphPanel

- Run、Agent、Task、Approval 使用不同节点样式；
- pipeline 按顺序横向排列；supervisor 以主管为中心展示任务与执行/审查 Agent；
- collaboration 首版展示参与 Agent，后续在协议补充 dispatch graph 后显示动态交接；
- 点击节点过滤相关 Span；点击轨迹中的 task/agent 属性反向高亮图节点；
- 保留节点/边文本列表作为无障碍和调试备用视图。

## 5. 实时更新方案

ObserveView 已按以下规则完成实时更新：

1. 初次进入使用摘要接口加载稳定快照；
2. 当前活动 Run 的 `run.event` 直接增量更新轨迹记录；
3. `task.updated`、`approval.updated` 触发防抖后的 RunGraph 刷新；
4. `llm.delta` 只更新运行中详情预览，不把每个 token 写入事件账本；
5. WebSocket 重连后重新获取摘要快照，避免事件缺口；
6. 已完成的历史 Run 不再维持实时订阅。

## 6. 实施阶段

### 阶段 A：协议与性能基础

- 增加 SpanSummary、SpanDetail、TrajectoryGroup；
- 增加摘要接口和单 Span 详情接口；
- 持久化 firstTokenAt；
- 增加多模式分组聚合与兼容规则；
- 扩充 observability 验证脚本。

交付判据：旧接口与历史数据继续可读；摘要响应不包含 input/output；三种模式均生成稳定分组；TTFT 可验证。

### 阶段 B：轨迹主界面

- 新增运行摘要、工具栏、四泳道时间概览和紧凑账本；
- 实现选择联动、搜索、类型/状态筛选、折叠；
- 新增详情检查器及按需加载；
- 轨迹成为默认视图，RunGraph 保留切换入口。

交付判据：用户无需展开卡片即可定位错误、最慢 Span 和关联 Agent；所有完整正文只在详情中加载。

### 阶段 C：实时、性能与可访问性

- 接入 WebSocket 增量和断线重建；
- 加入虚拟列表、尾部跟随控制和大数据性能保护；
- 完成键盘操作、ARIA、焦点管理和窄屏抽屉；
- 覆盖 1,000 Span 压力数据。

交付判据：流式更新不打断历史检查；1,000 Span 下滚动和筛选无明显卡顿；键盘可完成筛选、选择、切换详情和关闭面板。

### 阶段 D：RunGraph 联动

- 实现只读拓扑布局；
- 与轨迹共享 Agent/Task/Approval 选择；
- 补充图例、适配窗口和文本备用视图。

交付判据：从拓扑节点可定位相关 Span，从 Span 可反向高亮实体；刷新后结果一致。

## 7. 验收清单

- 默认打开执行轨迹，10 秒内可以找到最慢 Span 和第一个错误 Span；
- 时间轴、账本、详情检查器选择保持一致；
- 支持搜索、类型筛选、状态筛选、分组折叠和时间区间筛选；
- LLM 显示总耗时、TTFT、decoding、Token、成本和 stop reason；
- Supervisor 的 work/review/返工尝试可以明确区分；
- Collaboration 的 dispatch 与目标 Agent 可以明确区分；
- 运行中 Span 不显示虚假结束时间；
- 查看历史时，新事件不会强制把滚动位置拉回底部；
- Input/Output/Attributes 支持完整查看和复制；
- 旧 Run、孤立父链和缺少新属性的 Span 正常展示；
- `pnpm typecheck`、Web build、scheduler、collaboration、P0 tools 和 observability 回归全部通过。

## 8. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 时间轴功能过多导致首版拖延 | 阶段 B 先实现选择、区间和缩放；平移留在增强阶段 |
| 摘要/详情拆分破坏旧页面 | 保留旧接口，新增 summary 查询和 detail 端点 |
| 实时事件与 REST 快照重复或乱序 | Span ID 幂等 upsert，重连以 REST 快照为准 |
| 历史数据缺少 task/dispatch 属性 | 提供“未分组事件”，沿用现有名称兼容推断 |
| 大文本阻塞主线程 | 首屏不传 input/output，JSON 格式化只在详情打开时执行 |
| RunGraph 自动布局投入过大 | 首版使用确定性分层布局，不引入可编辑画布 |

## 9. 建议评审决策

建议本轮确认以下范围后开始实施：

1. 轨迹作为观测模块默认入口，RunGraph 为第二入口；
2. 采用“编排、Agent、模型、工具/审批”四泳道；
3. 完整 input/output 改为选择 Span 后按需加载；
4. 首版包含拖动区间和滚轮缩放，暂不包含右键平移；
5. 阶段 B 完成后先提供一次人工体验验收，再继续阶段 C、D。
