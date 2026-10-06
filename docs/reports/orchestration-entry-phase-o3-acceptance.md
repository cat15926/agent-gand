# 编排入口阶段 O3 验收记录

日期：2026-10-06。状态：本地实现与 fixture 验收完成。对应[O3 架构](../architecture/orchestration-entry-phase-o3.md)与[实施计划](../plans/orchestration-entry-convergence-implementation-plan.md)。

## 交付

兼容 TaskAttempt Runtime 适配器、TaskBinding 责任校验、公共上下文与候选完成、成员持久 FIFO、内置及原生共同工作区锁、Run 编排 owner、任务动作服务、按分支重试与崩溃恢复围栏。聊天室 dispatcher 解除整房串行，观察面板停止成员动作明确携带 Run。

## O3 专项验证

`pnpm verify:orchestration-o3` 使用临时 SQLite、临时角色和 mock Provider。多进程 worker 调用实际编排代码，SIGKILL 用于真实崩溃边界。真实供应商请求为 **0**。

| 场景 | 结果 |
|---|---|
| 直接 Run / 流水线 | execute 契约、现有 TaskAttempt 及 responsibility binding；已结束绑定失权 |
| 重复完成、失败回调、状态更新 | complete 动作命令与终态 CAS 各仅一次；拒绝覆盖结果；终态不能重新置 running |
| 空输出 / ACK / fast path 分支失败 | 不接受完成；成功分支仍保留 |
| 同房 / 跨房同成员 | FIFO，模型调用区间不重叠 |
| 空闲成员 | 在另一成员被阻塞时完成独立只读任务 |
| Collaboration / 流水线混排 | 共用 FIFO，资源释放唤醒另一个聊天室的 Dispatch |
| Collaboration 暂停 / 恢复 | 已验收输出复用，恢复不额外调用模型 |
| 取消排队 B | B 未调用模型，A 继续；终态 resume 返回 409 |
| 流水线暂停 | 第一步收尾后暂停，恢复只执行第二步 |
| 主管任务 / 独立审查 / 汇总 | 共同 execute 契约与 TaskBinding；真实 PASS 关闭 review Subject |
| 主管失败分支重试 | 新 Run，复用已确认分支；旧失败 Run 不变；重复 retry 返回同一新 Task |
| 同名工作区跨 Run | 写者持有时其他成员不能进入模型/工具执行；释放后读取继续 |
| 多 worker 同成员 | SQLite 持久互斥与 FIFO；重复 worker 不重放同一 Run |
| 已开始但未知结果的 SIGKILL | Run 等待用户，resume 409，模型不重新调用 |
| 未知调用的定时唤醒 | Hold 保留，不能改变 Run 或绕过恢复围栏 |
| 仅排队的 SIGKILL | 按原队列恢复，首次调用仅一次 |
| 结果持久化、编排终态未提交 | 原 TaskAttempt 结果恢复，模型调用仍一次 |
| 主管规划已确认、DAG 未保存 | 复用规划结果并建立实际任务，不能假完成空任务列表 |
| 无有效契约的历史活跃 Run | 等待核对，resume 409，没有自动补契约或调用模型 |

专项输出 **12 组检查，全部通过**。表格将组内边界单独列出；原生 SDK/Codex 与 Coordination 回归另见下方。O3 专项中的 API 并发使用 mock 延迟与可控门闩。

## 回归与检查

| 检查 | 结果 |
|---|---|
| `verify:orchestration-o1` | 12 组通过，规范化、预览、幂等与兼容提交保持有效 |
| `verify:orchestration-o2` | 14 组通过，SDK/Codex 绑定、固定评审快照、审批及未知原生恢复围栏有效 |
| `verify:external-agents-b` / `verify:external-agents-c` | 原生 fixture 工作/评审、MCP、接力/咨询、Hold、审批、指定 Run 停止及回调去重通过 |
| `verify:coordination` | 规划、执行、产物屏障、返工、辩论、截断重试、隔离、审批暂停恢复及重启通过 |
| `verify:runtime-terminal` / `verify:runtime-action-commands` | 终态与原子命令回归通过 |
| `verify:runtime-hold-recovery-v2` | 定时边界、失败隔离、退避、代际、恢复审计及跨进程 claim 通过 |
| `verify:collaboration-exit` / `verify:runtime-exit-guard` / `verify:followup-stage3` | 回合退出、完成门禁与追问回归通过 |
| `pnpm typecheck` / Web production build | 通过 |
| `verify:docs` / `git diff --check` | 通过 |

Coordination 额外确认：审批超时暂停保留成员预约，恢复复用原 Attempt；未知模型调用崩溃后 Plan 与 Run 同步暂停，旧/新恢复接口均返回 409。两处旧断言随 O3 契约更新：必需目标部分失败不能显示整轮成功，未知调用不能自动重放。停止成员 fixture 新增“缺少 Run 返回 409 且执行未被取消”的断言。

测试全部使用 fixture 或 mock，不使用用户提供过的密钥，也没有验收真实模型连接。

## 验收入口与限制

现有建房、消息、直接 Run 页面继续使用原交互。可创建同成员的多个任务观察顺序、创建独立成员任务观察并发；Run queue API 可查看预约，统一 actions API 可验证暂停、恢复与取消。

界面完整队列/任务动作、每轮策略与工作流选择仍属于 O4/O5。分支重试仅开放主管任务；未知副作用与原生写入工作树自动迁移未开放。真实 Claude SDK、Codex 服务和用户账户验收仍按 O7 单独进行。本阶段没有提交或推送。
