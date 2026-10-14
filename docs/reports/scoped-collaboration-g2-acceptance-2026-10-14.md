# G2 独立信封与父恢复验收记录

日期：2026-10-14。开发基线：`main@2129b6f`；本报告与 G2 实现同次提交。关联：[实施指导](../plans/scoped-collaboration-implementation-guide.md)、[实际契约](../architecture/scoped-collaboration-control-v1.md)、[Issue #15](https://github.com/cat15926/agent-gand/issues/15)。

## 1. 验收结论

G2 已完成模型 API 的独立文字材料连续协作：正常聊天室入口、预览确认、逐项信封、material/ACK/result 义务、独立 Scope、固定状态回流、父级唯一恢复、共享预算与 Owner 结果面板。支持最多六项、两批、每批最多三项，并受全局限制约束。

17 项隔离集成用例通过，共 44 次模型桩调用、0 次网络调用，临时库迁移 v14。桌面 1440px 与手机 390px UI 流程通过，共 7 次模型桩调用、0 次外部请求、0 个页面错误。未消耗真实供应商额度，未验证真实账户的模型工具调用稳定性。

## 2. 集成覆盖

| 用例 | 结果 |
|---|---|
| A 完成后继续 B/C；父上下文无子项私密正文 | 通过 |
| 替换私密材料后固定父状态投影保持相同 | 通过 |
| 五项两批、相同角色不同 Scope、共享输出账本 | 通过，8 次调用合计 64 个测试输出 Token |
| 重复确认与父级唯一 wake | 通过 |
| 同命令重放不重复预算；同键不同意图冲突 | 通过 |
| material/ACK/result 区分，material 不调用接收者模型 | 通过 |
| ACK 不能满足 result 义务 | 通过 |
| 第二项权限漂移整批回滚 | 通过 |
| 首次提交后未派发恢复 | 通过 |
| 批次提交后未执行、子项完成后未 wake 恢复 | 通过 |
| Stop 后迟到结果不落地、不唤醒 | 通过 |
| 未知输出用量保留占额、不自动重试 | 通过 |
| 拒绝 any、release、同批重复成员及 v2 回退 | 通过 |
| 外部后端及 rollout 限制 | 通过 |
| 成员版本变动使预览失效 | 通过 |
| 管理路由、会话、CSRF 与 Origin 防护 | 通过 |
| 房间费用政策冻结、共享费用预约、strict/未知价格准入 | 通过 |

上下文测试加入旧房间历史，确认独立事项不自动注入该历史。恢复测试覆盖 G2 基本持久窗口，不代替 G4 的完整 SIGKILL/多 worker 故障矩阵。

## 3. 界面验收

从普通聊天室打开“独立材料协作”，编辑材料、批次、接收者和交付要求；外部 SDK 成员不可选。修改后旧预览失效，费用政策可见。确认后两批连续执行，可查看私密结果与费用状态；刷新可继续查看服务端记录，私密表单草稿不进入浏览器存储。停止任务后迟到结果不恢复执行。

390px 视口无水平溢出；已人工检查手机结果面板与桌面预览截图。截图和 JSON 结果由脚本输出至本地忽略目录 `apps/server/data/scoped-g2-ui-qa/`，不提交合成测试图片。

## 4. 验证命令与相关修正

以下检查通过：

```sh
pnpm typecheck
pnpm verify:scoped-delivery
pnpm verify:scoped-delivery-ui
pnpm verify:scoped-collaboration
pnpm verify:scoped-collaboration-baseline
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-action-commands
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-run-policy
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:message-visibility
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-subject-completion
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:runtime-completion-integration
AGENT_GAND_ISOLATED_WORKER=1 pnpm verify:cost-budget
```

UI 验证使用本机 Playwright 与 Chromium，通过 `PLAYWRIGHT_MODULE` 和 `CHROMIUM_EXECUTABLE_PATH` 指定可执行依赖；测试使用隔离服务与 5174 前端端口。模型、数据库、角色及工作目录均为测试对象。

G0 回归保留旧 v2 私密阻断与公开成功行为，共 17 次模型桩调用、0 网络、0 原生执行。公共动作测试包含现有跨进程竞争与 SIGKILL 验证，但不能据此声称 G2 完整故障矩阵通过。

集成过程中修复房间偏好读取器未接受 `costPolicy` 导致费用设置无法被正确读取的问题，并共享前后端费用字段校验。Run 创建通知移至事务提交后，避免回滚产生幽灵事件。已有完成引擎测试清理前一用例遗留的运行 Attempt，避免污染下一用例成员锁；费用测试改用迁移清单最新版，保留原有费用断言。

## 5. 本地服务与业务数据

实施期间暂停后端，前端 5173 保留。升级前使用 SQLite backup 创建一致备份 `/private/tmp/agent-gand-before-g2-20261014-181415.sqlite`，权限 0600。备份时业务库为 v13，共 83 个任务：completed 65、failed 16、cancelled 1、waiting_for_user 1。所有可写测试均未使用业务库。

已通过 `pnpm --filter @agent-gand/server start` 恢复后端（3010）；前端 `http://localhost:5173/` 返回 HTTP 200，`/api/health` 返回 ok=true、8 个角色、83 个任务。业务库已升级至 v14，原有 83 个任务的各状态数量与升级前一致，`scoped_delivery_plans` 为 0，未在业务库创建验收任务。后端本次采用非 watch 进程，避免文档收尾触发重复启动。

`pnpm verify:docs` 与 `git diff --check` 均通过。

## 6. 尚未覆盖

- G3：独立正文汇总、确切内容授权发布与有限确定性发布规则。
- G4：系统化崩溃/竞争/部分失败恢复与费用强化矩阵。
- G5：Claude SDK、Codex 等原生冷边界及 Coordination 接入。
- G6：真实账户、多场景、灰度、迁移排空与最终发布验收。

旧 v2 任务未自动改造，原现场故障 Run 未重跑。新入口通过不等同于 Issue #15 全部解决或完整狼人杀已验收，Issue 未关闭。
