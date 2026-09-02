# 多 Agent 协作工具平台 · 需求调研报告

> 调研时间：2026 年 9 月
> 调研目的：为在 `agent-gand` 目录下从零搭建一个多 agent 协作工具平台服务提供需求输入，聚焦两个核心问题——**市面上主流多 agent 协作平台有哪些功能**、**它们采用什么样的 UI 布局**。
> 调研方法：4 路并行调研（开发者框架类 / 低代码商业平台类 / 前沿 agent 产品类 / UI 布局专项），信息来源以官方文档、官方博客、GitHub 仓库为主，辅以第三方评测与社区口碑，交叉验证。全部来源链接见附录。

---

## 目录

1. [市场格局总览](#1-市场格局总览)
2. [主流平台功能调研](#2-主流平台功能调研)
3. [核心功能对比矩阵](#3-核心功能对比矩阵)
4. [多 agent 协作机制模式总结](#4-多-agent-协作机制模式总结)
5. [UI 布局调研](#5-ui-布局调研)
6. [趋势与洞察](#6-趋势与洞察)
7. [对自建平台的建议](#7-对自建平台的建议)
8. [附录：参考资料](#8-附录参考资料)

---

## 1. 市场格局总览

2026 年的多 agent 协作市场已经分化为三层，各层的功能侧重与 UI 形态差异明显：

| 层 | 定位 | 代表产品 | 典型用户 | 典型 UI 形态 |
|---|---|---|---|---|
| **开发者框架层** | 代码优先的编排引擎/SDK | LangGraph、CrewAI、AutoGen/AG2、MetaGPT、CAMEL/Owl、AgentScope、ChatDev、Microsoft Agent Framework、OpenAI Agents SDK、Google ADK | 工程师、研究者 | Agent IDE（图视图 + 调试面板）、Studio 可视化调试器、CLI/TUI |
| **低代码平台层** | 可视化画布搭建应用/工作流 | Dify、Coze（扣子）、n8n、Langflow、Flowise、Copilot Studio、Relevance AI、Lindy、百度千帆 AppBuilder、智谱清流 | 公民开发者、业务团队、企业 IT | 节点画布编辑器 + 右侧预览调试面板 + 管理后台 |
| **自主 agent 产品层** | 委派任务给自主 agent（舰队） | Claude Code、ChatGPT agent、Devin、Manus、Cursor、GitHub Copilot coding agent、Jules | 开发者、知识工作者 | 聊天 + 实时工作区分屏、舰队/任务看板、回放时间线 |

几个总体判断（后文展开）：

- **没有任何一款产品用单一界面形态覆盖全生命周期**。成熟产品的共同做法是沿"构建 → 运行 → 审批 → 规模化并行 → 运维观测"组合多种 UI 模式。
- **"纯聊天窗口"已被业界公认为不足以承载 agent 产品**；进度可见、过程透明、可随时介入、自主性粒度可配置，是 2026 年 agent UX 的四条底线共识。
- **MCP 已成为工具接入的事实标准**（Dify、n8n、Langflow、Flowise、Relevance AI、Claude Code、Cursor、Copilot 全部支持双向 MCP），A2A 是跨系统 agent 通信的新兴协议（Google ADK、AG2 支持）。
- **微软系完成整合**：AutoGen 转入维护模式，与 Semantic Kernel 合并为 Microsoft Agent Framework（2025.10 公开预览）；可视化侧留给商用的 Copilot Studio。

---

## 2. 主流平台功能调研

### 2.1 开发者框架类

#### LangGraph（LangChain）—— 生产采用率最高的编排引擎

- **定位**：低层级、高可控的 agent 运行时，以"状态图（StateGraph）"构建有状态、可持久化、支持人机协同的长时应用；2025.10 发布 1.0 LTS。Python/TS 双语言，MIT。
- **核心功能**：
  - 编排：显式图 = 共享 State + Node（函数）+ Edge（含条件边、循环）；`Command(goto/update)` 实现节点内动态路由与 handoff；`Send` API 运行时 map-reduce 动态并行扇出；subgraph 子图嵌套。
  - 高层多 agent 库：`langgraph-supervisor`（主管路由）、`langgraph-swarm`（handoff 群集）。
  - 记忆：Checkpointer（线程内短期记忆，Postgres/SQLite/Redis 持久化，支持 time-travel 回放）+ Store（跨线程长期记忆）。
  - HITL：`interrupt()` 动态中断（携带 payload 供人审阅，`Command(resume=...)` 恢复）+ 编译期断点 + 工具调用审批中间件。
- **UI（LangGraph Studio，自称"第一个 Agent IDE"）**：桌面 App / Web / 本地 dev server 三形态，**代码即真相**（图由代码生成，改代码热更新）：
  - 中央上方：**图画布**，节点-连线图，运行时节点实时高亮执行进度，可随时打断；
  - 左侧：按 state schema **自动渲染的输入表单**（可切 JSON 视图）+ Submit/Interrupt 控制；
  - 右侧：**Threads 线程面板**，历史按"轮次→节点→state key"三级展开；任一节点可 **"Edit node state" 后 Fork 新分支重跑**或"Re-run from here"从检查点重放——长任务调 prompt 不必从头跑。
- **口碑**：控制力与可审计性最强、生产案例最多；学习曲线陡，深度绑定 LangChain 生态。

#### CrewAI —— 上手最快的"角色 × 任务"框架

- **定位**：以 Agent（role/goal/backstory 人设）+ Task（description/expected_output/context）为核心抽象；MIT 开源核心 + 商业平台（CrewAI AMP/Enterprise）。
- **核心功能**：sequential（顺序流水线）/ hierarchical（manager LLM 委派）两种进程；**Flows** 事件驱动工作流（`@start/@listen` 注解 + 共享状态 + 内置重试）；统一 Memory 类（短期/长期/实体，支持 Mem0、Qdrant）；内置 Knowledge RAG；任务级 `human_input` 人工介入 + Flow 级暂停-恢复（webhook 驱动）；平台侧有幻觉护栏、PII 脱敏、几十种 SaaS 集成与触发器。
- **UI（Crew Studio，平台内置）**："AI 辅助 + 可视化 + 测试"三合一：
  - **提示词创建页**：自然语言描述需求（支持语音），AI 自动生成 agents/tasks/工具；
  - **编辑器三栏**：左"AI Thoughts"（搭建过程流式推理）｜中 Canvas 画布（节点+连线，可拖拽）｜右 Resources 组件库；另有聊天区，**聊天与画布共享状态、可互换使用**；
  - **Execution 视图**：事件时间线 + 分层日志（Details/Messages/Raw Data 三个 tab）；
  - **发布**：一键上线、导出 Python 源码 ZIP、导出 React 组件、**导出为 MCP 服务**。
- **口碑**：上手最快、角色抽象直观；细粒度控制不如 LangGraph，开源版无官方 GUI。

#### AutoGen / AG2 —— 对话式多 agent 与最早的开源可视化 Studio

- **定位**：微软出品、以"多 agent 对话"为一等公民（MIT）；**2025.10 起与 Semantic Kernel 合并为 Microsoft Agent Framework，AutoGen 转维护模式**；社区分叉 **AG2**（Apache 2.0）继续发展并支持 A2A、AG-UI 协议。
- **核心功能**：对话团队模式——RoundRobinGroupChat（轮询）、SelectorGroupChat（LLM 选下一发言者）、GraphChat（图导航）、Swarm（handoff）；组件声明式 `dump_component()` ↔ JSON 互转（JSON 即配置）；UserProxy 人类代理；termination 条件库。
- **UI（AutoGen Studio 2.0，开源，React SPA + FastAPI）**，三个主视图：
  - **Build（Team Builder）**：中央画布 = team 主节点 + agent 节点图；组件库侧栏拖拽到节点**专用 drop zone**（team 节点收 agents/termination，agent 节点收 models/tools）；节点 edit 图标弹属性面板；可整体切 **JSON Editor** 直接编辑声明式配置；
  - **Playground**：创建 session 绑定团队跑任务——agent 间消息**实时流式**、**控制转移图**可视化消息流经路径、可插入 UserProxy 人机混跑、查看产物与指标（轮次/token/工具调用成败）、pause/stop、session 回放；
  - **Gallery**：组件市场（teams/agents/models/tools），URL/JSON 导入，"pin"后填充 Builder 侧栏。
- **口碑**：AutoGen Studio 是最早最完整的开源 no-code 多 agent UI；但官方明确"研究原型、非生产就绪"；框架分裂（0.2/0.4/AG2/Agent Framework）造成迁移混乱。

#### MetaGPT / MGX —— SOP 驱动的"AI 软件公司"

- **定位**：把软件公司 SOP 编码进 prompt 流水线（`Code = SOP(Team)`，ICLR 2024 Oral）：产品经理→架构师→项目经理→工程师→QA，各角色产出**结构化文档**（PRD/设计/API）供下游消费，显著降低幻觉级联。MIT。
- **核心功能**：Role/Action 编程式定义；**发布-订阅消息总线**（角色 `_watch` 订阅关心的 Action，天然解耦）；短期 Memory + RAG；DataInterpreter 数据解释器。商用产品 **MGX** 提供 Deep Research 与 Race Mode（多 agent 竞速）。
- **UI**：框架本身为 CLI 无画布；**MGX 是"聊天 + IDE 混合界面"**——与团队各角色对话 + IDE 式工作区（文件树/代码编辑/网页预览）+ **Milestone 里程碑面板**跟踪各阶段交付物。
- **口碑**：SOP + 结构化产物使多 agent 可靠性高于纯对话方案；token 绝对消耗高，固定 SOP 在非软件任务上偏刚性。

#### CAMEL / Owl —— 角色扮演研究与 GAIA 开源第一

- **定位**：CAMEL（Apache 2.0）以角色扮演（inception prompting）研究 LLM 社会；**OWL** 基于 CAMEL 构建通用任务自动化系统，GAIA benchmark 69.09 分、开源框架第一。
- **核心功能**：RolePlaying 双 agent（AI user × AI assistant）自主协作；**Workforce** 层级分派（coordinator 分解 + worker 执行 + 可"招聘"新 worker）；Owl 四角色分层：**Planner → Coordinator → Worker → Monitor**；工具生态极丰富（Browser/Search/Document/Code/MCP 等 30+ toolkit）；`HumanInputMode`（ALWAYS/ONCE/NEVER）人工介入。
- **UI**：CAMEL 无画布；**OWL 提供 Gradio 本地 Web UI**（中/英/日三语）——模型选择、UI 内配置 API key、对话式任务交互、任务历史；属"运行对话界面"而非"编排画布"。

#### AgentScope（阿里通义）—— 面向生产运行时的框架 + 调试观测 Studio

- **定位**：消息驱动、异步优先的生产级多 agent 框架，2026.5 发布 2.0（另有企业级 Java 版），Apache 2.0，国内有真实生产案例。
- **核心功能**：2.0 核心抽象——**Event System**（统一事件总线，驱动前端与 HIL 表单）、**Permission System**（工具/资源细粒度权限）、**多租户 Agent Service**（FastAPI + 预建 Web UI）、**Workspace/Sandbox**（Docker/E2B/K8s 等）、**Middleware 中间件**；编排用 pipeline / **MsgHub 群聊广播** / Agent Team；记忆支持 Agentic Memory、ReMe、Mem0；原生 **OpenTelemetry tracing**。
- **UI（AgentScope Studio，独立开源，React+Vite+Tailwind / TRPC / Node+Express / SQLite）**：
  - **Home**（Projects/Runs 管理）、**Dashboard**（token/调用次数统计）、**Runtime**（chatbot 式与运行中 agent 实时交互）、**Tracing**（OTel trace 可视化：LLM/agent 调用时间线、span 逐级展开）、**Evaluation**（评估统计）、**Friday**（内置 Copilot 兼二开 playground）。
  - 定位是**"调试观测工作台"而非拖拽编排器**。
- **口碑**：强在运行时与企业特性（多租户/权限/沙箱/观测），流程显式性不如图引擎；国内评测普遍结论："AgentScope 管运行与规模化，LangGraph 管流程精确控制，常被组合使用"。

#### ChatDev（清华/OpenBMB）—— 科研团队的平台化转型样本

- **定位**：ACL 2024 出身的"聊天驱动虚拟软件公司"；**2026.1 发布 2.0（DevAll），转型为零代码多 agent 编排平台**（Apache 2.0，30k+ stars）。
- **核心功能**：1.0 ChatChain——阶段链（设计→编码→测试→文档），每阶段**双 agent 对话**（instructor × assistant）完成原子任务；Human 模式（人扮演 Reviewer 的 HIL）；经验库记忆。2.0：**YAML 配置 + DAG 工作流抽象**，零代码编排任意场景（数据可视化、3D 生成、深度研究、游戏开发）。
- **UI（2.0 Web Console，FastAPI + Vue3/Vite）**：三个模块——**Tutorial**（分步教程）、**Workflow**（可视化画布：拖拽编排节点、配置参数、定义 context 流向，与底层 YAML 双向同步/校验）、**Launch**（上传附件→输入 prompt→运行：实时日志、中间产物查看、HITL 反馈）。1.0 另有 Visualizer 本地 Web：实时日志、**历史日志回放动画**、ChatChain 结构可视化。
- **口碑**：开箱模板实用，但偏 demo 级，企业能力缺失。

#### Microsoft Agent Framework（Semantic Kernel + AutoGen 合并）

- **定位**：2025.10 公开预览的统一开源 SDK + 运行时（MIT），.NET/Python/Go 三语言，深度绑定 Azure AI Foundry。
- **核心功能**：四大块——基础 Agents（LLM+工具+MCP）、**Harness Agent**（长任务全家桶：规划/todo 跟踪、上下文压缩、工具审批含"不再询问"、可观测）、**Workflows**（函数式 + 图式两种显式工作流，面向长时运行与 HITL）、Integrations 目录。编排模式：sequential / concurrent / group chat / handoff + Magentic 系（orchestrator + lead + actor）。
- **UI**：框架不自带画布（代码优先，VS Code + Azure Foundry Portal 为主）；微软侧唯一开源画布仍是 AutoGen Studio，官方把可视化工具定位为"原型化阶段"入口。

### 2.2 低代码 / 商业平台类

#### Dify —— 最热开源 LLMOps 平台

- **定位**：开源 LLM 应用开发平台（修改版 Apache 2.0，禁多租户转售）+ 云订阅 + 企业私有化；GitHub 最热 AI 应用项目之一。
- **核心功能**：
  - 应用类型：Chatbot / Agent / **Workflow（单次执行）** / **Chatflow（对话流）**，后两者共享画布与节点系统；
  - 节点：Start/Trigger（定时/Webhook）、LLM、Knowledge Retrieval、**Agent 节点（新版，沙箱内跑命令，可作为流程一步）**、Question Classifier、If-Else、Iteration、Loop、Code、Template、Variable Aggregator、HTTP、Tool、**Human Input（暂停等待人工输入）**、Answer/Output；
  - 串行/并行（单路径最多 50 节点）、节点跨工作流复制粘贴、Snippets 节点组复用、版本控制；
  - 知识库管道、插件生态、应用可发布为 **MCP Server**、内置 Dashboard、对接 LangSmith/Langfuse 等观测。
- **UI**：左侧导航（应用/知识库/工具/日志）；画布编辑器基于 **React Flow**——节点端口拖连线、"+"追加节点、框选复制粘贴、**自动整理布局（Cmd+O）**、Cmd+K 全局搜索；点击节点在左侧滑出**配置 Drawer**；Chatflow **调试预览面板在右侧**可收起。
- **调试三粒度**（业界标杆）：① 整流运行；② **单节点测试**（配置面板填输入→Run→"Last run"看输入/输出/耗时/错误）；③ 逐节点执行 + **Variable Inspector（可直接编辑缓存变量模拟场景，不必重跑上游）**。运行历史含 Tracing 视图（节点执行顺序/耗时/数据流向图）。
- **多 agent**：Agent 节点入工作流可串联交接，**无专门多 agent 画布**（弱于 Coze）。

#### Coze / 扣子（字节跳动）—— 零代码 + 国内渠道护城河

- **定位**：一站式 AI Bot 开发平台，零代码搭 Bot + 可视化工作流 + 一键发布到聊天渠道；国内版（豆包系模型，接微信/飞书）与国际版（GPT/Claude 等，接 Discord/TG/WhatsApp）两套独立体系。
- **核心功能**：单 Agent 模式 / **多 Agent 模式** / 工作流 / 对话流；节点含大模型、意图识别、子工作流（批处理+并行数+"忽略异常"）、代码、SQL、数据表、循环等；**自然语言生成完整工作流**（2026 主打）；知识库/数据库/长期记忆/变量；空间三级权限。
- **UI（多 Agent 编排页，官方文档明确四栏）**：
  - 面板 1（顶部）：智能体基本信息与发布历史；
  - 面板 2（左侧）：全局编排面板（全局提示词/变量/触发器/开场白），可折叠；
  - 面板 3（中间）：**画布**，默认"开始节点"已连到首个 Agent 节点，添加并连接各 Agent 节点；
  - 面板 4（右侧）：**预览与调试面板**，直接对话测试、查看运行详情；
  - **节点级单聊调试**：节点右上角对话按钮可与**指定 Agent 节点单聊**，验证单个节点表现。
- **多 Agent 机制**：节点四类——开始节点（新会话分发策略）、**Agent 节点**（各自提示词/插件/工作流/知识库，靠"适用场景"描述由上游 LLM 判断接管）、智能体节点（复用已发布单 Agent）、全局跳转条件（优先级最高，最多 5 个）。本质是 **LLM 路由式多 agent**（对话移交），无复杂拓扑。
- **口碑**：上手极快、发布渠道是最大护城河；黑盒程度高、迁移性弱、多 agent 编排深度有限。

#### n8n —— 最大的自动化集成生态 + AI Agent 集群节点

- **定位**：通用工作流自动化 + 原生 AI 能力（深度集成 LangChain），fair-code 可自托管；500+ SaaS 集成。
- **核心功能**：四类节点——App/Action、Trigger、Core（If/Switch/Merge/Code/Wait 等）、**Cluster 节点（AI 专用）**：**AI Agent 是"主节点 + 四周子节点挂载"的集群**——Chat Model（20+ 供应商）、Memory（Redis/Postgres/Zep 等）、Tools（MCP Client、自定义、**AI Agent Tool** 把另一个 agent 当工具）、Output Parser、Vector Store（十几种）；**AI Workflow Builder**（自然语言生成工作流）；MCP 双向；HITL（工具审批 + Wait 节点挂起数小时至数天 + Slack 按钮）；Evaluations、Insights、Git 源码管理。
- **UI**：左侧栏（Overview/Projects/Templates/Insights）；顶栏（工作流名/Save/**Publish**/Share/**History 版本历史**）；画布为点阵网格，**新画布基于 Vue Flow 重写**，右下角悬浮缩放控件 + **Tidy up 自动整理** + 便签 Sticky Notes（Shift+S，Markdown，充当分区标题）+ **Canvas Groups 命名节点分组** + 小地图；节点面板按 `+`/N 键唤出（覆盖式，分类含 "Human in the loop"）；hover 节点出执行/启停/删除按钮；**Chat 面板右下角对话气泡**实时调试。
- **多 agent**：AI Agent 节点互为工具（"AI Agent Tool"）+ 子工作流复用，实现 Supervisor/Worker 层级，无专门拓扑视图。

#### Langflow（现 IBM 生态）—— LangChain 的可视化正统

- **定位**：MIT 开源，把 LangChain 组件变成画布节点；DataStax 托管云已于 2026.3-4 关停，**自托管成默认**；v1.8.4 起三大能力：**MCP Server 导出**（任意 flow 编译成 MCP 服务器）、**LangGraph 可视化多 agent 编排**（agent 节点 + 条件边 + 共享 state）、升级版 Agent 节点。
- **UI**：左侧组件库分类侧栏（helpers/prompts/models/vector stores/logic…）+ 中央画布（**彩色类型化端口**连线）+ 侧面板配参数与凭证 + Playground 聊天预览；1.8 加入 flow 与组件级 **trace**，1.11 加入原生 **HITL 工具审批**、A2A 支持。
- **口碑**：MIT 无限制、RAG 原型 10-15 分钟；**画布超约 20 节点后体验显著恶化**（无分组/子流程抽象），复杂生产最终常回落到代码。

#### Flowise —— 最轻量的开源多 agent 画布

- **定位**：Apache 2.0 开源低代码构建器；两类流程：Chatflow（单 agent）与 **Agentflow V2（多 agent 编排）**。
- **核心功能（V2 节点）**：Start（聊天/表单输入）、LLM、Agent（模型+工具+知识+记忆+更新状态）、Tool（确定性调用）、Retriever、HTTP、Condition、**Condition Agent（LLM 按自然语言场景路由）**、Iteration（子流程嵌套在节点边界内）、Loop、**Human Input（暂停等待"继续/拒绝"+反馈，checkpoint 持久化、重启可恢复）**、Execute Flow（子流程）；**Flow State** 单次执行内共享 KV 状态；官方明确支持 Supervisor→多 Worker 委派-回收。
- **UI**：左上 "+" 打开节点面板、按端口连线、节点展开面板配参数（输入 `{{` 自动弹可用变量）；Chatflow 视图带聊天预览。
- **口碑**：上手最快（评测称 15 分钟搭好 RAG 机器人）、无商用限制；复杂拓扑能力与治理弱于 Dify。

#### Microsoft Copilot Studio —— 企业生态型低代码

- **定位**：Power Platform/M365 生态的低代码 agent 工作室，纯 SaaS 按消息/harness 计费。
- **核心功能**：三大构建块——**Agents**（对话智能体）、**Workflows**（拖拽自动化，每步可"推理并行动"，内置 HITL）、**Agent flows**（类 Power Automate，可独立跑或作为 agent 工具，含人工审核）；双编排引擎：Generative orchestration（自主组合 topics/tools/knowledge）与 Classic（触发短语 + Topic）；三种 harness（GitHub Copilot harness 重推理 / standard / Copilot chat）；1000+ 连接器；**多 Agent 编排**（agent 经连接器互相调用/委派，含 M365 Copilot 作协调者）；Analytics、Evaluations、组织级 Agent inventory（RBAC/成本）。
- **UI**：门户 + agent 左侧导航（Topics/Tools/Knowledge/Analytics）；**Topic 画布为纵向对话树**——Trigger 起步，节点间 "+" 向下插入，顶部剪切/复制/撤销，**右上角可切 YAML 代码编辑器**；**右侧 Test 面板实时对话测试**（可跟踪触发了哪个 topic）。

#### Relevance AI —— "AI 员工团队"商业代表

- **定位**：AI Workforce 平台，像招聘员工一样组建 agent 团队（销售/运营/支持），面向非技术业务团队。
- **核心功能**：三种构建方式——可视化画布组合 agents/tools/**approvals**、自然语言生成（Invent）、**从 Claude Code/Cursor 通过 MCP 直接驱动平台**；模型可路由任意供应商；1000+ 连接器；**四级自治**（L1 每步批准 → L2 护栏内自主 → L3 Autopilot 例行自主异常上报 → L4 全自主）；**基准评测（采样线上运行、通过率、漂移告警）**、成本可见（每任务成本）、SSO/RBAC/审计/PII 掩码/数据驻留；400+ 模板。
- **UI**：节点画布（agent/工具/条件/审批节点）；工具构建器独立小流程编辑器；监控侧有任务级 Run 页、Tasks 看板、评测基准页、成本仪表盘。
- **口碑**：多 agent 团队 + 自治分级 + 评测治理闭环完整；credit 计费高用量贵；评测实测三 agent 流水线约 85% 无缝交接、15% 需人工干预。

#### Lindy（简要）

面向个人/小团队的"AI 员工"办公自动化：Trigger→Action/Condition/**Agent Step**（自主步骤，官方自承更贵且可靠性弱于普通动作）画布；**字段填充三模式**（Auto 模型推断 / AI Prompt 指令生成 / Set Manually 固定引用不耗推理）精细控成本；**Test Panel 逐步真实执行**（非模拟）；版本历史可恢复。易用性口碑好（G2 4.9）但计费争议多。

#### 国内厂商（简要）

- **百度千帆 AppBuilder**：工作流 Agent / 自主规划 Agent 等形态；节点最"企业化"（含 CFC 函数计算、数据库、**MCP Server 节点**、全局跳转、记忆变量）；画布式，变量引用规则明确（只有连线后继才能引用前序变量）；百度生态分发强。
- **智谱清流**：GLM 全模型矩阵的企业级智能体平台，Agents + Workflow 可视化编排 + 企业知识库 + 批量评测调优，编排 UI 与 Coze/Dify 同类。

### 2.3 前沿自主 agent 产品类

#### Claude Code（Anthropic）—— 编排能力与权限模型最完整

- **两级多 agent 体系**：
  - **Subagents（会话内并行，稳定）**：主会话通过 Agent 工具派生，各自独立上下文/系统提示/工具权限，完成后仅返回摘要（保护主上下文）；自定义 agent = Markdown + YAML frontmatter（`.claude/agents/`，可入库共享），字段含 tools 白/黑名单、model、permissionMode、memory、**isolation: worktree** 等；默认后台运行、支持嵌套（默认 3 层）、每会话限额 200 个/并发 20；`@agent-name` @提及指定执行；Fork 模式继承全部上下文做多方案并行试错。
  - **Agent Teams（多会话团队，实验性）**：lead + teammates，每个 teammate 是**完整独立的 Claude Code 会话**，可点对点直接通信（不必经 lead）；**共享任务列表落盘**（三态 + 依赖关系 + 文件锁防竞态，lead 指派或 teammate 自领）；agent 间 SendMessage 互发、收件箱为 JSON 文件、teammate 完成/出错自动带结果通知 lead；官方典型用例：并行多视角代码评审（安全/性能/测试）、**对抗式竞争假设调试**（互查互斥防单 agent 锚定）、跨层改动分工。安全模型：权限确认弹给 lead 由**人类**批准，**任何 agent 消息不能代替人类授权**；TeammateIdle/TaskCreated/TaskCompleted 等 hooks 做质量门禁。
- **核心功能**：全生命周期 hooks、skills、沙箱、权限模式光谱（default/acceptEdits/plan/bypass + 工具粒度 allow/deny 规则）、分层记忆（CLAUDE.md/auto memory）、auto-compaction 上下文压缩；**Claude Code Web**（claude.ai/code）：云端 VM 运行、`--cloud`/`--teleport` 终端↔云端双向迁移会话、Auto-fix PR（订阅 CI 失败与 review 评论自动修复）、routines 定时/事件触发、Ultrareview 多 agent 深度评审。
- **UI（终端 TUI）**：输入框下方 **agent 面板**——运行中 subagent/teammate 列表（嵌套树、`+N` 后代数），↑↓ 选择、Enter 进入该 agent transcript 直接对话、Esc 打断、`x` 停止、**Ctrl+T 切换共享任务列表视图**；idle 超 30s 自动隐藏、超 3 个折叠为 "N idle agents"；agent teams 支持 **in-process 单终端切换**与 **tmux/iTerm2 分屏**（每个 teammate 一个窗格同屏围观）两种模式。
- **口碑**：编排+权限+上下文工程最强；agent teams 实验性限制多；token 消耗大（官方研究：多 agent 研究系统约 **15 倍**于单轮对话）。

#### Anthropic 多 agent 研究系统 / Managed Agents

orchestrator-worker 范式（lead 分析规划 → 并行派生专门 subagent + 独立引用核查），内部评测比单 agent 高 90.2%，代价是 ~15× token 与 N² 上下文爆炸，需生产级监控；后续研究指出多 agent 系统的协调失败、合谋风险。**Managed Agents**（API）：托管 server-side agent 运行时，开发者定义目标与成功标准，Claude 自评估自我迭代直至达成，沙箱接 Cloudflare，适合长时无人值守任务。

#### OpenAI Agents SDK + ChatGPT agent / Atlas

- **Agents SDK 四原语**：Agents（LLM+instructions+tools+内置循环）、**Handoffs**（agent 间类型化移交，对话控制权整体转交）与 **Agents as tools**（manager 模式，官方文档专门对比两者取舍）、**Guardrails**（输入/输出校验，与 agent 并行快速失败）、**Tracing**（跨调用全链路内置）；支持非 OpenAI 模型；另有 Sandbox agents、Sessions、HITL、MCP、Realtime 语音。
- **ChatGPT agent**（Operator 已并入）：推理模型 + **虚拟计算机**（浏览器/终端/文本编辑器）端到端完成任务；connectors/Apps 接入 Gmail/GitHub 等。UI 标杆：会话中**实时观看虚拟桌面**（光标移动、点击、终端输出）或切 **activity feed 步骤视图**，随时打断，登录墙时 **Take over browser** 交给用户操作再交还。
- **Atlas**：AI 浏览器（右上 Ask ChatGPT 侧边栏含 Agent mode），2026.8 起据报道转为 ChatGPT 内功能。

#### Devin（Cognition）—— 可审计性设计典范

- **机制**：并行多 Devin（每会话独立云 VM + 独立云 IDE，Team 档约 10 并发）——"开工把 backlog 切给一队 Devin，回头收 PR"；Devin 2.0 支持任务中途**随时转向（steer）**；组织级 **blueprint**（含持久浏览器登录态资产化复用）；入口覆盖 Slack/Linear/Jira/GitHub/API/CLI（`/handoff` 本地↔云交接）；Devin Desktop（原 Windsurf）定位"一个界面管理本地+云端 agent 舰队"。
- **UI（会话页）**：聊天 + **计划（Plan）与进度步骤** + 侧边三面板——**Shell**（完整命令历史，点击命令跳转会话时间点，未来命令灰显）、**IDE**（VSCode 风格，实时 diff，可"停止并接管"直接编辑）、**Browser**（可代过 CAPTCHA/MFA，登录态可存入 blueprint）；**Side Chats（/btw）**只读旁路问答不打断主任务。
- **亮点**："计划步骤即时间线锚点"——点进度步骤直接联动到命令/编辑/浏览器证据；时间旅行式审计。

#### Manus —— 通用 agent UI 的事实模板

- **机制**：orchestrator–executor（中央规划 agent 拆解委派给浏览器 agent/代码 agent 等专门子 agent，三层验证：规划/执行/验证）；聊天流中 todo 清单持续勾选、可随时干预；**Wide Research** 多 agent 并行广度研究；**Scheduled Tasks 2.0**（定时 + 事件触发）；Projects 持久工作区共享上下文。
- **UI（被广泛模仿的三栏）**：**左侧会话栏 → 中间聊天流（对话+计划清单+进度）→ 右侧 "Manus's Computer"**（沙箱 VM 实时视图，Browser/Terminal/VSCode 自动切换，可围观可介入）；**回放（Replay）**：任务完成后生成分享链接，他人可拖动**进度拨盘回放**整个执行过程——Kimi "OK Computer"、Perplexity Computer 等均效仿此模式。
- **口碑**：过程透明 + 回放裂变是增长关键；credit 贵且事前无成本预估，可靠性不稳。

#### Cursor（3.0）/ Windsurf

- **Cursor 2.0**：编辑器侧栏统一管理 agents 与 plans；**一个提示最多 8 agent 并行**（git worktree 或远程机隔离）；Plan Mode 后台运行、"出计划"与"执行"可用不同模型、并行多计划对比。
- **Cursor 3.0（2026.4）**：围绕 agent 重写界面，**Agents Window 侧栏汇聚所有本地与云端 agent**（含从 mobile/web/Slack/GitHub/Linear 发起的）；云端 agent 产出**演示视频与截图**供验证；本地↔云会话**一键双向 handoff**；Cloud Agents 可**订阅外部事件**（GitHub PR 活动、CI 结果"等 CI 失败再修"、Slack 线程、Linear 事件、定时器）；自研 Composer 模型。
- **Windsurf**：Cascade agent 的 plan→多文件编辑→终端→浏览器全流程；Plan Mode 生成含"笔记+任务清单+当前目标"的 `plan.md` 随进度更新；2025.7 被 Cognition 收购后并入 Devin Desktop。

#### GitHub Copilot coding agent / Spark

- **coding agent**：把 issue assignee 设为 Copilot 或从 agents panel 委派，在 GitHub Actions 临时环境中研究→计划→改码→开 PR（单仓单分支单 PR）；**custom agents** 创建多个专门化 Copilot（前端专家/文档/测试）实现分工；MCP server 扩展、hooks（关键点跑自定义 shell 校验）、Copilot Memory（沉淀仓库理解）；**进度完全呈现于 issue/PR 时间线**（计划作为评论、每步日志可展开、改动以 diff 呈现）——"一切发生在 GitHub 上"的异步留痕范式。
- **Spark**：面向非程序员的 micro-app 搭建器，**聊天 + 实时 live preview + 可视化控件直接改 UI + 可切代码编辑**三位一体。

#### Google ADK / Jules（简要）

- **ADK**：开源多 agent 框架（Python/TS/Go/Java），模板 workflow（Sequential/Parallel/Loop）+ ADK 2.0 的 Graph/Dynamic/**Collaborative workflows**（动态 coordinator 调度 subagent）；**A2A 协议**跨语言跨平台协作；`adk web` 开发者 UI——playground 试跑 + **事件时间线**（Event 记录每条消息/回复/工具调用）。
- **Jules**：异步自主编码 agent，**"Give me a plan" 生成计划、人工批准后才改代码**的"plan 先行、人工放行"交互；自动读取 AGENTS.md。

---

## 3. 核心功能对比矩阵

### 3.1 功能维度对比（✔ 支持 / ◐ 部分 / ✘ 无）

| 能力 | LangGraph | CrewAI | AutoGen Studio | Dify | Coze | n8n | Flowise | Relevance AI | Claude Code | Devin/Manus |
|---|---|---|---|---|---|---|---|---|---|---|
| 可视化编排画布 | ◐(代码生成图) | ✔(平台) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✘(TUI) | ✘ |
| 显式 DAG/图编排 | ✔ | ◐(Flow) | ◐ | ✔ | ◐ | ✔ | ✔ | ◐ | ✘ | ✘ |
| LLM 动态路由/委派 | ✔(Command) | ✔(hierarchical) | ✔(Selector) | ◐ | ✔ | ✔(AI Agent) | ✔(Condition Agent) | ✔ | ✔(自动委派) | ✔(orchestrator) |
| 运行时并行扇出 fan-out | ✔(Send) | ◐ | ◐ | ◐ | ◐(批处理) | ◐ | ◐ | ✔ | ✔ | ✔ |
| 长期记忆 | ✔(Store) | ✔ | ◐ | ✔(知识库) | ✔ | ✔(外挂) | ✔ | ✔(公司级知识) | ✔(memory) | ◐(Projects) |
| 共享状态/共享内存 | ✔(State+reducer) | ✔(Flow State) | ◐(共享上下文) | ◐(变量传递) | ◐(变量) | ✔(items) | ✔(Flow State) | ◐ | ✔(任务列表落盘) | ◐ |
| HITL 中断/审批 | ✔(interrupt) | ✔ | ✔(UserProxy) | ✔(Human Input) | ✘ | ✔(审批+Wait) | ✔(Human Input) | ✔(四级自治) | ✔(权限模式) | ✔(take over) |
| 时间旅行/回放/Fork 重跑 | ✔(checkpoint) | ◐ | ✔(session viewer) | ◐(运行历史) | ◐ | ◐(执行历史) | ✘ | ◐ | ◐ | ✔(回放) |
| Trace/token 成本观测 | ✔(LangSmith) | ✔(Traces) | ✔(指标) | ✔(Tracing) | ◐ | ✔(Insights) | ◐ | ✔(成本仪表盘) | ◐ | ◐ |
| MCP 支持 | ✔ | ✔ | ✔ | ✔(双向) | ◐ | ✔(双向) | ✔ | ✔ | ✔ | ✘ |
| 沙箱/执行隔离 | ◐ | ◐ | ✔(Docker) | ✔(Agent 沙箱) | ✘ | ✔ | ✘ | ✔ | ✔(worktree/云VM) | ✔(云 VM) |
| 定时/事件触发 | ✔(Platform) | ✔(平台) | ✘ | ✔(Trigger) | ✔ | ✔ | ◐ | ✔ | ✔(routines) | ✔(Manus) |
| 多渠道发布 | ◐ | ✔ | ◐ | ✔(API/Web/MCP) | ✔(微信/TG等) | ✔ | ✔(API/嵌入) | ✔ | ✘ | ✘ |
| RBAC/多租户 | ◐(平台) | ✔(平台) | ✘ | ✔ | ✔ | ✔(企业) | ◐ | ✔ | ✘ | ✔ |

### 3.2 UI 布局维度对比

| 产品 | 布局形态 | 编排入口 | 运行/调试呈现 | 特色交互 |
|---|---|---|---|---|
| LangGraph Studio | Agent IDE 三栏 | 代码生成图 | 图高亮 + 线程三级历史 + Fork 重放 | Edit state → Fork 分支重跑 |
| AutoGen Studio | 三视图(Build/Playground/Gallery) | 拖拽画布 + drop zone | 消息实时流 + 控制转移图 | JSON ↔ 画布双向编辑 |
| Crew Studio | 三栏(推理/画布/组件) + 聊天 | 自然语言生成 + 画布 | Execution 时间线 + 三 tab 日志 | 聊天与画布共享状态互换 |
| AgentScope Studio | 观测工作台多视图 | 代码 | Runtime 聊天 + OTel Tracing 时间线 | Friday 内置 Copilot |
| Dify | 画布 + 右侧预览 | React Flow 画布 | 右侧聊天预览 + 单节点测试 + 变量检查器 | 可编辑缓存变量模拟场景 |
| Coze 多 Agent | 四栏(信息/全局/画布/预览) | 画布 LLM 路由 | 右侧预览调试 | 与单个 Agent 节点单聊 |
| n8n | 顶栏+左侧栏+画布+滑入属性面板 | Vue Flow 画布 + 覆盖式节点面板 | 右下 Chat 气泡 + Executions 日志 | Sticky Notes + Canvas Groups + Tidy up |
| Copilot Studio | 纵向对话树 + 右侧测试面板 | Topic 树 "+" 插节点 | Test 面板跟踪 topic 触发 | YAML 代码视图切换 |
| Claude Code | 终端 TUI + agent 面板 | 配置文件/Markdown | agent 面板 + Ctrl+T 任务列表 | tmux 分屏团队视图、idle 折叠 |
| Manus | 三栏(会话/聊天/Computer) | 无(自主) | 右侧沙箱实时视图 + todo 勾选 | 回放拨盘分享 |
| Devin | 聊天+计划+三面板 | 无(自主) | 进度步骤时间线联动 Shell/IDE/Browser | 命令历史时间旅行、/btw 旁路问答 |
| Cursor 3 | IDE + Agents Window | 无(自主) | 多 agent 网格并排 + diffs | 云 agent 交付视频/截图、事件订阅 |

---

## 4. 多 agent 协作机制模式总结

调研发现，所有平台的多 agent 协作机制可归纳为 **7 种基本模式**（多数产品组合使用）：

| 模式 | 机制 | 代表 |
|---|---|---|
| **① 主管-工人（Supervisor/Worker）** | 一个 manager agent 拆解任务、分派给专门 agent、汇总结果 | CrewAI hierarchical、LangGraph Supervisor、Relevance AI、Manus orchestrator-executor、Flowise Supervisor→Worker |
| **② 移交（Handoff/Swarm）** | agent 间直接转移对话/任务控制权，无需中央主管 | OpenAI Agents SDK handoffs、LangGraph Swarm、AutoGen Swarm、Coze 多 Agent（LLM 判断接管） |
| **③ 群聊/讨论（Group Chat）** | 多 agent 共享消息上下文，按轮询/LLM 选择/图规则发言 | AutoGen RoundRobin/Selector/GraphChat、AgentScope MsgHub、MS Agent Framework group chat |
| **④ 显式图/DAG 工作流** | 节点-边显式定义执行路径（含条件分支、循环、并行） | LangGraph StateGraph、Dify/n8n/Flowise 画布、ChatDev 2.0 DAG、ADK Graph workflows |
| **⑤ 角色流水线（SOP Pipeline）** | 按软件公司 SOP 串联角色，各角色产出结构化文档传递 | MetaGPT、ChatDev ChatChain、千帆工作流 Agent |
| **⑥ Lead-Worker 团队（共享任务列表）** | 对等 agent 组队 + 共享任务清单（依赖、认领、文件锁）+ 点对点消息 | Claude Code Agent Teams（共享任务列表 + JSON 收件箱 + SendMessage） |
| **⑦ 对抗/竞争（Adversarial/Race）** | 多 agent 并行互斥视角或竞争假设，互相挑战防锚定 | Claude Code 对抗式调试、MetaGPT Race Mode、多视角代码评审 |

**通信介质**的三个层次：显式边/变量传递（图引擎）→ 发布-订阅消息总线（MetaGPT/AgentScope）→ 任务列表 + 收件箱文件（Claude Code，最去中心化）。

**隔离手段**从轻到重：独立上下文窗口（subagent）→ git worktree（文件级隔离）→ Docker 沙箱 → 独立云 VM。

---

## 5. UI 布局调研

### 5.1 六种典型布局模式

专项调研将所有产品的 UI 归纳为六种模式，**成熟产品沿生命周期组合使用**：

#### 模式 1：画布 / 节点编辑器式（Canvas Node Editor）—— 构建期

- **结构**：顶部工具栏 + 节点面板（常驻侧栏或 `+` 弹出）+ 中央无限画布 + 右侧属性面板（常驻或点击节点滑入）；小地图、zoom-to-fit、自动布局、便签/分组。
- **代表**：n8n、Dify、Langflow、Flowise、Coze、ComfyUI、OpenAI Agent Builder。
- **适用**：定义确定性流程/管道，混合人工节点与 LLM 节点；面向低代码人群。
- **优点**：控制流显式可见、可导出 DSL 版本化、非工程师可上手。
- **缺点**：表达不了运行时动态决策（动态分支画不出来，图会爆炸）；大图可读性差；调试要切到独立运行视图。
- **画布引擎选型格局**：
  | 引擎 | 代表产品 | 备注 |
  |---|---|---|
  | **React Flow（@xyflow/react）** | Dify、Langflow、Flowise、OpenAI Agent Builder | React 生态首选；自动布局外接 dagre/elkjs |
  | **Vue Flow** | n8n（新画布从 Rete.js 重写为 Vue Flow） | Vue3 项目首选 |
  | **AntV X6/XFlow** | 国内中后台自研流程平台 | 超大规模/嵌套图；同类有 LogicFlow、jsPlumb |
  | **FlowGram（字节）** | Coze Studio 开源版 | fixed layout + free layout 双模式，自带 Runtime |
  | **litegraph.js** | ComfyUI | Canvas2D 渲染性能好但非 DOM |

#### 模式 2：聊天 + 工作区分屏式（Chat + Workspace Split）—— 运行期

- **结构**：左侧聊天（控制面），右侧实时工作区（沙箱浏览器/终端/编辑器/artifact 预览，自动切换视图）；过程步骤折叠嵌入聊天流；多会话侧栏为外壳。
- **代表**：Manus（标杆，"左聊天右 Computer"）、ChatGPT agent（内嵌虚拟桌面直播 + activity feed 双视图）、Devin（会话内 Shell/IDE/Browser 三面板）、Claude Artifacts / OpenAI Canvas（artifact 变体）。
- **适用**：自主性高、任务开放式、人做轻量监督纠偏。
- **优点**：交互门槛最低；过程透明（右侧"眼见为实"）；产物就地呈现迭代。
- **缺点**：长任务聊天流被步骤淹没（需折叠设计）；移动端难承载。

#### 模式 3：Agent IDE 三栏式（Three-pane Agent IDE）—— 构建 + 调试期

- **结构**：左栏（文件/组件/会话列表）+ 中间（图视图/代码/画布）+ 右栏（运行面板：输入表单、输出流、trace、time-travel 控制）。
- **代表**：LangGraph Studio（图 + schema 自动表单 + interrupt/Fork）、Crew Studio（左 AI 推理/中画布/右组件库）、Devin、Copilot Studio。
- **适用**：开发者构建与调试 agent 本身。
- **优点**：编辑-运行-调试闭环一个界面；结构（图）与行为（trace）对照。
- **缺点**：对非开发者过重。

#### 模式 4：Trace 可观测性视图式（Observability Trace Viewer）—— 运维期

- **结构**：顶部筛选 → trace 列表 → trace 详情 = **嵌套树 + 瀑布/甘特时间线 + span 详情**（input/output、token、成本、latency）→ 上层 dashboard（成本/延迟/错误率、session 聚合）。
- **代表**：LangSmith（trace 树 + waterfall + 成本聚合）、Langfuse（span 树 + 子树延迟成本色标 + log level + sessions）、Arize Phoenix、AgentOps（会话回放 waterfall + 多 agent 交互图）、Coze Loop。
- **要点**：树形/瀑布/会话三种视图互补；time-travel 调试（LangGraph checkpoint 回退任意状态编辑后分叉重放、AgentOps 会话逐步回放）是最高级形态。

#### 模式 5：审批 / 中断卡式（HITL Interrupt & Approval）—— 风险控制

- **结构**：agent 暂停 → **中断卡/审批卡**呈现待批动作（参数、理由、diff）→ 批准/拒绝/编辑三种操作 → 恢复执行；入口可在聊天流内、Slack/Teams 按钮、表单或独立审批队列。
- **代表**：LangGraph interrupt（Studio 表单）、n8n 工具审批 + Wait 节点（挂起数小时至数天）、Copilot Studio 多级审批 + AI 代批、ChatGPT agent take-over-browser、Claude Code 权限模式光谱。
- **权限粒度光谱**（业界共识）：自主性设置应**具体到动作类型**且**常驻可见**——只读（plan）→ 敏感动作询问（default）→ 白名单自动 + 黑名单禁止（allow/deny 规则）→ 全自动（bypass）。

#### 模式 6：舰队 / 任务看板式（Fleet & Task Board）—— 规模化并行

- **结构**：一行一个并行 agent/任务：**状态分组（Needs input 置顶）+ 单行自动摘要（小模型生成、周期刷新）+ 时长 + 产物链接（PR/文件）**；peek 快速查看回复 vs attach 深入操作；完成通知。
- **代表**：Claude Code agent view（Needs input/Ready for review/Working/Completed 分组 + Haiku 摘要 15s 更新 + peek 面板 + PR 链接着色）、Devin Sessions 侧栏、OpenAI Codex tasks、Cursor Agents Window（多 agent 网格 + 云端视频/截图交付物）、Relevance AI 团队看板；生态外围 AgentCenter/Fleet Commander/AgentsRoom Split View。
- **适用**：一人监督 N 个 agent 的异步委派（"派出去回头收"）。

### 5.2 组合趋势（2025-2026 共识）

> **构建用画布（模式1/3）→ 运行用聊天+工作区（模式2）→ 高风险点嵌审批卡（模式5）→ 规模化后用舰队看板（模式6）→ 全程沉淀 trace 观测（模式4）。**

横跨所有模式的四条底线：**进度可见、工具调用透明、可随时介入/接管、自主性粒度可配置且常驻可见**。

### 5.3 值得复用的细粒度交互设计清单

1. **单节点/单 agent 测试**：Dify 单节点 Run + "Last run"；Coze 与指定 Agent 节点单聊；n8n 节点 hover Play。
2. **可编辑的调试状态**：Dify Variable Inspector 直接改缓存变量模拟场景；LangGraph Edit node state → Fork 重跑。
3. **AI 辅助搭建**：Coze/n8n 自然语言生成工作流；Crew Studio 聊天与画布共享状态互换。
4. **画布卫生**：n8n Sticky Notes + Canvas Groups + Tidy up 自动整理；Dify Cmd+O 自动布局 + Cmd+K 全局搜索。
5. **过程降噪**：聊天流中步骤折叠卡；Claude Code idle agent 折叠为 "N idle"。
6. **回放与分享**：Manus 回放拨盘链接；ChatDev 日志回放动画；Devin 点击命令时间旅行。
7. **时间线锚点联动**：Devin 进度步骤 ↔ Shell/IDE/Browser 证据联动。
8. **交付物验证**：Cursor 云 agent 附演示视频/截图；GitHub PR 时间线留痕。
9. **旁路问答**：Devin /btw 只读 side chat 不打断主任务。
10. **专家视图/用户视图分离**：ComfyUI App Mode 把复杂节点图收成极简表单。

---

## 6. 趋势与洞察

1. **"纯聊天"让位于多面板组合**：业界明确共识——聊天窗口不足以承载 agent 产品；聊天降级为"控制面"，工作区/画布/看板承担"观察面"。
2. **MCP 成为工具接入事实标准**，A2A 兴起为跨系统 agent 通信协议；平台普遍"既是 MCP Client 又是 MCP Server"（Dify 把应用发布为 MCP Server、Relevance AI 允许从 Claude Code 驱动平台）。
3. **代码优先回归**：高端产品（LangGraph、Claude Code、ADK）走"代码即真相 + 可视化只读/半只读辅助"路线；纯拖拽低代码在动态决策场景暴露表达力上限（Langflow 大画布恶化、Copilot Studio 对话树局限）。
4. **计划/任务清单成为一等公民**：Claude Code 共享任务列表（依赖+认领+文件锁）、Jules "plan 先行人工放行"、Windsurf plan.md、Manus todo 勾选、MS Agent Framework Harness 的 todo 跟踪。
5. **运行时可视化三件套**：消息流/时间线（谁做了什么）+ 执行图高亮/控制转移图（走到哪了）+ 成本指标（token/工具调用成败）——AutoGen Playground、Crew Execution、AgentScope Tracing、LangGraph Threads 全部覆盖。
6. **HITL 从"开关"进化为"自主性光谱"**：动作类型粒度（工具/命令白黑名单）+ 分级（Relevance AI L1-L4 四级自治）+ 常驻可见；"任何 agent 消息不能代替人类授权"成为安全设计准则（Claude Code）。
7. **舰队化管理兴起**：一人监督 N 个 agent（Claude Code agent view、Cursor Agents Window、Devin 多会话）；配套单行 AI 摘要、peek/attach 两档交互、文件级隔离（worktree）保障并行安全。
8. **事件驱动触发成为标配**：订阅 CI 结果、GitHub/Slack/Linear 事件、定时器（Cursor Cloud Agents、Claude Code routines、Manus Scheduled Tasks、Dify/n8n Trigger）——agent 从"被动应答"转向"驻值监听"。
9. **多 agent 的成本与风险被量化**：Anthropic 研究称多 agent 系统约 15× token 消耗、N² 上下文爆炸、存在协调失败与合谋风险 → 成本仪表盘（Relevance AI 每任务成本）与评测基准（采样线上运行、漂移告警）成为平台必备。
10. **长时任务需要 durable execution**：checkpoint 持久化、暂停-恢复（挂起数小时至数天）、重启不丢状态（LangGraph Checkpointer、Flowise checkpoint、n8n Wait、ADK 长时运行 agent）。

---

## 7. 对自建平台的建议

> 结合调研结论与本地工作区现状（`~/lhz/clowder-ai` 已有一个 IDE 式布局的生产级多 agent 平台；`~/lhz/multi-agent-collab-tools` 为分阶段学习实现），给出以下建议。

### 7.1 产品定位建议

三条可选路线（按投入与差异化排序）：

| 路线 | 定位 | 对标 | 差异化机会 |
|---|---|---|---|
| **A. 开发者框架 + Studio**（推荐） | 代码优先的编排引擎 + 可视化调试工作台 | LangGraph + Studio、AgentScope | 国内生态（GLM/Qwen/DeepSeek 模型路由）、中文文档、轻量自托管 |
| **B. 低代码画布平台** | 可视化搭建多 agent 应用并多渠道发布 | Dify、Coze、n8n | 红海竞争激烈，需强渠道或垂直场景 |
| **C. 自主 agent 舰队产品** | 委派任务给并行自主 agent 团队 | Manus、Devin、Claude Code | 沙箱/VM 基建投入重；可先做"编排壳 + 外接模型" |

**建议 MVP 采用 A + C 混合**：以"可编排的多 agent 团队 + 舰队看板监督"为核心心智（差异化），编排层提供代码/DSL 优先 + 画布只读可视化（避免先造画布编辑器的大坑），这与 LangGraph Studio、Claude Code 的成功路径一致。

### 7.2 功能需求清单（优先级）

**P0（MVP 必须）**

1. **Agent 定义**：名称/人设（system prompt）/模型（多供应商路由）/工具白名单/权限模式；支持配置文件定义并入库共享（参考 `.claude/agents/` 的 Markdown+frontmatter 模式）。
2. **编排引擎**：至少支持 Supervisor/Worker 委派 + 顺序流水线两种模式；任务结构（三态 + 依赖）落盘持久化（SQLite）。
3. **多 agent 通信**：agent 间消息传递（收件箱模型）+ 共享任务列表（认领/指派 + 防竞态锁）。
4. **工具调用**：内置基础工具（文件/搜索/HTTP/代码执行）+ **MCP Client** 接入外部工具。
5. **HITL**：敏感动作中断 + 审批（批准/拒绝/编辑后继续）；权限三档（只读/需确认/白名单自动）。
6. **运行可视化**：消息流时间线 + 任务进度状态 + 基础 token/成本统计。
7. **会话与运行历史**：持久化、可回看。

**P1（第二阶段）**

1. 编排画布（只读渲染执行图/拓扑，节点状态高亮）→ 再演进为可编辑。
2. Trace 观测（树形 + 瀑布时间线 + span 详情），OTel 兼容或对接 Langfuse。
3. 长期记忆与知识库（RAG）。
4. 定时/事件触发（webhook/cron）。
5. 舰队看板（多会话并行监督：状态分组 + 单行摘要 + peek/attach）。
6. 沙箱执行隔离（Docker 容器级）。
7. checkpoint 暂停-恢复（durable execution）。

**P2（远期）**

1. 多渠道发布（API/嵌入/机器人）与应用市场。
2. RBAC/多租户/审计（若走商业化）。
3. 评测体系（测试集 + 采样线上运行 + 漂移告警）。
4. 回放分享（Manus 式）与 time-travel 调试（state 编辑 + Fork 重跑）。
5. 自然语言生成编排（AI 辅助搭建）。

### 7.3 推荐 UI 布局方案

采用**"1 + 3"组合布局**（一个主壳 + 三个场景视图），对应第 5 节的模式组合趋势：

```
┌──────────────────────────────────────────────────────────────┐
│ 顶栏：项目/团队切换 · 运行控制 · 状态指示 · 成本/用量        │
├────┬─────────────────────────────────┬───────────────────────┤
│左侧│  ① 运行视图（默认）             │ 右侧面板（可收起）     │
│导航│  ┌───────────┬───────────────┐ │ · Artifacts 产物       │
│────│  │ 聊天/指令 │ 工作区         │ │ · Trace 时间线         │
│·舰队│  │ 流(控制面)│ (终端/浏览器/  │ │ · 审批卡片队列         │
│ 看板│  │ ·步骤折叠 │  编辑器预览)   │ │ · Span 详情           │
│·编排│  │ ·todo清单 │ 自动切换       │ │                       │
│ 画布│  └───────────┴───────────────┘ │                       │
│·观测│  ② 编排视图：画布(先只读渲染拓扑+节点状态高亮)          │
│·知识│  ③ 舰队视图：行=agent任务(状态分组+单行摘要+peek)       │
│·设置│     全局底部：agent 面板(运行中列表, idle 折叠)         │
└────┴─────────────────────────────────┴───────────────────────┘
```

关键设计决策（均有调研依据）：

- **聊天 + 工作区分屏作为默认运行视图**（Manus/ChatGPT agent 已验证的范式），过程步骤折叠降噪；
- **画布先做只读**：渲染执行拓扑与实时节点高亮（LangGraph Studio 模式），把交互编辑留到 P2，避开"画布编辑器"这个最大研发坑；
- **审批卡进聊天流 + 独立审批队列双入口**（n8n/Copilot Studio 模式），"Needs input" 状态在舰队看板置顶（Claude Code agent view 模式）；
- **舰队看板一行一 agent**：状态图标 + 小模型单行摘要 + 产物链接 + peek/attach 两档交互；
- **权限/自主性指示常驻顶栏**（当前模式可见可切）。

### 7.4 技术选型参考

| 层 | 建议 | 依据 |
|---|---|---|
| 前端框架 | React + Vite + Tailwind（或 Next.js） | AgentScope Studio、Dify、Langflow 同栈；组件生态最全 |
| 画布引擎 | **React Flow（@xyflow/react）**，自动布局用 elkjs（支持嵌套图） | Dify/Langflow/Flowise/OpenAI Agent Builder 验证；dagre 不支持分组嵌套 |
| 实时通信 | WebSocket / SSE（消息流、状态推送、步骤流式） | 全部调研产品的运行时标配 |
| 后端 | Node（TS）或 Python FastAPI | AgentScope Studio（Node+Express+TRPC）/ AutoGen Studio（FastAPI）可参考 |
| 持久化 | SQLite 起步（会话/任务/trace/checkpoint），与本地 clowder-ai 的多 SQLite 库模式一致 | 学习项目迭代快、零运维 |
| 观测 | 自建 span 模型 + 兼容 OTel；可选对接 Langfuse | Langfuse 开源可自托管 |
| 协议 | MCP Client 优先（工具接入），预留 A2A | 2026 事实标准 |

### 7.5 与本地现有项目的关系

- **`clowder-ai`（生产参考）**：其前端已实现 IDE 式布局（ActivityBar + ThreadSidebar + ChatContainer + ArtifactsPanel/EvidencePanel/PlanBoardPanel + ApprovalHub 审批中心 + ParallelStatusBar + Hub 观测台含 TraceTree，约 202 个组件）——本调研报告第 5 节的六模式在该项目中已有对应物，新平台可**直接复用其布局骨架与审批/观测面板的设计经验**，避免重复踩坑。
- **`multi-agent-collab-tools`（学习参考）**：其 5 大抽象（Agent、Message、Router、Shared State、Pattern）与第 4 节的协作机制模式一一对应，可作为新平台编排引擎内核的教学参照。

---

## 8. 附录：参考资料

### 开发者框架类
- LangGraph Studio（Agent IDE）：langchain.com/blog/langgraph-studio-the-first-agent-ide ｜ docs.langchain.com/langsmith/use-studio
- LangGraph v1/持久化/中断：docs.langchain.com/oss/python/releases/langgraph-v1 ｜ /persistence ｜ /interrupts
- CrewAI：docs-platform.crewai.com/platform/en/features/crew-studio ｜ docs.crewai.com ｜ github.com/crewaiinc/crewai
- AutoGen Studio：microsoft.github.io/autogen/stable/user-guide/autogenstudio-user-guide/usage.html ｜ 论文 arxiv.org/html/2408.15247v1
- AG2：github.com/ag2ai/ag2
- MetaGPT/MGX：github.com/foundationagents/metagpt ｜ arxiv.org/html/2308.00352v7
- CAMEL/Owl：github.com/camel-ai/camel ｜ github.com/camel-ai/owl ｜ arxiv.org/abs/2505.23885
- AgentScope：github.com/agentscope-ai/agentscope ｜ github.com/agentscope-ai/agentscope-studio
- ChatDev：github.com/openbmb/ChatDev
- Microsoft Agent Framework：learn.microsoft.com/en-us/agent-framework/overview/

### 低代码/商业平台类
- Dify：docs.dify.ai（workflow/节点/调试/Agent） ｜ github.com/langgenius/dify
- Coze：docs.coze.cn/guides_multiagent ｜ guides_workflow
- n8n：docs.n8n.io/courses/level-one/chapter-1/ ｜ advanced-ai
- Langflow：langflow.org ｜ docs.langflow.org/release-notes
- Flowise：docs.flowiseai.com/using-flowise/agentflowv2
- Copilot Studio：learn.microsoft.com/microsoft-copilot-studio（topics/approvals/multi-agent）
- Relevance AI：relevanceai.com/agents
- Lindy：docs.lindy.ai
- 千帆 AppBuilder：ai.baidu.com/ai-doc/AppBuilder ｜ 智谱清流：bigmodel.cn

### 前沿 agent 产品类
- Claude Code：code.claude.com/docs/en（agent-teams/sub-agents/agent-view/agents/claude-code-on-the-web）
- Anthropic 多agent研究：anthropic.com/engineering/multi-agent-research-system ｜ anthropic.com/research/multiagent-systems
- OpenAI Agents SDK：openai.github.io/openai-agents-python/ ｜ AgentKit：openai.com/index/introducing-agentkit
- ChatGPT agent：openai.com/index/introducing-chatgpt-agent/ ｜ Atlas：openai.com/index/introducing-chatgpt-atlas/
- Devin：devin.ai ｜ docs.devin.ai ｜ cognition.com/blog/devin-2
- Manus：manus.im ｜ manus.im/docs ｜ arxiv.org/html/2509.14528（UI 范式引用）
- Cursor：cursor.com/blog/cursor-3 ｜ cursor.com/changelog/2-0 ｜ cursor.com/docs/cloud-agent
- GitHub Copilot coding agent：docs.github.com/copilot/concepts/agents/coding-agent ｜ Spark：githubnext.com/projects/github-spark/
- Google ADK：adk.dev/workflows/ ｜ Jules：jules.google

### UI 布局与可观测性专项
- React Flow：reactflow.dev（auto-layout/elkjs 示例） ｜ Vue Flow：vueflow.dev ｜ AntV X6：x6.antv.antgroup.com ｜ FlowGram：github.com/bytedance/flowgram.ai
- n8n 画布（Vue Flow 迁移）：community.n8n.io/t/help-us-test-the-new-n8n-canvas-beta ｜ Canvas Groups/Sticky Notes：docs.n8n.io
- Manus UI 拆解：uxdesign.cc/manus-ai-real-or-hype ｜ scribd.com（Replicating Manus AI UI/UX）
- Claude Artifacts：support.claude.com ｜ assistant-ui.com/examples/artifacts
- LangSmith：docs.langchain.com/langsmith（cost-tracking/changelog waterfall） ｜ Langfuse：langfuse.com/docs（data-model/sessions/best-practices）
- Arize Phoenix：arize.com/docs/phoenix ｜ AgentOps：agentops.ai
- HITL：docs.langchain.com/oss/python/langgraph/interrupts ｜ docs.n8n.io（human-in-the-loop） ｜ code.claude.com/docs/en/permission-modes
- 多agent舰队看板：code.claude.com/docs/en/agent-view ｜ browseract.com/blog/multi-agent-management-dashboard-guide
- Agentic UI 模式：kanopylabs.com/blog/agentic-ui-patterns ｜ "Chat is the wrong interface"：blakecrosley.com/blog/chat-is-the-wrong-interface

---

> **报告完**。本报告基于 2026 年 9 月的公开信息整理，共覆盖 27 个平台/产品。落地实施时建议对目标对标产品（LangGraph Studio、Dify、Claude Code、Manus 等）做进一步的原型体验与功能拆解。
