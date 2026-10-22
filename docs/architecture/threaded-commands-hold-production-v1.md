# 持续协作：生产命令与等待合同 v1

更新：2026-10-22。RC03 在已推送 RC02 `a871910` 上实施；代码追加 v35，v25–v34 历史迁移不变。默认仍 closed，本文不代表日常部署已配置或数据库已升级。证据及范围见[RC03 报告](../reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md)。

## 首批生产命令

生产单例读取可选 `THREADED_COMMAND_REGISTRATIONS_FILE`。未配置时不安装任何命令，`domains.commands` 返回 `configured:false,state:not_registered`。release pack、Thread grant 和命令注册是独立条件，模型不能通过工具补充注册。

首批只提供服务器内置 `project_manifest_v1`：只读选定工程成员目录，生成文件路径、大小及 SHA256 清单，写入专用输出目录。program 固定为当前 Node，argv 固定为经过 pin 的 worker 及公开配置；环境为空，cwd 固定为输出目录。模型 `args` 仅允许空对象/null，不允许替换命令、环境、程序、参数或路径。任意 shell、构建、联网、Git 写入和合并命令尚未注册；后续每种 profile 必须单独定义权限、全部副作用域和可信核对方式。

配置文件仅包含公开元数据，严格拒绝未知键、重复键、范围重复、非规范路径、符号链接及不支持的 profile。例如：

```json
{
  "schemaVersion": 1,
  "version": 1,
  "ownerId": "INSTANCE_OWNER_ID",
  "projects": [{
    "id": "selected-project",
    "root": "/absolute/canonical/project",
    "members": [{
      "threadId": "GRANTED_THREAD_ID",
      "agentId": "release-member",
      "workspace": "/absolute/canonical/project/member"
    }]
  }],
  "commands": [{
    "id": "project-manifest",
    "projectId": "selected-project",
    "threadId": "GRANTED_THREAD_ID",
    "agentId": "release-member",
    "profile": "project_manifest_v1",
    "cwd": "/absolute/canonical/project/output",
    "readPaths": ["/absolute/canonical/project/member"],
    "writeRoot": "/absolute/canonical/project/output",
    "settleDelayMs": 0
  }]
}
```

目录须预先存在；模板不能直接启用。映射只作用于明确列出的 owner/Thread/Agent，未列成员沿用原隔离目录。已映射但路径失效时拒绝，不能悄悄退回另一个 workspace。工程根、成员 workspace、命令 cwd 显式登记，成员 workspace 互不交叠；任何命令输出根与所有成员 workspace 均不交叠，各命令输出根也不交叠。readPaths 限于该成员 workspace，无父子重复声明；输出仅为专用目录。模型 Session 绑定选定成员 workspace，映射及输入指纹进入信息边界，变更必须经匹配版本重建，不能借另一目录续接原生会话。

注册文件、Node、worker、guardian 及工程目录身份会被固定，输入树同时固定文件身份和内容。运行前复验配置、目录身份、程序 pin、输入清单及当前 release/member/account 权限。路径重定向、同路径替换、输入漂移或撤权拒绝新执行。文件输入有数量、大小、总字节及递归深度界限；符号链接、硬链接和特殊文件拒绝。程序信任来自服务器内置且固定的代码及受控宿主，不是任意程序的操作系统级沙箱。

## 独立资源与结果核对

先持久化命令 intent，再获取独立命令 claim；命令不占模型容量或 native Session，也不依赖父 Invocation 的 finally 释放目录。claim 包含完整 readPaths 的 read 声明与 writeRoot 的 write 声明，协调器对照原 intent 精确验证，不允许缩减、添加或变更访问声明。父子路径采用既有 read/write 互斥；父 Invocation 仍持有的 read 与重叠 command write 也冲突，不能绕过。当前 profile 用分离输出目录允许合法的 read/read 与独立 write。

领取、进程 ready 和外部启动前再次检查原 Invocation 围栏、当前 Action generation 和未结束 holder。启动后持久化宿主、PID/PGID、启动身份和随机 guardian token；恢复只观察原 intent，不盲重启。取消仅能作用于经核验的原 guardian 进程组；IPC 断开或 owner 退出由 guardian 停止子树。信号发送成功、租约到期和主进程退出本身都不足以释放资源。

进程组停止和副作用核对是两份证据。父进程独立重读 pinned 输入并复算 manifest，检查输出目录完整内容及精确字节；正常成功必须存在正确 manifest。失败/取消时空目录可以证明该 profile 没有持久输出；未知文件、残留 pending、输入漂移或缺失成功产物不能被当作核对通过。无可靠 native exit 时结果仍可为 unknown，即使已证明进程停止。只有原 claim 对应的持久进程静止及副作用证明都成立，才能释放资源；可恢复的未知输出须独立处理后再次核验，不自动删除。

