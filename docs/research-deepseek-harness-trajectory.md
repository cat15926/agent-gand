# DeepSeek Harness Trajectory 调研报告

调研日期：2026-09-18  
调研对象：DeepSeek Harness `master` 分支的 `packages/client/ui-trajectory` 及相关 Web Client 架构文档

## 1. 调研目标

本次调研聚焦 DeepSeek Harness 的 Trajectory（轨迹）模块如何解决以下问题：

- 长执行过程怎样保持全局时间感；
- 大量模型、工具和系统事件怎样快速定位；
- 事件摘要与完整输入输出怎样分层呈现；
- 流式更新、历史分页和用户主动检查怎样避免互相干扰；
- 哪些能力适合迁移到 agent-gand，哪些需要按多 Agent 编排模型重新设计。

主要依据：

- [Trajectory 模块说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/README.md)
- [TrajectoryView 视图编排](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/src/client/TrajectoryView.tsx)
- [TrajectoryTimeline 时间概览](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/src/client/TrajectoryTimeline.tsx)
- [TrajectoryTable 事件账本与详情检查器](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/src/client/TrajectoryTable.tsx)
- [TrajectoryToolbar 工具栏](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-trajectory/src/client/TrajectoryToolbar.tsx)
- [Web Client 架构](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client)
- [Conversation assembly](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/conversation)

## 2. Trajectory 的核心信息架构

Trajectory 没有把原始调用树直接画成一组嵌套卡片，而是拆成三个稳定区域：

1. 顶部工具栏：控制耗时模式、折叠状态和搜索。
2. 固定时间概览：以类似 Chrome Network 的多泳道时间轴展示全局分布。
3. 事件账本：按 Turn/Step 排列紧凑事件行；选择事件后，在右侧打开局部详情检查器。

这种结构让“浏览”和“检查”分离。用户先通过时间轴或账本找到异常，再在详情面板阅读完整输入、输出、用量和时序，而不是在主列表内持续展开大段内容。

## 3. 值得参考的功能

### 3.1 固定的多泳道时间概览

TrajectoryTimeline 使用 Input、Model、Tools 三条泳道展示记录。时间轴具备以下交互：

- 支持真实耗时宽度和等宽顺序两种模式；
- 悬停约 500 ms 后显示精确开始时间、结束时间和持续时间；
- 模型记录可进一步拆分 TTFT 与 decoding 时间；
- 单击块可选择对应账本记录；单击空白可聚焦最近记录；
- 水平拖动选择时间区间，并只保留该区间内活跃的记录；
- 滚轮围绕指针位置缩放时间域；右键拖动平移已缩放区域；
- 双击或 Escape 清除时间范围；
- 搜索命中、当前选中、错误和区间内外状态使用不同视觉状态。

它解决的不是“画得更炫”，而是让用户一眼看到并行、等待、长尾和异常发生的位置。

### 3.2 紧凑事件账本

TrajectoryTable 的主列表只保留索引、事件类型和内容摘要，并用明显的 Turn 分界和 Step 标记建立层次。主要能力包括：

- User、Assistant、Tool、Subtool、System、Context 等事件使用稳定的颜色和图标；
- 工具请求与结果在同一行通过箭头连接，减少上下跳读；
- 运行中、完成和错误状态直接体现在事件行；
- 单击选择，双击折叠 Turn 或 Assistant 下的工具调用；
- 支持折叠全部 Turn、折叠全部调用，并用摘要行保留步骤数和工具数；
- 搜索同时覆盖当前已加载轨迹，并与时间轴命中状态联动；
- 键盘 Enter/Space 可选择记录，使用 `aria-rowindex`、`aria-selected` 等无障碍语义。

当记录数超过阈值时，模块使用虚拟列表，只挂载可见行和少量 overscan。向上到达历史边界时按页加载旧记录，并保持当前滚动位置。

### 3.3 独立详情检查器

事件选择后，右侧出现可调整宽度的检查器，主体账本仍保持紧凑。详情标签根据事件类型动态变化，包括：

- 请求概览、参数、用量、Timing；
- System Prompt、Tools；
- Rendered、Raw、Source；
- Input、Output、Schema、Diff。

JSON 支持树形展开和复制值、路径、格式化 JSON；代码和 Markdown 有各自的阅读与复制方式。检查器宽度限制在合理区间，并支持拖拽和键盘调整。

### 3.4 对流式状态的克制处理

Trajectory 对运行中记录不伪造耗时：没有结束时间时显示运行态或开始标记。新事件默认跟随尾部；用户向上滚动查看历史后停止自动跟随，避免正在生成的内容打断检查。内容流式更新保持记录 key 和高度结构稳定，减少列表跳动和重复滚动。

### 3.5 面向视图的独立投影

