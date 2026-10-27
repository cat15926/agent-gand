# RC11 发布准备与隔离恢复验收

日期：2026-10-28。基线：RC10 `ffcbbca` 已提交并推送 `origin/main`。本轮新增预检和演练资产，代码 schema 仍为 35，默认 `closed`；未修改日常数据库、配置或服务进程。

**结论：RC11 的准备工具和所列隔离演练单独交付，目标部署退出条件尚未完成。** RC10 的三次真实综合链失败及原有发布阻断继续保留；不由本轮结果宣布完整模式可用或进入 RC12。合同见[发布准备合同](../architecture/threaded-release-preparation-v1.md)，操作见[运维手册](../operations/threaded-release-runbook.md)。

## 1. 实施范围

- 新增显式目标清单的只读预检：检查路径、schema 历史、全模式运行元数据和不可核实项，不解密凭据、不读日常消息正文、不触发自动迁移。
- 新增独立合成环境的匹配备份/恢复演练：SQLite 一致副本、配套目录和原路径恢复、真实 v34→v35 迁移、旧 worker 拒绝，以及迁移后的新数据和 unknown 保全。
- 新增实际 `index.ts` 的模式演练：observe 中协作业务表不变；closed 中旧模式历史入口保留、拒绝新 threaded 入场。模型传输为注入，无真实供应商调用。

账户备份工具只覆盖其登记的 SQLite、账户目录、角色、头像和专用旧原生目录。RC11 额外登记工作区、产物、threaded Session、发布配置和源码。SQLite 副本完整不等于跨目录一致，目录存在不等于密钥或 Session 匹配。

## 2. 分层验证

| 层次 | 命令与证据 | 结果与边界 |
| --- | --- | --- |
| 只读预检 | `pnpm verify:threaded-rc11-preflight`；[证据](evidence/threaded-rc11/preflight.json) | **18 组通过**；字段缺失、自报ready、路径/链接/覆盖、迁移缺行/篡改、未知责任、宿主不可核实、密钥文件冒用、RC10篡改/伪造与WAL零打开检查；元数据检查不签发生产许可 |
| 匹配恢复 | `pnpm verify:threaded-rc11-restore`；[证据](evidence/threaded-rc11/restore.json) | **7 组通过**；238 表完整逻辑快照、17 个 v25–v34 历史迁移片段哈希不变，真实 v34→v35 迁移/失败回滚；旧 v34 兼容与迁移函数拒绝 v35 且零修改，未启动旧完整服务 |
| 实际服务模式 | `pnpm verify:threaded-rc11-modes`；[证据](evidence/threaded-rc11/modes.json) | **6 组通过**；3 个实际 index PID，3 次合成注入 HTTP，0 次真实供应商请求 |

恢复演练调用实际 `backupAccounts` / `verifyBackup`，在临时原路径验证合成 AES 密钥/身份目录匹配及损坏备份拒绝。原生 Session、工程和产物另包校验，均为合成文件。先独立保存 v35 增量集合，才整组恢复旧备份；再恢复 v35 集合，核对两笔 unknown 的 1,554 output token / 24,690 微美元预留与两项 active Action 保持。它验证保存和恢复，不执行未知请求或供应商费用对账。

模式演练在导入数据库和服务前重定向并断言可写路径均位于临时目录，跳过日常 `.env`；随后删除隔离 worker 标记，使用实际 production factory、入场、调度与恢复门禁。observe 自然跨过 5 秒 timer deadline，再执行通知、唤醒、恢复和 startDispatch 提示，**100 张 threaded 表、9 张共享资源表及 unknown claim 不变**；排除允许变化的 availability 提示和宿主登记。九类业务写均返回 403，零凭据解密、零外呼。closed 明确暂停派发，拒绝新房间/新根，旧消息精确重试仍返回原回执；pipeline、supervisor、collaboration 的历史 HTTP 读写和新空房间通过，不冒称旧模式模型执行、自主模式完整回归或旧新真实供应商混跑。

恢复有两次[夹具调试失败](evidence/threaded-rc11/restore-fixture-failures.json)：种子列名错误，以及检查备份时 SQLite 生成 sidecar 导致清单校验拒绝；后者改为在独立检查副本打开 SQLite，原备份包保持不变。模式演练的六次环境/夹具失败和一次补共享资源审查前的成功见[运行历史](evidence/threaded-rc11/modes-history.json)，包括 loopback sandbox 拒绝、字段/HTTP 参数/断言错误和角色元数据不完整，均单列且不计最终通过组。预检首轮测试自身PID被sandbox拒绝，允许该只读探测后通过；这不等于日常宿主已验证。最终为18＋7＋6＝31组分层检查，历史 T12、RC03 和 RC09 证据不重计。

