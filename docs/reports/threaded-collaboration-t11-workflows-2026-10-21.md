# 持续协作 T11：评审修订、SOP 与基础知识验收

日期：2026-10-21。基线：T10 `c944c9d` 已提交并推送 `origin/main`；本批 T11 工作区尚未提交推送。任务来源为 [Issue #16](https://github.com/cat15926/agent-gand/issues/16)、[实施指导](../plans/threaded-collaboration-implementation-guide.md)与[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)。

T11 首版合同已实现并通过下列分层验收：完整接收来源/版本/作者路由评审、发现项逐项修订与独立门禁、SOP CAS及精确平台任务核验、home基础知识与统一来源ACL。追加v33；历史v25–v32源码与descriptor不变。生产新工作入口/executor保持关闭，未迁移日常数据库，未读取日常会话或发布GitHub评论/review。语义检索仍未实现，MEM01整体未完整通过；T12综合故障与发布未执行。

## 实现与合同核对

具体接口和显式平台差异见[工作流合同](../architecture/threaded-workflows-v1.md)。固定上游仍为 `8b373123323aacd7e2047dab94fdc15b8f7567ae`，未跟随远端HEAD。核对覆盖其[普通评审回调的来源/版本/作者字段](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callbacks.ts#L1547)、[ArtifactReview领域状态](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/domains/collaborative-content/artifact-review/reducer.ts#L93)和[SOP CAS](https://github.com/zts212653/clowder-ai/blob/8b373123323aacd7e2047dab94fdc15b8f7567ae/packages/api/src/routes/callback-workflow-sop-routes.ts#L360)。本地采用 canonical Action 接收消息ID+不可变seq及真实PR HEAD；独立reviewer门禁与上游artifact的human_required是不同领域政策，未宣称完全相同。

| 能力 | 本批行为 |
| --- | --- |
| 评审交付 | `submit_review`校验接收来源/版本/HEAD/当前holder及独立身份，普通A2A恰好发给一位不同的冻结作者；不混合Action派发或征询metadata |
| finding/修订 | 稳定ID、旧轮次不可变历史、逐项唯一回复；作者addressed仅attested，新HEAD必须独立reviewer明确核验，再解析合法交付 |
| 当前批准 | 每次check都读live HEAD及当前reviewer身份/授权、精确报告/来源和候选；旧receipt同key也重新检查。交付completed不推导批准，失效/不可达明确阻断 |
| 旧版本衔接 | v33首次迁移冻结旧review Action/generation兼容范围；新Action首次旧publish也拒绝。旧finding全部继承，历史采用与新轮次原子提交，旧报告不自动满足完整合同或门禁 |
| SOP | expectedVersion CAS、版本历史；自述unknown/attested，verified须匹配冻结task_done/taskId/criteriaHash及真实任务转换；stage/baton不授执行权 |
| 基础知识 | 七工具、home固定范围、精确消息/Invocation anchor、近期事件游标、不可变版本、过期/替代、来源展开；私有native transcript不进入知识 |
| 隐私与界面 | 新工具结果持久privacy来源曝光并进入Session/下游边界；Owner只读快照再查ACL，历史门禁展示强制currentApproval=false；来源展开另作认证HTTP读取 |

## 隔离、实际进程与界面证据

以下使用真实SQLite、实际运行Binding与应用工具allowlist；模型/PR/命令传输分别明确注入。真实IPC/Chrome/SDK进程不等于真实模型请求或生产服务验收。

| 验证 | 结果与限制 |
| --- | --- |
| [Review隔离证据](evidence/threaded-t11-reviews/isolated.json) | 9组；28次注入模型HTTP、94次注入PR读取。要求修改→交付完成→同根新HEAD逐项自述→独立核验→责任完成→当前本地门禁通过；旧HEAD/错版本/作者/自审/漏重复finding/旧入口绕过拒绝。同key门禁遇HEAD推进、撤权或不可达不复用旧通过；并行失败后的新HEAD替换须逐项回复、跨return采用不丢旧finding；两实际IPC写者同version唯一胜者 |
| Review故障/历史 | 11个事务故障点覆盖report/evidence/message/outbox/workflow/history/receipt/exposure及旧历史采用v1/v2，全部回滚；私密历史源撤权阻断当前/历史/门禁；只读Owner快照无写、无live外部调用、无围栏或权限指纹泄漏 |
| [SOP隔离证据](evidence/threaded-t11-sop/isolated.json) | 6组；11次注入模型HTTP。两成员双进程CAS、3写点回滚、精确task_done/错误任务/未知谓词拒绝、readonly snapshot、跨Thread历史ACL、提交后SIGKILL和同key重放核验失效降unknown |
| [知识隔离证据](evidence/threaded-t11-knowledge/isolated.json) | 8组；14次注入模型HTTP。七工具真实allowlist/receipt/session曝光、精确anchor/平台Invocation展开、expiry/supersession、权限指纹游标、跨Thread撤权、双实际IPC CAS、提交后SIGKILL及3写点回滚 |
| [实际Chrome证据](evidence/threaded-t11-ui/report.json) | 15组，5张截图；由真实工具生成SOP v2/知识v3，3次认证来源GET，390px无横向溢出；实际隔离HTTP进程SIGKILL后新runtime/SQLite连接恢复版本及来源，不重放模型。Review的Owner投影另由隔离域脚本验证，未虚造浏览器评审数据 |
| [T10 Action回归](evidence/threaded-t11-actions-regression/isolated.json) | 12组，使用新完整评审工具；双进程合法完成/返回竞争及替换证据、平台任务、命令代际/unknown和producer恢复保持；不再沿用返回原作者后自评的非法假设 |
| v33迁移 | 16组，执行真实冻结T10/c944c9d worker升级：历史所有表/消息请求hash/预算/队列/任务不变，完整DDL失败回滚，兼容名单只冻结一次，旧worker拒绝v33。未触及日常库 |

SOP与知识各自的CAS、故障和SIGKILL属于T11新增可靠性验收；原E01–E06征询增强仍保留在T08账本，不用一个汇总通过数替代各自证据。v32历史评审域脚本使用明确隔离compatibility marker fixture；真实首次迁移名单冻结由迁移脚本单独验证。

## 真实GitHub只读领域验收

[真实证据](evidence/threaded-t11-reviews/github-real.json)使用用户已授权的Git凭据，仅在内存中持有并访问官方GitHub GET allowlist，不输出或保存凭据。成功运行22次GET，选择独立作者的实际PR [clowder-ai#1660](https://github.com/zts212653/clowder-ai/pull/1660)，当时HEAD为 `e7cd997f308fe80d278bc2a451e12011339b42f2`，实际历史commit `5f133cf181dc18262846cf7f2fb8d8ba3c04cf6f` 的提交拒绝；错误acceptedRevision拒绝。新完整评审以changes_requested在隔离Thread本地交付，经真实域resolver完成责任；作者普通A2A唤醒成功，门禁明确blocked。重建runtime和SQLite后再次读取来源、角色、当前HEAD并保持阻断。

本地api-member是工作流指定作者路由；远端实际PR作者为mindfn，获权reviewer登录为cat15926。没有把本地成员冒充远端作者。未执行完整工程代码审查，不制造真实工程approved结论，不向GitHub发评论/review或合并。新远端HEAD在等待期间到来及完整修订/approved正例的PR传输仍为注入证据，不冒充真实远端变化。初次Node直连发生网络超时；官方连通性确认后优先IPv4重跑通过，失败尝试未产生模型token或远端写。

## 检查、预算与待办

`pnpm typecheck`、Web build、文档链接及diff检查通过；构建保留既有大chunk提示。回归包括Action12、collaboration17、collaboration-backends4（实际SDK worker/CLI/MCP/RPC、注入模型响应）、backend-runtime7、view-api4、isolation6、controls与legacy-boundary。SDK loopback回归在默认沙箱中返回unknown，获权允许临时本机MCP/RPC监听后通过；不将沙箱限制记为产品成功或模型故障。

可复验命令：

```sh
pnpm verify:threaded-reviews
pnpm verify:threaded-sop
pnpm verify:threaded-knowledge
pnpm verify:threaded-migration
THREADED_ACTIONS_OUTPUT=docs/reports/evidence/threaded-t11-actions-regression pnpm verify:threaded-actions
pnpm verify:threaded-reviews-github -- --authorized-git-credential
THREADED_UI_WORKFLOWS=1 PLAYWRIGHT_MODULE=/Users/ruhonglin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs CHROMIUM_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm verify:threaded-ui
```

本批真实模型请求及新增input/output token为0，累计占额仍75,327，含39,010旧未知预留；用户总上限1000万、本轮更严格20万门禁未改变。既有T08首次SDK征询取消根因未定位，风险继续保留。

下一项T12：真实PR等待中新HEAD、具体OS命令与实际平台/后端、主服务和真实模型完整故障组合、可审阅的发布及回滚流程。完整语义检索、Collective特殊隔离、多租户/多机及扩展载体逐项保留范围。T01–T11实现不等于全部59项、全部平台或生产发布通过。
