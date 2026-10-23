# 持续协作：真实 GitHub 事件与评审验收 v1

更新：2026-10-23。RC04 承接[生产 GitHub 来源](threaded-github-production-v1.md)、[评审合同](threaded-workflows-v1.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)，不新增迁移，代码 schema 仍 v35。日常配置及数据库保持原状，新增验收只使用临时数据库和明确的只读范围。

## 连续验收链

一个 PR 的 `review/review_delivered/review` Action 在 owner 范围内唯一，不能为了通过验收而改 slot、建第二个同类责任或换用户根。连续链至少需要三个真实版本、两次自然新 HEAD：

| 阶段 | 证据及约束 |
| --- | --- |
| H0 | 本地独立评审生产者交付 approved、显式完成评审责任，门禁查询验证旧 HEAD；在真实当前 H0 登记 tracking baseline，不产生回调 |
| 自然 H1 | 登记之后的官方读取返回不同 HEAD；正式 tracking producer 记录事件、唯一 callback/message/wake，原作者以原 root 消费回调 |
| H1 修订 | 旧 approved 门禁为 stale；作者按当前版本创建修订，只是 attested；不同评审者在 H1 提出 findings，并完成交付责任，但门禁 blocked；在 H1 登记第二个真实 baseline |
| 自然 H2 | 第二个 wait 登记之后再观察不同 HEAD；作者对所有未验证 finding 逐项回应；不同评审者按原 finding ID 独立验证、交付并完成责任，当前 H2 门禁才可 approved |
| 恢复及重试 | 同一 root、Action、不可变版本、finding ID 保留；同键提交/修订不二写，重复事实不重复回调；重启自身不发 GitHub GET、不执行模型、不重放交付 |

本地生产者在验收中是明确标注的脚本协议 fixture，身份、Binding、权限、消息、accepted source、代际、领域 resolver 和门禁走真实生产工厂。它不代替工程代码审查，不代表真实外部 PR 作者声明已经修复；本地 gate 的 `externalApprovalGranted` 仍为 false。GitHub 事实、真实子进程和注入模型三个证据层分开记录。

验收 pack 仅允许实际使用的七个工具，输入上限65536；临时根通过常规 Owner 预算 CAS 显式登记10秒活动片。先前默认1秒活动片在较长同步准备时按原守卫拒绝，精确原因保留为 `THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED`。其他总活动、token、费用、Invocation/Attempt及deadline限制保留，生产默认与守卫未改变。这是声明的验收配置范围，不证明默认1秒片段下所有长准备组合已通过。

自然新 HEAD 不由验收制造。稳定重复读取、单独 updated_at 变化、旧报告中的 HEAD 与今天不同、已合并 PR 的稳定事实，都不能冒充登记 wait 后的新事件。无事件记录 `not_observed`，仅 H1 记录 `observed_partial`，完整 H0→H1→H2 链及恢复证据通过才可记相应目标 passed。选中多个 PR 时逐目标记录，不宣称所有目标通过。

## GitHub 跟踪事实的受限共享

RC04 完整链暴露原实现缺口：全部 tracking callback 都被强制为发起者独享的私密消息。作者用它作为修订输入时，来源 ACL 正确地阻止将修订交给另一个评审者。绕过来源检查或另开用户根都不符合合同。

现在来源可提供服务器受信的 `deliveryAuthorization(scope, subject)`，返回可读取此领域事实的各成员授权指纹。只有生产 GitHub PR 来源安装此能力；普通 `thread_message` 及未提供该策略的来源继续使用 caller-only 私密回调。模型不能选择共享范围。

登记 wait 时冻结当前注册 actor 的授权指纹与成员身份，并与原输入的私密 audience 和全部来源消息 ACL 取交集。回调仍为 private，只有符合交集的明确 audience 可读；`targets` 仍只有原发起者，不额外唤醒所有可读成员。这让合法评审者读取原 GitHub 事件的来源证明，后续修订仍由 Action 和当前 provider 权限控制。

在回调派发前，包括暂停后恢复，逐成员重验授权、冻结身份及所有来源 ACL。任一已捕获接收成员失权或身份漂移则拒绝旧回调，不将消息公开、静默换成员或扩大 audience。登记后才获权的成员不加入旧 audience。旧 wait 没有冻结共享策略，保持 caller-only，不能因升级自动扩大可见范围。已合法发布的历史消息不被当作当前 GitHub 权限或当前版本的批准。

## 只读传输与进程证据

`verify:threaded-rc04-live` 仅在显式 `--authorized-git-credential` 后使用已授权 Git 凭据。凭据只留在父进程内存，不写环境、参数、文件、证据、SQLite 或 IPC。官方 `/user` 核实 principal，固定查询近期开放 PR，选择至多三个作者不同于该 principal 的 PR，再冻结精确仓库/PR 范围。单凭据不能通过更换本地 Agent 名称来评审相同 principal 自己的 PR。

传输只允许 `api.github.com` 的官方 GET；固定 query、API 版本和 headers，禁止任意 URL/query、远端写、重定向及缓存回退。响应有1MiB及20秒界限，401/403 清除凭据并稳定拒绝。公开证据只记录请求路径、状态、时间、响应 SHA256 和必要 PR 事实，不含认证头或 helper 输出。

验收工厂运行在真实独立 PID。子进程没有真实 GitHub token 或直接网络权限，固定 GET 经 IPC 交由父进程校验并发送；IPC 不含真实凭据。重启使用 SIGKILL，等待旧 PID 的 close/signal 证明，再以原 SQLite 和原 stage metadata 启动新 PID，核对 root、Action、wait、callback、报告及版本 ID/计数，恢复零盲重发。

这证明已持久 stage 边界上的生产组合重建及进程恢复，不宣称覆盖部署的整个 `index`、任意事务中间 SIGKILL、真实模型或 SDK 在途故障；这些继续由 RC05 等条目验收。

## 运行及证据口径

```sh
pnpm verify:threaded-rc04-transport
pnpm verify:threaded-rc04-delivery-authorization
pnpm verify:threaded-rc04-sharing
pnpm verify:threaded-rc04
pnpm verify:threaded-rc04-process
pnpm verify:threaded-rc04-live -- --authorized-git-credential --observe-seconds=600
```

真实观察默认600秒、每30秒检查一次、最多3个目标；可通过 `THREADED_RC04_LIVE_OUTPUT` 指定本次全新的证据路径。不能用一个短 smoke 的稳定读取宣布新事件通过，也不能覆盖旧 not_observed 或失败记录。实际结果及剩余项见[RC04 报告](../reports/threaded-collaboration-rc04-live-review-2026-10-23.md)。日常注册、迁移及灰度仍按 RC11–RC12 单独执行。
