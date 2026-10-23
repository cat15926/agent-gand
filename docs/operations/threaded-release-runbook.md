# 持续协作发布、排空与恢复手册

日期：2026-10-23。适用 schema 35（RC03前向追加，历史v25–v34保持不变）、HTTP `threaded-http-v1` 及当前兼容 worker。实现依据为 [production](../../apps/server/src/threaded/production.ts)、[发布配置](../../apps/server/src/threaded/productionSettings.ts)、[发布账本](../../apps/server/src/threaded/release.ts)和[独立 HTTP 路由](../../apps/server/src/api/threadedRoutes.ts)。组合范围仍以[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)为准。

代码交付不会自动修改日常配置、升级日常数据库、重启服务或开放房间。默认 `THREADED_COLLABORATION_MODE=closed`，未配置 release pack 时没有生产执行器；持久发布控制初始为虚拟版本 `0`，`admissionOpen=false`、`dispatchOpen=false`。本手册中的配置和请求是可审阅示例，尚未执行。

## 1. 确认发布范围与配置

首批生产接线仅接受 macOS（`darwin`），以及服务端明确登记的 `api` / `threaded-http-v1`、`claude-sdk` / `0.3.288`。只接受启用的托管 API Key 账户，角色、模型、账户配置版本、凭据版本和身份代次必须与数据库当前元数据精确一致；原生登录、其他 driver 和其他平台不能从配置模板推导为受支持。

服务不会把旧房间原地切换为持续协作，也没有“全部历史 Thread 自动开放”的选项。允许的新房间由已认证的新建请求创建，服务器用 release pack 的完整成员名单、版本和账户信息建立 grant，并与房间、路由和开放状态同事务提交。已存在的未授权历史 Thread 不会被接管。

release pack 是运维管理的 JSON 文件，不含 Key、Token、连接地址、工作区路径或角色私密指令。示例：

```json
{
  "schemaVersion": 1,
  "platform": "darwin",
  "members": [
    {
      "agentId": "REPLACE_WITH_EXISTING_AGENT_ID",
      "backend": "api",
      "backendVersion": "threaded-http-v1",
      "model": "anthropic:REPLACE_WITH_EXACT_ROLE_MODEL",
      "roleVersion": 1,
      "permissionVersion": 1,
      "accountId": "REPLACE_WITH_MANAGED_ACCOUNT_ID",
      "accountConfigVersion": 1,
      "accountCredentialVersion": 1,
      "accountIdentityGeneration": null
    }
  ],
  "applicationTools": [
    "post_message",
    "read_message",
    "search_messages",
    "message_sources",
    "conversation_decision",
    "settle_decision"
  ],
  "maxOutputTokens": 512,
  "maxInputTokens": 65536,
  "maxRequests": 4,
  "prices": {
    "REPLACE_WITH_EXISTING_AGENT_ID": {
      "inputPerMillion": 1,
      "outputPerMillion": 1
    }
  }
}
```

替换所有 `REPLACE_WITH_…` 和示例版本，直接核对既有角色及账户元数据，不通过更改历史角色或账户来迁就模板。`model` 必须逐字等于角色定义的模型；不能擅自加、删 `anthropic:` / `openai:` 前缀。示例价格 `1` 只是字段占位，单位为每百万 token 的美元价格，须改为本次已核实的计价。价格缺失不能视为免费，默认根预算的未知费用策略可能阻止请求。

成员数量为 1–8；Agent ID 仅接受字母、数字、下划线和连字符，最长 100 字符。SDK 成员只将 `backend` 改为 `claude-sdk`、`backendVersion` 改为 `0.3.288`，同时保留其精确角色/账户/模型元数据及 Anthropic Messages 协议条件。添加成员和扩大工具范围应先完成相应组合验收。

模型实际可用的应用工具是 pack `applicationTools` 与该角色 `tools` 的交集，之后仍受当前 Binding、ACL、Action 和代际约束。pack 不授予额外业务批准或工作区写权限。服务器派生每个 Owner/Thread/Agent 的独立工作区和私有配置目录，连接和凭据仍从托管账户解析。

