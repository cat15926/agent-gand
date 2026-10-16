# G5：原生冷边界与 Coordination 公共范围

状态：2026-10-17，部分交付。Coordination 的无工具静态文本步骤已接入；Claude SDK / Codex app-server 的原生隔离、四种控制动作和本地 all 混合批次已验证，完整原生能力包仍禁止生产准入。真实账户连接、any 竞争、原生端到端发布矩阵尚未验收。

## 原生执行边界

`scopedNative.ts` 从已绑定的 Scope/Manifest/Attempt 创建服务端句柄。每次启动生成随机独立 home 和空工作目录，绑定 manifest 摘要、策略版本、责任代际和 session boundary。角色、聊天室、audience 相同也不能复用。启动、工具回调、运行中轮询及输出返回重新验证来源 ACL/版本与责任权威。

Claude SDK 禁止 resume、会话持久化、自动记忆和用户/项目 CLAUDE.md 加载；保持设置来源、插件及 MCP 白名单控制。Codex 使用 ephemeral thread，关闭项目文档读取与记忆生成/注入，阻断 resume 与原生普通工具。平台不对 Scope 工作目录采集 Git 差异或共享快照，避免祖先仓库内容进入结果。进程和执行桥收敛后删除本次目录。

托管 API Key 仍由账户 relay 代管，原生子进程只接收临时 relay 凭据。Codex 登录账户使用进程内 `chatgptAuthTokens` 接口，账户 authority 负责身份核验和刷新，子进程只接收短期访问令牌，不复制 refresh token 或 auth 文件。该登录组合尚未真实账户验收；Claude 原生登录和历史环境变量认证未开放新 Scope 能力。

`scopedNativeTurn.ts` 只生成 v3 动作候选。为复用旧原生生命周期而产生的 v2 完成标记不是 Runtime 命令；实际责任变更仍由 scoped scheduler 在原生进程退出后校验和提交。未收到明确控制工具调用不能完成事项。

## 工具和预算

当前原生能力只准备文本控制链路，不开放业务工具。执行桥已接入 Manifest 工具声明/调用校验，以及工具结果返回前的同 Attempt 来源账本。未来开放业务工具必须补齐具体来源和组合验收，不能只设置角色工具名单。

SDK 内部回合不能被平台输出 Token 参数可靠硬限制。原生准入独占预留本 Run 剩余额度；报告用量后结算，缺少用量时保留 unknown 并阻止后续请求。SDK Scope 最多两回合；平台执行截止时间继续生效。该机制是准入记账，不是供应商账单硬上限。控制工具中断可能早于供应商最终 usage，不能把候选已收到等同于费用已知。

控制候选提交后，桥立即封闭。原生进程最多获得 1.5 秒结束结算时间，只接收最终用量及结束回执，不再接收正文或工具效果。SDK 通过 PostToolUse 在控制工具返回时结束，避免继续发送模型请求；使用匹配会话的非崩溃结果中的 query 级 modelUsage。Codex 要求封闭后的用量与匹配 turn 的结束回执同时存在。超时、回执缺失、零化崩溃结果或外部取消继续保留未知用量。

## Coordination 适用范围

仅新冻结、execute kernel、R7 stageBatchVersion=1、全部为只读无工具无文件产物的模型 API 静态步骤，冻结 `features.coordinationScopes=1`。已有 Run 的冻结契约不升级；有工具、原生成员和检查点续跑继续使用已有 R7 契约，不能宣称具有新 Scope 能力。

检查点标识由服务端在准入时传入，不能依赖准入之后才保存的检查点行，也不读取模型生成的 metadata 来授权。冻结参与者包含计划批准的观察者 audience，但观察者不会自动获得执行步骤或完成义务。

新路径沿用 R7 输入选择、依赖图、并发、R5 预算和 Owner 阶段验收。每个 Attempt 创建 Scope 和来源清单，传入当前目标、角色及已获准依赖；不加载聊天室历史。已引用原始结果和根消息在模型调用前进入账本，在返回时重新校验。完成验收与结果消息在公共 Scope 输出事务中提交；来源发生变化时拒绝迟到结果。

已完成且具有输入账本的 Coordination 步骤可用 `previewPrivateAggregate` 作为授权汇总来源，`itemKeys` 使用 stepId。后续独立汇总、确切草稿、Owner 单次批准及发布全部复用 G3 服务。新增普通聊天室入口属于 G6；此处未新增绕过 Owner 的动态边或自然语言自动发布。

## 存储和兼容性

Schema 17 移除 `runtime_scope_attempts` 对 Collaboration Attempt 的单一外键，保留 Scope 外键及输入账本外键，并安装跨两种 Attempt 的 authority 插入触发器。历史行不改写；公共服务仍校验引擎对应的责任代际、计划版本、有效期和来源。旧 worker 会拒绝 schema 17；回滚应使用升级前一致性备份，不能修改迁移版本号降级。

## 支持声明

`foundationImplemented` 表示基础边界存在，`implementationSupported` 表示完整能力包准入；`configuredAvailable` 与 `connectionVerified` 分别表示配置可用和真实连接证据。当前原生后端仅第一项为 true，其余保持 false。账户页已有连接测试不能替代 G5 独立范围、发布和混合调度验收。

配置字段依据：[OpenAI Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)；本机协议测试同时读取有效配置，验证文档读取上限为 0、记忆生成和注入均为 false。
