# 外部 Code Agent 阶段 D 验收

日期：2026-10-04。单宿主 macOS/Linux 的持久化与编码隔离已交付，验收使用临时数据库和一次性 Git 仓库。没有重置开发数据库、复制个人认证或调用供应商模型。当前契约与使用见[阶段 D 架构](../architecture/external-code-agent-phase-d.md)。

## 专项集成验证

`pnpm verify:external-agents-d` 使用真实 Fastify 路由、Git worktree、SQLite、统一 AgentTurn 和实际进程管理；原生推理由可控 SDK/app-server fixture 替代。已通过：

| 场景 | 验证结果 |
|---|---|
| 并发编码两个 Run | cwd 不同，各自实际文件内容独立，原仓库没有 agent 新文件 |
| 用户脏基线 | 未提交 README 与未跟踪文件复制到新 worktree，原文件保持原内容 |
| 固定 Reviewer | Coder 完成后再修改 working cwd，Reviewer 仍读取对应快照中的原结果 |
| 补丁导出 | API 返回固定快照的 binary patch；不包含后来修改，能对原脏基线 git apply --check |
| 平台路径保护 | managed .git 与大小写别名均不可写，原生文件策略同样拒绝 .GIT，快照 resolver 始终只读 |
| 混合队伍写入 | 内置 mock Agent 的实际 fs.write 落在同一 managed cwd，原目录无该文件 |
| SDK/Codex 会话续接 | 同聊天室 cwd/native ID 不变；新投递不包含旧历史标记原文，包含新任务 |
| 跨服务进程续接 | 新 Node 服务进程加载数据库和 native 文件，两个后端均恢复完成会话 |
| 单 Run 多回合 | 同 scope 结果缓存；不同 scope 的相同角色可按 run 策略恢复 |
| 会话失效 | SDK 预检失败、JSONL 丢失、账户改变均安全冷启动，无模型 turn 后重放 |
| 累计 usage | Codex 下一轮只记累计差值；SDK 恢复的 token/cost 保持未知 |
| 持久占用 | 另进程持有且仍活着时，即使过期也不能抢占；进程退出后可获得普通资源 |
| 服务单 owner | 同数据库第二活动服务启动被拒绝 |
| 原生启动授权前 SIGKILL | guardian 已登记、尚未授权实际 native spawn；恢复不启动原生 turn |
| 首个写入后 SIGKILL | 实际变更与 evidence 保留，旧进程收敛，execution interrupted，不重放 |
| 等待审批时 SIGKILL | 文件未写，旧审批 expired，无 pending 遗留，不重放 |
| 原生终态保存后 SIGKILL | completed 结果可缓存返回，不重复模型 turn 或写入 |
| 同组 stubborn 子进程 | 父服务 SIGKILL 后父原生与忽略 TERM 子进程均退出，没有迟到文件 |
| 连续恢复两次 | native turn 数不变，没有双 worker，活动进程登记清零 |
| 无登记旧版本 / PID 不匹配 | recovery attention，工作区围栏保留，不误杀当前测试进程 |
| 主管任务恢复 | 当前 Attempt 原生中断时失败且不重排；过去失败不能误伤后来已完成的返工 |

测试验证的是平台真实边界与本地原生协议 fixture，不将 fixture 的模型选择等同于真实模型行为。

## 本机真实协议验证

`pnpm verify:claude-sdk-session-protocol` 使用真实 SDK 0.3.288、真实 worker 和本地 Messages API。第一进程保存私有 JSONL；第二进程通过 `getSessionInfo` 后恢复同一 UUID；第二次 API 请求保留第一轮用户输入与 assistant 响应，并包含新任务。供应商模型推理次数为 0。

`pnpm verify:claude-sdk-mcp-protocol` 复验真实 SDK PreToolUse、MCP 回调与中断；`pnpm verify:codex-mcp-protocol` 复验真实 Codex 0.159.2 的 MCP 环境与工具发现；`pnpm verify:codex-app-server-protocol` 检查 initialize/thread-start 的只读与审批回执。Codex 的 completed thread/read/resume 与模型 turn 由专项 fixture 验证，未声明真实供应商恢复编码通过。

## 回归与构建

验收命令：

- `pnpm verify:external-agents`、`pnpm verify:external-agents-b`、`pnpm verify:external-agents-c`、`pnpm verify:external-agents-d`
- 三个上述既有原生协议检查与新增 `pnpm verify:claude-sdk-session-protocol`
- `pnpm verify:runtime-crash`、`pnpm verify:durable`、`pnpm verify:followup-stage3`、`pnpm verify:collaboration`
- `pnpm typecheck`、`pnpm --filter @agent-gand/web build`、`pnpm verify:docs`、`git diff --check`

上述回归、类型检查、前端构建、文档链接和 diff 格式检查均通过。阶段 A 回归首次发现 Guardian 把 CLI stdin EOF 误判为停止，修正为仅以 IPC 断开判断 owner 消失后复验通过；CLI 的标准 EOF 输入行为保留。并发 worktree 专项发现共享 Git 登记的 commondir 创建竞态，已通过仓库级持久互斥保护所有 worktree add。前端构建的大 chunk 提示是已有体积提示，构建成功。

多套进程故障专项同时运行曾触发测试内的 1 秒/4 秒等短超时；最终 A、B、C 顺序复验通过，保持原测试时限。推荐这些专项串行运行，避免机器负载影响短时限断言。

## 验收边界

这是可信单宿主工具的隔离与恢复能力，不是多租户 OS 沙箱。主动脱离进程组的 daemon、跨数据库共同写入、Windows、远程 worker、容器调度、ACP 和常驻 native 池没有在本阶段实现。

工作区不复制忽略文件，不支持 submodule；快照依赖 Git 与目录边界，没有防止管理员手工编辑的 immutable 标记。attention 没有自动解除操作。原生外部副作用不具备数据库事务的 exactly-once；未知执行保留现场并禁止重放。SDK 恢复成本、控制中断用量、精确 token 硬上限仍沿用未知/能力限制。

人工验收：配置账户，新建双向编码角色与已注册 Git 工作区，检查原目录无 agent 修改、独立目录实际变更、审批前无写入、Reviewer 读固定版本，以及下载补丁的 `git apply --check`。在同一聊天室继续任务时，查看“已续接完成会话”；中断后应显示恢复检查和实际 diff。
