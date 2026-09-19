# Agent 角色创建与管理实施指导

状态：已评审并完成首版实施（2026-09-14）。

日期：2026-09-14。适用工程：agent-gand；源码基线：`2ce5f12`。

## 1. 实施目标与范围

让用户可以在界面内创建一个具备名称、职责、提示词、模型和工具权限的 Agent，保存后立即用于新的聊天室和任务。用户不需要手工编辑 Markdown 或重启服务。

这里的“创建角色”是创建可复用的 Agent 配置，不是训练模型，也不会创建新的 API 账户或独立常驻进程。角色配置在执行 Run 时被加载，通过现有编排器调用模型与工具。

建议首版包含：

- Agent 列表、详情、新建、编辑、复制、停用和重新启用。
- 内置模板：通用助手、规划者、执行者、审查者；模板提供可编辑初始配置。
- 基础信息、职责说明、系统提示词、模型、工具权限表单及即时校验。
- 保存后无需重启即可用于新建聊天室，旧房间通过显式“调整成员”加入新角色。
- 新角色能参与流水线、主管委派及审查返工，不依赖角色 ID 命名习惯。
- 配置版本、运行快照，保证编辑角色不会改变已经排队或执行中的 Run。
- 文件定义与界面创建定义共存、来源清晰、重启不丢失或互相覆盖。

首版已按第 9 节完成核心实施。AI 自动生成角色、文件导入导出、每角色独立密钥、MCP 配置、动态加入正在执行的 Run、永久删除、版本回滚界面暂不纳入首版。

## 2. 当前实现与必须处理的衔接点

| 位置 | 当前行为 | 对新功能的影响 |
| --- | --- | --- |
| `packages/shared/src/agent.ts` | AgentDefinition 已有 id/name/description/systemPrompt/model/tools/disallowedTools/permissionMode/color/source | 可复用基础字段，但缺启停、版本和明确角色能力 |
| `apps/server/src/agents/loader.ts` | 解析 `*.agent.md`；ID 默认由文件名产生；部分无效字段宽松降级 | 需要可复用的规范化和校验，不应让表单输入沿用静默降级 |
| `apps/server/src/agents/registry.ts` | 启动调用 syncFromFiles；upsert 固定写 source=file，同 ID 直接覆盖 | 界面创建记录必须独立写入 source=db，并处理跨来源 ID 冲突 |
| `apps/server/src/api/routes.ts` | Agent 仅提供 GET /api/agents | 缺创建、编辑、停用、配置预检和可选项查询 |
| `apps/web/src/components/views/FleetView.tsx` | 仅展示状态、模型、权限及任务摘要 | 可升级为“Agent 管理”，复用现有舰队入口 |
| `apps/web/src/components/views/RunView.tsx` | 从 state.agents 初始化选人，部分 effect 会在空选时自动全选 | 新增/停用角色后需更新候选列表，但不能偷偷改变用户已选团队 |
| `apps/server/src/conversations/dispatcher.ts` | 出队时根据 conversation.agentIds 读取注册表最新定义，缺失成员被 filter 掉 | 新增编辑后必须改为读取 Run 快照；不能静默缩减团队 |
| `apps/server/src/orchestration/supervisor.ts` | 默认审查人及 fallback 使用 `/review/i.test(agent.id)`；恢复时重新读取注册表 | 自定义 qa-specialist 无法可靠成为默认审查者；恢复可能使用改过的配置 |
| `apps/server/src/tools/types.ts` | readonly/confirm/auto 三种门控；tools 是白名单，不是统一的“可用工具集” | UI 必须准确表达权限语义，不能把取消勾选误称为禁止使用 |
| `apps/server/src/tools/builtin/index.ts` | 按权限模式提供工具 schema | 权限预览、schema 下发和实际执行判定需一致 |
| `apps/server/src/llm/router.ts`、`config.ts` | 支持 mock/openai/anthropic 路由；凭据在服务端全局环境配置 | 首版角色选择模型路由，复用现有凭据，不把密钥放进角色定义 |

结论：需要补齐“管理入口 → 配置持久化 → 热更新 → 团队选择 → 版本固定 → 实际执行”整条路径。只加一个新建弹窗和 INSERT 不足以完成这项能力。

## 3. 用户流程与预期界面

入口建议：保留“舰队”导航，在页面加入“角色管理 / 执行状态”两个页签；角色管理提供“＋ 创建 Agent”。空列表和新聊天室成员选择区也提供相同入口。

