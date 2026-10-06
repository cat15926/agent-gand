# 角色创建体验阶段 E3 验收记录

日期：2026-10-05。结论：E3 实现及本地自动化、浏览器验收通过。真实供应商调用为 0；E4 完整迁移与实际供应商验收尚未启动。

## 交付范围

- 职责、接入与模型、权限与确认三步向导，创建、编辑、复制复用同一流程。
- 产品名称选择、协议兼容过滤、唯一可用账户预选、多账户明确选择、模型目录及手填 ID。
- 就地新增账户与原生登录、完整账户管理子面板；子面板返回保留角色草稿和已选头像。
- 编码模板默认写入需确认；服务端实际权限摘要；技术参数放入高级设置。
- 显式测试当前后端/模型，按测试范围展示状态，普通预检和保存不调用模型。
- 原子保存停用草稿、修复后启用、失效绑定保留、缺显式账户禁止回退旧认证。
- 角色连接状态、成功后加入建房草稿、文本草稿刷新恢复、键盘与窄屏操作。

当前使用与接口契约见 [E3 架构与使用](../architecture/accounts-and-agent-creation-phase-e3.md)。

## 自动验证

| 命令 | 结果与证据 |
| --- | --- |
| `pnpm typecheck` | 共享包、服务端和前端通过 |
| `pnpm --filter @agent-gand/web build` | 生产构建通过；已有大 chunk 提示保留，账户页保持 lazy chunk |
| `pnpm verify:accounts-e3` | 停用定义与状态原子保存；全局伪 Key 存在时缺显式账户仍拒绝回退；修复启用、版本冲突、Run 冻结；不兼容/撤销/缺客户端/待登录诊断；停用草稿不能绕过权限策略；模型转换和按后端/模型限制测试结果；实际只读权限摘要通过 |
| `pnpm verify:accounts-e3-ui` | 独立服务与临时数据库的完整三步浏览器验收通过，见下节 |
| `pnpm verify:accounts-e1` | 加密、版本、重启、旧来源、引用、脱敏、Host/Origin/CSRF、远程认证、私有文件保护通过 |
| `pnpm verify:accounts-e2` | 双账户并发、冻结版本/轮换/停用/撤销、四 Driver 认证转发、模型状态、原生登录代次/取消/会话隔离/重启、秘密与环境隔离通过 |
| `pnpm verify:agents` | 原有角色管理、版本及兼容行为通过 |
| `pnpm verify:coordination-planner` | 模型建议、修复、fallback、显式约束、风险确认、澄清及审计通过 |
| `pnpm verify:external-agents` | A：只读分析、分帧、失败诊断、会话、取消、超时、重放保护通过 |
| `pnpm verify:external-agents-b` | B：审批先于写入/测试、拒绝、去重、路径围栏、策略入场、清理、Git/测试证据和返工通过 |
| `pnpm verify:external-agents-c` | C：stdio MCP、混合交接/征询、控制纠偏、持久 Holds、审批/ledger、Stop、请求去重与责任围栏通过 |
| `pnpm verify:external-agents-d` | D：脏基线工作树、不可变评审/patch、SIGKILL 恢复、持久资源围栏、安全缓存重放、会话恢复和增量上下文通过 |
| `pnpm verify:docs` / `git diff --check` | 文档链接与空白检查通过 |

E2 测试的预检断言同步为 E3 的 HTTP 200、`ok:false` 契约；待登录账户改为停用草稿，活跃角色创建前先恢复可用账户。

2026-10-05 的 E3 补充调整了前端草稿校验、会话摘要、焦点和建房布局，重新通过类型检查、构建、完整 E3 UI、文档链接与空白检查。E1/E2、A–D 等后端回归记录来自本阶段主流程验收。

## 浏览器证据

`scripts/verify-accounts-e3-ui.mjs` 启动独立临时 Fastify 服务、SQLite、角色目录、Vite 和原生客户端 fixture，结束后回收服务及临时数据。供应商接口仅指向本机 HTTP mock。可用 Playwright/Chromium 已安装时运行 `pnpm verify:accounts-e3-ui`；本机实际运行命令为：

```bash
PLAYWRIGHT_MODULE=/Users/ruhonglin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs \
CHROMIUM_EXECUTABLE_PATH=/Users/ruhonglin/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell \
pnpm verify:accounts-e3-ui
```

实际通过：

