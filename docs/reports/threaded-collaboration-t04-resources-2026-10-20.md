# 持续协作 T04 共享资源验收记录

日期：2026-10-20（Asia/Shanghai）。范围：共享资源协调器、混合模式竞争、Session 身份准备、容量、公平性、围栏和旧执行路径接线。

## 基线与结果

已按用户要求提交并推送 T03：`c3b36db`，`feat(threaded): add T03 trusted execution lifecycle`，远端 `origin/main`。T04 基于该提交实施，代码、测试和文档留在工作区，未提交/推送 T04，未回写 Issue。

新增 [v27](../../apps/server/src/db/executionResourcesMigration.ts)；v25/v26 与历史 descriptor/checksum 不改写。实现说明见 [共享资源合同](../architecture/threaded-resources-v1.md)。生产旧模式进入共用协调器；新模式已有资源端口，工作入场、自动调度与真实 executor 仍关闭。

## 隔离验证

| 检查 | 结果与可证明范围 |
| --- | --- |
| `pnpm verify:threaded-resources` | 通过，19 组；真实 SQLite 多连接/多进程屏障竞争、同槽单所有者/跨 Thread 并发、旧 exclusive 屏障、持久轮转、eligibility 恢复保留年龄、原生 ID 锁、目录读写/重叠、全资源事务、容量、父子围栏、TTL unknown、持久证明与代际、通知重入和恢复扫描、工具运行/待对账及证明到释放间隙的保留 |
| `pnpm verify:threaded-resource-integration` | 通过，8 组；真实 Session CAS/冷开 UUID/版本历史/API null 绑定、canonical 路径变化拒绝、资源与 Run/Attempt 共同回滚、started/unknown 接线、已静止终态与晚到副作用隔离、未知进程不释放和意外 nativeId 对账；proof 已签发但响应尚未提交时的 stop/撤权/晚到 unknown 竞争 |
| `pnpm verify:resource-late-session` | 通过，3 组；旧 native 精确 execution ID 的晚绑定、其他进程/无父/无确切容量调用拒绝、Threaded 不接受晚绑定兼容字段；子准备不重复占容量 |
| `pnpm verify:legacy-resources` | 通过，11 组；临时库真实旧 member/budgetedChat/资源桥，fake provider 实际 Promise 静止与外层 abort 区分、工作区整组领取、原生登记证据与新旧混跑、turn/Scoped 冷会话锁、旧 lease 父子目录/read 互操作和 nonce 释放 |
| `pnpm verify:threaded-migration` | 通过，10 组；包含冻结 T03/v26 程序真实拒绝 v27、前向幂等、故障回滚、历史 checksum 与约束 |
| `pnpm verify:threaded-lifecycle` | 通过，保留 T03 21 组 fake 生命周期回归 |
| `pnpm verify:threaded-controls` | 通过；改为真实共享资源单例，专用 HTTP、兄弟隔离、账户撤销/回滚及生产恢复，零外部请求 |
| `pnpm verify:threaded-isolation`、`verify:threaded-access`、`verify:threaded-legacy-boundary` | 通过；旧路径、HTTP/WS、owner/CSRF 与关闭入场边界 |
| `pnpm verify:runtime-run-policy`、`verify:runtime-action-commands`、`verify:runtime-terminal`、`verify:runtime-hold-recovery-v2` | 通过；旧策略、动作、终态和持久等待恢复 |
| `pnpm verify:execution-timeouts` | 通过；显式结束超时后的 fake provider 再进入后继 case，费用 unknown 保留；等待成员时 abort 会持久取消旧/新 ticket，不阻塞后继 |
| `pnpm verify:claude-sdk-session-protocol`、`verify:scoped-native` | 通过；SDK Session 参数和 Scope 冷会话/本地 fake SDK、Codex、loopback 协议，供应商请求为 0 |
| `pnpm verify:external-agents-d`、`verify:accounts-e2` | 通过；临时目录中的本地 fake SDK/进程恢复、Session resume、dirty worktree、双账号和 driver 隔离。宿主进程身份检查在获准的沙箱外执行，未连接真实模型 |
| `pnpm typecheck` | 通过；shared/server/web |
| `pnpm verify:docs`、`git diff --check` | 通过；本地文档链接与差异空白，新增文件另检 |

所有数据库、Agent 目录、Session/工作目录为临时隔离路径。未读取或迁移日常业务库，未调用真实模型、账号登录或 SDK 服务；多进程资源测试用可控 IPC 屏障，不以延时猜测获锁顺序。原生登记 fixture 的证据和真实 SDK 进程验收分开记录。

交叉复核补充并修复：重复 eligibility 通知造成微任务忙循环；native 静止证明必须匹配确切 execution ID；已签发静止证明与控制/撤权竞争时保留静止事实而不回滚控制；仍可恢复的旧准备 ticket 禁止策略改版，以免恢复时意外采用新策略。内置工具仍 running/needs_attention 时，准备资源在签发证明及释放时均保留，工具状态提交后重试已有 pending cleanup。各项保留负向回归。

## 差异及结论边界

新 Threaded 按完整资源集一次领取；旧模式为维持整个 turn 的 Agent exclusive，保留分阶段准备的兼容桥：父准备不计模型容量，root/shared workspace 合组，真实 Session 单独互斥，实际调用唯一占额。有活动子 claim 的父 claim 不得签发静止证明或释放。旧 Codex 的启动后 ID 仅通过确切旧 execution 关联提升，冲突停止并保留围栏，不能作为新模式支持 Codex 的证据。

过期没有抢占权限。旧 provider 外层超时已返回但实际 Promise 尚未结束时，资源与父围栏仍保留；只在实际结束并生成受信收据后释放。重启丢失 provider 收据时继续 unknown，不为恢复吞吐量猜测退出。原生执行按确切进程登记、已停止和恢复状态验证。共享容量只算实际调用，未实施 T06 的根预算、token/费用累计账本。

生产仍是一宿主、一活动服务进程；共享单例主动通知加持久游标修复。跨进程竞争测试证明 SQLite 领取安全，不能冒充跨 worker 通知 transport 或 T06 Wake drain 已交付。策略下的更低账号/供应商限额需受信配置，不自动发现供应商配额。

| 原验收 | 本轮结论 | 保留后续责任 |
| --- | --- | --- |
| Q01–Q03 | 资源互斥、并发、FIFO/屏障/轮转与旧桥子场景通过 | T06 的真实 Wake 调度、T07 后端 |
| Q04 | 真实 ID 互斥、准备 CAS/复验、意外 ID 保留围栏通过 | T07 真实 SDK cold/resume、内容和恢复锚点 |
| Q05 | 同进程主动通知、重入与持久扫描通过 | T06 drain/消息提交竞态，不宣称跨 worker transport |
| Q06、REC02/REC03/REC05 | 资源 generation/proof、unknown 与重启恢复子场景通过 | T06 完整恢复与 T07/T12 实际后端/平台 |
| ISO03–ISO05 | 持久资源进入授权、控制、响应终态事务 | T05/T06 的消息/Outbox，T07 真正副作用 |
| DB03 | v27 及旧版本拒绝通过 | 后续迁移逐版验证与发布回退演练 |

K01–K16 和原 59 项场景/必须观察结果保持不变。E01–E06、高级语义记忆、Collective、扩展载体及其他操作系统没有因本轮资源验证升级为可用。下一项 T05，详见[实施状态](../plans/threaded-collaboration-implementation-status.md)。