```text
舰队 / 角色管理                                      [＋ 创建 Agent]
搜索名称或 ID     全部能力 ▾     启用状态 ▾     来源 ▾

名称             职责/能力        模型             来源       操作
Planner          规划、协调       当前配置模型      文件       查看 / 复制
Coder            执行             当前配置模型      文件       查看 / 复制
质量工程师       执行、审查       用户配置模型      自建       编辑 / 复制 / 停用
```

创建使用独立面板，步骤清晰、数据全程保留：

1. **选择模板**：从空白或内置模板开始；也可以从已有 Agent 复制。
2. **填写角色**：名称、稳定 ID、职责说明、参与方式和主题色。
3. **配置行为**：系统提示词、模型、权限模式及工具策略。
4. **预览保存**：查看最终摘要、实际权限表和模型配置状态；点击“创建 Agent”。

创建示例：名称“质量工程师”，ID `qa-specialist`，职责“检查边界条件并复审修改”，参与方式“执行、审查”，模型由用户从已配置 Provider 下填写，权限只读。系统提供审查提示词模板，用户补充项目标准。

保存成功显示“角色已创建，可加入聊天室”，并提供“创建聊天室”和“返回列表”。若从新聊天室的成员选择区进入，返回后保留原草稿，将新 Agent 加入当前建房草稿的已选成员；若从舰队进入，不自动加入任意旧聊天室。

预期效果：用户创建 `qa-specialist` 后，不改文件、不重启服务，即可在新房间中选为审查者；Coder 提交后由其给出结构化审查，FAIL 时仍触发原有返工闭环。

## 4. 配置字段与校验约定

以下限制为本方案拟定值，实施时统一在服务端校验，前端同步用于提示。

| 字段 | 约束与默认值 | 界面说明 |
| --- | --- | --- |
| id | `^[a-z][a-z0-9-]{1,47}$`；全局唯一；创建后不可修改 | 公开标识，用于 @ 和任务引用；显示名改变不影响 ID |
| name | trim 后 1–40 字符；可与其他角色同名 | 名称相同时显示 ID 以便区分 |
| description | trim 后 1–300 字符 | 用于主管判断任务该交给谁 |
| capabilities | 非空数组，值为 execute/review/coordinate，去重 | “执行任务 / 审查产出 / 协调团队”，允许多选 |
| systemPrompt | trim 后 1–20,000 字符 | 定义职责、步骤、输出要求与边界 |
| model | mock:/openai:/anthropic: 前缀＋非空模型名；总长 ≤200；拒绝控制字符和空白模型名 | Provider 选项＋模型名输入；不假定已有全量模型目录 |
| permissionMode | readonly/confirm/auto；默认 readonly | 根据模式显示逐工具实际行为 |
| tools | 已注册工具名数组、去重 | 自动允许列表；并非所有模式下的唯一可用集 |
| disallowedTools | 已注册工具名数组、去重 | 明确禁用，优先级最高 |
| color | `#[0-9a-fA-F]{6}`，默认选预设色 | 用于头像及名称标识 |
| enabled | 默认 true | 停用后不能进入新的执行快照 |
| source/version/时间 | 服务端生成；请求传入则拒绝 | 来源与乐观锁由后端管理 |

保留 ID：user/system/all/supervisor，避免与消息保留身份冲突；其他 ID 如与文件或 DB 记录碰撞均返回 409。停用不会释放 ID。旧文件中不符合新 ID 规则的历史 ID 保留，不改名、不破坏引用；复制为新角色必须符合新规则。

同一工具不能同时出现在 tools 与 disallowedTools，编辑表单使用互斥选项。新增和更新都拒绝未知工具，不静默丢弃。文件同步若遇到历史未知工具给出诊断，不自动扩大权限；新文件配置也应经过统一规范化验证。

模型“已配置”只说明对应服务端凭据存在，不等于模型可调用或账户有权限。首版允许保存凭据尚未配置的角色并显示状态；启动 Run 前执行配置预检并给出明确错误，不能等所有任务创建后才静默失败。mock 明确标为演示模式。

## 5. 权限配置应按实际行为展示

现有 confirm 的 tools 白名单内非只读工具会直接执行，所以不能笼统写“所有写入都需确认”。使用现有 checkPermission 作为统一计算基础，提供如下预览：