1. 空账户列表直接新增 Messages Key 并自动回填；取消新增、管理子面板内取消/Escape、返回不关闭父向导，提示词和待上传头像保留。
2. 多账户要求明确选择；Chat-only 账户不进入 Codex 候选，Responses 账户可选；API/SDK/Codex 切换后恢复各自模型与连接草稿。
3. 从向导显式测试指定后端/模型；mock 收到所选虚拟 Key、原生模型 ID，未包含工具声明。测试成功后卡片展示相同范围的通过状态。
4. 创建只读角色并上传头像；复制保持绑定；账户停用后仍保留原选择，禁止活跃保存；重复 ID 错误回到可见字段，修改后保存停用副本。
5. 编辑角色改选第二账户，模型和版本更新，头像保留；新建原生 Claude 登录引导并取消，强制只读后保存停用草稿，未登录状态不能启用。
6. 编码模板使用确认模式，Write/Bash 未预先免审，切换白名单也未自动开放写入。
7. 保存成功后加入建房草稿，原目标保留且成员合并；没有创建聊天室或 Run。
8. 390px 屏宽无横向溢出；权限摘要、固定底部操作、Tab/Shift+Tab 约束、Escape、焦点恢复通过；返回上一步聚焦名称，重复 ID 的服务端错误聚焦 ID，只读 CLI 聚焦权限预览；刷新恢复同标签页文字与连接草稿。
9. 页面 JavaScript 错误为 0；DOM/sessionStorage 不含虚拟 Key；实际供应商调用为 0，全流程仅显式点击测试时调用本机 mock 一次。
10. SDK 的“同一运行复用 / 同一聊天室复用”切换会更新实际权限摘要；只读 CLI 显示“每回合新会话”。
11. 连接模型为 null 或工具列表包含 null 的损坏主体被忽略；单独产品缓存的工具列表损坏时保留当前角色、重新选择该产品正常；建房草稿的发送对象及工作区类型损坏时恢复可用空表单。
12. 390px 建房页的任务输入框宽度至少 200px，处于屏幕范围内，无横向溢出；运行详情收起、聊天室列表默认折叠，成员选择可用。

截图位于忽略目录 `apps/server/data/accounts-e3-qa/`：`confirmation-desktop.png`、`connection-mobile.png`、`confirmation-mobile.png`、`identity-mobile.png`、`room-draft-mobile.png`。桌面和移动确认页、移动建房页已进行视觉检查，内容滚动、权限、固定保存区域和建房表单可用。

## 本地验收与数据保留

开发服务继续运行，UI 为 `http://localhost:5173`，API 健康检查和 Vite 代理均返回 200，角色选项包含五个模板。E3 UI 测试使用独立数据库，没有在用户开发库中创建测试角色、账户或运行。

只读核对现有库及 E2 前备份：4 个角色，67 条 Run（65 条可见），用户账户 `gml-5.3` 的 ID、启停及版本保留；没有进行中的登录操作。角色和账户元数据及运行数量与备份一致。

## 剩余范围

- 真实 Messages/Responses 服务的模型权限、计费和完整编码/评审，以及用户原生授权成功链路，沿用 [E2 的待验收清单](./accounts-and-keys-phase-e2-acceptance.md)，由实际账户完成。模拟服务通过不表示真实供应商已经通过。
- 未上传头像在完整刷新或组件卸载后需重新选择；向导显示恢复提醒，文本和连接草稿可恢复。
- E4 迁移/回滚专项验收尚未开始；没有新增模型自动发现、账户池轮换或多用户权限体系。

## 2026-10-05：成员点击导致智能匹配自动改模式

用户确认选中外部成员后页面自动变成顺序流水线。原因是建房页根据外部成员派生模式，沿用阶段 A 限制；默认全选团队还使新加入的 SDK 角色触发该行为。现改为保留用户选择的模式，单独显示舰队成员选中状态和人数；新智能匹配草稿默认选择模型 API 成员，旧草稿保留原成员。外部成员的 Coordination 智能规划仍未接入，页面明确提示并提供显式切换模式，服务端兼容约束继续生效。

`pnpm verify:room-members-ui` 通过：默认候选团队、点击成员不改模式、SDK/CLI 兼容提示与显式切换、规划请求使用当前团队、预览失效、旧草稿和模式恢复、键盘操作、390px。新增浏览器验证拦截全部 API 请求，创建聊天室和供应商模型调用均为 0。类型检查、前端构建、E3 隔离浏览器及 Coordination Planner 回归通过；本地实际舰队的成员选择也通过临时浏览器会话复核，未创建聊天室或调用模型。

## 2026-10-05：选择外部成员导致建房表单宽度变化

智能匹配下，选择“鸡腿🍗”新增的兼容提示改变了表单内容宽度。浏览器 fixture 复现表单从约 466px 变为 767px；当时两种状态均无滚动条。建房容器现设置 `w-full min-w-0`，继续以 768px 为最大宽度，并用 `scrollbar-gutter: stable` 预留滚动条空间。

浏览器回归验证 1440×960、1440×540、1024×768、390×844：选择与取消 SDK 成员后，容器、目标输入框和舰队成员区域的位置及宽度一致，协作方式仍为智能匹配。1440×540 和 390×844 下提示使内容从无需滚动变为需要滚动，宽度仍一致；没有横向溢出。前端类型检查、生产构建通过，桌面及移动截图已视觉复核。测试拦截 API，无真实聊天室创建或供应商调用。
