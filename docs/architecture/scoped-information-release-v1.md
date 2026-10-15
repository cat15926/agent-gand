# 私密汇总与授权发布 v1（G3）

状态：已实现，2026-10-15，迁移 v15。基于 [G2 独立材料契约](scoped-collaboration-control-v1.md)；对应[实施指导](../plans/scoped-collaboration-implementation-guide.md)与[G3 验收报告](../reports/scoped-collaboration-g3-acceptance-2026-10-15.md)。

## 1. 支持范围与交互

在聊天室“独立材料协作”抽屉中打开“私密汇总与发布”：

1. 选择已完成的 G2 任务及其中 1–6 份 result 报告，选择一个模型 API 汇总者，填写汇总要求与输出预算。
2. 预览将授予汇总者读取的确切报告，确认后创建独立汇总任务。原报告不改权限；只有获准副本进入新任务。
3. 汇总者在独立 content Scope 内生成私密草稿，通过 `agent.request_release(summary)` 提交。控制 Scope 只接收固定状态，随后进入专用发布等待。
4. Owner 可编辑草稿，保存新版本会使旧批准失效。选择确切文字或固定状态投影，以及指定成员/房间公开范围。
5. 预览完整待发布文字和接收范围，批准此版本。批准不立即发布，尚未消费的授权可以撤销。
6. 点击“发布已批准内容”，消费一次授权并创建新消息。发布事实驱动唯一恢复，控制任务核对完成状态后结束。

草稿、来源版本、批准、撤销和发布事实由服务端保存，刷新后可继续查看；未保存的表单不进入浏览器持久存储。已发布卡持续展示实际接收范围，关闭的表单不显示空白默认范围。原报告和完整审计始终保留原权限。

这里的新汇总任务是 Owner 确认的新工作，具备独立 Subject 和明确的新预算；不修改已完成 G2 Run 的冻结契约，也不是自动跨 Run 失败恢复。新任务继承当前房间费用政策，并在读取授权预览中显示。组织、汇总和最终恢复共用新 Run 的 Token/费用账本；预览、批准、撤销和消息发布不调用模型。

## 2. 冻结契约与范围

G3 Run 必须声明 `scopedCollaboration.releaseVersion=1`、`deliveryVersion=1`、`capabilityPackage=scoped-release-v1`，继续使用 v3 Tool API/Control Action、Scope、manifest、provenance 及既有责任引擎。缺少确认后的 workflow 或投递计划时不可执行。G2 Run 不自动获得 G3 工具。

汇总读取授权绑定源 Run、结果 key、消息版本/哈希、源 Attempt 的完整输入账本摘要和引用、汇总者、要求、房间成员及账户/角色快照。服务端在确认及模型执行前后复核来源；授权副本与新 Run 的唯一 `aggregate` 信封绑定，旧来源权限保持冻结。仅所选报告正文进入汇总上下文，原始报告生成时的其他输入仅进入授权审计与漂移核验，不自动一并暴露给汇总者。

同一个角色可担任组织者和汇总者，但其 control/content Attempt 使用不同 Scope、manifest 和冷上下文。汇总草稿不会进入父级状态投影；控制恢复不读取草稿或模型生成的下一步建议。

首版仅支持文字：所选报告与汇总要求合计最多 12000 字符，草稿最多 24000 字符；无附件、文件读取、任意工具、原生会话或原生后端执行。发布接收者可以是房间内成员，接收消息本身不自动启动其模型。

## 3. 发布策略、批准与事实

| 对象 | 已实现语义 |
|---|---|
| Policy | 当前输出快照、来源选择、草稿版本、完整输入摘要、固定接收范围、有效期、最多一次、撤销版本 |
| Grant | Owner 专用确认签发；绑定 preview 指纹、完整文字、目标、Policy 版本、输入账本和提交编号 |
| Record | 已提交的新消息、消费的 Grant、Policy 版本、输出字节、目标、输入摘要及命令关联；不可变 |

两个发布方式分别为：

- `exact_content`：精确绑定预览中显示的整段文字，无额外附件或模型生成元数据。Owner 修订后的版本也覆盖全部原始受限输入，而非仅凭文案声明脱密。
- `deterministic_projection`：固定注册版本 `status-receipts-v1`，只输出已选报告的 `{key,state}` JSON。来源必须是已完成 G2 任务，选择规则和接收范围冻结，不接受表达式、模板代码、网络请求或模型判断。

