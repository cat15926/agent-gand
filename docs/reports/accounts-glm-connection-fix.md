# GLM 连接测试认证与超时修复记录

日期：2026-10-05。状态：实现与本机模型 fixture 验证完成；真实智谱直接 API 与 SDK 请求均确认被当前凭据拒绝认证，成功推理验收待有效凭据更新。

## 问题与修复

用户测试 `Claude-GLM-5.3 / Claude Code · SDK / glm-5.3` 返回“外部 Agent 执行超时”。本地记录显示该账户已填写智谱 Messages 地址、账户超时 180 秒，但连接测试会把外部 Driver 超时截为 30 秒。同一账户的直接模型 API 测试曾返回 HTTP 401，原有转发固定使用 `x-api-key`。早先两个 GLM 账户还使用 Anthropic 官方地址，不能据此验证智谱 Key。

依据[智谱 Claude Code 配置说明](https://docs.bigmodel.cn/cn/coding-plan/tool/claude)，增加 Messages 的 Bearer 认证配置，统一应用到直接 Provider 和 SDK/CLI 的服务端认证转发。现有连接省略该字段时保留 `x-api-key`；认证配置保存为新连接版本，旧运行继续使用冻结版本。当前 `Claude-GLM-5.3` 账户已通过本机管理 API 修正为 Bearer，地址和密钥保留，账户超时仍为 180 秒；其他账户未自动修改。

取消连接测试的固定 30 秒上限，按账户超时对完整测试设置截止时间。测试请求限制输出、工具和思考预算；真实供应商的参数处理以其接口为准。转发收到 401/403 时中止受管客户端重试，返回 HTTP 状态和认证排查提示。页面显示目标地址、认证方式、等待时间及超时上限，并在再次测试时清除旧结果。

用户要求暂缓 Base URL 直接选择功能，本次保持原有地址编辑入口，未实现地址预设选择器或角色中的地址编辑入口。

## 验证

- `pnpm typecheck` 与前端生产构建通过。
- `pnpm verify:accounts-connection` 使用临时数据库、本机 Messages 服务、实际 Claude SDK 0.3.288 和 Claude CLI：验证 `glm-5.3` 模型 ID、x-api-key/Bearer 两种认证、`/api/anthropic/.../v1/messages` 路径、无工具探针、冻结旧连接版本。
- 上游延迟 31 秒，实际 SDK 连接测试仍通过，证明原 30 秒截断已移除。
- 本机 401/403 fixture 各只接收一次模型请求，SDK 显示认证失败，未等待超时；完整流式响应挂起时，直接 API 和 SDK 均在账户设定的 8 秒预算内失败，并回收进程。最终没有运行中的测试记录或原生进程记录。
- `pnpm verify:accounts-e2` 与 `pnpm verify:accounts-e4` 回归通过，包括账户轮换、撤销、配置冻结、历史恢复和备份恢复。
- `pnpm verify:accounts-e3-ui` 隔离浏览器回归通过：表单选择并保存 Bearer、测试面板显示认证方式和 180 秒上限、等待时长递增，真实 Provider 转发使用 Bearer；角色创建/编辑/草稿与 390px 布局、键盘操作继续通过。
- `pnpm verify:external-agents-c` 通过，正常 Runtime 工具权限、纠偏和停止行为保持可用；`pnpm verify:docs`、`git diff --check` 通过。

本机 fixture 验证没有调用真实供应商，也不能证明用户 Key 的有效性、套餐权限或额度。此前在对话中公开的 Key 应在供应商侧撤销并替换，报告不记录密钥内容。

## Bearer 修复后的真实 401 排查

用户确认当前 Key 来源是智谱个人编程套餐（Coding Plan）。本轮使用用户现有账户新增一次最小直接 Messages 请求与一次最小 Claude SDK 请求，对照结果均为 HTTP 401、业务码 `1000`、消息“身份验证失败。”。实际地址为 `https://open.bigmodel.cn/api/anthropic`、认证为 Bearer，账户配置版本 2、凭据版本 1；Key 无空白、无重复 Bearer 前缀，未打印密钥内容。这些结果表明当前凭据未通过智谱认证，无法仅靠放宽超时完成模型验收；不据此猜测它已撤销、过期或所属套餐失效。

补充供应商错误诊断：SDK/CLI 返回脱敏业务码与短消息；读取限制 8 KiB / 2 秒，非 JSON 和超限错误体回退通用提示。目标地址独立显示，避免复制页面文字时与“Messages 认证”标签相连。类型检查、生产构建、`verify:accounts-connection` 与隔离 E3 浏览器回归均通过，专项测试覆盖业务码保留、错误中的凭据脱敏、HTML/超大/持续挂起错误体，以及实际 SDK/CLI 认证失败终止。

下一步由用户在智谱个人编程套餐控制台生成有效 Key，通过项目账户的“替换密钥”更新后再测试。服务端不能生成、恢复或解除供应商侧的密钥认证状态；不要通过聊天传递完整 Key。两次真实请求均未返回模型文本或用量数据，不能记为成功推理验收。
