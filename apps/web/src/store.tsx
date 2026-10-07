/**
 * 全局状态：初始 hydrate（REST）+ 增量更新（WS 事件）
 * 房间消息独立于详情面板的任务选择；异步回填不得清空其他轮次。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgentDefinition,
  ApprovalRequest,
  Message,
  ConversationHistoryPage,
  Run,
  RunEvent,
  ServerEvent,
  Task,
  TaskAttempt,
  TaskReview,
  UsageSummary,
  Conversation,
  RuntimeCompletionCandidate,
  RuntimeDurableHold,
  RuntimeHoldRecoveryAudit,
  RuntimeEvidenceBundle,
  RuntimeRouteGuardEvent,
  RuntimeResponsibilitySnapshot,
  RuntimeActionCommandRecord,
  RuntimeShadowComparison,
  RuntimeWakeEvent,
  RuntimeSuccessorObligation,
  CollaborationAttempt,
  CollaborationBatch,
  CollaborationDispatch,
  CollaborationUserDecision,
  CollaborationBudgetSnapshot,
  CoordinationEvent,
  CoordinationPlan,
  CoordinationStepAttempt,
  CoordinationStepState,
} from '@agent-gand/shared';
import * as api from './services/api';
import { browserReadPositions } from './chatScroll';
import { mergeHistory, historyRunScope, HISTORY_WINDOW_LIMIT, type HistoryMetadata, type HistoryDirection } from './services/historyWindow';
import { armPermissionRequest, notifyApproval } from './services/notify';
import { readChatLocation, writeChatLocation } from './services/chatLocation';
import { onServerEvent, onWsStatus } from './services/ws';

export interface State {
  executions: import('@agent-gand/shared').ExternalAgentExecution[];
  wsConnected: boolean;
  agents: AgentDefinition[];
  runs: Run[];
  conversations: Conversation[];
  activeConversationId: string | null;
  activeRunId: string | null;
  messages: Message[];
  history: HistoryMetadata | null;
  messageRevision: number;
  historyRevision: number;
  events: RunEvent[];
  tasks: Task[];
  attempts: TaskAttempt[];
  reviews: TaskReview[];
  approvals: ApprovalRequest[];
  usage: UsageSummary[];
  /** 活动 llm span 的流式增量累积（spanId → 已到文本；span 结束即折叠清除，§8.1） */
  streams: Record<string, string>;
  scheduler: { runId: string; active: number; queued: number } | null;
  collaborationDispatches: CollaborationDispatch[];
  collaborationAttempts: CollaborationAttempt[];
  collaborationBatches: CollaborationBatch[];
  collaborationDecisions: CollaborationUserDecision[];
  completionCandidates: RuntimeCompletionCandidate[];
  successorObligations: RuntimeSuccessorObligation[];
  evidenceBundles: RuntimeEvidenceBundle[];
  routeGuardEvents: RuntimeRouteGuardEvent[];
  durableHolds: RuntimeDurableHold[];
  wakeEvents: RuntimeWakeEvent[];
  holdRecoveryAudits: RuntimeHoldRecoveryAudit[];
  responsibilitySnapshots: RuntimeResponsibilitySnapshot[];
  actionCommands: RuntimeActionCommandRecord[];
  shadowComparisons: RuntimeShadowComparison[];
  collaborationBudgets: Record<string, CollaborationBudgetSnapshot>;
  collaborationScheduler: { conversationId: string; runIds: string[]; activeAgentIds: string[]; queued: number; blocked: number } | null;
  coordinationPlan: CoordinationPlan | null;
  coordinationSteps: CoordinationStepState[];
  coordinationAttempts: CoordinationStepAttempt[];
  coordinationEvents: CoordinationEvent[];
}

