import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDefinition, CollaborationUserDecision, CoordinationPreview, CoordinationProtocolId, Message, RunMode } from '@agent-gand/shared';
import * as api from '../../services/api';
import { useStore } from '../../store';
import { MarkdownBody } from '../Markdown';
import { WorkspacePanel } from '../WorkspacePanel';
import { SessionSidebar } from '../SessionSidebar';
import { AgentAvatar } from '../AgentAvatar';

const TYPE_LABEL: Record<string, string> = {
  assignment: '任务指派', result: '任务结果', review_request: '请求审查', review_result: '审查结论',
  revision_request: '需要修改', handoff: '工作交接', informational: '讨论',
  collaboration_result: '协作结果', collaboration_handoff: '协作交接', collaboration_question: '并行征询',
  collaboration_wait_user: '等待用户', collaboration_routing: '路由状态', collaboration_task_proposal: '正式任务提议',
};
const DELIVERY_LABEL: Record<string, string> = {
  received: '已接收', queued: '已排队', processing: '处理中', responded: '已回应', failed: '处理失败',
};

function belongsToSameVisualGroup(previous: Message | undefined, current: Message | undefined): boolean {
  if (!previous || !current) return false;
  if (previous.kind !== 'user' && previous.kind !== 'agent') return false;
  if (current.kind !== 'user' && current.kind !== 'agent') return false;
  if (previous.replyTo || current.replyTo) return false;
  return previous.from === current.from &&
    previous.runId === current.runId &&
    previous.messageType === current.messageType &&
    previous.taskId === current.taskId &&
    new Date(current.createdAt).getTime() - new Date(previous.createdAt).getTime() <= 90_000;
}

function agentName(id: string, agents: AgentDefinition[]): string {
  if (id === 'all') return '团队';
  if (id === 'user') return '你';
  if (id === 'system') return '系统';
  return id.split(',').map((part) => agents.find((agent) => agent.id === part)?.name ?? part).join('、');
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('复制失败');
}

function mentionAliases(agent: AgentDefinition): string[] {
  const plainName = agent.name.replace(/[^\p{L}\p{N}_-]+$/gu, '');
  return [...new Set([agent.id, agent.name, plainName].filter(Boolean))];
}

/** 只解析消息开头连续出现的 @，避免把正文中的普通引用误当成路由指令。 */
function leadingMentionRecipientIds(text: string, agents: AgentDefinition[], allowedIds: string[]): string[] {
  const allowed = new Set(allowedIds);
  const candidates = agents.filter((agent) => allowed.has(agent.id)).flatMap((agent) =>
    mentionAliases(agent).map((alias) => ({ alias, agentId: agent.id })),
  ).sort((left, right) => right.alias.length - left.alias.length);
  const recipients: string[] = [];
  let remaining = text.trimStart();
  while (remaining.startsWith('@')) {
    const matching = candidates.filter(({ alias }) => {
      if (!remaining.startsWith(`@${alias}`)) return false;
      const boundary = remaining.slice(alias.length + 1, alias.length + 2);
      return boundary === '' || /[\s,，:：;；、]/u.test(boundary);
    });
    const longest = matching[0]?.alias.length ?? 0;
    const ids = [...new Set(matching.filter(({ alias }) => alias.length === longest).map(({ agentId }) => agentId))];
    if (ids.length !== 1) break;
    if (!recipients.includes(ids[0]!)) recipients.push(ids[0]!);
    remaining = remaining.slice(longest + 1).replace(/^[\s,，:：;；、]+/u, '');
  }
  return recipients;
}

function combineRecipients(mentioned: string[], selected: string[]): string[] {
  return [...new Set([...mentioned, ...selected])];
}

function ReviewIssues({ message }: { message: Message }) {
  const issues = Array.isArray(message.payload?.issues) ? message.payload.issues as Array<Record<string, unknown>> : [];
  if (issues.length === 0) return null;
  return <div className="mt-3 space-y-2 border-t border-red-500/20 pt-3">
    {issues.map((issue, index) => <div key={index} className="rounded-lg bg-zinc-950/50 p-2.5 text-xs">
      <div className="flex items-center gap-2">
        <span className={issue.severity === 'blocking' ? 'text-red-300' : 'text-amber-300'}>{issue.severity === 'blocking' ? '阻塞' : '提醒'}</span>
        {(typeof issue.file === 'string' || typeof issue.line === 'number') && <code className="text-zinc-400">{String(issue.file ?? '')}{issue.line ? `:${String(issue.line)}` : ''}</code>}
      </div>
      <p className="mt-1 text-zinc-300">{String(issue.problem ?? '')}</p>
      <p className="mt-1 text-zinc-500">建议：{String(issue.suggestion ?? '')}</p>
    </div>)}
  </div>;
}

