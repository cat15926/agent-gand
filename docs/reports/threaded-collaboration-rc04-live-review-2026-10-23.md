# 持续协作 RC04：真实事件与连续评审验收

日期：2026-10-23（Asia/Shanghai）。状态：**实现与所列隔离验收完成；真实观察609秒/71次官方GET，0新HEAD，结果not_observed；真实连续链尚未通过。RC04本轮变更未提交。**

本轮先将RC03提交并推送到 `origin/main`：`ee751a3`。RC04保持schema v35，不新增迁移，不更改日常配置/数据库或打开生产入口。原T01–T12、RC01–RC03证据保留。

## 实施结果

本次新增可复用的实际生产验收工厂、严格官方只读传输、父进程独占凭据的IPC代理、实际子进程恢复和有界真实观察入口，详见[合同](../architecture/threaded-live-review-acceptance-v1.md)。

完整链坚持一个canonical PR Action和原root：H0 approved与真实baseline → 自然H1唯一跟踪唤醒及旧门禁stale → H1逐轮修订、changes_requested交付完成但gate blocked → 自然H2逐finding回应与不同评审者验证 → 当前H2门禁通过。需要两次基线登记之后的自然HEAD变化，不能拆Action、另开用户根、比较旧报告或修改远端来替代。

### 实际缺口及修复

完整链首次自测在作者修订时触发 `THREADED_ACTION_TARGET_SOURCE_FORBIDDEN`：旧tracking回调对发起者独享，独立评审者无法读取修订的来源。RC04在[productionGithub](../../apps/server/src/threaded/productionGithub.ts)、[tracking](../../apps/server/src/threaded/tracking.ts)、[collaboration](../../apps/server/src/threaded/collaboration.ts)及[cooperation](../../apps/server/src/threaded/cooperation.ts)补受信的 `deliveryAuthorization`：

- 登记时冻结每个获权接收成员的provider授权与本地身份，并和原私密audience/全部来源ACL取交集。
- 回调保持private，targets仍只有原发起者；后续合法评审者可以读取共同获权的领域事实，不额外唤醒所有可读成员。
- 派发前包含暂停恢复再次逐成员检查；撤权/身份变更拒绝旧回调，新获权成员不进入旧audience。
- generic、内置thread_messages和没有冻结策略的旧wait继续caller-only；不通过公开私密来源或忽略来源检查来放行修订。

随后完整脚本在长同步准备、尚未请求模型时触发 `THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED`。排查确认不是输入容量或传输超时：当时manifest为11905字节，requests.begin尚未通过。临时验收根用正常Owner预算CAS显式登记10秒活动片，生产默认1秒及其守卫未改，其他总活动/token/费用/Invocation/Attempt/deadline限制保持。最终pack只授权七个实际工具、输入65536、本地脚本响应timeout120秒；上述配置和先前失败原因进入证据，不能外推默认1秒下全部长准备组合已通过。见[开发诊断](evidence/threaded-rc04/development-findings.json)。临时白名单诊断代码已移除，没有传播原异常、请求正文或凭据。

## 分层验证

**新增专验38组、相关回归70组，共108组通过。**这是脚本分组数，不等于原59项或真实事件链已通过。没有真实模型调用、供应商token消耗或远端review/comment/commit/branch/PR写入。

| 验证 | 组数 | 证据与边界 |
| --- | ---: | --- |
| 官方只读传输 | 12 | [transport](evidence/threaded-rc04/transport.json)：注入凭据reader/响应；授权前不读helper，固定GET/query/headers、scope、响应hash、大小/超时、401/403、close及secret边界 |
| 生产共享授权方法 | 6 | [delivery authorization](evidence/threaded-rc04/delivery-authorization.json)：精确scope/注册actor、撤权/身份版本、模式、配置/凭据漂移及prototype键，0真实GET |
| ACL共享集成 | 7 | [sharing](evidence/threaded-rc04/sharing.json)：真实SQLite/messages/cooperation；generic/消息源隔离、原私密范围交集、暂停后接收者撤权/身份漂移拒绝、新成员不扩旧audience、旧记录不自动共享 |
| 单Action完整协议链 | 9 | [isolated](evidence/threaded-rc04/isolated.json)：注入H0/H1/H2和模型，真实production权限、同root、唯一wake、accepted source、逐finding、CAS重试、漂移/不可用失败以及SQLite重建 |
| 实际PID恢复 | 4 | [process](evidence/threaded-rc04/process.json)：4个真实PID、3次SIGKILL/close；完成阶段边界的原Action/root/wait/callback/review恢复，0GET/模型重放，父token不进入子进程env/argv/IPC/SQLite/WAL/metadata |
| 协作回归 | 17 | [collaboration](evidence/threaded-rc04/regressions/collaboration.json)，原征询、消息、tracking、隐私、控制合同保留 |
| RC02生产GitHub回归 | 18 | [github](evidence/threaded-rc04/regressions/github.json)，实际factory与注入官方响应，来源/凭据/身份/恢复围栏 |
| Action回归 | 12 | [actions](evidence/threaded-rc04/regressions/actions.json)，责任/代际/幂等/资源与真实SQLite多进程竞争 |
| Review回归 | 9 | [reviews](evidence/threaded-rc04/regressions/reviews.json)，完整评审/修订/完成与门禁分离 |
| RC03等待回归 | 14 | [waits](evidence/threaded-rc04/regressions/rc03-waits.json)，结构化来源、恢复SLA、普通/守门域及共享额度 |

