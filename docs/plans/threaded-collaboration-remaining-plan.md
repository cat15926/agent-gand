# 持续协作剩余实施与验收计划

状态：**RC01–RC03已按所列范围完成；RC04实现及所列隔离/进程验收完成，真实观察已结束、not_observed，完整真实链未通过；其他RC/EXT待实施或验收**。更新：2026-10-23（Asia/Shanghai）。RC02已推送`a871910`，RC03已推送`ee751a3`；RC04当前变更未提交，代码schema保持v35、历史v25–v34不变。默认closed，日常未配置/迁移；不自动开始RC05等下一任务或日常发布，不新增T13。

本表承接[实施指导](threaded-collaboration-implementation-guide.md)、[当前状态](threaded-collaboration-implementation-status.md)和[兼容矩阵](threaded-collaboration-compatibility-matrix.md)。RC/EXT 是剩余工作索引，原 T01–T12、K01–K16、59 项场景及预期继续有效；不能通过改编号、缩小核心合同或删除未通过项宣布完成。

## 1 已交付基线

| 对象 | 截至基线的事实 | 尚不能据此宣称 |
| --- | --- | --- |
| T01–T11 | 设计及所列实现、隔离/浏览器/限定真实后端与领域证据已交付；T11只包含基础知识，不含语义检索 | 全部上游能力或全部平台已兼容 |
| T12 | 代码及证据已推送；v34迁移17组、release 7组、production 16组、恢复9组/24子进程、实际index 4组、macOS命令8组、Chrome 5组通过 | 整体发布通过或59项全部通过 |
| 真实API/SDK | 同一已授权账号的五类知识/SOP工具通过；SDK在执行完成且进程已静止后，隔离HTTP factory服务SIGKILL，新进程用原nativeId/anchor续接，恢复零请求 | 实际index带供应商的完整故障、mid-flight SDK自动恢复或原生自动压缩已验 |
| 领域接线 | 平台任务及PR适配器、注册OS端口已有分层证据；[RC02](../reports/threaded-collaboration-rc02-github-2026-10-22.md)已接可选生产GitHub注册、身份/范围/撤权检查；[RC03](../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md)已接首批`project_manifest_v1`生产OS注册、独立读写资源/副作用核验及hold合同；日常GitHub/OS均未配置 | 配置release pack即可启用所有领域，或日常已开放 |
| 风险与费用 | T12真实PR新HEAD仍为not_observed；RC04本轮609秒/71次官方GET、0新HEAD，结果not_observed，完整真实链未通过；T08首次征询取消根因未定位；两次T12真实失败保留 | 失败已全部修复、unknown可自动释放或请求免费 |
| 部署 | 交付默认closed；既有记录未包含日常库迁移、灰度或生产回退 | 已在日常业务环境开放 |

T01–T12证据来自[T12报告](../reports/threaded-collaboration-t12-release-2026-10-21.md)及阶段报告；RC01新增[RC01报告](../reports/threaded-collaboration-rc01-contracts-2026-10-22.md)、固定来源哈希和66组隔离回归，没有重跑真实供应商或改写历史证据。RC02另交付18组新隔离、54组相关回归及7项/8次真实官方GitHub只读GET，真实新HEAD完整链未验。RC03追加严格选定命令profile及结构化hold/SLA/共享额度，已通过范围见[RC03报告](../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md)；通用shell/build与完整真实供应商/工程并发组合未据此开放。RC04新增生产跟踪分享桥接，38组专验及70组相关回归通过，schema仍v35；其真实窗口已结束，609秒/71次官方GET、0新HEAD，not_observed，H1/H2完整真实链未通过，原T12 not_observed及全部T阶段证据原样保留。

## 2 首版收口计划

P0 为生产放行前必须解决或明确处置的工作；P1 为声明组合的完整真实验收。优先级表示建议顺序，不是日期承诺；P1不表示可以免验，被声明纳入发布的组合仍须完成对应验收。已有代码的条目先补验，发现缺陷后再修复；不把已有通过场景重新列成从零开发。

