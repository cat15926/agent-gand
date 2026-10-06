# 账户与密钥、Agent 角色创建体验实施指导

状态：实施中。用户于 2026-10-04 批准方案；E1–E4 代码与本地验收已完成，真实供应商授权与模型验收待用户完成。E4 证据见[迁移验收记录](../reports/accounts-phase-e4-acceptance.md)。

日期：2026-10-04。agent-gand 设计源码基线：`883a3e9`。E1 实现见[架构与使用](../architecture/accounts-and-keys-phase-e1.md)，验证证据见[E1 验收记录](../reports/accounts-and-keys-phase-e1-acceptance.md)。E2 实现见[逐账户接入与登录](../architecture/accounts-and-keys-phase-e2.md)，验证见[E2 验收记录](../reports/accounts-and-keys-phase-e2-acceptance.md)。E3 实现见[三步角色向导](../architecture/accounts-and-agent-creation-phase-e3.md)，验证见[E3 验收记录](../reports/accounts-and-agent-creation-phase-e3-acceptance.md)。

## 1. 目标与设计结论

把配置流程整理为：**创建一次账户或密钥 → 创建角色时选择接入方式、账户和模型 → 检查权限摘要 → 保存并使用**。

新增独立的“账户与密钥”模块；一个账户条目可以代表 API Key 连接，也可以代表 CLI 的登录身份。角色只保存 `accountRef`，多个角色可以复用同一条目。账户名称、服务地址、模型目录和凭据统一管理，角色表单不再要求用户填写环境变量或原始认证目录。

用户创建的是 agent-gand 内的连接配置。订阅账户仍由用户到供应商页面完成授权，API Key 仍由用户从供应商取得。

本轮覆盖内置模型 API、Claude Code、Codex，以及现有四个外部 Driver 的兼容接入。Gemini、OpenCode 可使用同一扩展契约，新增运行 Driver 留到后续。多用户权限体系、账户池自动轮换、余额充值、自动切换供应商也留到后续。

## 2. 当前问题与 Clowder 参考

### 2.1 已核实的当前实现

| 位置 | 当前行为 | 需要调整 |
| --- | --- | --- |
| [AgentManager.tsx](../../apps/web/src/components/AgentManager.tsx) | 单个长弹窗暴露五种后端、模型路由、原生会话、两套工具策略；认证依靠提示文字 | 拆分创建步骤，将认证集中为账户选择，将运行参数放到高级设置 |
| [agent.ts](../../packages/shared/src/agent.ts) | 有 `model`、`execution`，缺账户引用 | 增加可兼容旧角色的 `accountRef` |
| [config.ts](../../apps/server/src/config.ts) | 内置模型使用 `LLM_*`；Claude SDK 使用 `ANTHROPIC_*`；Codex 使用专用登录目录 | 统一解析入口；保留明确标记的旧配置兼容路径 |
| [llm/router.ts](../../apps/server/src/llm/router.ts) | 按模型前缀创建全局 Provider 单例 | 按已冻结账户连接实例化，防止同供应商多个密钥混用 |
| [nativeDrivers.ts](../../apps/server/src/execution/nativeDrivers.ts) | SDK 只支持 API Key；Codex app-server 使用一个全局专用目录 | 支持逐账户解析、隔离认证目录和独立登录流程 |
| [sessions.ts](../../apps/server/src/execution/sessions.ts) | 从全局环境或全局 `auth.json` 推导账户绑定 | 改为显式账户、配置版本和认证身份绑定 |
| [modelPlanner.ts](../../apps/server/src/coordination/modelPlanner.ts) | 选择规划角色后仅保留模型字符串 | 同时传递规划角色账户，避免规划器继续调用全局密钥 |
| [index.ts](../../apps/server/src/index.ts) | 监听 `0.0.0.0`，CORS 接受任意 Origin，暂无后台认证 | 引入账户管理前补齐本地管理接口边界 |

