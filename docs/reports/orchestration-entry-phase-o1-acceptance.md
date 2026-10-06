# 编排入口 O1 验收报告

日期：2026-10-05。范围：共同请求契约、配置预览、幂等提交、比较快照和旧入口兼容。对应[实施计划](../plans/orchestration-entry-convergence-implementation-plan.md)与[生效架构](../architecture/orchestration-entry-phase-o1.md)。

## 结果与交付

已新增 shared 请求/能力/决策/快照协议；服务器规范化、能力元数据读取、规则比较、共同 legacy 提交和持久记录；只读预览及 Run 快照查询 API；专项验证脚本。旧建房、直接 Run、消息、Coordination 预览、追问预览接入共同边界。

所有新建议标记 comparisonOnly，执行继续使用原有 Runtime 与编排。外部成员未被从能力快照中排除；尚未接入的外部步骤显示 O2 门禁。O1 未启用新的策略执行或改动前端菜单。

## 专项验证证据

`pnpm verify:orchestration-o1` 通过 12 组验证，报告 `providerRequests: 0`：

| 检查 | 结果 |
|---|---|
| 六类来源规范化同义请求、目标顺序 | 通过 |
| 新预览不落库、不派发、不调用模型 | 通过 |
| 账户元数据读取不解密 Key；无 Key/私有路径/系统提示泄漏 | 通过；临时移走模拟主密钥后预览仍能完成 |
| API/SDK/app-server/CLI 能力差异、O2 门禁、硬 token 限制 | 通过 |
| @ 冲突、未知提及、重复成员、错误约束、未知字段 | 通过 |
| 创建/消息/Run 同键去重，不同内容 409 | 通过 |
| 原提交在团队变化后仍可重试；新提交的旧指纹拒绝 | 通过 |
| 凭证、角色版本、工作区信任变化使预览失效 | 通过 |
| 另一进程重试、两个进程并发同键提交 | 通过；只产生一个 Run 与一条用户消息 |
| 激活不匹配计划失败后的事务与广播回滚 | 通过 |
| 重复 schema 升级、旧 Run 不回填、旧消息兼容去重 | 通过 |
| 旧 HTTP 响应与首轮流水线语义 | 通过；双成员首轮保留两个 Agent span，用户消息仅一条 |

## 回归检查

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 shared/server/web 类型检查 |
| `pnpm verify:coordination-planner` | 通过模型提案、修复、回退、显式优先与澄清回归 |
| `pnpm verify:followup-stage3` | 通过定向、回退、全队计划回归 |
| `pnpm verify:coordination` | 通过计划执行、评审返工、辩论、暂停/恢复与隔离 |
| `pnpm verify:accounts-e3` | 通过账户/角色冻结、不兼容与权限阻断 |
| `pnpm verify:runtime-run-policy` | 通过冻结策略、历史解释与退役执行阻断 |
| `pnpm verify:docs` | 通过本地文档链接检查 |
| `git diff --check` | 通过格式检查 |

真实供应商调用不属于本阶段验收。旧规划器回归使用本地模拟服务；O1 专项不发起 provider 请求。

## 后续边界

O2 才解决 Coordination attempt 与外部权限绑定；O3 才收敛调度和完成入口；O4 才将这些规则/工作流变为执行权威；O5 才改变产品交互。纯预览的配置齐备与历史 PASS 不能替代真实客户端安装、有效登录和模型权限测试。

本阶段未进行 Git 提交或推送，保留工作区原有未提交变更。