38组中的GitHub事实均为注入；真实官方读取在下节单独记录。进程验收限定已持久化stage边界，不是任意mid-commit crash或部署index进程/真实供应商故障验收。108组也不代表实质工程审查通过：作者/评审者的文本是明确标注的本地协议fixture，不是外部PR作者声明或GitHub批准，所有gate保持 `externalApprovalGranted:false`。

## 真实官方只读观察

本次输出为[独立场次](evidence/threaded-rc04/live-2026-10-23.json)，未覆盖T12的606秒/48GET `not_observed` 或RC02的历史只读证据。

认证主体通过官方 `/user` 核实为 `cat15926`，从当前开放、未合并且作者不同的PR中选择并冻结：

| 目标 | 当前场次初始HEAD | 初始等待 |
| --- | --- | --- |
| [clowder-ai#1698](https://github.com/zts212653/clowder-ai/pull/1698) | `865ea7dd3dedb86998115f536a67a920524b2a3d` | await_first_head |
| [clowder-ai#1701](https://github.com/zts212653/clowder-ai/pull/1701) | `b0374ab3d94299dc435757aa4b955189716c0f9b` | await_first_head |
| [clowder-ai#1505](https://github.com/zts212653/clowder-ai/pull/1505) | `2f5ebf30e4e0668145bb417fa0fa499f3d871dfa` | await_first_head |

观察自2026-10-23 00:17:41（Asia/Shanghai）开始，计划600秒、每30秒检查；连同实际GET与恢复用时最终609秒，于00:27:50结束。共71次官方GET、17轮检查、66份PR事实，三个目标都未出现新HEAD，均保留原baseline、0个tracking callback，结果 **not_observed**。阶段摘要及官方响应哈希见[真实观察摘要](evidence/threaded-rc04/live-summary.json)。

每个目标执行一次真实SIGKILL并等待close后用新PID恢复，共6个PID/3次重启。原Thread/root/Action/wait/消息/回调/评审ID与计数保持；恢复额外GET和脚本模型调用均0。因没有自然H1，真实旧批准失效/H1问题交付/H2逐finding及独立复审仍not_performed，不能用无变化窗口或初始脚本approved充当完整通过。

凭据只在父进程内存，子进程用固定占位capability，通过严格IPC GET代理取得公开事实；实际token不进入环境、参数、文件、证据或子进程。请求记录含时间、路径、状态、响应SHA256与必要HEAD事实，不保存认证头、helper输出或原始错误。没有真实模型调用，不更改历史费用/unknown预留。

## 当前退出条件与剩余工作

RC04的实现和隔离连续链已交付；本窗口没有自然新HEAD，已明确记 `not_observed`，RC04真实连续链未通过，仍需合法发生的H1/H2。后续即使只观察到第一次事件，也只能记 `observed_partial`，不能标为完整通过。

后续在同类合法目标的实际自然更新中补齐完整连续链，逐阶段核对唯一消息/回调、旧门禁失效、逐finding与独立完成。真实模型/SDK、实际index在途及存储故障继续RC05；工程并发/写作与合并责任RC06；日常备份、迁移、选定注册和灰度RC11–RC12。本轮不自动开始这些阶段。

当前进度见[实施指导](../plans/threaded-collaboration-implementation-guide.md)、[实施状态](../plans/threaded-collaboration-implementation-status.md)、[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)与[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。

补充保留[RC03资源日志的逐字文本副本](evidence/threaded-rc04/rc03-log-retention/manifest.json)：原 `.log` 被Git忽略，本轮以可跟踪文本保存相同SHA256字节，不改写RC03既有JSON或历史结果。
