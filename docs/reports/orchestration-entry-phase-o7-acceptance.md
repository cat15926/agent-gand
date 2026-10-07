# 编排入口 O7：整体验收与收尾记录

日期：2026-10-06；真实账户补验：2026-10-07。结论：**O7 本地交付工具与整体验收完成，鸡腿绑定的真实 Claude SDK 只读最小任务已通过；Codex app-server 用户账户验收尚未执行，兼容分支尚未删除。整个 O7 最终验收尚未完成。**

实现说明见 [O7 架构与演示](../architecture/orchestration-entry-phase-o7.md)、[API 迁移说明](../architecture/orchestration-api-migration.md)和[兼容清理清单](../plans/orchestration-compatibility-cleanup-checklist.md)。

## 已交付

- 聚合本地验收 `orchestration:acceptance`；每项记录退出状态和耗时，失败/未执行不会被归类为通过。
- O7 的真实 HTTP 集成测试、可重复的隔离页面演示和页面代理测试。
- 用户账户最小任务命令 `orchestration:acceptance-real`；显式选择角色、独立空房、冻结账户、只读请求、幂等查回、任务/执行绑定核验、失败停止与无敏感正文报告。
- 只读入口统计与清理盘点；不根据零条统计自动删除兼容分支。
- 修正旧 SDK MCP / session 验证脚本的调用环境：显式传入本地 fixture 认证，私有目录和执行目录在临时目录内，不再依赖旧的隐式全局环境。

## 本地验证

`pnpm orchestration:acceptance` 的最终结果为 `passed`，12 项全部退出 0：

| 检查 | 结果 | 证明范围 |
|---|---|---|
| O1 | 通过 | 请求规范化、幂等与预览 |
| O2 | 通过 | 多驱动执行/评审准入、绑定和权限围栏 |
| O3 | 通过 | 成员互斥/FIFO、终态和任务动作 |
| O4 | 通过 | 全部已公开工作流、返工、DAG、预算与修订 |
| O6 | 通过 | 版本迁移、兼容、关闭入口后的收尾和实际子进程故障 |
| O7 HTTP | 通过，10 组 | 自动/接力/分析/评审/等待恢复、托管账户模拟驱动、错误边界和清理盘点 |
| Claude SDK MCP | 通过 | 实际安装 SDK + 本机 Messages fixture、权限回调/MCP/受控中断 |
| Claude SDK session | 通过 | 实际 SDK 私有 JSONL、第二进程恢复与原生历史 |
| Codex app-server protocol | 通过 | 本机已安装 CLI 的协议与沙箱准入，不含供应商推理 |
| Codex MCP protocol | 通过 | MCP 配置与本地平台回调 |
| Accounts connection | 通过 | 实际 SDK/CLI 本机 Messages、认证方式、31 秒响应、401/403 失败及超时清理 |
| O5 + O6 页面 | 通过，12 组 | 草稿、团队/本轮对象、五工作流、任务动作、审批、宽度及灰度提示 |

聚合机器记录位于 `apps/server/data/orchestration-o7-qa/local-suite.json`；O7 单项记录为同目录 `result.json`。这些运行产物被 Git 忽略，不包含完整认证材料，也不把模拟后端归类为真实通过。

`verify:orchestration-o7-demo-ui` 额外连接实际运行的 Vite 代理，未经请求拦截：1440/768/390px 无横向溢出，长名称 SDK 成员开关不改变策略或输入宽度；HTTP 提交、WebSocket hello、任务完成、刷新后的持久任务卡、键盘和 React 无异常验证通过。浏览器调整视口后等待渲染帧稳定，再比较同一尺寸下的成员开关。截图和 `demo-ui-result.json` 位于同一 QA 目录。

类型检查、生产构建、文档链接与 `git diff --check` 通过。构建仍有已有的大 chunk 提示，本阶段未调整打包策略。

## 真实账户状态

| 后端 | 状态 | 原因 |
|---|---|---|
| Claude SDK | 通过（2026-10-07） | 用户指定现有 Claude-GML-5.3（鸡腿）账户，真实 `glm-5.3` 只读最小任务完成 |
| Codex app-server | 账户模型测试通过；任务验收未执行 | 2026-10-07 登录代次 2 的 `default` 无工具模型测试通过，待用户选定角色开展 Run/attempt 绑定验收 |

