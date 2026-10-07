# 编排兼容分支清理清单

状态：**盘点工具已实现，尚未授权删除兼容分支。** O7 的实施授权不代替原计划要求的“用户验收确认后再清理”。

## 盘点方法

```sh
pnpm orchestration:cleanup-inventory --output apps/server/data/orchestration-o7-qa/cleanup-inventory.json
```

命令只读业务 SQLite，不初始化表、不迁移、不解密密钥、不派发任务。输出房间映射、活跃冻结任务、待检查状态及入口聚合统计，始终不自动删除。统计没有用户/客户端身份；调用方责任人需要结合自己的客户端和部署清单核对。

## 候选和保留对象

| 对象 | 当前调用方/用途 | 后续处理 |
|---|---|---|
| `api/routes.ts` 旧建房、消息、Run 输入格式 | 外部旧客户端和兼容回归；新版 TaskComposer 使用 `submitTask` | 先确认旧客户端迁移，再关闭旧入场灰度；最后考虑删除包装 |
| 旧 coordination/followup preview | 旧客户端和历史验证脚本 | 新客户端改用统一 preview，旧响应契约保留到确认清理 |
| `apps/web/src/services/api.ts` 旧 createConversation / previewCoordination 等导出 | 本次源码搜索未发现生产组件调用 createConversation / previewCoordination；仍有兼容定义 | 用户确认清理时统一核对引用后删除未使用导出 |
| `orchestration/service.ts` 旧格式适配 | 旧 API 入场、幂等查回和测试 | 不能直接删除新旧入口共享的规范化、冻结和去重代码 |
| `conversation.mode` 历史读取和 `run.mode` 执行投影 | 历史记录、兼容 worker、Coordination/Collaboration 路径 | 保留；不是全部可删除的旧分支 |
| 旧 pipeline / supervisor / Coordination attempt 适配 | 已冻结任务、审批、恢复和终态 | 活跃冻结任务收尾前保留；终态数据读取仍需兼容 |
| 不可重放的账本与未知执行围栏 | 原生调用/文件写入结果未知 | 保留证据和检查要求，不以取消任务代替检查 |
| 旧格式回归脚本 | 证明仍支持的旧客户端契约 | 在对应契约正式移除后再调整，不能为了绿灯先删测试 |

## 删除前证据

1. 版本迁移重复执行通过，待迁移房间为零；损坏/缺主管房间有明确处理记录。
2. 约定观察期完整覆盖实际客户端使用；旧格式调用者有迁移负责人和完成记录。没有统计、短观察期或只看新 UI 都不算证据。
3. 用户指定账户的真实 Claude SDK 与真实 Codex app-server 最小任务均通过，Run ID、后端与冻结绑定可查；供应商失败不能写成通过。
4. 活跃旧冻结任务有兼容 worker 收尾，未知执行有检查记录；不能降级契约或删除状态。
5. 用户审阅验收报告与拟删除对象，**明确确认清理**。确认后再实施独立改动并验证旧任务读取/恢复边界。

## 2026-10-06 本机只读盘点

当前业务库有 39 个房间、69 个 Run，39 条旧房间映射；版本 1/2 已记录，待迁移为零。没有活跃 Run 或待检查未知执行。有一个主管默认房间需要配置：`2a7401d3-fc5c-4202-b018-cfe51d8fd540`。

入口统计没有记录，表示统计证据尚未建立，**不能推导旧客户端调用为零**。真实账户验收与用户清理确认尚未完成。因此本轮保留全部兼容 API 和恢复分支。

2026-10-07 补验：用户指定鸡腿账户的真实 Claude SDK 只读最小任务已通过，Run 为 `b865731a-4739-4490-bae3-e3ddb493400c`；Codex 账户模型测试通过，但带 Run/attempt 绑定的 Codex 编排任务验收仍待完成。详见 [O7 验收记录](../reports/orchestration-entry-phase-o7-acceptance.md)。完整观察期与清理确认仍待完成；本次测试产生的新入口统计不能代替旧客户端迁移证据。
