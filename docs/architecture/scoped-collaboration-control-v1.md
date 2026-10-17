# 独立材料协作契约 v1（G2）

状态：已实现，2026-10-14；数据库迁移 v14。对应[实施指导](../plans/scoped-collaboration-implementation-guide.md)与[G2 验收报告](../reports/scoped-collaboration-g2-acceptance-2026-10-14.md)。

G3 已在独立 Owner 授权入口开放文字汇总与发布，详见[发布契约](scoped-information-release-v1.md)。G5 现已开放托管 API Key 的 SDK 组织者/接收者，默认关闭 Codex 新 Scope；当前配置及真实验证范围见[支持矩阵](scoped-collaboration-support-v1.md)。下文记录 G2 基线；G4 新增单批只读 any 和 Attempt 恢复，差异以[恢复契约](scoped-collaboration-recovery-v1.md)为准。

## 1. 产品入口与适用范围

在已有聊天室的任务输入区打开“独立材料协作”。Owner 选择模型 API 组织者，填写目标、逐项文字材料、接收者、批次及交付要求，预览后确认执行。在同一面板查看逐项状态、私密结果和预算，也可停止任务。刷新保留服务端运行记录，未提交的私密表单不写浏览器持久存储。

首版支持 1–6 项、1–2 个顺序批次，每批最多 `min(3, collaboration.maxTargets)` 项；同批接收者不能重复，同一角色可在不同批次处理独立事项。只能选择当前房间启用的模型 API 成员，账户配置在预览时验证，确认后使用 Run 冻结快照。

| 交付要求 | 完成条件 |
|---|---|
| 仅投递（material） | 服务端将已授权材料装入独立执行上下文；不调用该接收者模型 |
| 确认收到（acknowledged） | 模型显式调用 `agent.acknowledge` 并提供正确的 envelopeId |
| 提交结果（result） | 模型通过 `agent.complete` 提交实质结果；简单 ACK 不满足该义务 |

仅处理表单文字及冻结角色定义，不读取房间历史、文件、平台工具结果或原生会话。不支持任意动态计划、`any`、正文汇总与扩大披露、SDK/CLI、跨 Run 后继。子项失败使后续批次停止。

## 2. 预览、确认与版本边界

管理接口复用现有管理会话、CSRF、Host/Origin 检查：

| 方法与路由 | 用途 |
|---|---|
| `POST /api/accounts/scoped-delivery/preview` | 验证材料计划并生成 15 分钟有效的预览 |
| `POST /api/accounts/scoped-delivery/confirm` | 用 previewId、fingerprint、clientKey 确认一次投递 |
| `GET /api/accounts/scoped-delivery/runs/:runId` | Owner 查看状态、逐项私密结果及预算 |
| `GET /api/accounts/scoped-delivery/rooms/:roomId` | 读取房间最近 20 个独立材料任务 |

预览内容由既有主密钥封装；指纹覆盖草稿、成员版本、角色定义、关联账户版本、房间费用政策与批次/派发配置。编辑或相关版本变化后须重新预览。确认事务冻结 Run、计划、角色快照、来源、预算和首个 Dispatch；事务提交后才通知并唤起调度器。同预览、同 clientKey 返回原 Run，更换提交编号或复用到其他预览会冲突。

Run 必须同时声明 Tool API/Control Action v3、`boundaryVersion=2`、`scoped-control-v1`、`deliveryVersion=1`，且存在服务端确认的投递计划。G1 的基础 v3 契约仍不可执行。入口遵循现有 rollout：关闭时拒绝，preview 时仅预览，execute 时可确认。能力接口分别呈现实现支持、配置可用和连接验证；G2 未将真实连接标记为通过。

## 3. 调度与信息边界

沿用 Collaboration scheduler、Batch、Dispatch、Attempt、Subject/Custody、完成引擎和 Action Command。独立执行器使用 `providerForAgent`、`budgetedChat`、成员准入和账户授权检查；不经过会注入房间历史与文件名的普通回合装配器。

每个 Attempt 建立新 Scope 和 manifest，来源限于该事项、冻结角色定义与服务端指令，并登记 provenance。相同角色、相同 audience 不会复用其他事项的上下文。执行前及输出提交时重新验证权限、来源与代际。

组织者仅能提交与冻结批次完全相同的 `agent.consult_batch`，固定 `join=all`、`returnProfile=status-only-v1`。创建 Batch、逐项信封、子责任、义务与命令回执属于一个事务；任何一项来源失效都撤销整批。命令以幂等键及意图指纹绑定，改变意图不能重用原键。

子项结束后，服务端只读取完成状态并生成 `{key,state}`；state 限定为 delivered、acknowledged、completed、failed、cancelled。父级不接收子项正文、错误文本或模型生成的下一步建议。该投影通过绑定计划与批次的服务端 wake 命令创建唯一父恢复 Dispatch。根完成摘要同样为服务端固定文字。

v3 协议经严格解析后显式映射到责任引擎既有的内部 v2 动作联合类型，以复用义务和完成检查；不接受 v2 工具调用回退。所有项目的材料和结果按 Owner 与接收者的私密范围保存。内部角色、指令及状态投影保留审计记录，在普通消息展示中隐藏。ACL 不代表消息数据库已做端到端加密。

## 4. 预算、停止与恢复

所有批次和组织者调用共用 Run 的输出 Token 预留账本及既有费用预留账本。确认时冻结全局派发/Token/费用/时长限制、表单输出上限及房间请求超时；房间费用政策存在时一并冻结。预览和运行面板展示该政策与费用状态。

模型 API 的单次输出上限由 `COLLAB_SCOPED_MAX_TOKENS_PER_CALL` 配置，默认 12288；确认时以不超过该 Run 输出预算的值冻结在 `DeliveryPlan.maxTokensPerCall`，实际请求仍受剩余预留预算限制。该配置变化使尚未确认的预览失效；已确认计划不随服务配置改变。历史计划没有此字段时继续使用 4096，不回写旧计划。新计划缺省首响应和空闲时限各为 600 秒，显式房间限制优先。界面独立材料/私密汇总默认总预算分别为 48000/24000。

模型 API 不承诺供应商账单硬上限，因此 strict 费用模式在预览拒绝；要求未知价格停止时，所有实际调用成员必须有完整价格。未知用量保留占额并阻止自动重放。该版本不允许通过预算修订或跨 Run 后继修改冻结计划，需要重新预览新任务。

停止后旧 Attempt、迟到响应和父唤醒均受 Run 状态、授权、lease/代际及截止时间检查约束。初始提交后未派发、批次提交后未执行、子项结束后未唤醒的恢复使用现有调度器和唯一命令账本。G4 已补齐跨进程 SIGKILL、停止/发布/唤醒竞争和预算对账矩阵，见[恢复契约](scoped-collaboration-recovery-v1.md)。

## 5. 存储与兼容

v14 增加 `scoped_delivery_previews`、`scoped_delivery_plans`、`scoped_delivery_batches`、`scoped_delivery_envelopes`。后三类记录以数据库触发器禁止修改和删除；可变执行状态继续由原有表承担。加密预览也纳入主密钥缺失保护。

旧 v2 Run 保持原行为，不迁移或自动重新执行历史失败任务。升级后应运行支持 v14 的 worker，不能把旧二进制直接连回新库；回退需要单独评估备份之后的新数据。本阶段真实账户、多后端隔离、正文发布和完整狼人杀验收不在完成范围。
