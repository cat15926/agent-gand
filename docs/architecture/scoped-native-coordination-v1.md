# G5：原生冷边界与 Coordination 公共范围

状态：2026-10-17，已接入托管 API Key 的 Claude SDK、受控文件工具和新版静态 Coordination Scope。Codex app-server 使用相同实现并通过本机协议夹具，默认不开放新 Scope；真实 Codex 验证按用户要求暂缓。当前证据与限制见[接入收尾报告](../reports/scoped-collaboration-native-integration-2026-10-17.md)。

## 原生执行边界

`scopedNative.ts` 从已绑定的 Scope/Manifest/Attempt 创建服务端句柄。每次启动生成随机独立 home 和空工作目录，绑定 manifest 摘要、策略版本、责任代际和 session boundary。角色、聊天室、audience 相同也不能复用。启动、工具回调、运行中轮询及输出返回重新验证来源 ACL/版本与责任权威。

Claude SDK 禁止 resume、会话持久化、自动记忆和用户/项目 CLAUDE.md 加载；保持设置来源、插件及 MCP 白名单控制。Codex 使用 ephemeral thread，关闭项目文档读取与记忆生成/注入，阻断 resume 与原生普通工具。平台不对 Scope 工作目录采集 Git 差异或共享快照，避免祖先仓库内容进入结果。进程和执行桥收敛后删除本次目录。

托管 API Key 仍由账户 relay 代管，原生子进程只接收临时 relay 凭据。Codex 登录账户使用进程内 `chatgptAuthTokens` 接口，账户 authority 负责身份核验和刷新，子进程只接收短期访问令牌，不复制 refresh token 或 auth 文件。该登录组合已有部分真实账户证据，完整验收未通过；Claude 原生登录和历史环境变量认证未开放新 Scope 能力。Codex 0.159.2 的该令牌接口要求握手声明实验能力，仅在 scoped + token-only 路径开启；不增加可调用方法或工具。

`scopedNativeTurn.ts` 只生成 v3 动作候选。为复用旧原生生命周期而产生的 v2 完成标记不是 Runtime 命令；实际责任变更仍由 scoped scheduler 在原生进程退出后校验和提交。未收到明确控制工具调用不能完成事项。

## 工具和预算

文本独立材料与汇总任务仍只开放本轮唯一控制工具。新版 Coordination 另可开放 `fs.read`、`fs.write`、`search.files`：实际工具取平台、冻结步骤、角色和 Manifest 的交集，原生磁盘、shell、网络工具继续关闭。读取与搜索只覆盖 Manifest 选定的不可变受控文件版本及本 Attempt 自己写入的版本；不扫描聊天室、物理仓库或其他 Attempt 的同名文件。写入生成新的受控产物版本，沿用 Scope ACL，不能覆盖旧版本或扩大权限。每次读取与工具结果在返回前登记来源账本，完成前重验 ACL、版本和责任代际。

SDK 内部回合不能被平台输出 Token 参数可靠硬限制。原生准入独占预留本 Run 剩余额度；报告用量后结算，缺少用量时保留 unknown 并阻止后续请求。SDK 文本 Scope 最多一个模型回合；带受控文件工具的 Scope 最多八个模型回合、六次普通工具调用，控制候选提交后立即封闭。平台执行截止时间继续生效。显式要求供应商严格 Token 上限的普通编排/阶段仍拒绝原生成员；准入占额不冒充硬限制。缺少最终用量时，即使已有动作候选也不完成事项；同 Run/阶段后续请求被阻断。该机制是准入记账，不是供应商账单硬上限。控制工具中断可能早于供应商最终 usage，不能把候选已收到等同于费用已知。

