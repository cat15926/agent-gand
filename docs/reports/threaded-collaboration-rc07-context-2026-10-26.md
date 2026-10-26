# 持续协作 RC07：上下文边界与原生压缩分层验收

日期：2026-10-26（Asia/Shanghai）。基线为本轮已提交并推送的 RC06 `f03648e`。RC07 实现及所列 **31 组专验、83 组相关回归，共 114 组通过**，当前变更未提交；默认窗口自然压缩、产品 seal 入口及实际 index 的完整原生组合仍未验，**不关闭 RC07 全范围或整体发布验收**。不按组数推算核心合同完成比例。

产品名为“持续协作”，内部标识 `threaded`。默认仍为 closed，代码 schema 35、历史迁移不变；未改变日常配置、迁移日常数据库或开始 RC08。验收范围见[上下文合同](../architecture/threaded-context-acceptance-v1.md)，剩余工作见[计划](../plans/threaded-collaboration-remaining-plan.md)。

## 1 生产改动及实际缺陷

原 API 路径在 `loadInput` 时即写入 Session input intent 和 context sending intent，之后才检查包含工具描述的完整 HTTP envelope。当 manifest 可容纳、完整请求却超限时，真实发送次数为零，调用失败并释放，但 Session 永久保留无法用后端回执修复的 sending intent；即使提高合法输入预算，后续同 Session 仍受阻。修复前已复现，见[原缺陷证据](./evidence/threaded-rc07/admission-before-fix.json)。

现在 API 在请求通过格式、权限和完整预算校验后，才于 `requests.begin` 中写 input/send intent。`executeBackendRequest` 的外层 evidence 事务覆盖预算开始、输入曝光和后端 sending receipt：其中任一写入失败，应用数据库内整体回滚。delivery 回调查询已持久化的 intent，不缓存可能已回滚的 ID。外部验收 token 账本是另一数据库，保守预留不宣称随应用事务自动退款。

SDK 保留不同边界：本地原生进程在首次 HTTP 前就已接收 prompt，仍须先记 exposure；HTTP 尚未发送不能证明本地 Session 未见输入。SDK 缺可信 checkpoint 时显式冷开，不能因远端零调用删除本地曝光事实。

原压缩记录只有 boundary 和来源，无法分辨真实自动压缩与手动/未知触发。现在持久化 SDK `compact_metadata` 的白名单字段：`trigger:auto/manual/unknown`、压缩前 token，以及 SDK 实际提供的压缩后 token 和持续时间。无效数值/trigger 拒绝写入；缺失元数据记 unknown，旧记录可继续读取。没有新增 schema 迁移，也不公开私有原生摘要或 transcript。

## 2 分层证据

| 层 | 通过组数 | 实际载体与边界 | 证据 |
| --- | ---: | --- | --- |
| 精确上下文 | 7 | 7 个独立 worker PID、真实 SQLite/context/runtime；可信后端回执由受信生产 writer 注入，零供应商 | [context](./evidence/threaded-rc07/context.json) |
| 准入原子性 | 5 | API 完整 envelope/预算/receipt INSERT 故障及 SDK 本地曝光；注入 transport/process port | [admission](./evidence/threaded-rc07/admission.json) |
| 原生 SDK 注入 | 7 | 实际 SDK/guardian，9 个实际 guardian PID；HTTP/usage 注入，factory 隔离执行开关；压缩、撤权、低层 seal、缺 checkpoint | [native](./evidence/threaded-rc07/native.json) |
| 实际 index 注入 | 5 | 7 个实际 `apps/server/src/index.ts` PID，执行前移除初始化 bypass；真实认证 HTTP、发布及调度，传输注入 | [main injected](./evidence/threaded-rc07/main-injected-final.json) |
| 实际 index 真实供应商 | 5 | 同样 7 个 index PID，5 场景中实际发送 6 个 API 请求；overflow 场景正确零发送 | [main live](./evidence/threaded-rc07/main-live-first.json) |
| 受控窗口原生 runner 注入 | 1 | 4 次实际 SDK 调用/guardian、5 个注入 HTTP；与真实 runner 相同窗口切换条件 | [controlled injected](./evidence/threaded-rc07/native-injected-live-runner.json) |
| 受控窗口原生真实供应商 | 1 | 4 次实际 SDK 调用/guardian、5 个真实 HTTP；factory 隔离执行开关，不是实际 index | [controlled live](./evidence/threaded-rc07/native-live-first.json) |
| 相关回归 | 83 | context14、session-context13、resource-integration8、queue11、backend-runtime7、backends14、production16 | [汇总](./evidence/threaded-rc07/verification-summary.json) |

