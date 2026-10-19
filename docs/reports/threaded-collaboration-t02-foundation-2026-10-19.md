# 持续协作 T02 基础边界验收记录

日期：2026-10-19（Asia/Shanghai）。任务范围：shared 类型、独立模式路由、稳定身份、旧路径隔离、schema 与迁移。

## 基线与交付

T01 文档已按用户要求提交并推送至 origin/main，提交 `0a2f1b4`（`docs(threaded): freeze T01 design and acceptance baseline`）。T02 基于该提交实施；运行代码底座仍为 T01 核对的 `b95dc2553405268a9b807b3983fee8f9facc55fa`，T01 源码清单保留为历史证据，不覆写其 hash。

当前实现见 [T02 架构合同](../architecture/threaded-foundation-v1.md)：独立 RunMode/LegacyRunMode、默认关闭策略、专用认证快照接口、旧 HTTP/WS 及执行路径隔离、v25 六表基础迁移与注入式 store。没有实现 Threaded 调度或真实执行。

## 命令与结果

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | shared/server/web；旧 DTO 显式收窄，新模式类型可编译 |
| `pnpm verify:threaded-migration` | 通过，7 组 | 空库、v24 历史、重复迁移、稳定 owner、作用域/唯一约束、故障回滚、未来版本/checksum 拒绝；实际冻结 v24 兼容检查器拒绝 v25 |
| `pnpm verify:threaded-legacy-boundary` | 通过 | 混合 HTTP 集合/直接/派生 ID、读写和 WS；旧记录继续可读，新记录不可泄露或经旧路由变更；零外部请求 |
| `pnpm verify:threaded-access` | 通过 | 专用会话、CSRF、Host/Origin、owner、版本、WS 失效与关闭入场 |
| `pnpm verify:threaded-isolation` | 通过，6 组 | 新模式/未知模式/错配记录不被旧 dispatcher/recovery/terminal/executor 接管；快照不变，零回调；旧三模式终态正向对照 |
| `pnpm verify:runtime-run-policy` | 通过 | 原冻结策略及历史兼容解释 |
| `pnpm verify:runtime-terminal` | 通过 | 原终态证明、事务 CAS、并发/进程崩溃和回滚通知 |
| `pnpm verify:runtime-action-commands` | 通过 | 原动作账本、幂等、跨进程竞态与 SIGKILL |
| `pnpm verify:runtime-hold-recovery-v2` | 通过 | 原持久等待恢复、过期与代际边界 |
| `pnpm --filter @agent-gand/web build` | 通过 | 前端旧入口构建兼容；保留非阻断的 chunk 大小提示 |
| `pnpm verify:docs`、`git diff --check` | 通过 | 文档链接、补丁空白；新增未跟踪文件单独检查空白 |

迁移脚本使用独立 SQLite，并读取 Git 中固定 T01 提交的旧迁移模块作为兼容参照；新旧 guard 均未打开日常业务库。故障注入检查 DDL、owner 和迁移登记在同事务回滚后可重试。旧 rows 与 v1–v24 checksum 保持原样。

## 验收 ID 的结论边界

| 原 ID | 本轮结论 | 后续仍须验证 |
| --- | --- | --- |
| DB03 | **v25 迁移范围通过** | T05/T06 后续迁移、完整发布/回退演练 |
| ISO01 | 旧路径及所列旧回归子场景通过 | T03–T12 的执行、资源、完整旧模式端到端回归 |
| ISO02 | 隔离骨架子场景通过 | 实际 Invocation/Run adapter 与完整恢复故障窗口 |
| ISO03 | 认证/旧入口/伪造 Binding 子场景通过 | 生产 Binding、工具/回调代际及权限收缩 |
| CTX02、UI01 | 旧读取/WS 旁路子场景通过 | 新消息及附件 ACL、完整上下文、增量事件重连/去重 |
| 其余原 ID、E01–E06 | 未执行 | 保持原任务责任，不用基础测试替代行为验收 |

本轮不声称原 59 项全部通过，也不声称任何真实后端或业务域可用。专用 WS 只提供持久快照；不把没有消息执行的连接测试称为完整 UI 重连通过。

交叉复核发现并修复了账户发布策略的派生 ID 旁路：原补丁仅在响应过滤时返回 404，但 revoke 已提交。现在在 preHandler 查询真实 run_id 后拒绝；负向 fixture 断言返回 404 且策略仍为 proposed/version1，发布 grant 仍为 ready。运行隔离还补齐了恢复器只发 scheduler 事件但不写库的边界，拒绝路径无旧事件输出。

## 操作范围与交接

T01 已推送；T02 代码和文档留在工作区供审阅。没有启动日常服务、迁移日常数据库、修改账号凭据、调用真实供应商或发布业务消息。T02 的配置 observe/execute 均保留不可执行门槛，新前端入口未开放。

下一任务为 T03：在现有 schema 与类型上实现可信 Binding、Invocation 对 Run 的唯一适配、专用 lifecycle/terminal 端口、授权复查和 fake executor。未知外部执行不得复用旧 finally 的无条件释放；与 T04 资源合同联调后再进入 T06。
