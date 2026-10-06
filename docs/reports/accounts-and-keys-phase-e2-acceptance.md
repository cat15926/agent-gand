# 账户与密钥阶段 E2 验收记录

日期：2026-10-04。结论：E2 实现与本地技术验收通过。真实供应商账户授权、模型权限及计费链路待用户验收；E3 角色向导、E4 完整迁移与真实供应商验收未实施。

后续状态：E3、E4 本地验收已完成，见 [E3 验收记录](./accounts-and-agent-creation-phase-e3-acceptance.md)、[E4 验收记录](./accounts-phase-e4-acceptance.md)。本文保留 E2 交付时的验收范围。

## 交付

- 角色 `accountRef`、统一 resolver、Run 入场冻结配置/凭据/身份代次；旧角色保持旧认证来源。
- 内置 LLM 全部消费路径及规划器使用角色账户；按账户版本缓存 Provider。
- 四个外部 Driver 的逐账户 API Key 调用，服务端认证转发及独立 HOME/config；Codex 显式 Responses provider。
- Codex 设备码登录；Claude 本地终端登录引导；认证检测、代次切换、取消、过期、重启收敛。
- 模型测试、具体接入方式/模型的结果展示、配置变更过期、立即撤销及依赖运行取消。
- 账户页原生表单、登录/测试面板、无障碍名称、键盘关闭与小屏布局。

使用方式及执行限制见 [E2 架构与使用](../architecture/accounts-and-keys-phase-e2.md)。

## 自动验证

| 命令 | 结果与证据 |
| --- | --- |
| `pnpm typecheck` | 共享包、服务端、前端通过 |
| `pnpm --filter @agent-gand/web build` | 生产构建通过；现有大 chunk 提示仍存在 |
| `pnpm verify:accounts-e1` | 加密、版本、重启、旧来源、引用、脱敏、Host/Origin/CSRF、远程认证及私有文件保护通过 |
| `pnpm verify:accounts-e2` | 双账户并发；冻结后轮换/改地址/停用；缺绑定拒绝回退；规划器账户；四 Driver 模型 fixture；原生登录代次/取消/失效/会话隔离；所属管理会话；重启不重放；密钥和流式前缀脱敏；环境隔离；原生进程中撤销；自由协作终局取消通过 |
| `pnpm verify:accounts-e2-protocol` | 本机 Codex 0.159.2 接受自定义 Responses provider 和私有目录 deny profile；沙箱命令无法读取临时私有 marker，Shell 不继承临时认证令牌；独立 Codex/Claude 空 HOME 无个人认证；模型调用、登录启动均为 0 |
| `pnpm verify:accounts-e2-sdk` | 实际 SDK 0.3.288、Claude CLI 经真实 Driver/relay 到本机 Messages/SSE fixture；上游收到所选虚拟 Key，模型请求无工具，返回 OK |
| `pnpm verify:accounts-e2-codex` | 实际 Codex 0.159.2 app-server/exec 经真实 Driver/relay 到本机 Responses/SSE fixture；上游收到所选虚拟 Key，模型请求无工具，返回 OK |
| `pnpm verify:external-agents` | 阶段 A 只读、分帧、失败诊断、取消、超时及重放保护通过 |
| `pnpm verify:external-agents-b` | 阶段 B 审批先于写入/命令、拒绝、去重、路径围栏、进程回收、Git/测试证据、FAIL→返工→PASS 通过 |
| `pnpm verify:external-agents-c` | 阶段 C 真实 stdio MCP、混合 Runtime 控制、纠偏、Holds、权限/ledger、Stop、责任代际围栏通过 |
| `pnpm verify:external-agents-d` | 阶段 D 工作树、不可变评审/patch、SIGKILL 恢复、持久占用、会话恢复及增量上下文通过 |
| `pnpm verify:agents` | 原有角色管理兼容通过 |
| `pnpm verify:coordination-planner` | 规划建议、修复、fallback、显式约束、风险、澄清和审计通过 |
| `pnpm verify:docs` / `git diff --check` | 文档链接及空白检查通过 |

托管 Codex 的专项审批 fixture 还验证：含路径检查的文件修改可审批并写入；可能脱离沙箱的命令审批被拒绝，不能通过用户点击批准读取认证文件。Claude 辅助登录验证一个操作只允许一个终端持有，重复启动不破坏原登录；客户端失败后操作标为失败，受管进程已停止。

上述实际 SDK/CLI 测试使用模拟供应商 HTTP/SSE，**不等同于真实供应商模型推理验收**。Codex 授权成功/取消和 Claude 成功授权链路在 backend fixture 完成；实际本机只验证空目录认证状态及 Claude 未授权引导/取消。

实际集成检查发现 Codex 0.159.2 拒绝旧 TOML `approval_policy="untrusted"`。已移除此全局参数，thread/turn RPC 继续显式传递并核对审批策略。实际 Codex 的测试工具目录包含原生 Goal/用户输入能力；现关闭原生 Goal，API Key 测试转发删除上游工具声明，原生不可支持的交互请求失败关闭。

## 浏览器与本地数据

`pnpm verify:accounts-e2-ui` 使用 Playwright 和可用 Chromium，可通过 `PLAYWRIGHT_MODULE` / `CHROMIUM_EXECUTABLE_PATH` 指定本机运行时；`GAND_UI_URL` 默认 `http://localhost:5173`。它依赖已启动的开发服务和本地管理模式，创建唯一名称的临时账户并在 finally 清理。

实际浏览器通过：

- 兼容网关创建；普通保存不调用模型；显式最小模型测试及按方式/模型显示结果。
- 配置变更标记测试过期；立即撤销后禁用测试与启用。
- Claude 创建后自动进入登录引导，命令无内部路径；未授权检测反馈、取消、原生账户编辑与清理。
- Codex 设备码面板的链接、代码、取消（浏览器 route fixture，不启动真实授权）。
- 390px 小屏无横向溢出；Escape 关闭与焦点恢复；无页面 JavaScript 错误。

截图在忽略目录 `apps/server/data/accounts-e2-qa/`，未将测试账户、私有目录、真实凭据或 SQLite 数据提交到 Git。

本轮使用临时数据库验证模型/原生进程，原有 SQLite 在升级前已备份到 `apps/server/data/backups/before-accounts-e2-20261004.sqlite`。本地已有角色与历史运行保留；浏览器清理仅匹配本轮唯一临时名称，不删除用户创建的账户。

## 需要用户完成的真实供应商验收

| 路径 | 当前证据 | 待验收 |
| --- | --- | --- |
| Claude SDK API Key | 实际 SDK→本机 Messages/SSE 已通过 | 用户供应商 Key、模型权限及完整编码/评审工作流 |
| Codex Responses API Key | 实际 app-server/exec→本机 Responses/SSE 已通过 | 用户网关/官方服务的 Responses 兼容性、模型权限及额度 |
| Codex 原生登录 | backend 设备码 fixture + 空目录实际状态检测 | 供应商设备码授权、真实身份读取、模型调用及 Token 刷新 |
| Claude 原生登录 | backend 授权 fixture + 实际空目录/引导/取消 | 用户在独立终端授权、真实身份摘要及只读模型调用 |

角色三步向导和账户下拉选择在 E3 实施。目前可通过角色 API/Markdown `accountRef` 测试完整连接；现有表单编辑/复制会保留已绑定账户。没有自动供应商模型发现、账户池轮换或多用户权限体系。