统计是“场景×证据层”的去重组数。单例调试重跑和报告格式修正后的注入复验不增加组数；PID 仅分层呈现，不合并为部署规模。源码检查、token 账本聚合和文档检查也不计测试组。

## 3 实际主入口五场景

| 场景 | 已验证事实及范围 |
| --- | --- |
| overflow | 认证 HTTP 接受超大 source 后，冻结 manifest 为 blocked；没有 backend receipt、input/send intent、delivery 或 cursor，真实供应商零调用。源本身不可容纳与完整 envelope 不可容纳分别验证 |
| gaps | 旧公开消息因预算整项延期，private/draft 被过滤，较高 seq 的 source 先投递；后续小 source 的 API 重建包含旧低 seq 内容。逐条核对 wire/manifest/delivery/cursor facts，不以高水位漏掉旧项。这是 API 重建证明，不当作原生增量空洞已验 |
| wave | 同一用户 source 指向 A/B，并行路由 wave 固定相同 cutoff；故意将全局容量设为 1，让 B 在 A 已发布后才 prepare。B 的实际请求仍不含 A 本波回答，冻结输入不依赖同时开始 |
| cursor | 真实请求已有 complete receipt 后，SQLite cursor INSERT trigger 拒绝写入，整笔 delivery 事务回滚。去掉故障后 SIGKILL 旧 index，以新 PID 打开同一临时库，按精确原 receipt 幂等修复；没有重复供应商请求、假造丢失的响应或重复游标事实。另 context 层覆盖 UPDATE 失败的跨 PID 修复 |
| envelope | 隔离 pack/角色包含全部应用工具描述，manifest ready 但完整请求超预算：零发送、零曝光。停止服务后显式提高该测试 pack 的输入预算并重启，同一 API Session 接受新 source 并成功；原失败 source 不自动重放 |

历史 context seed 由受信生产消息端口建立，随后新 source 走认证 HTTP；不冒称历史 seed 都由 UI 输入。回执检查使用精确正文 SHA256 和唯一、尚未消费的持久 sending request。API 受控重建与原生 Session 连续性始终分开。

## 4 真实原生压缩与权限边界

载体为 macOS、`claude-sdk 0.3.288` / Claude Code `2.1.288`，选定已配置账号 `Claude-GML-5.3`（`267c2e27-b25f-43cf-acaa-143327f7f714`），模型 `glm-5.3`、`open.bigmodel.cn` Anthropic-compatible。其他平台、供应商或 driver 不继承结论。

真实 runner 前两轮建立实际历史，输入含 44,999 字节固定合成参考文本，无日常业务数据；四轮均使用正常 SDK 和真实供应商回复/用量。验收设置 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`，从第 3 轮开始显式设置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=32000`，输出上限保持生产兼容的 8192。SDK 随后发出真实 `compact_boundary`/`trigger:auto`，保存元数据、获权消息来源及精确边界，后续仍同 nativeId resume。该事件实测压缩前 33,046 token、压缩后 1,404 token、持续 16,546ms；最终锚点携带同一边界。合成的是输入材料和触发窗口，**没有合成供应商 usage、摘要或 compact 事件**。最终证据中的进程均核实停止。

这是受控窗口触发，不代表 glm-5.3 的自然窗口只有 32k，也不证明默认窗口下已经自然出现压缩。factory 使用显式隔离执行开关；实际 index 全链压缩仍未验。平台仅记录保守的获权来源闭包，不宣称知道原生摘要的逐句来源或公开其全文。独立离线核对见[真实来源证明](./evidence/threaded-rc07/native-live-provenance.json)。

原生注入层另验证：其他成员 private 消息不进入任何 wire；跨 Thread 源成员权限收缩后，旧 anchor 不可读，历史 exposure 不被删，下一轮真实 SDK 冷开且不含撤权衍生内容；缺 checkpoint 也冷开。权限改变由隔离 fixture 设置，不是已交付 Owner UI 操作。低层受信 seal 不可变、幂等并阻止旧 checkpoint；后续 SDK 冷开。当前没有产品 HTTP/UI seal 入口，因此不能用该低层测试关闭产品操作验收。

## 5 隔离与费用账本

