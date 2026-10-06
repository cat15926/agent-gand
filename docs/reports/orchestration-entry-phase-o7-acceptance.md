# 编排入口 O7：整体验收与收尾记录

日期：2026-10-06。结论：**O7 本地交付工具与整体验收完成，真实 Claude SDK / Codex app-server 用户账户验收尚未执行，兼容分支尚未删除。不能宣称整个 O7 已通过最终验收。**

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
| Claude SDK | 未执行 | 等待用户确认是否使用现有 Claude-GML-5.3（鸡腿）账户 |
| Codex app-server | 未执行 | 当前业务库没有已登录 Codex 托管账户，等待用户指定项目账户/认证安排 |

本轮真实供应商推理请求为零；真实服务没有被测，不能写“认证失败”或“真实后端通过”。业务库只读取公开账户/角色摘要和审计，不解密密钥，不启动新的业务推理。

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
