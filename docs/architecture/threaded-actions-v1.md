# 持续协作 Action 与领域合同 v1

T10，2026-10-21。基于已推送 T09 `72efefd`，追加 schema v32。生产入场及 executor 继续关闭；本合同不授予 GitHub 发布权限。

## 身份、准入与代际

`threaded_actions` 按 instance Owner、canonical subject、family、注册 successor slot 唯一；home Thread、causal root 不可变。首批 subject 为平台任务 ID 和小写 `repository + PR number`，合法组合仅 `work/primary/task_done`、`review/review/review_delivered`，不能随意新建 slot 绕过唯一性。已有相同业务身份返回 safe_wait 和原责任引用，明确 admitted=false，不产生第二次获权或新根预算。Action 与 Invocation/Run 分开，普通 A2A、文本 done、队列清空或响应结束不会创建或完成责任。

每一代冻结 subject、predicate、freshness、standing、holders、parallelIntent、前驱身份/路由、来源 ACL 和原根；历史不可改写或删除。主体投影按 version/generation CAS 更新，holder 结果只能从未决变为终态。完成候选引用服务器产生的 typed evidence，解析器重新读取领域真值后才提交责任结果。

默认单 successor；多 holder 评审需要显式 parallelIntent，逐成员记录结果，全部成功才完成。失败/取消/不可用/拒绝接手不等于完成；所有 holder 终结但存在失败时转 replaceable。活跃责任不能被直接替换：普通 replace 需要 replaceable 事实及冻结前驱 standing；返回后的重新派发需要准确 incoming generation 的已投递返回凭证。自报成功不能充当上述凭证。

单 holder 的 return 只投递给冻结前驱，保留原 predicate/freshness 和 parallelIntent。PR 作者可以接回拒绝责任，但不能因此获得独立评审资格。并行 holder 中单个拒绝只终结自己，不能撤走其他成员。该细节复核自固定上游 [return 状态机](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/action-successor-return-state-machine.ts)与[replacement 状态机](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/ball-custody/action-successor-replacement-state-machine.ts)。

转交、普通持久 agent_post、Message/Wake/Outbox 与工具回执在同一事务中提交。普通派发保留 A2A 的深度计数及同根预算，允许持有人继续使用普通 Decision。领域/等待回调在投递时重验身份、来源、控制与 generation；消息进入新 Invocation 前再次核验。普通 A2A 可向非 holder 求助，但该接收者不会取得 Action standing。所有回调继承原 causal root，不创建新的预算根。旧代际终态可留审计，不能完成新责任。

## 平台任务 producer / resolver

`create_task` 创建真实 `tasks` 行和 Threaded ownership，不复制为另一个模拟任务域。验收条件及创建来源ACL在创建时冻结；领域工具读取登记独立 privacySourceIds/Session exposure，后续交付不能放宽这些来源。`transfer_action` 需任务创建者/合法 assignee standing；平台任务沿用单 assignee，分工需要多个独立任务。`read_action` 返回当前 task version，供合法 holder 提交。

`complete_task` 校验当前 Invocation/Attempt Binding、Action dispatch/generation、assignee、任务状态和 version、criteria hash，以及每条冻结验收条件对应的当前调用已发布来源消息；持久记录合法 `in_progress → completed` 转换及 typed evidence。它不会依靠模型传入 status 判定完成，也不声称自动证明任意自然语言验收条件的客观正确性。

`complete_action` 的 task_done resolver 读取真实 tasks 状态和精确 transition/version/generation。producer 已提交而候选/投影尚未提交时，恢复器从同一领域转换、actor identity 和仍可读的验收来源补齐候选、结果和唯一通知，不重新执行模型。

旧 task 服务列表/单条/生命周期不接管 ownership 中的任务，旧 HTTP 派生读取先查旧 task 可见性。SQLite trigger 还要求精确版本写入许可，阻止直接旧 UPDATE 修改被绑定任务；facade 事务内插入并移除许可。旧普通任务的行为保留。历史 v25–v31 源码与 descriptor 不变。

