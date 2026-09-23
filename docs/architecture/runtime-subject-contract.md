# Runtime Subject 与并行完成契约（ADR）

状态：已确立领域语义；阶段 2 不改变现有 Scheduler 的运行结果。

Run 是用户目标的容器，不拥有单一 holder。单持有约束仅适用于 WorkSubject。显式多接收者各自建立 root Subject，默认汇合条件为 `all_required`；部分失败进入 `needs_attention`，不得因为另一分支成功就宣称整轮完成。普通未指派消息由既有路由选出一个目标，只有一个 root Subject。

`initial` 创建 root；`handoff` 和 `resume` 延续同一 Subject；`fanout` 创建 consultation 子 Subject，发起者仍持有父责任；`aggregate` 恢复父 Subject 的执行。Coordination Step 在阶段 7 映射为独立 Subject，Plan 仍负责 DAG 和终局条件。

Dispatch 表示要执行一次，Attempt 表示执行尝试。Attempt completed 只能表示本次调用结束；Subject completed 必须由完成契约接受，Run completed 还需所有必需 Subject 与协议条件通过。`RunContract` 入场冻结，后续修改使用 Revision。阶段 3 才开始影子持久化，阶段 6 才切换完成判定权。
