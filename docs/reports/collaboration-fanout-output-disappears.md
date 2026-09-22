# 并行辩手发言短暂出现后消失：缺少持久聊天消息

日期：2026-09-21

状态：已修复（新运行生效）

范围：Collaboration 模式的 `ask_many` / fanout 子任务；不涉及 Coordination Plan 的结构化 Debate Runtime

## 用户现象与证据

用户在 Run `75b61adb-a790-47f1-98e4-87e3de3b1b64` 中要求 Code 和鸡腿围绕 Claude 与 ChatGPT 辩论三轮，由 Reviewer 裁判。Code 和鸡腿的正文在聊天区流式出现，生成完毕后消失。

运行记录表明，第 1、2 轮四个 fanout Dispatch 均为 `completed`，对应 Attempt 保存了四份独立正文（约 823～1173 字符），LLM Span 也记录了输出。聊天室 `messages` 表却没有这四条以辩手为发送者的消息；只有系统发给 Reviewer 的两条 `collaboration_routing` 批次汇总。界面将系统汇总折叠显示，因此用户看不到独立、常驻的辩手发言。

第 3 轮的两个 fanout Dispatch 另因并行征询超时被取消，未形成成功发言。它不是本缺口造成的，也不在此次修复范围。

## 根因

旧实现将 fanout 的直接回复或回发发起者的 handoff 转成内部结果，只写入 `collaboration_attempts.output`；该决定避免了子任务各自发布 `collaboration_result` 而导致重复最终报告。但前端仍无差别展示所有 `llm.delta`，并在 LLM Span 结束时清掉流式段落。普通 Agent 回复会随后由正式聊天消息接替，fanout 回复却没有对应消息，于是形成“先出现、后消失”。

这属于**消息呈现与持久化契约缺失**，不是第 1、2 轮模型输出丢失。此前的[重复最终报告分析](./collaboration-duplicate-final-reports.html)提出“fanout 不发布最终报告”是正确边界；本次修复保留该边界，只补充非终局的可见发言。

## 修复

1. 为每个成功完成的 fanout Dispatch 落库一条 `collaboration_contribution` 消息：正文为原始输出，发送者为实际 Agent，接收者为批次发起者，关联原征询消息，并附带 Dispatch、Batch、Attempt ID。
2. 消息创建、Attempt 完成和批次聚合仍在同一事务内；稳定的 `clientMessageId` 防止同一 Dispatch 在重试、重连或重复处理时产生多条发言。失败、取消和迟到结果不生成成功发言。
3. 前端以“协作发言”标记该类型，流式预览结束后由持久消息接替；刷新聊天室仍能加载。该类型**不是** `collaboration_result`，不增加最终报告数。
4. 模型的批次回流仍从 Attempt 读取，构造当前 Dispatch 上下文时跳过这些仅用于展示的发言，避免把同一正文连同系统汇总重复注入。默认“最近回复者”路由也跳过此类非终局发言；用户直接回复某条发言时仍可定向对应辩手。

## 验证

- `pnpm typecheck`：通过。
- `pnpm verify:collaboration`：通过；并行成员各保留独立发言，刷新后 ID 不变；仍仅有一条最终 `collaboration_result`。
- `pnpm verify:collaboration-reliability`：通过；同一 fanout 消息的稳定 ID 幂等。

历史 Run 不自动补写消息，以免把旧发言追加到裁判结论之后、改变原始时间顺序。其原文仍可从 Attempt 和折叠的批次汇总查看。第 3 轮超时应作为独立执行问题调查。
