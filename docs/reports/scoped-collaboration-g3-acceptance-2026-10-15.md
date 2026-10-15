# G3 私密汇总与授权发布验收记录

开发与自动化验收：2026-10-14；最终收尾：2026-10-15。开发基线：`main@cbb13e1`；本报告与 G3 实现同次提交。关联：[实施指导](../plans/scoped-collaboration-implementation-guide.md)、[生效契约](../architecture/scoped-information-release-v1.md)。

## 1. 交付结果

已交付普通聊天室中的私密汇总读取授权、独立汇总 Subject/Scope、`agent.request_release` 私密草稿、草稿版本编辑、完整内容预览、Policy/Grant/Record、单次发布、撤销、过期及专用持久 Hold/Wake。

Owner 可授权汇总者读取 A/B 两份结果，保留原报告范围，再仅将指定总评发布给第三名成员。发布是创建新消息；普通回答“全部授权”不能消费授权或唤醒等待。

固定投影 `status-receipts-v1` 只发布已选结果的 key/state，绑定当前快照、接收范围及一次消费。尚不支持未来内容循环预授权、任意自然语言自动脱密、附件和原生后端。

## 2. 隔离集成验证

`pnpm verify:information-release`：15 类用例通过，30 次模型桩调用，0 次网络调用，临时库迁移 v15。

| 用例 | 结论 |
|---|---|
| 显式授权报告副本、独立汇总、父上下文干净、共享账本 | 通过，原报告正文与 ACL 未改动 |
| 普通用户回答不签发授权、不唤醒 | 通过 |
| 确切文字只对获准成员可见、重复发布唯一消费与恢复 | 通过 |
| 编辑草稿使旧 Grant 失效，新版本按确切字节发布 | 通过 |
| 撤销阻断未发布 Grant | 通过 |
| 过期 Grant 拒绝 | 通过 |
| 原始输入内容漂移阻断，不能只检查最后一条报告 | 通过 |
| 新增输入账本记录阻断旧 Grant | 通过 |
| Stop 先提交时拒绝发布 | 通过 |
| 固定状态投影与发布后撤销不改写事实 | 通过 |
| 同一任务的多个已批准 Grant 竞争，只有一个消费；事实不可修改/删除 | 通过，同进程竞争；完整跨进程矩阵留 G4 |
| 未支持变换、额外 confirm 字段及无效接收者拒绝；批准不调用模型 | 通过 |
| 汇总读取确认前成员变动拒绝 | 通过 |
| Stop 后迟到汇总不能新增草稿或发布 | 通过 |
| 管理会话、CSRF、Origin 与 Owner 审计 | 通过 |

测试使用临时数据库、角色、私有目录、工作区和拒绝网络的模型桩。未调用真实供应商或原生客户端，未创建业务验收任务。

## 3. UI 验收

`pnpm verify:information-release-ui` 从正常聊天室打开抽屉，先完成 G2 分批任务，再通过实际表单完成 G3 读取授权、私密汇总、草稿编辑、旧预览失效、批准、撤销、重新批准与发布。刷新后保留版本、撤销和发布事实。桌面 1440px、手机 390px 无水平溢出。

最终脚本记录 5 组检查、8 次模型桩调用、0 次外部请求、0 个页面错误。验收截图与结果 JSON 位于本地忽略目录 `apps/server/data/scoped-g3-ui-qa/`；桌面发布完成页、手机预览及发布页进行视觉核对，不提交这些测试图片。

验收中修复了两处交互/状态问题：发布准入要接受专用 Hold 的 waiting Subject；撤销后的新批准要使用新的幂等提交编号。发布完成后的卡片展示持久化的实际接收范围，避免刷新后显示未选择的默认表单造成误解。

## 4. 回归检查

以下检查通过：

```sh
pnpm typecheck
pnpm verify:information-release
pnpm verify:information-release-ui
pnpm verify:scoped-delivery
pnpm verify:scoped-collaboration
pnpm verify:scoped-collaboration-baseline
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-action-commands
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-run-policy
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:message-visibility
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-completion-integration
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-durable-holds
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-hold-recovery-v2
```

G2 保持 17 类用例、44 次模型桩调用、0 网络。G0 仍复现旧 v2 私密阻断与公开成功对照，17 次模型桩调用、0 网络、0 原生执行。G1 继续拒绝没有完整执行计划的 v3 基础契约和未知版本；支持矩阵仅开放模型 API 的控制与文字发布包。

浏览器脚本使用本机 Playwright/Chromium，通过 `PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE_PATH` 指定依赖，隔离前端端口 5174。公共 Hold/Action Command 原有跨进程测试通过，不据此宣称 G3 所有发布故障窗口已通过。

## 5. 本地数据与服务

开发开始前停止非 watch 后端，前端 5173 保留。使用 SQLite backup 创建一致备份 `/private/tmp/agent-gand-before-g3-20261014-225257.sqlite`（0600）。升级前业务库 v14，共 83 个任务：completed 65、failed 16、cancelled 1、waiting_for_user 1。

2026-10-15 已恢复非 watch 后端（3010），前端 `http://localhost:5173/` 返回 HTTP 200；`/api/health` 返回 ok=true、8 个角色、83 个任务。业务库升级至 v15，原有任务的各状态数量与升级前一致，`information_release_workflows` 和 `information_release_records` 均为 0。后端日志保存在 `/private/tmp/agent-gand-g3-server-20261015.log`。

最终 `pnpm verify:docs` 与 `git diff --check` 通过；验收记录随实现提交。

## 6. 剩余阶段

G4：更完整的跨进程发布/Stop/撤销/恢复竞争、故障注入、部分失败及费用矩阵。G5：Claude SDK、Codex 等原生隔离和 Coordination 接入。G6：真实账户、多场景、灰度、迁移与最终发布验收。

本阶段不自动修复历史 Run、不关闭 Issue #15，也不将桩验证推广为真实模型稳定性或完整狼人杀能力。G3 新汇总是明确授权并单独计费的新任务，已完成 G2 Run 的冻结契约保持不变。
