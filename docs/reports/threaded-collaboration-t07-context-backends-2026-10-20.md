# 持续协作 T07：上下文与后端验收

日期：2026-10-20。基线 T06 `79bad41` 已推送 `origin/main`。T07 代码、测试、真实验收证据与本文随本次提交归档；具体提交及远程状态以 Git 记录为准，未回写 Issue。新增 v30，仅在隔离 SQLite 执行迁移，日常服务未启动，生产新工作入场保持关闭。

T07 已交付不可变输入 manifest、ACL/附件/预算及序号空洞、三类独立游标、单条补投、权限/压缩/seal 与原生锚点、API/Claude SDK 专用适配器，以及逐实际 HTTP 的预算和可信 usage/传输/进程证据。合同见[上下文、Session 与后端 v1](../architecture/threaded-context-backends-v1.md)。

## 隔离验证

| 检查 | 结果与实际范围 |
| --- | --- |
| `pnpm verify:threaded-context` | 14 组；真实序列化 ACL/附件、递归来源撤权、预算空洞、冻结 wave、delivery/seen/mention_ack 分离、unknown 防重投、单调回执和晚到修复 |
| `pnpm verify:threaded-session-context` | 13 组；Session CAS、账号/权限/角色/工具/目录/版本边界、私密曝光、意外 nativeId、压缩/seal、旧 cutoff 冷开及原子输入意图 |
| `pnpm verify:threaded-backends` | 14 组；API 协议与工具循环逐请求结算、失败/截断未知、loopback SDK 隐藏请求串行、精确 usage、进程/锚点与证明快照；无外部模型调用 |
| `pnpm verify:threaded-backend-runtime` | 7 组；组合工厂从 Wake 到响应，实际 payload/hash、可信回执/预算/释放、超限停驻、传输 unknown 围栏、终态后游标修复及发送前 token 门禁 |
| `pnpm verify:threaded-migration` | 13 组；实际冻结 `79bad41` v29 的消息/预算/队列事实升级 v30，DDL 故障回滚、重复升级和旧 worker 拒写；v25–v29 源码不变 |
| 运行时/预算/队列/生命周期回归 | runtime 18、budget 14、queue 11、lifecycle 21 组通过；保留不丢唤醒、unknown、控制、响应原子终态及同根累计预算 |
| 权限/隔离/资源回归 | access、controls、isolation、legacy-boundary、resource-integration 及 legacy-resources 11 组通过；生产无 executor、关闭入场，旧模式边界保留 |
| 类型与文档 | `pnpm typecheck`、文档链接及差异空白检查通过；K01–K16 和原 59 项场景/预期原文保留 |

确定性测试只使用临时库、合成内容与注入证据；loopback 协议测试的进程退出正例为显式注入，不能作为真实宿主退出验收。真实后端证据单列如下。

## 真实后端

用户授权使用已配置账号，输入+输出总上限 10,000,000 tokens。本轮执行额外设置跨运行持久累计的 200,000 token 门禁，每次实际 HTTP 前按完整请求字节、输出上限及额外余量预留，已知 usage 才结算，取消/未知保留占额。所有内容均为新造验收消息；日常业务库只读所选账号元数据与加密凭据，不读日常 Conversation/Message，不迁移、不写业务库。临时凭据加载库与执行库分开，执行库没有加密凭据行；真实密钥仅用于供应商认证头。

实际组合：macOS、Node v22.23.1、Claude SDK 0.3.288；已配置账号 `Claude-GML-5.3`，model `glm-5.3`，端点 `open.bigmodel.cn` 的 Anthropic 兼容协议。同一个账号分别验证 API 与 SDK，不代表全部配置账号/供应商已验收。

