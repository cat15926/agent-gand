# 账户与密钥阶段 E1：架构与使用

状态：已生效。日期：2026-10-04。

本文保留 E1 的管理与加密契约。当前托管调用和原生登录已在 [E2](./accounts-and-keys-phase-e2.md)接入，账户选择已在 [E3](./accounts-and-agent-creation-phase-e3.md)接入；迁移、停机备份与回滚以 [E4](./accounts-migration-phase-e4.md)为准。下文中尚未接入的功能描述仅指 E1 交付时的阶段范围。

E1 提供连接配置与 API Key 的集中管理。左侧“账户”入口打开“账户与密钥”，舰队角色管理也提供入口。当前角色和运行仍使用原有认证路径；托管账户的实际调用由 E2 接入，创建角色时选择账户由 E3 接入。页面和 API 明确标记这一区别。

实施方案见[已批准计划](../plans/accounts-and-agent-creation-implementation-guide.md)，验证证据见[E1 验收记录](../reports/accounts-and-keys-phase-e1-acceptance.md)。

## 使用流程

1. 执行 `pnpm dev`，打开 `http://localhost:5173/`，进入“账户”。本地模式自动建立管理会话。
2. 点击“添加 API Key”，填写名称、供应商和密钥。Anthropic/OpenAI 预填地址与协议；兼容服务需要填写地址并声明支持的协议。
3. 可维护模型 ID、推荐模型和超时。模型列表是用户维护的配置，不代表供应商实际授予权限。
4. 保存后仅显示密钥末四位。可以编辑连接、单独替换或清除当前密钥、启停账户、查看引用和删除。
5. “检查配置”只校验配置与密钥可解密状态，不访问供应商，不消耗模型额度；所有模型保持“未测试”。

官方类型的服务地址放在高级设置中。地址只允许 HTTP(S)，拒绝内嵌用户名/密码、查询参数和 fragment。默认模型必须存在于维护的模型列表中。

旧配置显示为只读条目：内置 OpenAI、内置 Anthropic、Claude SDK、Claude CLI 和 Codex 原生来源。内置 Anthropic 与 SDK 的环境密钥分别投影，避免把不同 Key 合并。原生来源显示“未检测”，既不读取完整 Token，也不声称已登录；创建独立登录账户留到 E2。

## 数据与版本

共享契约位于 [account.ts](../../packages/shared/src/account.ts)，服务实现位于 [accounts/](../../apps/server/src/accounts/)。新增表使用 `CREATE TABLE IF NOT EXISTS` 初始化，不改写旧角色和 Run 快照。

| 表 | 保存内容 |
| --- | --- |
| `accounts` | 名称、供应商、来源、启用/归档状态、乐观锁版本以及当前配置/凭据版本指针 |
| `account_versions` | 不可变的服务地址、接口协议、模型目录、默认模型和超时 |
| `account_credentials` | 加密凭据、随机 nonce、认证 tag、主密钥标识和末四位 |
| `run_account_bindings` | 为 E2 预留的 Run/角色与账户、配置、凭据版本绑定；E1 已尊重存在的绑定 |

每次修改需要 `expectedVersion`，过期修改返回 409。改名或启停只递增账户版本；连接变化递增配置版本，替换 Key 单独递增凭据版本。清除密钥将当前指针置空，旧加密版本暂时保留供后续冻结运行引用；立即撤销和旧版本回收由 E2 定义。

引用详情包含当前角色（包括停用角色）、活动 Run、历史 Run 和历史角色版本。旧角色按原有模型/Driver 映射到旧来源；显式 `accountRef` 引用也受保护。存在当前角色或未完成 Run 时禁止删除。只有历史引用时归档元数据和配置并删除凭据；无引用时物理删除。归档账户可以在状态筛选中查看。

## 密钥保存与备份

API Key 使用 AES-256-GCM 加密，随机 12 字节 nonce，附加认证数据绑定账户 ID、凭据版本和主密钥标识。公共视图只返回 `hasCredential`、末四位及可解密状态。没有读取原密钥的 HTTP 接口；WS 更新只发送账户 ID、版本和删除标记。