type Action =
  | { type: 'history'; conversationId: string; page: ConversationHistoryPage; direction: HistoryDirection }
  | { type: 'ws'; connected: boolean }
  | { type: 'hydrate'; runs: Run[]; conversations: Conversation[]; agents: AgentDefinition[]; tasks: Task[]; approvals: ApprovalRequest[]; usage: UsageSummary[] }
  | { type: 'agents'; agents: AgentDefinition[] }
  | { type: 'runDetail'; runId: string; messages: Message[]; events: RunEvent[]; attempts: TaskAttempt[]; reviews: TaskReview[]; coordination: api.CoordinationRunDetail | null; executions: State['executions'] }
  | { type: 'setActiveRun'; runId: string | null }
  | { type: 'setActiveConversation'; conversationId: string | null; runId: string | null }
  | { type: 'conversationDetail'; conversationId: string; runs: Run[]; messages: Message[]; events: RunEvent[]; attempts: TaskAttempt[]; reviews: TaskReview[]; coordination: api.CoordinationRunDetail | null; executions: State['executions'] }
  | { type: 'collaborationDetail'; conversationId: string; details: api.CollaborationRunDetail[] }
  | { type: 'coordinationDetail'; runId: string; detail: api.CoordinationRunDetail | null }
  | { type: 'responsibilityDetail'; runId: string; snapshots: RuntimeResponsibilitySnapshot[] }
  | { type: 'serverEvent'; event: ServerEvent };

export const initialState: State = {
  executions: [],
  wsConnected: false,
  agents: [],
  runs: [],
  conversations: [],
  activeConversationId: null,
  activeRunId: null,
  messages: [], history: null, messageRevision: 0, historyRevision: 0,
  events: [],
  tasks: [],
  attempts: [],
  reviews: [],
  approvals: [],
  usage: [],
  streams: {},
  scheduler: null,
  collaborationDispatches: [], collaborationAttempts: [], collaborationBatches: [], collaborationDecisions: [], completionCandidates: [], successorObligations: [], evidenceBundles: [], routeGuardEvents: [], durableHolds: [], wakeEvents: [], holdRecoveryAudits: [], responsibilitySnapshots: [], actionCommands: [], shadowComparisons: [], collaborationBudgets: {}, collaborationScheduler: null,
  coordinationPlan: null, coordinationSteps: [], coordinationAttempts: [], coordinationEvents: [],
};

