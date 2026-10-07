# Codex 登录后模型测试的系统技能缓存误报修复

日期：2026-10-07。结论：**目录误报已修复，当前 Codex 登录账户的 `app-server / default` 真实模型测试通过。** 此次验证为账户连接测试，未代替 O7 所要求的带 Run/attempt 绑定的 Codex 任务验收。

## 原因与处理

用户测试返回“Codex 专用执行目录包含自定义配置、规则或插件，拒绝启动”。当前账户已认证，目录中没有 `config.toml`、自定义规则或插件；只有客户端启动时生成的 `skills/.system`。原实现只要发现 `skills` 目录就拒绝执行，因此登录检查或首次调用之后，正常目录会被误判为受污染。

Codex 的[官方缓存实现](https://github.com/openai/codex/blob/main/codex-rs/skills/src/lib.rs)将内置技能写入 `CODEX_HOME/skills/.system` 并生成 marker。服务端现在允许空 `skills` 或带正常 marker 的 `.system` 缓存；目录、缓存根和 marker 的符号链接仍拒绝，其他技能目录与自定义配置/规则/插件仍拒绝。

marker 不作为缓存内容可信的证明。登录/身份检查、app-server、只读 CLI 和 MCP 配置检查统一设置 `skills.bundled.enabled=false`，让整个缓存命名空间不参与执行。该[配置契约](https://github.com/openai/codex/blob/main/codex-rs/config/src/skills_config.rs)已用本机固定版本 Codex 0.159.2 核验，包括缓存内人为添加的技能也不出现在实际 `skills/list` 中。既有缓存和认证文件保留，没有复制或重建登录凭据，也没有更换账户身份。

## 验证证据

| 检查 | 结果 |
|---|---|
| 修复前复现 | 实际 Codex app-server → CLI → app-server 连续请求，本机 Responses 服务复现相同目录拒绝 |
| 原生协议 | 实际客户端生成缓存后再次启动成功；禁用整个系统技能命名空间，缓存文件保持；自定义目录/配置/规则/插件及符号链接拒绝；不启动模型 turn |
| 本机 Responses | 实际 Codex app-server → CLI → app-server 连续三次无工具请求通过，真实供应商请求为零 |
| 账户 E2 | 登录代次、冻结身份、认证转发、撤销、进程回收和秘密隔离回归通过 |
| MCP / 阶段 B | 禁用系统技能后实际平台 MCP 发现通过；写入审批、拒绝、幂等、超时清理、独立评审和返工回归通过 |
| 文档检查范围 | 按 Git 项目文件检查，包含新文档并排除已忽略的私有账户/自动技能缓存，避免扫描供应商内置文档 |
| 静态检查 | 类型检查、文档链接和 `git diff --check` 通过 |

真实模型测试使用业务服务 `http://127.0.0.1:3010`、账户 `Codex`（`38fc733b-0401-4ffe-83c7-21c6b08cc0e0`）、配置版本 1、登录代次 2；后端 `codex-app-server`，模型 `default`，结果 `passed`。测试关闭普通工具、会话复用和 Runtime 桥接，返回非空文本。连接过程中出现重试，等待时间较长，最终在账户的 180 秒预算内完成；这不代表供应商响应延迟已有保证。

对应检查 ID 为 `086cb72d-f924-4b8e-a0e4-df02a38204e5`。机器记录位于 `apps/server/data/orchestration-o7-qa/codex-account-test-2026-10-07.json`，只保存账户引用、版本、模型、状态和时间，不保存密钥、原生认证内容或模型正文。结束后运行中的账户测试及原生进程记录均为零。