| 编号 | 优先级 / 类型 | 剩余工作与当前状态 | 前置依赖 | 必须交付的退出证据 | 原任务 / 验收 |
| --- | --- | --- | --- | --- | --- |
| RC01 | P0 / 合同核验已完成 | 已核验五域实际调用链：Session分层兼容、预算/循环、hold/SLA、普通/Collective工作区及独立语义召回；见[RC01报告](../reports/threaded-collaboration-rc01-contracts-2026-10-22.md) | 固定Clowder提交及T01决策（已满足） | 已交付逐条源/本地对照、113文件固定blob及SHA256、64分域引用、66组隔离回归与后续用例；K01–K16共16条/原59项文字不变。hold核心缺口进RC03/RC05，工程映射/写入进RC03/RC06，语义进EXT01；源核验完成不等于这些实现已通过 | T01、T07、T08、T11；K07、K15、F06、P08、MEM01 |
| RC02 | P0 / 实现与接线已完成 | [生产GitHub注册及报告](../reports/threaded-collaboration-rc02-github-2026-10-22.md)：实际单例可安装PR/tracking/Review来源，固定scope/repo/PR及单principal凭据，补恢复撤权与并发身份故障围栏；日常未配置 | RC01相关合同已满足 | 已交付18组专用+54组回归及7项/8次真实provider GET；无注册明确not_registered，基线不误触发、HEAD/撤权复验、secret不落库/worker、observe零IO；真实新事件仍RC04，日常选定配置/放行仍RC11–RC12 | T08、T10–T12；W05、A04–A07、MEM02 |
| RC03 | P0 / 首批选定profile实现及接线已完成 | [合同](../architecture/threaded-commands-hold-production-v1.md)与[报告](../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md)：严格`project_manifest_v1`注册、工程根/成员目录/cwd映射、独立多read/write资源及宿主verifier；结构化hold来源、missed-timer SLA恢复/过期退休、命令wake共享准入及撤权回调围栏。代码schema追加v35，旧timer精确回填、无历史注册时间的活跃旧command按升级时刻保守占窗且重启不续期；已推送ee751a3，日常未配置 | RC01已完成；现有端口/资源合同 | 已通过等待14/命令准入4/实际production接线2/迁移19/资源38及所列回归，原生OS与其他回归准确结果见报告；固定program/argv/env/cwd、权限/代际及完整资源复验；结构化来源/reporter anchor与伪等待拒绝、同job幂等及共享3次/小时，守门专域单列，在线one-shot不设统一硬SLA。通用shell/build、真实供应商故障与工程并发写作不在本profile通过范围，后两项仍RC05/RC06 | T08、T10、T12；W01、W03–W04、OS01、REC03 |
| RC04 | P1 / 实现及所列隔离/进程验收完成，真实not_observed、完整链未通过 | [合同](../architecture/threaded-live-review-acceptance-v1.md)与[报告](../reports/threaded-collaboration-rc04-live-review-2026-10-23.md)：修复caller-only跟踪回调阻断修订/独立复审的生产缺口；GitHub可按受信private audience政策，与原来源ACL取交集，冻结各recipient的grant/identity并在派发复验；generic与旧wait保持caller-only。38组专验及70组相关回归通过，当前变更未提交，真实只读窗口已结束，609秒/71次官方GET、0新HEAD，not_observed，H1/H2完整真实链未通过 | RC02；同一选定PR合法发生的两次自然新HEAD | 单canonical Action、同root的H0→H1→H2两次自然HEAD；baseline不触发、每次新HEAD唯一wake、旧approved失效、changes_requested可完成责任但门禁blocked、逐项attested不自行verified、不同本地reviewer独立复核；实际worker重启/重复扫描不重复。38组专验为12transport/6生产授权/7分享/9注入链/4实际进程，不替代真实事件；未出现事件保留not_observed，不把历史HEAD与当前GET拼成动态证明 | T10–T12；W05、A04–A07、REC05 |
| RC05 | P0 / 真实故障验收 | 实际index隔离配置/数据库连接真实供应商，补发送前/可能已发/终态提交后、mid-flight SDK、审批/撤权、存储I/O组合；按RC01补停机跨fireAt及SLA恢复/过期边界；既有index4组不含真实执行。RC04长同步准备曾在默认1秒活动片触发`THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED`，隔离根经常规Owner预算CAS显式使用10秒活动片；目标发布活动片及默认1秒下长准备组合仍须真实验收，生产默认及守卫未修订或放行，其余总预算限制未放宽 | RC01已完成；RC03对应等待语义；有效release pack、组级预算 | 实际PID/宿主及停止证明；未发有据retry、可能已发unknown且不重放；响应/后继/Run/费用原子一致；恢复零盲重发，I/O故障不假成功；恢复窗口之前/等于/之后及ownerAuth/baseline/generation漂移逐项验，不能用静止后续接冒充mid-flight | T03、T06–T07、T12；ISO04–ISO05、REC01–REC06、OS01 |
| RC06 | P1 / 真实并发验收 | 验证同键并发重试、同槽竞争、跨Thread同Agent、旧独占/新槽混跑、公平性、同nativeId双resume、只取消A且B继续、容量释放再入队；补实际工程写作争用，现有相关确定性用例已过 | RC01；RC03用于命令写入组合 | 一个有效持有者、不同policy同native仍无双resume/旧finally释放、无饥饿/丢唤醒、容量只计一次；真实工程父子路径read/write互斥或隔离产物有唯一合并责任及版本。工程projectPath绑定交互/并发写未交付时明确未验，不能以per-agent目录替代 | T04、T07、T12；DB01、Q01–Q06、ISO01–ISO02、P08 |
| RC07 | P1 / 真实上下文验收 | 补真实输入超限/序号空洞、同波并行输入冻结、原生自动压缩/seal后续接及权限收缩；现有fixture与SDK短会话成功不覆盖这些组合 | RC01；RC06的并行载体 | manifest精确集合和游标一致，未暴露输入不推进游标，游标写失败全事务回滚；B不吸收A本波答案；压缩来源/ACL可追溯，不能兼容则明确冷开，不泄露其他成员transcript | T07、T12；CTX03、CTX05–CTX06、MEM02 |
| RC08 | P0 / 问题定位与增强验收 | 定位T08首轮SDK征询取消；对实际生产组合补征询部分失败/超时/重启/失权与丢回执。已有E01–E06隔离通过及新场景真实成功保留 | RC05；原失败证据 | 给出可复现根因和修复回归；若原现场不足，明确未定位和限制，不用新成功覆盖旧失败。逐成员原答、唯一partial/settlement/outbox/callback及anti-cascade不退化 | T08、T12；MM01–MM04、M03、E01–E06 |
| RC09 | P0 / 对账 | 核对未知供应商用量/费用和未决外部副作用；当前已存证unknown预留89,758 token，仍未最终对账 | 可与RC01–RC08并行；可信供应商/宿主证据 | 精确到原request/binding/代际的可信事实；幂等补记及资源/用量分别核验，不清除历史。无法取得事实的项继续unknown，单列保留、暂停及恢复处置，不能自动退款或重放 | T04、T07、T12；B02、REC03、K13 |
| RC10 | P0 / 综合验收与发布审查 | 验证A公开接力B、征询C/D、一人失败/超时、有据恢复、评审/修订及返回原Thread的真实综合链；将RC结果回写K/F/P/S/E及59项，冻结本次平台/后端/工具/领域范围，补旧模式与安全旁路回归 | RC01–RC09相关条目完成；未解unknown有明确处置；若纳入语义则还需EXT01 | 综合链至少包含一次服务重启、旧回调、权限变化和预算限制，逐成员原答、唯一回调、Action与门禁分别留证；重试、接力、修订/替换继承同一causal root且预算不重置；每项标明实现、隔离/真实通过、失败或未验证，增强单独验收。纳入范围的核心合同及增强必须通过。MEM01语义未交付时整项保留未完成，不宣称59项全部通过 | T01、T12；全部K/原验收，尤其K16、MEM01 |
| RC11 | P0 / 发布准备 | 对目标部署完成匹配版本备份/恢复、v35前向迁移（保留v25–v34及T12历史证据）、旧worker拒绝、closed旧模式回归和observe演练；目前只有隔离证据，日常未执行 | RC10；确定的目标环境与一致备份 | 数据/账号密钥/原生会话/工作区恢复方案匹配；恢复演练有校验记录；observe不触发协作后台写；不降低schema或丢失新数据/unknown | T12；DB03、ISO01–ISO02、OPS01 |
| RC12 | P0 / 灰度与交接 | 选定新Thread小流量放行，核对工具/真实用量/Action，演练停止新入场、暂停派发、排空、兼容应用回退，再按证据扩大范围；未执行 | RC11；经选择的发布范围及新Thread配置 | 新根关闭后旧根有据处理或明确暂停；unknown/Action/outbox可见；保留匹配pack与兼容worker。threaded_only排空不能充当整库回退许可；整库备份恢复须另对账全部模式和备份后的副作用 | T12；OPS01、OS01、UI01、B01–B02 |

