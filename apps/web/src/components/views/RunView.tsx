import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentDefinition, CollaborationUserDecision, ExternalWorkspaceBinding, Message } from '@agent-gand/shared';
import * as api from '../../services/api';
import { useStore } from '../../store';
import { MarkdownBody } from '../Markdown';
import { TaskComposer } from '../TaskComposer';
import { TaskCard } from '../TaskCard';
import { SessionSidebar } from '../SessionSidebar';
import { AgentAvatar } from '../AgentAvatar';
import { ChatScrollController } from '../../chatScroll';

const TYPE_LABEL: Record<string, string> = {
  assignment: '任务指派', result: '任务结果', review_request: '请求审查', review_result: '审查结论',
  revision_request: '需要修改', handoff: '工作交接', informational: '讨论',
  collaboration_result: '协作结果', collaboration_contribution: '协作发言', collaboration_handoff: '协作交接', collaboration_question: '并行征询',
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

function RunWorkspaceCard({ runId, revision }: { runId: string; revision: string }) {
  const [binding, setBinding] = useState<ExternalWorkspaceBinding | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setBinding(null); setError('');
    void api.getRunWorkspace(runId).then((value) => { if (live) setBinding(value); }).catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [runId, revision]);
  if (error) return <p className="mt-2 text-xs text-amber-300">工作区信息获取失败：{error}</p>;
  if (!binding) return null;
  return <div className="mt-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-xs text-zinc-400">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sky-200">{binding.status === 'ready' ? '隔离编码工作区' : binding.status === 'preparing' ? '正在准备隔离工作区' : '工作区需要检查'}</span>
      {binding.latestSnapshot && <a href={`/api/runs/${encodeURIComponent(runId)}/workspace/patch`} download className="rounded bg-sky-500/15 px-2 py-1 text-sky-200 hover:bg-sky-500/25">下载变更补丁</a>}
    </div>
    <p className="mt-1">变更保存在独立工作区；下载补丁后可在原仓库检查并应用。</p>
    <details className="mt-1"><summary className="cursor-pointer">查看目录与快照</summary><p className="mt-1 break-all">原仓库：{binding.sourceRoot}</p><p className="mt-1 break-all">编码目录：{binding.cwd}</p>{binding.latestSnapshot && <p className="mt-1 break-all">快照：{binding.latestSnapshot.commit}</p>}</details>
    {binding.error && <p className="mt-1 whitespace-pre-wrap text-amber-300">{binding.error}</p>}
  </div>;
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

export function RunView({ onManageRoles }: { onManageRoles?: () => void }) {
  const { state, setActiveConversation } = useStore();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [reply, setReply] = useState<Message | null>(null);
  const [taskStates, setTaskStates] = useState<api.TaskState[]>([]);
  const [reservations, setReservations] = useState<api.MemberReservation[]>([]);
  const [revisionTask, setRevisionTask] = useState<api.TaskState | null>(null);
  const [taskStateError, setTaskStateError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollControllerRef = useRef<ChatScrollController | null>(null);
  if (!scrollControllerRef.current) scrollControllerRef.current = new ChatScrollController();
  const room = state.conversations.find((item) => item.id === state.activeConversationId);
  const roomRuns = useMemo(() => state.runs.filter((run) => run.conversationId === room?.id).sort((a, b) => a.turnNo - b.turnNo), [state.runs, room?.id]);
  const activeRun = roomRuns.find(item => item.id === state.activeRunId) ?? roomRuns.at(-1);
  useEffect(() => { const media = window.matchMedia('(max-width: 767px)'); const change = () => setCollapsed(media.matches); media.addEventListener('change',change); return () => media.removeEventListener('change',change); }, []);
  useEffect(() => { setReply(null); setRevisionTask(null); setTaskStates([]); }, [room?.id]);
  useEffect(() => {
    let live = true; let pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const [members,tasks] = await Promise.all([api.getMemberReservations(), room ? api.getTaskStates(room.id) : Promise.resolve({ tasks: [] })]);
        if (live) { setReservations(members.reservations); setTaskStates(tasks.tasks); setTaskStateError(''); }
      } catch (reason) { if (live) setTaskStateError(reason instanceof Error ? reason.message : String(reason)); }
      finally { pending = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(),2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [room?.id, state.runs, state.approvals]);
  const streamLength = Object.values(state.streams).reduce((length, text) => length + text.length, 0);
  useLayoutEffect(() => {
    scrollControllerRef.current?.sync(state.activeConversationId, scrollRef.current);
  }, [state.activeConversationId, state.messages.length, streamLength]);
  async function archiveRoom() {
    if (!room || !window.confirm(`归档聊天室“${room.title}”？历史运行和证据仍会保留。`)) return;
    await api.archiveConversation(room.id);
    setActiveConversation(null);
  }
  return <div className="flex h-full min-w-0">
    <SessionSidebar collapsed={collapsed} onToggleCollapse={() => setCollapsed((value) => !value)} activeConversationId={state.activeConversationId}
      onSelect={setActiveConversation} onNewSession={() => setActiveConversation(null)} />
    <div className="flex min-w-0 flex-1 flex-col">
      {!room ? <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"><TaskComposer key="new-room" reservations={reservations} onManageRoles={onManageRoles} /></div> : <>
        <header className="shrink-0 border-b border-zinc-800 bg-zinc-950/80 px-5 py-3">
          <div className="flex items-center gap-3"><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium text-zinc-100">{room.title}</h2><p className="mt-1 text-[11px] text-zinc-500">候选团队 {room.agentIds.length} 位 · {roomRuns.length} 个任务 · 房间默认偏好用于新任务</p></div>
            <div className="hidden -space-x-2 lg:flex">{room.agentIds.map((id) => { const agent = state.agents.find((item) => item.id === id); return <AgentAvatar key={id} agent={agent} label={id} className="h-8 w-8 border-2 border-zinc-950 text-xs" />; })}</div>
            <button onClick={() => void archiveRoom()} className="rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300" title="归档聊天室">•••</button>
          </div>
          {state.scheduler && <div className="mt-2 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full animate-pulse rounded bg-violet-500" style={{ width: `${Math.max(20, 100 * state.scheduler.active / Math.max(1, state.scheduler.active + state.scheduler.queued))}%` }} /></div>}
          {state.collaborationScheduler && <div className="mt-2 flex gap-3 text-[10px] text-zinc-500"><span>活跃 Agent {state.collaborationScheduler.activeAgentIds.length}</span><span>排队 {state.collaborationScheduler.queued}</span>{state.collaborationScheduler.blocked > 0 && <span className="text-amber-300">阻断 {state.collaborationScheduler.blocked}</span>}</div>}
          {activeRun?.workspace?.startsWith('ext:') && <RunWorkspaceCard key={activeRun.id} runId={activeRun.id} revision={`${activeRun.status}:${state.executions.filter((item) => item.runId === activeRun.id).map((item) => `${item.id}:${item.status}:${item.snapshot?.commit ?? ''}`).join(',')}:${state.messages.length}`} />}
          {state.executions.filter((item) => item.runId === activeRun?.id).map((item) => <details key={item.id} className="mt-2 rounded-lg bg-zinc-900 px-3 py-2 text-xs text-zinc-400">
            <summary className="cursor-pointer">{agentName(item.agentId, state.agents)} · {item.driver} · {item.permissionMode === 'confirm' ? '需确认' : item.permissionMode === 'auto' ? '白名单自动' : '只读'} · {{ running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', interrupted: '已中断' }[item.status]}</summary>
            <p className="mt-2 break-all">版本：{item.driverVersion ?? '未检测'} · 工作区：{item.cwd}</p>
            <p className="mt-1 break-all">会话：{item.sessionId ?? '尚未绑定'}</p>
            {item.sessionMode && <p className="mt-1">{item.sessionMode === 'resume' ? '已续接完成会话' : '已建立新会话'} · {item.sessionReason}</p>}
            {item.snapshot && <p className="mt-1 break-all">固定审查快照：{item.snapshot.commit}</p>}
            {item.recovery && <p className={`mt-1 ${item.recovery.state === 'attention' ? 'text-amber-300' : 'text-zinc-400'}`}>恢复检查：{item.recovery.reason}</p>}
            {item.controlAction && <p className="mt-1">已提交协作动作：{item.controlAction.type}{item.exitCorrectionAttempts ? ` · 纠偏 ${item.exitCorrectionAttempts} 次` : ''}</p>}
            <p className="mt-1">输入/输出 tokens：{item.tokensIn ?? '未知'} / {item.tokensOut ?? '未知'} · CLI 报告成本：{item.costUsd === null ? '未知' : `$${item.costUsd.toFixed(4)}`}</p>
            {item.error && <p className="mt-1 whitespace-pre-wrap text-red-300">{item.errorCode}：{item.error}</p>}
            {item.evidence && <div className="mt-2 space-y-2">
              <p>权限：{item.permissionMode} · Git HEAD：{item.evidence.head ?? '未知'}{item.evidence.truncated ? ' · 证据已截断' : ''}</p>
              <details>
                <summary className="cursor-pointer">查看实际 diff 和工具结果</summary>
                <p className="mt-2">执行前的工作区变更</p>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2">{item.evidence.beforeDiff || '（无 diff）'}</pre>
                <p className="mt-2">执行后的工作区变更</p>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2">{item.evidence.afterDiff || '（无 diff）'}</pre>
                {item.evidence.commands.map((command) => <pre key={command.itemId} className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2">{command.name} · exit={command.exitCode ?? '未知'}{'\n'}{command.output}</pre>)}
              </details>
            </div>}
          </details>)}
        </header>
        <div ref={scrollRef} onScroll={(event) => scrollControllerRef.current?.onScroll(event.currentTarget)} className="min-h-0 flex-1 overflow-y-auto px-2 py-3 [scrollbar-gutter:stable] sm:px-4 sm:py-4">
          <div className="mx-auto max-w-4xl space-y-1">
            {taskStateError && <p role="alert" className="text-xs text-amber-200">任务状态获取失败：{taskStateError}</p>}
            {roomRuns.map(run => { const messages = state.messages.filter(message => message.runId === run.id); return <div key={run.id}>
              <TaskCard run={run} detail={taskStates.find(item => item.runId === run.id)} onRevise={task => { setReply(null); setRevisionTask(task); }} />
              {messages.map((message,index) => <MessageItem key={message.id} message={message} allMessages={state.messages} onReply={message => { setRevisionTask(null); setReply(message); }} groupStart={!belongsToSameVisualGroup(messages[index - 1],message)} groupEnd={!belongsToSameVisualGroup(message,messages[index + 1])} />)}
            </div>; })}
            {Object.entries(state.streams).map(([id, text]) => <StreamingItem key={id} spanId={id} text={text} />)}
            {state.messages.length === 0 && <p className="pt-20 text-center text-sm text-zinc-600">聊天室已创建。发送首个任务后，团队才会开始执行。</p>}
          </div>
        </div>
        <div className="shrink-0 max-h-[58%] overflow-y-auto border-t border-zinc-800 bg-zinc-950/90 [scrollbar-gutter:stable]">
          <TaskComposer key={`${room.id}:${revisionTask?.runId ?? 'new-task'}`} room={room} reply={reply} onReplyClear={() => setReply(null)} reservations={reservations} revisionTask={revisionTask} onRevisionClose={() => setRevisionTask(null)} />
        </div>
      </>}
    </div>
  </div>;
}
