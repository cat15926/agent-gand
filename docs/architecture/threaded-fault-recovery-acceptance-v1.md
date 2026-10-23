# 持续协作 RC05：故障与恢复验收合同 v1

日期：2026-10-23（Asia/Shanghai）。本合同约束隔离验收，不是日常启用配置。schema 保持 v35，历史迁移不改。原 K01–K16、59 项场景及预期保持原文。

## 故障边界与裁决

| 已有可信事实 | 恢复允许行为 | 禁止推断 |
| --- | --- | --- |
| Attempt 已领取，仍为 prepared/not_started，未跨外部请求屏障 | 核实原资源状态后，在同 Invocation、Run、causal root 下创建替代 Attempt；原准入和预算累计 | 因租约过期就认定未发送；另开根清空预算 |
| 生成请求的发送意图与授权已提交，配置供应商已返回响应头，但父进程在完成回执前死亡 | 新 index 保留 request/Attempt/Invocation/资源与未知用量围栏，不自动重放 | 响应头、异常、进程退出、TTL 或重新批准可证明免费/未发送 |
| 响应、终态、Run、后继 wake 已提交 | 原响应按 source Attempt 唯一；恢复只修投影和已核实的资源释放，后继仍用原 root | 不同成员输出相同文本就是原响应重复；新用户根可替代后继 |
| 供应商已回包，但 SQLite 拒绝回执/未知记录写入 | 不发布成功；写能力恢复后从原发送屏障恢复 unknown，零盲重发 | 把内存中的成功响应当作持久成功；将回执落库失败记为零费用 |
| 终态事务某个写点失败 | 输出、响应、后继、终态、Run 与本次 outcome 原子回滚；此前独立核实的实际用量保留 | 通过回滚已核实用量来“退费” |
| 父 index 死亡且原生 guardian 的 IPC 丢失 | 宿主核查原 token、host、PID/PGID 的实际停止；未对账请求仍 unknown | 进程组已停等于持久 `registered` 已核实、请求结果已知或可释放围栏 |

实际主入口是 `apps/server/src/index.ts`，保留其单例、全部启动/恢复顺序、HTTP 路由及生产授权。preload 仅设置临时路径、固定账户/release pack 和故障屏障。配置与数据库初始化完成后删除 `AGENT_GAND_ISOLATED_WORKER`，执行阶段不使用 fixture 绕过。生成请求故障屏障必须位于 `/v1/messages`，不能把 `count_tokens` 请求伪作 SDK 生成中断。

## 本轮生产修复

1. `cooperation.ts`：missed timer 恢复除合法时间范围、来源与身份外，还要求持久 `record.kind=timer`、原整数 `seconds` 与 `deadline=created_at+seconds*1000` 一致。正常记录原本不可变；该检查防御畸形旧记录/导入，不声称普通工具能篡改原 timer。无迁移、无重新准入或期限延长。
2. `runtime.ts`：发前执行失败可能已登记 unknown，而初始模型请求授权仍为 reserved。恢复保留原 outcome_kind/hash/first cause，不用另一条 `PROCESS_RESTART_UNKNOWN` 再结算同一未知事实；从未登记 outcome 的崩溃仍走原恢复路径。未知财务和活动预留不释放。
3. `index.ts`：旧 durable hold 后台恢复在 SQLite READONLY 时原先会抛出未捕获异常并退出整个服务。两个既有后台恢复 tick 现在仅捕获 READONLY/BUSY/LOCKED/FULL/IOERR/CANTOPEN 及细分类的操作性 SQLite 错误，记录固定 tick 名与错误码，结束当前 tick、等待原周期；没有即时重试或补成功。其他异常、启动时恢复/迁移仍 fail-fast。慢 SSE + READONLY 在实际 index 上保留修复前 EXIT1 和修复后证据。

## Timer、SLA 与活动预算

