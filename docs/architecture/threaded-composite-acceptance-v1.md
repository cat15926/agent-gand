# 持续协作综合验收与发布审查 v1

状态：RC10 验收资产已建立，完整发布门槛未满足。日期：2026-10-27。以 [RC10 报告](../reports/threaded-collaboration-rc10-release-review-2026-10-27.md)、[兼容矩阵](../plans/threaded-collaboration-compatibility-matrix.md)和[剩余计划](../plans/threaded-collaboration-remaining-plan.md)记录当前结果。schema 35、日常 closed 不变。

## 合同与证据层级

验收场景使用有限步骤保证可重复观测；产品仍按普通消息、权限、来源、持久事实与预算规则运行，不能把这条测试脚本作为固定业务流程替代 K01–K16。验收顺序为：A 在原 Thread 公开交给 B；B 在有权限的工作 Thread 征询 C/D；保留 C 原答及 D 的失败/到期状态；恢复后唯一通知 B；独立评审要求修订；原作者逐 finding 响应并申请新 HEAD；独立复审完成责任与 gate；B 将结果显式发回原 Thread。

同一 causal root 贯穿公开接力、跨 Thread、征询、回调、Action 和修订。Action 的 canonical identity、home Thread、冻结 predecessor 及代际规则不变。不得用新的用户触发根、另一 Thread 重建 Action、清空预算、复用旧 gate 或作者自证代替修订。

证据分层独立：

1. 工厂/注入链：生产 broker、SQLite、领域服务与独立恢复 PID；模型/PR 响应注入。旧代际 callback、权限变化、预算耗尽与 SQL/outbox 失败在这一层分别断言。
2. 实际入口/注入链：真实 `index.ts` 进程、生产 singleton、release pack/grant、认证 HTTP 和实际 SDK 守护进程；供应商响应仍注入。
3. 实际入口/真实模型链：复用同一 runner，选定配置账号发出真实 API/SDK 请求；PR 身份/HEAD、测试时钟及调度屏障仍注入，必须逐项标注。
4. 自然远端业务：真实 PR 事件、代码事实与当前来源权限。本轮第 3 层不能替代 RC04 未观察到的两个自然 HEAD，也不能授予 GitHub approval/merge。
5. 旧模式共存回归与文档审查：分别计数；负例审计、重复跑和检查点不叠加为产品测试组数。

所有通过的整链必须留存精确来源、原答、callback/message/wake/queue/outbox、review report 与 revision attestation、独立 finding resolution、Action completion 和 gate。只出现“完成”文本不构成通过；空 finding 集合不能满足逐项修订。安全拒绝是有效负向结果，不等于正向业务链通过。

## 隔离测试根政策

实际 index 通过显式 Owner CAS 调整合成根：Invocation 上限20→30、A2A深度15→25、根货币预算上限5→100美元、活动片1→10秒、未知费用策略stop→每请求预留1美元。这是应用内保守预算策略，不是实际供应商费用结算；共享外部token账本另受100万累计门禁约束。所有原版本和新版本留在报告budgetVersions/finalAudit，额度调整不删除累计用量。生产默认保持不变，这些证据不能证明默认政策下完整链通过。

## 真实运行护栏

真实运行显式要求 `--authorized-real --account <configured-id> --token-ledger <original-file>`。仅用户已授权的账号可用；使用原共享账本，不新建干净账本、删除 unknown 或退款预留。预设内部累计门禁为 100 万 token；数值不得超过用户原授权的 1000 万，本地测试屏障放行后、真实发送前依精确 request body hash 原子保守预留，可信完整回执才能转 known。货币费用与 token 用量分开。

日常账号配置只读打开，密钥通过私密 IPC 注入隔离进程，临时加密副本使用仅在本轮父/子进程内存中保留的密钥，父进程保留以供同轮重启。供应商只能访问选定 HTTPS origin 的 Messages/Count Tokens POST，禁止重定向和其他外联。GitHub GET 完全注入，不读取真实 GitHub 凭据，不允许远端写入。工具报错后阻止后续供应商外呼，保留原失败和账本。

服务结束时仅处理有本轮 token/宿主/路径身份的守护进程组；停止与请求用量分别记账。删除临时库前固定白名单导出最终安全事实，包括失败/unknown；账号、凭据、管理会话和原生聊天历史不导出。历史报告不能被后一次成功覆盖。

## 重跑方式

默认工厂证据采用排他创建；重跑指定新的输出文件：

```sh
THREADED_RC10_CHAIN_OUTPUT=/tmp/rc10-chain-rerun.json pnpm verify:threaded-rc10-chain
pnpm verify:threaded-rc10-main --report /tmp/rc10-index-injected-rerun.json
pnpm audit:threaded-rc10-acceptance --output /tmp/rc10-acceptance-audit.json
pnpm audit:threaded-rc10-main-chain --input /tmp/rc10-index-injected-rerun.json --output /tmp/rc10-chain-link-audit.json
```

实际入口验收需要本机回环端口与受管进程身份检查。真实模式另需已授权账号和原账本参数，不能把示例作为新费用授权。原文审查固定 RC09 `915f106316863f8f681ad891421be3f4ca53cc0b` 和历史提取 SHA256 `7c0b897370f11707c6204bbf954a1ba0e6efd9df76863815750af55eb63e952e`；原 K16/59 场景预期、E 合同不可改写。

## 发布退出

每个验收 ID 保留实现、隔离通过、真实通过、失败或未验证及证据链接。核心合同不简化，平台差异显式登记，新增可靠性独立验收，高级能力逐项说明范围。MEM01 语义子项未实现时整项未完成。具名阻断没有完成之前，RC10 保持“验收资产交付，完整退出未通过”；不自动执行 RC11/RC12，不启用日常持续调度。
