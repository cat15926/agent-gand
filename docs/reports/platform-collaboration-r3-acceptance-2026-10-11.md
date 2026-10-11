# 平台协作剩余计划 R3 验收记录（2026-10-11）

R3 已完成本地实现与适用范围验收，对应[实施计划](../plans/platform-collaboration-remaining-implementation-plan.md)和[生效契约](../architecture/artifact-worktree-snapshots-v1.md)。本批包含 R1/R2/R3 实现及报告，提交与推送状态以 Git 历史为准。R4–R8 继续待实施。

## 已交付

- 归档冻结阶段的全部声明文件和完整文本，保留来源 Run、阶段/交付项、实际接受决定版本、ACL、文件版本、SHA256、大小与类型。完整文本不使用证据面板的 2000 字摘要替代；缺少任一声明交付不能确认完整归档。
- 公开 Git 根工作区保存精确 HEAD commit、tree 及对象闭包。移除旧工作树和原 Git 对象目录后仍可恢复同一提交；不保存父提交历史、远程配置、hooks 或原生登录目录。仅明确声明的新增/修改/删除及二进制改动覆盖基线，其余改动和排除项在预览中说明。
- Owner 可以预览、保存、下载完整文本/文件并确认恢复到平台生成的新隔离目录。恢复不调用模型、不重放工具、不改写用户当前工作树。预览到确认期间的内容或权限变化、归档篡改、路径逃逸、链接、硬链接、特殊文件及恢复目录漂移均阻断。
- R2 受控文件不可变版本连同认证元数据进入加密载荷，清单参与 AEAD 认证。私密字节保持加密；公开和私密受控文件均不直接落入原生恢复目录，只通过 Owner 下载或已有 ACL 工具读取。现有快照也会阻止丢失主密钥后自动创建替代密钥。
- 阶段接受决定与归档同事务提交，失败回滚且不唤醒下一阶段。已验收、被后继引用或已恢复的快照保持保留；未引用且未恢复的手动归档可由 Owner 携带摘要清理，没有自动过期删除。
- 追加迁移 v7 和阶段检查点 v2，保留 v1 历史读取。公开只读阶段续跑/返工迁移已验收的精确声明版本及用户输入附件，并记录 `restoredFrom`；新版本仅有相同阶段标签不足以进入检查点，未验收和被拒绝产物不会成为后续完成证明。
- 任务卡“查看计划、结果与验收”中的“产物与工作树快照”提供阶段/路径选择、变化与遗漏预览、完整下载和新目录恢复。阶段续跑及返工预览复用同一清单，展示 Git 基线、文件版本、权限与验收来源。

## 验收证据

| 层级 / 入口 | 本地通过范围 |
|---|---|
| `pnpm verify:artifact-snapshots`，execute / off | 缺失声明拒绝、完整长文本、实际验收版本、自包含浅 Git 基线、新增/修改/删除/二进制及 64 KiB 文件、旧目录和对象库删除后的冷进程恢复、原 checkout 保持不变、敏感路径/平台数据库排除、内容/清单/ACL/模式漂移、链接/硬链接/父目录替换、引用保留及手动清理、主密钥缺失、公开受控阶段续跑及未验收新版本排除、Owner/CSRF/Origin/严格字段与幂等 |
| `pnpm verify:business-stage-gates`，execute / off | 模型 API 与 Claude SDK/Codex app-server 实际 stdio 模拟；顺序门禁、文件变化拒绝、接受后归档和重启恢复、拒绝阶段返工及新原生会话、取消不复活、输出预算和未知消耗、冷读取与降级保护 |
| `pnpm verify:business-stage-gates-ui`，Chrome | 实际 UI 声明与归档、完整文本及二进制下载、新隔离目录恢复及同 commit、阶段续跑/返工清单、Owner 确认、旧证据隔离、桌面和 390px 无横向溢出、阅读位置与导航回归 |
| `pnpm verify:platform-network`，真实本地 HTTP/WS | 接受与确认幂等、服务冷重启后读归档并恢复、重复恢复返回同目录、恢复前后模型调用数不增加、断连重连及晚到事件围栏；`R1_VERIFY_UI=1` 另覆盖真实 Chrome 中的私密受控文件与 Owner 下载，重启后仍保留原私密字节与 ACL |
| 兼容性专项 | `verify:business-acceptance`、`verify:business-stage-continuation`、`verify:business-stage-rework`、`verify:private-interaction` 的适用 execute/off 回归，`verify:run-continuation`、`verify:runtime-evidence-bundles`、`verify:orchestration-o6` |
| 工程检查 | Shared / Server / Web 类型检查、Web 构建、文档链接及 diff 格式检查；构建保留既有大 chunk 提示 |

夹具使用临时数据库、临时 Git 仓库和模拟模型；真实供应商请求计数为 0。真实 HTTP/WS 只连接本机回环，stdio 层也使用模拟 SDK/app-server，不将其表述为真实账户联合验收。

浏览器证据位于忽略目录 `apps/server/data/business-stage-ui-qa`：`desktop-artifact-snapshot.png`、`mobile-artifact-snapshot.png`、`mobile-artifact-restore.png`；网络联合证据位于 `apps/server/data/platform-r3-qa`。手机快照页面已人工查看，长路径/哈希换行且确认按钮可见。

一次并行回归中的 `verify:business-stage-gates` 在模拟原生成员步骤失败，随后独立复跑及 execute/off 检查通过；没有足够证据确定首次失败原因。脚本现附加失败步骤和原生执行错误诊断，保留这项测试稳定性观察，不据此修改生产时限或宣称真实供应商故障。

## 限制与后续范围

物理文件和文本单项最多 1 MiB，受控文件沿用 256 KiB，完整 JSON 载荷（含 Base64）最多 16 MiB，最多 4000 文件/目录扫描条目、128 个额外声明路径。阶段检查点的确认输出及元数据仍受 1 MiB 上限约束，超限明确拒绝。链接、子模块、特殊文件及被路径策略识别的凭据不支持归档；Git 基线跟踪敏感内容时整体拒绝，不能静默生成缺失基线。

归档的“完整”仅针对所选阶段及声明路径；未选择阶段、未声明工作树改动和新文件明确披露，不等同于整轮业务目标已达成。非 Git 根目录只保存普通文件快照。Git 包只保存目标提交的树闭包，无完整历史；备份仍需 SQLite 与原主密钥。

- R4：私密/写入 Agent 续跑、返工、当前授权重建及副作用核对。Owner 产物恢复不代替这些执行契约。
- R6：自由协作及其他编排引擎的受控文件承接、多分支和部分成员返工。当前公开 `stage_gated` 文件检查点已开放，其他组合保留明确拒绝。
- R5/R7：费用预算与调度效率；R3 未扩大这些功能范围。
- R8：经授权的真实 Claude/GLM/Codex 混合后端长链路验收；本阶段没有调用已有真实账户或消耗其额度。

下一阶段为 R4，先建立私密授权重建、写入账本及未知副作用核对，再开放对应自动承接入口。