| 运行与证据 | 通过内容 | 实际 HTTP | 本次已知 tokens | 本次未知预留 |
| --- | --- | ---: | ---: | ---: |
| [API](evidence/threaded-t07-real-api.json) | 两次独立上下文重建保留随机记忆标记；其他成员私密消息未进入任何实际输入 | 2 | 688 | 0 |
| [SDK 首轮](evidence/threaded-t07-real-sdk.json) | 冷开、同 nativeId 续接及记忆校验、权限变化新 nativeId 冷开；实际发送后取消并保留 unknown | 4 | 6,441 | 19,505 |
| [SDK 重开补验](evidence/threaded-t07-real-sdk-reopen.json) | 关闭旧 SQLite/runtime，使用新资源 owner 重建，恢复持久锚点并以同 nativeId 续接；recover 零请求；再次验证权限冷开和取消 unknown | 4 | 6,431 | 19,505 |
| 累计 | 已知消耗与未知占额分别登记 | **10** | **13,560** | **39,010** |

累计保守占额 **52,570 tokens**，低于本轮 200,000 和用户授权 10,000,000 上限。各 JSON 的 `knownTokensThisRun`/`unresolvedReservedTokensThisRun` 为本次量，`knownTokens`/`unresolvedReservedTokens` 为持久门禁累计量，不能再次相加。金额不因 tokens 已知而推断；未配置可信价目的费用仍未知。

真实完成的 SDK worker 所属进程组均验证 `verified_stopped`，三个完成 Invocation 留下三个精确输入锚点，权限边界产生两个 nativeId。取消是在真实响应头到达后触发，本地进程退出不足以证明远端请求停止；Invocation/资源/请求保留 unknown，重复恢复与再次领取没有重放。两个隔离 unknown 事实和占额没有被 TTL 或异常 cleanup 清除。

[实际输入审计](evidence/threaded-t07-real-input-audit.json)另外检查 canonical payload hash 与完成请求回执一致、执行库不含凭据、API 私密源始终不进入输入、SDK 原生锚点及权限边界身份数。证据不保存密钥、认证头或模型正文。

可复现入口需显式 `--authorized-real --backend api|claude-sdk --account <已配置账号 ID>`，并指定共享的 `--token-ledger` 和 `--token-limit`，例如 `pnpm threaded:acceptance-real --authorized-real --backend api --account <ID> --token-limit 200000 --token-ledger /tmp/t07-token-ledger.sqlite --report /tmp/t07-api.json`。重复真实测试必须复用同一账本或重新明确累计预算，不得靠新临时库重置限额。默认 fixture 验证无需账号或联网。

## 范围与后续

重开补验发生在同一个验收进程内，关闭并重建 SQLite、runtime 和资源协调器；每次 Invocation 使用独立 SDK worker。它证明持久事实恢复与原生续接，不是主服务完整进程退出/启动验收。T06 的真实 IPC 崩溃 fixture 继续作为生命周期回归，完整业务宿主演练仍归 T12。SDK 自动压缩没有在真实短会话中触发，压缩事件/摘要来源/seal 仅有确定性证据。

本次不扩展为 OpenAI 协议、Anthropic 官方端点、其他原生驱动、Linux、WSL 或 Windows 的真实通过。CTX02 的面向模型精确读取/搜索工具、应用路由/工具、等待和 E01–E06 持久征询仍由 T08 验收；UI、Action、SOP/共享知识及真实业务闭环归 T09–T12。不能将上述子场景等同全部 59 项通过。

交叉审阅和故障验证补齐了原生记忆包含未来序号时冷开、多个真实 HTTP 对同一输入的单调回执、完整 HTTP 输入上限、持久回执修复游标、当前账号/配置与实际 Session 的身份核验。另增压缩后再次续接而无新压缩的连续性用例、锚点写失败仍保留已知静止并让下次冷开、新旧 API 共用供应商容量的用例。最后三项为隔离回归，没有追加真实模型调用。新增上下文阻塞不会发模型请求或通过重试耗尽资源。

下一项 T08：在当前专用执行端口接入路由、协作工具、非阻塞等待与持久征询，继续单独验证新增可靠性能力。生产 `dispatchEnabled=false` 且未安装 executor；`closed|observe|execute` 均不能开放当前新工作。
