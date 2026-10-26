# 持续协作：上下文与压缩验收合同 v1

更新：2026-10-26（Asia/Shanghai）。RC07 承接[上下文与后端合同](threaded-context-backends-v1.md)，补验输入上限、精确投递集合、冻结 wave、游标故障恢复、原生压缩与权限收缩。本轮代码 schema 保持 35，不增加迁移；RC06 基线已推送 `f03648e`，RC07 实现及所列分层验收完成、当前变更未提交；默认窗口自然压缩、产品 seal 和实际 index 完整原生组合仍未验，尚未整体验收关闭。日常仍为 closed，未配置、启用或迁移。各层结果以[RC07 报告](../reports/threaded-collaboration-rc07-context-2026-10-26.md)为准。

## 冻结输入、序号空洞和输入上限

manifest 必须固定当前合法 Binding、Session、Wake、wave 与 inputMaxSeq，保存精确消息 ID、版本/hash、包含或排除原因及整体 payload hash。消息正文和附件整体纳入或延后，不允许截断触发来源来获得一个可发送输入。来源自身连同保留系统占额超限时，manifest 显式 blocked；没有请求、没有模型交付事实，未用请求预留及执行容量按可信未发送路径处理，不能改键重试绕过预算。

ACL 不可读、尚未发布与预算延后是不同空洞。原生增量输入查逐条交付集合，不能因较高 seq 已交付而遗漏较低 seq 的合法补投；API 每次按当前权限重建必要历史。delivery、seen 和 mention_ack 分别推进，任何一个最大游标都不能替代精确消息事实。

同波成员 B 即使在 A 生成回复以后才准备或发送，也只能读取原 wave 的 inputMaxSeq 内获权消息。A 本波答案的较高 seq 不进入 B 的输入；该规则在多槽并发和后续队列启动时仍成立，不能用调度先后改变独立思考边界。

上下文预算有两个拒绝边界：来源/manifest 预算，以及含工具、系统内容和协议开销的完整 HTTP JSON envelope。manifest ready 不代表实际请求必然获准。API 完整 envelope 在准入前被拒绝且没有本地模型接收方时，不得提前写入可能曝光、input_intent 或 sending；否则下一 Invocation 会被虚假的未决发送阻挡。

RC07 将 API 可能曝光登记移到请求准入之后：`executeBackendRequest` 的外层 evidence 事务包含预算领取/启动、Session input_intent、context sending 与 backend request receipt。任何一步失败，包括 receipt INSERT 失败，整体回滚；事务提交后才允许 fetch。SDK 则在本地 worker 接收 prompt 前登记可能曝光，即使尚无 HTTP 请求，本地原生 transcript 仍可能已接触输入，不能用 0 fetch 擦除该事实。此差异只影响曝光时间，不降低两种后端的权限、预算、回执或未知执行约束。

## 游标事务失败与历史修复

可信 delivery 必须来自匹配 binding/manifest/payload hash 的不可变后端回执。一次投递事务原子写入 context receipt、逐条消息 delivery、独立游标事实、游标和 send intent 的交付状态；任一游标写入失败时，这些投递结果整体回滚，先前的可能曝光和已经落盘的独立后端回执保留。

重启事实恢复可依据原回执修复原 manifest，重复扫描或精确回执重放不能重复逐条消息事实或推进两次游标。它不请求供应商，不重放模型输入，也不授予新执行权限。即使成员随后被撤权，已发生的历史曝光仍须保留；新的读取、准备或发送按当前权限拒绝。没有可信完整回执的 interrupted sending 继续 unknown，不能凭重启、进程静止或最大 seq 推断已交付。

## 原生压缩、可信锚点与 seal

固定 Claude SDK 0.3.288 的 `compact_boundary` 必须由受信宿主记录，绑定实际 nativeId、backendVersion、boundary UUID、binding 与 manifest。RC07 将 SDK 的 `compact_metadata` 规范化存入既有原生事件 JSON：`trigger` 为 auto 或 manual，缺失元数据显式记录 unknown；SDK 提供的 `pre_tokens`、可选 `post_tokens` 与 `duration_ms` 分别保存为 preTokens、postTokens、durationMs。未知字段不扩张权限，非法触发类型、负数、非整数 token 或无效耗时拒绝且不留下事件。旧事件没有新增 metadata 时仍按既有合同验证，不需迁移或重写历史。

这些字段证明宿主收到的压缩来源和 SDK 报告值，不是供应商计费凭据。合成供应商 usage 可触发实际安装的 SDK 自动压缩算法，但仍属于注入传输层，不能写成真实供应商自然达到阈值。可信低层直接提交 metadata 仅验证生产者合同，也不能冒充原生事件观察。

