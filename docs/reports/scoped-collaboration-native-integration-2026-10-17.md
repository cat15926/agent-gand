# SDK 受控文件与原生 Coordination 接入收尾

日期：2026-10-17。范围：完成普通准入、SDK 平台文件工具与静态阶段图的新公共 Scope 接入。真实 Codex 验证按用户要求暂缓，历史失败及未知用量原样保留。

## 已交付实现

- 独立材料与私密汇总的正常预览、确认和调度接受显式绑定兼容托管 API Key 的 SDK 成员，页面按服务能力选择成员，异步初始化兼容仅含 SDK 的房间。
- 三种文件工具只访问获准不可变受控文件或本 Attempt 的写入。工具调用取平台、角色、步骤与 Manifest 的交集，读入及工具结果登记来源；私密来源漂移、路径越权和伪造 authority 均阻断。
- 写入生成沿用 Scope ACL 的新文件版本，不直接读写原生工作目录或代码仓库。原生 shell、网络、磁盘工具及持久会话继续关闭。
- 新静态阶段图使用 `coordinationScopes=2`，可选择上传文件和已完成前置步骤产物；依赖、并发、阶段预算和 Owner 门禁沿用 R7/R5。阶段证据列表可引用成员实际生成的文件版本，不能用旧同名文件替代。
- 静态结果进入既有 G3 来源目录，汇总、草稿、专用批准和单次发布继续使用相同边界。已有 Run 与检查点续跑不升级。
- SDK 文件链最多八个模型回合、六次普通工具调用，控制工具后封闭；文本控制链仍一个模型回合。最终用量缺失时保留 unknown，拒绝完成和后续请求。显式严格 Token 上限仍拒绝原生成员；准入记账不等于供应商硬限制。
- `SCOPED_NATIVE_DRIVERS` 默认 `claude-sdk`，空值可关闭；Codex 实现和本机夹具已接入但默认关闭。能力发现分别说明实现、配置和连接证据，不自动宣称所有账户连接已验证。

## 本机验收

新增 `pnpm verify:scoped-native-files` 已通过：12 次回环 Messages 请求、2 个 Codex stdio 夹具进程，真实供应商与真实 Codex 模型调用均为 0。验证安装的 SDK 连续读取/写入/控制、越权后不再推理、同 Scope 自写文件读取、私密 ACL 漂移、正常 Coordination SDK/API 文件 DAG、Owner 文件验收、G3 来源、新准入 SDK 组织者及批准发布、未知预算阻断。正常准入测试没有替换冻结角色或账户绑定。

`pnpm verify:scoped-native-real-selection` 与类型检查通过；桌面与 390px 页面验证 SDK 可选、表单/旧预览失效、停止与刷新、普通入口恢复，以及能力异步加载后的 SDK 房间初始化。完整矩阵结果见下文。

## 真实选定账户验收

使用既有鸡腿 `coder-jitui` 与 `glm53-api`，合成材料、独立数据库和认证目录，不复制业务消息或任务，不读取 Codex 登录凭据。固定上限：20 次平台调用、48,000 输出 Token 记账、30 分钟总时限、单次回复 600 秒。SDK 内部模型请求数另记为未知。

```sh
# 默认只输出范围，不执行
pnpm scoped:native-real --claude-agent coder-jitui --api-agent glm53-api --skip-codex --integration-only
# 执行新的隔离接入验收；不能用此模式续跑旧验收
pnpm scoped:native-real --claude-agent coder-jitui --api-agent glm53-api --skip-codex --integration-only --execute
```

实际运行 `2026-10-17T06:35:35Z` 至 `06:37:15Z`，两项均通过：正常 SDK 组织者 → API 私密成员 → 固定状态回流 → SDK 私密汇总 → Owner 专用批准 → 单次确切文字发布；正常静态阶段预览/确认 → SDK 读取 input.txt / 写入 result.txt → API 读取结果文件 → Owner 引用实际文件版本并验收。没有替换冻结角色、插入伪造成功或使用 mock 推理。

共 **9 次平台调用，全部 completed**：SDK 6 次、API 3 次；已知输入 21,415、输出 **1,974 / 48,000** tokens，新 unknown 为 0。文件工具实际执行三次（读取两次、写入一次）。供应商内部推理请求数未知，平台调用数不等同于内部回合数。

证据位于 `apps/server/data/scoped-native-real/2026-10-17T06-35-35.062Z/` 的 `result.json`、`postcheck.json` 与隔离数据库，权限受限且不入 Git。复核：没有 Codex 执行或原生登录身份副本、活动任务/原生进程、残留冷目录、持久会话及外键错误；只有一条与批准文字完全一致的公开发布，原报告仍私密。原有 87 条业务 Run 与先前一致性备份逐行一致；业务库另有 1 条独立新增任务，未把它归因于隔离测试。旧三条 unknown、36,000 未知占额原样保留。

旧文本验收保留在 [API + SDK 报告](scoped-collaboration-api-sdk-acceptance-2026-10-17.md)。

## 本地服务与回归

完成无活动调用检查及一致性备份后，已重启本地后端。`http://localhost:5173/` 与 `http://127.0.0.1:3010/api/health` 正常；重启前后的全部 88 条 Run 行摘要一致，schema 17、外键错误 0。通过正式本机管理会话复核能力接口：execute，模型 API / SDK 可用，Codex 默认不可用，CLI 不支持；校验后注销临时会话。备份为 `/private/tmp/agent-gand-before-native-integration-restart-20261017.sqlite`，权限 0600。

首轮完整矩阵发现两项问题并保留失败日志：新增文件证据列表影响旧契约，以及 UI 测试仍断言 SDK 不可选。已将自动文件证据限定为新版 Scope、更新 UI 支持断言，并加强新版文件证据的完成步骤绑定；旧阶段调度、发布页面和新增负向测试复验通过。最终 `pnpm scoped:acceptance` **18/18 项全部通过**，包含类型、G0–G6、本机 SDK/Codex 协议与冷恢复、新增文件工具、旧阶段/检查点兼容及桌面/390px 两套 UI。最终证据为 `apps/server/data/scoped-acceptance/2026-10-17T06-39-15-264Z/`；首轮失败证据 `2026-10-17T06-35-41-335Z/` 保留。完整本机矩阵真实供应商模型请求为 0，真实账户证据单独列于上节。

## 保留限制

真实 Codex 的 ACK、发布请求和混合闭环暂缓；API Key、原生登录及其他供应商不能由当前单一账户组合推广。Claude 原生登录、只读 CLI、动态委托、文件自动公开以及任意代码仓库读写不属于本次开放范围。旧三条 unknown、36,000 未知输出占额不清除。