2026-10-06 的本地验收没有真实供应商推理。2026-10-07 经用户明确指定账户后，在正常业务服务 `http://127.0.0.1:3010` 执行一次成功的真实 SDK 最小任务；服务声明 `fixture=false`、`claudeSdkWorker=bundled`。认证使用已托管账户，不使用聊天中曾出现的密钥或全局登录目录。

首次 Run `2b6a2cdb-a1b2-4aa4-a70c-422b2f32c9ef` 在原生执行创建前失败：只读请求收紧了角色权限，却保留了原生工具白名单，触发 `readonly 原生工具由后端固定提供` 配置校验。该失败不是供应商认证失败。修复统一的只读角色副本：收紧权限时清空本轮原生工具授权，应用于请求、步骤和评审；鸡腿存储的 `confirm` 权限及六项原生工具配置未改动。

修复后证据：

| 项目 | 结果 |
|---|---|
| Run / 原生执行 | `b865731a-4739-4490-bae3-e3ddb493400c` / `0154b8b7-3875-49b4-abe8-bbbd0acd8115`，均 `completed` |
| 角色 / 账户 | `coder-jitui` / `267c2e27-b25f-43cf-acaa-143327f7f714`，配置/凭据版本均为 1 |
| 后端 / 模型 | `claude-sdk`，安装版本 `claude-agent-sdk 0.3.288`，`glm-5.3` |
| 权限 / 绑定 | 原生执行 `readonly`；冻结账户、有效 attempt 执行绑定、统一编排契约均已核验 |
| 最小交付 | 持久化结果包含 `2 + 2 = 4`；调用 `agent_complete` 完成，无退出纠偏 |
| 普通工具 | 未调用文件、命令或其他普通工具，仅平台完成控制动作 |
| 本地回归 | O7 HTTP 11 组、O2 14 组、类型检查通过；新增写工具角色的自动/接力只读和原生评审覆盖 |

完成控制动作会停止原生回合，Trace 中对应 MCP 工具 span 因没有收到原生完成回执显示 `error`；原生执行记录和平台完成裁决均为成功。这是当前工具回执的观察局限，不是认证或任务失败。

机器报告保留在 `apps/server/data/orchestration-o7-qa/claude-real-2026-10-07.json`（首次失败）与 `claude-real-2026-10-07-after-readonly-fix.json`（修复后 SDK 通过）。仅保存状态、绑定和引用，不保存密钥或模型正文。修复后报告整体仍为 `incomplete`、命令退出 2，原因是 O7 同时要求 Codex，而本次用户仅选择了 Claude；Claude 后端自身为 `passed`。

随后用户报告 Codex 模型测试的目录拒绝；已修复客户端自动系统技能缓存误报，并用当前登录账户完成真实 app-server/default 连接复测，详见[Codex 缓存修复记录](./accounts-codex-system-cache-fix.md)。账户测试没有创建平台 Run，不能用于补齐 O7 的 Codex 任务绑定证据。

账户确定并在正常服务上配置好角色后，可执行：

```sh
pnpm orchestration:acceptance-real --base-url http://127.0.0.1:3010 --claude-agent coder-jitui --codex-agent YOUR_CODEX_ROLE
```

不要原样使用占位角色。只提供 `--claude-agent` 时可以单独验收 SDK，但 Codex 保持 `not_run`，整体 `incomplete`。真实运行保存 `real-result.json`，仅保留 Run ID、账户引用/版本、driver、执行/绑定状态和错误类别，不保存模型正文。输入说明和错误处置见 O7 架构。

## 业务迁移与兼容收尾

只读盘点：39 个房间已映射，69 个 Run；版本迁移无待办，没有活跃或未知结果任务。一个旧主管房间需补配置，详见清理清单。入口统计没有记录，观察期和调用方迁移证据尚未建立。

因此 `canRemoveCompatibility=false`；保留旧 API、历史字段及冻结 Run 的执行/审批/恢复适配。原计划要求用户确认后才可清理兼容分支，本轮没有进行清理、提交或推送。

## 可验收服务

当前隔离演示：`http://127.0.0.1:5174/`，API 为 `http://127.0.0.1:3011`。全部模型与原生进程为模拟，业务数据库和真实认证独立；退出服务后删除本次演示数据。可通过 `pnpm orchestration:demo` 重新启动，操作步骤见 O7 架构。