`maxOutputTokens` 范围为 1–8192，`maxInputTokens` 为 8192–250000，`maxRequests` 为 1–16；它们约束本轮后端请求，不能替代整条因果链的预算。接力、等待和修订保留根预算，未知用量继续占额，不能以设置价格或请求上限宣称供应商账单硬封顶。

配置文件与模式均在服务启动时加载。例如保留关闭状态准备部署：

```sh
THREADED_COLLABORATION_MODE=closed
THREADED_RELEASE_MEMBERS_FILE=/受保护的部署目录/threaded-release-pack.json
```

这两个字段不包含秘密。生产服务通过显式执行策略取得执行权，不应设置 `AGENT_GAND_ISOLATED_WORKER=1` 来绕过发布策略。RC02已接可选GitHub PR/tracking/Review来源；未设置注册文件时明确not_registered，release pack不会自动启用。RC03已接可选OS命令注册，首批仅受信 `project_manifest_v1`；缺少注册时命令明确not_registered，其他tracking/命令来源不能从配置模板推导支持。

如选择GitHub只读范围，按[生产GitHub合同](../architecture/threaded-github-production-v1.md)准备非秘密注册JSON，固定当前实例、已grant的Thread/成员、repo及PR number，配置 `THREADED_GITHUB_REGISTRATIONS_FILE` 指向受保护文件。部署进程另注入指定的 `THREADED_GITHUB_TOKEN_*` 用户凭据；不要把值写入JSON、Thread或release pack。首个读取官方/user验证配置principal，只有当前release成员权限和匹配版本才可使用。注册内容或token轮换需递增相应版本并正常重启，不用删除等待/unknown恢复访问。

`domains.github.state` 的registered只表示公开配置已加载，ready只表示本进程principal验证通过，每次PR仍需当前授权/HEAD；配置漂移、缺token、401/403或身份不符按状态拒绝。observe不会读取GitHub凭据/网络；closed拒新根但可按合法既有grant处理事实，关闭入场不等于撤销所有外部读取。详见[RC02分层报告](../reports/threaded-collaboration-rc02-github-2026-10-22.md)。本次未在日常环境设置这些配置或开放功能。

如选择首批生产命令，按[命令与等待合同](../architecture/threaded-commands-hold-production-v1.md)准备受保护的公开注册JSON，通过 `THREADED_COMMAND_REGISTRATIONS_FILE` 加载。固定工程根、已grant的Thread/成员、成员workspace、专用输出cwd及完整read/write声明；目录必须已存在且规范、不交叠，模型不能选择路径。当前只读工程清单程序经过执行链和输入pin，并由父进程独立核对产物；任意shell/构建/网络命令不在首批范围。`domains.commands` 不显示私密目录内容。修改已加载注册或工程输入会阻断旧端口，不能用重命名或清理unknown绕过原claim；先保留证据并按匹配版本对账。

v35保留旧timer额度并建立timer/command wake共享账本；旧活跃command wake因缺历史注册时间，以一次迁移时刻保守占一小时且重启不续期；升级后既有字符串timer不补造来源或SLA，无效等待显式退休。实际旧等待处置、额度回填与恢复演练应先在备份副本核验，不能只根据schema升级成功宣称业务恢复完成。本轮没有执行日常迁移或配置。

RC04的[真实事件/评审验收](../architecture/threaded-live-review-acceptance-v1.md)使用临时生产工厂和只读官方事实，与日常放行分开。GitHub新wait的受信共享audience按原来源ACL及各成员授权/身份冻结、派发复验；仍只唤醒原发起者，旧wait和普通消息tracking不自动扩大可见范围。脚本评审报告不是工程审查或远端批准，真实新事件不足时保持未验，不能作为扩大canary的依据。

## 2. 两个独立门禁与运行模式

