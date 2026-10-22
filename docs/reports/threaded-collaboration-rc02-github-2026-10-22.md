# 持续协作 RC02：生产 GitHub 事实、跟踪与评审接线

日期：2026-10-22（Asia/Shanghai）。状态：**RC02 实现与所列分层验收完成，本次实现/文档/证据随Git提交交付；日常未配置/启用。**

本次先将RC01及此前进度文档提交并推送至 `origin/main`：`35804a1d12e51cda12105f635116ba1e48c27f40`。RC02在此基线上实施，不新增迁移，schema仍为v34；未实施RC03、RC04或日常部署。

## 1 交付与退出条件

| RC02 要求 | 本次交付 | 证据与限制 |
| --- | --- | --- |
| 生产单例安装可信PR/tracking来源 | [生产来源](../../apps/server/src/threaded/productionGithub.ts)由[service](../../apps/server/src/threaded/service.ts)读取 `THREADED_GITHUB_REGISTRATIONS_FILE`，经[production](../../apps/server/src/threaded/production.ts)安装PR source与github_pr tracking，复用已有Review producer/resolver | 18组专用隔离验收经过实际production factory、release/settings/runtime，不使用isolated execution bypass；默认未配置时明确not_registered |
| 固定仓库/权限/凭据来源 | 严格JSON固定owner、Thread、Agent、repo、PR number、login/mayAssign、配置及凭据版本；同时复核release grant、成员/角色/权限/账号版本和保留pack | 越界或失权在token/网络前拒绝；配置/凭据漂移稳定阻断；单凭据用户principal由官方/user确认，不支持多主体或任意endpoint |
| 官方GET与可信事实 | 官方/user及明确列出的pulls路径、GET-only、redirect:error、no-store、20秒、1MiB、响应identity/字段验证、I/O前后授权复验、固定错误码 | 真实provider 7项检查、8次官方GET通过；只读PR为 [clowder-ai#1618](https://github.com/zts212653/clowder-ai/pull/1618)，无远端写入 |
| baseline/freshness/撤权 | baseline按完整scope授权隔离；真实baseline不产生新HEAD事件；恢复结算与paused callback派发均重核当前source | 实际factory新HEAD唯一wake、重建不重复、旧HEAD审核拒绝、变化请求交付与gate分离为注入传输；真实新HEAD完整链仍交RC04 |
| 模型不能选择URL/secret | 服务端固定路由、环境变量来源和认证头；拒绝未知字段、内联secret/URL；SDK worker清理环境 | 扫描临时库、公开结果和worker环境无合成token；凭据未落库或进入模型工具输出 |
| 缺配置及observe失败关闭 | admission/capabilities公开注册状态；无文件不安装，observe不读token/不访问GitHub/不执行恢复业务写；注册不打开默认closed | 无日常release配置、业务库迁移、服务重启或灰度操作；closed仅按原合同允许合法既有工作读取事实/排空 |

完成口径为“生产代码可注册、权限和领域闭环按范围验收”，不是已在日常环境安装配置，也不是全部59项已通过。完整生效协议与配置模板见[生产GitHub合同](../architecture/threaded-github-production-v1.md)。

## 2 修复的恢复与并发窗口

此前tracking轮询会复核当前provider授权，但 `cooperation.recoverWithin()` 可先按旧事件里的授权指纹结算；暂停后的callback也可能只复验成员身份。RC02把当前source授权接入[cooperation](../../apps/server/src/threaded/cooperation.ts)和[collaboration](../../apps/server/src/threaded/collaboration.ts)：

- **注册**：prepare之后再核授权，baseline只取同一scope授权的事件，防其他Thread/Agent的同repo事件混入。
- **结算**：匹配事件已持久化而provider授权失效时withdraw wait，不产生callback；直接恢复、终态恢复和轮询路径遵守同一规则。
- **派发**：已经settled但因pause积压的callback，在发送前重新查原wait及当前provider授权；失配rejected，不创建旧消息/wake。历史settlement保留。
- **身份验证并发**：首次/user成功返回后写ready前再次assertAuthority，防另一并发401形成的永久故障被较早成功覆盖；交错fixture验证两请求拒绝、零PR GET及后续零重试。

独立审查还发现并已修复授权指纹的scope形式差异：tool传完整Binding、恢复只传owner/thread/agent，原先直接摘要整个入参会使合法wait立刻失配。现在统一三个规范字段，并由实际factory注册/恢复用例验证。上述问题均在本次开发阶段定位、修复和回归；没有以放宽授权检查通过用例。

这些修复服务于K04/K09/K11/K14及W05/A04–A07/MEM02，不改变原K01–K16或59项原文，不宣称参考源码已有本地同等可靠性保证。

## 3 验收命令与分层结果

| 命令 | 本次结果 | 证明范围 |
| --- | --- | --- |
| `pnpm typecheck` | shared/server/web通过 | 类型及当前接线；末次模块变更也经server类型检查 |
| `pnpm verify:threaded-production-github` | 18组通过；48次注入GitHub GET、320次合成token读取、9次注入模型HTTP | 实际production factory/grant、固定scope/PR、身份与响应、漂移/401/403稳定故障、撤权三个窗口、并发/user、baseline/唯一wake、SQLite/factory重建、Review交付/gate及秘密边界 |
| `pnpm verify:threaded-production` | 16组通过，非isolated bypass | closed/observe、入场/派发、保留pack、账号撤权、unknown和有界退出 |
| `pnpm verify:threaded-collaboration` | 17组通过 | 既有路由/私密/征询/等待及tracking不退化 |
| `pnpm verify:threaded-actions` | 12组通过 | 持久责任/并发/typed完成、旧代际/命令及PR事实职责 |
| `pnpm verify:threaded-reviews` | 9组通过 | 来源/作者/HEAD、修订和独立复审、历史门禁与ACL |
| `pnpm verify:threaded-production-github-live -- --authorized-git-credential` | 7项/8次实际官方GET通过，全部200 | 新生产provider真实传输、身份、事实/baseline及授权撤回；不包含完整factory真实模型链或自然HEAD唤醒 |

隔离结果去重为 **18组新增＋54组回归＝72组**，真实模型/供应商请求及新增模型token为0。真实GitHub验收单列，不将7项读请求检查与隔离组相加计算兼容比例。

证据：

- [专用隔离结果](evidence/threaded-rc02-production-github/isolated.json)：秘密扫描累计2133个临时表实例、1203行；原始字节/公开结果不含合成token，worker不继承GitHub变量，未绕执行许可。
- [相关回归结果](evidence/threaded-rc02-regressions.json)：本次4个既有套件的独立结果；不以旧报告替代新回归，未改写历史T10–T12证据。
- [真实只读结果](evidence/threaded-rc02-github-readonly.json)：沿用用户已明确授权，仅内存使用Git凭据，固定官方GET；无token/header/body秘密输出或保存。principal `cat15926`，PR作者 `liu-zhengdong`，HEAD `37ea19158f7d69198763f698c7f9d0a8b284d291`；该PR已closed/merged，baseline headChanged=false，重复及provider重建未制造事件。
- [本次交付校验](evidence/threaded-rc02-delivery.json)：当前源文件hash、原合同文字、文档和迁移不变检查。

真实验收中的scope撤权及“实际GET返回后撤权”由本地受控授权开关制造，官方HTTP本身真实；没有撤销日常账号、远端token或修改GitHub权限。provider重建的baseline由内存传递，不能称SQLite恢复；SQLite/factory恢复另由隔离用例证明。远端未通知的撤权不具有即时检测保证，实际失败不采信缓存。

## 4 保留的边界与后续

1. 日常未设置GitHub注册文件/凭据环境变量，未打开持续协作。安装能力与选择日常注册范围分开，发布仍按RC11–RC12执行。注册不等于远端写授权。
2. 真实新HEAD事件没有在本次发生；RC04仍未执行，不用已merged PR的稳定读取替代真实wake/修订/独立复审链。既有T12 606秒/48GET的not_observed记录不变。
3. GitHub.com用户凭据、单principal、明确repo/PR范围是本次范围；GitHub App installation、多凭据主体或Enterprise endpoint不作支持声明。
4. Review均为本地普通A2A交付及本地独立门禁，不发布GitHub review/comment，也不合并。历史context/workflow只证明已授权的历史事实；新操作必须重读当前权限与HEAD。
5. OS生产注册、结构化hold来源、SLA恢复窗口、命令共享准入及工程映射仍交RC03；RC05–RC10的真实模型/故障/综合组合、旧unknown对账、EXT01语义范围均未被本次替代。
6. 本次没有打开日常业务/模型账号数据库或累计token账本，没有释放旧unknown或调整20万门禁。Git凭据只用于已授权的官方只读验证，新增模型费用为0。

进度已同步[实施状态](../plans/threaded-collaboration-implementation-status.md)、[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)及[剩余计划](../plans/threaded-collaboration-remaining-plan.md)。下一阶段为RC03，未自动开始。
