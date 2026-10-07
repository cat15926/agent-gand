# Codex 登录角色无法保存并启用的修复

日期：2026-10-07。结论：新建原生 Codex 角色的保存、停用草稿的编辑启用和卡片启用流程已修复；业务库中现有 `nim` 角色通过实际页面保存并启用。

## 原因与处理

账户已完成原生登录，角色 `nim` 仍处于停用草稿，版本 1。原生角色预检使用 `account/read(refreshToken:true)`，每次检查都强制联网刷新令牌。预览偶尔成功，但后续保存或启用的独立检查会在 15 秒后返回 `issues.accountRef="外部 Agent 执行超时"`。页面预览、点击保存的预检以及服务端保存预检还会重复执行同类检查。

Codex [官方 app-server 认证契约](https://learn.chatgpt.com/docs/app-server#1-check-auth-state)区分读取当前账户与强制刷新令牌。普通角色预检现在使用 `refreshToken:false`，仍通过真实客户端核对本地账户和身份指纹；没有根据历史测试结果直接放行，也没有缓存认证结论。未登录、认证文件缺失或身份被替换仍失败，账户停用和撤销及角色权限校验继续生效。登录完成、显式账户检查及任务启动保留原有刷新和认证校验。

点击保存时直接进入服务端最终预检，减少一次重复请求。向导显示检查等待提示，失败后提供“重新检查”；角色卡片的启用错误显示服务端字段原因。

## 验证

| 检查 | 结果 |
| --- | --- |
| `pnpm verify:accounts-e3` | 模拟 OAuth 刷新服务不可达时，已登录 Codex 角色可预检、创建并启用及重新启用；任务启动仍尝试刷新，暂时失败不清除身份；替换身份指纹后阻断 |
| `pnpm verify:accounts-e3-ui` | 完整三步向导回归通过，增加 Codex 就地创建账户、登录成功、创建角色、停用后编辑“保存并启用”，保存期间没有额外预览请求；真实供应商调用为 0 |
| `pnpm verify:accounts-e2` | 原生登录代次、冻结身份、凭据缺失、撤销、四种 Driver 和进程清理回归通过 |
| `pnpm typecheck` | 共享包、服务端、前端通过 |
| `pnpm --filter @agent-gand/web build` | 构建通过，保留既有大 chunk 提示 |

实际业务页面 `http://localhost:5173` 中编辑 `nim`，保持账户 `38fc733b-0401-4ffe-83c7-21c6b08cc0e0`、模型 `default`、`codex-app-server`、确认权限和同一运行复用设置，点击“保存并启用”成功，版本由 1 变为 2。全部角色配置逐项核对保持一致，只有启用状态及版本更新。从权限预检到保存完成约 10.9 秒，无模型请求。

机器记录和截图位于忽略目录 `apps/server/data/accounts-e3-qa/`：`nim-save-enable-2026-10-07.json`、`nim-save-enable-before.png`、`nim-enabled.png`、`codex-native-confirmation.png`。该记录只保存角色和账户引用、状态、版本及耗时，不保存密钥或原生认证内容。本次验证针对角色保存与启用；模型连接验证沿用[此前真实账户测试](./accounts-codex-system-cache-fix.md)，没有重复消耗额度。