### 候选目标的只读发现

实际执行 `pnpm threaded:release-preflight discover --repo /Users/ruhonglin/lhz/agent-gand`，再对发现的显式[候选清单](evidence/threaded-rc11/preflight-target.json)执行`check --target`；检查退出2是预期阻断，见[发现记录](evidence/threaded-rc11/preflight-target-discovery.json)和[预检结果](evidence/threaded-rc11/preflight-target-result.json)。发现过程读取配置文件以仅提取允许的路径/模式，不解析、输出或使用凭据值。

| 项目 | 本轮事实 |
| --- | --- |
| 候选数据库 | `/Users/ruhonglin/lhz/agent-gand/apps/server/data/agent-gand.sqlite`；只读20字节文件头和文件/sidecar元数据，WAL格式导致SQLite连接前拒绝，未获取schema/业务计数 |
| 模式与发布清单 | 仓库候选配置`closed`，release pack未选择；不据此推断其他启动方式/环境覆盖下的实际服务配置 |
| 配套目录 | private、roles、sandbox存在；默认managed workspaces、专用Codex/Claude home不存在，仅登记候选覆盖缺项，不推断已启用或丢失真实原生会话 |
| 准备判定 | `preparationPassed=false`、`targetReleaseReady=false`；RC10门槛和匹配备份/恢复、迁移/旧worker、目标closed/observe证据缺口全部保留 |

没有为取得绿色结果而创建日常目录、改journal模式、checkpoint、删除sidecar或启动服务。普通rollback格式的SQL盘点应在静止数据库或一致副本执行：文件头检查与SQLite打开没有跨进程锁，不能保证并发切换journal模式下的字节级不变。工具保守拒绝重叠组件目录；合法嵌套工作区仍须显式覆盖方案，这不是产品不支持嵌套工程的结论。

## 3. 目标部署剩余操作

| 顺序 | 待完成内容 | 当前门槛与退出证据 |
| --- | --- | --- |
| 1 | 关闭 RC10 的发布阻断 | 补齐声明范围的真实综合链及各项未完能力/组合；历史失败和 unknown 保留原处置 |
| 2 | 明确目标运行版本与完整路径 | 固定实际启动环境、源码/依赖、全部 workspace/artifact/native 和旧 pack；自动发现结果仅是候选目标 |
| 3 | 全模式静止与一致备份 | 正常停服；核对旧/自主/手动任务、原生进程及外部副作用，未知项逐项处置；保护匹配密钥和目录 |
| 4 | 在隔离副本完成目标数据恢复 | 完整性、原路径、密钥解密、Session/工作区、授权/预算/unknown 一并匹配；保全备份后新增集合 |
| 5 | 目标 v35 迁移与模式验收 | 兼容版本执行前向迁移，旧 worker 零修改拒绝；先 closed/observe 核对，再明确记录 RC11 退出结果 |
| 6 | 单独进入 RC12 | 选定新 Thread 小流量、停止入场/暂停派发/排空与兼容应用回退；本轮未执行 |

`observe` 只承诺协作业务路径不写，主服务仍可能初始化 schema、登记宿主并恢复旧模式。`threaded_only` 排空不等于整库安全回退。未知执行和费用不能因新演练成功而清零，恢复历史数据库也不撤销远端已发生的操作。

## 4. 费用与范围

本轮真实供应商请求为 0，不使用已配置 API/SDK 凭据，不修改共享验收费用账本。RC10 结束时账本为 111 行，已知 295,127＋保留预留 293,955＝保守占额 589,082 token；原授权总额 1,000 万、内部累计保护线 100 万保持不变。16 笔保留预留中包含 RC10 的 3 笔可能已发和 1 笔本地未外发保留项，不将后者误称为远端未知执行。

本轮[矩阵审计](evidence/threaded-rc11/matrix-audit.json)仍覆盖119行，K01–K16与原59项场景/预期原文摘要保持`7c0b897370f11707c6204bbf954a1ba0e6efd9df76863815750af55eb63e952e`，E01–E06非状态列不变；完整发布与59项全部通过均为false。五个新增脚本语法及文档链接检查见[交付校验](evidence/threaded-rc11/validation.json)，源码/报告/证据的精确文件摘要见[交付清单](evidence/threaded-rc11/delivery.json)。未修改生产源码、schema或RC10历史交付资产。

所有新结果限本机 macOS、合成隔离数据与明确注入边界，不外推其他平台、真实原生登录/续接、完整旧新真实供应商混跑或目标部署发布成功。RC11 变更本轮实施后留待后续提交；RC10 历史报告及交付清单未回写。
