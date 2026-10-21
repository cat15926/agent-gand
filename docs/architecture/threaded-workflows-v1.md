# 持续协作 Review、SOP 与基础知识 v1

T11 在已推送 `c944c9d` 的 T10 Action/真实领域接口上追加 v33。历史 v25–v32 源码及 descriptor 保持不变，生产入口和 executor 继续关闭。验收见 [T11 报告](../reports/threaded-collaboration-t11-workflows-2026-10-21.md)。

## 评审与修订

评审责任由 Action 管理，交付、结论、修订自述、独立复审和批准门禁分别持久化。普通讨论仍走普通 A2A，不强制创建评审工作流。

`review_context` 返回服务端冻结的 Action/generation、PR HEAD、确切接收消息及其不可变 seq、指定作者和 finding ID。`submit_review` 必须显式带上这些字段及 expectedVersion；服务器重读 live HEAD、独立 reviewer 身份和权限，校验当前 holder 与所有来源 ACL。在同一事务发布面向恰好一位不同作者的普通 A2A 报告、typed published_review evidence、稳定 finding ID 和不可变 workflow 版本。报告不混入 Action 派发/征询 metadata，也不把 reviewer 执行 standing 传给作者。作者从普通报告被唤醒，但不能据此完成 reviewer 的责任。`complete_action` 仍另行依据真实领域事实解析交付；changes_requested 可以完成交付，不能满足批准。

`start_review_revision` 只接受原站位与因果根下的新 live HEAD；必须唯一、逐项回应本轮全部未核验 finding。addressed 只记为 attested；disputed/deferred 仍未解决。服务器调用内部修订准入创建下一代责任，重置报告，并保留历史 HEAD、原报告和回复。只有独立 reviewer 对新版本显式引用 resolvedFindingIds，才能核验发现项。新轮次还需合法交付和完成责任。既有工作流及旧交付不能通过普通 transfer_action revision 或新HEAD replace 跳过回复要求；完成责任、失败后的replaceable责任或合法返回holder的修订都走带逐项回复的可信入口，模型不能调用内部修订端口。

v33 首次迁移冻结已有 review Action/generation 的兼容名单。`publish_action_review` 仅供该范围内尚未升级的旧责任交付，新 Action 首次调用也会拒绝。重建 SQLite/runtime 不扩大名单。当前 `verify:threaded-actions-github` 命令兼容转到完整T11只读验收；历史T10脚本及证据保留在 `c944c9d`，不覆写历史结果。旧 immutable evidence 的发现项从该Action全部历史代际采用，跨return仍保留原ID和HEAD，并被带入修订要求，采用历史与新轮次在同一事务提交；旧报告不因升级就成为完整 accepted-source 报告或批准。

`check_review_gate` 每次检查 live HEAD、当前 workflow/version/generation、合法完成候选、全部指定 reviewer 的结论/当前身份和授权、报告及接收来源 ACL，以及全部 finding 的独立核验状态。缺失或不可核验明确返回 blocked/stale/unverifiable。即使同 request key 重放也重新检查，不信任旧工具收据或 UI 快照。结果只表示本地独立评审政策，`externalApprovalGranted` 始终 false；不合并、不发布 GitHub 评论/review，也不替代 Owner 审批或外部受保护分支规则。

## SOP 告示与可信任务事实

`update_sop` 使用 expectedVersion CAS，记录不可变版本、stage、baton、checks 和累计来源。两成员或多进程更新同一版本只有一个成功。文字 stage/baton 不分配资源、交出 Action 或完成业务。

普通 check 只有 unknown/attested。机器可验项必须在更新时声明 `verificationRequirement:{kind:'task_done',taskId}`，服务器冻结具体任务及 criteriaHash。`verify_sop_check` 仅接受注册的 task_done verifier，重新读取该任务合法转换、版本、Action generation/holder、验收来源和 actor 当前身份；另一任务的合法 evidence、文本 done 或任意未知谓词不能核验该项。verified 只证明所列具体任务事实，不证明模型写的任意 check 标签或评审批准。替换 check 会清除旧核验；读取及旧收据重放也复算事实，失效降为 unknown，历史原文保持。

## 基础知识与来源边界

固定服务端 home collection，提供 knowledge_publish/read/search/recent/anchor/sources/mark 七个工具。模型不能指定 owner、任意 Thread、他人身份、私有 collection 或他人游标。所有入口及来源展开都检查当前授权；摘要、版本、替代元数据和后续输出继承全部直接及递归消息来源。Invocation anchor 只展开已发布平台消息和公开执行元数据，不读取原生私有 transcript。

知识拥有不可变版本、CAS 更新、自然或显式过期和替代状态。近期事件游标由服务器签发，绑定 owner/home Thread/actor/权限指纹和有效期，不能因换一个合法 Binding 就复用撤权前游标。检索明确标为 `literal_substring`；未实现语义索引、召回与排序，不把基础部分计作完整 MEM01 通过。知识内容不自动变成完成 evidence。

新只读工具同 key 重读最新获权事实。工具收据、额外刷新产生的来源曝光、Session 版本输入及下游发布边界使用同一来源闭包，防止旧收据或刷新读取绕过私密继承。所有 writes、消息/outbox、不可变历史、receipt 和 exposure 在外层事务中提交。

## Owner 展示、恢复与差异

Owner view 只读展示报告/发现项、SOP 任务事实和知识过期/替代及可展开来源。它没有 live 远端授权端口，门禁通过只显示为当时的检查记录，`currentApproval:false`；必须重新调用门禁验证当前 HEAD 与权限。每次快照及来源读取重新执行 ACL，不泄露 Binding、身份指纹或原生会话。重启只恢复持久事实，不重放模型或外部副作用。

| 显式平台差异 | 当前范围 |
| --- | --- |
| accepted-source | PR 的 canonical Action 接收消息 ID + 不可变 seq，与真实 PR HEAD 一起绑定，替代上游 artifact revision 引用 |
| 评审政策 | 本地 GitHub 独立 reviewer 门禁；不宣称复制 ArtifactReview 的 human_required 领域政策，人类/外部发布审批仍单独处理 |
| SOP verifier | 首批只注册精确平台 task_done；其他业务检查保持 unknown/attested |
| 知识检索 | home、精确 anchor、近期事件、平台会话展开、版本/过期/替代与统一 ACL；语义检索单列未实现 |
| 存储与宿主 | SQLite/WAL、IMMEDIATE/CAS、单宿主；多租户/多机、Collective 特殊隔离和扩展载体仍另列范围 |
| 发布与 OS | 真实远端 HEAD 在等待中推进、具体 OS 命令、主服务/真实模型完整故障组合、发布/回滚留 T12 |
