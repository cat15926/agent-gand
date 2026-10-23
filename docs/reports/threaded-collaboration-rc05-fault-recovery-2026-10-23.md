# 持续协作 RC05：实际主入口、供应商与故障恢复

日期：2026-10-23（Asia/Shanghai）。状态：**三处生产修复及所列分层验收完成；仍有明确可用性限制、未定位历史真实超时和未知用量，不能宣告完整模式或生产发布通过。本轮 RC05 变更未提交。**

本轮先将 RC04 提交并推送到 `origin/main`：`d831a70`。RC04 的 609 秒/71 GET、0 新 HEAD、`not_observed` 保持，未以 RC05 代替两次自然 HEAD 的真实链验收。本轮不启动 RC06 或日常发布，不改日常配置/数据库；schema 仍 v35、历史迁移不变。验收原则及范围见[故障恢复合同](../architecture/threaded-fault-recovery-acceptance-v1.md)。

## 生产修复与原因

1. **missed timer 精确原基线。** `cooperation.ts` 现校验原 `record.kind/seconds` 与 `created_at/deadline` 的精确一致性，不能只凭一个落在 5 秒–1 小时的合理时间恢复。既有行的基线本就不可变；新增防御针对畸形旧记录/导入，不声称普通工具可改原 timer。SLA、原来源、身份和 Action 代际检查保留，退休不会重新扣准入或创建根。
2. **已登记 unknown 不重复结算。** 默认 1 秒活动片下 1250ms 同步准备在发前失败时，Attempt/活动可已 unknown，而初始请求授权仍 reserved。旧恢复用另一条 `PROCESS_RESTART_UNKNOWN` 再结算，触发 `THREADED_BUDGET_SETTLEMENT_CONFLICT`。`runtime.ts` 现保留原 outcome_kind/hash/first cause；未登记结果的新崩溃仍按原恢复路径处理。重复恢复不释放未知活动、token、费用或资源围栏。
3. **后台存储错误不越出 tick。** 慢 SSE + SQLite READONLY 在实际 index 上复现旧 `recoverDurableHolds` 定时器未捕获异常、退出整个服务。[修复前证据](evidence/threaded-rc05/main-streamed-receipt-io-before-fix.json)保留 `EXIT1` 与调用栈。`index.ts` 的两个既有恢复定时器仅捕获操作性 SQLITE READONLY/BUSY/LOCKED/FULL/IOERR/CANTOPEN 及扩展码，固定任务名/错误码日志，终止当次、等下一原周期；没有立即重试或补成功。非存储错误及启动恢复/迁移仍 fail-fast。[修复后慢 SSE](evidence/threaded-rc05/main-streamed-receipt-io.json)与[真实回包拒写](evidence/threaded-rc05/main-live-receipt-io-after-fix.json)分别通过。

## 分层验收

**新增专验 51 组、相关回归 99 组，共 150 组通过。**这是各脚本分组数，不是原 59 项或 150 个互不重复的业务合同。下列最终通过 scope 的实际 index 验收共 **58 PID**；不含失败开发轮次或历史回归 PID，不是全局进程总数。

