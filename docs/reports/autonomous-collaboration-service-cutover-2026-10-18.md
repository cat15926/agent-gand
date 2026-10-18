# 自主协作业务服务灰度切换记录

日期：2026-10-18（Asia/Shanghai）。用户批准按“固定代码版本 → 旧任务收尾 → 备份与副本演练 → 服务切换 → 页面验收”执行。此前真实组合证据见[AC6 验收报告](autonomous-collaboration-ac6-acceptance-2026-10-18.md)，运行契约见[托管 SDK 与准入契约](../architecture/autonomous-managed-sdk-rollout-v1.md)。

## 切换结果

业务服务已切换至 `fe03c97`（`feat(collaboration): validate managed SDK rollout and real autonomous workflows`），数据库 schema17 → schema24，前后端均已重新启动并返回健康响应。现有 GLM API / Claude SDK 组合已在业务库通过真实页面协作；代码仓库默认配置仍 closed，本地业务配置仅开放下述灰度房间。

- 地址：[自主协作验收 · GLM API 与 Claude SDK](http://localhost:5173/?room=9b0db0fb-4a4f-4adb-8403-52458e873005)。
- 房间 ID：`9b0db0fb-4a4f-4adb-8403-52458e873005`。
- 负责人：`glm53-api`；可参与成员：鸡腿、nim、找茬员、小牛吗、大聪明，均使用现有托管 GLM-5.3 Claude SDK 账户。
- 自主 SDK 负责人开关继续为空，首批灰度采用完整游戏实测通过的 API 主持 / SDK 成员组合。Codex 自主组合继续暂缓，既有手动流程入口保持原配置。
- 房间默认只读、根输出48000、单次输出12288、首响应/空闲600000毫秒、根截止30分钟；估算费用上限5 USD，单次未知费用占额0.05 USD。

实际配置：

```dotenv
AUTONOMOUS_COLLABORATION_MODE=execute
AUTONOMOUS_ROOM_IDS=9b0db0fb-4a4f-4adb-8403-52458e873005
AUTONOMOUS_NATIVE_DRIVERS=claude-sdk
AUTONOMOUS_NATIVE_COORDINATOR_DRIVERS=
```

实际服务验证：其他既有房间的新自主请求被 `AUTONOMOUS_ROOM_CLOSED` 拒绝；灰度房间中的 SDK 负责人请求被 `AUTONOMOUS_COORDINATOR_UNAVAILABLE` 拒绝。两项请求均 HTTP409，未创建 Run、未触发模型调用。允许房间可以使用普通发送入口。

## 旧任务与历史记录

切换前两个活动任务均为 waiting_for_user，没有活动原生进程。经原服务正常 `/api/runs/:id/actions` cancel 收尾，保留任务、消息与审计记录：

- `65edf8dc-a6cb-4eab-ac4e-533ce5aec8eb`：2026-10-07 的“鸡腿，组织一场狼人杀比赛！”。
- `d1e4a45d-5e3b-48f7-bff2-9140babf9c8b`：2026-10-16 的“继续游戏”。

历史6次未知模型调用全部属于已失败任务，执行记录已有结束时间，没有活动原生进程或待核对工具效果；这些事实足以支持本次向前升级，不代表供应商用量已核实。逐行保留 unknown 及原记录，未重放、清零或改记完成。

## 备份、迁移与恢复演练

私有证据目录：`apps/server/data/service-cutover-2026-10-18/`，已被 Git 忽略，目录权限0700；备份文件权限0600，未提交账户密钥或业务数据。

1. 正常停止任务前，先保存 SQLite 一致性快照 `before-stop.sqlite`、旧任务和未知调用证据；配置保存在 `server.env.before`。
2. 正常 SIGTERM 关闭旧服务后，`accounts:backup` 保存离线数据库、账户私有材料、角色、头像及已有客户端目录，`accounts:verify-backup` 校验394个文件通过，不依赖环境中的外置主密钥。
3. 从离线备份创建 `rehearsal.sqlite`，由当前数据库初始化模块升级至24并执行偏好迁移。完整性检查 ok、外键错误0，副本账户解密审计通过。
4. 比对10张关键表的原始列和记录摘要：89个任务、1059条消息、3个账户、6个账户版本、2份加密凭据、5个原生身份、74条账户绑定、276份角色快照、0个受控文件版本、43次模型调用均一致。
5. 恢复原备份为独立 `restore-drill.sqlite`，schema17、完整性及外键检查通过，10张表摘要匹配。取 `7f7d826` 的 schema17 兼容检查实际验证：接受原备份、拒绝升级后的 schema24 副本。这是旧版本 schema 守卫证明，未将其扩大为完整旧服务回退证明。
6. 保存当前 `fe03c97` 和 schema17 兼容 `7f7d826` 的源代码归档；实际旧进程启动时的未提交工作区无法从 Git 精确还原，不声称后者就是旧进程的完整源码快照。
7. 对业务库执行同样升级，创建专用空房间，应用灰度配置并启动兼容服务。完成页面验收后，再次比对离线备份的全部上述历史记录均未改变，并保存 `after-cutover.sqlite` 一致性快照。

未知调用/费用仍在，因此维护清单的整库自动回退就绪标记保持 false。需要关闭灰度时先关闭新准入，使用当前兼容服务排空并保留新账本；恢复旧备份须另行保全切换后产生的任务和用量，不能覆盖新记录来消除未知状态。

## 切换后的实际页面验收

从真实 `http://localhost:5173/` 页面选择 API 负责人、鸡腿成员后发送合成算术需求，未拦截前后端接口，未模拟供应商。使用普通页面入口真实委派、收集、汇总并交付。

| 项目 | 结果 |
|---|---|
| Run | `2e094bbc-89ad-4739-83dd-82bc5525751f` |
| 时间 | 22:36:34 → 22:38:35，约121秒 |
| 实际执行 | API 委派鸡腿核对7×8，SDK 返回56，API aggregate 读取成员结果后交付 |
| 平台模型调用 | API5、SDK1，全部 completed |
| 输出用量 | 6278 token，未知0 |
| 中途用户决策 / 最终交付 | 0 / 1 |
| 费用账本已用及占额 | 0.260288 USD；API 未报告价格的5笔未知费用保留 |
| 运行时审计 | `auditShadowRun` 返回空问题列表 |
| 浏览器检查 | 刷新后最终消息仍可见，390px 无横向溢出，页面错误0 |

SDK 内部供应商请求数仍未知；平台进程/模型调用数不等于供应商内部请求次数，费用账本不代表最终供应商账单。

验收观察脚本首轮因查询遗漏 runId 参数而退出，但业务任务持续正常执行。保存首轮观察失败报告后修正脚本，只重新打开页面并观察同一个 Run，没有再次发送需求、重放调用或改写执行结果。完整页面观察最终通过。

证据包括 `live-ui-result.json`、`live-final.md`、桌面/手机截图、`admission-check.json`、`rehearsal-result.json`、`compatibility-check.json`、`restore-drill.json`、`post-cutover-preservation.json`、`post-cutover-audit.json`。

最终业务清单：schema24、完整性 ok、外键错误0、活动 Run/Attempt/原生进程0、历史未知模型调用6笔保留、本次未知费用5笔保留。账户审计通过，无问题。代码验收仍采用此前最终28/28矩阵；本次没有修改生产实现，补充的是业务迁移、配置、页面真实验证和运维记录。

## 用户操作

打开上述灰度房间，直接在“提出需求”中发送任务。组织游戏时可输入：“组织一场五人简化狼人杀，我只当观众，请自动推进到终局。”默认 API 负责人可调度房间内五名 SDK 玩家，无需逐轮发牌、搬运消息或手动推进。

其他房间尚未纳入本轮自主灰度，已有历史记录继续可查看。文件修改任务需另行明确允许受控文件写入，本轮灰度房间默认只读。服务启动方式仍为仓库现有 server start 与 web dev，日志保存在私有切换目录中。
