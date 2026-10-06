# 编排入口阶段 O2 验收记录

日期：2026-10-06。状态：**本地实现与 fixture 验收完成**。对应[O2 架构](../architecture/orchestration-entry-phase-o2.md)与[总计划](../plans/orchestration-entry-convergence-implementation-plan.md)。

## 交付

- 三来源 ExecutionBinding、绑定元数据表、共同授权查询；Coordination claim 与绑定事务一致。
- API/Claude SDK/Codex app-server 的 Coordination 步骤与独立评审适配；已验证六种 execute 协议逐项准入。
- 角色步骤工具收窄、编码 cwd 与产物路径区分、固定 Git 评审快照、目标 attempt/代际绑定。
- 原生审批 Durable Hold、MCP/权限消息 fencing、跨步骤会话隔离、未知原生执行重启暂停。
- 智能匹配页面开放 SDK/app-server，CLI 提示与移除动作保留；O1 幂等入口保持兼容。

## 专项证据

`pnpm verify:orchestration-o2` 使用临时数据库、临时账户目录、临时 Git 仓库和模拟原生 worker。验证实际 stdio RPC/MCP、审批表、Runtime custody、进程收敛与 Git 快照，没有供应商请求。

| 场景 | 验证结果 |
|---|---|
| API / SDK / app-server 单步 | 同一个 Coordination Runtime；没有创建 task_attempts |
| 旧 HTTP 预览/建房入口 | 共同提交事务和 dispatcher 实际执行 SDK Coordination |
| API→SDK、SDK→API、SDK→Codex、Codex→SDK 评审 | Reviewer 不同成员、readonly、固定快照 |
| 原生 FAIL→返工→PASS | 两轮实现/评审及新快照；既有义务收口 |
| 顺序、并行、汇总、辩论 | 六协议完整执行；汇总接分支；辩论 MCP 实际冻结产物 |
| 同成员分支与汇总 | 不同步骤的 sessionBindingId 不同，均 cold |
| CLI / 外部主管 / 复杂协议 | 结构化准入错误或角色校验拒绝 |
| generation / contract / planRevision / 租约 / 未知 origin | 无权调用；真实任务租约过期拒绝；MCP 返回 403 |
| 评审目标换代 | 当前 Reviewer 失权，旧 PASS 不能用于新实现 |
| 审批与安全边界暂停 | native approval 对应 Durable Hold；当前步骤完成，恢复不重放写入 |
| 暂停后修改可变工作区 | Reviewer 仍读实现时的快照内容 |
| 旧代际迟到批准 | 审批拒绝、原生执行取消、没有实际写入 |
| 重启 | 新进程能读取持久绑定且旧绑定失效；未知原生执行不进入自动恢复列表，HTTP 直接恢复返回 409、不再推理 |
| 步骤期限超时 | 执行撤权、失败收尾；没有残留 running attempt 或原生进程 |

`pnpm verify:room-members-ui` 使用 React 页面、拦截 API fixture 和 Chromium。SDK 可触发规划并保留在候选团队；CLI 仍被流水线门禁限制，移除 CLI 不移除 SDK。成员点击不改模式，计划失效与草稿恢复正常。390/1024/1440px 下选择/取消 SDK 的输入框、成员区和表单宽度稳定。真实聊天室创建和供应商模型调用均为 0。

## 回归

已通过：`pnpm typecheck`、`verify:orchestration-o1`、`verify:external-agents-b`、`verify:external-agents-c`、`verify:external-agents-d`、`verify:coordination`、`verify:coordination-planner`、`verify:runtime-coordination-adapter`、`verify:runtime-coordination-closure`、`verify:followup-stage3`、文档链接与 diff 空白检查。

## 限制

此记录确认本地实现和模拟后端协议。没有使用用户真实 Key 或对 GLM、Claude、Codex 供应商请求推理，真实账户/模型连接仍需账户模块测试。CLI Coordination、外部主管、复杂图协议以及 O3–O7 不在本阶段开放。未提交或推送这些工作区变更。