| 层级 | 组数 | 证据与准确边界 |
| --- | ---: | --- |
| 等待/来源/SLA | 9 | [waits](evidence/threaded-rc05/waits.json)：20 case、22 次本地脚本请求；fireAt/SLA 前/等于/后、来源授权 unknown/漂移、身份/owner 不可变、畸形基线、暂停撤权及 Action 正常 return 后代际漂移。factory/SQLite 重建，不是 PID 或真实供应商 |
| 存储/审批/撤权 | 10 | [storage](evidence/threaded-rc05/storage.json)：真实 READONLY/BUSY/FULL，六处 SQLite ABORT 原子回滚、发送屏障/回执拒写、提交后释放故障、审批与三类撤权；production factory、注入传输 |
| 活动片/绝对期限 | 5 | [activity](evidence/threaded-rc05/activity.json)：真实 elapsed；异步 1600ms 默认片可续，同步 1250ms 默认片发前阻断；显式 10 秒片成功；发送后过片保留 unknown；较长片仍守绝对 deadline。传输为注入 |
| 实际 index，注入传输 | 10 | [main-injected-post-fix](evidence/threaded-rc05/main-injected-post-fix.json)：19 PID；prepared/终态/可能发送/API/SDK/审批/撤权/入口拒写/回执拒写/默认与目标活动片。保留全部生产启动顺序、单例、HTTP/session/release/authority；无隔离执行绕过 |
| 实际 index，停机 timer | 6 | [main-waits](evidence/threaded-rc05/main-waits.json)：18 PID、12 次 SIGKILL；受控时钟 fireAt−1/=/+1、SLA−1/=/+1。实际 active Binding 上调用真实 hold 工具，初始响应注入；两次恢复/重复扫描 0 新请求/准入/根，窗口内至多一个回调/消息/wake。不是自然模型触发 hold |
| 实际 index，慢 SSE 拒写 | 1 | [streamed I/O](evidence/threaded-rc05/main-streamed-receipt-io.json)：2 PID，本地注入慢流跨后台 tick，READONLY 期间无虚假终态、写能力恢复后重启 unknown 零重发 |
| 实际 index，配置供应商核心故障 | 7 | [main-live-second](evidence/threaded-rc05/main-live-second.json)：14 PID，真实账户/配置模型/真实 API 与 SDK；生成请求故障边界排除 count_tokens |
| 实际 index，配置供应商活动片 | 2 | [main-live-activity](evidence/threaded-rc05/main-live-activity.json)：3 PID；默认 1 秒长同步准备零外发并保持原 unknown 原因；显式 10 秒片下同准备后一次真实供应商请求成功 |
| 实际 index，真实回包后拒写 | 1 | [main-live-receipt-io-after-fix](evidence/threaded-rc05/main-live-receipt-io-after-fix.json)：2 PID，真实生成响应头后 SQLite 拒写，无成功响应/终态，重启与重复扫描 unknown 不重放 |

相关回归分别为 [budget 14](evidence/threaded-rc05/regressions/budget.json)、[runtime 18](evidence/threaded-rc05/regressions/runtime.json)、[RC03 waits 14](evidence/threaded-rc05/regressions/rc03-waits.json)、[collaboration 17](evidence/threaded-rc05/regressions/collaboration.json)、[production 16](evidence/threaded-rc05/regressions/production.json)、[release 7](evidence/threaded-rc05/regressions/release.json)、[actual main 4](evidence/threaded-rc05/regressions/main-process.json)、[service recovery 9](evidence/threaded-rc05/regressions/service-recovery.json)。旧脚本固定输出的历史报告已逐字节还原，新结果独立存放。server typecheck、文档链接和差异检查另做交付核验。

### 真实主入口的核心判据

- prepared 崩溃点无模型请求；恢复同 Invocation、Run、root，仅替代 Attempt，一次真实外发。
- 终态后崩溃按原 source Attempt 核对唯一响应，两条原/后继 terminal 与 Run 均 completed、同 root，原模型请求不重放。不同成员答复可有相同文本，不能仅按 body 判重复。
- API 与 SDK 都在实际生成响应头后杀父，持久发送屏障已存在、回执未完成。SDK 已登记原 guardian token/host/PID，宿主实际检查原 PGID 无存活成员；新 index 仍保留 registered/unknown 和预算围栏，不冒充持久停止核验或费用对账完成。
- 审批在真实运行 Binding 上通过生产 lifecycle 故障钩子注册 pending；跨重启旧 Owner session 401、新认证批准 409，不能复活死 driver。账号撤权不发布旧结果。没有声称自然模型触发审批。
- 存储故障时没有成功响应或终态；修复写能力后以原发送屏障恢复 unknown，0 新请求。已核实 token 与未知价格/执行状态分开保留。

## 失败证据与限制

开发失败没有覆盖或改写：