| 控制 | 实际含义 |
| --- | --- |
| `mode=closed` | 拒绝新根和新房间；保留匹配 pack、grant 和 `dispatchOpen=true` 时，已接收根仍可排空 |
| `mode=observe` | 持续协作只提供快照、路由预览和恢复计划；不派发模型，也不接受业务写请求 |
| `mode=execute` | 允许检查新工作准入；仍需有效 pack、`admissionOpen=true` 及新房间 grant |
| `admissionOpen` | 只控制新房间和新用户根，不改变 Thread 状态或执行 epoch |
| `dispatchOpen` | 只控制后续新 claim；关闭后，已运行且仍获授权的请求可正常收尾 |
| Thread / Member / Invocation 的暂停、停止 | 独立的用户控制，可使当前执行失权并发出取消提示；资源释放仍需静止证据 |

操作 `/api/threaded` 必须通过现有 Owner 管理会话建立持续协作会话，携带有效 Cookie、CSRF 和受信 Origin；请求不能提供 `ownerId`、Binding、epoch 或代际来声明身份。下列示例表示已登录客户端的请求，不是匿名 curl 接口。

先读取：

```text
GET /api/threaded/admission
GET /api/threaded/release
```

`admission` 给出配置可用性、拒绝原因及当前控制版本；`release` 给出 grant 和逐项工作计数。首次关闭/开放使用预期版本 `0`，之后必须使用实际返回版本：

```http
POST /api/threaded/release/controls
Content-Type: application/json

{
  "expectedVersion": 0,
  "requestId": "release-20261021-open-1",
  "admissionOpen": true,
  "dispatchOpen": true,
  "reason": "Open the reviewed canary configuration"
}
```

`expectedVersion` 冲突时重新读取状态后决定下一次操作，不覆盖另一位操作者。相同 `requestId` 与相同完整请求返回原审计回执；改变同键内容会冲突。控制变化及其原因持久保存；控制写入失败不会只留下已经改变的门禁。

## 3. 小范围启用与验证

1. 保持新入场关闭，保存匹配版本的备份，在隔离副本完成迁移和恢复演练。正常启动会前向迁移到 schema 35；不能将日常启动当成只读检查。
2. 安装经审阅的 pack，将模式改为 `execute` 并正常重启；先读取 `admission`，确认 `configured=true`、`ready=true` 且成员/后端/模型符合本次范围。此时门禁仍按持久值生效，不会因重启重置。
3. 用带版本的发布控制打开新入场及派发。仅创建本次 canary 的新 Thread：

   ```http
   POST /api/threaded/threads
   Content-Type: application/json

   {"title":"持续协作验收空间","clientRequestId":"release-20261021-canary-1"}
   ```

   请求不能提交自选成员、账户或后端。服务器配置完整 roster，以第一个登记成员建立默认路由。新 Thread 的 grant、来源版本和权限指纹保留在账本中。
4. 在返回的 Thread 内提交小任务，核对用户消息、真实派发、应用工具回执、正式响应、请求用量和资源释放。Invocation 完成、Action 完成、review 门禁及 SOP 自报状态分别核对，不能用消息队列清空或一条“完成”正文替代业务证据。
5. 核对 UI 刷新、重连和重复发送。已经接收的同键请求即使在关闭新入场后重试，也应查回原回执，不创建第二条根或请求。确认范围后再决定是否扩大部署；本次实现本身没有执行这一步。

启动顺序是先核实宿主/原生事实、恢复持久执行与其他模式，再由 `startDispatch()` 放开新派发。通知和修复定时器不能越过这一屏障。具体隔离证据见[生产集成验收](../reports/evidence/threaded-t12-production/isolated.json)；它不代表日常服务已切换。

## 4. 关闭、排空和观察

正常停止新工作时，提交新的控制版本，将 `admissionOpen=false`，保留 `dispatchOpen=true`。需要关闭产品入口时，再将配置模式改为 `closed` 并正常重启，保留原 pack。这样已接收根仍可领取、执行并结算。

关闭新入场不改 Thread 为 `closed`，也不增加它的 authority epoch。直接修改这些字段会取消或阻断旧工作，不能作为 release 开关。旧的普通用户根不能在关闭后新增；对既有 interactive Decision 的有效回答仍可延续原根，后续 `settle_decision` 使用同一预算。暂停、停止、权限撤销、账户变化、预算和期限仍立即生效。

