# G6 通用验收、灰度与文档交付

日期：2026-10-17。代码基线：G5 `7f7d826`；G6 工作区变更尚未提交。schema 保持 17，无新增迁移。范围：已开放的模型 API 独立材料、私密汇总/发布，以及有限 Coordination Scope；G5 原生能力包保持阻断，不将本阶段结果推广为真实账户或全原生验收。

## 交付

- 统一结果目录：普通界面可选择独立材料和已通过 Owner 门禁的 Coordination 报告，只授权明确选中的结果；来源软删除后目录隐藏，旧读取预览失效。
- 修复 Coordination 的固定状态发布路径；确切文字与固定状态均复用 G3 的预览、批准、单次发布与唯一恢复。
- 专项 `SCOPED_COLLABORATION_MODE` 和受保护的支持矩阵接口；UI 展示仅预览/关闭状态及原生能力限制。新契约服从开关，旧契约按冻结语义排空。
- 来源/运行/发布列表在断网后重连；响应丢失重试不新建任务、不重复发布；提交期间 Escape 保持抽屉状态一致。
- 只读 `scoped:inventory`、隔离备份/恢复演练、统一验收命令、[支持契约](../architecture/scoped-collaboration-support-v1.md)及[运维手册](../operations/scoped-collaboration-runbook.md)。

## 验证与证据范围

| 验证 | 结果与断言 |
|---|---|
| `pnpm typecheck` | shared/server/web 类型检查 |
| `verify:scoped-collaboration-baseline` | G0 实际调度替身、连续 A/B 场景、timer/answer、旧 v2 越界拒绝 |
| `verify:scoped-collaboration` | Scope、来源、账本、会话边界、非法版本和迁移门禁 |
| `verify:scoped-delivery` | G2 两批五项、ACK/投递/结果、非干扰对照、原子拒绝、幂等与预算 |
| `verify:information-release` | G3 确切发布、固定投影、权限/输入漂移、撤销/过期、并发单次消费 |
| `verify:scoped-recovery` | G4 any、崩溃和 Stop 竞争、未知用量保留、唯一父恢复与预算 |
| `verify:message-visibility` / `verify:private-interaction` | 消息、Context、文件/搜索/证据/WS 权限和公开/私密交替；修正旧脚本把迁移版本硬编码为 11 的过期断言 |
| `verify:runtime-action-commands` / `verify:stage-scheduling` | 原事务/责任门禁与 R7 阶段图、Owner 验收、检查点返工回归 |
| `verify:scoped-g6` | 11 次 mock 调用；阶段结果目录、仅授权 A、两种发布模式、关闭后排空、元数据清单只读、能力/来源接口采样 |
| `verify:scoped-g6-operations` | 4 次夹具模型调用；迁移/恢复调用 0；匹配 DB/主密钥备份、v16→v17 启动、v2/v3 行摘要不变、原密文预览幂等确认、真实 G4 schema 门禁拒绝新库、损坏备份拒绝 |
| `verify:scoped-delivery-ui` | 10 次 mock 调用；正常入口、桌面/390px、两批、Owner 私密结果、停止、单批 any、刷新 |
| `verify:information-release-ui` | 13 次 mock 调用；确切草稿编辑/撤销/重批、Coordination 来源、固定状态公开、提交/发布响应丢失、断网重连、灰度开关与提交中 Escape |
| `verify:docs` | 本地文档链接检查 |

所有场景使用临时数据库、模拟角色/账户或本机夹具；真实供应商请求 0、G6 原生模型调用 0。迁移使用隔离备份，没有恢复或改写业务库。浏览器 pageerror 0；1440×960、390×844 均通过，人工查看截图未发现横向溢出或按钮遮挡。

统一命令为 `pnpm scoped:acceptance`，默认包含浏览器；`--core-only` 会明确记录未运行 UI。逐命令日志和汇总保存在 `apps/server/data/scoped-acceptance/`，UI 截图/结果在 `apps/server/data/scoped-g2-ui-qa/`、`apps/server/data/scoped-g3-ui-qa/`。这些包含合成私密材料的本机产物被 Git 忽略，不作为源码提交。

完整 15 项矩阵均通过，证据目录为 `apps/server/data/scoped-acceptance/2026-10-16T16-49-38-867Z/`。之后针对软删除来源和旧 worker 接受 v16/拒绝 v17 补跑 G6、G3、迁移演练与全项目类型检查，全部通过。

## 必测矩阵映射

| 分类 | 证据入口 |
|---|---|
| 范围、私密 A/B、历史、文件/证据/错误/WS | G1、message-visibility、private-interaction、G2/G6 UI |
| 未授权目标/次序/数量、整批拒绝、状态投影授权 | G2、G3、G6 固定状态发布 |
| 输入先记账、新来源/旧授权失效 | G1、G3、G4 |
| 草稿/目标/成员/来源漂移、过期/撤销、并发消费 | G3、G4，G6 两种引擎来源 |
| 普通恢复不能扩权、缺 manifest/未知版本拒绝 | G0、G1、G4 |
| 双击、响应丢失、重连、重复唤醒 | G2/G3/G4 命令事务及 G6 浏览器 |
| Stop/complete/release/wake 竞争、提交前后崩溃 | G4；G6 排空与迁移演练 |
| 多项预算、取消、未知计费、后继累计 | G2/G4/R7，G6 灰度不重发 |
| 旧 v2 权限、新旧混读、旧 worker 拒绝新库 | G0、G1、G6 恢复演练 |
| 未授权秘密变化但获准状态相同的非干扰对照 | G2 确定性夹具；不宣称消除耗时等时序信道 |
| SDK/Codex 原生记忆与私密→公开 | G5 本机协议证据；完整供应商/原生能力仍为未支持，G6 不解锁 |

## 性能与限制

能力/来源目录各进行 5 次预热、30 次 Fastify inject 本机采样，第一轮 P95 分别为 0.228ms、1.047ms。数据为两份阶段报告的小夹具；G0 没有 HTTP P95，所以这是新基线而非与 G0 的性能改善对比。界面和权限校验不增加模型调用。真实网络、大房间和真实账户性能另行验证。

G6 完成当前开放组合的产品、灰度、兼容与运维交付。全量原生上线仍受 G5 剩余门槛约束：获准账户实测、原生 any/发布/崩溃矩阵、原生业务工具和 Coordination 原生成员。Issue #15 未被远程关闭；任意旧私密 Run 不自动迁移；任意自由文本披露和文件/附件发布仍不支持。

## 本地服务与业务记录

本地后端已恢复，健康检查正常；前端 `http://localhost:5173/` 返回 HTTP 200，新的能力管理接口对无管理会话请求返回 401。

与 G5 基线相比，原有 83 条 Run 的完整记录摘要保持不变；期间普通聊天室另有一条 SDK 任务，当前共 84 条。本次重启前后这 84 条记录摘要一致，新增记录被保留。schema 为 17，外键检查错误 0。本次代码、文档及验证脚本尚未提交或推送。