DeepSeek Harness 让 Chat 和 Trajectory 分别从同一耐久事件窗口构建自己的展示模型，而不是让轨迹页面读取聊天页面已经加工过的状态。这样可以做到：

- 原始事件是共享事实；
- 轨迹视图拥有自己的分组、折叠、搜索和选择状态；
- 实时事件与历史重放产生一致结果；
- 聊天展示的改变不会破坏轨迹语义。

## 4. agent-gand 当前实现评估

当前工程已经具备良好的数据基础：

- `RunGraph` 表达 Run、Agent、Task、Approval 之间的逻辑关系；
- `TraceTree` 表达 Span 父子关系、总耗时、自耗时和孤立父链；
- Span 已有结构化 attributes；
- WebSocket 已推送 `run.event` 与 `llm.delta`；
- pipeline、supervisor、collaboration 使用同一观测协议。

主要问题集中在展示投影与交互层。

| 维度 | 当前状态 | 直接影响 |
|---|---|---|
| 全局时间感 | 只有每个卡片的持续时间 | 无法快速识别并行、空闲区间、长尾 Span |
| 信息密度 | 树节点使用大卡片，属性全部显示 | Span 稍多就形成很长页面，扫描成本高 |
| 定位能力 | 无搜索、类型筛选、区间筛选 | 只能逐项滚动查找错误或工具调用 |
| 层级控制 | 无单节点/全部折叠 | 深层调用树无法收口 |
| 详情阅读 | 输出截断后直接铺在行内 | 输入、输出、属性、用量和时序没有清晰分区 |
| 视图联动 | TraceTree 与 RunGraph 独立静态展示 | 无法从时间轴、拓扑定位同一个 Span/实体 |
| 实时更新 | ObserveView 只在选择 Run 时获取一次 observability | 运行中的页面不会持续重建 TraceTree/RunGraph |
| 大数据性能 | API 一次返回全部 input/output；DOM 递归渲染全部节点 | 长会话响应和渲染成本随正文体积快速增加 |
| 高级时序 | 只有 startedAt/endedAt | 无法展示 TTFT、模型生成阶段、等待审批时长细分 |
| 分组语义 | 仅父子树，没有任务/轮次视觉分段 | Supervisor 返工和 Collaboration dispatch 不易辨认 |

本地现有真实会话中，一个 42 Span 的 observability 响应约 134 KB，主要体积来自完整 LLM input/output。继续增加 Span 数后，主列表布局和网络传输都会成为瓶颈。

## 5. 适合直接借鉴的设计

以下交互可以直接迁移：

- 顶部固定时间概览；
- 真实耗时/等宽顺序切换；
- 搜索、类型筛选、折叠全部；
- 紧凑事件账本；
- 时间轴、账本、详情检查器三方选中联动；
- Input、Output、Attributes、Timing、Usage 分栏；
- JSON 格式化和快捷复制；
- 运行中不伪造耗时；
- 用户离开底部后暂停自动跟随；
- 长列表虚拟化和按需加载详情。

## 6. 必须按多 Agent 场景改造的部分

DeepSeek Harness 的泳道和分组围绕单个 Agent 的 Input/Model/Tools。agent-gand 应改成：

- 泳道：编排、Agent、模型、工具/审批；
- pipeline 分组：Agent 步骤；
- supervisor 分组：Task → work/review attempt；
- collaboration 分组：dispatch/batch，并显示 from → target；
- 详情中加入 Agent、Task、Attempt、Dispatch、Approval 的关联跳转；
- RunGraph 保留为第二视图，并与轨迹选择共享实体高亮；
- Agent 并行工作必须在时间轴上分别可辨认，而不是全部合并到一条 Assistant 泳道。

## 7. 不建议首版照搬的能力

- 不在首版实现历史无限分页。agent-gand 当前单 Run 规模有限，应先完成摘要/详情拆分和虚拟列表；达到阈值后再启用游标分页。
- 不在首版实现所有右键手势。滚轮缩放、拖动区间、双击复位已能覆盖主要需求，右键平移可放到增强阶段。
- 不复制 DeepSeek Harness 的 Turn/Step 数据模型。应从现有 task、attempt、dispatch 和 Span attributes 构建 agent-gand 自己的 `TrajectoryGroup`。
- 不把聊天事件与 Trace 强行混为一张表。消息可作为可选轨迹类型，默认聚焦执行事件。

## 8. 结论

agent-gand 当前缺少的不是更多观测数据，而是一层适合人阅读的轨迹投影。最有效的优化路径是：以时间概览提供全局定位，以紧凑账本承载扫描，以按需详情检查器承载深读，再用 RunGraph 表达多 Agent 拓扑。现有统一观测协议可以继续作为底层事实层，但需要增加轻量摘要、详情按需加载、TTFT 和多 Agent 分组语义。
