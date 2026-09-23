# Runtime Completion Engine（阶段 6）

## 判定与提交分离

Agent 的 `finish` 或无控制动作正文只形成完成候选。纯函数 `evaluateCompletion()` 不写数据库；Scheduler 在判定为 accepted 后才持久化最终消息与 Run 终态。每次不同判定写入 `runtime_completion_evaluations`，协作详情 API 返回 `completionEvaluations`，便于前端和故障分析查看 waiting/rejected/failed 的原因。

普通完成必须同时满足：无开放 Dispatch/Batch/Decision；所有 required Subject 已完成；consult 等后继 Subject 已完成；Custody 无 pending holder 且代际有效；每个工作项有完成输出；Capsule 证据仍可解析；依赖、必要产物、审查及协议终局通过。后四项是 Coordination 阶段 7 可直接映射的公共输入，不在判定器中复制 Coordination 规则。

失败、阻断、取消或 partial/timeout Batch 会得到 failed；条件尚未满足但没有失败时得到 waiting/rejected。Scheduler 将无法继续的 rejected/failed 映射为 Run failed，并发布一条包含中文原因的系统消息，不发布 `collaboration_result`。多 root Subject 使用 all-required；只有全部接受后，按稳定 clientMessageId 发布一次最终报告。服务在最终消息后崩溃时，重启重试会命中消息幂等键。

两种显式用户裁决是例外但仍经过引擎：用户接受预算边界的部分结果要求至少存在一个输出，记录 `partial_user_accepted`；用户批准转入 Supervisor Run 记录 `delegated`，不重复发布 Collaboration 最终报告。

## 发布边界

`COLLAB_COMPLETION_ENGINE=true` 才接管新建 Collaboration Run 的终态，并隐含启用事务级 Custody。默认关闭。接管标记冻结在 Run Contract 中，因此进程重启、启用或回退开关都不会改变已有 Run 的完成语义。阶段 7 之前，Coordination 仍使用自己的终局提交，但它的依赖/产物/reviewer/协议状态已经有公共判定输入。

验收：`pnpm verify:runtime-completion`、`pnpm verify:runtime-completion-integration`、`COLLAB_COMPLETION_ENGINE=true pnpm verify:collaboration`、默认 `pnpm verify:collaboration`、`pnpm typecheck`。