| 模式 | 未在自动允许列表的只读工具 | 未在自动允许列表的写入工具 | 列表内写入工具 |
| --- | --- | --- | --- |
| readonly | 可用，除非明确禁用 | 禁止 | 仍禁止 |
| confirm | 可用，除非明确禁用 | 需审批 | 自动允许 |
| auto | 禁止 | 禁止 | 自动允许 |

任何模式下 disallowedTools 优先禁止；外部工作区写入和 shared/ 写入继续遵循现有工作区审批覆盖规则。表单说明“实际操作还受工作区限制”。

模板建议默认 readonly；执行者模板可选择 confirm，但自动允许列表只预选只读工具，避免刚选“执行者”就默认放开 shell。角色能力 execute/review/coordinate 只表达调度资格，不授予工具权限。

新增工具目录 API 返回工具名称、说明、只读标记；权限计算复用服务端函数，并校准 toolsForAgent 对 disallowedTools 的过滤，避免把明确禁用的工具仍发给模型。UI 不维护第二套手写工具分类。

## 6. 存储、版本与来源隔离

### 6.1 推荐存储方式

界面创建角色存入现有 SQLite，source=db；文件角色继续以 `agents/*.agent.md` 为定义源，source=file。首版文件角色在界面只读，允许复制为新的 DB 角色。文件角色启停属于本地使用状态，可在界面修改，启动同步不得重置它。

不在“保存角色”时同时写 DB 和 Markdown，避免重启覆盖、文件权限失败和双写不一致。后续导出功能可单独生成文件。

| 数据 | 拟新增字段/表 | 用途 |
| --- | --- | --- |
| agents | enabled、version、definition_hash、source_path、sync_error | 当前配置及状态；source_path 只供服务端使用 |
| agent_versions | agent_id、version、definition、created_at；联合主键 | 不可变配置历史 |
| run_agent_snapshots | run_id、agent_id、version、definition、created_at；联合主键 | 每轮执行固定成员配置，含姓名、颜色、能力、提示词和权限 |
| conversations | default_reviewer_id、members_version | 房间默认审查者和成员配置的并发更新保护 |

已有 agents.definition JSON 可继续保存完整定义；enabled 和 version 只以列为权威，序列化响应时合并，避免重复字段漂移。版本 definition 不保存 API key。JSON 规范化后计算 hash；定义未变化时文件重载不递增版本。

### 6.2 文件同步规则

1. 读取并校验文件，先检测目录内重复 ID；重复记录均不覆盖已加载配置，显示诊断。
2. 相同 ID 已存在且 source=db：记录冲突，不覆盖 DB 角色。
3. source=file 且内容有变化：新增版本并更新当前配置；保留 enabled。
4. 文件无效或被移除：保留历史版本，将该角色标为不可用于新 Run，并显示原因；运行快照继续可用。
5. 配置有效恢复后清除同步错误，但保留用户手动停用状态。

应用迁移先为现有角色建立 version=1 和兼容能力。可仅在这次兼容迁移中从旧 ID 推导 reviewer/planner 等默认能力；运行时选择自定义角色必须使用 capabilities。

### 6.3 配置何时生效

Run 创建事务中校验完整团队、启用状态、模型配置与审查配置，保存全部 Agent 快照，再发布 run.updated 和开始调度。排队、当前执行、人工重试、服务重启恢复全部使用同一快照；修改角色只影响之后新建的 Run。

dispatcher 和 resumeSupervisorRun 不再执行“从注册表获取最新定义并 filter 掉缺失成员”。缺快照或必需角色时应明确失败，不能无声换人或更换主管。主管、执行与审查流程使用传入的固定定义。

历史 Run 的原始提示词版本无法可靠还原：已完成记录保留原样，标注“历史配置未知”；新增版本和快照不得伪称为历史真值。迁移前仍处于 pending/running/awaiting_approval 的旧 Run，首次接管时固定当前可用定义并记录“迁移时捕获”，找不到成员则阻塞并提示处理。

聊天 UI 根据消息 runId 优先取运行角色摘要（名称、颜色、角色能力）；新消息使用本轮快照，旧消息缺摘要时降级显示历史 ID。不能因改名、停用让历史发言消失或变成另一个角色。

## 7. 编排与聊天室接入

### 7.1 角色能力与房间职责

全局 capabilities 表示“这个角色能够做什么”；房间 supervisorId/defaultReviewerId 表示“这个团队选谁承担职责”。两者分开，不能把一个角色在某房间当主管视为全局只能当主管。

