# 真实协作验收入口 v1（R8）

R8 在 R1–R7 的夹具基础上验证真实供应商任务。入口与证据层级见[验收记录](../reports/platform-collaboration-r8-acceptance-2026-10-13.md)，调度及恢复语义继续使用[阶段批量调度](./scoped-stage-batch-scheduling-v1.md)、[R4 恢复](./private-write-stage-recovery-v1.md)及[R5 预算](./cost-budget-governance-v1.md)。本轮不新增契约版本或数据库迁移。

## 入口与执行范围

`pnpm collaboration:acceptance-real` 必须指定源 Claude SDK 角色、Codex 账户和模型 API 角色。默认只打印方案；追加 `--execute` 才发送请求。参数不接受密钥或登录令牌。

```sh
pnpm collaboration:acceptance-real \
  --claude-agent <已配置的SDK角色ID> \
  --codex-account <已登录的Codex账户ID> \
  --api-agent <已配置的模型API角色ID> \
  --max-starts 24 --timeout-ms 180000 --total-timeout-ms 1200000
```

在确认这些账户和模型属于获准测试范围后追加 `--execute`。默认源库为 `apps/server/data/agent-gand.sqlite`；可指定 `--source-db` 和新的 `--output-dir`。`--campaign core` 验证三后端、并行/汇合、拒绝返工、私密/公开切换、HTTP/WS 和失败续跑；`recovery` 补公共故障续跑及 SDK 私密写入核对；`codex-write` 单独补 Codex 私密写入核对。后两个批次使用一次性 Git 基线。

`--resume` 保留原库、原准入上限及原截止时间，跳过已通过事项。`--retry-public-fault` 只允许显式补测公开只读故障；历史错误及 Run 留在报告中，不用修改旧终态实现“恢复”。用户取消的 Run 仍不能关联续跑，真正失败的 Run 通过 Owner 预览与确认创建唯一后继。

源数据库只读。只复制所选账户的当前连接/加密密钥版本、所选登录代次和必要认证文件，不复制业务 Run、消息、审批、工作区或历史会话。验收角色和文件位于独立目录；SDK 使用内置 worker，Codex 使用实际客户端。模型 API 从选定托管角色或该源角色的现有环境连接生成隔离托管账户。真实入口拒绝 mock 角色、fixture 服务、自定义 SDK worker及本机模拟供应商端点。

## 准入、预算及清理

每个验收库安装专用 SQLite 触发器，在记录 `started_at` 之前原子检查全库准入次数和绝对截止时间。触发器仅存在于验收库，不进入产品迁移。限制对象为模型 API 请求和原生调用启动；SDK/Codex 内部多次推理、认证检查及自动重试不能由这一计数完整度量。

Core/恢复请求冻结 R5 估算费用政策、每次未知费用预留 0.1 USD、账户/模型及阶段范围。费用未知保留占额，后继沿原政策结转。原生启动和后端报告不等于供应商账单，也不宣称金额是实际扣费。API 单次输出上限为 2048 Token，原生使用既有账户/调用时限；执行范围包含单次平台文件写入及只读复核，禁止任意命令与外部写入。

退出会收敛验收子服务和原生进程，终止未完成测试 Run。数据库、报告和产物保留供核对，目录 0700、文件 0600，且位于 Git 忽略目录。报告保存 Run/绑定、状态、哈希、时长及预算，不保存密钥、认证材料或模型正文。

## 故障与真实证据

上游故障适配器包装实际 Undici Dispatcher，在一个真实供应商响应头到达后丢弃响应；适配 Undici 8 的 `onResponseStart`，不返回模拟推理。随后冷重启服务，验证没有自动重放，再由 Owner 从已失败来源预览/确认续跑。

私密写入故障在实际平台 `fs.write` 返回字节结果后终止对应原生进程组。必须核对该执行的守护进程路径、PID 和所有权 nonce，拒绝未归属进程。实际文件、原工具/调用账本和未知结果保留；Owner 核对原文件字节后提交恢复审查，后继只读取恢复版本，写入次数必须为零。

`pnpm verify:platform-real-acceptance` 用假凭据、本机真实 HTTP 和真实 SQLite 验证隔离、准入触发器、故障传输、进程所有权及令牌同步，不消耗供应商额度。供应商结论只能来自带绑定的真实 Run。

## 原生登录令牌刷新

验收副本可能刷新同一登录身份的 OAuth 令牌。正常退出后，以源账户当前登录代次、身份哈希、启用/撤销状态、文件所有者/权限和原文件摘要作为条件，原子同步刷新结果。源文件或身份已被用户修改则跳过，不能覆盖新登录。只同步同一身份的认证文件，不变更账户连接、代次或角色。串联隔离批次的同步链也需逐级执行相同条件。

## Codex MCP 发现修复

实测 Codex 0.159.2 在 `features.code_mode_host=false` 下返回“code-mode host is disabled”，平台 `fs.write` 无法发现。双向 Driver 现显式开启 MCP 工具发现宿主，继续关闭 `code_mode`、shell、浏览器、插件及私密回合的普通原生工具；MCP 仍只接受本次桥及冻结工具白名单。实际 SDK/Codex 私密写入与响应丢失恢复分别验收；工具发现不再只靠初始化通过推断。

## 浏览器验收

`platform-collaboration-real-ui.mjs` 打开已有真实记录，核对调用面板及零推理预览。`platform-collaboration-real-ui-live.mjs` 在新的隔离库中通过实际 Chrome 创建两个阶段，执行真实 API 任务、拒绝/预览返工、手机确认、验收并继续，最多三次准入。仅静态构建资源由本机文件提供，API/WS 均访问实际服务，没有拦截成 fixture。1440px/390px 属于浏览器视口验证，不代表实体手机或人工质量评审。
