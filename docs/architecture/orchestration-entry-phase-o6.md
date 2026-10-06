# 编排入口 O6：版本迁移、灰度与故障恢复

日期：2026-10-06。范围：O6 本地实现。真实供应商与账户验收留到 O7。

## 房间升级

O6 保留原 `conversations.mode`、成员、工作区、排序时间和所有历史 Run。服务器取得运行宿主后，在旧 Run 房间回填之后，事务执行默认偏好迁移：

| 旧 mode | 新房间默认策略 | 默认工作流 |
|---|---|---|
| collaboration | 自动 | 常规协作 |
| pipeline | 顺序接力 | 常规协作 |
| supervisor | 自动 | 主管拆解 |

原主管与默认评审者 ID 一并保留。缺少可用模型 API 主管时，页面提示配置要求，预览会阻断不合法计划。迁移不会调用 planner、补造执行快照或重跑旧任务。已有 O5 显式偏好只标记版本和来源，JSON 原样保留。

`preferences_version=1` 与 `preferences_origin=legacy_mapping|explicit` 区分格式及来源。首次映射递增 `members_version` 以使旧预览过期；重复执行不会再次递增。历史排序的 `updated_at` 不变。页面展示转换结果；用户显式保存默认偏好后来源变为 `explicit`。

新请求未提供策略、工作流或约束时，统一入口采用房间默认。旧格式 API 继续按其旧 `mode` 契约执行，不把旧载荷重新解释成新的工作流。成员管理只校验候选团队及默认角色；移除默认主管/评审者/汇总者会清空对应未来偏好，不修改任何既有 Run。

偏好损坏或版本不支持时保留原数据，历史详情仍可读取，新入口要求重新保存偏好。旧草稿使用与房间相同的共享映射；沿用 O5 的 v1→v2 升级、可识别字段恢复和原始恢复副本。升级后到成功发送前不会删除 v1 草稿。

## 数据版本与兼容 worker

`orchestration_schema_migrations` 记录版本、固定描述的 SHA-256 和安装时间：

1. `o1-o5-additive-baseline`：收编已有幂等建表/加列机制，核对请求、预览、绑定、成员票据、任务控制和 token 预留表。
2. `o6-versioned-room-defaults`：增量添加房间版本/来源字段、房间映射审计和入口统计表。

迁移描述作为版本身份固定；后续改变追加版本，不能修改旧描述。启动先检查已知版本及 checksum、活跃编排快照的 schema/resolver/template/engine，再执行 schema.sql 和迁移。遇到未来数据库或不支持的活跃契约即停止，避免旧 worker 盲读后改变状态。

`room_preferences_migration_audits` 按房间唯一记录映射版本、原模式、偏好摘要和时间，不保存目标正文或密钥。房间映射与审计在同一个 `BEGIN IMMEDIATE` 事务中，部分失败整体回滚。新 Run 继续使用 O1–O5 的冻结入口快照、账户绑定、Runtime contract、PlanRevision 和 attempt；不会通过迁移重新生成它们。

## 灰度开关

以下配置启动时读取，修改后重启支持 O6 的 worker：

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `ORCHESTRATION_ENTRY_MODE` | `execute` | `execute` 可提交；`preview`/`closed` 保留规则预览但关闭新统一任务 |
| `ORCHESTRATION_ENABLED_WORKFLOWS` | 全部五种 | 逗号分隔的工作流白名单；空值禁用全部 |
| `ORCHESTRATION_ENABLED_DRIVERS` | 五类驱动全部 | `builtin-llm,claude-sdk,codex-app-server,claude-cli,codex-exec`；空值禁用全部 |
| `ORCHESTRATION_LEGACY_ENTRY_ENABLED` | `true` | 独立关闭旧格式创建、旧规划预览和终态主管分支重试新 Run |

可按规则预览、模型 API、SDK、app-server、CLI 已验证子集逐步开放。模板和驱动限制只检查实际执行成员，候选团队中尚未开放的成员不阻断交给其他人的任务。开关不能放宽原生权限、工具约束、注册 Git 要求或只读 CLI 的限制。

关闭新入口不影响已准入任务的执行、审批、回答、暂停、恢复、取消或安全修订。修订预览使用 `revisionRunId`，服务器验证它是当前房间的已暂停步骤图；该字段不能用于提交新任务。详细 planner 在关闭新入口时不会接受新的规划调用。