建议后续顺序：RC01–RC03已按所列范围完成；RC04本次实现及分层验收已执行，本轮真实观察已结束为not_observed，H1/H2双HEAD完整闭环退出条件未满足；RC09对账可并行，RC05–RC08按相应前置补验；统一由RC10汇总，再进入RC11/RC12。本表不自动启动下一任务。外部事件、供应商回执和原生压缩的出现时间不可保证，不据此承诺固定完成日期。

## 3 后续能力范围

这些条目保持兼容矩阵的原范围，不替代首版核心合同；未纳入某次发布，不等于已经支持。普通home Thread的私密ACL、Action、基础知识和SOP已属于首版，不能挪入本表免验。

| 编号 | 优先级 / 状态 | 剩余能力 | 依赖与验收要求 | 原范围 |
| --- | --- | --- | --- | --- |
| EXT01 | P1 / 后续待实现 | 完整语义索引、召回/排序和跨会话检索 | RC01已确认生产索引/embedding/独立NN/hybrid RRF及默认/降级边界；须实现source/model版本绑定、来源ACL/撤权闭包、过期/替代/精确展开和有界partial元数据。冻结本地corpus/model/config与真实Recall@k/MRR/NDCG、负例泄漏门槛；参考词法Recall@5≥80%和semantic scaffold不能冒充实模标准。substring或仅重排其命中不计语义；MEM01整项仍未完成 | T11扩展；MEM01、MEM02、S08 |
| EXT02 | P2 / 后续待实现 | Collective私有/公共执行隔离 | 单独冻结上下文、权限、Session及来源策略，按CTX/MEM专项验证；不能复用普通home私密消息通过结果推断已支持 | S09；CTX01–CTX06、MEM02 |
| EXT03 | P2 / 后续待验证并补适配 | Linux上的首批API/SDK与命令组合 | macOS结果不外推；逐项验证宿主身份、进程树/IPC/取消、Session锁、恢复和资源/费用围栏 | S10；OS01、REC、OPS01 |
| EXT04 | P2 / 后续待实现或验证 | codex-app-server、codex-exec、claude-cli等driver，以及WSL/Windows | 按driver版本×平台×工具分别冻结start/resume/cancel/权限/用量/恢复；Windows原生须独立进程归属与终止实现。未完成组合不开放、不宣传支持 | S11；CTX06、REC03、OS01及新增专项 |
| EXT05 | P2 / 后续架构扩展 | 多机worker、多租户及跨worker通知 | 新建分布式授权/资源协议、租户与数据边界、通知/恢复所有权和故障模型；单宿主多进程CAS不等于分布式或多租户通过 | S12；ISO03、DB03、Q、MEM02及新增专项 |

