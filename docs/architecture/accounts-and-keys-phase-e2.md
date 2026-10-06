# 账户与密钥阶段 E2：逐账户调用与原生登录

状态：E2 实现完成。2026-10-04 已完成 fixture、实际本机 SDK/CLI 到模拟模型服务、原生协议和浏览器验证。真实供应商模型及用户授权验收待用户自己的账户完成；现已可通过 [E3 三步角色向导](./accounts-and-agent-creation-phase-e3.md)选择账户。

## 使用入口与支持范围

打开账户页，选择“添加账户或密钥”。API Key 可配置服务地址、接口、模型和超时；登录账户选择 Codex 或 Claude Code。

| 连接 | 运行方式 | 限制 |
| --- | --- | --- |
| Anthropic Messages API Key | 内置 Provider、Claude SDK、Claude 只读 CLI | 地址可为官方服务或明确支持 Messages 的网关 |
| OpenAI Chat Completions API Key | 内置 Provider | Responses 不能代替 Chat Completions |
| OpenAI Responses API Key | Codex app-server、Codex exec | 显式自定义 provider；固定 Codex 0.159.2 |
| Codex 登录身份 | Codex app-server、Codex exec | 每账户、每代次独立认证目录 |
| Claude 登录身份 | Claude 只读 CLI | SDK 完整编码仍要求 API Key |

“检查状态”只检查配置、密钥解密或原生认证，不调用模型。“测试模型”显式发最小模型请求，可能消耗供应商额度。结果只覆盖所选接入方式、模型和连接版本。改名不使测试过期；修改地址/协议/模型目录/超时、替换密钥或更换登录身份会使旧结果过期。模型列表来自账户维护，接口未做供应商模型自动发现。