function upsertBy<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = [...list];
  next[idx] = item;
  return next;
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'history':
      if (action.conversationId !== state.activeConversationId) return state;
      return { ...state, ...mergeHistory(state.messages,state.history,action.page,action.direction), historyRevision: state.historyRevision+1 };
    case 'ws':
      return { ...state, wsConnected: action.connected };
    case 'hydrate':
      // 显式取字段，避免把 action.type 泄进 state（inspector P3）
      return {
        ...state,
        runs: action.runs,
        conversations: action.conversations,
        agents: action.agents,
        tasks: action.tasks,
        approvals: action.approvals,
        usage: action.usage,
        streams: Object.fromEntries(Object.entries(state.streams).filter(([id]) => { const runId = state.events.find(event => event.id === id)?.runId; return !action.runs.some(run => run.id === runId && ['completed','failed','cancelled'].includes(run.status)); })),
      };
    case 'agents':
      return { ...state, agents: action.agents };
    case 'setActiveRun':
      return { ...state, activeRunId: action.runId, scheduler: null,
        coordinationPlan: null, coordinationSteps: [], coordinationAttempts: [], coordinationEvents: [] };
    case 'setActiveConversation':
      return { ...state, activeConversationId: action.conversationId, activeRunId: action.runId, executions: [], messages: [], history: null, messageRevision: 0, historyRevision: 0, events: [], attempts: [], reviews: [], streams: {}, scheduler: null,
        collaborationDispatches: [], collaborationAttempts: [], collaborationBatches: [], collaborationDecisions: [], completionCandidates: [], successorObligations: [], evidenceBundles: [], routeGuardEvents: [], durableHolds: [], wakeEvents: [], holdRecoveryAudits: [], responsibilitySnapshots: [], actionCommands: [], shadowComparisons: [], collaborationBudgets: {}, collaborationScheduler: null,
        coordinationPlan: null, coordinationSteps: [], coordinationAttempts: [], coordinationEvents: [] };
    case 'conversationDetail':
      if (action.conversationId !== state.activeConversationId) return state;
      return { ...state, activeRunId: action.runs.some(run => run.id === state.activeRunId) ? state.activeRunId : action.runs.at(-1)?.id ?? null,
        executions: action.executions.reduce(upsertBy, state.executions), runs: action.runs.reduce(upsertBy, state.runs),
        messages: action.messages.reduce(upsertBy, state.messages).sort((a,b) => a.seq - b.seq), events: action.events.reduce(upsertBy, state.events) };
    case 'collaborationDetail':
      if (action.conversationId !== state.activeConversationId) return state;
      return { ...state,
        collaborationDispatches: action.details.flatMap((item) => item.dispatches),
        collaborationAttempts: action.details.flatMap((item) => item.attempts),
        collaborationBatches: action.details.flatMap((item) => item.batches),
        collaborationDecisions: action.details.flatMap((item) => item.decisions),
        completionCandidates: action.details.flatMap((item) => item.completionCandidates),
        successorObligations: action.details.flatMap((item) => item.successorObligations),
        evidenceBundles: action.details.flatMap((item) => item.evidenceBundles),
        routeGuardEvents: action.details.flatMap((item) => item.routeGuardEvents),
        durableHolds: action.details.flatMap((item) => item.durableHolds),
        wakeEvents: action.details.flatMap((item) => item.wakeEvents),
        holdRecoveryAudits: action.details.flatMap((item) => item.holdRecoveryAudits),
        responsibilitySnapshots: action.details.flatMap((item) => item.responsibilitySnapshots),
        actionCommands: action.details.flatMap((item) => item.actionCommands),
        shadowComparisons: action.details.flatMap((item) => item.shadowComparisons),
        collaborationBudgets: Object.fromEntries(action.details.flatMap((item) => item.run ? [[item.run.id, item.budget] as const] : [])),
      };
    case 'runDetail':
      // 查看任务只合并其明细；其他轮次的消息、流式内容和审计记录继续保留。
      if (action.runId !== state.activeRunId) return state;
      return { ...state, executions: action.executions.reduce(upsertBy, state.executions), messages: action.messages.reduce(upsertBy, state.messages).sort((a,b) => a.seq - b.seq), events: action.events.reduce(upsertBy, state.events), streams: Object.fromEntries(Object.entries(state.streams).filter(([id]) => !action.events.some(event => event.id === id && event.endedAt !== null))), attempts: action.attempts, reviews: action.reviews,
        coordinationPlan: action.coordination?.plan ?? null, coordinationSteps: action.coordination?.steps ?? [],
        coordinationAttempts: action.coordination?.attempts ?? [], coordinationEvents: action.coordination?.events ?? [],
        completionCandidates: mergeRunItems(state.completionCandidates, action.coordination?.completionCandidates ?? [], state.activeRunId),
        successorObligations: mergeRunItems(state.successorObligations, action.coordination?.successorObligations ?? [], state.activeRunId),
        evidenceBundles: mergeRunItems(state.evidenceBundles, action.coordination?.evidenceBundles ?? [], state.activeRunId),
        routeGuardEvents: mergeRunItems(state.routeGuardEvents, action.coordination?.routeGuardEvents ?? [], state.activeRunId),
        durableHolds: mergeRunItems(state.durableHolds, action.coordination?.durableHolds ?? [], state.activeRunId),
        wakeEvents: mergeRunItems(state.wakeEvents, action.coordination?.wakeEvents ?? [], state.activeRunId),
        holdRecoveryAudits: mergeRunItems(state.holdRecoveryAudits, action.coordination?.holdRecoveryAudits ?? [], state.activeRunId),
        responsibilitySnapshots: mergeRunItems(state.responsibilitySnapshots, action.coordination?.responsibilitySnapshots ?? [], state.activeRunId),
        actionCommands: mergeRunItems(state.actionCommands, action.coordination?.actionCommands ?? [], state.activeRunId),
        shadowComparisons: mergeRunItems(state.shadowComparisons, action.coordination?.shadowComparisons ?? [], state.activeRunId) };
    case 'coordinationDetail':
      if (action.runId !== state.activeRunId) return state;
      return { ...state, coordinationPlan: action.detail?.plan ?? null, coordinationSteps: action.detail?.steps ?? [],
        coordinationAttempts: action.detail?.attempts ?? [], coordinationEvents: action.detail?.events ?? [],
        completionCandidates: mergeRunItems(state.completionCandidates, action.detail?.completionCandidates ?? [], action.runId),
        successorObligations: mergeRunItems(state.successorObligations, action.detail?.successorObligations ?? [], action.runId),
        evidenceBundles: mergeRunItems(state.evidenceBundles, action.detail?.evidenceBundles ?? [], action.runId), routeGuardEvents: mergeRunItems(state.routeGuardEvents, action.detail?.routeGuardEvents ?? [], action.runId),
        durableHolds: mergeRunItems(state.durableHolds, action.detail?.durableHolds ?? [], action.runId), wakeEvents: mergeRunItems(state.wakeEvents, action.detail?.wakeEvents ?? [], action.runId),
        holdRecoveryAudits: mergeRunItems(state.holdRecoveryAudits, action.detail?.holdRecoveryAudits ?? [], action.runId),
        responsibilitySnapshots: mergeRunItems(state.responsibilitySnapshots, action.detail?.responsibilitySnapshots ?? [], action.runId),
        actionCommands: mergeRunItems(state.actionCommands, action.detail?.actionCommands ?? [], action.runId),
        shadowComparisons: mergeRunItems(state.shadowComparisons, action.detail?.shadowComparisons ?? [], action.runId) };
    case 'responsibilityDetail':
      if (action.runId !== state.activeRunId) return state;
      return { ...state, responsibilitySnapshots: [
        ...state.responsibilitySnapshots.filter((snapshot) => snapshot.runId !== action.runId),
        ...action.snapshots,
      ] };
    case 'serverEvent': {
      const e = action.event;
      const inRoom = (runId: string) => runId === state.activeRunId || state.runs.some(run => run.id === runId && run.conversationId === state.activeConversationId);
      switch (e.type) {
        case 'execution.updated':
          return inRoom(e.execution.runId) ? { ...state, executions: upsertBy(state.executions, e.execution) } : state;
        case 'agent.updated':
          return { ...state, agents: e.agent.enabled ? upsertBy(state.agents, e.agent) : state.agents.filter((agent) => agent.id !== e.agent.id) };
        case 'message': {
          if (e.message.conversationId !== state.activeConversationId) return state;
          if (!state.history) return { ...state, messages: upsertBy(state.messages,e.message).sort((a,b) => a.seq-b.seq) };
          const existing = state.messages.some(message => message.id === e.message.id);
          const arrived = e.message.seq > state.history.headSeq;
          const merged = existing || (arrived && !state.history.hasNewer) ? upsertBy(state.messages,e.message).sort((a,b) => a.seq-b.seq) : state.messages;
          const messages = arrived && !existing && merged.length > HISTORY_WINDOW_LIMIT ? state.messages : merged;
          return { ...state, messages, messageRevision: state.messageRevision + (arrived ? 1 : 0), history: { ...state.history,
            headSeq: Math.max(state.history.headSeq,e.message.seq), total: state.history.total + (arrived ? 1 : 0),
            oldestSeq: messages[0]?.seq ?? null, newestSeq: messages.at(-1)?.seq ?? null,
            hasOlder: state.history.hasOlder || merged.length > messages.length,
            hasNewer: state.history.hasNewer || (arrived && messages === state.messages) } };
        }
        case 'conversation.updated':
          return { ...state, conversations: (e.conversation.archivedAt
            ? state.conversations.filter((item) => item.id !== e.conversation.id)
            : upsertBy(state.conversations, e.conversation)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
        case 'llm.snapshot':
          if (e.displayKind === 'review_protocol') return state;
          return inRoom(e.runId) ? { ...state, streams: { ...state.streams, [e.spanId]: e.text } } : state;
        case 'llm.delta':
          if (e.displayKind === 'review_protocol') return state;
          // 房间中其他任务仍可运行；查看历史任务不影响流式消息。
          return inRoom(e.runId)
            ? {
                ...state,
                streams: { ...state.streams, [e.spanId]: (state.streams[e.spanId] ?? '') + e.text },
              }
            : state;
        case 'run.event': {
          if (!inRoom(e.event.runId)) return state;
          // span 结束（endedAt 非空）→ 流式段落折叠（正式消息/终态 output 随后到达）
          const streams =
            e.event.endedAt !== null && state.streams[e.event.id] !== undefined
              ? Object.fromEntries(Object.entries(state.streams).filter(([id]) => id !== e.event.id))
              : state.streams;
          return { ...state, events: upsertBy(state.events, e.event), streams };
        }
        case 'task.updated':
          return { ...state, tasks: upsertBy(state.tasks, e.task) };
        case 'task.attempt.updated':
          return e.attempt.runId === state.activeRunId
            ? { ...state, attempts: upsertBy(state.attempts, e.attempt) }
            : state;
        case 'review.updated':
          return state.tasks.some((task) => task.id === e.review.taskId && task.runId === state.activeRunId)
            ? { ...state, reviews: upsertBy(state.reviews, e.review) }
            : state;
        case 'scheduler.updated':
          return e.runId === state.activeRunId ? { ...state, scheduler: e } : state;
        case 'collaboration.dispatch.updated':
          return e.dispatch.conversationId === state.activeConversationId ? { ...state, collaborationDispatches: upsertBy(state.collaborationDispatches, e.dispatch) } : state;
        case 'collaboration.attempt.updated':
          return e.attempt.conversationId === state.activeConversationId ? { ...state, collaborationAttempts: upsertBy(state.collaborationAttempts, e.attempt) } : state;
        case 'collaboration.batch.updated':
          return e.batch.conversationId === state.activeConversationId ? { ...state, collaborationBatches: upsertBy(state.collaborationBatches, e.batch) } : state;
        case 'collaboration.decision.updated':
          return e.decision.conversationId === state.activeConversationId ? { ...state, collaborationDecisions: upsertBy(state.collaborationDecisions, e.decision) } : state;
        case 'runtime.completion_candidate.updated':
          return state.runs.some((run) => run.id === e.candidate.runId && run.conversationId === state.activeConversationId)
            ? { ...state, completionCandidates: upsertBy(state.completionCandidates, e.candidate) } : state;
        case 'runtime.action_command.committed':
          return state.runs.some((run) => run.id === e.command.runId && run.conversationId === state.activeConversationId)
            ? { ...state, actionCommands: upsertBy(state.actionCommands, e.command) } : state;
        case 'runtime.shadow_comparison.recorded':
          return state.runs.some((run) => run.id === e.comparison.runId && run.conversationId === state.activeConversationId)
            ? { ...state, shadowComparisons: upsertBy(state.shadowComparisons, e.comparison) } : state;
        case 'runtime.evidence_bundle.updated':
          return state.runs.some((run) => run.id === e.bundle.runId && run.conversationId === state.activeConversationId)
            ? { ...state, evidenceBundles: upsertBy(state.evidenceBundles, e.bundle) } : state;
        case 'runtime.route_guard.updated':
          return state.runs.some((run) => run.id === e.event.runId && run.conversationId === state.activeConversationId)
            ? { ...state, routeGuardEvents: upsertBy(state.routeGuardEvents, e.event) } : state;
        case 'runtime.hold.updated':
          return state.runs.some((run) => run.id === e.hold.runId && run.conversationId === state.activeConversationId)
            ? { ...state, durableHolds: upsertBy(state.durableHolds, e.hold) } : state;
        case 'runtime.hold_recovery.recorded':
          return state.runs.some((run) => run.id === e.audit.runId && run.conversationId === state.activeConversationId)
            ? { ...state, holdRecoveryAudits: upsertBy(state.holdRecoveryAudits, e.audit) } : state;
        case 'runtime.wake_event.recorded':
          return state.runs.some((run) => run.id === e.wakeEvent.runId && run.conversationId === state.activeConversationId)
            ? { ...state, wakeEvents: upsertBy(state.wakeEvents, e.wakeEvent) } : state;
        case 'runtime.successor_obligation.updated':
          return state.runs.some((run) => run.id === e.obligation.runId && run.conversationId === state.activeConversationId)
            ? { ...state, successorObligations: upsertBy(state.successorObligations, e.obligation) } : state;
        case 'collaboration.scheduler.updated':
          return e.conversationId === state.activeConversationId ? { ...state, collaborationScheduler: e } : state;
        case 'coordination.step.updated':
          return e.step.runId === state.activeRunId
            ? { ...state, coordinationSteps: upsertByStepId(state.coordinationSteps, e.step) }
            : state;
        case 'run.updated':
          {
          const rooms = state.conversations.map((room) => {
            if (room.id !== e.run.conversationId) return room;
            const latestTurn = state.runs.filter((run) => run.conversationId === room.id).reduce((max, run) => Math.max(max, run.turnNo), 0);
            return e.run.turnNo >= latestTurn ? { ...room, latestRunId: e.run.id, latestRunStatus: e.run.status } : room;
          });
          return {
            ...state,
            conversations: rooms,
            runs: upsertBy(state.runs, e.run),
            activeRunId: state.activeRunId ?? (e.run.conversationId === state.activeConversationId ? e.run.id : null),
          };
          }
        case 'approval.updated':
          return { ...state, approvals: upsertBy(state.approvals, e.approval) };
        case 'usage': {
          // UsageSummary 以 runId 为键（无 id 字段），单独按 runId upsert
          const idx = state.usage.findIndex((u) => u.runId === e.usage.runId);
          if (idx === -1) return { ...state, usage: [...state.usage, e.usage] };
          const usage = [...state.usage];
          usage[idx] = e.usage;
          return { ...state, usage };
        }
        default:
          return state;
      }
    }
  }
}

