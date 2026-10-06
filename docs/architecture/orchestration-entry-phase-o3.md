# 编排入口阶段 O3：执行准入、队列与任务动作

日期：2026-10-06。状态：本地实现完成。依据[实施计划](../plans/orchestration-entry-convergence-implementation-plan.md)，验证见[O3 验收记录](../reports/orchestration-entry-phase-o3-acceptance.md)。

## 执行入口

Coordination 继续使用原 StepAttempt，Collaboration 继续使用原 Dispatch/Attempt。直接 Run、旧流水线、定向/简单追问 fast path 和主管工作、评审、规划、汇总使用 TaskAttempt 适配器。

兼容入口在调用前冻结 `execute / runtime / commands_v1` 契约。没有新增 Attempt 状态机：`orchestration_turn_tasks` 将稳定 scope 对应到既有 Task，`runtime_task_subjects` 将 Task 的 work/review 对应到公共 Subject。主管 DAG 使用既有任务及依赖；本阶段不替换 O1 比较决策，也不实现 O4 的新策略解析。

步骤执行顺序为：既有调度器领取 → 公共 Custody 获得责任 → 捕获 ExecutionBinding → 成员资源准入 → 工作区租约 → 模型与工具 → 完成候选 → 既有 Attempt/Task 收尾。TaskBinding 增加可选 responsibility，校验 Subject、代际、契约修订和任务租约。工作项声明先于并发调用，避免新增必需 Subject 使运行中的绑定失效。

适配器调用使用公共 Context Contributor 记录身份、责任及契约。主管拆解和汇总关闭普通工具；工作步骤继续执行角色工具政策。独立 Reviewer 始终只读；有固定快照时，模型 API 和原生 Reviewer 都读取该快照。

## 成员与工作区调度

聊天室 dispatcher 按 Run 派发；聊天室本身不占串行执行槽。`execution_member_tickets` 只记录成员资源预约，引用原 Attempt，不拥有任务结果或派发权。其自增序号定义进入执行准入的 FIFO。

- 同一成员跨 Run、跨聊天室和跨编排器独占执行。Collaboration 的就绪 Dispatch 先预约，领取时验证预约顺序；不同聊天室的队列在资源释放后被唤醒。
- 有依赖的未来步骤在就绪后排队，不预占成员。暂停中的未调用任务让出成员；恢复后保留其预约序号，当前执行者仍先收尾。
- 不同成员可以并发只读。并行波次继续受各调度器原并发限制约束。
- 互斥使用 SQLite 持久 lease 与 host/PID/进程身份。租约到期不抢占仍存活的执行者；无法验证的原生进程保留成员和工作区围栏。
- 兼容流水线/fast path/主管编排另持有 Run 编排租约，重复 worker 观察到活动 owner 后退出，不将另一 worker 的 Run 判为失败。

所有内置执行持有工作区 lease。命名工作区使用规范化真实路径；直接注册的外部工作区以注册根锁定，不能通过 scope 子目录绕过。非外部内置执行同时锁定 `shared/`。只读 lease 可共享，写 lease 独占。原生执行沿用同一 lease 表，并等待占用释放。

隔离 Git 工作树拥有不同可变 cwd，可以按既有规则独立运行；固定评审快照按其真实路径共享读取。工作区锁不等于允许合并、提交或部署。

## 完成与终态

TaskAdapter 将结果交给公共 ExitGuard、SubjectCompletionCandidate 和 EvidenceBundle。证据引用原 TaskAttempt 输出；公共 complete 动作命令在同一事务内保存候选、完成 Attempt 与责任并记录命令。重复提交相同结果复用原命令，改变已完成结果则拒绝。Reviewer FAIL 不能完成 review Subject，返工进入新代际；只有当前 PASS 能完成该责任。

空输出、截断、审批饥饿及单纯 ACK/“收到”不能通过完成门禁。公共 ExitGuard 的 ACK 检查也适用于 Coordination 和 Collaboration。fast path 的全部目标都是必需分支，一个分支失败时保留其他输出并显示失败，不自动接受部分结果。

