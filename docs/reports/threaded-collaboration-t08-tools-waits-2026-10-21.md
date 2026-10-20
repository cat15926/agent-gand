# 持续协作 T08：路由、工具、征询与等待验收

日期：2026-10-21（Asia/Shanghai）。代码基于已推送 T07 `a7736984b35babeb7be2f2af29374d2074d0b9cf`，本阶段变更尚未提交推送。结论：T08 普通协作范围实现并通过下列分层验证；生产入场、executor 继续关闭，T09–T12 未交付。

## 实现与合同

新增 v31 路由策略/计划、工具 receipt/私密曝光来源、成员对循环、持久征询/唯一结算/回调、timer/tracking/Decision 及版本化操作账本；旧 v25–v30 迁移源码和 descriptor 不变。冻结实际 v30 升级 v31，验证失败回滚、重复升级、旧 guard 拒写及新消息 writer 重试既有 v30 请求 hash。

15 个协作工具接入 API 与 SDK 0.3.288 的真实 broker。post/final 独立，精确查询、附件、来源、ACK 沿用统一 ACL；工具结果写 native provenance，撤权冷开。串行、独立并行、征询、非阻塞等待与普通 Decision 继承原根，调用/请求预算持续累计。实现契约见 [T08 架构](../architecture/threaded-collaboration-v1.md)。

固定上游 `8b373123323aacd7e2047dab94fdc15b8f7567ae` 重新核对 AgentRouter、IntentParser、a2a-mentions、QueueProcessor、WorklistRegistry 及串/并行路径；未指定意图的多目标默认 ideate，#critique 仅改变提示，最后一个显式意图生效。项目群组替代品种名册；custody-recognition/Action 政策及真正命令代际留 T10，不能算高级业务已实现。

## 隔离验证

| 命令 | 结果与范围 |
| --- | --- |
| `pnpm typecheck` | shared、server、web 通过 |
| `pnpm verify:threaded-collaboration` | 17 组；实际 SQLite/运行时/ACL/工具，41 次注入 HTTP，零真实模型/外网；路由、串并行、循环、跨 Thread、私密/附件、征询、等待、Decision、E01–E06 |
| `pnpm verify:threaded-collaboration-backends` | 4 组；Anthropic/OpenAI HTTP tool loop、实际 SDK worker/CLI + MCP/RPC、真实宿主进程停止和 native anchor；私密工具读取来源撤权后冷开。响应为注入协议，不计真实模型 |
| `pnpm verify:threaded-collaboration-api` | 4 组；Fastify 专用 session/CSRF/version、配置 CAS、preview/接收、生产三配置关闭与 Decision exact-origin/根/重试 |
| `pnpm verify:threaded-migration` | 14 组，含冻结实际 `a773698` v30 的升级与回滚 |
| 预算/队列/运行时 | `verify:threaded-budget` 14、queue 11、runtime 18 组通过 |
| 上下文与后端 | context 14、session-context 13、backends 14、backend-runtime 7 组通过 |
| 消息与访问 | messages 19、message-api 6、message-notifications 9 组及 access 通过 |
| 资源、控制与旧路径 | resources 19、resource-integration 8、legacy-resources 11、lifecycle 21 组，以及 controls、isolation、legacy-boundary 通过 |
| 文档/差异 | 本地链接、原 K01–K16/59 场景与预期逐列保留、既有迁移未改写、行末空白检查 |

loopback/实际 SDK 宿主进程检查在允许本机监听和 ps 的环境执行。它们不连接真实供应商；受限沙箱中拒绝监听导致的 unknown 不计功能通过，已在允许环境完成相同检查。

## 独立可靠性增强

| 用例 | 本次证据 |
| --- | --- |
| E01 | 部分回复后真实 recovery worker SIGKILL；新 worker 恢复同 group/原 deadline/原首答，不重新调用模型 |
| E02 | 可控时钟跨原 deadline，唯一 partial/timeout，保留原不同意见及逐目标状态；结算零合成请求 |
| E03 | 两个实际 SQLite/IPC writer 屏障同时竞争末答和 timeout，一个不可变 settlement/callback；重复恢复和迟到终态不复活 |
| E04 | 新 worker 结算后、通知前 exit32；另测 send-before-ACK 重复提示，settlement、callback、queue 唯一，零模型重放 |
| E05 | pause→waiting；身份不变 resume→delivered；中途 stop 再 resume→cancelled；权限版本变化→rejected；结算与原回应保留 |
| E06 | group 创建 9 类写点、结算及回调 11 类追加写点、Decision/替换等待故障与只读库；失败整体回滚；终态已知结果凭原证明重试零额外模型调用 |

这些是受控时钟、临时 SQLite 与实际子进程故障证据，不等于整个生产服务、真实模型并发和真实领域系统全部故障组合通过。测试断言覆盖记录数、原文、deadline、调用计数和不可变终态；见 [17 组脚本](../../scripts/verify-threaded-collaboration.mjs)与[故障 worker](../../scripts/fixtures/threadedCooperationWorker.mjs)。[隔离取证快照](evidence/threaded-t08-isolated-collaboration.json)保存各表行数/hash、group/target/callback身份、原deadline、受控时钟与请求计数；E06逐故障点前后表快照相同。生成命令为 `pnpm verify:threaded-collaboration --report docs/reports/evidence/threaded-t08-isolated-collaboration.json`，模型响应为注入，快照hash不包含原文导出。