此版投影是当前不可变快照的一次发布，不提供未来未知内容的循环预授权、自然语言自动脱密或任意游戏规则解释器。两种方式都需要专用 Owner 批准。

预览最多有效 15 分钟；发布预览还受当前 Run 截止时间限制，取较早者。确认 API 不接受替换正文、目标或来源。编辑草稿、改变房间成员、改变任何原始输入/ACL/消息版本、追加汇总输入账本，均阻断旧批准。相同确认请求返回原授权，不重复创建任务或 Grant。

撤销递增 Policy 版本，阻断未来消费。撤销不收回已阅读信息，也不删除或改写发布事实。每个汇总任务最多一条 ReleaseRecord；多个有效 Grant 竞争时只有一个可发布。

## 4. 事务与持久等待

发布在现有 SQLite `BEGIN IMMEDIATE` 事务内重新检查 Run 活跃状态、截止时间、恢复核对标记、根 Subject/Custody、草稿/输入、Policy 版本与期限、目标成员和单次消费。Grant CAS 消费、新消息、ReleaseRecord 和专用唤醒事件一并提交；消息事件沿用 afterCommit。任何失败都回滚，不出现消费成功但消息未创建的半提交。

专用 Hold 使用注册接收器 `information-release-v1`，与 Run/correlation/generation 绑定；普通用户回答和普通决策均不产生发布授权。沿用 Runtime Hold/Action Command、claim 租约和唯一 resume Dispatch。新增的服务端 `releaseWake` 仅接受已有发布事实及对应 claimed Hold，不为模型开放。

若 Stop 先提交，发布或迟到模型草稿会被拒绝；若发布先提交，既有事实保留。发布后的控制恢复仍受预算/时限检查，恢复失败不能被解释为发布撤回。G4 负责后续更完整的跨进程发布竞争和崩溃注入矩阵。

## 5. API

所有路由位于现有 accounts 管理边界，复用 Owner 会话、CSRF、Host/Origin、no-store 和敏感错误日志控制。

| 方法与路由 | 功能 |
|---|---|
| `POST /api/accounts/information-releases/aggregate/preview` | 读取授权预览 |
| `POST /api/accounts/information-releases/aggregate/confirm` | 确认副本授权并创建独立汇总 Run |
| `GET /api/accounts/information-releases/rooms/:roomId` | 最近 20 个汇总工作流 |
| `GET /api/accounts/information-releases/runs/:runId` | Owner 查看草稿、来源版本、策略、授权和事实 |
| `PATCH /api/accounts/information-releases/runs/:runId/draft` | expectedRevision 校验后新增草稿版本 |
| `POST /api/accounts/information-releases/runs/:runId/preview` | 冻结完整输出与目标 |
| `POST /api/accounts/information-releases/confirm` | 批准 previewId/fingerprint/clientKey |
| `POST /api/accounts/information-releases/grants/:id/publish` | 单次消费并发布；重复请求返回原事实 |
| `POST /api/accounts/information-release-policies/:id/revoke` | 撤销尚未消费的发布权限 |

领域错误返回 code、retryable=false、allowedRecovery 与 diagnosticRef；常见错误包括 RELEASE_STALE、RELEASE_REVOKED、RELEASE_EXPIRED、RELEASE_ALREADY_CONSUMED、RELEASE_STOPPED。错误不附带私密模型正文。

## 6. 存储与兼容

v15 新增 `information_release_previews/workflows/drafts/policies/grants/records`。预览使用既有主密钥加密，并纳入主密钥缺失保护；workflow、草稿版本及发布事实通过触发器禁止更新和删除。授权状态依靠事务 CAS，ReleaseRecord 对 Grant、Run 和消息具有唯一约束。

草稿正文及授权记录是受管理接口保护的数据库内容，未声明端到端加密；消息继续使用既有 ACL。旧 v2 和 G2 契约保持原行为，历史故障任务不迁移。能力接口区分实现支持、配置可用和真实连接验证；模型 API 的 G3 已实现，真实连接仍未验证，SDK/Codex/CLI 仍关闭。