幂等查询先于准入开关：相同请求键和载荷仍返回原任务；同键不同载荷仍返回 409；新键被拒绝且不生成 Run。规则预览的配置指纹不包含 rollout，实际提交原子复核当前开关。空房间创建仍是纯元数据操作。

## 旧 API 与迁移观察

`POST /api/conversations`、`/api/runs`、房间 messages 仍兼容旧格式；新版请求仍进入统一执行提交服务。旧格式响应增加 `Deprecation: true` 与 successor-version Link，不指定未经承诺的移除日期。旧 coordination/followup 预览保留其原有规划和响应契约。

`orchestration_entry_statistics` 聚合 endpoint、输入格式、接受/拒绝、HTTP 状态、次数和首次/末次时间。`GET /api/orchestration/entry-statistics` 提供统计；不保存请求正文、用户标识、原始 Header、Token 或账户响应。统计用于 O7 核对旧调用方及弃用清理，本阶段不删除接口。

## 故障恢复边界

- 尚未调用的排队/步骤从持久任务恢复，保持 FIFO 和依赖。
- 模型结果已持久化的 turn 复用结果完成原步骤，不重复模型调用。
- 调用已经开始但结果未记录，成员票据标记中断，Run 进入人工检查，禁止自动重放和直接继续。
- 内置模型已经持久化工具请求、正在等原审批，且无未知工具/原生副作用时，可恢复原审批门控。确认旧成员票据宿主死亡后，让对应 Collaboration attempt 的租约立即进入现有恢复路径，不等待原 5 分钟租期。原审批卡、逻辑工具键及已确认模型响应继续复用。
- 原生审批、未知进程、manual 工具结果不确定或实际写入后账本未提交，继续保留原工作区和围栏。不能因取消任务、关闭新入口或换 worker 而宣布副作用已检查。
- 旧活跃 Run 没有有效执行契约时保持等待，不用当前角色重新规划或补造新契约。

恢复仍由现有 member admission、leases、Runtime holds/wake、Coordination 和 Collaboration 处理；O6 没有创建另一套任务队列或状态机。

## 运维、备份与支持的回退范围

审计命令使用只读 SQLite，不导入会自动初始化的 database.ts，不解密密钥，不调用供应商：

```sh
pnpm orchestration:audit
pnpm orchestration:rollback-check --target o6-compatible
```

输出迁移版本、待迁移房间、活跃任务及契约版本、配置待修复项、需要检查的任务和入口统计。活跃清单不包含目标正文；取消后的未知写入也保留在检查清单。旧库尚未升级时审计只报告 pending，不自动升级。

支持的回退是**保留能识别 O6 数据和 O1–O5 冻结契约的 worker，关闭新请求接入**。完全停止新任务需同时设置：

```sh
ORCHESTRATION_ENTRY_MODE=closed
ORCHESTRATION_LEGACY_ENTRY_ENABLED=false
```

步骤：

1. 运行只读审计，记录活跃任务和检查清单。
2. 正常停止服务，使用[账户 E4 备份](./accounts-migration-phase-e4.md)的 `accounts:backup` 和 `accounts:verify-backup` 保存数据库、角色及私有认证材料；若有活跃原生执行，先由兼容 worker 收敛。
3. 用保留兼容执行代码的 O6 worker 应用上述开关并重启，继续完成已准入任务。审批与人工检查继续按原契约处理。
4. 修复后逐步重开新入口，重新预览；已有历史和任务不迁移到较低版本。

不支持直接切到未验证的 O5/O4/O1 旧二进制，不执行 DROP/删新状态/改写历史快照/数据库降级。`rollback-check --target pre-o6` 等未知目标明确拒绝。O6 guards 无法让未包含 guards 的旧二进制变得安全，必须遵守版本范围。

`pnpm orchestration:migrate` 仅在已由兼容 worker 完成 schema 升级且服务离线时重复映射房间；拒绝活服务、未收敛的原生进程和活跃成员票据。常规升级在启动时自动映射，无需重复手工操作。恢复整个旧备份会丢失备份后的状态，不属于本阶段自动回退路径。

验收证据见 [O6 验收报告](../reports/orchestration-entry-phase-o6-acceptance.md)。