function DecisionCard({ decision }: { decision: CollaborationUserDecision }) {
  const { state, refreshConversation } = useStore();
  const room = state.conversations.find((item) => item.id === decision.conversationId);
  const proposal = decision.payload.proposal as { title?: string; goal?: string; acceptanceCriteria?: string[]; suggestedAssigneeIds?: string[]; suggestedReviewerId?: string } | undefined;
  const [answer, setAnswer] = useState('');
  const [percent, setPercent] = useState(25);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const candidates = state.agents.filter((agent) => room?.agentIds.includes(agent.id));
  const [supervisorId, setSupervisorId] = useState(candidates.find((agent) => agent.capabilities.includes('coordinate'))?.id ?? '');
  const [agentIds, setAgentIds] = useState<string[]>(room?.agentIds ?? []);
  const [reviewerId, setReviewerId] = useState(proposal?.suggestedReviewerId ?? room?.defaultReviewerId ?? '');
  async function resolve(input: Parameters<typeof api.resolveCollaborationDecision>[1]) {
    setBusy(true); setError('');
    try { await api.resolveCollaborationDecision(decision.id, input); await refreshConversation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (decision.status !== 'pending') return <div className="mt-3 rounded-lg bg-zinc-950/40 px-3 py-2 text-xs text-zinc-500">已处理：{decision.status}</div>;
  if (decision.kind === 'agent_question') return <div className="mt-3 space-y-2 rounded-xl border border-violet-500/20 bg-zinc-950/40 p-3">
    <div className="text-xs font-medium text-violet-200">Agent 正在等待你的回答</div>
    <textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={2} className="w-full rounded-lg bg-zinc-900 p-2 text-xs outline-none ring-1 ring-zinc-700 focus:ring-violet-500" />
    <button disabled={busy || !answer.trim()} onClick={() => void resolve({ action: 'answer', message: answer.trim() })} className="rounded-lg bg-violet-500 px-3 py-1.5 text-xs text-white disabled:opacity-40">回复并继续</button>
    {error && <p className="text-xs text-red-300">{error}</p>}
  </div>;
  if (decision.kind === 'budget_exhausted') return <div className="mt-3 space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
    <div className="text-xs font-medium text-amber-200">协作预算已达到上限</div>
    <div className="flex flex-wrap gap-2">{[25, 50, 100].map((value) => <button key={value} disabled={busy} onClick={() => void resolve({ action: 'increase_budget', increasePercent: value })} className="rounded bg-amber-500/15 px-2.5 py-1 text-xs text-amber-200">增加 {value}%</button>)}</div>
    <div className="flex items-center gap-2"><input type="number" min={10} max={200} value={percent} onChange={(event) => setPercent(Number(event.target.value))} className="w-20 rounded bg-zinc-900 px-2 py-1 text-xs" /><button disabled={busy || percent < 10 || percent > 200} onClick={() => void resolve({ action: 'increase_budget', increasePercent: percent })} className="rounded bg-zinc-800 px-2.5 py-1 text-xs">自定义扩容</button></div>
    <button disabled={busy} onClick={() => void resolve({ action: 'terminate_at_budget' })} className="text-xs text-zinc-400 hover:text-zinc-200">按当前部分结果终止</button>
    {error && <p className="text-xs text-red-300">{error}</p>}
  </div>;
  return <div className="mt-3 space-y-2 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3">
    <div className="text-xs font-medium text-sky-200">提议创建正式 Supervisor Task</div>
    <p className="text-xs text-zinc-300">{proposal?.title}</p>
    {proposal?.acceptanceCriteria?.length ? <ul className="list-disc pl-4 text-[11px] text-zinc-400">{proposal.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul> : null}
    <select value={supervisorId} onChange={(event) => setSupervisorId(event.target.value)} className="w-full rounded bg-zinc-900 px-2 py-1.5 text-xs"><option value="">选择主管</option>{candidates.filter((agent) => agent.capabilities.includes('coordinate')).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    <div className="flex flex-wrap gap-1">{candidates.map((agent) => <button key={agent.id} onClick={() => setAgentIds((ids) => ids.includes(agent.id) ? ids.filter((id) => id !== agent.id) : [...ids, agent.id])} className={`rounded-full px-2 py-1 text-[11px] ${agentIds.includes(agent.id) ? 'bg-sky-500/20 text-sky-200' : 'bg-zinc-900 text-zinc-500'}`}>{agent.name}</button>)}</div>
    <select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} className="w-full rounded bg-zinc-900 px-2 py-1.5 text-xs"><option value="">不设 Reviewer</option>{candidates.filter((agent) => agent.capabilities.includes('review')).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    <div className="flex gap-2"><button disabled={busy || !supervisorId || agentIds.length === 0} onClick={() => void resolve({ action: 'approve_task', supervisorId, agentIds, ...(reviewerId ? { defaultReviewerId: reviewerId } : {}) })} className="rounded bg-sky-500 px-3 py-1.5 text-xs text-white disabled:opacity-40">批准并启动</button><button disabled={busy} onClick={() => void resolve({ action: 'reject_task' })} className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400">拒绝</button></div>
    {error && <p className="text-xs text-red-300">{error}</p>}
  </div>;
}

function MessageItem({
  message,
  allMessages,
  onReply,
  groupStart,
  groupEnd,
}: {
  message: Message;
  allMessages: Message[];
  onReply: (message: Message) => void;
  groupStart: boolean;
  groupEnd: boolean;
}) {
  const { state } = useStore();
  const [copied, setCopied] = useState(false);
  const author = state.agents.find((agent) => agent.id === message.from);
  // 气泡方向由真实发送者决定，避免未来扩展 kind 后把非用户消息放到右侧。
  const mine = message.from === 'user';
  const referenced = message.replyTo ? allMessages.find((item) => item.id === message.replyTo) : undefined;
  const isReview = message.messageType === 'review_result' || message.messageType === 'revision_request';
  const verdict = typeof message.payload?.verdict === 'string' ? message.payload.verdict : null;
  const decision = state.collaborationDecisions.find((item) => item.promptMessageId === message.id);
  async function copyMessage(): Promise<void> {
    try {
      await copyText(message.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }
  if (message.kind === 'system' || message.kind === 'tool') return <div className="mx-auto max-w-3xl"><details className="rounded-lg bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500" open={Boolean(decision)}>
    <summary className="cursor-pointer">{message.kind === 'tool' ? '🔧 工具活动' : '⚙ 系统消息'} · {message.body.slice(0, 90)}</summary>
    <pre className="mt-2 whitespace-pre-wrap text-[11px] text-zinc-400">{message.body}</pre>
  </details>{decision && <DecisionCard decision={decision} />}</div>;

  const meta = <>
    <span className="font-medium" style={{ color: mine ? '#c4b5fd' : (author?.color ?? '#d4d4d8') }}>{mine ? '你' : (author?.name ?? message.from)}</span>
    {!mine && <span className="hidden text-zinc-600 sm:inline">Agent</span>}
    <span className="text-zinc-600">→ {agentName(message.to, state.agents)}</span>
    {message.messageType !== 'informational' && <span className={`rounded-full px-2 py-0.5 ${isReview ? 'bg-amber-500/15 text-amber-300' : 'bg-zinc-800 text-zinc-400'}`}>{TYPE_LABEL[message.messageType]}</span>}
    {message.taskId && <span className="hidden rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-300 sm:inline">任务 {message.taskId.slice(0, 6)}</span>}
  </>;

  const avatar = groupStart
    ? mine
      ? <AgentAvatar label="你" color="#7c3aed" className="h-9 w-9 text-sm max-[420px]:hidden" />
      : <AgentAvatar agent={author} label={message.from} className="h-9 w-9 text-sm" />
    : <div className={`h-9 w-9 shrink-0 ${mine ? 'max-[420px]:hidden' : ''}`} aria-hidden="true" />;

  return <article id={`message-${message.id}`} className={`group flex w-full items-start gap-2.5 px-3 ${groupStart ? 'pt-3' : 'pt-1'} ${groupEnd ? 'pb-3' : 'pb-1'} ${mine ? 'flex-row-reverse justify-start' : 'justify-start'}`}>
    {avatar}
    <div className={`min-w-0 ${isReview ? 'w-fit max-w-[92%] sm:max-w-[88%] md:max-w-[82%] xl:max-w-[840px]' : mine ? 'w-fit max-w-[90%] sm:max-w-[84%] md:max-w-[76%] xl:max-w-[680px]' : 'w-fit max-w-[92%] sm:max-w-[86%] md:max-w-[80%] xl:max-w-[720px]'}`}>
      {groupStart && <div className={`mb-1 flex flex-wrap items-center gap-2 text-xs ${mine ? 'justify-end' : 'justify-start'}`}>{meta}</div>}
      <div className={`relative min-w-0 overflow-hidden border px-4 py-2.5 pr-11 text-left shadow-sm ${
        mine
          ? 'rounded-2xl rounded-br-md border-violet-400/20 bg-violet-500/25 text-zinc-100'
          : isReview
            ? `${verdict === 'PASS' ? 'border-emerald-500/30' : 'border-red-500/30'} rounded-2xl rounded-bl-md bg-zinc-900 text-zinc-200`
            : 'rounded-2xl rounded-bl-md border-zinc-700/70 bg-zinc-800/90 text-zinc-200'
      }`}>
        <button type="button" onClick={() => void copyMessage()} aria-label={copied ? '已复制消息' : '复制消息内容'} title={copied ? '已复制' : '复制'}
          className={`absolute right-2 top-2 rounded-md px-2 py-1 text-[11px] transition ${copied ? 'bg-emerald-500/15 text-emerald-300 opacity-100' : 'bg-black/20 text-zinc-400 opacity-70 hover:bg-black/35 hover:text-zinc-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'}`}>
          {copied ? '已复制' : '⧉'}
        </button>
        {referenced && <button onClick={() => document.getElementById(`message-${referenced.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          className="mb-2 block w-full truncate rounded-lg border-l-2 bg-zinc-950/30 px-3 py-2 text-left text-xs text-zinc-400"
          style={{ borderColor: state.agents.find((item) => item.id === referenced.from)?.color ?? '#71717a' }}>
          回复 {agentName(referenced.from, state.agents)}：{referenced.body.slice(0, 100)}
        </button>}
        {isReview && verdict && <div className={`mb-1 text-xs font-medium ${verdict === 'PASS' ? 'text-emerald-300' : 'text-red-300'}`}>{verdict === 'PASS' ? '✓ 审查通过' : '✗ 审查未通过'}</div>}
        <div className="[overflow-wrap:anywhere] text-sm leading-6"><MarkdownBody text={message.body} /></div>
        <ReviewIssues message={message} />
        {decision && <DecisionCard decision={decision} />}
      </div>
      {groupEnd && <div className={`mt-1 flex items-center gap-2 text-[11px] text-zinc-600 ${mine ? 'justify-end' : 'justify-start'}`}>
        <time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
        {mine && message.deliveryStatus && <span className={message.deliveryStatus === 'failed' ? 'text-red-300' : ''}>{DELIVERY_LABEL[message.deliveryStatus] ?? message.deliveryStatus}</span>}
        <button onClick={() => onReply(message)} className="opacity-0 hover:text-violet-300 group-hover:opacity-100 group-focus-within:opacity-100">回复</button>
      </div>}
    </div>
  </article>;
}

function StreamingItem({ spanId, text }: { spanId: string; text: string }) {
  const { state } = useStore();
  const span = state.events.find((event) => event.id === spanId);
  const parent = span?.parentId ? state.events.find((event) => event.id === span.parentId) : undefined;
  const rawId = parent?.name.startsWith('agent:') ? parent.name.slice(6).split('（')[0] : '';
  const agent = state.agents.find((item) => item.id === rawId);
  return <div className="flex gap-3 rounded-xl px-3 py-3">
    <AgentAvatar agent={agent} className="h-9 w-9 animate-pulse text-sm" />
    <div className="max-w-3xl rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 px-4 py-3">
      <p className="mb-1 text-xs text-zinc-500">{agent?.name ?? 'Agent'} 正在回复…</p>
      <div className="text-sm text-zinc-400"><MarkdownBody text={text} /><span className="animate-pulse">▍</span></div>
    </div>
  </div>;
}

function NewRoomComposer() {
  const { state, setActiveConversation } = useStore();
  const [goal, setGoal] = useState('');
  const [modeChoice, setModeChoice] = useState<'auto' | RunMode>('auto');
  const [selected, setSelected] = useState<string[]>(state.agents.map((agent) => agent.id));
  const [initialTargets, setInitialTargets] = useState<string[]>([]);
  const initialized = useRef(state.agents.length > 0);
  const [supervisorId, setSupervisorId] = useState(state.agents.find((agent) => agent.capabilities.includes('coordinate'))?.id ?? '');
  const [defaultReviewerId, setDefaultReviewerId] = useState(state.agents.find((agent) => agent.capabilities.includes('review'))?.id ?? '');
  const [workspace, setWorkspace] = useState('');
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planPreview, setPlanPreview] = useState<CoordinationPreview | null>(null);
  const [error, setError] = useState('');
  const mentionedTargets = useMemo(() => leadingMentionRecipientIds(goal, state.agents, selected), [goal, state.agents, selected]);
  const effectiveTargets = useMemo(() => combineRecipients(mentionedTargets, initialTargets), [mentionedTargets, initialTargets]);
  const mode = modeChoice === 'auto' ? planPreview?.draft.runtimeMode ?? null : modeChoice;
  useEffect(() => {
    if (!initialized.current && state.agents.length > 0) { setSelected(state.agents.map((agent) => agent.id)); initialized.current = true; }
    if (!state.agents.some((agent) => agent.id === supervisorId && agent.capabilities.includes('coordinate'))) setSupervisorId(state.agents.find((agent) => agent.capabilities.includes('coordinate'))?.id ?? '');
    if (!state.agents.some((agent) => agent.id === defaultReviewerId && agent.capabilities.includes('review'))) setDefaultReviewerId(state.agents.find((agent) => agent.capabilities.includes('review'))?.id ?? '');
  }, [state.agents, supervisorId, defaultReviewerId]);
  useEffect(() => { setPlanPreview(null); setError(''); }, [goal, selected, defaultReviewerId]);
  async function preview(requestedProtocol?: CoordinationProtocolId): Promise<CoordinationPreview | null> {
    if (!goal.trim() || selected.length === 0 || planning) return null;
    setPlanning(true); setError('');
    try {
      const result = await api.previewCoordination({ goal: goal.trim(), agentIds: selected,
        ...(selected.includes(defaultReviewerId) ? { defaultReviewerId } : {}), ...(requestedProtocol ? { requestedProtocol } : {}) });
      setPlanPreview(result);
      return result;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return null; }
    finally { setPlanning(false); }
  }
  async function create() {
    if (!goal.trim() || selected.length === 0 || busy) return;
    if (effectiveTargets.length > 3) return;
    let activePreview = planPreview;
    if (modeChoice === 'auto' && !activePreview) {
      activePreview = await preview();
      if (!activePreview || activePreview.draft.decision !== 'auto_start') return;
    }
    if (modeChoice === 'auto' && activePreview?.draft.decision === 'clarify') { setError('请先回答计划卡中的关键问题。'); return; }
    if (modeChoice === 'auto' && activePreview?.draft.decision === 'unavailable') { setError('当前建议未通过安全校验，请调整团队或任务约束。'); return; }
    const effectiveMode = modeChoice === 'auto' ? activePreview?.draft.runtimeMode ?? null : modeChoice;
    if (!effectiveMode) { setError('当前建议使用的协议尚未接入统一协调运行时。你可以调整任务或切换为手动协作方式。'); return; }
    setBusy(true);
    setError('');
    try {
      const created = await api.createConversation({ goal: goal.trim(), mode: effectiveMode, agentIds: selected,
        ...(effectiveMode === 'collaboration' && effectiveTargets.length > 0 ? { recipientIds: effectiveTargets.filter((id) => selected.includes(id)) } : {}),
        ...(effectiveMode === 'supervisor' && selected.includes(supervisorId) ? { supervisorId } : {}),
        ...(selected.includes(defaultReviewerId) ? { defaultReviewerId } : {}),
        ...(modeChoice === 'auto' && activePreview ? { coordinationDraftId: activePreview.draft.id } : {}),
        ...(workspace ? { workspace } : {}) });
      setActiveConversation(created.conversation.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <div className="mx-auto flex h-full max-w-3xl flex-col justify-center px-6">
    <div className="mb-6 text-center"><h2 className="text-xl font-semibold text-zinc-100">创建 Agent 聊天室</h2><p className="mt-2 text-sm text-zinc-500">选择团队与协作方式，之后可在同一房间继续交流。</p></div>
    <textarea id="goal-input" value={goal} onChange={(event) => setGoal(event.target.value)} rows={5} placeholder="描述希望团队完成的目标…"
      className="resize-none rounded-2xl bg-zinc-900 p-4 text-sm outline-none ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:ring-violet-500" />
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <select value={modeChoice} onChange={(event) => { setModeChoice(event.target.value as 'auto' | RunMode); setPlanPreview(null); }} className="rounded-lg bg-zinc-800 px-3 py-2"><option value="auto">✨ 智能匹配</option><option value="collaboration">自由协作</option><option value="supervisor">主管委派</option><option value="pipeline">顺序流水线</option></select>
      {mode === 'supervisor' && <select value={supervisorId} onChange={(event) => setSupervisorId(event.target.value)} className="rounded-lg bg-zinc-800 px-3 py-2">{state.agents.filter((agent) => selected.includes(agent.id) && agent.capabilities.includes('coordinate')).map((agent) => <option key={agent.id} value={agent.id}>主管：{agent.name}</option>)}</select>}
      <select value={defaultReviewerId} onChange={(event) => setDefaultReviewerId(event.target.value)} className="rounded-lg bg-zinc-800 px-3 py-2"><option value="">不设默认评审</option>{state.agents.filter((agent) => selected.includes(agent.id) && agent.capabilities.includes('review')).map((agent) => <option key={agent.id} value={agent.id}>评审：{agent.name}</option>)}</select>
      <button onClick={() => setWorkspaceOpen(true)} className="rounded-lg bg-zinc-800 px-3 py-2 text-zinc-400">🗂 {workspace || '自动创建房间工作区'} ▾</button>
      {state.agents.map((agent) => <button key={agent.id} onClick={() => setSelected((items) => items.includes(agent.id) ? items.filter((id) => id !== agent.id) : [...items, agent.id])}
        className="rounded-full px-3 py-1.5" style={{ color: selected.includes(agent.id) ? agent.color : '#71717a', backgroundColor: selected.includes(agent.id) ? `${agent.color}20` : 'transparent' }}>{agent.name}</button>)}
      <button disabled={busy || planning || !goal.trim() || selected.length === 0 || (modeChoice === 'auto' && Boolean(planPreview) && (!mode || planPreview?.draft.decision === 'clarify' || planPreview?.draft.decision === 'unavailable'))} onClick={() => void create()} className="ml-auto rounded-lg bg-violet-500 px-5 py-2 font-medium text-white disabled:opacity-40">{planning ? '正在分析…' : busy ? '正在创建…' : modeChoice === 'auto' && !planPreview ? '智能规划并开始' : modeChoice === 'auto' && planPreview?.draft.decision === 'auto_start' ? '自动开始' : modeChoice === 'auto' ? '确认并开始' : '创建并发送'}</button>
    </div>
    {modeChoice === 'auto' && planPreview && <div className={`mt-3 rounded-2xl border p-4 text-sm ${planPreview.draft.validationErrors.length > 0 ? 'border-amber-500/30 bg-amber-500/5' : 'border-violet-500/30 bg-violet-500/5'}`}>
      <div className="flex items-start gap-3"><div className="mt-0.5 rounded-lg bg-violet-500/15 px-2 py-1 text-violet-200">{planPreview.draft.decision === 'auto_start' ? '可自动开始' : planPreview.draft.decision === 'clarify' ? '需要确认' : planPreview.draft.decision === 'unavailable' ? '暂不可用' : '推荐'}</div><div className="min-w-0 flex-1"><div className="font-medium text-zinc-100">{planPreview.draft.displayName}</div><p className="mt-1 text-xs text-zinc-400">{planPreview.draft.summary}</p><div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500"><span>置信度 {Math.round(planPreview.draft.platformConfidence * 100)}%</span><span>风险：{planPreview.draft.risk === 'low' ? '低' : planPreview.draft.risk === 'medium' ? '中' : '高'}</span><span>{planPreview.snapshot.agents.length} 位 Agent</span><span>{planPreview.plan.steps.length} 个计划步骤</span></div></div></div>
      {planPreview.notices?.map((notice) => <div key={notice} className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">⚠ {notice}</div>)}
      {planPreview.draft.clarificationQuestion && <div className="mt-3 rounded-xl bg-zinc-950/50 p-3 text-xs text-zinc-200"><p>{planPreview.draft.clarificationQuestion}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" onClick={() => void preview('parallel_fanout')} className="rounded-full bg-violet-500/20 px-3 py-1.5 text-violet-200">各自分析后汇总</button><button type="button" onClick={() => void preview('dynamic_collaboration')} className="rounded-full bg-zinc-800 px-3 py-1.5 text-zinc-300">共同讨论</button></div></div>}
      {planPreview.draft.validationIssues.some((item) => item.severity === 'error') && <div className="mt-3 rounded-lg bg-zinc-950/50 px-3 py-2 text-xs text-amber-200">{planPreview.draft.validationIssues.filter((item) => item.severity === 'error').map((item) => item.message).join('；')}</div>}
      {!planPreview.draft.runtimeMode && planPreview.draft.validationErrors.length === 0 && <div className="mt-3 rounded-lg bg-zinc-950/50 px-3 py-2 text-xs text-amber-200">计划已通过结构校验，但对应协议尚未接入统一协调运行时。</div>}
      {planPreview.draft.decision !== 'clarify' && planPreview.draft.alternatives.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs"><span className="text-zinc-500">也可以：</span>{planPreview.draft.alternatives.map((alternative) => <button key={alternative.displayName} type="button" title={alternative.suitableWhen} onClick={() => void preview(alternative.protocols[0]?.protocol)} className="rounded-full bg-zinc-800 px-3 py-1.5 text-zinc-300 hover:bg-zinc-700">{alternative.displayName}</button>)}</div>}
      <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer hover:text-zinc-200">查看计划</summary><ol className="mt-2 space-y-1 pl-4">{planPreview.plan.steps.map((step) => <li key={step.id}>{step.id} · {step.completion}</li>)}</ol></details>
      <button type="button" onClick={() => { setPlanPreview(null); setError(''); }} className="mt-3 text-xs text-zinc-500 hover:text-zinc-300">重新分析</button>
    </div>}
    {error && <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
    {mode === 'collaboration' && <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-xs"><div className="mb-2 text-zinc-500">初始发送对象（可点选或在消息开头输入 @名称，最多 3 位；不选则发送给最近回复者）</div><div className="flex flex-wrap gap-2">{state.agents.filter((agent) => selected.includes(agent.id)).map((agent) => <button key={agent.id} onClick={() => setInitialTargets((ids) => ids.includes(agent.id) ? ids.filter((id) => id !== agent.id) : ids.length < 3 ? [...ids, agent.id] : ids)} className={`rounded-full px-3 py-1.5 ${effectiveTargets.includes(agent.id) ? 'bg-violet-500/20 text-violet-200 ring-1 ring-violet-500/40' : 'bg-zinc-800 text-zinc-500'}`}>{agent.name}</button>)}</div>{effectiveTargets.length > 3 && <p className="mt-2 text-red-300">发送对象超过 3 位，请减少点选或 @ 对象。</p>}</div>}
    <WorkspacePanel open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} current={workspace} onSelect={setWorkspace} goal={goal} />
  </div>;
}

function RoomComposer({ onReplyClear, reply }: { reply: Message | null; onReplyClear: () => void }) {
  const { state, refreshConversation } = useStore();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recipients, setRecipients] = useState<string[]>([]);
  const room = state.conversations.find((item) => item.id === state.activeConversationId);
  const mentionedRecipients = useMemo(() => leadingMentionRecipientIds(text, state.agents, room?.agentIds ?? []), [text, state.agents, room?.agentIds]);
  const effectiveRecipients = useMemo(() => combineRecipients(mentionedRecipients, recipients), [mentionedRecipients, recipients]);
  const replyDecision = reply ? state.collaborationDecisions.find((item) => item.promptMessageId === reply.id && item.status === 'pending') : undefined;
  async function send() {
    if (!room || !text.trim() || busy) return;
    if (effectiveRecipients.length > 3) { setError('发送对象超过 3 位，请减少点选或 @ 对象。'); return; }
    const body = text.trim();
    setBusy(true); setError('');
    try {
      if (replyDecision?.kind === 'agent_question') await api.resolveCollaborationDecision(replyDecision.id, { action: 'answer', message: body });
      else await api.sendConversationMessage(room.id, { body, ...(effectiveRecipients.length > 0 ? { recipientIds: effectiveRecipients } : {}), replyTo: reply?.id ?? null,
          taskId: reply?.taskId ?? null, clientMessageId: crypto.randomUUID() });
      setText(''); setRecipients([]); onReplyClear(); await refreshConversation();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  if (!room) return null;
  return <div className="shrink-0 border-t border-zinc-800 bg-zinc-950/90 p-3">
    <div className="mx-auto max-w-3xl rounded-2xl bg-zinc-900 ring-1 ring-zinc-700 focus-within:ring-violet-500">
      {reply && <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2 text-xs text-zinc-500"><span className="min-w-0 flex-1 truncate">{replyDecision?.kind === 'agent_question' ? '回答并恢复本轮' : `回复 ${agentName(reply.from, state.agents)}`}：{reply.body}</span><button onClick={onReplyClear}>×</button></div>}
      {room.mode === 'collaboration' && <div className="flex flex-wrap gap-1 border-b border-zinc-800 px-4 py-2">{room.agentIds.map((id) => { const agent = state.agents.find((item) => item.id === id); return <button key={id} onClick={() => setRecipients((items) => items.includes(id) ? items.filter((item) => item !== id) : items.length < 3 ? [...items, id] : items)} className={`rounded-full px-2 py-1 text-[11px] ${effectiveRecipients.includes(id) ? 'bg-violet-500/20 text-violet-200' : 'bg-zinc-800 text-zinc-500'}`}>@{agent?.name ?? id}</button>; })}</div>}
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} placeholder="发送消息；可选择最多 3 位 Agent，Shift+Enter 换行"
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
        className="w-full resize-none bg-transparent px-4 pt-3 text-sm outline-none placeholder:text-zinc-600" />
      <div className="flex items-center gap-2 px-4 pb-3 text-xs">
        {effectiveRecipients.length > 0 ? <span className={effectiveRecipients.length > 3 ? 'text-red-300' : 'text-violet-300'}>{effectiveRecipients.length > 1 ? '并行发送给 ' : '发送给 '}{effectiveRecipients.map((id) => agentName(id, state.agents)).join('、')}</span> : <span className="text-zinc-600">{room.mode === 'collaboration' ? '发送给最近回复者' : '发送给团队，由编排器协调'}</span>}
        {error && <span className="truncate text-red-300">{error}</span>}
        <button onClick={() => void send()} disabled={!text.trim() || busy} className="ml-auto rounded-lg bg-violet-500 px-4 py-1.5 text-white disabled:opacity-40">{busy ? '发送中…' : '发送'}</button>
      </div>
    </div>
  </div>;
}

export function RunView() {
  const { state, setActiveConversation, refreshConversation } = useStore();
  const [collapsed, setCollapsed] = useState(false);
  const [reply, setReply] = useState<Message | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const room = state.conversations.find((item) => item.id === state.activeConversationId);
  const roomRuns = useMemo(() => state.runs.filter((run) => run.conversationId === room?.id).sort((a, b) => a.turnNo - b.turnNo), [state.runs, room?.id]);
  const activeRun = roomRuns.at(-1);
  useEffect(() => { const element = scrollRef.current; if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 220) element.scrollTop = element.scrollHeight; }, [state.messages.length, Object.values(state.streams).join('').length]);
  async function archiveRoom() {
    if (!room || !window.confirm(`归档聊天室“${room.title}”？历史运行和证据仍会保留。`)) return;
    await api.archiveConversation(room.id);
    setActiveConversation(null);
  }
  // AG-COORD-04：审批暂停中的 Coordination run 显式恢复/取消
  async function resumePausedRun() {
    if (!activeRun) return;
    try { await api.resumeCoordinationRun(activeRun.id); await refreshConversation(); }
    catch (reason) { window.alert(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function cancelPausedRun() {
    if (!activeRun || !window.confirm('取消本次运行？已冻结的产物会保留，运行不可恢复。')) return;
    try { await api.cancelCoordinationRun(activeRun.id); await refreshConversation(); }
    catch (reason) { window.alert(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div className="flex h-full">
    <SessionSidebar collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} activeConversationId={state.activeConversationId}
      onSelect={setActiveConversation} onNewSession={() => setActiveConversation(null)} />
    <div className="flex min-w-0 flex-1 flex-col">
      {!room ? <NewRoomComposer /> : <>
        <header className="shrink-0 border-b border-zinc-800 bg-zinc-950/80 px-5 py-3">
          <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium text-zinc-100">{room.title}</h2><p className="mt-1 text-[11px] text-zinc-500">{state.coordinationPlan ? '智能匹配' : room.mode === 'supervisor' ? `主管：${agentName(room.supervisorId ?? '', state.agents)}` : room.mode === 'collaboration' ? '自由协作' : '顺序流水线'} · 第 {activeRun?.turnNo ?? room.runCount} 轮 · {activeRun?.status === 'running' ? '团队正在协作' : activeRun?.status === 'pending' ? '已排队' : activeRun?.status === 'waiting_for_user' ? '等待你的决定' : activeRun?.status === 'completed' ? '本轮已完成' : activeRun?.status ?? '空闲'} · 🗂 {room.workspace}</p></div>
            <div className="flex -space-x-2">{room.agentIds.map((id) => { const agent = state.agents.find((item) => item.id === id); return <AgentAvatar key={id} agent={agent} label={id} className="h-8 w-8 border-2 border-zinc-950 text-xs" />; })}</div>
            <button onClick={() => void archiveRoom()} className="rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300" title="归档聊天室">•••</button>
          </div>
          {state.scheduler && <div className="mt-2 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full animate-pulse rounded bg-violet-500" style={{ width: `${Math.max(20, 100 * state.scheduler.active / Math.max(1, state.scheduler.active + state.scheduler.queued))}%` }} /></div>}
          {state.collaborationScheduler && <div className="mt-2 flex gap-3 text-[10px] text-zinc-500"><span>活跃 Agent {state.collaborationScheduler.activeAgentIds.length}</span><span>排队 {state.collaborationScheduler.queued}</span>{state.collaborationScheduler.blocked > 0 && <span className="text-amber-300">阻断 {state.collaborationScheduler.blocked}</span>}</div>}
        </header>
        {activeRun?.status === 'waiting_for_user' && state.coordinationPlan?.status === 'paused' && <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-5 py-3 text-xs text-amber-200">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">⏸ 审批连续超时，本轮运行已暂停；处理完右侧审批卡后可恢复，或直接取消。</span>
            <button onClick={() => void resumePausedRun()} className="rounded-lg bg-amber-400/90 px-3 py-1.5 font-medium text-zinc-900">恢复运行</button>
            <button onClick={() => void cancelPausedRun()} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-zinc-300">取消运行</button>
          </div>
        </div>}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto max-w-4xl space-y-1">
            {state.messages.map((message, index) => {
              const run = roomRuns.find((item) => item.id === message.runId);
              const showDivider = index === 0 || state.messages[index - 1]?.runId !== message.runId;
              return <div key={message.id}>
                {showDivider && run && <div className="my-5 flex items-center gap-3 text-[11px] text-zinc-600"><span className="h-px flex-1 bg-zinc-800" /><span>第 {run.turnNo} 轮 · {run.status === 'pending' ? '等待执行' : run.status === 'running' ? '进行中' : run.status === 'waiting_for_user' ? '等待你的决定' : run.status === 'completed' ? '已完成' : run.status}</span><span className="h-px flex-1 bg-zinc-800" /></div>}
                <MessageItem
                  message={message}
                  allMessages={state.messages}
                  onReply={setReply}
                  groupStart={!belongsToSameVisualGroup(state.messages[index - 1], message)}
                  groupEnd={!belongsToSameVisualGroup(message, state.messages[index + 1])}
                />
              </div>;
            })}
            {Object.entries(state.streams).map(([id, text]) => <StreamingItem key={id} spanId={id} text={text} />)}
            {state.messages.length === 0 && <p className="pt-20 text-center text-sm text-zinc-600">聊天室已创建，等待团队消息…</p>}
          </div>
        </div>
        <RoomComposer reply={reply} onReplyClear={() => setReply(null)} />
      </>}
    </div>
  </div>;
}