适配器 Run 仅通过 `commitRunTerminal` 提交终态，在事务内重新读取公共完成快照。报告引用、用户消息状态和完成评价同事务提交；重复完成或取消只有一个终态记录。`finishRun` 兼容调用在 TaskAdapter Run 上委托给同一边界；`setRunStatus` 不再复活终态 Run。

## 任务动作 API

| API | 行为 |
|---|---|
| `POST /api/runs/:runId/actions`，`action: cancel` | 只取消该 Run；收尾 Attempt/责任/审批并停止其原生执行 |
| 同上，`action: pause` | Coordination 使用原安全步骤边界；流水线按当前步骤、fast path 按当前并行组、主管按当前任务波次、Collaboration 按当前 Attempt 收尾后暂停 |
| 同上，`action: resume` | 验证用户暂停及恢复围栏；继续既有计划/任务，复用已确认结果；待用户回答不走此入口 |
| 同上，`action: retry, taskId` | 仅支持主管失败分支；原终态保持不变，新建关联 Run，复用可信已完成分支和真实 PASS，继续失败及依赖分支 |
| `GET /api/runs/:runId/queue` | 返回该 Run 的成员资源预约与前方等待数，供 O5 任务卡使用 |
| `POST /api/tasks/:id/cancel` | 仅撤销该 Task 的 Attempt，按 attemptId 停止原生调用 |

旧 Run stop、Coordination pause/resume/cancel、Collaboration Run stop 及 Task retry/cancel 包装共同服务。旧“停止成员”入口必须携带 `runId`，前端观察面板已补齐；不能再只凭聊天室取消其他任务。

分支重试按来源 Task 持久去重。重复请求返回同一新 Task；再次失败应对新 Task 发起下一次重试。已有未知工具副作用、未确认原生调用、用户取消分支或原生写入工作树时返回 409，需要核对工作区并明确建立新任务；不会仅复制文字输出并声称代码已迁移。通用失败步骤 UI、原生写入恢复检查和新任务卡属于后续阶段。

## 崩溃与恢复

服务先收敛原生进程，再恢复成员预约，然后关闭旧 TaskAttempt 和重建可恢复任务责任。

1. 尚未调用的资源预约保留 FIFO 序号。旧 Attempt 关闭，新 Attempt 从同一逻辑 scope 继续，第一次模型调用不会被误作重复调用。
2. 已开始但没有持久结果的调用，标记 recovery attention，Run 等待用户；自动恢复不领取它，普通 resume 返回 409。Coordination Plan 同步暂停，旧恢复接口、成员领取、执行绑定和定时 Hold 唤醒也检查此围栏。
3. API 回合已保存完整结果、或适配器 Task 已确认完成时，恢复消费原记录，不重复请求模型。
4. 原生调用继续执行 O2 的未知副作用围栏；固定原生结果尚未提交到步骤时，Coordination 的直接恢复限制保留。
5. 主管尚未持久化 DAG 时，恢复重新走原拆解入口，已有规划结果按稳定 scope 复用；不能把“任务列表为空”解释为工作已完成。
6. 已知的审批超时暂停保留成员预约与工具调用检查点；恢复复用原 StepAttempt，按已持久化请求继续审批，不额外生成失败 Attempt。

新增表均为增量 `CREATE TABLE IF NOT EXISTS`。历史终态保持可读；缺少有效适配器契约的历史活跃流水线/主管/fast path 保留为等待核对，不能自动补契约并重跑。完整迁移与回滚范围由 O6 处理。本阶段验证的是当前入口生成的执行契约与恢复边界。

## 本阶段边界

O1 的规范化/幂等与 O2 的能力准入、原生绑定和会话限制继续有效。本阶段没有实现 O4 策略解析、新模板，或 O5 前端任务卡。只读 CLI、外部主管及未验证复杂协议的限制保留。本地 fixture 通过不代表用户账户或真实供应商连接通过。