模型、角色、执行方式和认证是四个不同概念。接入体验需要优化，A–D 已实现的审批、Runtime 控制、隔离工作区和恢复规则仍作为运行约束。

### 2.2 参考依据与采用范围

研究使用本地已有 Clowder 源码快照 `b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4`，提交日期为 2026-09-30；已访问其公开仓库入口。本方案中的源码结论基于该固定快照，不宣称它代表最新提交。

| Clowder 文件 | 已核实设计 | 本项目采用方式 |
| --- | --- | --- |
| [HubAccountsTab.tsx](https://github.com/zts212653/clowder-ai/blob/b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4/packages/web/src/components/HubAccountsTab.tsx) | 独立账户列表，复用认证弹窗，账户更新通知角色编辑器 | 独立模块与统一创建/编辑表单，热更新候选账户 |
| [UnifiedAuthModal.tsx](https://github.com/zts212653/clowder-ai/blob/b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4/packages/web/src/components/UnifiedAuthModal.tsx) | 区分 OAuth/API Key；字段包括客户端、名称、地址、模型 | 账户类型决定表单，常用项可直接完成，保留模型手动补充 |
| [HubCatEditor.tsx](https://github.com/zts212653/clowder-ai/blob/b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4/packages/web/src/components/HubCatEditor.tsx) | 角色有 `accountRef`；账户为空时提供创建入口；创建成功后回填 | 在角色创建过程中就地新增账户并保留角色草稿 |
| [account-resolver.ts](https://github.com/zts212653/clowder-ai/blob/b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4/packages/api/src/config/account-resolver.ts) | 账户配置与凭据分离，通过统一解析器提供运行配置 | 服务端集中解析，公共 DTO 与运行凭据分离 |
| [accounts.ts](https://github.com/zts212653/clowder-ai/blob/b1fe2966fa0a97d1e3cd2e174ed59fd1477b4fc4/packages/api/src/routes/accounts.ts) | 删除前检查角色引用 | 显示受影响角色，并检查活动 Run 和历史版本依赖 |

Clowder 的账户过滤含宽泛的 API Key 候选，不能直接当成本项目的接口兼容契约。我们增加协议和 Driver 的兼容矩阵。Clowder 的 OAuth 条目创建本身也不等于完成供应商授权；本项目应展示实际登录状态。

## 3. “账户与密钥”模块

### 3.1 入口和列表

左侧导航新增“账户”入口，页面完整名称为“账户与密钥”；舰队页和角色表单同时提供“管理账户”入口。

```text
账户与密钥                                      [+ 添加账户或密钥]
搜索名称       供应商：全部 ▾       类型：全部 ▾       状态：全部 ▾

名称              类型          适用方式             状态          操作
团队 Claude Key   API Key       模型 API / Claude     未测试        编辑 / 测试 / 停用
个人 Codex        登录账户      Codex                 已登录        重新登录 / 停用
公司模型网关      API Key       模型 API              测试通过      编辑 / 测试 / 停用

每条记录显示：服务域名、密钥末四位或登录身份摘要、模型数、关联角色数。
```

显示名称允许中文，系统生成不含凭据信息的稳定 ID。同名时显示供应商和 ID 摘要以区分。状态拆成“认证状态”和“连接测试结果”，避免将 CLI 已安装误显示为账户已可用。

角色关联数可点击查看引用角色。停用表示阻止新 Run；“立即撤销”是单独操作，应明确列出将中断的活动执行。删除有引用的条目时返回冲突，提供迁移角色入口；历史引用存在时归档条目并保留审计信息。

### 3.2 添加 API Key

基础字段：

1. 名称，例如“公司 Claude”“个人 OpenAI”。
2. 服务类型：Anthropic、OpenAI、兼容服务；官方类型自动填写官方地址。
3. API Key：密码输入框，仅提交时发送，编辑时留空表示保留现有密钥。
4. 服务地址：官方类型默认折叠；兼容服务显式填写并显示目标域名。
5. 模型：可从检测结果选择，也可添加原生模型 ID；设置一个推荐默认模型。

“高级设置”包含接口类型、超时、显式代理等已有运行选项。兼容服务必须选择实际支持的接口：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses。一个连接可以声明同地址支持多个接口，每个接口分别记录检测结果。

按钮提供“保存”“保存并测试”。普通保存仅做本地配置校验；真实模型测试由用户显式触发，界面说明会发送最小请求并可能消耗额度。

持久化后的密钥只显示“已设置”和末四位；不提供取回原密钥的接口。替换密钥单独递增凭据版本。清除密钥使用单独操作，避免空输入误删。

### 3.3 添加登录账户

用户选择 Claude Code 或 Codex，输入显示名称，点击“创建并登录”。服务端生成专用认证目录，前端不填写目录路径或 OAuth Token。

- Codex：优先通过已固定版本 app-server 的 `account/login/start`、`account/login/cancel`、`account/read` 和登录通知实现；优先设备码方式，显示供应商验证地址及一次性代码。
- Claude Code：通过当前 CLI 的 `claude auth login` 在该账户专用目录中登录。实施时先验证授权链接输出、取消流程和认证持久化方式；没有稳定可用的网页流程时，提供本地引导登录终端和“一键重新检测”，不让用户复制 Token。
- 登录进程与普通任务执行分开管理；登录不打开项目工作区、不调用模型、不启用项目 hooks/MCP。超时、取消、服务重启均回收登录进程。
- 页面只暴露登录状态和必要的身份摘要；供应商 Token 留在服务端原生认证存储中。不同条目使用不同目录，不复制个人主目录的登录文件。
- 同一条目重新登录为其他身份时产生新身份代次，旧会话不再复用。供应商是否允许同一身份同时授权多个目录需在实测中确认，不能靠修改显示名称声称实现独立账户。

创建成功但未完成授权的记录显示“待登录”；可作为角色草稿的选择项，无法启动新 Run。

## 4. 创建 Agent 角色的交互

建议把当前长弹窗改为宽面板内的三步流程，编辑既有角色时复用三个分区。

### 第一步：角色职责

- 选择模板：通用助手、规划主管、编码执行者、代码评审者、自定义。
- 填写显示名称和一句话职责；头像、颜色为可选项。
- 自动生成可编辑的角色 ID，放入高级设置；用户手动修改后不再自动覆盖。
- 模板提供默认提示词和能力，提示词可在此步展开编辑。

### 第二步：接入与模型

```text
接入方式        [模型 API]  [Claude Code]  [Codex]  [演示]

账户或密钥      [团队 Claude Key · 已设置 ▾]     [+ 新增] [管理]
模型            [账户推荐模型 ▾]                [自定义模型]

当前连接：Anthropic · api.anthropic.com
认证：已设置       模型测试：未测试
```

- 普通用户选择产品名称；`claude-sdk`、`codex-app-server` 等技术载体在高级设置显示。默认优先使用已经验证的 SDK/app-server 能力。
- 根据接入方式和接口类型筛选账户；不兼容条目默认不列入候选，辅助列表可展示不能使用的具体原因。
- 没有匹配账户时显示“添加 Claude 密钥”“登录 Codex”等具体操作。
- 点击“新增”打开账户子面板，角色名称、提示词、权限草稿保留。创建成功后选中该条目并更新模型候选，取消则返回原表单。
- 唯一可用账户或用户明确设置的默认账户可在新建时预选；多个账户且无默认值时要求选择。编辑时始终保留原绑定，失效时提示修复，不自动换成另一账户。
- 模型按“检测到 / 账户维护 / 自定义”显示来源。检测失败时仍允许输入模型 ID，不能把推荐列表当作供应商授予权限的证据。
- 内置调用自动编译 `openai:` / `anthropic:` 前缀，用户不手写路由；外部调用传原生模型 ID。只有确实支持默认模型的 Driver 才显示“使用客户端默认模型”。
- 切换接入方式时保留每种方式的草稿，并清除当前不兼容绑定；不重置名称、职责和提示词。涉及能力/权限变化时展示变化摘要。
- “规划主管”模板默认走模型 API；当前外部 Driver 不具备 `coordinate` 资格，应在选择阶段解释限制。

### 第三步：权限与确认

基础选项用“只读分析”“写入需确认”“按白名单执行”，只展示该接入方式实际支持的选项。评审模板默认只读，编码模板默认需确认；白名单执行不自动预选写工具或 Shell。

原生工具、平台工具、会话复用等在高级设置展开，并由服务端返回实际权限预览。原生工具与平台业务工具分区展示，保留明确禁用的优先级。

底部固定显示摘要：“角色 / 职责 / 接入方式 / 账户 / 模型 / 权限”。提供“测试连接”“保存角色”；缺认证、缺 Driver 或配置不兼容时可“保存为停用草稿”，不能保存为可运行角色。认证已设置但未测试可保存，显示未测试状态，运行前执行预检。

创建成功给出“加入当前建房草稿”或“创建聊天室”。从舰队创建时不自动改变旧聊天室成员。面板支持键盘导航、错误定位、取消后焦点恢复和小屏布局。

## 5. 首版支持矩阵

| 接入方式 | 可选认证 | 必须满足的接口/限制 | 默认载体 |
| --- | --- | --- | --- |
| 模型 API：Anthropic | API Key | Anthropic Messages | 内置 Anthropic Provider |
| 模型 API：OpenAI/兼容服务 | API Key | Chat Completions；现有内置 Provider 尚未实现 Responses | 内置 OpenAICompatible Provider |
| Claude Code 完整执行 | Anthropic/兼容 Messages API Key | 保留工具审批、Runtime 桥接、会话与隔离策略；自定义地址须通过针对性测试 | `claude-sdk` |
| Claude Code 登录账户 | Claude 原生登录身份 | 首版仅现有只读 CLI 路径及其顺序流水线范围 | `claude-cli` |
| Codex 完整执行 | Codex 原生登录，或 API Key | API Key 服务须支持 Responses；原生登录使用供应商自身地址 | `codex-app-server` |
| Codex 只读分析 | 同上 | 原有只读执行限制，不授予完整协作能力 | `codex-exec` |
| 演示 | 无 | 明确显示 Mock 功能范围 | 内置 Mock |

重要边界：当前 SDK 驱动明确拒绝订阅凭据；将 Claude 登录身份用于 SDK 的完整执行属于另一个兼容性工作，需验证 SDK/CLI 的认证、工具审批和持久化后才能开放。界面必须明确显示“登录账户当前支持只读分析”，不能把它自动接到 SDK，也不能静默降级用户要求的完整编码任务。

“OpenAI 兼容”不等于同时支持 Chat Completions 和 Responses。Codex API Key 接入需显式设置其 model provider / `wire_api=responses` 等参数，并测试当前固定的 `0.159.2`；不能只设置 `OPENAI_BASE_URL` 就宣称完成。

## 6. 数据与接口契约

### 6.1 数据分层

| 数据 | 内容 | 可否返回前端 |
| --- | --- | --- |
| `accounts` | 稳定 ID、显示名、供应商、认证类型、来源、启用/归档状态、当前配置版本 | 可，去除内部路径 |
| `account_versions` | 不可变的服务地址、接口类型、模型目录、默认模型、超时/代理配置 | 可返回安全配置摘要 |
| `account_credentials` | 账户 ID、凭据版本、AES-GCM 密文、nonce/tag、密钥 ID；或旧环境变量引用 | 只返回已设置/末四位，不返回密文或明文 |
| `account_native_identities` | 原生客户端、内部认证目录引用、登录身份代次、状态 | 只返回认证摘要 |
| `account_checks` | 分别记录配置、认证、接口/模型测试状态、时间、脱敏错误、所测试版本 | 可 |
| `account_login_operations` | 登录操作 ID、目标账户、状态、有效期、进程所有权 | 只返回必要的登录进度 |

认证类型用 `api_key` / `native_login`；来源用 `managed` / `legacy_env` / `legacy_native`。供应商和认证类型在创建后保持固定，需要转换时创建新条目并重新绑定。名称修改不影响认证身份或会话，地址/协议/凭据变更影响新执行。

API Key 采用版本化加密存储，主密钥与 SQLite 分开。本地部署自动生成 `data/private` 下权限为 `0600` 的主密钥文件，目录为 `0700`，并被 Git 忽略、从工作区和导出中排除；也可配置外部主密钥。已有密文但主密钥丢失时拒绝读取，不能自动生成新主密钥覆盖。数据库备份与主密钥恢复方式需写入操作说明。

原生 OAuth 凭据由 CLI 管理，存放在逐账户、逐身份代次的私有目录；不将供应商 refresh token 再复制到角色或 SQLite。路径由服务端生成，客户端不能指定任意认证目录。

### 6.2 角色与运行引用

```ts
// 角色：长期引用逻辑账户，下一次新 Run 使用其当前配置。
interface AgentAccountBinding {
  accountRef?: string; // 旧角色可缺省；新建真实角色要求显式选择
}

// 新 Run 入场冻结；放在服务端运行连接记录中，不含原始凭据。
interface RunConnectionBinding {
  runId: string;
  agentId: string;
  accountId: string;
  configVersion: number;
  credentialVersion?: number;      // API Key
  identityGeneration?: number;     // 原生登录
  backend: string;
  model: string;
}
```

增加 `run_account_bindings` 或等价运行连接表，作为凭据版本引用和回收的可查询依据。Run 的公开观测数据仅含账户名/ID及版本摘要，不包含密钥、原生路径或凭据指纹。

普通配置更新、替换 Key、停用只影响新的 Run；已排队 Run 使用入场时固定的连接版本。立即撤销单独改变版本可用性并中止依赖执行。旧凭据版本保留到活动/排队引用释放后回收，不能在替换时立即删除。

原生认证冻结的是身份代次，不是永不变化的 access token；允许 CLI 正常刷新 Token。若身份改变或认证失效，暂停对应任务并提示重新认证；不能自动换账户继续。新身份在新目录完成登录，不覆盖活动执行的认证目录。

### 6.3 拟新增 API

| 接口 | 用途 |
| --- | --- |
| `GET /api/accounts` | 脱敏列表、兼容能力、状态和角色引用数 |
| `POST /api/accounts` | 创建 API Key 或待登录条目 |
| `GET/PATCH /api/accounts/:id` | 查看/更新安全配置，使用 `expectedVersion` 乐观锁 |
| `POST /api/accounts/:id/credentials` | 替换 Key，返回新凭据版本 |
| `POST /api/accounts/:id/check` | 配置检查、原生登录状态检查；不发模型任务 |
| `POST /api/accounts/:id/test` | 用户显式触发最小模型测试，禁止工具、副作用和会话复用 |
| `GET /api/accounts/:id/models?backend=...` | 按后端返回模型候选、来源和检测时间 |
| `POST /api/accounts/:id/login` | 启动独立登录操作 |
| `GET/DELETE /api/account-logins/:operationId` | 查询或取消登录，不返回 Token |
| `GET /api/accounts/:id/references` | 角色、活动 Run、排队 Run 引用 |
| `POST /api/accounts/:id/revoke` | 显式立即撤销，并关闭依赖执行 |
| `DELETE /api/accounts/:id` | 无当前引用时删除；历史引用时归档；有活动引用时返回 409 |
| `POST /api/agents/preflight` | 校验接入、账户、模型和权限组合，返回字段错误与实际执行摘要 |

`GET /api/agents/options` 扩展为返回接入方式目录、适用认证类型、权限选项和推荐载体；兼容判断由服务端统一提供，前端不维护第二套协议规则。`account.updated` / `account.login.updated` 事件使打开的角色表单及时更新。

配置存在、CLI 已安装、认证存在和模型实测通过分别显示。测试结果关联连接版本和模型，配置更新后旧测试标记为过期；缺少 live test 不应显示“测试通过”。

## 7. 运行层改造与必须保持的约束

统一增加 `accounts/resolver.ts`，将账户引用及冻结版本解析为仅服务端可用的连接对象。

1. **内置 LLM**：`resolveProvider` 接收连接对象；缓存按账户配置与凭据版本区分。更新普通回合、`chatOnce`、收尾回合、review 和规划器等所有调用路径。显式 `COORDINATION_PLANNER_MODEL` 使用配套账户引用；旧环境变量规划器保留兼容路径。
2. **Claude SDK/CLI**：将 Key、地址和专用目录作为本次调用输入；SDK 不再硬编码从全局 `ANTHROPIC_API_KEY` 获取认证。登录身份与 API Key 目录规则分开校验。
3. **Codex**：每账户使用独立专用目录；API Key 路径生成受控的 Responses provider 参数。原生登录继续保留项目配置、插件、规则和审批的隔离限制。
4. **进程环境**：`process.ts`、`rpc.ts`、SDK worker 等接收逐执行环境，不通过修改全局 `process.env` 切换账户。清除未选账户的 Key/Token 和供应商路由覆盖项；必要系统变量、代理和平台桥接变量按用途注入。
5. **子工具隔离**：平台 MCP 不继承供应商 Key；原生 Shell 使用可验证的环境过滤，私有凭据目录加入读取限制。若某载体无法实现认证进程与工具环境隔离，需要本地认证代理或相应能力限制，在完成验证前不得宣称密钥对子工具不可见。
6. **会话绑定**：将账户 ID、配置版本、凭据版本/身份代次、驱动版本加入绑定。更换账户、地址、Key 或登录身份后建立新会话；只有名称变化可以继续复用。
7. **运行预检**：在创建任务和排队前检查角色账户引用、兼容性、认证存在和 Driver 版本；实际启动前再次检查撤销状态。错误要关联具体角色，并附“修复账户”入口。
8. **控制和恢复**：账户配置不能修改审批模式、平台工具权限、工作区范围或 Runtime 控制契约。保留进程所有权、租约、完成前清理、固定 Reviewer 快照和禁止崩溃后盲目重放等 A–D 规则。

模型列表获取不是兼容性测试。真实测试优先走该角色对应的实际适配器；仅 HTTP `/models` 成功不能证明 Codex Responses 或 Claude SDK 完整路径可用。

## 8. 管理接口与密钥边界

当前监听所有网卡且开放 CORS 的实现与新增密钥管理接口直接相关。本轮将本地版默认绑定 loopback、限制 Host/Origin；账户管理、认证和测试接口使用本地管理会话与 CSRF 防护。开发模式纳入可信的 Vite 代理来源，发布模式使用同源请求。

非 loopback 部署需要明确启用后台管理认证；未配置时拒绝开放账户管理。此处只补齐管理接口边界，不扩展为 SaaS 用户/组织系统。

新增秘密写入路径都不记录请求体；HTTP 错误、原生 stderr、观测事件和 WS 使用统一脱敏，既按字段处理，也遮盖当前已解析凭据的实际值。现有只匹配 `sk-*` 的正则不足以覆盖兼容服务 Key。

服务地址拒绝内嵌用户名/密码及明显敏感查询参数，校验 URL 协议、规范化路径；认证请求不跟随跨域重定向携带 Key。内网/本机兼容服务保留支持，但由用户显式创建地址，测试仅访问该连接目标，不自动扫描网络。

## 9. 兼容与迁移

1. 保留 `LLM_OPENAI_*`、`LLM_ANTHROPIC_*`、SDK `ANTHROPIC_*` 及既有专用 Codex 目录的兼容入口，在模块中显示“来自旧环境配置”或“来自旧登录目录”。旧环境条目用内部 `env_ref`，默认不把明文复制进数据库。
2. 内置 Anthropic Key 和 Claude SDK Key 可能不同，分别生成逻辑条目；不能仅按供应商名称合并。
3. 现有角色缺少 `accountRef` 时，由兼容解析器维持原有接入行为，UI 显示其具体来源并提供“选择托管账户”。新角色除 Mock 外使用显式账户绑定。
4. 文件角色仍以 Markdown 为定义源，支持可选 `accountRef` frontmatter；界面保持只读并允许复制到数据库编辑，不为迁移偷偷改写文件角色。
5. 已运行/历史 Run 不补写“当时不存在”的账户版本，也不改动原快照。旧快照按原兼容路径运行并记录来源；新 Run 才保证冻结连接版本。迁移不干扰仍在执行的外部进程。
6. 升级前备份 SQLite 及专用认证数据；新增表和字段按当前数据库初始化方式做幂等迁移。托管密钥从 UI 保存后立即可用于新 Run，无需重启。
7. 回滚可恢复旧环境配置和旧角色路径；新增托管账户只供新版本读取，不将明文导出到 `.env`。备份/回滚需同时保留主密钥和所引用的原生身份目录。

## 10. 实施分阶段与文件清单

本轮使用 E1–E4 编号，与已完成的外部接入 A–D 区分。方案已批准，E1–E4 代码和本地验证已完成；真实供应商授权及模型调用尚待用户验收。兼容、冻结与回滚契约见 [E4 运维说明](../architecture/accounts-migration-phase-e4.md)。

| 阶段 | 交付内容 | 阶段验收 |
| --- | --- | --- |
| E1：账户基础 | 共享账户类型、版本化存储/加密、脱敏 CRUD、引用检查、旧配置投影、管理接口边界；账户列表和 API Key 表单 | 可保存多个同供应商 Key，刷新/重启不丢失；API/日志不返回 Key；未授权来源不能修改账户 |
| E2：真实接入 | 统一 resolver；内置 LLM、Claude SDK、Codex API Key 的逐账户调用；Codex/Claude 原生登录管理；会话和 Run 绑定 | 两个账户并发调用互不串用；登录成功、取消、失效可观察；换账户新建会话；A–D 运行约束继续通过 |
| E3：角色创建体验 | 三步表单、就地新增账户、兼容过滤、模型候选、权限摘要、草稿、角色列表连接状态 | 从空配置到创建角色可全程完成；无需填写环境变量和驱动 ID；子面板返回不丢草稿 |
| E4：迁移与验收 | 旧角色/快照兼容、规划器等遗漏路径检查、回滚说明、自动化与浏览器验收、实际供应商验收记录 | 老角色保持原行为；新角色使用所选账户；升级重启/撤销/队列恢复可验证；浏览器验收通过 |

首条纵向链路：**添加 Anthropic API Key → 创建 Claude 编码角色 → 使用所选账户执行 → 评审角色只读检查**。随后完成 Codex API Key / 原生登录及兼容网关链路。

主要新增/修改位置：

| 模块 | 文件 |
| --- | --- |
| 共享契约 | 新 `packages/shared/src/account.ts`；修改 `agent.ts`、`execution.ts`、`events.ts`、`index.ts` |
| 账户后端 | 新 `apps/server/src/accounts/{store,credentials,resolver,compatibility,checks,login}.ts` 和 `apps/server/src/api/accountRoutes.ts` |
| 数据库与配置 | `apps/server/src/db/schema.sql`、`database.ts`、`config.ts`；私有目录和 Git 忽略规则 |
| 角色与 Run | `agents/{loader,validation,registry}.ts`、`runs/trace.ts`、API 角色选项/预检、任务入场及恢复入口 |
| 调用路径 | `llm/{router,provider}.ts`、`orchestration/agentStep.ts`、`coordination/{capabilities,modelPlanner}.ts` |
| 外部执行 | `execution/{runner,drivers,nativeDrivers,sdkOptions,process,rpc,sessions,errors}.ts` 和登录进程管理 |
| 前端入口 | `App.tsx`、`SideNav.tsx`、`services/api.ts`、`store.tsx`；新账户页面/表单/登录面板 |
| 角色前端 | 拆分 `AgentManager.tsx` 为角色身份、账户模型、权限、摘要组件；保留列表/编辑/复制行为 |
| 验证与文档 | 新账户/认证/角色交互验证；更新外部接入架构、使用说明、迁移说明和验收报告 |

## 11. 验收标准

### 11.1 产品操作

- 从空账户列表添加 API Key，再在角色向导直接选择；离开和返回表单不丢职责、提示词和头像。
- 两个不同 Anthropic Key 供两个角色选择；编辑角色、复制角色均显示实际绑定。
- Codex 完成原生授权后角色可选该账户；取消或授权过期显示可修复状态。
- Chat Completions 网关不显示为可用 Codex 账户；支持 Responses 的连接有对应实测记录。
- 停用账户显示引用角色并阻止新任务；替换 Key 不覆盖已排队 Run；立即撤销能终止依赖执行。
- Chrome/应用内浏览器完成创建、编辑、错误修复、键盘和小屏操作验收。

### 11.2 运行正确性

- 使用两个不同伪 Key 的本地服务 fixture 验证普通对话、review、规划器、收尾、SDK/Codex 各路径实际收到所选账户认证及正确地址。
- 同供应商两个账户同时运行，进程、Provider 缓存、认证目录和会话互不串用；验证调用期间全局环境没有变化。
- 地址、Key 和身份变化使旧测试过期，并阻止跨账户会话恢复；纯改名保留会话资格。
- 重启后账户与引用版本可恢复；缺少主密钥、认证文件、已撤销版本时给出明确错误，不静默使用全局 Key。
- 更新并运行适合本次改动的角色管理、外部 A–D、运行恢复及编排/协作回归；完成 typecheck、web build 和文档链接检查。

### 11.3 秘密和边界

- 在 API 响应、Run 快照、WS、原生错误、日志和导出中搜索测试 Key/Token，确认无原值泄露。
- 登录网址/设备码只在该管理会话展示，并过期清理；其他账户不能查询登录操作。
- 验证凭据文件权限、路径遍历/符号链接拒绝、MCP/普通子工具的认证环境隔离。
- 验证未授权 Origin、Host 和非本地管理请求不能新增/替换 Key、登录、测试或撤销。

真实供应商验收由用户自己的账户完成，分别记录 SDK、Codex API Key、Codex 登录及 Claude CLI 登录的结果。仅 fixture、CLI 版本检测或 `/models` 成功的结果不能标记为真实模型调用已验收。

## 12. 已批准的具体决策

用户已批准以下默认方案：

1. 新增独立“账户与密钥”模块，统一管理 API Key 与原生登录条目。
2. 创建角色采用三步向导，支持就地新增账户；技术 Driver 和工具细节进入高级设置。
3. 首版完成上述支持矩阵；Claude 订阅登录先沿用只读 CLI，SDK 完整执行使用 API Key。
4. 旧环境配置保留兼容并显示来源，新角色显式选账户，新 Run 冻结连接版本。
5. 本地托管凭据加密、原生身份逐账户隔离，并补齐本地管理接口边界。

若要求 Claude 订阅账户也立即支持完整 SDK 编码协作，需要把该认证兼容性验证和适配明确加入 E2 的范围；验证完成前保持不可用状态，不将它作为现成能力写入验收承诺。
