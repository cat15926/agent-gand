# Issue #15 私密咨询后连续调度阻断分析

日期：2026-10-13。证据类型：源码核对＋隔离数据库函数级复现。
源码基线：`d6abb7abba6cfa789d127ab4372160e56bcb3fda`。关联：[Issue #15](https://github.com/cat15926/agent-gand/issues/15)、[正式实施指导](../plans/scoped-collaboration-implementation-guide.md)。

后续进展：G0 已于同日完成仓库内真实调度集成复现，详见 [G0 验收记录](./scoped-collaboration-g0-acceptance-2026-10-13.md)。以下保留先前函数级分析的原始证据范围；其限制不等同于后续 G0 的覆盖范围。

## 1. 结论

当前代码可复现“公开父任务 → 私密咨询 A → 私密汇总 → 继续咨询 B 被拒”。权限保护与现有契约一致，但平台缺少父任务仅接收获准状态后独立继续调度的路径。

这是持续私密协作的能力缺口。R7 的冻结阶段图和逐成员范围、R8 的既有真实后端验收，没有交付动态 Collaboration 的 clean_control 返回或消息披露授权。

## 2. 证据范围

| 事项 | 本次核对结果 |
|---|---|
| 当前 Git 基线 | `main@d6abb7a`，分析开始和结束时工作区干净 |
| 代码迁移清单/本地业务数据库 | 至 v11；数据库以只读方式检查 |
| Issue 正文 | 通过 GitHub 公开 API 读取；当次状态 open，评论 0 |
| 原始故障 Run | Issue 引用 `f5f6e3b2-b660-4f4e-bdaf-557472f91d76`，本地业务库未找到 |
| 现场四次错误及时间线 | 来自 Issue，本次没有独立重验 |
| Windows 源码包与 5173 现场部署 | 不推断其与本机代码、数据库或进程一致 |
| 供应商调用 | 本次函数级复现为 0；没有启动原生模型执行 |

报告不包含原玩家身份、私密正文、账户或认证信息。

## 3. 函数级复现方法与结果

临时 Node/tsx 脚本使用独立 SQLite、角色和私有目录，设置 `AGENT_GAND_ISOLATED_WORKER=1`，移除供应商/账户环境变量，阻断 fetch，配置独立 sandbox 路径。实际加载生产 Context、Action parser、Store、权限及 Batch 汇总函数。

构造 C/A/B 三成员与公开根消息，冻结 Runtime 契约，创建父 Dispatch；用真实 parser 校验私密咨询 A。测试构造对应 Batch/子 Dispatch，并用合成数据写入已完成子任务，随后调用生产 `reconcileCollaborationBatches` 与 `assembleCollaborationContext`。

| 检查点 | 实际结果 |
|---|---|
| 初始 Context | public，audience 为空 |
| C→A 私密材料 | private，audience 为 C、A、user |
| 系统汇总消息 | private，audience 为 C、user |
| 汇总后 C 的 Attempt | private，audience 为 C、user；Context 含合成 A 结果 |
| C 再咨询 B | 拒绝，错误为“私密来源不在目标成员的可见范围内，即使再次声明 private 也不能扩大授权” |
| 改写任务文案后咨询 B | 相同拒绝 |
| C 再咨询 A | 相同拒绝 |
| 反事实：保留 C、A、user 再咨询 B | 仍拒绝，说明仅删除汇总收窄不能解决连续调度 |
| 对照：以原公开来源另行构造 Context | 不含 A 材料/结果，parser 可以接受向 B 的 private 请求 |
| 最终 Dispatch | initial、fanout、aggregate；没有 B Dispatch |
| 退出清理 | 隔离 Run 取消、数据库关闭、临时数据目录删除 |

原函数级复现脚本位于当次主机 `/tmp/agent-gand-issue15-repro.mjs`，不作为持久验收资产或公共依赖。G0 已新增仓库内受维护的 [调度基线测试](../../scripts/verify-scoped-collaboration-baseline.mjs)。

**边界：**子任务完成由测试播种，未通过真实模型、完整 Action Command 提交链或浏览器。公开 Context 对照由测试直接构造，不表示产品已有授权后的 clean_control 恢复入口。timer 和普通 answer 的继承结论来自代码阅读，本次未运行完整定时/用户恢复链。不能据此标记 G0 完成。

## 4. 代码依据

| 代码 | 对应事实 |
|---|---|
| [scheduler.ts](../../apps/server/src/collaboration/scheduler.ts)：applyAction / maybeCompleteBatch | 共同 objective 咨询；私密来源及结果权限交集；汇总仅保留发起者和 user |
| [controlTools.ts](../../apps/server/src/collaboration/controlTools.ts)：parseControlCall | 当前来源为 private 时校验目标可见性，重新声明 private 不扩权 |
| [context.ts](../../apps/server/src/runtime/context.ts)：assembleCollaborationContext / persistRuntimeContextAssembly | 来源范围影响可注入消息及持久 Context 范围；同 Attempt 不允许漂移 |
| [access.ts](../../apps/server/src/messaging/access.ts)：attemptAccess | 优先读取已冻结 Context，未存在时沿用 Dispatch 来源 |
| [decisions.ts](../../apps/server/src/collaboration/decisions.ts)：answer 分支 | 用户回答继承提问消息范围，不签发新的披露权限 |
| [recovery.ts](../../apps/server/src/runs/recovery.ts)：recoverDurableHolds | resume 使用唤醒消息或冻结恢复来源，不因定时等待清除来源 |
| [sessions.ts](../../apps/server/src/execution/sessions.ts)：prepareNativeSession | 现有信息边界主要包含 Run、visibility、audience，尚无拟新增 Scope/manifest 标识 |
| [businessScheduling.ts](../../apps/server/src/orchestration/businessScheduling.ts) | R7 处理预先声明的分工、依赖和汇合授权，不提供动态父级状态恢复 |

## 5. 实施建议

以 P1 协作能力缺口处理，先交付 G0–G2 的隔离材料与状态调度，再补正文汇总/发布和各后端实测。保留默认权限保护，使用单独的控制范围与内容范围。

幂等、停止、预算和权限提交复核必须随功能交付；后续故障阶段强化验证。完整自由文本暗牌游戏需要额外明确的披露政策，不能把独立投递通过当作全流程完成。详细交付要求以实施指导为准。