先设置临时 DB/agents/private 目录，再导入生产单例。真实测试只读加载选定日常账号、版本、加密凭据及撤销状态，不读取日常消息。main runner 经私有 IPC 传入凭据，在子测试库以全新内存密钥加密；native runner 在父进程内读取凭据，SDK 仅持短期 relay token。密钥不进入 argv/env/report。逐 HTTP 绑定完整正文 hash 与持久 request/authorization，限制目标地址与方法，发送前先向原共享账本事务预留；未知预留不释放。

用户原授权 1000 万 token 保留，本轮继续选择较小的**累计 500,000 token 门禁**，原账本 `/tmp/agent-gand-t07-authorized-token-ledger.sqlite` 没有重置。

| 口径 | 已确认 token | 未知预留 token | 保守合计 |
| --- | ---: | ---: | ---: |
| RC07 前（RC06 后） | 70,543 | 206,832 | 277,375 |
| 本次实际 index：6 请求 | 9,482 | 0 | 9,482 |
| 本次受控原生：5 请求 | 107,258 | 0 | 107,258 |
| 当前累计 | **187,283** | **206,832** | **394,115** |

门禁余量 **105,885 token**；本次 11 请求全部有可信已知 token，新增 116,740。原 57 行逐字段重建的摘要与运行前一致，见[ledger](./evidence/threaded-rc07/ledger.json)。原未知 89,758、RC05 未知 97,271 和 RC06 未知 19,803 均保持；进程已停止不证明供应商费用，token 已知也不证明货币价格已知。

验收根经正常 Owner CAS 选 10,000ms 活动片；生产默认 1000ms、总预算与绝对期限不变。RC05 默认片长可用性限制和历史未定位超时、RC04 `not_observed` 以及 RC06 工程源写/merge、真正资源冲突的 command 持久等待、完整 legacy 供应商混跑缺口继续保留。

## 6 开发失败、核验与剩余条件

- 修复前完整 API envelope 超限导致永久假曝光的原失败保留；修复后隔离与实际 index 两层通过。admission 首轮 SDK 沙箱 loopback 失败只列环境候选，不把缺失的内部诊断当作已查明根因，见[开发记录](./evidence/threaded-rc07/admission-development-findings.json)。
- main 首轮 wave fixture 错用 `globalCapacity`，没有实际收紧容量；改用生产政策字段 `globalLimit` 后单例及全套通过。[第一轮](./evidence/threaded-rc07/main-injected-first.json)保留，不将 fixture 错误计作生产修复。
- 原生触发开发曾有未观察到压缩、窗口太低及输出参数调整；最终条件先注入复验，再只运行一轮真实供应商。失败与条件变化见[原生开发记录](./evidence/threaded-rc07/native-development-findings.json)，不能用最后成功反推此前失败根因。
- 真实原生报告通用脱敏误将四处 `budgetAuthorization` 对象开括号替换，导致 JSON 格式损坏。原文本保留，依据保存的结构仅恢复开括号并另记摘要/转换证明；未补造业务值、未重跑供应商。runner 改为递归字符串脱敏和 JSON 往返校验，详见[格式修复记录](./evidence/threaded-rc07/native-live-serialization-repair.json)。
- 首轮 TypeScript 检查提示 intent 可能 undefined；将失败分支写成显式 `return fail(...)`，运行语义不变，随后 typecheck 通过。原失败输出另存，不覆盖历史证据。

服务端 typecheck、文档链接、diff、独立只读 review、文件清单及摘要见[交付清单](./evidence/threaded-rc07/delivery.json)。原 K01–K16 和 59 个场景/期望正文逐字保持，见[原文不变性证明](./evidence/threaded-rc07/original-text-invariance.json)。

| 剩余退出条件 | 后续要求 |
| --- | --- |
| 默认窗口自然压缩 | 在真实正常模型窗口与实际输入历史下观察事件，保留不可保证事件出现的事实；不能拿本次受控窗口替代 |
| 实际 index 完整原生组合 | 在生产入口组合 SDK 压缩/恢复、序号空洞、权限收缩与故障重启；各层已通过不代表交叉积已验 |
| 产品 seal | 设计明确权限和持久语义的产品入口，再验用户操作、重试、并发与后续会话；当前仅受信低层接口 |
| 发布与其他阶段 | RC08 问题定位/征询、RC09 对账、RC10 综合链及 RC11–RC12 发布继续按计划；本轮不自动执行或启用日常模式 |