要暂缓领取后续工作，将 `dispatchOpen=false`；已运行请求仍可有据结束。要中断当前工作，使用现有已认证的 Thread/Member/Invocation 控制。取消提示不等于进程已退出，不能据此释放资源或清零未知费用。

进入 `observe` 前，先在当前兼容服务中关闭新入场；如需保留明确的暂停意图，同时关闭派发。随后正常停服，将模式改为 `observe` 后重启。观察状态不能通过持续协作 HTTP 修改门禁、路由策略、消息、Decision、生命周期控制或批准决定；只有读取、纯路由预览和会话注销等例外。需要继续控制或排空时，保留 pack，以 `closed` 模式重启兼容服务，再按版本明确恢复派发。

`observe` 是持续协作的行为模式，不是整库以 SQLite readonly 打开的保证。主服务的数据库初始化、迁移、宿主登记和其他模式恢复仍有其原有写行为；观察恢复计划不会证明外部进程已静止。不要以不停服修改环境变量、替换已加载文件或改数据库行来切换观察状态。

`GET /api/threaded/release` 的关键字段：

| 字段 | 处理含义 |
| --- | --- |
| `queued`、`undispatchedWakes`、`pendingOutbox` | 尚有可修复或待领取工作，通知丢失不能视为工作已消失 |
| `running`、`activeClaims`、`activeProcesses` | 执行或资源仍未完成释放/静止核验 |
| `waiting`、`durableWaits`、`consultations`、`callbacks`、`pendingApprovals` | 仍需兼容 worker、外部事实或 Owner 处理 |
| `unresolvedActions`、`unresolvedCommands` | 业务责任或命令尚未终结；Invocation 完成不会自动清空这些项 |
| `unknownExecutions`、`unknownUsage` | 执行与消耗分别不确定，保留围栏、账本和原始证据 |
| `drain.ready` | 仅在新根已经关闭且本快照所有 threaded 工作项均为 0 时为 true |
| `drain.scope=threaded_only`、`wholeDatabaseRollbackReady=false` | 本清单不能证明旧模式、手动执行或整库已经具备回退条件 |

保持相同 schema/协议兼容服务处理未决工作，直到排空或由 Owner 明确暂停。持久等待和 unknown 不应通过删除记录来“排空”。进程退出、已接收正文、用量结算分别核验；关机等待到期会保存未知事实。之后收到可信的精确请求回执可以证明静止并对账，但晚到正文不得作为失权结果发布，原未知审计保留。

### 保留匹配的旧 pack

Thread grant 冻结 backend、backendVersion、model、角色版本、权限版本、账户及其版本。现有根不能因当前配置文件换成另一 driver 而静默升级。移除旧成员或改变这些字段后，旧根可能明确阻塞为 `THREADED_RELEASE_CONFIGURATION_NOT_RETAINED`；账户或角色失效有相应拒绝原因。

排空旧根时保留其完整匹配配置及仍有效的账户/角色元数据，并继续使用兼容服务。当前一个服务只加载一份 pack；同一 Agent 的互不兼容旧/新配置不能靠重新贴标签同时恢复。先排空旧根，或保留旧根明确暂停及其快照，再计划新 Thread。恢复 pack 不得绕过真实账户撤销、权限变化或已知风险，也不能手工修改 grant/hash/版本来假装兼容。

`THREADED_RELEASE_CREDENTIAL_VERSION_MISSING` 表示匹配的加密凭据版本行缺失：准入会显示不可用，已接收根明确阻塞，不尝试解密。`THREADED_RELEASE_CREDENTIAL_UNAVAILABLE` 表示实际安全读取/解密失败：该 Agent 在本进程内保留不可用故障，避免通知驱动的反复解密和排队活锁。保留根与账本，修复原主密钥、原凭据版本或文件权限后，正常重启匹配 pack 再核验；不要生成新 Key、替换账户或删除 unknown 来使旧工作继续。

### RC05 故障边界补充