## 授权真实后端验收

使用用户已授权配置账号 `Claude-GML-5.3`（ID `267c2e27-b25f-43cf-acaa-143327f7f714`，configVersion 2、credentialVersion 1），`glm-5.3` / `open.bigmodel.cn` 的 Anthropic 兼容端点，macOS + claude-sdk 0.3.288。只读业务库的 accounts/account_revocations/account_versions/account_credentials，未读取日常会话或消息，未迁移业务库；模型只接收新建合成消息和隔离 SDK 历史。凭据仅在获权端点请求头使用，执行库无凭据密文，SDK 使用空隔离 HOME/工作区及随机 loopback token。

| 场景 | 结果 |
| --- | --- |
| API read_message → post_message → final | 通过；1 Invocation、3 实际 HTTP、1 post 和1逻辑后继，工具读取来源已登记 |
| SDK read_message → post_message → final | 通过；1 Invocation、3 实际 HTTP、MCP/RPC 工具及 native anchor，实际 worker 已核验停止 |
| 首次双成员征询 | 未通过；SDK 成员安全 cancelled，未记录具体触发原因。保留[首次原始报告](evidence/threaded-t08-real-tools.json)，不抹去失败。该隔离场景留1 collecting group、1 cancelled/1 pending target，未触发额外请求 |
| 新隔离场景复验征询 | 通过；API 调用者、SDK/API 两位成员独立回答、唯一 settlement、唯一调用者 callback，共4 Invocation、5实际HTTP；原回答逐字保留，同一根，无额外聚合模型调用。见[复验报告](evidence/threaded-t08-real-consultation.json) |

首次取消的根因未定位，不宣称已修复；runner 现保留白名单内的安全 authority/budget code 供后续诊断。复验是新场景，不冒充原失败运行恢复。原失败 fixture 不接生产且原生进程已停止，不能用它证明真实失败后的恢复闭环。真实 API/SDK 成功工具路径及征询成功路径已通过；失败/恢复窗口依据上节独立隔离证据，T12 保留主服务及真实后端故障矩阵。

只读复核全部 retained execution DB：精确 payload hash、receipt/来源数、原生进程 verified_stopped、凭据行0、复验 settlement/callback/root 唯一和原答一致，见[脱敏审计](evidence/threaded-t08-real-audit.json)。正文、请求头和密钥未导出。临时 fixture 分别保存在系统 temp 的 `agent-gand-t07-real-xea2YI` 与 `agent-gand-t07-real-H7gy2I`；报告是持久化脱敏事实，数据库是本机临时取证材料。

执行命令（复现会产生新的授权用量，不能重置累计 ledger）：

```sh
pnpm threaded:acceptance-real --authorized-real --stage T08 --backend all \
  --account 267c2e27-b25f-43cf-acaa-143327f7f714 --token-limit 200000 \
  --token-ledger /tmp/agent-gand-t07-authorized-token-ledger.sqlite \
  --report /tmp/threaded-t08-new-run.json --keep-isolated-evidence
# 仅重建征询场景时追加 --case consultation；工具场景可用 --case tools
```

## 用量与剩余范围

用户授权总 input+output 上限 1000 万 token，本轮沿用 T07 的更严格累计门禁 20 万。每次实际请求按完整 HTTP body 字节数 + output cap + 8192 先预留，确认 input+output 后结算；未知保留。ledger 为 `/tmp/agent-gand-t07-authorized-token-ledger.sqlite`，不是模型费用账单。

| 维度 | 已确认 token | 未知预留 | 保守累计占额 | 实际 HTTP |
| --- | ---: | ---: | ---: | ---: |
| T07 既有验收 | 13,560 | 39,010 | 52,570 | 10 |
| T08 首次（含取消场景） | 16,429 | 0 | 16,429 | 9 |
| T08 征询复验 | 6,328 | 0 | 6,328 | 5 |
| 合计 | 36,317 | 39,010 | 75,327 | 24 |

T08 新增14实际HTTP、22,757已知token，无新增未知预留。未知计费仍按根政策保留微美元占额；合成征询根显式使用10,000,000 microusd未知费用容额以完成多请求，未改全局20万token门禁，不构成供应商价格承诺。

T09 UI/回执/重连为下一项。T10 Action、业务完成谓词、命令代际、真实 GitHub tracking，T11 Review/Revision/SOP/知识及 T12 综合发布仍待实施。W04 没有被 timer 或 tracking 代替；W05 的 PR producer 仅注入传输通过。Linux/WSL/Windows、其他供应商与原生 driver、真实自动压缩、主服务完整崩溃和真实业务闭环不在本次通过声明。全部 16 条 K 与原 59 项场景/预期不改写，不以阶段子项通过替代整项验收。
