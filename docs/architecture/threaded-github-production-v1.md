# 持续协作 GitHub 生产来源 v1

状态：**RC02 已实现及所列分层验收完成，日常未配置/启用**。更新：2026-10-22。承接[Action合同](threaded-actions-v1.md)、[Review合同](threaded-workflows-v1.md)、[发布合同](threaded-release-v1.md)及[RC01核验](../reports/threaded-collaboration-rc01-contracts-2026-10-22.md)。不新增schema迁移；生产仍默认closed。

## 注册与权限

生产单例从 `THREADED_GITHUB_REGISTRATIONS_FILE` 读取非秘密JSON，通过 `loadThreadedProductionGithub` 安装同一受信来源的 `actions.pr` 与 `trackingSources.github_pr`。未设置文件时两者不安装，admission/capabilities 的 `domains.github` 明确为 `configured:false,state:not_registered`；配置release成员pack不能自动取得GitHub能力。

```json
{
  "schemaVersion": 1,
  "version": 1,
  "ownerId": "INSTANCE_OWNER_ID",
  "credential": {
    "source": "environment",
    "name": "THREADED_GITHUB_TOKEN_READONLY",
    "version": 1
  },
  "repositories": [{
    "repository": "example-org/example-repo",
    "pullNumbers": [16],
    "threadIds": ["GRANTED_THREAD_ID"],
    "actors": [{
      "agentId": "release-agent",
      "githubLogin": "github-service-user",
      "mayAssign": true
    }]
  }]
}
```

这是模板，需替换为实例owner、已有release grant的Thread、pack成员及选定仓库/PR。只有明确列出的PR可读取；配置还必须通过当前Thread/成员/角色/权限/账号版本及保留pack检查。共享同一凭据的actor映射必须具有同一GitHub login；actor之间的本地Agent身份仍独立，`mayAssign`是本地责任准入权限，不代表远端写权限。如果被审PR的作者就是此GitHub principal，所有共享该principal的actor均不能充当独立reviewer；单凭据首版不支持通过伪填另一login审核自己的PR，该组合保持不可用，不能因可读PR而宣称评审门禁可用。

配置只支持 `environment`，变量名必须以 `THREADED_GITHUB_TOKEN_` 开头。值由部署进程注入，不能放在JSON、release pack、Thread消息、模型参数或命令参数中。首版只支持能由官方 `/user` 核实身份的GitHub用户凭据，以及 `api.github.com`；GitHub App installation token、多凭据主体和Enterprise端点不在本次范围。

配置严格拒绝未知/重复键、内联token/URL/header、重复或空范围；最多50仓库、每仓库100个Thread/8个actor/1000个PR。初次读取固定文件内容及文件身份，后续复验公开配置；文件更改、删除或路径重定向稳定拒绝，需按匹配版本重启。`version`与`credential.version`用于授权指纹，变更注册或轮换凭据须递增对应版本，不复用旧版本伪造相同授权。

## 凭据、传输与事实

凭据首次有效授权时只固定在进程内；缺失、格式错误、同进程值变化、HTTP401/403或身份不符均形成稳定不可用状态，修复后需重启。授权指纹只含公开配置hash/版本、credential版本、三个规范scope字段、仓库、login、mayAssign及当前release成员身份，不保存token或token哈希。完整Binding与恢复使用的三个scope字段得到同一授权身份。

首个外部读取前以同一token官方 `GET /user` 核实login；其后只允许 `GET /repos/<registered repository>/pulls/<registered number>`。全部网络在SQLite事务外，固定20秒超时、`redirect:error`、no-store/no-cache、API版本及User-Agent，不采信缓存降级。响应限制1MiB，验证PR number/base repo、HEAD SHA、作者、时间、state/merged/merge SHA，并只向适配器返回需要的事实字段。网络、解析和权限失败只产生固定错误码，不传播响应正文、原始异常或认证头。

网络前、返回后以及接纳事实前复验公开配置、凭据pin和当前成员授权。HTTP401/403后不再尝试读取token或发请求；404/429/5xx或无效响应不能形成可信事实。`registered`仅表示配置已装载，`ready`仅表示本进程已核实principal，均不代替每次PR权限、当前HEAD或领域门禁。远端未通知的权限撤销不具备即时检测保证；实际读取失败即拒绝，不以旧缓存批准新操作。

模型仍只提交结构化仓库/PR或 `repo#number`，不能选择端点、凭据来源或身份。SDK/工具进程继续使用现有 `cleanEnvironment` 白名单，不继承GitHub token变量。历史Review/消息仍按本地来源ACL读取；它们不证明当前provider授权或当前GitHub批准。

## tracking 与恢复撤权

首次实际读取持久化baseline，既有HEAD及单独updated_at变化不触发新HEAD事件。后续实质变化经原typed tracking接口记录，按完整scope授权隔离；注册时baseline只取同一授权的事件。

RC02在注册、恢复结算与待发回调三个位置重核当前来源授权：

1. 注册准备后的权限变化不能沿用旧prepared授权。
2. 匹配事件已入库、尚未结算时撤权，wait进入withdrawn，不产生callback。
3. 已结算但因pause积压的callback，在恢复发送前撤权则rejected，不生成旧wake；历史settlement仍保留。

这些检查覆盖直接调用cooperation恢复及终态事务中的恢复，不只依赖五秒轮询顺序。已在合法授权下发布的历史消息不被删除，也不授新责任；后续Action/Review门禁继续重新读取可信来源及当前HEAD。

RC04追加了受信私密事实共享策略：新登记的GitHub wait可冻结各注册成员当前来源授权与身份，再与原来源ACL交集；回调仍只唤醒原发起者，只有交集内成员能读取。派发前包括暂停恢复逐成员复验，撤权拒绝，新增成员不进入旧audience；普通消息tracking及旧wait仍caller-only，详见[真实事件/评审合同](threaded-live-review-acceptance-v1.md)。这补齐原先独享tracking来源导致合法修订无法交给独立reviewer的链路，不改变独立评审和当前HEAD门禁。

## 业务与模式边界

PR事实接入原 `transfer_action`、Review交付producer、完成resolver及 `check_review_gate`。被审HEAD/accepted source/作者/独立reviewer仍按原合同核验；`changes_requested`交付可完成评审责任，门禁仍blocked。历史approved不批准新HEAD。本模块不发布GitHub review/comment，不合并或写远端。

注册不改变release两个门禁。无pack/grant、成员失权或未列出范围不能读取；observe不读GitHub凭据、不访问GitHub，也不执行协作恢复写。closed拒绝新工作，但保留合法grant/注册时，既有工作可按原发布合同读取事实和排空；关闭新入场不等于撤销所有既有外部读取。

验收分层见[RC02报告](../reports/threaded-collaboration-rc02-github-2026-10-22.md)。真实新HEAD→唤醒→失效→修订→独立复审的组合仍交RC04；OS注册/hold/SLA交RC03，实际index真实供应商故障和日常迁移/灰度继续按RC05、RC11–RC12执行。