## GitHub PR producer / resolver / freshness

服务器安装 `ActionPrSource`，冻结 repository allowlist、账号映射和 mayAssign 权限。模型只能提供业务 subject，不能提供 URL、token 或身份映射。标准 `githubActionSource` 只访问官方 REST GET，禁用重定向和缓存回退；缺凭据、不可达、身份变化、未知 HEAD 明确不可核验。异步 IO 在 SQLite 事务外，回来后重验 Binding、权限指纹和 generation；prepared fact 最长 30 秒，完成请求每次重新读取 live HEAD。

`publish_action_review` 由当前独立 reviewer 发布到当前 Thread，绑定 reviewedHeadSha、verdict、findings、reviewer、published Message 和 acceptedSource=`thread`，服务器颁发 evidence ID。它不调用 GitHub 评论/review 写接口。`multi_mention` 的 schema 不接受 Action metadata，专用评审责任不通过征询捷径执行。

review_delivered resolver 必须再次读取当前 HEAD，并核对本地合法发布事实和认证 reviewer。`changes_requested` 可以结束评审交付责任；`approvalGateSatisfied` 始终 false，T11 的 Review/Revision 与批准门禁另行消费领域结果。已有 approved 报告不能匹配不同 HEAD；完成后的新版本必须显式 revision，活跃旧责任则按失败/返回/合法替换处理。作者自报修改完成不能覆盖独立结论。

UI 使用只读真实投影；PR freshness 标记有 30 秒展示有效期，过期显示不可核验，不能用展示缓存做完成判定。已配置 provider 的恢复轮询更新 fresh/stale/unverifiable。没有安装真实 provider 的生产实例不激活 PR 完成能力。

## 命令、等待与恢复

`run_command/wait_command/cancel_command` 仅接服务器显式注册的 `ActionCommandPort`。注册端口负责具体执行器的权限、资源、副作用与可对账 evidence；不提供模型任意 shell 或 URL 执行入口。默认没有命令端口。

命令冻结启动时的来源边界，后续等待与结果交付继续取权限交集。命令在外部 IO 前持久为 unknown，并用 commandId 作为幂等身份；崩溃恢复只 observe，绝不再次 start。取消未证实外部结束则保留 unknown。等待独立保存、非阻塞、代际绑定；替换/返回责任不会暗中取消外部命令。旧代际完成仅进入原命令审计，不能回调新 holder。撤权后不以旧端口结果授予新事实；旧外部命令的人工对账/终止需要执行器自身的获权管理入口，T10 不默认安装 OS 命令管理器。

生产没有新增执行器、账号或入场开关。运行时/SQLite 重建恢复由持久记录驱动；schema 不认识 v32 的旧 worker 在写入前拒绝。

## 显式适配与范围

| 差异/能力 | 本批边界 |
| --- | --- |
| 存储与责任 ID | SQLite IMMEDIATE/CAS 和独立 generation 历史，替代上游 Redis lease；不是超时抢占 |
| 结构化工具 | `transfer_action` 与专用本地评审交付工具，替代上游 callback payload 命名；均保留幂等、standing、代际、受众和真实领域验证 |
| 任务 | 接真实平台 tasks；单 assignee，批量工作拆任务；未开放旧任务自动转为 Threaded |
| PR | 获权官方 GET + 本地 Thread 交付，不默认发布 GitHub 评论/review |
| 批次 | 首批固定两个 predicate/slot；其他 subject/predicate、深层 delegate lineage、跨租户/多机不注册为已支持 |
| Review/Revision | T10 提供 frozen HEAD、交付事实、fresh revision 和责任机制；完整 findings 修订流、批准门禁、SOP/知识仍属 T11 |
| 命令 | 已注册端口的等待/取消与代际隔离；具体 OS 执行器及平台组合另行验收 |
| 验收 | 平台域、注入传输竞态、真实 GitHub GET、真实模型、实际服务进程故障分别记证，不能合并为全产品通过 |