本轮另取得受控窗口的真实供应商压缩证据：SDK 0.3.288、CLI 2.1.288，4 次 Invocation、5 次真实 HTTP、4 个 guardian。前两轮使用 100,000 窗口，第 3/4 轮仅在隔离验收环境显式设置 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=32000`；44,999 字节参考材料为合成内容，用量和压缩摘要均来自真实供应商，没有伪造 usage。SDK 产生 auto 边界后，下一次从同 nativeId、同精确 boundary 的锚点续接。该层使用 factory 隔离执行 bypass，不是实际 index 入口；生产模型正常窗口没有改变，也不能据此声明默认窗口自然压缩已验。

压缩以后只允许从覆盖精确压缩边界、输入 UUID、checkpoint、原请求回执和静止进程证据的可信锚点续接。若 SDK 没有提供可用输入 checkpoint，当前响应的合法交付事实仍保留，下一次必须明确冷开；不能为追求同 nativeId 而合成锚点。跨 Thread 来源权限收缩后，旧摘要/锚点也受来源 ACL 闭包约束，必须拒绝旧原生链并以新身份重建当前获权输入，不泄露撤回来源或其他成员私有 transcript。

seal 是受信服务端的不可变边界，同键内容相同可幂等查回、冲突须拒绝。seal 后旧锚点不能继续执行，已静止资源按原证据释放，下一次冷开。RC07 的 seal 验收通过隔离 fixture 调用现有低层端口；产品尚未提供生产 HTTP/UI seal 动作，该层成功不代表新增了可由用户或模型调用的入口。

## 分层证据与退出条件

| 层级 | 通过组数 | 已证明范围与限制 |
| --- | ---: | --- |
| [独立 context](../reports/evidence/threaded-rc07/context.json) | 7 | 来源整条超限、ACL/发布/预算空洞、API 重建、游标失败回滚与多进程恢复、撤权后历史修复、unknown、同波冻结；隔离 SQLite 与合成回执，不是供应商执行 |
| [请求准入](../reports/evidence/threaded-rc07/admission.json) | 5 | ready manifest 的完整 envelope 拒绝、后续可继续、外层 receipt 写失败原子回滚、SDK 本地曝光；本地事务与注入传输，不能从无 fetch 推断 SDK 未曝光 |
| [原生 SDK 注入](../reports/evidence/threaded-rc07/native.json) | 7 | 实际 guardian/SDK CLI，合成 usage 触发 compact_boundary、精确边界同 nativeId 续接、丢失 checkpoint 冷开、来源撤权及低层 seal、metadata 校验；factory 隔离执行 bypass，非实际 index 或真实供应商 |
| [实际 index 注入](../reports/evidence/threaded-rc07/main-injected-final.json) | 5 | 实际 singleton/release/authority，无隔离执行 bypass；来源超限、空洞、同波冻结、游标失败恢复、envelope 拒绝后继续；7 个 index PID，模型响应注入 |
| [实际 index 真实供应商](../reports/evidence/threaded-rc07/main-live-first.json) | 5 | 选定账号下的上述 5 场景、7 个 index PID；来源超限在调用前拒绝，该场景本身 0 供应商请求；不包含完整原生压缩组合 |
| [受控窗口原生注入](../reports/evidence/threaded-rc07/native-injected-live-runner.json) | 1 | 4 次实际 SDK Invocation、5 次注入 HTTP，验证真实供应商 runner 的受控窗口与精确续接路径；不计真实请求或用量 |
| [受控窗口原生真实供应商](../reports/evidence/threaded-rc07/native-live-first.json) | 1 | 4 次 Invocation、5 次真实 HTTP、4 个 guardian，真实 auto 事件和摘要、同 nativeId/精确 boundary 续接；factory 隔离执行 bypass，不外推实际 index 或默认窗口自然压缩 |

31 组专验与 83 组相关回归全部通过，合计 114 组。回归为 context 14、session 13、resource integration 8、queue 11、backend runtime 7、backends 14、production 16；开发失败与修复前复现单独保留，不计通过组数。实际 index 每层的 7 个 PID 来自 5 个场景及 cursor/envelope 各 1 次重启；wave 场景故意串行化容量，专门验证 B 晚于 A 发布仍不吸收本波答案，不能把这层屏障解释为同时执行证明。envelope 场景在拒绝后按隔离发布流程改用匹配输入上限，不修改日常配置。

RC07 实现及所列分层验收完成，默认窗口自然压缩、生产产品 seal、实际 index 完整原生组合和其他账号/平台仍未验，尚未整体验收关闭。低层 seal 合同的已验证结果保留，但产品尚无 HTTP/UI 入口。原 K01–K16、59 项场景及预期保持原文；本轮只更新实现与证据状态，不把通过数量折算为核心合同完成比例。

真实验收继续使用用户已授权账号和原共享累计账本；授权总限为 1000 万 input+output token，本轮保守门禁沿用累计 50 万。按实际 request 发送前预留、凭完整回执记已知用量。RC07 新增 11 个真实请求全部获得已知用量，新增确认 116,740＝主入口 9,482＋原生受控压缩 107,258 token，新增 unknown 为 0；累计已知 187,283＋历史未知 206,832＝保守占额 394,115，门禁余 105,885。原 57 行账本未改，历史 unknown 不被新成功、进程停止或压缩摘要清除；已知 token 不等于价格或历史费用已收敛。RC04 not_observed、RC05 未定位超时、RC06 工程源写/merge 与资源冲突等待等缺口继续保留，日常发布由后续阶段独立决定。