| 原始记录 | 观察与处理 |
| --- | --- |
| [发送前驱动首轮](evidence/threaded-rc05/main-prepared-driver-first.json) | 驱动串行等待即将冻结的控制 HTTP 回执而超时；改为先收持久边界再杀 PID，后续通过。没有真实供应商请求 |
| [注入首轮](evidence/threaded-rc05/main-injected-first.json) | 终态场景用户提示直接带另一成员 mention，与显式目标冲突，入口正确 409；修改测试提示的表达，不放宽路由规则 |
| [真实首轮](evidence/threaded-rc05/main-live-first.json) | prepared 已过，terminal 驱动把后继返回相同文本误当原响应重复；按 source Attempt/Invocation/Run/root 改断言，原报告与 831 已知 token 保留 |
| [真实拒写首轮](evidence/threaded-rc05/main-live-extended.json)、[第二轮](evidence/threaded-rc05/main-live-extended-second.json) | 各 `RC05_TIMEOUT_facts`，各新增 12918 token 未知预留，仍未最终定位原超时。第二轮安全阶段诊断仅含操作名。不能因为随后复现本地 timer EXIT1 或新真实场景成功，就宣称原两次超时已证明同根因或释放旧请求 |
| [慢 SSE 修复前](evidence/threaded-rc05/main-streamed-receipt-io-before-fix.json) | 明确调用栈定位 legacy durable hold tick 的 SQLITE_READONLY 未捕获退出；与原两次真实 timeout 分开记证 |
| [main-waits 沙箱首轮](evidence/threaded-rc05/main-waits-sandbox-denied.json) | 本地监听 EPERM；获准原生本机隔离验收后通过，不伪作生产缺陷 |

默认 1 秒同步长准备可用性仍有限：本轮实际 index 明确验证其失败闭合，不是已经支持任意同步长准备。Owner 显式 10 秒只覆盖本轮选定合成根；其他预算及绝对期限没有放宽，目标日常配置仍待 RC11/RC12 选择和验证。

SQLite FULL 是临时 `max_page_count` 容量上限，BUSY 来自独立 writer，ABORT 为实际 SQLite 触发器；不宣称填满宿主磁盘、物理断电/fsync/介质故障已验。平台仅 macOS，选定账户的 `glm-5.3` Anthropic-compatible API 与 SDK 0.3.288；不覆盖其他后端/账号/平台或任意故障组合。SDK 原生自动压缩、工程并发、征询原取消和综合发布仍按 RC06–RC12/EXT 单列。

## 费用与权限边界

沿用用户“已配置账号都可用、1000 万 token”授权，选择 `Claude-GML-5.3` 账号 `267c2e27-b25f-43cf-acaa-143327f7f714` 和其已配置 `open.bigmodel.cn` 端点。本轮选择累计 **500000** 保守门禁；未修改 T12 旧 runner 的 200000 局部门禁，也没有重置共享账本。

[账本核验](evidence/threaded-rc05/ledger.json)用所有本轮 request authorization 重建原 33 行并比对首轮原 SHA256，完全不变；共新增 14 个请求预留，7 个有可信 token 回执、7 个仍未知。

| 项目 | 确认 token | 未知预留 token | 保守累计 |
| --- | ---: | ---: | ---: |
| 本轮之前 | 63336 | 89758 | 153094 |
| 本轮新增（含失败） | 1845 | 97271 | 99116 |
| 当前共享账本 | 65181 | 187029 | **252210** |

距离本轮 500000 门禁仍有 247790；这只是门禁余量，不授后续自动调用。旧 89758、两次未定位 timeout 及新受控中断均保留；没有推断免费、退款或释放 unknown。供应商实际价格未知时，执行完成/已知 token 也不等于费用已知。最终对账仍 RC09。

日常数据库仅以 readonly 读取选定账号配置、版本/加密凭据和撤销状态；不读日常消息，不触发日常迁移。父进程凭据加载器沿用既有主密钥配置；供应商 key 及子库随机临时主密钥只经私有 IPC 传入子进程，不进其 argv/env/报告，子库重新加密并在结束删除。临时 cookie/CSRF 与主密钥做报告排除。没有 PR/comment/review/branch 等远端业务写操作。

## 交付与剩余范围

代码、脚本、合同、运维手册、实施指导/状态/剩余计划与兼容矩阵已同步。[原文不变证据](evidence/threaded-rc05/original-text-invariance.json)独立确认 16 条核心合同与 59 项 scenario/expected 和 RC04/HEAD 完全相同，canonical SHA256 为 `7c0b897370f11707c6204bbf954a1ba0e6efd9df76863815750af55eb63e952e`。

本轮变更未提交；日常仍默认 closed、未配置/迁移/启用。RC04 自然双 HEAD、未定位历史真实 timeout、默认 1 秒同步准备可用性、SDK 持久停止事实与未知费用处置没有被本轮通过数字消除；完整模式与发布目标继续见[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。