function mergeRunItems<T extends { runId: string }>(list: T[], incoming: T[], runId: string | null): T[] {
  return [...list.filter(item => item.runId !== runId), ...incoming];
}

function upsertByStepId(list: CoordinationStepState[], item: CoordinationStepState): CoordinationStepState[] {
  const index = list.findIndex((step) => step.planId === item.planId && step.revision === item.revision && step.stepId === item.stepId);
  if (index === -1) return [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

async function loadCoordinationDetail(runId: string): Promise<api.CoordinationRunDetail | null> {
  try {
    return await api.getRunCoordination(runId);
  } catch (error) {
    if (error instanceof api.ApiError && error.status === 404) return null;
    throw error;
  }
}

async function loadRunDetail(runId: string, dispatch: (a: Action) => void): Promise<void> {
  const [detail, coordination, executions] = await Promise.all([api.getRun(runId, false), loadCoordinationDetail(runId), api.getExternalExecutions(runId)]);
  dispatch({
    type: 'runDetail',
    runId,
    messages: detail.messages,
    events: detail.events,
    attempts: detail.attempts,
    reviews: detail.reviews,
    coordination,
    executions,
  });
}

async function loadConversationDetail(conversationId: string, dispatch: (a: Action) => void, selectedRunId?: string | null): Promise<void> {
  const saved = browserReadPositions.get(conversationId);
  const anchor = !saved?.following ? saved?.anchor?.replace(/^message-/, '') : undefined;
  const [room, page] = await Promise.all([api.getConversation(conversationId,false), api.getConversationHistory(conversationId,anchor ? {around:anchor} : {}).catch(reason => {
    if (anchor && reason instanceof api.ApiError && reason.status === 404) return api.getConversationHistory(conversationId);
    throw reason;
  })]);
  dispatch({ type: 'serverEvent', event: { type: 'conversation.updated', conversation: room.conversation } });
  const latest = room.runs.find(run => run.id === selectedRunId) ?? room.runs.at(-1);
  const [detail, coordination, executions] = latest
    ? await Promise.all([api.getRun(latest.id,false), loadCoordinationDetail(latest.id), api.getExternalExecutions(latest.id)])
    : [null, null, []];
  dispatch({ type: 'conversationDetail', conversationId, runs: room.runs, messages: [],
    events: detail?.events ?? [], attempts: detail?.attempts ?? [], reviews: detail?.reviews ?? [], coordination, executions });
  dispatch({ type: 'history', conversationId, page, direction: 'replace' });
  if (latest && detail) dispatch({ type: 'runDetail', runId: latest.id, messages: [], events: detail.events, attempts: detail.attempts, reviews: detail.reviews, coordination, executions });
}

const StoreContext = createContext<{ state: State; setActiveRun: (id: string | null) => void; setActiveConversation: (id: string | null) => void; refreshConversation: () => Promise<void>; loadHistory: (direction: HistoryDirection, around?: string) => Promise<boolean>; detailsOpen: boolean; setDetailsOpen: (open: boolean) => void; loading: boolean; loadError: string; retryLoad: () => void }>({
  state: initialState, detailsOpen: false, setDetailsOpen: () => {}, loading: true, loadError: '', retryLoad: () => {},
  setActiveRun: () => {},
  setActiveConversation: () => {},
  refreshConversation: async () => {}, loadHistory: async () => false,
});

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const stateRef = useRef(state); stateRef.current = state;
  const historyVersion = useRef(0);
  const selection = useRef(readChatLocation());
  const initialized = useRef(false);
  const requestVersion = useRef(0);
  const activeRunRef = useRef(state.activeRunId);
  const activeConversationRef = useRef(state.activeConversationId);
  activeRunRef.current = state.activeRunId;
  activeConversationRef.current = state.activeConversationId;

  /** 全量刷新列表；断线重连后也调用，回补断连期间丢失的增量（inspector P2） */
  const hydrateAll = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!initialized.current) setLoading(true);
    setLoadError('');
    try {
    const [agents, runs, conversations, tasks, approvals, usage] = await Promise.all([
      api.getAgents(),
      api.getRuns(),
      api.getConversations(),
      api.getTasks(),
      api.getApprovals(),
      api.getUsage(),
    ]);
    if (version !== requestVersion.current) return;
    dispatch({ type: 'hydrate', runs, conversations, agents, tasks, approvals, usage });

    const requested = initialized.current ? activeConversationRef.current : selection.current?.roomId;
    const room = requested ? conversations.find(item => item.id === requested) : undefined;
    const current = room ?? (!initialized.current && !selection.current ? conversations[0] : undefined);
    const runId = initialized.current ? activeRunRef.current : selection.current?.runId;
    if (current) {
      if (!initialized.current) dispatch({ type: 'setActiveConversation', conversationId: current.id, runId: runId ?? current.latestRunId });
      await loadConversationDetail(current.id, action => { if (version === requestVersion.current) dispatch(action); }, runId);
    } else if (!initialized.current) dispatch({ type: 'setActiveConversation', conversationId: null, runId: null });
    initialized.current = true;
    } catch (reason) { if (version === requestVersion.current) setLoadError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (version === requestVersion.current) setLoading(false); }

  }, []);

  useEffect(() => {
    void hydrateAll();
    armPermissionRequest(); // 首次交互请求浏览器通知权限（§8.2）

    const offStatus = onWsStatus((connected) => {
      dispatch({ type: 'ws', connected });
      if (connected) void hydrateAll(); // 重连成功 → 全量回补，不清空 UI
    });
    const offEvents = onServerEvent((event) => {
      if (event.type === 'hello') {
        // hello 只补 agents，不动其余状态（避免重连清空列表）
        dispatch({ type: 'agents', agents: event.agents });
        return;
      }
      // 新 pending 审批 → 系统通知（已授权时点击聚焦，§8.2）
      if (event.type === 'approval.updated' && event.approval.status === 'pending') {
        notifyApproval(event.approval);
      }
      dispatch({ type: 'serverEvent', event });
      if (event.type === 'coordination.step.updated' && event.step.runId === activeRunRef.current) {
        void loadCoordinationDetail(event.step.runId)
          .then((detail) => dispatch({ type: 'coordinationDetail', runId: event.step.runId, detail }))
          .catch(() => { /* 断线期间由下一次 hydrate 回补。 */ });
      }
      if (event.type === 'run.updated' && event.run.id === activeRunRef.current) {
        void loadCoordinationDetail(event.run.id)
          .then((detail) => dispatch({ type: 'coordinationDetail', runId: event.run.id, detail }))
          .catch(() => { /* 断线期间由下一次 hydrate 回补。 */ });
      }
      const responsibilityRunId = event.type === 'collaboration.dispatch.updated' ? event.dispatch.runId
        : event.type === 'collaboration.attempt.updated' ? event.attempt.runId
        : event.type === 'runtime.completion_candidate.updated' ? event.candidate.runId
        : event.type === 'runtime.hold.updated' ? event.hold.runId
        : event.type === 'runtime.successor_obligation.updated' ? event.obligation.runId
        : event.type === 'coordination.step.updated' ? event.step.runId
        : event.type === 'run.updated' ? event.run.id : null;
      if (responsibilityRunId && responsibilityRunId === activeRunRef.current) {
        void api.getRunResponsibility(responsibilityRunId)
          .then((detail) => dispatch({ type: 'responsibilityDetail', runId: responsibilityRunId, snapshots: detail.snapshots }))
          .catch(() => { /* 断线期间由下一次 hydrate 回补。 */ });
      }
    });
    return () => {
      offStatus();
      offEvents();
    };
  }, [hydrateAll]);

  const setActiveRun = useCallback(
    (id: string | null) => {
      activeRunRef.current = id;
      writeChatLocation(activeConversationRef.current, id);
      setDetailsOpen(Boolean(id));
      dispatch({ type: 'setActiveRun', runId: id });
      if (id) void loadRunDetail(id, dispatch).catch(reason => setLoadError(reason instanceof Error ? reason.message : String(reason)));
    },
    [],
  );

  const setActiveConversation = useCallback((id: string | null, options?: { runId?: string | null; push?: boolean }) => {
    const conversation = state.conversations.find((item) => item.id === id);
    const version = ++requestVersion.current;
    initialized.current = true; activeConversationRef.current = id; activeRunRef.current = options?.runId ?? conversation?.latestRunId ?? null;
    setDetailsOpen(false); setLoadError(''); setLoading(Boolean(id));
    writeChatLocation(id, activeRunRef.current, options?.push !== false);
    dispatch({ type: 'setActiveConversation', conversationId: id, runId: activeRunRef.current });
    if (id) void loadConversationDetail(id, action => { if (version === requestVersion.current) dispatch(action); }, activeRunRef.current).catch(reason => { if (version === requestVersion.current) setLoadError(reason instanceof Error ? reason.message : String(reason)); }).finally(() => { if (version === requestVersion.current) setLoading(false); });
  }, [state.conversations]);

  const refreshConversation = useCallback(async () => {
    const id = activeConversationRef.current;
    const version = requestVersion.current;
    if (id) await loadConversationDetail(id, action => { if (version === requestVersion.current) dispatch(action); }, activeRunRef.current);
  }, []);


  const loadHistory = useCallback(async (direction: HistoryDirection, around?: string) => {
    const current = stateRef.current, id = current.activeConversationId;
    if (!id) return false;
    const version = ++historyVersion.current, roomVersion = requestVersion.current;
    const cursor = around ? {around} : direction === 'older' && current.history?.oldestSeq ? {before:current.history.oldestSeq} : direction === 'newer' && current.history?.newestSeq ? {after:current.history.newestSeq} : {};
    const page = await api.getConversationHistory(id,cursor);
    if (version !== historyVersion.current || roomVersion !== requestVersion.current || id !== activeConversationRef.current) return false;
    dispatch({ type: 'history', conversationId:id, page, direction });
    return true;
  }, []);
  const scopeKey = historyRunScope(state.runs,state.messages,state.activeConversationId,state.activeRunId).sort().join(',');
  useEffect(() => {
    const id = state.activeConversationId; if (!id) return;
    let live = true;
    void api.getConversationCollaboration(id,scopeKey ? scopeKey.split(',') : []).then(detail => { if (live) dispatch({ type:'collaborationDetail',conversationId:id,details:detail.runs }); }).catch(reason => { if (live) setLoadError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { live = false; };
  }, [state.activeConversationId,scopeKey]);
  useEffect(() => {
    const restore = () => { const location = readChatLocation(); setActiveConversation(location?.roomId ?? null, { runId: location?.runId, push: false }); };
    window.addEventListener('popstate', restore); return () => window.removeEventListener('popstate', restore);
  }, [setActiveConversation, setActiveRun]);
  useEffect(() => { if (!loading && initialized.current) writeChatLocation(state.activeConversationId, state.activeRunId, false); }, [loading, state.activeConversationId, state.activeRunId]);

  return <StoreContext.Provider value={{ state, setActiveRun, setActiveConversation, refreshConversation, loadHistory, detailsOpen, setDetailsOpen, loading, loadError, retryLoad: () => void hydrateAll() }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  return useContext(StoreContext);
}
