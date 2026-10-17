# nim 切换 Codex 后的 G5 真实验收

日期：2026-10-17。结论：已使用当前 nim 角色启动隔离验收；鸡腿 Claude SDK 通过，nim 的首个 Codex 回合超时，G5 原生能力包继续保持关闭。

## 所选配置与验证方式

| 角色 | 冻结版本 | 模型 | 接入与账户 |
|---|---|---|---|
| nim | 4 | `default` | Codex app-server，既有 Codex 原生登录账户，配置版本 2 / 身份代际 2 |
| coder-jitui（鸡腿） | 7 | `glm-5.3` | Claude SDK，既有 Claude-GML-5.3 API Key 账户，配置版本 2 |
| glm53-api | 1 | `anthropic:glm-5.3` | 同一托管模型 API 账户；本轮准备所用，未产生真实 API 模型调用 |

本轮使用安装的 Codex `0.159.2`。`default` 由独立客户端解析；没有将它替换成另一个模型，也没有据此宣称某个具体 GPT 型号通过。

验收命令新增明确的角色选择：

```sh
pnpm scoped:native-real --claude-agent coder-jitui --api-agent glm53-api --codex-agent nim --execute
```

默认不带 `--execute` 只输出所选角色和限额。准备阶段从启用的 nim 读取账户、模型、角色提示词及会话策略，在独立库中生成只读测试角色；Scope 执行仍强制冷启动并关闭普通工具。角色定义摘要记录于私有结果文件，续测时校验所选角色集合及完整定义，模型、账户、提示词、会话策略或启用状态变化均拒绝继续旧验收。

测试材料为合成算术任务，角色提示作为有明确来源的公共输入进入 Scope。业务消息、任务及其他成员材料没有复制到验收库。混合调度的原生快照替换仅存在于隔离验收脚本，产品准入没有增加绕过开关。

## 真实结果

本轮从 `2026-10-17T02:27:50Z` 运行至 `02:38:44Z`。共用限额为 20 次平台启动、48,000 输出 Token 记账、30 分钟总时限、单次回复 600 秒；未扩大上限。

| 场景 | 结果 |
|---|---|
| 鸡腿 SDK：同角色私密事项、另一私密事项、公开事项 | 三次冷启动均通过；会话与目录不复用，输入不包含其他事项标记 |
| 鸡腿 SDK：complete / consult_batch / acknowledge / request_release | 四类动作通过，6 条 completed；全部取得最终用量并清理目录 |
| nim Codex：首个私密冷启动 | 身份检查通过，原生会话建立；10 分钟内没有正文、推理活动或控制工具结果，执行已停止 |
| nim 后续冷启动、ACK、发布请求及 SDK/Codex 真实混合发布 | 未通过 / 未开始；没有追加付费重试或用本机夹具补记通过 |

SDK 已知输入 12,614、输出 1,365 tokens；这是当前单回合限制配置下的新供应商证据，补齐了[上一轮报告](scoped-collaboration-closure-2026-10-17.md)中该配置尚无真实验收的限制。

Codex 1 条调用保留 `unknown`、12,000 输出占额。新轮合计 **7 条调用，13,365 / 48,000 输出记账**。供应商客户端内部请求数和最终账单无法由平台启动数推定。

## 超时证据与修复

Codex 于 `02:28:43Z` 启动，`02:28:52Z` 绑定会话。stderr 在 `02:33:26Z` 和 `02:38:01Z` 两次报告 `failed to refresh available models: request timed out`。另外使用不带凭据、不发送模型内容的 HTTP HEAD 探测，连接 `https://chatgpt.com/backend-api/codex/models` 在 8 秒 TCP 连接期限后失败，HTTP 状态为 000。测试进程没有继承到 HTTP/SOCKS 代理环境变量。

这些证据说明本轮存在访问 Codex 服务的网络问题，尚不能据此判定账户推理权限或指定模型可用。账户检查成功、建立会话和模型完成是不同的验收结果；当前证据不足以开放 G5。

本轮还暴露了诊断问题：验收传入的 `AbortSignal.timeout()` 产生标准 `TimeoutError`，执行器此前把它统一转换为取消。因此本轮历史记录仍显示 `cancelled`，其时间戳对应 600 秒请求时限；原记录未重写。执行器现已识别该标准超时，后续会记录 `failed / timeout / deadline`，保留未知用量；不知道上游计时长度时不编造具体秒数。主动取消仍记录 cancelled。

隔离回归覆盖会话建立后的标准超时、进程停止、未知用量保持及相同执行不重放。角色选择回归覆盖复制当前角色、关闭普通工具和拒绝续测配置漂移。两项回归的真实供应商请求均为 0。

本轮通过 `pnpm verify:execution-timeouts`、`pnpm verify:scoped-native-real-selection`、`pnpm verify:platform-real-acceptance`、`pnpm typecheck`、`pnpm verify:docs` 及 `git diff --check`。未带 `--execute` 的 nim 验收命令确认只展示限额，没有发出模型请求。

## 数据与清理

证据目录：`apps/server/data/scoped-native-real/2026-10-17T02-27-50.323Z/`。结果、隔离 SQLite 与凭据保存在不入 Git 的受限本机目录。最终活跃 Run、活跃原生执行、残留冷 home 均为 0。

业务库 87 条 Run 的完整行摘要与本轮开始时一致。旧轮 `2026-10-17T01-34-18.506Z` 的 13 条调用、2 条 unknown 及 24,000 未知占额保持原样。新轮的 unknown 单独保留，不冲销历史记录。

已在无活跃调用时备份并重启本地后端加载诊断修复；后端 `/api/health` 正常、`http://localhost:5173/` 返回 HTTP 200。重启后业务行摘要仍一致，外键错误与活跃调用均为 0。备份位于 `/private/tmp/agent-gand-before-nim-validation-restart-20261017.sqlite`，权限 0600。

后续安排（用户确认）：先跳过 Codex 角色的真实验证，不再将代理信息作为本轮继续工作的前置条件。后续验收使用 `--skip-codex` 单独验证模型 API + Claude SDK；Codex 的历史失败及未知用量保持原样，跳过不等于通过，也不禁用或修改业务角色 nim。

该后续新轮已完成 12 次真实调用，所选范围全部通过且无新增 unknown，见 [API + SDK 验收报告](scoped-collaboration-api-sdk-acceptance-2026-10-17.md)。本报告中的 Codex 失败结论保持不变。

原生业务工具和 Coordination 原生成员的新 Scope 接入仍属未完成项，继续遵守[支持契约](../architecture/scoped-collaboration-support-v1.md)。