Messages 账户支持 `authHeader: "x-api-key" | "bearer"`，省略时沿用 `x-api-key`。在现有高级设置中选择“Messages 认证”；认证方式是连接版本的一部分，修改后旧测试过期，新运行使用新配置。智谱 Claude Code 兼容接口应填写 `https://open.bigmodel.cn/api/anthropic` 并选择 Bearer Token，使用该服务可用的 Coding Plan Key，见[智谱官方配置说明](https://docs.bigmodel.cn/cn/coding-plan/tool/claude)。服务端 Provider 与外部客户端转发共用认证规则，供应商密钥仍不进入客户端环境。

模型测试遵循账户请求超时，缺省 180 秒、最大 600 秒；预算覆盖客户端检测、启动及完整响应读取，不再对外部客户端额外限制为 30 秒。测试页面显示目标地址、Messages 认证、等待时长和上限。测试探针关闭工具和会话复用，Messages 请求显式设置 `thinking.type=disabled`、限制输出预算，SDK 额外使用低思考强度；供应商对这些参数的处理由其接口决定。外部 API Key 调用收到 HTTP 401/403 时停止原生客户端重试，返回明确的认证/权限错误并清理进程。修复证据见[GLM 连接测试修复记录](../reports/accounts-glm-connection-fix.md)。Base URL 的直接选择功能暂缓，地址仍通过现有高级设置填写。

401/403 诊断保留供应商 JSON 错误的脱敏业务码和短消息，仅读取至多 8 KiB、等待至多 2 秒；HTML、超限、无法解析或未结束的错误体退回通用认证提示。供应商错误内容仍经过凭据脱敏，不能以原始响应或完整认证头展示。测试目标地址单独显示，避免和认证标签拼成错误地址。

“停用”阻止新 Run，已排队或开始的 Run 保留冻结版本。“立即撤销”列出受影响运行，确认后取消依赖 Run，关闭模型请求及原生进程；已撤销条目不可重新启用，应创建新的账户。删除检查角色、未完成 Run、登录、模型测试和未收敛进程。历史引用存在时归档并清除凭据，保留审计摘要。

## 登录流程

Codex 使用 `account/login/start` 的 `chatgptDeviceCode` 流程。页面展示 `auth.openai.com` 的验证链接和一次性代码；服务端处理 `account/login/completed`，再独立调用 `account/read` 核对身份。设备码和链接只留在内存及所属管理会话的响应中，不持久化，不向公开 WebSocket 广播。

Claude 当前 CLI 没有经验证的稳定网页集成流程。页面创建登录操作并给出：

```sh
pnpm accounts:login <页面生成的登录操作 ID>
```

在本项目服务器所在机器的项目根目录执行，按 CLI 引导完成供应商授权，再回页面检测。辅助程序使用服务器生成的独立 `HOME`/`CLAUDE_CONFIG_DIR`、空登录工作目录和受管进程；不复制个人登录文件。已失效或取消的操作拒绝启动，一个操作只允许一个终端持有。

登录有效期 10 分钟。关闭面板后可在同一管理会话重新打开继续；取消、退出管理会话或服务关闭会回收所属登录进程。服务重启将遗留操作标为中断，不自动重放授权或测试。无法确认旧进程已停止时保留恢复围栏，阻止继续登录、测试和删除。

重新登录创建新的身份代次及目录，完成前不替换当前身份。旧 Run 保留旧代次。执行前核对认证及身份摘要：允许客户端刷新 access token；身份改变或认证失效则拒绝执行，不能切换账户或回退全局认证。重新登录后创建新 Run，不重放已发生副作用的原生执行。

Claude 原生删除调用隔离目录中的 `claude auth logout`，再清理目录，以覆盖客户端可能使用的原生认证存储。退出失败会返回错误并保留私有文件供管理员处理，不声称完成凭据清理。

## 运行连接与角色引用

角色 API 与 Markdown 支持可选 `accountRef`。界面使用 [E3 三步向导](./accounts-and-agent-creation-phase-e3.md)选择账户，编辑/复制保留已有绑定。文件角色可先通过账户页取得稳定账户 ID，然后在既有角色定义中加入：

```yaml
# 内置模型角色
model: anthropic:供应商原生模型ID
accountRef: 账户页生成的ID
```

```yaml
# Claude SDK 外部角色；其他职责、工具、权限字段仍按既有角色契约配置
model: 供应商原生模型ID
accountRef: 账户页生成的ID
execution:
  kind: external
  driver: claude-sdk
  sessionPolicy: run
```

Codex 外部角色使用 `driver: codex-app-server`；API Key 应填写实际模型或账户推荐模型。原生登录账户可使用 `model: default`。`POST /api/agents/preflight` 接受完整 `AgentInput`，校验账户、协议、认证和 Driver，返回字段错误与权限摘要，不进行模型调用。E3 起结构有效但连接不可用时返回 HTTP 200、`ok:false`；结构/策略错误仍为 HTTP 400，具体契约见 [E3](./accounts-and-agent-creation-phase-e3.md)。

新 Run 的同一入场事务冻结 `run_account_bindings`：角色、账户、配置版本、凭据版本/身份代次、后端、模型。解析器按冻结记录取不可变配置及凭据，缺记录、丢失主密钥、版本不匹配或被撤销均失败关闭，不回退到全局配置。轮换后的旧凭据继续留在加密存储中供冻结引用使用；无自动凭据轮换/清理任务，最终由账户删除/归档清除。

内置普通回合、压缩、`chatWithAgent`、控制纠偏和规划器均使用角色账户。规划器可额外配置 `COORDINATION_PLANNER_ACCOUNT_REF` 与 `COORDINATION_PLANNER_MODEL`。Provider 缓存按账户、配置和凭据版本区分。原生会话绑定进一步包含账户版本/身份代次、Driver、角色版本、模型、权限和工作区，绑定改变建立新会话。

缺省 `accountRef` 的旧角色保持原认证来源；不自动迁移或修改已有角色。旧配置条目仍为只读投影。

## 凭据与原生工具边界

API Key 在服务端解密。外部调用使用每次执行独立的 loopback 认证转发：客户端获得短期随机令牌和本机地址，转发层将选定 Key 加到供应商请求。转发只接受指定 Messages/Responses POST 路径，拒绝浏览器 Origin 和重定向，并有请求体、超时、取消和生命周期限制。实际供应商 Key 不进入外部进程、Shell 或 MCP 环境。

原生进程使用独立 HOME/config 和环境白名单；SDK worker 禁止再次加载服务端 `.env`。SDK Bash 的 sandbox credential policy 清除认证变量，MCP 环境显式屏蔽供应商变量；Codex Shell 使用 `inherit=none` 和固定基础变量。测试 fixture 环境变量仅在 `NODE_ENV=test` 传递。

Codex 使用服务端生成的命名只读权限 profile，显式禁止读取账户私有目录，关闭工具网络和登录 Shell。线程/回合不再传入会覆盖此 profile 的旧 sandbox 参数，仍核对实际只读、无网络及审批策略。托管账户拒绝可能逃出沙箱的原生命令审批，保留沙箱内只读命令和经过路径检查的文件修改审批。该限制会使需要沙箱外命令的编码/测试失败；不能用审批绕过凭据目录保护。

连接测试关闭原生普通工具、会话复用和 Runtime 桥接；API Key 转发层还删除上游请求中的工具声明。Codex 原生 Goal 功能关闭，平台 Runtime 保持任务权威。未实现的用户输入/权限请求失败关闭。

输出、错误、工具结果和日志使用服务端秘密脱敏。流式输出缓冲可能跨块的秘密，原生快照同时隐藏未完成的秘密前缀。此机制用于已知凭据及常见认证字段，不能声称能识别所有未知敏感文本。公共接口无解密取回 Key 的能力。

## 数据、API 与运维

新增 `account_native_identities`、`account_login_operations`、`account_checks`、`account_revocations`；E1 的账户、版本、密文与 Run 绑定表继续使用。认证文件目录 `0700`，凭据文件 `0600`，禁止 symlink/多硬链接，原生身份只保留脱敏摘要及服务端指纹。

新增或扩展的接口均位于 `/api/accounts` 管理边界，沿用 Host/Origin、管理 cookie、CSRF 和远程管理认证：

| 接口 | 用途 |
| --- | --- |
| `GET/POST /api/accounts/:id/login` | 当前会话的待完成操作 / 启动登录 |
| `GET/DELETE /api/accounts/logins/:operationId` | 当前会话查询 / 取消登录 |
| `POST /api/accounts/logins/:operationId/check` | 完成后独立核对身份 |
| `POST /api/accounts/:id/check` | 配置或认证检查，不推理 |
| `POST /api/accounts/:id/test` | `{expectedVersion, backend, model}` 显式测试 |
| `GET /api/accounts/:id/models?backend=...` | 相容后端的账户维护模型候选 |
| `POST /api/accounts/:id/revoke` | `{expectedVersion}` 撤销并停止依赖运行 |

数据库、E1 主密钥以及整个私有认证目录应一起备份。不要复制原生 OAuth 文件来分发账户，刷新令牌仍由客户端管理。当前检查工具、整组备份与恢复步骤见 [E4 运维说明](./accounts-migration-phase-e4.md)。E2 实施前已保存 SQLite 备份，未替换现有数据库。

官方 [app-server 文档](https://developers.openai.com/codex/app-server) 与 [配置参考](https://developers.openai.com/codex/config-reference) 提供背景；固定 0.159.2 的兼容性证据来自本机生成的类型、无模型协议探测和真实 CLI 到本机 Responses fixture。特别是该版本拒绝旧 TOML `approval_policy="untrusted"`，实现移除此全局参数，仍通过 thread/turn RPC 显式设置并验证审批。

详细验证与剩余供应商验收见 [E2 验收记录](../reports/accounts-and-keys-phase-e2-acceptance.md)。
