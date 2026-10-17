# 独立协作灰度、排空与恢复手册

日期：2026-10-17。适用 schema 17 与当前兼容 worker。支持组合见[支持矩阵](../architecture/scoped-collaboration-support-v1.md)，验收见 [G6 报告](../reports/scoped-collaboration-g6-acceptance-2026-10-17.md)。

## 上线前

核对部署源码、schema 与配置。执行以下只读检查不会初始化数据库、解密材料或发送模型请求：

```sh
pnpm scoped:inventory
pnpm orchestration:audit
pnpm accounts:audit
```

`DB_PATH` 可指定待检查库。清单包含准入状态、Scope Run 状态数量、活动 Attempt/原生进程、待派发项、待恢复 Hold、有效待发布授权、未知 Token 占额、外键与完整性结果，不包含私密正文。

在隔离环境执行 `pnpm scoped:acceptance`，包括桌面和 390px UI。浏览器环境可通过 `PLAYWRIGHT_MODULE`、`CHROMIUM_EXECUTABLE_PATH` 指定已安装运行时。`--core-only` 明确跳过浏览器矩阵，不能据此声称完成 UI 验收。证据写入被 Git 忽略的 `apps/server/data/scoped-acceptance/`。迁移演练需要包含 G4 提交 `66165b2` 的 Git 历史，以运行旧版本真实 schema 门禁。

## 灰度

1. 设置 `SCOPED_COLLABORATION_MODE=preview` 并正常重启服务。先核对支持范围、来源与预算，预览不会调用模型，也不能确认新 Run。
2. 使用已验证的模型 API 成员和明确的小预算，设为 execute 后在选定聊天室做一次 canary：独立 A/B → 固定状态返回 → 选定 A 的私密汇总 → 确切文字或固定状态 → Owner 批准与单次发布。
3. 检查子项完成、唯一父恢复、发布消息、冷边界、调用与预算记录。未知用量必须仍占额；重复点击、重连不能新增副作用。SDK 还须满足 `SCOPED_NATIVE_DRIVERS=claude-sdk`、全局驱动及托管账户兼容性；Codex 默认关闭且真实验证暂缓。
4. 再扩大使用范围。当前采样仅建立小夹具下无模型接口的本机基线；大房间、真实网络及供应商性能须单独采样。

全局入口若为 closed/preview 或禁用模型 API，新能力采用更严格状态；专项开关不会提升全局权限。开关是新准入策略，不是修改已冻结 Run 的指令。

SDK 文件 canary 使用新版静态阶段图：本次上传 input → SDK 受控读取/写入 → API 成员读取获准前置文件 → Owner 引用实际版本并验收。显式严格 Token 上限不能用于原生客户端；准入占额仅用于记账，未知用量继续阻断后续调用。完整验证命令见[接入收尾报告](../reports/scoped-collaboration-native-integration-2026-10-17.md)。

## 关闭和排空

设置 `SCOPED_COLLABORATION_MODE=closed` 并正常重启。保留能读取 schema 17、Tool API v3 和 Coordination Scope 的兼容 worker；不要改库或改旧 audience。

在界面查看既有任务：等待用户的任务由 Owner 继续处理、专用批准/发布，或使用停止操作结束。停止不撤回已发布内容，不自动消除已经产生的费用或未知外部效果。

清单中 `noExecutingAttempts=true` 表示没有正在执行的 Attempt/原生进程；`compatibleWorkerRequired=false` 才表示没有仍需派发、恢复或消费的有效任务。过期、已撤销和终态任务上的授权不计入有效待发布数量，历史记录保留。若 `unknownUsageNeedsReview=true`，继续人工核对调用账单与原生状态，不能把未知改成零或自动重放。

以上仅为独立协作清单；全服务停机前还需检查 `orchestration:audit` 中的其他引擎活动工作。安全边界内停止服务后才能备份。

## 备份、恢复与版本回退

按[账户备份规范](../architecture/accounts-migration-phase-e4.md)同时保存匹配数据库、主密钥、私有认证目录和角色；保留产物、工作区、环境配置及匹配源码。不要只复制 SQLite 文件。

```sh
pnpm accounts:backup --output /安全位置/新的备份目录
pnpm accounts:verify-backup --input /安全位置/新的备份目录
```

先在隔离目录验证清单、权限与摘要，再按清单恢复匹配文件并使用兼容 worker 启动。schema 16 备份由当前代码升级到 17；历史绑定和输入账本不改写。G6 演练同时验证了密文预览的幂等重试与损坏备份拒绝。

G4 旧 worker 不识别 schema 17，必须在读写/调度前拒绝。回退产品开关应保留当前兼容 worker，不能删迁移行或降低契约版本。如果备份之后已有真实发布或写入，先核对增量与外部事实；恢复旧快照不能撤回信息或证明副作用未发生。真实灾难恢复须作为独立运维操作记录。

## 本机性能基线

`verify:scoped-g6` 对 capabilities 和 sources 接口各预热 5 次、采样 30 次，报告 P95，不产生模型请求。G0 未测 HTTP P95，因此不能宣称相较 G0 的延迟改进。此样本仅用于本机小数据集回归；未来同环境出现超过 3 倍且超过 20ms 的 P95 时先调查再放量，不以删除 ACL/来源校验降低延迟。