## 4 执行与记录约束

- **证据分层**：代码接线、注入fixture、实际宿主进程、真实模型、真实业务及生产操作分别记证，不以通过组数估算复刻比例。每组记录原ID、平台/版本/模型/工具、真实请求数、失败及未验范围。
- **授权与预算**：沿用既有测试授权和原累计账本，不重复要求已授范围的授权，也不将它扩张为远端写或日常发布。T12报告时点保守占额153,094＝确认63,336＋未知预留89,758；当前20万门禁的保守余量46,906不能保证某组请求可运行。执行前核对实际账本和每组预留，任何门禁调整留决策记录并遵守用户已授权1000万token总上限；本次不改门禁、不重置账本、不释放旧unknown。
- **真实事件与数据**：默认GitHub只读，不为制造HEAD而擅自写PR/评论/review/branch/commit。优先使用隔离库和合成上下文；不以日常业务库、破坏性磁盘故障或重置数据库完成测试。
- **发布边界**：本计划不是激活指令。发布顺序按RC10–RC12及[运维手册](../operations/threaded-release-runbook.md)，保留必要的旧pack、恢复器和worker；不能靠删新表、降schema或抹去未决责任回退。
- **完成口径**：单项退出证据落库并更新当前状态/矩阵后才能改为通过。若原失败无法复现、自然事件未出现、费用无回执或范围尚未实现，按真实状态保留，不能用另一个成功场景抵消。
