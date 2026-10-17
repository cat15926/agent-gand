# 自主结果收集与交付 v1（AC3）

状态：2026-10-18，模型 API 适用实现，schema 20。关联[实施计划](../plans/agent-autonomous-collaboration-implementation-plan.md)、[AC2 动态委派](./autonomous-dynamic-delegation-v1.md)、[验收报告](../reports/autonomous-collaboration-ac3-acceptance-2026-10-18.md)。普通入口仍属 AC4，默认 closed；原生自主工具、游戏协议及上线组合验收留在后续阶段。

## 显式新根与兼容

受信服务调用 `admitAutonomousCollaboration(runId, draft, {deliveryVersion:1})`，冻结 `delegationVersion=1` 与 `deliveryVersion=1`，并要求 `AUTONOMOUS_COLLABORATION_MODE=execute`。AC2 不传第三参数，语义不变；旧 AC1/AC2 根不能升级，v2/v3 不解释为自主任务。模型不能传 Run、Grant、Scope、Attempt、账本或批准者身份。当前只支持 `builtin-llm`，没有新增普通聊天 HTTP 准入。

所有分支、汇总及续跑共用一个 Run 和 Token/费用账本。工作状态仍取 Subject/Custody、Dispatch/Attempt 与 Completion Engine，新增表只登记不可变来源、意图与效果事实。

## 实际工具

| 工具 | 运行行为 |
|---|---|
| `agent.aggregate` | 用当前父责任内已完成子工作的 key 选择结果，指定有权成员和独立目标，创建新的内容 Subject/Scope；允许选择自己 |
| `agent.emit` | `update` 是合法阶段更新，`final` 是最终交付候选；三种格式为 `text`、`result_bundle`、`task_status_v1` |
| `agent.request_user` | 合并 1–6 项实际缺失的业务信息，注明所阻塞的工作；持久等待后恢复同一责任 |
| `agent.complete` | 保留 AC2 候选验收；子义务、来源、工具和已知用量满足条件后才接受 |

已有 `agent.delegate`、受控文件和冷上下文继续生效。AC3 委派的默认结果范围由父任务、实际 Scope、所选输入 ACL 及 reader 上限共同收窄，允许合法任务成员接收结果；AC2 的默认结果范围保持原样。

## 已验收结果与来源封存

完成事务在候选 accepted、贡献消息和 Attempt 完成的同时封存：工作、Grant、Attempt、Candidate、确切贡献消息、该 Attempt 的受控文件版本，以及实际 Scope/Manifest/输入账本指纹。不是把一句模型摘要当作可信完成。

每次使用结果都核验 accepted Candidate、Evidence Bundle、消息/文件当前指纹、所有已读来源、根与祖先撤销，以及派生来源链。已完成结果的来源账本必须完全一致。交付计划可先于同一 Attempt 后续工具回执生成，其来源记录只允许保留完全相同的既有前缀，不允许修改或删除先前暴露。

结果及批准副本作为独立新 Scope 的白名单输入，实际读入时记录 provenance。汇总不会修改原 Scope、原始材料 ACL 或原 Grant。汇总结果仅在当前组织者本来有权读取时进入其冷续跑上下文；无权组织者仍只收到固定状态。

## 三条自动交付路径

1. 普通合法来源：成员独立完成 → 有权成员在新 Scope 汇总 → 组织者合法续跑 → 最终验收和一次交付。内部步骤没有逐项预览确认。
2. 互相私密的结果：服务端按确切结果版本直接组成报告，范围取任务交付范围与全部来源的交集；必要时只对 Owner 可见。组织者没有接触这些正文，不需要虚构统一摘要或要求用户搬运。
3. 需要扩大权限：先准备确切内容、来源版本和接收范围，再出现一个必要决策。拒绝后继续处理合法选项；重试同一语义意图即使换 commandKey，也不重复请求批准。

没有显式 final 候选时，根 accepted 后自动交付根总结、全部已验收直接子工作及受控文件引用；不额外请求模型。最终消息与唯一 Run 终局在同一事务提交，终局记录引用实际交付消息，不另发一份报告。失败、未完成、来源变化或 unknown 用量不能提交最终报告。update 可提前发布；final 只在完整验收后发布。

受控文件交付包含路径、版本、SHA-256 和精确版本下载引用。网页通过 Owner 管理会话获取受控内容并下载，不直接显示 JSON，也不会把文件改成公开。

## 结构化输出

`text` 受该 Attempt 所有实际暴露来源限制，不能用“摘要无敏感内容”代替权限判断。

`result_bundle` 由服务端直接从封存结果组装，模型只得到状态回执；不会把无权正文作为工具返回。文件引用也参与来源权限交集。

`task_status_v1` 仅包含版本、固定 profile、总工作数和各固定状态计数；不包含目标、key、错误、任意模型文字或自定义字段。它仍受根消息范围约束，不是一条通用脱密通道，也不实现狼人杀投票协议。

## 必要决策与回答后的续跑

权限决策使用管理会话认证、Origin/Host 校验、CSRF 及 no-store 的账户路由：

- `GET /api/accounts/autonomous-collaboration/decisions/:id`：Owner 读取待批准的确切正文、范围、原因及指纹。
- `POST .../:id/resolve`：只接受 `action:approve|deny` 和该指纹，不接受修改正文、目标或代理 Owner 身份。

新增读取者批准只复制对应已验收结果的确切消息/文件版本，登记原来源及批准记录，新副本 ACL 为这次确切授权范围。原始输入和原结果权限不变，后续汇总实际读取副本；副本来源变化同样使使用失败。发布批准只适用于确切计划的文字、来源版本和接收范围，不授予后续自由发布权限。

业务问题复用聊天室问题卡，通过普通回答解决业务缺失；普通回答不能批准权限。模型工具没有任何 approve 操作。源 Scope、账本、房间成员版本、撤销、期限、停止状态和等待代际在 Owner 决策时再次检查；过期决策没有副作用。

提问/授权会结束当前 Attempt，释放成员资源。同一阻塞按语义指纹复用；单 Run 至多 6 条必要决策，并为未来续跑预留 Dispatch。其他可独立执行分支继续，所有分支都停止可运行工作后才将 Run 标为 waiting_for_user。答案/批准、唯一代际唤醒、同 Subject 续跑都有持久记录；重启不会重新执行已验收工作或重复发布。

## 存储与部署

迁移 20 追加八张禁止更新/删除的事实表：`autonomous_results`、`autonomous_aggregate_sources`、`autonomous_emission_plans`、`autonomous_emission_records`、`autonomous_decision_proposals`、`autonomous_decision_resolutions`、`autonomous_intake_copies`、`autonomous_tool_receipts`。此前迁移描述符和历史行保持原含义。

实际 v19 worker 拒绝 schema20。部署前备份并排空旧 worker，使用匹配版本源码启动；回退恢复配套备份，不能删除迁移号伪装兼容。阶段验收仅使用临时数据库和模拟 Provider，日常业务库没有迁移。
