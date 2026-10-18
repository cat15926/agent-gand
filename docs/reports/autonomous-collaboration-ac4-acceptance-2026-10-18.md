# AC4 默认单入口验收

日期：2026-10-18。对应[实施计划](../plans/agent-autonomous-collaboration-implementation-plan.md) AC4、[生效契约](../architecture/autonomous-default-entry-v1.md)。

## 提交与范围

AC3 已提交推送到 `origin/main`：`4b583be`（`feat(collaboration): automate scoped aggregation and result delivery`）。按用户“提交推送变更，然后开始实施 AC5”的要求，本报告及 AC4 实现独立提交推送，再开始 AC5。

本阶段将已开放的模型 API 组合接入普通发送，增加同任务补充、真实进度卡、持久暂停恢复与高级手动入口。新请求 entryVersion2 冻结 entryVersion1 能力字段及 schema21；旧根不升级。默认开关仍 closed，日常服务未重启，不能据此声称真实模型、原生客户端或完整狼人杀已通过验收。

## 隔离验收

`pnpm verify:autonomous-ac4` 专项通过，模拟 Provider 经实际 HTTP、调度、Scope、工具、预算及终局入口调用 **18 次**，含新 Node 进程恢复 1 次；供应商请求和真实原生调用均为 0。

| 场景 | 验证结果 |
|---|---|
| 普通发送 | 无预填计划或确认页，附件进入真实上下文；成员独立审阅→内容汇总→一次最终交付，共一个 Run |
| 提交重试 | 相同内容同键返回原任务，改变内容冲突；关闭灰度后仍能查回既有提交 |
| 用户补充 | I/O 期间的补充追加来源/版本；旧候选不提交，下一次实际调用读入新要求；不新增任务或预算 |
| 真实暂停恢复 | 文件已写入后暂停，等待当前请求收敛；恢复只读取原回执并完成，不重复写文件 |
| 冷进程恢复 | 新 Node worker 恢复暂停快照，重复启动只产生一次续跑/交付，保留原写入和账本 |
| 约束生效 | readonly 从实际工具/Grant 中移除 fs.write，不是仅显示标签 |
| final 版本 | 新补充到达后不发布旧 final 候选，交付新接受的结果 |
| 私密引用 | 同房间明确引用版本才读入；拒绝扩大私密范围；模型 I/O 后来源改变阻止提交 |
| 不支持组合 | SDK/Codex 或房间外对象、超预算、严格计费、伪造权限、无效引用、过大/二进制材料和关闭入口均在模型 I/O 前拒绝，事务无残留 |
| 用户停止 | 迟到结果不可完成或发布，停止后不能追加指令，历史消耗保留 |
| 迁移 | 非空实际 AC3 契约夹具重复升级20→21，全部旧表行不变、外键无错；实际 v20 worker 拒绝新库，旧 AC3 根不能升级 |

证据：Git 忽略的 `apps/server/data/autonomous-ac4-qa/result.json`。

`pnpm verify:autonomous-ac4-ui` 通过，**8 次模拟 Provider 调用**，页面异常 0。实际浏览器验证：普通输入上传并发送、不出现通用计划确认、真实分工卡、同任务补充、暂停后刷新、继续后唯一交付；提交响应丢失后重试原请求，不误建任务或误记补充；高级材料表单保留；旧任务未升级；1440px/390px 无横向溢出。供应商请求和真实原生调用均为 0。证据及截图：`apps/server/data/autonomous-ac4-ui-qa/`。

## 回归与业务数据

完整 `pnpm scoped:acceptance` **24/24 通过**：类型检查、AC1–AC4、既有 G0–G6、消息与私密交互、动作命令、阶段调度、恢复、SDK/Codex 协议及受控文件夹具、四组浏览器验收和文档链接。证据：`apps/server/data/scoped-acceptance/2026-10-17T16-46-03-865Z/`。原生用例为本机协议夹具，不代表真实客户端自主协作已验收。边界及内部记录折叠收尾后另行复核 AC1、AC4 专项、AC4 页面和类型检查。`pnpm verify:cost-budget`、`pnpm verify:runtime-run-policy` 与 `git diff --check` 也通过。

业务库只读核对：原有 **88 条 Run 全部字段与一致性备份相同**，仍为 schema17，无自主任务表，外键错误 0。证据：`apps/server/data/autonomous-ac4-qa/business-data-check.json`。所有执行验收使用临时隔离库、模拟模型和临时凭据目录，未主动重启日常后端或迁移业务库。

## 后续

AC5 完成可校验多轮秘密协作与非游戏流程；AC6 完成真实模型/托管 SDK 组合、完整故障矩阵、灰度和回退。默认配置不因本阶段测试自动开放，Codex 真实验证继续按用户要求暂缓。
