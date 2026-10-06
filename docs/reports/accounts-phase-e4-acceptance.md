# 账户迁移与验收阶段 E4 记录

日期：2026-10-05。结论：E4 代码、迁移与本地验收完成；真实供应商授权、模型权限与计费链路待用户验收。所有本轮自动化模型请求均指向本机模拟服务，真实供应商请求数为 0。

使用与回滚见 [E4 运维说明](../architecture/accounts-migration-phase-e4.md)，原方案见 [实施指导](../plans/accounts-and-agent-creation-implementation-guide.md)。

## 本轮交付与证据

- 历史快照不覆盖，部分缺失按 Run 创建时已有角色版本回填；不推测历史托管账户或生成凭据版本。不完整 pipeline、supervisor、fastpath 恢复停止。
- 独立规划器保存模型和账户来源，托管认证版本与成员账户一起冻结。结构化追问、计划修订使用 Run 快照，角色换绑或全局规划器更新不能更换已排队运行的认证。
- resolver 即使收到丢失账户引用的角色，也拒绝绕过已有冻结绑定。未绑定停用草稿不会计入旧环境来源的角色引用。
- 新增只读 `accounts:audit`、停机 `accounts:backup`、只读 `accounts:verify-backup`，提供配套原路径回滚步骤。

`verify:accounts-e4` 使用去掉账户表的 A–D schema 构造临时旧库。只读检查前后数据库文件一致；启动迁移重复执行；原快照文本逐字一致，部分成员被补齐，无法确认来源的成员保持缺失且阻止恢复，没有凭据回填。测试覆主管和审查单次调用、普通轮次及工具预算收尾；团队规划者、独立规划器和暂停后的计划修订均使用冻结 Key/地址。可选规划器入场失败后不偷偷补绑。

重启验收在父进程创建排队 Run 后轮换 Key、修改地址、换绑角色并修改规划器配置，再启动独立服务进程；该 Run 完成，模拟上游只收到一次使用原冻结 Key 和原地址的请求，子服务输出不含 Key。备份包含一致数据库、主密钥、模拟原生认证目录和角色文件，逐文件权限及校验和通过；在临时原路径实际恢复后可检查密文，认证文件完整。缺主密钥、清单篡改、活动服务、未清理进程和源链接均会阻断对应操作。

## 自动验证结果

| 命令 | 本轮结果 |
| --- | --- |
| `pnpm typecheck` | 共享包、服务端、前端通过 |
| `pnpm --filter @agent-gand/web build` | 生产构建通过，现有大 chunk 提示仍存在 |
| `pnpm verify:accounts-e4` | 迁移、冻结、修订、进程重启、备份恢复及阻断通过 |
| `pnpm verify:accounts-e1` | 加密、旧来源、引用、脱敏、管理访问边界及私有文件保护通过 |
| `pnpm verify:accounts-e2` | 双账户、版本冻结、四 Driver、登录代次/取消/重启、撤销与环境隔离通过 |
| `pnpm verify:accounts-e3` | 草稿、缺账户/不兼容阻断、角色创建与预检通过 |
| `pnpm verify:accounts-e3-ui` | 三步向导、账户选择、内联新增、显式测试、编辑/复制、失效提示、刷新草稿、键盘及 390px 布局通过 |
| `pnpm verify:accounts-e2-protocol` | 本机 Codex 0.159.2 与 Claude 空目录认证、Responses provider、私有路径和工具环境验证通过 |
| `pnpm verify:accounts-e2-sdk` | 实际 Claude SDK 0.3.288 / CLI → 本机 Messages/SSE 模拟供应商通过 |
| `pnpm verify:accounts-e2-codex` | 实际 Codex 0.159.2 app-server / exec → 本机 Responses/SSE 模拟供应商通过 |
| `pnpm verify:external-agents` / `-b` / `-c` / `-d` | A–D 的只读、审批、控制桥、工作树、审查及恢复回归通过 |
| `pnpm verify:agents` | 原角色管理兼容通过 |
| `pnpm verify:coordination-planner` / `pnpm verify:coordination-stage-e` | 规划、fallback、只读 MCP、协议组合与修订回归通过 |
| `pnpm accounts:audit` | 本地现有数据只读检查通过，问题列表为空 |
| `pnpm verify:docs` / `git diff --check` | 文档链接及空白检查通过 |

浏览器测试使用临时数据库、独立本地服务和模拟账户；截图保存在忽略目录 `apps/server/data/accounts-e3-qa/`，本轮查看了移动端权限确认截图。模拟测试和实际供应商测试分开记录。

## 本地数据与服务

本轮只读检查本地数据：4 个角色、67 个 Run、1 个托管 API Key 账户、1 个密文版本；3 条历史原生身份记录保留。未更改用户账户、角色、历史快照、业务工作区或登录数据。开发服务健康检查通过，前端仍为 `http://localhost:5173/`，API 为 `127.0.0.1:3010`。未停服替换数据库，未运行 reset，未提交或推送变更。

已有升级前 SQLite 备份 `apps/server/data/backups/before-accounts-e2-20261004.sqlite` 是当时的数据库副本，不单独宣称它能恢复随后创建的账户和认证数据。今后的账户备份应按 E4 说明整组保存。

## 真实供应商验收记录

| 路径 | 本轮技术证据 | 真实验收状态 |
| --- | --- | --- |
| 内置模型 API | 托管账户普通/主管/审查/收尾、旧环境兼容、冻结后重启均经本机 HTTP 验证 | 待用户在账户页明确选择接入方式/模型并点击测试；现有账户未被自动调用 |
| Claude SDK + API Key | 实际 SDK/CLI 到本机 Messages/SSE 通过 | 待用户选择支持 Messages 的真实账户、模型，测试后进行编码/评审 |
| Codex app-server / exec + API Key | 实际 Codex 到本机 Responses/SSE 通过 | 待用户确认真实端点 Responses 兼容性、模型权限与额度 |
| Codex 原生登录 | 设备码 backend fixture、实际空目录检测通过 | 待用户创建独立账户、完成设备码授权并测试；真实 Token 刷新待验证 |
| Claude 原生登录 | 授权 backend fixture、实际空目录与终端引导/取消通过 | 待用户在独立终端完成授权并测试；真实身份与 Token 刷新待验证 |

普通保存、权限预检与维护工具不调用模型。真实模型测试由用户显式触发，测试结果绑定接入方式、模型和账户版本；改地址、换 Key 或换身份后应重新测试。后续只记录脱敏账户 ID、backend、模型、版本、时间与通过/失败结果，不记录 Key/Token；“测试通过”只证明这一组连接的最小无工具响应，不证明完整编码工作流。