未设置 `ACCOUNT_MASTER_KEY` 时，第一次保存密钥创建 `<DB_PATH 所在目录>/private/account-master-key.json`。私有目录权限为 `0700`，文件为 `0600`；读取要求归属当前用户、普通文件、单一硬链接，拒绝目录/文件符号链接和宽松权限。也可通过 `ACCOUNT_MASTER_KEY` 提供 64 位十六进制主密钥，值应由部署环境保存。

备份需要同时保留 SQLite 与原主密钥。运行中的 SQLite 应使用在线 backup API；停服备份时应完整保留数据库及尚未 checkpoint 的 WAL，不能只复制一个可能仍在写入的 `.sqlite` 文件。原生认证目录仍按阶段 D 的方式单独备份。

恢复时先停止服务，恢复数据库和匹配的主密钥，检查目录/文件权限，再启动服务。数据库已有加密凭据但主密钥缺失时不会自动重新生成，账户显示“无法解密”。替换主密钥环境变量不会自动重新加密旧凭据，必须恢复原值。不要用 `pnpm db:reset` 处理解密错误。

私有目录与主密钥文件已从平台文件读取、搜索、工作区注册、隔离工作区复制和外部路径检查中排除，符号链接别名也受保护。Claude 的原生读取权限加入私有目录限制。这不构成对获批任意 Shell 命令的完整秘密隔离保证；E2 还需完成逐执行认证环境和原生子工具隔离，不能据此声称所有原生工具均无法读取服务进程持有的秘密。

## 管理访问边界

服务器默认 `HOST=127.0.0.1`；Vite 将 API 代理到 `127.0.0.1:3010`。账户接口校验实际客户端 IP、Host、完整 Origin 和 `Sec-Fetch-Site`，不信任转发头。本地可信来源默认包含后端端口和 Vite 5173 的 localhost/loopback Origin。

管理会话有效期为 8 小时，Cookie 使用 HttpOnly、SameSite=Strict、`Path=/api/accounts`；HTTPS 使用 Secure。写操作要求会话 CSRF Token，建立会话要求专用 bootstrap header。会话只在内存保存，服务重启后需重新连接。账户响应禁用缓存，请求体、解析异常和凭据值不写入账户日志。

非 loopback 监听时，账户管理必须配置至少 32 字符的 `ACCOUNT_ADMIN_TOKEN`；否则接口拒绝开放。前端输入该口令建立管理会话，口令只保留在页面内存。远程浏览器入口需要 HTTPS，并显式配置可信 Origin，例如：

```dotenv
HOST=0.0.0.0
ACCOUNT_ADMIN_TOKEN=<部署环境提供的随机口令，至少 32 字符>
ACCOUNT_TRUSTED_ORIGINS=https://gand.example.com
```

反向代理需要传递匹配该 Origin 的 Host。`ACCOUNT_TRUSTED_ORIGINS` 是完整允许列表，设置后替代默认值；多项用逗号分隔，不带路径或尾随斜线。这个管理边界仅覆盖账户接口；现有运行、角色、工具和 WS 接口仍未扩展为统一多用户认证，远程部署仍需外层访问控制。

## HTTP 契约

路由定义位于 [accountRoutes.ts](../../apps/server/src/api/accountRoutes.ts)。除访问模式和会话建立外，全部要求管理会话；写操作同时要求 CSRF。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/accounts/access` | 返回 local/token 模式及是否启用 |
| `POST /api/accounts/session` | 建立管理会话，返回 CSRF Token 与到期时间 |
| `DELETE /api/accounts/session` | 结束会话 |
| `GET /api/accounts?includeArchived=1` | 返回脱敏列表与阶段功能标记 |
| `POST /api/accounts` | 创建托管 API Key 连接 |
| `GET /api/accounts/:id` | 返回脱敏详情 |
| `PATCH /api/accounts/:id` | 修改名称、启用状态或连接配置 |
| `POST /api/accounts/:id/credentials` | 替换当前密钥并产生新版本 |
| `DELETE /api/accounts/:id/credentials` | 清除当前凭据指针 |
| `POST /api/accounts/:id/check` | 离线配置与解密检查，`testedModel=false` |
| `GET /api/accounts/:id/references` | 查看角色和运行引用 |
| `DELETE /api/accounts/:id` | 引用检查后删除或归档 |

E1 列表固定返回 `features.roleBinding=false`、`nativeLogin=false`、`liveTest=false`。兼容后端列表依据声明的协议计算，只用于配置提示；实际推理、原生登录状态和连接测试均尚未验收。
