# 编排 API 迁移说明

适用：O1–O7 当前实现。默认本地 API 为 `http://127.0.0.1:3010`；隔离演示为 `http://127.0.0.1:3011`。

## 新调用路径

1. `GET /api/orchestration/options` 获取开放策略、工作流和准入开关。
2. `POST /api/conversations/empty` 建立空房；团队是候选集合，不立即执行。
3. `POST /api/orchestration/preview` 对本轮请求做规则预览。
4. 在用户确认后，`POST /api/conversations/:id/requests` 提交同一请求及预览 ID/指纹。
5. 使用 `GET /api/runs/:id`、`/orchestration`、`/coordination` 或 `/collaboration` 读取持久结果；成员队列使用 `/queue`。

也可向 `POST /api/conversations` 发送 `entryVersion:1` 的请求，一次性建房并提交。`entryVersion` 是提交入口字段，不传入预览正文。

```json
{
  "title": "接口分析",
  "agentIds": ["analyst-a", "claude-worker"],
  "workspace": null,
  "preferences": {
    "strategy": "auto",
    "workflow": "routine",
    "constraints": { "readonly": true }
  }
}
```

上例为建空房正文。随后预览正文如下，ID 替换为服务器返回值：

```json
{
  "conversationId": "ROOM_ID",
  "goal": "只读分析接口设计并列出风险",
  "recipientIds": ["claude-worker"],
  "strategy": "auto",
  "workflow": "routine",
  "constraints": { "readonly": true }
}
```

规则预览不派发、不测试认证、不调用模型；`planning:"detailed"` 是显式付费规划，主管拆解需要合法 API 主管。预览存在 `severity:"error"` 时不能确认。确认正文应保持原字段，并增加：

```json
{
  "entryVersion": 1,
  "conversationId": "ROOM_ID",
  "goal": "只读分析接口设计并列出风险",
  "recipientIds": ["claude-worker"],
  "strategy": "auto",
  "workflow": "routine",
  "constraints": { "readonly": true },
  "clientRequestId": "CLIENT_GENERATED_UUID",
  "previewId": "PREVIEW_ID",
  "orchestrationFingerprint": "PREVIEW_FINGERPRINT"
}
```

新任务返回 HTTP 202；同键同内容返回原任务和 HTTP 200。客户端在网络错误后应保存原正文与幂等 ID，通过同一房间入口查回；不能换 ID 盲目重发。同键不同内容返回 409。成员、账户连接、目标、策略、工作流或工作区改变后，重新预览，不沿用旧确认。

`agentIds` 只描述团队；房间请求通常省略它，使用已保存团队。`recipientIds`、`@成员`、回复和 `wholeTeam` 决定本轮对象；有冲突就修正，不能借兼容入口绕过。省略策略/工作流/约束时继承房间默认。`constraints.maxTokens` 是受支持的模型 API 输出预算，SDK/app-server 不支持硬限制；外部成员可使用 `readonly` 和 `deadlineMs`。

## 任务动作和默认偏好

| 接口 | 请求与边界 |
|---|---|
| `POST /api/runs/:id/actions` | `{"action":"pause"}` / `resume` / `cancel`；仅影响指定 Run。未知副作用禁止直接恢复 |
| `POST /api/approvals/:id/decide` | 原审批卡的 approve/reject/edit；不转移审批到最新任务 |
| `POST /api/orchestration/preview` | 暂停任务修订时增加 `revisionRunId`，仅此预览字段可享已有任务准入；不用于创建新任务 |
| `POST /api/runs/:id/orchestration/revisions` | `previewId`、`orchestrationFingerprint`、`instruction`；确认修订后仍需明确恢复 |
| `PATCH /api/conversations/:id/preferences` | `preferences` 和 `expectedMembersVersion`；只影响未来任务，CAS 冲突需刷新 |
| `GET /api/conversations/:id/task-state` | 同一房间各 Run 的暂停、等待、队列、未知状态与冻结任务设置 |

工作流固定结构不能被策略覆盖；开发评审已经开始写入后，不允许原地重建图。未开放的分支重试或接受部分结果完成不能由客户端自行模拟。

## 旧接口迁移与状态码

| 旧入口/格式 | 替代方式 | 兼容行为 |
|---|---|---|
| `/api/conversations` + `mode` | 空房 + requests，或同接口 `entryVersion:1` | 旧格式保留原响应和冻结执行语义 |
| `/api/conversations/:id/messages` + `body` | `/api/conversations/:id/requests` + `goal` | 旧消息追问路由仍由兼容适配处理 |
| `/api/runs` + `mode` | 同接口新版契约，推荐房间 requests | 保留旧 Run API；不要把 room mode 当本轮策略 |
| `/api/coordination/preview` | `/api/orchestration/preview` | 旧协议名不自动等同于新工作流 |
| `/api/conversations/:id/followup-preview` | `/api/orchestration/preview` + 房间/回复/目标 | 新请求明确选择目标和策略 |

旧格式回复带 `Deprecation:true` 和指向新版预览的 `Link`。目前没有公布移除日期。`GET /api/orchestration/entry-statistics` 按 endpoint、输入格式、HTTP 状态和接受/拒绝结果累计统计，不含目标或调用者身份；观察期前没有统计不能视为零调用。

400 表示字段、角色范围或组合无效；404 表示房间/任务不存在；409 表示幂等冲突、预览过期、成员 CAS 或恢复/修订冲突；503 的 `ORCHESTRATION_ENTRY_DISABLED`、`WORKFLOW_NOT_ENABLED`、`DRIVER_NOT_ENABLED`、`LEGACY_ENTRY_DISABLED` 表示入场开关。预览中的问题先展示再修正。入场开关关闭后，幂等查回和已有任务审批/动作仍可用。

旧房间 mode 映射、增量升级和兼容回退见 [O6 架构](./orchestration-entry-phase-o6.md)。接口清理必须经过[清理清单](../plans/orchestration-compatibility-cleanup-checklist.md)的门禁。
