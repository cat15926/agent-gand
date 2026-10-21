# T10 Action、领域完成与责任代际验收

2026-10-21。T09 已提交并推送 origin/main：`72efefd`。本次在其上完成 T10 代码、v32、专用工具、领域投影及下列验收；T10 尚未提交推送。合同见[Action v1](../architecture/threaded-actions-v1.md)。

| 层次 | 结果与证据 |
| --- | --- |
| Action / 平台域 / 命令端口 | `pnpm verify:threaded-actions` 12 组通过，[机器记录](evidence/threaded-t10-actions/isolated.json)；真实 tasks/facade、独立 SQLite worker 并发、producer SIGKILL、5 个事务故障写点；模型/PR/命令传输明确注入 |
| 实际 GitHub 域 | [只读证据](evidence/threaded-t10-actions/github-real.json)：真实 PR `zts212653/clowder-ai#1649`，HEAD `8efc87c6ba530c665f2f1d5960ae54b4e0f3280d`，获权官方 API、独立作者身份、本地 published review、resolver 再读 live HEAD、changes_requested 完成责任且不批准；历史真实 commit 的 approved 提交被拒绝 |
| 真实 PR 跟踪 | live baseline 与同 HEAD 重读不唤醒通过；等待中未观察新远端 HEAD，动态新事件一次唤醒仍只有注入传输证据，不标整项真实业务全验 |
| 实际浏览器 | `THREADED_UI_ACTIONS=1 pnpm verify:threaded-ui` 12 组通过，[记录及截图](evidence/threaded-t10-ui/report.json)；真实领域责任/holder/generation 投影，原有授权同步、离线恢复、实际隔离 HTTP 进程 SIGKILL/新进程+SQLite 恢复均通过 |
| 迁移 | 15 组：执行冻结实际 T09 v31 worker 升 v32，故障完整回滚、重复升级、旧 descriptor 不变、旧 worker 拒写 |
| 回归 | typecheck、web build、T08 协作17组、协作HTTP4组、实际SDK/HTTP工具接线4组、backend-runtime7组、view HTTP4组、controls、旧入口隔离/兼容通过；其余最终运行结果见实施状态 |

首轮 GitHub 只读验收读取 PR #1641，21 GET，真实本地交付及 baseline 通过但无较旧 commit。第二轮选择含历史 commit 的 PR #1639，23 GET；最终普通A2A接线后第三轮选择 PR #1649，22 GET。后两轮旧 HEAD 的 approved 提交均被 live resolver 拒绝。三轮共 66 官方 GET、远端写入 0。没有发现可复用的“历史已发布 APPROVED review”记录，证据不声称存在该记录；完整已存 approved → HEAD 推进 → revision 的竞态由隔离场景覆盖。

Git 凭据读取曾被自动审批拒绝，原因是来源未明确授权；收到用户明确授权后，仅在内存使用现有 GitHub Git 凭据调用官方 GET，不保存或输出凭据，不发布评论/review。真实账号来源只用于这项只读验收。未读取日常会话、未迁移或启动日常业务库。

SDK runtime回归在受限环境首次返回unknown，允许其本机隔离loopback bridge后7组通过；未据此执行真实供应商调用。

核心负向结果：文本 done/伪造 evidence/未注册 predicate 不产生合法完成；活跃 holder 不能被无凭证抢占；返回只能命中冻结前驱，保留原 HEAD；并行拒绝不能撤走其他成员；完成与合法替换由真实双进程争用产生唯一胜者；旧命令/timer 终态不能复活新责任。平台任务 producer 提交后实际子进程被 SIGKILL，重建 resolver 从精确领域转换补齐唯一候选/完成/通知，模型不重放。普通 A2A 求助仍可唤醒非 holder，且不授予责任。

本次真实模型调用 0、token 新增 0。授权总上限 1000 万 input+output，独立累计硬门禁仍为 20 万；此前占额仍为 75,327，含旧未知预留 39,010。T08 首次征询取消原因仍未定位，未用本次领域验收覆盖该风险。

后续 T11：完整 Review/Revision/findings 与批准门禁、SOP CAS、基础知识来源/版本/ACL。T12：新的远端 HEAD 在 live wait 中到达、实际 OS 命令执行器、生产发布/排空/回滚、其他供应商/平台及完整服务故障组合。生产 `closed|observe|execute` 均继续拒绝新工作，无 executor；本次结果不构成全部 59 项或生产发布通过。
