# 持续协作 RC03：生产命令、工程映射与等待合同

日期：2026-10-22（Asia/Shanghai）。状态：**首批选定 profile 的实现、接线及下列验收完成；RC03 实现/文档/证据随本次提交交付。日常未配置、未迁移、未启用。**

本轮先将 RC02 提交并推送到 `origin/main`：`a8719103312d468e539c9810506a59674c1ca5c2`。RC03 在此基线上实施，追加 schema v35，历史 v25–v34 源码和 descriptor 保持不变。没有自动开始 RC04、其他 RC/EXT 或日常部署。

## 交付及范围

| RC03 要求 | 本次实现 | 实际范围及证据 |
| --- | --- | --- |
| 生产命令注册 | [loader](../../apps/server/src/threaded/productionCommands.ts) 接入实际 [production](../../apps/server/src/threaded/production.ts) 与 [service](../../apps/server/src/threaded/service.ts)，可选 `THREADED_COMMAND_REGISTRATIONS_FILE` | 未配置明确 not_registered；`constructor`/`__proto__`等未注册名称也拒绝，注册表无原型继承；只接受固定服务器内置 `project_manifest_v1`，不注册任意 shell/build/network |
| 固定程序与当前权限 | 固定 Node、worker、guardian、argv、空 env 和 cwd；注册、程序、路径、输入身份 pin；每次复验 release/member/account 及 Action generation | 真实 guardian ready 前合法转移 Action，后续 native launch 被阻止；full Binding 与恢复三字段 scope 得到同一授权 |
| 工程与目录映射 | 固定 project root、成员 workspace、命令 cwd，映射指纹进入 Session 信息边界；漂移拒绝而不回退 | 实际生产工厂 Session 指向选定工程目录；成员/输出目录交叠、symlink、文件替换与输入变化负例通过。没有宣称已交付工程绑定 UI、通用写作或自动合并 |
| 独立命令资源 | 固定所有 read/write 声明进入独立 claim，不占模型容量/native Session；协调器精确对照原 intent | 修复生产默认 Session validator 原先会拒绝无模型 Session 的独立命令问题；actual production 无 fixture 执行绕过，完成真实领取、进程及资源释放 |
| 副作用与 unknown | 父进程独立重算 pinned 输入与 manifest，核对整个专用输出目录；原 guardian/进程组停止证据另验 | 正常成功必须有正确产物；未知文件或 partial/pending 保持 unknown/未释放，独立处置后复核，不盲重跑；取消、IPC/owner 退出及旧代际不能释放新 claim |
| 结构化来源 | [waitContracts](../../apps/server/src/threaded/waitContracts.ts) 与 [cooperation](../../apps/server/src/threaded/cooperation.ts) 实现六种 kind、value、expectedSignal、SLA、reporter anchor、真实来源/ACL/输入 cutoff 复验 | 本地 message/task/managed_command 可验证；外部 issue/comment/reporter 需另装可信 adapter，默认拒绝。RC02 的 PR adapter 不冒充这些来源 |
| SLA 恢复 | 启动时已错过的 timer 才使用恢复窗口；有效且严格早于 SLA 才能派发；相等/更晚或无效明确退休 | 在线 one-shot、重启时尚未到期的 timer 不统一套硬 SLA；暂停积压的恢复回调仍不能越过原窗口；旧字符串来源不补造 SLA/授权 |
| 共享 hold 准入 | timer 与 `wait_command` 共用3次/小时/owner+Thread+Agent；相同 timer job、相同 command ID 不二扣 | `run_command` 单纯执行不自动占 hold；注册 wake 才扣。新 wait、额度与旧 wait 替换原子回滚；当前端口撤权会拒绝旧 terminal/paused callback |
| 守门领域 | 默认 ordinary，服务器显式选定 gatekeeping 才用600秒上限及已有事件回调检查 | 不把专域限制套用所有 Thread，不复制参考 shadow/fail-open；日常没有指定守门 Thread |

详细配置、恢复及平台差异见[生产命令/等待合同](../architecture/threaded-commands-hold-production-v1.md)，部署步骤更新至[运维手册](../operations/threaded-release-runbook.md)。

## 前向迁移与旧等待

[v35](../../apps/server/src/db/threadedHoldAdmissionMigration.ts) 新建 append-only 共享准入账本，数据库检查 source kind、稳定键与精确 owner/Thread/member scope。旧 timer quota 表、记录及原时间保持，前向回填到新账本；历史额度不能通过升级清零。

v34 command wait 缺少可靠注册时间。迁移只将仍 awaiting、或对应 command callback 仍 pending/waiting 的旧任务保守记在一次迁移时刻，暂占一小时；不是伪造历史精确时间。纯历史已派发/失效且没有待发回调的记录不全量重扣，重复升级或10ms后重启都不续期。恢复不自动重启旧命令。

旧自由文本 timer 的 record 保留，不补造新来源和 SLA。启动时已错过的旧 timer 退休 invalid；尚未到期的旧 timer 在线到时也因无可信结构化来源退休 invalid。相应迁移、旧等待处置和应用兼容应在备份副本先演练，不能直接拿日常服务启动作只读检查。

