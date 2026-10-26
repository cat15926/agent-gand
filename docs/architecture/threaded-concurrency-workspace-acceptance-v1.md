# 持续协作：并发与工程工作区验收合同 v1

更新：2026-10-24（Asia/Shanghai）。RC06 在 schema 35 上实现显式共享工程绑定和注册命令补充资源调度，未增加数据库迁移。本文记录已通过的范围与未验边界，不授权日常配置、迁移或启用；默认仍为 closed。交付和完整证据索引见[RC06 报告](../reports/threaded-collaboration-rc06-concurrency-2026-10-24.md)。

## 资源身份与并发规则

同一完整请求键/operation 的并发重试必须收敛到一个 ticket、一个有效 claim 及一次容量计费；同键内容冲突须拒绝且不留下部分资源。相同 Thread/Agent 槽只有一个执行者，不同 Thread 的同一 Agent 可在容量范围内并行。旧 legacy 独占与新 Thread 槽相互约束，等待的独占不能被后续 Thread 流量持续越过；Thread 公平性、原 ticket 年龄和容量释放通知必须持久保留。

native 互斥按实际 backend/account identity/host/nativeId 的 canonical key 获取，不能以不同 policy/binding hash 绕过。旧 claim 的迟到 finally/release 只能处理原 fence，不能释放 successor。取消 A 只取消 A 的授权作用域和原进程组，独立 B 须能继续、完成并按自己的静止/terminal 证据释放；A 的 possible-send unknown、未知用量及审计不因进程退出或 B 成功而清除。

注册 OS 命令是 `capacity:false` 的独立完整资源请求，不占模型调用容量或 native Session。其补充资源不另占模型服务轮次，也不推进 Thread 的模型公平性；无冲突的较早模型候选不会单纯因候选头顺序阻止命令。但 active claim 和更早有效 eligible pending 的实际非容量资源冲突仍阻止获取，父子路径 read/write、命令/Session/legacy 独占均适用。完整 claim 同事务获取，失败不允许留下部分持有。

命令真正资源冲突的单次 reserve 仍可能保留业务 command unknown，并回滚 OS intent/claim；当前没有持久等待后自动重试启动合同。同键查回不是重新执行，不能删除 unknown、换键盲重放或把这一限制写成已交付的无丢唤醒能力。模型队列的容量释放再入场与命令的单次 reserve 是不同验收范围。

## 共享工程绑定与产物

生产注册的 `shared_project` 为显式选项：同一 project 登记的所有 members 均须写该模式，且各 workspace 精确等于 canonical project.root。未写模式保持旧 isolated 合同，不能隐式把成员目录升级成共享工程。同一工程不混合两种模式，也不允许跨 project 重叠。详细公开配置见[生产命令合同](threaded-commands-hold-production-v1.md)。

模型 Session policy/context 与模型资源声明绑定整个共享 root 的 read 范围，不能以某个命令只读取子目录为由缩小模型 claim。共享工程另登记与 root 互不为祖先/后代的 artifactRoot；每条命令只写其专用严格子目录，输出全局不交叠且不接触任何成员 workspace。command 的 readPaths 仍位于共享 root，完整 read/write 声明及来源独立核验。配置、共享模式、artifactRoot 和目录身份进入映射指纹，路径替换/符号链接/输入漂移失效后拒绝，不回退到 per-agent 目录。

本轮生产 profile 仍只有固定 `project_manifest_v1`：读选定输入、写清单，宿主独立核对精确文件和 SHA256、完整输出目录及原 guardian 进程组静止。它不编辑工程源文件，不构建、不提交 Git，也不执行生产合并。

真实本机工程验收包括同根 read/read、父 read 阻止子 write、子 write 阻止父 read、分离路径产物并行及释放后原 ticket 入场。另有明确的 fixture 协议，让两个作者产物携带相同 baseVersion/baseSha256，由唯一 merge owner 选择一个版本、推进 1→2，并拒绝另一旧基线产物。该协议只验证隔离产物的责任/版本表达与低层资源组合；它不是产品 merge 工具，不证明生产权限、崩溃原子发布或真实工程写作完整闭环。

## 分层证据

| 层级 | 通过组数 | 已证明范围 | 不能外推 |
| --- | ---: | --- | --- |
| [多进程 coordinator](../reports/evidence/threaded-rc06/concurrency.json) | 16 | 多 SQLite/PID 的同键重试、槽/跨 Thread/legacy barrier、公平性、容量释放及命令补充资源冲突规则 | 真实供应商 legacy/新模式完整混跑 |
| [原生 SDK](../reports/evidence/threaded-rc06/native.json) | 6 | 实际 guardian、SDK CLI、checkpoint、只取消 A 而 B 继续/完成/续接；同 native key 的跨进程 fence | 此层 HTTP 为合成注入，且使用显式 isolated worker；不同 policy 同 native 的记录为低层刻意种子，不是普通生产准备输出 |
| [工程工作区](../reports/evidence/threaded-rc06/workspace.json) | 9 | 9 个真实 worker PID、工程文件/资源争用；实际 production factory 无执行 bypass、3 个注入模型调用、两个注册原生命令并行产物；12 类非法配置和路径漂移拒绝 | 模型供应商未在此层调用；生产工程源写/merge 未交付；唯一合并责任协议仅 fixture |
| [实际 index/注入传输](../reports/evidence/threaded-rc06/main-injected-final.json) | 5 | 实际 index.ts、HTTP、生产 singleton/release/authority，无执行 bypass；重试/同槽/跨 Thread/只取消 A/容量再入场 | 注入延迟和屏障不能证明真实供应商 send-to-headers 重叠 |
| [实际 index/真实供应商](../reports/evidence/threaded-rc06/main-live-first.json) | 5 | 选定 Claude-GML-5.3/GLM-5.3 配置下的上述五项，真实网络时间与原生进程证据分开记录 | 其他账号、模型、平台、完整 legacy 供应商混跑及通用工程写作 |

各层共 41 组；旧回归单独保存在本轮 regressions 目录，不改写原报告。固定源码和目录 pin、执行前权限/代际复验、进程静止及副作用凭证属于本地可靠性能力，不能只靠源项目规则核验或一条完成正文判为通过。

## 用量、发布和保留限制

本次真实供应商新增已知用量 5,362 token、未知预留 19,803 token；累计已知 70,543，加未知预留 206,832，共保守占额 277,375 token。此前账本行与未知项保持不变；这些数字是本地验收账本，不能宣称供应商费用已硬封顶或已完成未知请求对账。A 取消后已经发生的发送/缓冲与未知用量须按精确请求凭据分别核验。

验收根通过正规 Owner CAS 选择 10,000ms activity 片长，生产默认 1,000ms 不变；本轮不证明默认短片长下长同步准备已解决。日常仍 closed，日常数据库未迁移，schema 35 的备份/灰度由后续发布阶段独立验收。

RC04 真实观察的 not_observed 和 H1/H2 完整链缺口继续保留，RC05 两轮未定位真实超时、历史未知费用和恢复限制也未被本轮成功覆盖。完整 legacy/新模式真实供应商混跑、任意工程源写/生产 merge、其他平台及高级载体仍按各自范围继续实施或明确登记未验。
