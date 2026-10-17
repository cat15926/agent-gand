# 跳过 Codex 后的模型 API + Claude SDK 真实验收

日期：2026-10-17。按用户要求暂缓 Codex 角色验证，完成了不含 Codex 的真实协作与受控发布闭环。结果为 `passed_selected_scope`，只代表本报告所选组合通过，完整 G5 与原生生产准入仍未完成。

## 验收范围

使用既有 `coder-jitui`（鸡腿，v7）和 `glm53-api`（v1），分别为 Claude SDK / `glm-5.3` 与模型 API / `anthropic:glm-5.3`。两者使用同一个已启用的托管 API Key 账户，配置版本 2。

```sh
# 默认只展示范围和限额，不请求模型
pnpm scoped:native-real --claude-agent coder-jitui --api-agent glm53-api --skip-codex

# 执行隔离真实验收
pnpm scoped:native-real --claude-agent coder-jitui --api-agent glm53-api --skip-codex --execute
```

`--skip-codex` 不接受同时指定 Codex 角色或账户；准备阶段不复制 Codex 账户、登录身份或凭据，不创建其测试角色，也不启动客户端。含 Codex 的旧验收不能改用跳过参数续跑，以免将旧失败改写成跳过。历史记录保持原样，nim 的业务配置没有修改或禁用。

测试使用独立 SQLite、角色目录、账户密钥文件、空白原生 home/workspace 和合成算术材料，未复制业务消息或任务。为验证尚未开放的原生组合，脚本在隔离 Run 中替换冻结测试角色，再调用实际调度、Scope、预算和发布服务；没有新增产品准入开关。真实混合链路禁止调用 mock 模型。

## 真实结果

执行时间：`2026-10-17T03:14:36Z` 至 `03:17:47Z`。沿用共用上限：20 次平台启动、48,000 输出 Token 记账、30 分钟总时限、单次回复 600 秒。

| 场景 | 结果 |
|---|---|
| 鸡腿 SDK：同角色、同 audience 的两个私密事项及公开事项 | 三次独立冷启动通过；不复用会话和目录，不夹带其他事项标记 |
| SDK complete / consult_batch / acknowledge / request_release | 四类控制动作通过，均取得最终用量 |
| 模型 API 组织者 → SDK 私密执行 → 固定状态回流 | 完成；组织者的两次模型输入均不包含原始私密材料标记 |
| SDK 私密汇总 → 专用 Owner 授权 → 确切文字发布 | 完成；发布正文与批准正文一致，原结果仍为私密 |
| 重复发布同一 grant | 返回相同结果，仅一条发布记录 |
| 发布后恢复与结束 | 新冷启动完成；源投递 Run 和汇总 Run 均 completed |
| Codex | 按用户要求 skipped；本轮执行记录 0 |

共 **12 次平台调用，全部 completed**：模型 API 2 次、Claude SDK 10 次；其中 SDK 冷边界与四动作占 6 次，协作和发布闭环占 6 次。

已知输入 21,934、输出 **7,131 / 48,000** tokens，新增 unknown 为 0。供应商客户端内部请求数不能从平台调用数推算；记账上限不是供应商账单的硬上限。

## 隔离与数据核对

证据位于 `apps/server/data/scoped-native-real/2026-10-17T03-14-36.456Z/`，`result.json`、`postcheck.json` 与隔离数据库保存在受限本机目录，不入 Git。

完成后只读复核通过：

- 测试库只有所选 API Key 账户，原生登录身份 0、Codex 执行 0。
- 发布记录仅一条，正文与批准一致，公开消息范围正确，原始结果的私密范围保持不变。
- 活跃测试 Run、活跃原生执行、残留冷 home、未知调用及外键错误均为 0。
- 业务库 87 条 Run 的完整行摘要与本轮开始时一致。
- 旧两轮 Codex 的 3 条 unknown、合计 36,000 未知输出占额原样保留，没有冲销或转为通过。

`verify:scoped-native-real-selection` 已增加跳过路径回归：无 Codex 账户/身份副本、默认不执行、冲突参数拒绝、含 Codex 的旧轮不能切换范围续跑。该脚本与 `verify:platform-real-acceptance` 均通过，真实供应商请求为 0；脚本语法、文档链接及 diff 检查通过。

## 后续边界

Codex 实测暂缓，不再等待代理信息。Claude SDK 的本轮真实文本协作/发布证据不能推广为原生业务工具或原生 Coordination 已实现；这两项仍需实施。SDK/Codex 独立材料能力包保持原有准入状态，完整 G5 不标记完成。参见[支持契约](../architecture/scoped-collaboration-support-v1.md)及[实施指导](../plans/scoped-collaboration-implementation-guide.md)。