## 验证结果

**14 套脚本合计167组通过：30组新增专验、19组迁移、118组相关回归。**这是脚本分组数，含不同层的相关覆盖，不等于167个独立业务场景，也不表示原59项全部通过。API/GitHub 响应均为注入，实际 OS 进程证据单列；没有真实模型调用或供应商请求。

| 验证 | 组数 | 结果及证据 |
| --- | ---: | --- |
| 新结构化等待 | 14 | [waits](evidence/threaded-rc03/waits.json)：伪来源/ACL/cutoff、同job、替换回滚、online与missed区别、SLA前/等于/后、身份/控制、私有锚点、暂停源撤权、legacy退休、守门域及共享额度 |
| 新命令准入/撤权 | 4 | [command admission](evidence/threaded-rc03-command-admission.json)：shared3/h、稳定命令ID、精确一小时边界、失败回滚、terminal和paused callback当前授权 |
| 新生产命令原生进程 | 10 | [production commands](evidence/threaded-rc03-production-commands.json)：4次真实 native worker，另1次真实 guardian 被代际围栏阻止 native launch；完成/取消/未知输出/partial对账、执行链/目录/输入/配置pin |
| 新实际生产工厂 | 2 | [production composition](evidence/threaded-rc03-production.json)：关闭 fixture bypass，注入模型但实际运行1次原生命令；Session映射、完整claims、独立证明释放、唯一wake和observe零启动/恢复写 |
| 迁移 | 19 | [migration](evidence/threaded-rc03/migration.json)：保留原17组，补真实 `a871910` v34→v35、旧额度/活跃命令占窗、重复不续期、DDL/最终登记全回滚、真实v34 worker零修改拒绝v35 |
| 共享资源 | 19 | [资源汇总](evidence/threaded-rc03/regressions/resources.json)：SQLite竞争、Session、祖先read/write、unknown和旧finally |
| 新旧资源接线 | 8 | 同上：旧独占与新slot、独立资源约束及原桥接合同 |
| 旧资源兼容 | 11 | 同上：首跑沙箱无法 `ps` 观察进程，保留失败日志；获环境权限后原样重跑通过，未伪造进程证明 |
| 协作 | 17 | [collaboration](evidence/threaded-rc03/regressions/collaboration.json)，旧场景保留，字符串fixture改实际消息锚点 |
| Action | 12 | [actions](evidence/threaded-rc03/regressions/actions.json)，含真实多进程同键争用、代际及未知命令恢复 |
| 生产接线 | 16 | [production](evidence/threaded-rc03/regressions/production.json)，默认closed、当前pack/权限、终态原子性和有界退出 |
| RC02 GitHub | 18 | [github](evidence/threaded-rc03/regressions/github.json)，官方GET形状为注入，来源撤权、身份和secret边界回归 |
| Review | 9 | [reviews](evidence/threaded-rc03/regressions/reviews.json)，完整交付/修订/门禁与多进程事务回归 |
| 既有 OS 生命周期 | 8 | [OS regression](evidence/threaded-rc03-os-regression.json)，实际macOS进程取消、IPC/owner退出、恢复与未知围栏；伪造cwd仍拒绝，仅兼容新增精确错误码 |

新增命令入口：

```sh
pnpm verify:threaded-rc03-waits
pnpm verify:threaded-rc03-command-admission
pnpm verify:threaded-production-commands
pnpm verify:threaded-rc03-production
```

已有相关脚本另存RC03回归证据，未覆盖T01–T12/RC01/RC02历史报告。完整源码/证据摘要见[delivery](evidence/threaded-rc03-delivery.json)。服务器类型检查、文档链接和 `git diff --check` 通过。K01–K16的16条核心文字及原59项场景/预期与 `a871910` 逐字一致，见[原文校验](evidence/threaded-rc03/original-contracts.json)。

## 后续边界

1. 真实供应商、实际 index 的故障/存储组合与SLA恢复交RC05，真实工程读写争用、写作与合并责任交RC06。本次实际工程仅固定清单程序和分离输出域。
2. 外部 issue/comment/reporter 的生产 adapter、任意shell/build/network profile未安装；每项须另行定义受信来源、完整副作用域及验收，不能由已有工具名推断支持。
3. 参考ManagedJobService默认4并发属于独立控制面，本地按完整workspace互斥和固定注册范围管理，不宣称并发参数同形同参。
4. 真实新HEAD完整跟踪/修订/复审仍RC04；旧费用及副作用unknown仍RC09。本轮0真实模型token，不改变历史unknown预留。
5. RC11–RC12的目标环境备份、v35迁移、日常配置与灰度未执行。默认closed不变，未回写GitHub Issue，未把代码接线当作生产放行。

已同步[实施指导](../plans/threaded-collaboration-implementation-guide.md)、[实施状态](../plans/threaded-collaboration-implementation-status.md)、[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。下一阶段建议RC04，RC09可并行，未自动开工。
