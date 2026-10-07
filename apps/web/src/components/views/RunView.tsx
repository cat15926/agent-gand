import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentDefinition, CollaborationUserDecision, Message, ConversationMessageSearch } from '@agent-gand/shared';
import * as api from '../../services/api';
import { useStore } from '../../store';
import { MarkdownBody } from '../Markdown';
import { Drawer } from '../Drawer';
import { RoomResults } from '../RoomResults';
import { historyRunScope, type HistoryDirection } from '../../services/historyWindow';
import { writeRoomDraft, emptyPreferences } from '../../services/roomDraft';
import { TaskComposer } from '../TaskComposer';
import { TaskCard } from '../TaskCard';
import { SessionSidebar } from '../SessionSidebar';
import { AgentAvatar } from '../AgentAvatar';
import { copyText, revealMessage } from '../../services/clipboard';
import { ChatScrollController, browserReadPositions } from '../../chatScroll';

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
      <p className="mt-1 text-zinc-400">建议：{String(issue.suggestion ?? '')}</p>
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
  if (decision.status !== 'pending') return <div className="mt-3 rounded-lg bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400">已处理：{decision.status}</div>;
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
    {proposal?.acceptanceCriteria?.length ? <ul className="list-disc pl-4 text-xs text-zinc-400">{proposal.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ul> : null}
    <select value={supervisorId} onChange={(event) => setSupervisorId(event.target.value)} className="w-full rounded bg-zinc-900 px-2 py-1.5 text-xs"><option value="">选择主管</option>{candidates.filter((agent) => agent.capabilities.includes('coordinate')).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    <div className="flex flex-wrap gap-1">{candidates.map((agent) => <button key={agent.id} onClick={() => setAgentIds((ids) => ids.includes(agent.id) ? ids.filter((id) => id !== agent.id) : [...ids, agent.id])} className={`rounded-full px-2 py-1 text-xs ${agentIds.includes(agent.id) ? 'bg-sky-500/20 text-sky-200' : 'bg-zinc-900 text-zinc-400'}`}>{agent.name}</button>)}</div>
    <select value={reviewerId} onChange={(event) => setReviewerId(event.target.value)} className="w-full rounded bg-zinc-900 px-2 py-1.5 text-xs"><option value="">不设 Reviewer</option>{candidates.filter((agent) => agent.capabilities.includes('review')).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select>
    <div className="flex gap-2"><button disabled={busy || !supervisorId || agentIds.length === 0} onClick={() => void resolve({ action: 'approve_task', supervisorId, agentIds, ...(reviewerId ? { defaultReviewerId: reviewerId } : {}) })} className="rounded bg-sky-500 px-3 py-1.5 text-xs text-white disabled:opacity-40">批准并启动</button><button disabled={busy} onClick={() => void resolve({ action: 'reject_task' })} className="rounded bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400">拒绝</button></div>
    {error && <p className="text-xs text-red-300">{error}</p>}
  </div>;
}

function MessageItem({
  message,
  allMessages,
  onReply,
  onLocate,
  groupStart,
  groupEnd,
}: {
  message: Message;
  allMessages: Message[];
  onReply: (message: Message) => void;
  onLocate: (id: string) => Promise<boolean>;
  groupStart: boolean;
  groupEnd: boolean;
}) {
  const { state } = useStore();
  const [fullReport, setFullReport] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copied, setCopied] = useState(false);
  const author = state.agents.find((agent) => agent.id === message.from);
  // 气泡方向由真实发送者决定，避免未来扩展 kind 后把非用户消息放到右侧。
  const mine = message.from === 'user';
  const referenced = message.replyTo ? allMessages.find((item) => item.id === message.replyTo) ?? state.history?.references.find(item => item.id === message.replyTo) : undefined;
  useEffect(() => { const node = document.getElementById(`message-${message.id}`); const expand = () => setFullReport(true); node?.addEventListener('message-reveal',expand); return () => node?.removeEventListener('message-reveal',expand); }, [message.id]);
  const isReview = message.messageType === 'review_result' || message.messageType === 'revision_request';
  const verdict = typeof message.payload?.verdict === 'string' ? message.payload.verdict : null;
  const decision = state.collaborationDecisions.find((item) => item.promptMessageId === message.id);
  async function copyMessage(): Promise<void> {
    try {
      await copyText(message.body);
      setCopyError(''); setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false); setCopyError('复制失败，请手动选择内容复制');
    }
  }
  if (message.kind === 'system' || message.kind === 'tool') return <div id={`message-${message.id}`} data-read-anchor className="mx-auto max-w-3xl"><details className="rounded-lg bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400" open={Boolean(decision)}>
    <summary className="cursor-pointer">{message.kind === 'tool' ? '🔧 工具活动' : '⚙ 系统消息'} · {message.body.slice(0, 90)}</summary>
    <pre className="mt-2 whitespace-pre-wrap text-xs text-zinc-400">{message.body}</pre>
  </details>{decision && <DecisionCard decision={decision} />}</div>;

  const meta = <>
    <span className="font-medium" style={{ color: mine ? '#c4b5fd' : (author?.color ?? '#d4d4d8') }}>{mine ? '你' : (author?.name ?? message.from)}</span>
    {!mine && <span className="hidden text-zinc-400 sm:inline">Agent</span>}
    <span className="text-zinc-400">→ {agentName(message.to, state.agents)}</span>
    {message.messageType !== 'informational' && <span className={`rounded-full px-2 py-0.5 ${isReview ? 'bg-amber-500/15 text-amber-300' : 'bg-zinc-800 text-zinc-400'}`}>{TYPE_LABEL[message.messageType]}</span>}
    {message.taskId && <span className="hidden rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-300 sm:inline">任务 {message.taskId.slice(0, 6)}</span>}
  </>;

  const avatar = groupStart
    ? mine
      ? <AgentAvatar label="你" color="#7c3aed" className="h-9 w-9 text-sm max-[420px]:hidden" />
      : <AgentAvatar agent={author} label={message.from} className="h-9 w-9 text-sm" />
    : <div className={`h-9 w-9 shrink-0 ${mine ? 'max-[420px]:hidden' : ''}`} aria-hidden="true" />;

  return <article id={`message-${message.id}`} data-read-anchor className={`group flex w-full items-start gap-2.5 px-3 ${groupStart ? 'pt-3' : 'pt-1'} ${groupEnd ? 'pb-3' : 'pb-1'} ${mine ? 'flex-row-reverse justify-start' : 'justify-start'}`}>
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
          className={`chat-touch-action absolute right-2 top-2 rounded-md px-2 py-1 text-sm transition ${copied ? 'bg-emerald-500/15 text-emerald-300 opacity-100' : 'bg-black/20 text-zinc-400 opacity-70 hover:bg-black/35 hover:text-zinc-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'}`}>
          {copied ? '已复制' : '⧉'}
        </button>
        {message.replyTo && <button onClick={() => void onLocate(message.replyTo!)}
          className="mb-2 block w-full truncate rounded-lg border-l-2 bg-zinc-950/30 px-3 py-2 text-left text-xs text-zinc-400"
          style={{ borderColor: state.agents.find((item) => item.id === referenced?.from)?.color ?? '#71717a' }}>
          {referenced ? `引用 ${agentName(referenced.from, state.agents)}：${referenced.body.slice(0,100)}` : '查看引用的原消息'}
        </button>}
        {isReview && verdict && <div className={`mb-1 text-xs font-medium ${verdict === 'PASS' ? 'text-emerald-300' : 'text-red-300'}`}>{verdict === 'PASS' ? '✓ 审查通过' : '✗ 审查未通过'}</div>}
        <div className={`[overflow-wrap:anywhere] text-sm leading-6 ${message.body.length > 2400 && !fullReport ? 'max-h-80 overflow-hidden' : ''}`}><MarkdownBody text={message.body} onNavigate={() => setFullReport(true)} /></div>{message.body.length > 2400 && <button aria-expanded={fullReport} onClick={() => setFullReport(v => !v)} className="mt-3 rounded-lg bg-zinc-950/70 px-3 py-2 text-xs text-violet-200">{fullReport ? '收起长消息' : '展开完整报告'}</button>}{copyError && <p role="status" className="text-xs text-amber-300">{copyError}</p>}
        <ReviewIssues message={message} />
        {decision && <DecisionCard decision={decision} />}
      </div>
      {groupEnd && <div className={`mt-1 flex items-center gap-2 text-xs text-zinc-400 ${mine ? 'justify-end' : 'justify-start'}`}>
        <time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
        {mine && message.deliveryStatus && <span className={message.deliveryStatus === 'failed' ? 'text-red-300' : ''}>{DELIVERY_LABEL[message.deliveryStatus] ?? message.deliveryStatus}</span>}
        <button onClick={() => onReply(message)} className="chat-touch-action min-h-11 rounded px-2 sm:min-h-8 text-zinc-400 hover:text-violet-300 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">回复</button>
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
      <p className="mb-1 text-xs text-zinc-400">{agent?.name ?? 'Agent'} 正在回复…</p>
      <div className="text-sm text-zinc-400"><MarkdownBody text={text} /><span className="animate-pulse">▍</span></div>
    </div>

  </div>;
}

export function RunView({ onManageRoles }: { onManageRoles?: () => void }) {
  const { state, setActiveConversation, setDetailsOpen, loading, loadError, retryLoad, refreshConversation, loadHistory } = useStore();
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const [roomMenu, setRoomMenu] = useState(false);
  const [rename, setRename] = useState(false);
  const [roomTitle, setRoomTitle] = useState('');
  const [roomError, setRoomError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchPage, setSearchPage] = useState<ConversationMessageSearch | null>(null);
  const [searchBusy,setSearchBusy] = useState(false), [searchError,setSearchError] = useState(''), [searchRetry,setSearchRetry] = useState(0);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [historyBusy,setHistoryBusy] = useState(false), [historyError,setHistoryError] = useState('');
  const historyRequest = useRef(0), searchRequest = useRef(0);
  const currentRoomRef = useRef(state.activeConversationId); currentRoomRef.current = state.activeConversationId;
  const pendingPosition = useRef<{id:string;offset:number;revision:number} | null>(null);
  const [unread, setUnread] = useState(0);
  const [following, setFollowing] = useState(true);
  const messageCount = useRef({ roomId: null as string | null, count: 0 });
  const [composerVersion, setComposerVersion] = useState(0);
  const [reply, setReply] = useState<Message | null>(null);
  const [taskStates, setTaskStates] = useState<api.TaskState[]>([]);
  const [reservations, setReservations] = useState<api.MemberReservation[]>([]);
  const [revisionTask, setRevisionTask] = useState<api.TaskState | null>(null);
  const [taskStateError, setTaskStateError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollControllerRef = useRef<ChatScrollController | null>(null);
  if (!scrollControllerRef.current) scrollControllerRef.current = new ChatScrollController(browserReadPositions);
  const room = state.conversations.find((item) => item.id === state.activeConversationId);
  const roomRuns = useMemo(() => state.runs.filter((run) => run.conversationId === room?.id).sort((a, b) => a.turnNo - b.turnNo), [state.runs, room?.id]);
  const visibleIds = new Set(state.messages.map(message => message.runId));
  const visibleRuns = roomRuns.filter(run => visibleIds.has(run.id) || state.collaborationDecisions.some(d => d.runId === run.id && d.status === 'pending') || state.approvals.some(a => a.runId === run.id && a.status === 'pending') || !['completed','failed','cancelled'].includes(run.status) || (run.id === room?.latestRunId && !state.history?.hasNewer));
  const scopeKey = historyRunScope(state.runs,state.messages,room?.id ?? null,state.activeRunId).sort().join(',');
  useEffect(() => { const media = window.matchMedia('(max-width: 767px)'); const change = () => { setMobile(media.matches); setCollapsed(media.matches); }; media.addEventListener('change',change); return () => media.removeEventListener('change',change); }, []);
  useEffect(() => { setReply(null); setRevisionTask(null); setTaskStates([]); setRoomMenu(false); setRename(false); setRoomError(''); setSearch(''); setSearchOpen(false); setSearchPage(null); setResultsOpen(false); setHistoryError(''); setHistoryBusy(false); historyRequest.current++; searchRequest.current++; pendingPosition.current = null; setUnread(0); }, [room?.id]);
  useEffect(() => {
    let live = true; let pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const [members,tasks] = await Promise.all([api.getMemberReservations(), room ? api.getTaskStates(room.id,scopeKey ? scopeKey.split(',') : []) : Promise.resolve({ tasks: [] })]);
        if (live) { setReservations(members.reservations); setTaskStates(tasks.tasks); setTaskStateError(''); }
      } catch (reason) { if (live) setTaskStateError(reason instanceof Error ? reason.message : String(reason)); }
      finally { pending = false; }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(),2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [room?.id, scopeKey, state.runs, state.approvals]);
  const streamLength = Object.values(state.streams).reduce((length, text) => length + text.length, 0);
  useLayoutEffect(() => {
    const surface = scrollRef.current, held = pendingPosition.current;
    if (held && surface && held.revision !== state.historyRevision) {
      const node = document.getElementById(held.id);
      if (node) surface.scrollTop += node.getBoundingClientRect().top - surface.getBoundingClientRect().top - held.offset;
      pendingPosition.current = null;
    }
    scrollControllerRef.current?.sync(state.activeConversationId, surface, !loading);
    setFollowing(scrollControllerRef.current?.following ?? true);
    if (!loading) { const previous = messageCount.current; if (previous.roomId === state.activeConversationId && !scrollControllerRef.current?.following) setUnread(v => v + Math.max(0,state.messageRevision - previous.count)); messageCount.current = { roomId: state.activeConversationId, count: state.messageRevision }; }
  }, [state.activeConversationId, state.messages, state.messageRevision, streamLength, loading]);
  useEffect(() => { const el = scrollRef.current; if (!el) return; const observer = new ResizeObserver(() => scrollControllerRef.current?.sync(state.activeConversationId, el, !loading)); observer.observe(el); return () => observer.disconnect(); }, [state.activeConversationId, loading]);
  useEffect(() => { if (!roomMenu) return; const close = (e: KeyboardEvent) => { if (e.key === 'Escape') setRoomMenu(false); }; window.addEventListener('keydown',close); return () => window.removeEventListener('keydown',close); }, [roomMenu]);
  useEffect(() => {
    searchRequest.current++;
    if (!room || !search.trim() || !searchOpen) { setSearchPage(null); setSearchBusy(false); return; }
    const controller = new AbortController(); setSearchBusy(true); setSearchError(''); setSearchPage(null); setSearchIndex(0);
    const timer = window.setTimeout(() => { void api.searchConversationMessages(room.id,{q:search.trim()},controller.signal).then(setSearchPage).catch(reason => { if (!controller.signal.aborted) setSearchError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (!controller.signal.aborted) setSearchBusy(false); }); },200);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [room?.id,search,searchOpen,searchRetry]);
  const matches = searchPage?.matches ?? [];
  const afterRender = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  async function pageHistory(direction: HistoryDirection, around?: string) {
    if (historyBusy) return false;
    const id = room?.id, token = ++historyRequest.current; setHistoryBusy(true); setHistoryError('');
    scrollControllerRef.current?.pauseFollowing();
    if (!around && direction !== 'replace' && scrollRef.current) {
      const top = scrollRef.current.getBoundingClientRect().top;
      const anchor = Array.from(scrollRef.current.querySelectorAll<HTMLElement>('[data-read-anchor]')).find(node => node.getBoundingClientRect().bottom > top);
      if (anchor) pendingPosition.current = {id:anchor.id,offset:anchor.getBoundingClientRect().top-top,revision:state.historyRevision};
    }
    try { const applied = await loadHistory(direction,around); if (!applied) return false; await afterRender(); return true; }
    catch (reason) { if (token === historyRequest.current && id === currentRoomRef.current) setHistoryError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { if (token === historyRequest.current) { pendingPosition.current = null; setHistoryBusy(false); } }
  }
  async function locateMessage(id: string) {
    scrollControllerRef.current?.pauseFollowing(); setFollowing(false);
    if (!document.getElementById(`message-${id}`) && !await pageHistory('replace',id)) return false;
    revealMessage(id); return true;
  }
  async function jumpLatest() {
    if (state.history?.hasNewer && !await pageHistory('replace')) return;
    if (scrollRef.current) scrollControllerRef.current?.jumpToLatest(scrollRef.current);
    setFollowing(true); setUnread(0);
  }
  useEffect(() => { if (following && state.history?.hasNewer && !historyBusy) void jumpLatest(); }, [state.messageRevision]);
  async function nextMatch() {
    if (searchBusy || !matches.length) return;
    if (searchIndex < matches.length) { if (await locateMessage(matches[searchIndex]!.id)) setSearchIndex(i => i+1); return; }
    const token = searchRequest.current;
    setSearchBusy(true); setSearchError('');
    try {
      const next = await api.searchConversationMessages(room!.id,{q:search.trim(),...(searchPage?.nextAfter ? {after:searchPage.nextAfter} : {})});
      if (token !== searchRequest.current) return;
      setSearchPage(next); setSearchIndex(1); if (next.matches[0]) await locateMessage(next.matches[0].id);
    } catch (reason) { if (token === searchRequest.current) setSearchError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (token === searchRequest.current) setSearchBusy(false); }
  }
  async function archiveRoom() {
    if (!room || !window.confirm(`归档聊天室“${room.title}”？历史运行和证据仍会保留。`)) return;
    try { await api.archiveConversation(room.id); setActiveConversation(null); } catch (reason) { setRoomError(reason instanceof Error ? reason.message : String(reason)); }
  }
  function retryDraft(runId: string, newRoom: boolean) {
    const run = roomRuns.find(r => r.id === runId); if (!room || !run) return;
    const detail = taskStates.find(t => t.runId === runId); const request = detail?.snapshot?.request;
    const prefs = request ? { strategy: request.strategy, workflow: request.workflow, constraints: request.constraints, supervisorId: request.supervisorId, defaultReviewerId: request.defaultReviewerId, aggregatorId: request.aggregatorId } : room.preferences ?? emptyPreferences();
    const goal = detail?.revisedGoal ?? run.goal; const targets = request?.recipientIds ?? [];
    if (newRoom) { writeRoomDraft({ ...prefs, version: 2, goal, title: `${room.title} · 重新配置`, selected: room.agentIds, initialTargets: targets, workspace: '', recoveryNotice: '已保留目标、房间成员与执行设置。请选择可用的 Git 工作区后预览新任务。' }); setActiveConversation(null); }
    else { try { sessionStorage.setItem(`gand:task-draft:${room.id}`, JSON.stringify({ goal, targets, prefs })); } catch { setRoomError('浏览器无法保存恢复草稿，请复制原目标后重试。'); return; } setReply(null); setRevisionTask(null); setComposerVersion(v => v + 1); }
  }
  async function saveTitle() { if (!room || !roomTitle.trim()) return; try { await api.renameConversation(room.id, roomTitle.trim()); await refreshConversation(); setRename(false); } catch (reason) { setRoomError(reason instanceof Error ? reason.message : String(reason)); } }
  const sidebar = <SessionSidebar collapsed={mobile ? false : collapsed} onToggleCollapse={() => setCollapsed(value => !value)} activeConversationId={state.activeConversationId} onSelect={id => { setActiveConversation(id); if (mobile) setCollapsed(true); }} onNewSession={() => { setActiveConversation(null); if (mobile) setCollapsed(true); }} />;
  return <div className="flex h-full min-w-0">
    {mobile ? <Drawer open={!collapsed} title="聊天室列表" side="left" onClose={() => setCollapsed(true)}>{sidebar}</Drawer> : sidebar}
    <div className="flex min-w-0 flex-1 flex-col">
      {mobile && !room && <button className="shrink-0 self-start px-4 py-2 text-sm text-violet-200" aria-label="展开聊天室" onClick={() => setCollapsed(false)}>☰ 聊天室</button>}
      {loadError && <div role="alert" className="shrink-0 bg-red-500/10 p-3 text-sm text-red-300">加载失败：{loadError}<button className="ml-3 underline" onClick={retryLoad}>重试加载</button></div>}
      {loading ? <div role="status" className="flex flex-1 items-center justify-center text-sm text-zinc-400">正在加载聊天室…</div> : loadError && !room ? <div className="flex flex-1 items-center justify-center p-6 text-sm text-zinc-400">暂时无法加载聊天室，请重试。</div> : !room ? <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"><TaskComposer key="new-room" reservations={reservations} onManageRoles={onManageRoles} /></div> : <>
        <header className="shrink-0 border-b border-zinc-800 bg-zinc-950/80 px-3 py-2 sm:px-5 sm:py-3">
          <div className="relative flex items-center gap-2">{mobile && <button aria-label="展开聊天室" onClick={() => setCollapsed(false)} className="h-11 w-11 shrink-0 rounded-lg hover:bg-zinc-800">☰</button>}<div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium text-zinc-100">{room.title}</h2><p className="mt-1 truncate text-xs text-zinc-400">房间成员 {room.agentIds.length} 位 · {roomRuns.length} 个任务</p></div>
            <div className="hidden -space-x-2 lg:flex">{room.agentIds.map((id) => { const agent = state.agents.find((item) => item.id === id); return <AgentAvatar key={id} agent={agent} label={id} className="h-8 w-8 border-2 border-zinc-950 text-xs" />; })}</div>
            <button aria-label="搜索房间消息" className="h-11 shrink-0 rounded-lg px-2 text-xs text-zinc-300 hover:bg-zinc-800" onClick={() => setSearchOpen(v => !v)}>搜索</button><button aria-label="查看房间成果" onClick={() => setResultsOpen(true)} className="h-11 shrink-0 rounded-lg px-2 text-xs text-violet-200 hover:bg-zinc-800">成果</button><button aria-label="任务详情" onClick={() => setDetailsOpen(true)} className="h-11 shrink-0 rounded-lg px-2 text-xs text-violet-200 hover:bg-zinc-800"><span className="hidden sm:inline">任务</span>详情</button><button aria-label="聊天室菜单" aria-expanded={roomMenu} onClick={() => setRoomMenu(v => !v)} className="h-11 w-11 shrink-0 rounded-lg hover:bg-zinc-800">•••</button>{roomMenu && <div className="absolute right-0 top-full z-10 flex w-48 flex-col rounded-xl border border-zinc-700 bg-zinc-900 p-2 text-sm shadow-xl"><button className="p-3 text-left hover:bg-zinc-800" onClick={() => { setRoomMenu(false); setRoomTitle(room.title); setRename(true); }}>重命名聊天室</button><button className="p-3 text-left hover:bg-zinc-800" onClick={() => { setRoomMenu(false); document.querySelector<HTMLButtonElement>('[aria-label="执行设置"]')?.click(); }}>房间与执行设置</button><button className="p-3 text-left text-red-300 hover:bg-zinc-800" onClick={() => { setRoomMenu(false); void archiveRoom(); }}>归档聊天室…</button></div>}
          </div>
          {searchOpen && <div className="mt-2 space-y-2 text-xs"><div className="flex items-center gap-2"><input aria-label="搜索当前房间消息" maxLength={200} className="input min-w-0 flex-1" placeholder="搜索整个房间的消息…" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void nextMatch(); }} /><span role="status" className="shrink-0 text-zinc-300">{searchBusy ? '搜索中…' : `${searchPage?.total ?? 0} 条`}</span><button disabled={searchBusy || historyBusy || !matches.length} className="shrink-0 rounded bg-zinc-800 p-2 disabled:opacity-40" onClick={() => void nextMatch()}>下一条</button></div>
          {searchError && <p role="alert" className="text-red-300">{searchError}<button className="ml-2 underline" onClick={() => setSearchRetry(n => n+1)}>重试搜索</button></p>}
          {!!matches.length && <details><summary className="cursor-pointer text-zinc-400">查看匹配内容 · 当前页 {matches.length} 条</summary><div className="mt-2 max-h-32 space-y-1 overflow-y-auto">{matches.map(message => <button key={message.id} disabled={historyBusy} onClick={() => void locateMessage(message.id)} className="block w-full truncate rounded bg-zinc-900 px-2 py-2 text-left text-zinc-300">{message.body}</button>)}</div></details>}</div>}
          {roomError && <p role="alert" className="mt-2 text-sm text-red-300">{roomError}</p>}
          {state.scheduler && <div className="mt-2 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full animate-pulse rounded bg-violet-500" style={{ width: `${Math.max(20, 100 * state.scheduler.active / Math.max(1, state.scheduler.active + state.scheduler.queued))}%` }} /></div>}
          {state.collaborationScheduler && <div className="mt-2 flex gap-3 text-xs text-zinc-400"><span>活跃 Agent {state.collaborationScheduler.activeAgentIds.length}</span><span>排队 {state.collaborationScheduler.queued}</span>{state.collaborationScheduler.blocked > 0 && <span className="text-amber-300">阻断 {state.collaborationScheduler.blocked}</span>}</div>}

        </header>
        <div className="relative min-h-0 flex-1"><div data-testid="chat-history" ref={scrollRef} onScroll={event => { scrollControllerRef.current?.onScroll(event.currentTarget,!state.history?.hasNewer); const follow = scrollControllerRef.current?.following ?? true; setFollowing(follow); if (follow) setUnread(0); }} className="h-full min-h-0 overflow-y-auto px-2 py-3 [scrollbar-gutter:stable] sm:px-4 sm:py-4">
          <div className="mx-auto max-w-4xl space-y-1">
            {taskStateError && <p role="alert" className="text-xs text-amber-200">任务状态获取失败：{taskStateError}</p>}
            {state.history && <div className="flex items-center justify-center gap-3 py-2 text-xs text-zinc-400"><span>消息 {state.history.oldestSeq ?? 0}–{state.history.newestSeq ?? 0} · 共 {state.history.total} 条</span>{state.history.hasOlder && <button disabled={historyBusy} onClick={() => void pageHistory('older')} className="rounded-lg bg-zinc-800 px-3 py-2 text-violet-200 disabled:opacity-40">加载更早消息</button>}</div>}
            {visibleRuns.map(run => { const messages = state.messages.filter(message => message.runId === run.id); return <div key={run.id}>
              <TaskCard onRetryDraft={newRoom => retryDraft(run.id,newRoom)} run={run} detail={taskStates.find(item => item.runId === run.id)} onRevise={task => { setReply(null); setRevisionTask(task); }} />
              {state.collaborationDecisions.filter(d => d.runId === run.id && d.status === 'pending' && !messages.some(m => m.id === d.promptMessageId)).map(decision => <div key={decision.id} className="my-3 rounded-lg border border-violet-500/30 p-3"><p className="text-sm text-violet-200">此任务有待处理的问题或决定</p><button disabled={historyBusy} onClick={() => void locateMessage(decision.promptMessageId)} className="mt-2 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300">查看原问题</button><DecisionCard decision={decision} /></div>)}
              {messages.map((message,index) => <MessageItem key={message.id} message={message} allMessages={state.messages} onLocate={locateMessage} onReply={message => { setRevisionTask(null); setReply(message); requestAnimationFrame(() => document.getElementById('goal-input')?.focus()); }} groupStart={!belongsToSameVisualGroup(messages[index - 1],message)} groupEnd={!belongsToSameVisualGroup(message,messages[index + 1])} />)}
            </div>; })}
            {state.history?.hasNewer && <div className="flex justify-center py-3"><button disabled={historyBusy} onClick={() => void pageHistory('newer')} className="rounded-lg bg-zinc-800 px-3 py-2 text-sm text-violet-200 disabled:opacity-40">加载后续消息</button></div>}
            {!state.history?.hasNewer && Object.entries(state.streams).map(([id, text]) => <StreamingItem key={id} spanId={id} text={text} />)}
            {!loading && !loadError && state.messages.length === 0 && <p className="pt-20 text-center text-sm text-zinc-400">聊天室已创建。发送首个任务后，团队才会开始执行。</p>}
          </div>
        </div>
        {(historyBusy || historyError) && <div className="absolute left-2 right-2 top-1 z-10 rounded-lg bg-zinc-900/95 p-2 text-xs shadow-lg">{historyBusy ? <span role="status" className="text-zinc-300">正在加载消息…</span> : <span role="alert" className="text-red-300">{historyError}<button onClick={() => setHistoryError('')} className="float-right px-2 text-zinc-300">关闭提示</button></span>}</div>}
        {(!following || state.history?.hasNewer) && <button disabled={historyBusy} onClick={() => void jumpLatest()} className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-violet-400/40 bg-zinc-900 px-4 py-2 text-sm text-violet-200 shadow-xl disabled:opacity-40">{unread ? `${unread} 条新消息 · ` : ''}跳到最新 ↓</button>}</div>
        <div className="chat-composer-footer shrink-0 max-h-[35%] overflow-y-auto border-t border-zinc-800 bg-zinc-950/90 [scrollbar-gutter:stable]">
          <TaskComposer key={`${room.id}:${revisionTask?.runId ?? 'new-task'}:${composerVersion}`} room={room} reply={reply} onReplyClear={() => setReply(null)} reservations={reservations} revisionTask={revisionTask} onRevisionClose={() => setRevisionTask(null)} />
        </div>
      </>}
    </div>
    {room && <RoomResults key={room.id} roomId={room.id} open={resultsOpen} onClose={() => setResultsOpen(false)} onLocate={locateMessage} />}
    <Drawer open={rename} title="重命名聊天室" onClose={() => setRename(false)}><form className="space-y-4 p-4" onSubmit={e => { e.preventDefault(); void saveTitle(); }}><label className="block text-sm">新的房间名称<input autoFocus className="input mt-2" maxLength={80} value={roomTitle} onChange={e => setRoomTitle(e.target.value)} /></label>{roomError && <p role="alert" className="text-sm text-red-300">{roomError}</p>}<button disabled={!roomTitle.trim()} className="rounded-lg bg-violet-500 px-4 py-2 text-sm disabled:opacity-40">保存名称</button></form></Drawer>
  </div>;
}