控制候选提交后，桥立即封闭。原生进程最多获得 1.5 秒结束结算时间，只接收最终用量及结束回执，不再接收正文或工具效果。SDK 通过 PostToolUse 在控制工具返回时结束，避免继续发送模型请求；使用匹配会话的非崩溃结果中的 query 级 modelUsage。Codex 要求封闭后的用量与匹配 turn 的结束回执同时存在。超时、回执缺失、零化崩溃结果或外部取消继续保留未知用量。

恢复时只在原进程收敛后清理已验证的随机冷目录，不读取祖先仓库 Git 差异；不能确认进程或路径时保留 attention。账户身份探测的 15 秒超时单独标记为客户端初始化，不混同于 600 秒模型回复时限。

## Coordination 适用范围

新冻结、execute kernel、R7 stageBatchVersion=1、全部为只读无工具无文件产物的模型 API 静态步骤继续冻结 `features.coordinationScopes=1`。在专项与全局准入均为 execute、原生成员满足账户与驱动要求时，新静态阶段图冻结 `coordinationScopes=2`；所有执行节点标记为服务端生成的 `scopedFilesOnly`，只允许受控文件工具。预览明确说明使用本次上传/批准的受控文件，不直接修改代码仓库。

检查点标识由服务端在准入时传入，不能依赖准入之后才保存的检查点行，也不读取模型生成的 metadata 来授权。冻结参与者包含计划批准的观察者 audience，但观察者不会自动获得执行步骤或完成义务。

已有 Run、旧冻结契约和检查点续跑不升级，继续使用原有 R7 路径。新路径沿用 R7 输入选择、依赖图、并发、R5 预算和 Owner 阶段验收。每个 Attempt 创建 Scope 和来源清单，传入当前目标、角色及已获准依赖；不加载聊天室历史。已引用原始结果和根消息在模型调用前进入账本，在返回时重新校验。完成验收与结果消息在公共 Scope 输出事务中提交；来源发生变化时拒绝迟到结果。

版本 2 将本次 Owner 上传且 ACL 相容的受控文件，以及获准已完成前置 Attempt 的文件版本加入 Manifest。下游不能读取失败、未完成或无依赖授权的文件。声明文件产物须由本 Attempt 生成，不能用同名旧文件代替。阶段验收证据列表展示已完成成员生成的受控文件版本；Owner 仍须提交报告并明确验收。

已完成且具有输入账本的 Coordination 步骤可用 `previewPrivateAggregate` 作为授权汇总来源，`itemKeys` 使用 stepId。后续独立汇总、确切草稿、Owner 单次批准及发布全部复用 G3 服务。G6 已将来源选择与固定状态发布接入普通聊天室入口，见[当前支持契约](scoped-collaboration-support-v1.md)；没有绕过 Owner 的动态边或自然语言自动发布。

## 存储和兼容性

Schema 17 移除 `runtime_scope_attempts` 对 Collaboration Attempt 的单一外键，保留 Scope 外键及输入账本外键，并安装跨两种 Attempt 的 authority 插入触发器。历史行不改写；公共服务仍校验引擎对应的责任代际、计划版本、有效期和来源。旧 worker 会拒绝 schema 17；回滚应使用升级前一致性备份，不能修改迁移版本号降级。

## 支持声明

`foundationImplemented` 表示基础边界存在，`implementationSupported` 表示完整能力包准入；`configuredAvailable` 与 `connectionVerified` 分别表示配置可用和真实连接证据。API、SDK 与 Codex 的隔离基础和实现均为 true；只读 CLI 仍不支持。`SCOPED_NATIVE_DRIVERS` 默认 `claude-sdk`，空值可关闭原生新准入；Codex 需要显式配置，当前默认关闭。实际还服从全局驱动及 closed/preview/execute 开关、角色绑定的托管账户类型、兼容性和状态。`connectionVerified` 不因实现或本地夹具通过而自动提升，账户页已有连接测试也不能替代组合验收。

配置字段依据：[OpenAI Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)；本机协议测试同时读取有效配置，验证文档读取上限为 0、记忆生成和注入均为 false。