[RC05合同](../architecture/threaded-fault-recovery-acceptance-v1.md)与[报告](../reports/threaded-collaboration-rc05-fault-recovery-2026-10-23.md)提供实际index/选定供应商、timer停机与SQLite故障分层证据，不授日常启用。missed timer必须保留原fireAt/seconds及来源/SLA，畸形旧记录退休；恢复已unknown的原outcome原因与预算hash不重结算。后台lease/hold恢复tick遇操作性SQLITE存储错误只终止当前周期，记录固定任务名/错误码并等下一既有周期；启动时恢复/迁移与其他错误仍fail-fast。存储恢复前不能承诺新工作成功，恢复后不能盲重放原请求。

默认1000ms片长仍可能在同步准备期间过期；本轮仅合成根通过正规Owner CAS显式选10000ms并验真实供应商。目标发布须明确选定片长和总预算，不能直接沿用验收根配置打开日常入口。SDK中途杀父后即使宿主确认guardian组已停，原持久registered/unknown及供应商未知费用仍保留，待可信事实对账。原89758未知加本轮97271未知预留全部保持；当前累计252210 token保守占额及两轮未定位真实超时详见报告，不据新成功自动释放旧项。

## 5. 一致性备份与恢复

关闭新根并核对 threaded 清单后，还须独立检查旧协作、自主协作、手动 Run、工具执行、登录/账户测试、原生进程、未知效果和费用。`drain.ready=true` 不能替代整库停机检查，`accounts:backup` 的既有原生进程检查也不能代替新模式的进程/claim/unknown 清单。

正常停止服务，等待异步 shutdown 核验。若日志显示未核实执行，保留兼容 worker 和该状态，先处理进程归属及对账；不要将“主服务已退出”当成“所有子进程已退出”。保全当前数据可以记录未决状态，但不得据此把旧快照恢复标为无风险。

按[账户备份规范](../architecture/accounts-migration-phase-e4.md)使用 SQLite backup API 的一致副本，备份父目录必须已经存在，输出目录必须全新：

```sh
pnpm accounts:backup --output /受保护的备份目录/新的备份名
pnpm accounts:verify-backup --input /受保护的备份目录/新的备份名
```

同时保留匹配源码及依赖版本、实际未提交源码、部署环境、release pack、角色文件、账户主密钥和私有目录、threaded 原生配置目录/Session、工作区、产物及必要外部系统事实。环境提供的主密钥和旧环境凭据须按原安全渠道另存，不能把它们写进 pack、仓库或验收报告。仅复制正在使用的 `.sqlite` 文件不能保证含 WAL 的一致性。

恢复分为两类：

1. **保留 schema 的关闭或恢复。** 使用支持 schema 35 的匹配兼容程序和当前数据，先 `closed` 或 `observe`，保留匹配 pack；核对未知事实及恢复计划后，在 `closed` 下明确打开派发来排空。此路径不会把新协议交给旧程序。
2. **整组历史备份回退。** 先额外保全切换后数据库、WAL/SHM、私有目录、工作区和产物，核对升级后新增工作及外部副作用，再恢复经校验的配套备份、源码、配置、密钥和目录。旧 SQLite 不得混用新 WAL/SHM。历史快照不会撤回已经发布的信息、真实执行或供应商费用；未决增量必须单独处理。

启动前的 schema 校验会拒绝不识别新迁移的旧 binary/worker，且在 schema 初始化前执行。不能删迁移行、新表或 unknown 来降低版本。隔离 release 验收已执行实际 T11 `ba438b1` 的 v33 兼容门，确认拒绝 v34；RC03隔离验证另确认实际RC02 `a871910` 的v34 worker拒绝v35且零修改；这些结果不等于已经替日常环境完成历史备份恢复。

先在隔离原路径副本演练，核对 `quick_check`、外键、grant/root、消息/回执/Action 和预算历史；恢复阶段不得自动重放未知外部请求。完整运维操作应记录应用 revision、schema、pack 摘要、配置模式、控制版本、停机前后清单及保留的未知项，再按已验证范围恢复兼容服务。
