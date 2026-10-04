# 外部 Code Agent 阶段 B 验收

日期：2026-10-04。双向后端和平台集成的离线验收完成；真实供应商模型的写入、审批和测试 smoke 尚未执行。使用方式见[阶段 B 架构与使用](../architecture/external-code-agent-phase-b.md)。

## 专项集成验证

`pnpm verify:external-agents-b` 使用伪 Claude SDK worker、伪 Codex v2 stdio app-server、真实 Fastify 路由、临时 SQLite 与一次性 Git 仓库。SDK options 和 PreToolUse 使用实际实现；临时仓库的文件修改和 `node --test` 是真实本地操作。

已验证的行为：

- 两个后端都在批准写入前保持目标文件不变；测试命令在批准前未执行，批准后采集真实 Git diff 与测试输出。
- 重复原生请求复用审批卡；原生卡不能 edit；拒绝返回原生进程且不发生对应写入。
- 越界文件请求及符号链接逃逸不获得批准；外部 coordinate/自由协作、Codex auto/白名单配置被拒绝。
- SDK auto 只放行配置的工具；实际 SDK options 使用工具前检查、空 allowedTools、failIfUnavailable sandbox，并禁止 unsandboxed commands。
- Run 停止后旧审批卡返回 409，待审批执行结束；超时清理忽略 SIGTERM 的原生子进程，没有继续占用的同组进程。
- Codex 返回降级 sandbox 在模型 turn 前失败；其他 thread 的通知按协议错误处理。
- Codex 使用独立、持久执行目录，不读取测试用户目录中的免审配置；该目录出现 config.toml 时拒绝执行，原有登录状态文件不被复制或删除。
- 现有 scheduler 完成 Claude SDK Coder → Codex Reviewer 的 FAIL → 第二次实现 → PASS，生成两个工作与两个只读审查执行；Reviewer 输入包含平台采集的实际 diff 和测试证据。
- 经完整聊天室 API 完成 Codex Coder → Claude SDK Reviewer 的 Supervisor 流程并得到结构化 PASS。

验收中还修正了初次聊天室运行携带空路由对象时被判为追问的问题，否则会跳过主管任务和审查。初次派发恢复为正常主管入口，已有追问路由回归通过。

## 本机原生协议检查

`pnpm verify:codex-app-server-protocol` 运行本机真实 `codex-cli 0.159.2`，在私有临时 CODEX_HOME 中执行 initialize 与空 thread/start，验证 cwd、read-only sandbox、networkAccess=false、approvalPolicy 和 user reviewer 的返回结构。没有发送 turn/start，模型 turn 数为 0。

该检查确认真实协议的 `thread/start.sandbox` 输入为 `read-only`，返回的 SandboxPolicy type 为 `readOnly`，两者不能混用。官方 SDK 版本固定为 `@anthropic-ai/claude-agent-sdk@0.3.288`；SDK worker 采用该包的类型和 options，但专项测试替换了推理进程。

## 回归验证

以下验证通过：

- `pnpm typecheck`
- `pnpm verify:external-agents`（阶段 A 兼容）
- `pnpm verify:external-agents-b`
- `pnpm verify:codex-app-server-protocol`（真实协议，不调用模型）
- `pnpm verify:agents`、`pnpm verify:scheduler`、`pnpm verify:followup-stage3`
- `pnpm verify:durable`、`pnpm verify:runtime-exit-guard`、`pnpm verify:collaboration-ui`
- `pnpm verify:docs`、前端生产构建、`git diff --check`

构建仍存在已有 elk 图布局依赖的大 chunk 提示，不阻止构建。

## 验证边界

伪 runtime 验证平台请求、响应、策略参数、事件、审批和进程生命周期；它不能证明真实 SDK hook、供应商 sandbox、OAuth/API key、模型工具选择和编码质量在完整推理中正确。真实 Codex 检查仅证明初始化与策略回执，不证明真实写入/审批流程。

真实验收应在一次性 Git 仓库、已配置 SDK API key 和独立 Codex 登录目录上，各执行一个修改与测试任务，检查批准前后文件状态、原生卡、工具输出、diff、结构化审查和停止。当前不声明此项已通过，也未自动消费供应商推理额度。

服务端单宿主进程组和内存工作区互斥不提供跨进程持久隔离或崩溃恢复；外部 Runtime MCP、Windows 和 resume 尚未交付。经批准的 Codex 沙箱外命令需按卡中显示的完整操作判断，其副作用不保证限于 cwd。具体范围见架构文档。