- 流水线按用户选择的成员顺序执行，保持原行为；能力作为提示，不重新排序。
- 主管模式要求 supervisorId 属于团队且具备 coordinate。
- 默认 Reviewer 必须属于团队且具备 review；有多名候选时要求显式选择，不按列表第一个或名字推断。
- 每个任务的 assignee 必须具备 execute，reviewer 必须具备 review。审查者不能与该任务执行者相同。
- 若只有主管且其具备 execute，可自行执行；没有可执行成员时建房/启动预检报错。
- 用户可选择“无需审查”。选择“必须审查”却没有合格独立 Reviewer 时拒绝启动，不自动降级。

修改 decomposePrompt、parseDecomposition 和 fallbackTasks，替换 `/review/i.test(id)`。在模型返回缺失 reviewer 时使用房间默认值；模型指定无资格或自审成员时按现有重试/降级机制处理，不能把审查需求清空。

### 7.2 已有聊天室如何使用新角色

新增“调整成员”面板，展示当前成员、可用候选、主管及默认审查者。保存时使用 membersVersion 防止并发覆盖，仅影响未来新建 Run。

运行中调整成员允许保存下一轮配置，但提示“本轮仍使用原团队”；已排队 Run 同样遵循已保存快照。变更必须保持主管/审查关系有效，待发送草稿中的 @ 对已移除成员需要提示重新选择。

停用角色后，已有执行和排队快照可完成；旧房间下次发送如果仍引用该停用成员，明确提示调整团队，不能自行删人继续。停用是禁止新使用，不是立即停止进程。

## 8. API 与事件设计

接口名为拟定值，实施时在 shared 中先定义请求/响应契约。

| API | 行为与响应 |
| --- | --- |
| GET /api/agents | 保持返回数组；运行选择器只展示可新用角色 |
| GET /api/agents?includeDisabled=1 | 管理列表含停用及同步异常角色；前端不直接复用为可选成员 |
| GET /api/agents/:id | 定义、版本、启用状态、来源及配置诊断；未知 ID 返回 404 |
| GET /api/agent-options | 内置模板、能力枚举、工具目录、Provider 是否配置；不返回密钥或完整环境 |
| POST /api/agents/validate | 纯配置预检，无模型调用；字段错误、模型配置状态和有效工具权限 |
| POST /api/agents | 创建 source=db、version=1，返回 201；ID 冲突 409 |
| PATCH /api/agents/:id | 修改 DB 定义，携带 expectedVersion；旧版本 409，文件定义编辑 403 |
| PATCH /api/agents/:id/status | 启停任意来源角色，携带 expectedVersion；返回状态与新版本 |
| PATCH /api/conversations/:id/members | 更新未来轮次团队、主管、默认 Reviewer；携带 expectedMembersVersion |

复制首版由客户端读取原配置并提交 POST /api/agents，不必增加独立 copy API；新 ID 必填，来源、时间、版本均由服务端重建。提交成功前使用 loading 锁，接口仍依赖唯一约束应对重复提交。

建议事件 `agent.updated` 携带最新定义/状态/版本，创建与编辑共用；`agent.sync.issue` 用于文件同步错误提示。广播必须在事务提交后发生。管理列表按 ID 合并，运行选择器过滤可用状态，WS 重连重新获取完整列表。

验证错误建议结构：`{ error, code, fieldErrors }`，表单保持已填数据；API 客户端保留字段错误，不仅转成字符串。方法不能接受 id/source/version/createdAt 等越权覆盖字段。

## 9. 工程拆分与执行顺序

### M1：配置模型与持久化（约 1–2 个工程日）

1. shared 增加 AgentCapabilities、管理 DTO、验证结果、版本与事件。
2. 新建 `apps/server/src/agents/validation.ts`，集中字段、模型路由与工具校验。
3. registry 分离 file 同步和 DB create/update/status，增加事务、唯一冲突与乐观锁。
4. SQLite 幂等迁移，版本记录、来源隔离与同步诊断。

完成判据：通过 API 可创建、编辑、停用；重启仍存在；文件同 ID 不覆盖 DB 数据。

### M2：执行固定版本与自定义能力（约 2–3 个工程日）

1. Run 创建入口统一预检和快照，覆盖 `/api/runs`、新聊天室、续聊三个入口。
2. dispatcher、恢复入口和编排器读取快照；历史记录明示兼容来源。
3. 主管计划和 fallback 使用 capabilities＋房间默认 Reviewer。
4. 增加房间成员设置和相应后端校验。