command terminal 只表示注册程序结果，不表示业务 Action 完成，回调明确 `businessConditionVerified:false`。结果入库、等待派发、暂停后恢复派发均复验当前端口权限与 Action 代际；撤权的 terminal wait 标为 stale，已排队回调标为 rejected，不唤醒新 holder。

## 结构化 hold 与来源

`hold_ball` 仍立即返回，定时范围 5–3600 秒。`waitSourceRef` 改为严格结构对象：

```json
{
  "kind": "thread_message",
  "value": "REAL_READABLE_MESSAGE_ID",
  "expectedSignal": "registered background result",
  "slaUntilMs": 1792694400000
}
```

六种 kind 为 `github_issue`、`github_comment`、`thread_message`、`task`、`reporter_handle`、`managed_command`。`reporter_handle` 必须另含 `anchorRef`。来源必须可验证；伪造 ID、跨 owner/Thread、不可见消息、超过原输入 cutoff 的消息、缺 anchor 和 `pending_input`/明确的人类输入等待均拒绝。等待用户回复应使用普通消息或 interactive Decision。自由文本 expectedSignal 是预期说明，不构成业务事实。

本地 message/task/managed_command 由真实数据库、原作用域、消息 ACL 和当前 command/Action 权限核验。私密来源加入派生边界，不能被公开 timer 泄露。GitHub issue/comment 与 reporter 需服务器另装 `waitSourceAuthorization`，返回固定授权及可读 anchor；默认缺失即拒绝。RC02 的 PR 只读来源不冒充这三个 adapter。注册时冻结来源身份，恢复及回调派发前再次核验。

同一 job 的精确重试在消耗额度前返回原 wait，不改 deadline/root/SLA。timer 和 `wait_command` 共用 v35 账本：每 owner/Thread/Agent 滚动一小时最多 3 次新 hold；同一 commandId 仅一次，换 tool request key 不再扣额。窗口为 `(now-1h, now]`。`run_command` 只启动受资源限制的命令，不自动注册 wake；调用 `wait_command` 时才占 hold 额度。quota 拒绝、替换和新 wait 的写入同事务回滚。旧 timer quota 全量保留并前向回填，不能通过升级清零。

升级时旧 command wait 没有可恢复的注册时间：仍 awaiting，或其已生成 callback 尚 pending/waiting 的命令，以一次迁移时刻保守占用一小时额度；这不是精确历史时间。已完成派发或 stale 的旧记录不全量重扣。重复迁移不重计、不续期。参考 ManagedJobService 的默认4并发/同user+cat是另一控制面；本地命令按完整workspace claim互斥及固定注册范围控制，不宣称与其并发参数同形同参，真实工程组合仍须RC06。

## SLA、恢复及守门域

SLA 是停机错过 timer 后的恢复窗口。factory 启动时已经到期的原 timer 才进入 missed 分类；运行中创建的 timer、或重启时尚未到期的 timer 保持在线 one-shot 语义，即使在线到时已超过 SLA，也不改为硬取消。在线仍须来源和权限有效。

missed 恢复检查原 timer deadline/createdAt、结构化来源、冻结成员/账号身份、原消息边界、控制记录及 Action 代际。有效且 `now < slaUntilMs` 才结算并允许派发一次；pure classifier 在相等时可返回 recover，但此时没有实际重试窗口，持久处置为 retired_expired。之后同样过期；来源/身份无效为 retired_invalid，wait 进入 withdrawn，不生成回调。暂停积压的恢复回调到 SLA 后也拒绝。原记录及费用/额度不重建、不重复消耗。

旧版自由文本 timer 不自动补造来源、SLA 或授权。错过的旧 timer 退休为 invalid；启动时尚未到期的旧 timer 在线到时也明确退休，保留原记录及 invalid outcome。

默认域为 ordinary。只有服务器显式提供 `holdPolicy(scope) => 'gatekeeping'` 才采用守门专域：timer 最多 600 秒，且注册时已有 tracking/command event callback 则拒绝冗余 timer。该策略不能由模型选择，当前日常服务没有指定守门 Thread；不把源项目专域限制扩成所有等待的限制，也不复制其 shadow/fail-open 检查。

真实供应商主服务故障组合仍按 RC05 验收，真实工程写作/合并与并发争用按 RC06；日常注册、备份迁移与灰度按 RC11–RC12。本文的首批 profile 不替代这些验收。
