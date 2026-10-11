# Run 失败关系诊断 v1

对应[平台协作剩余计划 R1](../plans/platform-collaboration-remaining-implementation-plan.md)。诊断沿用现有执行、Attempt、工具和 Runtime 账本，提供只读投影，不增加执行队列或恢复动作。

## 用户交互

失败任务卡优先使用后端的当前失败记录；展开“失败关系与恢复依据”，查看失败成员、前置依赖、后续停止、未知工具结果及次级证据异常。独立分支可以保留多个失败，历史重试和终态关闭产生的状态不作为当前原始故障。

记录展示发生阶段、触发时限和最近可信模型活动。外部执行另展示有效总时限；模型 API 的 HTTP 错误在“查看记录来源”中显示状态码及供应商已返回的可用 Request ID。没有请求 ID、工具终局事件或供应商证据时，不推断供应商故障。仅有控制候选与已提交平台动作分别标注。

恢复判断复用现有 `assessRunRecovery`；该面板不会扩大续跑范围。后续成员取消不能替换当前失败成员的分类；私密、写入、未知副作用、未收敛进程及无法唯一确定的待办仍受现有恢复门禁约束。

## 只读契约与信息边界

`GET /api/runs/:runId/failures` 返回共享 `RunFailureReport` v1；不存在的 Run 返回 404。REST 沿用现有本地所有者读取约定，不新增成员身份查询参数或多租户认证。内部 `runFailureReport(runId, viewerId)` 逐项检查 Attempt/消息/事件权限，先过滤节点，再返回链接、原始失败集合和截断状态；只有所有者得到恢复详情。

节点关联 Dispatch、Coordination 步骤、Task、Attempt、外部执行、Span、责任事项及已提交控制动作。正文和 stderr 使用现有密钥脱敏并限制长度；不投影工作目录、输入上下文、工具参数、原生会话、思考正文和控制动作返回内容。最多返回 400 个节点，优先保留当前失败，并明确标记截断。

| 关系 | 可证明的含义 |
|---|---|
| `same_attempt` | 持久身份绑定至同一次调用，属于关联，不证明某工具导致调用失败 |
| `span_parent` | 记录的调用层级 |
| `depends_on` | 冻结计划或任务账本的前置依赖；不把无关兄弟分支归为受影响事项 |
| `secondary_to` | 执行失败后的证据采集异常，不替换原执行失败 |
| `failed_at_terminal` | 终态事务关闭执行之前已经失败的事项，不据此宣称它是唯一终止原因 |
| `terminal_cancel` | 原生 AbortReason 明确引用该 Run 终态，证明后续调用因此停止 |

`control_interruption` 保留受控停止语义；动作账本按 Attempt 绑定，区分已提交与只有候选。`missing_terminal` 保留结果未知，不升级为已确认的工具错误或业务完成。旧重试错误保留实际 Attempt ID，不与新 Attempt 合并。

## 持久化与事务

失败/取消终态增加元数据事件 `failure:terminal_boundary`，与终态处于同一事务，提交后才发布。事件只保存版本、Run、终态来源、关闭前已失败事项和未完成事项的 ID。后续关闭将未完成事项改为失败时，诊断将其解释为受影响的关闭记录，避免制造新原始故障。重复终态不增加快照，事务回滚不留下快照或通知。

Runtime `commitRunTerminal` 与兼容 `finishRun` 均记录边界；直接使用历史状态写入的记录没有因果快照，读取不会自动补写。新增契约使用现有 JSON 事件与执行记录，无数据库迁移；旧任务、旧终态和原验收账本不改写。

模型 API 保留错误中的 `llm.http_status`、合法且脱敏后未变化的 `llm.request_id`；只识别响应中的 `x-request-id` / `request-id`。超时 Span 增加失败阶段、时限毫秒、首次和最后模型活动时间。晚到供应商回调仍通过原有 AbortSignal 围栏隔离。

## 验证入口

- `pnpm verify:run-failures`：多分支、历史重试、关闭前快照、控制/未知工具、隐私与脱敏、只读不变、冷进程、回滚和 HTTP 契约。
- `pnpm verify:execution-timeouts`：模型 API 时限和 HTTP Request ID、实际流解析、晚到回调、CLI 时限、未知预约及排队隔离。
- `pnpm verify:external-agents-c`：实际 SDK/app-server 驱动连接本地模拟进程，双向交接后超时、私密咨询与汇总、控制纠偏、审批/工具账本、Stop 和权限围栏。
- `pnpm verify:platform-network`：实际回环 HTTP/WS、冷主机重启、并发幂等、丢失响应、重连历史、超时晚到回调及未知调用不重放；推理仍为模拟。

网络夹具的 `R1_VERIFY_UI=1` 开启实际 Chrome 验证，先构建 Web；可通过 `PLAYWRIGHT_MODULE` / `CHROMIUM_EXECUTABLE_PATH` 指定本机运行时，`R1_QA_DIR` 指定截图目录。默认输出至忽略目录 `apps/server/data/platform-r1-qa`。所有夹具使用临时数据；不使用真实供应商凭证。

实现及验收记录见[R1 进度报告](../reports/platform-collaboration-r1-acceptance-2026-10-11.md)。