完成判据：名为 `qa-specialist` 的审查者可完成 FAIL→修复→PASS；运行途中改角色不会污染当前 Run；停用不造成静默漏成员。

### M3：管理与创建界面（约 2–3 个工程日）

新增 `components/agents/AgentList.tsx`、`AgentEditor.tsx`、`AgentPermissionPreview.tsx`、`AgentDetail.tsx`，在 FleetView 集成。RunView 建房支持创建入口和审查者选择；聊天身份显示真实角色名称/能力。

客户端 services/api.ts 增加契约调用，store.tsx 接入 agent.updated；新角色候选热更新但不自动选中所有成员。归档角色提供查看状态与重新启用操作；文件角色清楚标注只读来源。

完成判据：从空白或模板完成创建，保存后立即建房使用，字段错误可以原位修正，409 冲突不丢草稿。

### M4：回归与交付（约 1–2 个工程日）

配置服务和调度集成验证，浏览器走查列表、表单、权限预览及新角色运行。更新 README 和操作文档，提供一个可复现的 mock 演示流程。

整体粗估 6–10 个工程日，基于单人熟悉本仓库；不含独立模型凭据系统和角色生成助手。建议先后端验证再接 UI，避免只展示创建成功但实际无法调度。

## 10. 验证与验收清单

| 场景 | 必须观察到的结果 |
| --- | --- |
| 新建 | 创建“质量工程师/qa-specialist”，页面无需刷新出现；数据库 source=db、version=1 |
| 校验 | 重复/保留 ID、空提示词、未知工具、冲突白名单、无效模型前缀被拒；字段错误准确 |
| 文件来源 | file 角色界面不可改定义，但可复制；文件与 DB 同 ID 时不会覆盖 |
| 重启 | 自建角色存在、启停状态保留、版本不无故增长 |
| 并发编辑 | 两个编辑器持相同 version，第一份成功，第二份 409，草稿保留 |
| 权限 | readonly 无法写入；confirm 非白名单写入走审批；auto 只允许白名单；disallowed 始终禁止 |
| 工具 schema | 禁用工具不会向模型下发；预览和实际门控相符；外部写入审批仍有效 |
| 自定义审查 | ID 无 review 字样仍可作为 Reviewer；不能自审；无合格审查人不静默跳过 |
| 快照 | Run 入队后把 Agent 模型/提示词/权限改成 v2，当前 Run 和恢复仍读 v1；新 Run 读 v2 |
| 停用 | 选择器不可新选；旧 Run 可完成；旧房间下一轮提示更换，无静默缩减 |
| 成员调整 | 下一轮明确使用新成员；当前执行/排队轮次保持原成员 |
| 历史展示 | 改名或停用后历史消息仍有身份；未知历史版本不伪造 |
| Provider | 未配置模型可保存但状态明确，启动前报配置问题；mock 可全程无 key 演示 |
| 凭据 | 列表、详情、导出的 DTO、事件和日志不包含 API key |
| 回归 | pnpm typecheck、前端 build、verify:scheduler 及完整 LLM Stub 测试通过 |

新增 `scripts/verify-agent-management.mjs`：使用临时数据库和临时 Agent 文件，覆盖创建、冲突、启停、文件重载、版本快照与自定义审查。迁移测试至少覆盖现有数据库与全新数据库，重复启动结果相同。测试进程结束清理自己创建的临时目录，不修改真实角色文件或工作区。

浏览器验收：1440px 与 390px 下可完整填写和保存；键盘可操作；错误信息可见；关闭未保存编辑器时保护草稿；创建失败不清空输入。没有实际发起模型调用时不能显示“测试连接成功”。

## 11. 交付时的预期结果

用户打开舰队的角色管理，选择“审查者”模板，创建名为“质量工程师”的角色并保存。新建聊天室时可以选它与 Coder 配合，指定其为默认审查者；Coder 提交后由它给出意见并推动修复。之后修改该角色的检查标准，只影响新建的执行轮次；历史记录和正在进行的任务都可按原配置核查。

建议本轮评审确认：采用 DB 保存自建角色、文件角色定义只读且可复制、Run 固定角色版本、通过能力和房间配置选择审查者。这四项共同保证“能创建、能运行、能持续维护、不会改坏历史任务”。