停机恢复分别验证 fireAt 之前/等于/之后，以及 SLA 之前/等于/之后。重建保持 wait、根、准入与原时间基线；有效窗口内至多一个回调消息/wake，SLA 等于或之后不再派发。来源授权 unknown/失效、owner/成员身份变化、Action 代际漂移均须逐项拒绝。在线已启动的 one-shot timer 与 missed-timer 恢复窗口分别留证，不能混称一个统一硬 SLA。

生产默认活动片仍为 1000ms。心跳可续异步请求，但不能在同步阻塞期间执行。验收故意注入 1250ms 同步准备：默认片过期应失败闭合并保留 unknown，不能宣称该长准备可用性已解决。选定合成根通过正规 Owner CAS 使用 10000ms 片，其他请求/Invocation/Attempt/token/费用/总活动与绝对 deadline 限制保持。较长片不能绕绝对 deadline。

## 真实账户、账本与证据分层

真实调用沿用用户对已配置账户及总 1000 万 token 的授权。本轮选择原共享账本、累计 **500000 token 保守门禁**；T12 runner 的 200000 是当时该工具的局部门禁，未修改其代码或历史结论。本轮开始账本为确认 63336 + 未知预留 89758 = 153094；旧行逐字节保持。新未知请求按单独 request authorization 先预留再发送，只有原请求可信 token 回执可转 known；无价格的费用继续保守预留。较低本轮门禁选择与最终增量写入报告，不重置账本或释放旧 unknown。

只读取日常账户配置、选定版本/加密凭据和撤销状态，不读取日常消息。真实明文凭据只经父子私有 IPC 与配置端点的认证头使用；子库用父进程内随机临时主密钥重新加密，同轮重启复用该内存密钥，结束销毁。凭据、主密钥和临时管理会话不得出现在 argv、环境、报告或日志。所有消息/会话/工作区/数据库均为隔离合成数据。

| 证据层 | 可证明 | 不能替代 |
| --- | --- | --- |
| 等待与活动 factory、SQLite 重建 | 精确可控时钟边界、来源/身份/代际、真实 elapsed 和重复恢复 | index PID 重启、真实供应商行为 |
| 真实 SQLite 故障 | READONLY、独立 writer 的 BUSY、临时 max_page_count 的 FULL、实际触发器 ABORT 的原子回滚 | 填满宿主磁盘、断电、物理 fsync/介质损坏 |
| 实际 index + 注入响应 | 生产单例、HTTP 授权、恢复顺序、真实 PID/SIGKILL/宿主停止 | 真实供应商用量或自然模型审批 |
| 实际 index + 配置供应商 | 本轮精确请求及故障窗口、唯一响应/后继、SDK 中途进程与未知费用保留 | 所有账户、平台、故障组合、原生压缩或自然 PR 事件 |

审批故障钩子在真实运行 Binding 上调用生产 lifecycle 注册 pending approval，验重启后旧会话/审批不能恢复已死 driver；它不宣称自然模型触发审批。RC04 两次自然 HEAD、RC06 工程并发、RC07 压缩、RC08 征询原取消及 RC09 未知费用对账仍各自单验。默认关闭与日常未配置/迁移/启用保持。

## 可复现入口

普通专验：`pnpm verify:threaded-rc05-waits`、`pnpm verify:threaded-rc05-storage`、`pnpm verify:threaded-rc05-activity`、`pnpm verify:threaded-rc05-main`、`pnpm verify:threaded-rc05-main-waits`。普通命令只注入模型传输，不读取真实凭据。

真实主入口显式命令：

```sh
pnpm verify:threaded-rc05-main -- --authorized-real \
  --account 267c2e27-b25f-43cf-acaa-143327f7f714 \
  --token-ledger /tmp/agent-gand-t07-authorized-token-ledger.sqlite \
  --token-limit 500000 --report /tmp/rc05-real-new-evidence.json
```

该命令会计费并制造受控中断，应沿用已有授权且先核对共享余额；不覆盖先前报告。参数 `--case` 可限定单个故障，最终逐例范围以[实施报告](../reports/threaded-collaboration-rc05-fault-recovery-2026-10-23.md)和对应 JSON 为准。
