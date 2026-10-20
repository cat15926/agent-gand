# 持续协作 T07：上下文、Session 与后端 v1

状态：已实现，2026-10-20。接续[消息合同](threaded-messaging-v1.md)、[资源合同](threaded-resources-v1.md)与[运行时合同](threaded-runtime-v1.md)。实际验证范围见[T07 报告](../reports/threaded-collaboration-t07-context-backends-2026-10-20.md)。生产单例仍没有 executor，新工作入场关闭；内部组合工厂的受控验收不改变发布策略。

## 输入与游标

`createThreadedContext` 从持久 Binding、Wake 与冻结 wave 的 `inputMaxSeq` 构建不可变 manifest。调用者不能自选更宽历史、改写 payload 或把未知消息变成已交付。manifest 固定来源、消息/附件版本、原始附件字节、序列化 hash、预算及包含/排除/延后原因。正文包含来源和发送者标记；模型只能收到获权且已发布的内容。跨 Thread 来源递归验权，发送时再次检查，非本地权限版本变更也不能绕过来源撤回。

输入预算使用保守 UTF-8 字节估算，包含附件 base64 和结构开销；消息整体纳入或延后，不截断正文/附件。触发 Wake 的来源自身超限则显式阻塞原 Invocation，证明未发送、退回未使用请求预留并释放容量，不能靠新 Attempt 自旋。系统指令占额单独验证，后端完整 HTTP JSON 还有发送前上限检查；SDK 自带历史和内部协议开销也受该检查。

三类事实独立：

| 事实 | 推进条件 | 不代表 |
| --- | --- | --- |
| delivery | 精确请求的可信传输回执 | Agent 已显式阅读、点名已确认或业务完成 |
| seen | 当前合法执行通过独立端口确认 | 后端已经收到输入或可以跳过注入 |
| mention_ack | 当前合法执行确认具体点名 | Invocation、Action 或征询已结束 |

每条消息有实际交付账本。原生增量输入查精确集合补投，不能以最大序号吞掉较低序号的预算空洞。API 每次重建获权历史，不因 seen 或曾经 delivery 删除必要上下文。内部通知 ACK 不是模型 delivery。

可能曝光与 sending intent 在同一事务记录，且先于外部发送。unknown 不推进 delivery，不允许盲重投；只有可信 not_sent 对账允许新 intent。同一逻辑输入可对应 SDK 多次实际 HTTP，后续回执只能增加审计事实，不能把 delivered 降级或重复推进逐条交付。游标事务失败后，可凭持久后端回执修复原 manifest 的 delivery；已撤权或终态后的历史事实修复不授予新执行权限。

## Session 边界

`createThreadedSessionContext` 使用 T04 的持久身份准备和 CAS；在资源领取之前解析身份，领取时重验版本。API 绑定仅为可重建元数据，没有 nativeId 或原生 resume 能力。SDK 仅在精确原生身份、输入回执、原生 checkpoint 和已静止进程证据全部匹配时记录可恢复锚点。

原生 Session 的边界包括 owner/Thread/member、后端及版本、model、canonical workspace/configDir、账号配置/凭据/身份代际、角色/工具/权限、系统指令及信息边界。任何不兼容变化均保留旧版本并冷开。可能曝光过但无可信锚点、来源权限撤回、seal、未覆盖的压缩边界、旧 Wake 截止小于原生记忆中已曝光序号，均不能直接 resume。旧 Session 有未释放或 reconciling claim 时不能旋转身份。意外 nativeId 必须先持久标记对账，不能自动认领新的 ID。

压缩事件与 seal 为不可变审计边界；摘要如登记，必须保留获权来源。只有覆盖精确压缩边界的终态锚点可续接。T07 没有把摘要注入共享知识；基础知识与 SOP 仍归 T11。真实 SDK 自动压缩的触发范围另见验收报告，不能以确定性测试代替。

## 后端与实际请求

`createThreadedBackendRuntime` 组合专用 runner、上下文、Session、预算、证据和 API/Claude SDK 适配器。配置由服务端 `resolveAgent` 提供，模型/HTTP 调用者不能传连接、账号或身份。持久准备保存配置指纹，不保存认证头；在实际请求及效果边界重验 Binding、ACL、队列、配置和 Session。

Attempt 活动与实际 request 分离。每个实际 HTTP 在 I/O 前原子预留预算、标记请求已启动并写后端 sending 记录，收到完整终态后用精确回执结算。SDK 内部重试、辅助请求、压缩请求也经过本机 relay；不会仅采信 SDK 累计结果用量。隐藏的并行 HTTP 在领取请求预算之前串行化，一份资源 claim 不可绕过容量限制。

API 支持 Anthropic Messages/OpenAI 兼容协议，供应商地址前缀保留。拒绝或不完整传输不制造成功 ACK，不用未记账的兼容重试。输入、输出和价格维度分别结算；缺失缓存价格不会推断为零成本。请求已结束但价格未知可以释放已静止执行资源，费用预留继续保留。传输 unknown 或任何所属进程未证实停止，均不能生成释放证明；后续请求也必须拒绝。

Claude SDK 固定 `0.3.288`，使用独立 worker、明确 cwd/configDir、预分配 nativeId 与专用进程归属。worker 只获得随机 loopback 认证令牌，真实密钥仅在服务端到已配置供应商的认证头中使用。当前 SDK 原生工具限定 Read/Grep/Glob，并遵守工作区读取策略；应用协作工具、写工具、其他驱动待各自任务。完成锚点同时绑定输入 user UUID、原生 checkpoint、实际请求回执和已确认停止的所属进程组。成功结果缺少可信 checkpoint 可完成当前响应，但下一次冷开，不能伪造续接证据。

恢复先执行 T06 生命周期代际撤销，再由 `recoverThreadedBackendFacts` 将 interrupted sending 标为 unknown，并修复具有匹配 binding/manifest/payload hash 的历史 delivery。该恢复模块只读写事实，不导入传输、进程或 executor；不会重新请求模型。

## 存储与发布范围

追加 v30，包括 context/逐条交付/游标、Session 边界/曝光/锚点和实际请求/进程/原生事件证据；v25–v29 已发布 descriptor 与源文件保持不变。迁移失败整体回滚，旧 v29 worker 拒写 v30。

生产 `threaded/service.ts` 保持无 executor、dispatchEnabled=false；资源静止证据按 origin 选择真实验证器，不能拿旧模式或 fake 证明释放新执行。内部工厂明确启用和传入连接才可做隔离验收，closed/observe/execute 配置本身不开放生产入口。

首批实际范围为 macOS 上 API 与固定 Claude SDK，通过 GLM 的 Anthropic 兼容端点。其他供应商/协议/宿主平台的实际运行不能从该结果推导。路由/应用工具/等待/征询、UI、Action、知识/SOP 与完整业务运营闭环仍分别由 T08–T12 验收。官方会话和端点配置背景可参见 [Claude SDK Sessions](https://code.claude.com/docs/en/agent-sdk/sessions) 与[智谱 Claude Code 配置](https://docs.bigmodel.cn/cn/coding-plan/tool/claude)；当前行为以仓库固定版本和实际证据为准。
