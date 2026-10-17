# 独立协作支持矩阵与产品契约（G6）

日期：2026-10-17。数据库 schema 17；Scope boundary 2、manifest/provenance 1、Tool API 与控制动作 v3。本文说明当前开放组合，原生后端剩余门槛见 [G5 进展](../reports/scoped-collaboration-g5-progress-2026-10-16.md)。

## 支持矩阵

| 组合 | 当前产品状态 | 证据与边界 |
|---|---|---|
| 模型 API 独立材料 | 可执行；受服务准入开关限制 | 1–6 项、最多两批、每批最多三人；投递、ACK、实质结果各有独立判定；只回传获准编号与固定状态 |
| 模型 API 单批只读 any | 可执行 | 首个通过验收的结果胜出；其他项停止，已发出的调用仍可能计费；不开放写入或多批 any |
| 模型 API 私密汇总 | 可执行 | Owner 明确选择 1–6 份已完成报告，预览确切副本；汇总建立新 Run 和新预算，不改原报告权限 |
| 确切文字/固定状态发布 | 可执行 | 先批准、后发布；单次消费；正文、来源、输入账本、草稿或成员变化使旧批准失效；普通聊天不能代替授权 |
| Coordination 静态模型 API 步骤 | 有限支持 | 新冻结的 `coordinationScopes=1`、execute、R7 只读无工具/文件步骤；保留依赖图和 Owner 阶段门禁；已完成结果可进入相同汇总与发布界面 |
| 新版原生静态 Coordination | 可执行；`coordinationScopes=2` | 托管 SDK 与模型 API 的文件 DAG；仅本次上传/获准依赖的受控文件；保留 Owner 文件验收和 G3 结果选择 |
| 历史 Coordination、非新 Scope 工具/文件、检查点续跑 | 保留原冻结契约 | 不宣称新 Scope 能力，不自动补造来源或升级旧 Run；没有新 Scope 账本的结果不列入汇总来源目录 |
| Claude SDK | 托管 API Key 组合可执行 | 独立材料、私密汇总、Owner 批准发布及受控文件 Coordination 已接入；真实账户证据限于所选组合，见[接入收尾](../reports/scoped-collaboration-native-integration-2026-10-17.md) |
| Codex app-server | 实现与协议夹具已接入；默认关闭，真实补验暂缓 | 本机 all/any、发布和恢复已通过；真实账户部分通过，nim 补验建立会话后遇到模型列表网络超时；用户要求先跳过，历史失败和 unknown 保留；见 [nim 验收](../reports/scoped-collaboration-nim-codex-acceptance-2026-10-17.md) |
| 只读 CLI | 不支持独立 Scope 能力包 | 可用的旧执行方式保持各自规则，不能用于新独立材料/汇总任务 |
| 任意文本自动披露、动态委托、文件/附件发布 | 不支持 | 预览拒绝；不能从自由文本、模型自报来源或自然语言“全部授权”获得权限 |

`foundationImplemented`、`implementationSupported`、`configuredAvailable`、`connectionVerified` 分别代表隔离基础、完整能力实现、当前后端准入配置和真实连接证据。G6 没有供应商实测，`connectionVerified` 不被改为 true。账户页连接通过也不会解锁被配置关闭的能力包。SDK 仅接受显式绑定的兼容托管 API Key 账户，Claude 原生登录与历史环境变量认证未开放。

## 统一交互

普通输入区提供“本轮如何协作”入口；权限拒绝卡可直接准备独立材料。公开目标可预填，私密输入/引用/附件/历史结果不自动复制；原任务记录和权限保留。

从聊天室任务区进入“独立材料协作”，先查看支持范围和入口状态。逐项填写接收者、批次、交付要求及文字材料，预览后确认。改变输入会使预览失效；有效期、预算与范围均在预览中展示。

“私密汇总与发布”的来源目录统一列出已完成独立材料和具有新 Scope 的阶段编排结果。目录仅包含任务标识、目标、事项编号与作者，不自动加载正文；确切读取内容在授权预览中展示。组织者只收到状态，汇总者只读取 Owner 选定的结果。

私密草稿经过编辑、预览、批准、发布后生成独立消息。固定状态投影只输出服务端核验过的 `{key,state}`，不调用模型，也不把报告文字当作状态摘要。发布后原报告保持原 ACL。

提交和批准沿用固定 clientKey；响应丢失后重试返回同一结果。发布按 grant 单次消费。断网时显示重连状态；恢复与刷新读取服务端事实，不重建任务或重放模型请求。私密表单不进入浏览器持久存储。抽屉在提交期间不会因原生 Escape 默认行为与 React 状态脱节。

## 接口与准入

新增只读管理接口，均要求管理会话并发送 `Cache-Control: no-store`：

- `GET /api/accounts/scoped-delivery/capabilities`：当前准入状态、限制及后端支持矩阵。
- `GET /api/accounts/information-releases/rooms/:roomId/sources`：当前聊天室中可选择的完成结果，不含报告正文。

`SCOPED_COLLABORATION_MODE=closed|preview|execute` 默认为 execute，保留此前部署行为；同时服从更严格的全局 `ORCHESTRATION_ENTRY_MODE` 和后端开关。`SCOPED_NATIVE_DRIVERS` 默认 `claude-sdk`，空值关闭原生新准入；即使显式列出 Codex，也不代表完成其真实账户验收。preview 允许生成预览，禁止确认新 Run；closed 拒绝新独立材料/汇总任务，新 Coordination 也不冻结新 Scope 特性。

开关不重写已有契约。已提交确认的幂等重试、既有 Scope 的排空、历史查看、专用批准和单次发布仍可由兼容 worker 处理。关闭不是取消，也不会清除未知用量。具体操作见[运维手册](../operations/scoped-collaboration-runbook.md)。

## 生效契约

基础边界沿用 [G2 控制契约](scoped-collaboration-control-v1.md)、[G3 发布契约](scoped-information-release-v1.md)、[G4 恢复契约](scoped-collaboration-recovery-v1.md)；Coordination 与原生基础沿用 [G5 契约](scoped-native-coordination-v1.md)。本阶段不追加迁移、不改历史消息权限、不自动迁移旧私密 Run，不自动关闭 GitHub Issue #15。
