# Runtime ProgressDigest 与兼容清理门禁

## 发布状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| ProgressDigest v1 | 已编码、已测试、默认启用 | 新权威 Collaboration Run（仅 `execute`）冻结 `progressDigestVersion=1` |
| 历史 ProgressDigest 读取 | 已编码、已测试 | 缺少版本或快照的事件继续按 `evidence_fingerprint` 解释 |
| 兼容库存门禁 | 已编码、已测试、默认启用 | 清理前已扫描实际数据库；保留为发布验收项 |
| legacy/Shadow/atomic 入口 | 已弃用 | 新入场拒绝；终态历史仍可只读解释 |
| legacy finalization、atomic_compat 执行分支 | 已删除 | 用户授权停止最后一条活跃历史 Run 后，库存门禁归零 |

## ProgressDigest v1

Evidence fingerprint 回答“哪些证据记录被引用”，其中包含 Execution/RunEvent 身份。ProgressDigest 回答“Subject 是否出现了新的实质状态”。两者同时保存，不能互相替代：

```text
EvidenceRef 身份 + 原始解析结果
  └─ evidenceFingerprint（完整审计）

Subject + runtimeRevision + 工具类别 + 稳定资源 + 规范化内容
  └─ ProgressDigest（防循环进展判断）
```

ProgressDigest 的规范化规则：

- ToolExecution 按 `read/write/other` 类别、工具名和稳定资源归组；非只读工具还纳入规范化输入，使同一资源的不同写入内容即使回执相同也算进展；
- 稳定资源优先取 `path/file/url/uri/resource/target/query/command`，否则使用去噪输入摘要；
- JSON 的时间字段和文本中的 ISO/RFC 时间戳不进入内容摘要；
- 相同稳定资源、相同内容的重复只读结果只保留一项；
- 普通 RunEvent/trace/log 不计入进展，只有显式 `runtime.progress=true` 或 `evidence.substantive=true` 的事件可计入；
- Message 和 Attempt 自述不单独证明进展；工作区文件按作用域、路径和已验证内容哈希计入。

`runtime_route_guard_events` 保留原 `evidence_fingerprint`，并新增 `progress_digest` 与完整 `progress_snapshot`。新版本事件按 progress digest 计算连续次数；旧事件继续兼容读取。API、WebSocket、Trace 和右侧面板展示摘要项数及被排除的重复只读/普通日志数量。

## 兼容清理库存门禁

`inspectRuntimeCompatibilityInventory()` 只读扫描非终态 Collaboration Run 和未完成 checkpoint，分别检查：

- 缺失、损坏或歧义 Contract；
- legacy authority、Shadow state 与 `atomic_compat`；
- 冻结 `toolApiVersion=1`；
- 仍引用 `agent.send_message/ask_many/wait_for_user` 的 active/waiting checkpoint。
- 当前 admission 仍配置为 legacy/Shadow/atomic compatibility。

只有 `readyForCompatibilityRemoval=true` 时才删除旧 alias 的模型暴露、legacy finalization 和 atomic compatibility 执行分支。本地最后一条历史 Run `5d6e20d8-72f8-44a2-854a-891abb6b1943` 已按用户授权使用 Stop 终止并保留历史，清理前复扫结果为 `activeCollaborationRuns=0`、`readyForCompatibilityRemoval=true`。终态历史 Run 不阻止删除，其 Contract、动作、事件和 checkpoint 继续只读可解释；旧动作 parser 留作历史解释，不再生成模型工具 schema。

库存命令在门禁未归零时以退出码 2 结束，避免 CI/发布脚本把“输出了一份报告”误认为“允许删除”：

```bash
pnpm runtime:compatibility-inventory
```

不得为了让门禁通过而自动取消、改写或升级活跃历史 Run。本次唯一的 Stop 由用户明确授权。若其他部署仍有非终态历史 Run，必须在升级前处理；当前 worker 不会接球退役 Profile。

## 验收

```bash
pnpm verify:runtime-progress-digest
pnpm verify:runtime-loop-guard
pnpm verify:runtime-compatibility-retirement
pnpm verify:runtime-run-policy
pnpm typecheck
pnpm verify:docs
```

专项 fixture 断言：新只读 Execution ID、时间戳变化和普通日志都不会重置计数；稳定资源的内容变化会重置；原 evidence fingerprint 仍变化并可审计；终态历史记录不阻止清理，活跃未知/legacy/checkpoint 库存会阻止清理。
