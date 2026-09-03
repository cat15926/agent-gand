/**
 * 全局状态：初始 hydrate（REST）+ 增量更新（WS 事件）
 * 只保留 activeRun 的 messages/events 明细，避免长任务内存膨胀
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type {
  AgentDefinition,
  ApprovalRequest,
  Message,
  Run,
  RunEvent,
  ServerEvent,
  Task,
  UsageSummary,
} from '@agent-gand/shared';
import * as api from './services/api';
import { armPermissionRequest, notifyApproval } from './services/notify';
import { onServerEvent, onWsStatus } from './services/ws';

export interface State {
  wsConnected: boolean;
  agents: AgentDefinition[];
  runs: Run[];
  activeRunId: string | null;
  messages: Message[];
  events: RunEvent[];
  tasks: Task[];
  approvals: ApprovalRequest[];
  usage: UsageSummary[];
  /** 活动 llm span 的流式增量累积（spanId → 已到文本；span 结束即折叠清除，§8.1） */
  streams: Record<string, string>;
}

type Action =
  | { type: 'ws'; connected: boolean }
  | { type: 'hydrate'; runs: Run[]; agents: AgentDefinition[]; tasks: Task[]; approvals: ApprovalRequest[]; usage: UsageSummary[] }
  | { type: 'agents'; agents: AgentDefinition[] }
  | { type: 'runDetail'; runId: string; messages: Message[]; events: RunEvent[] }
  | { type: 'setActiveRun'; runId: string | null }
  | { type: 'serverEvent'; event: ServerEvent };

const initialState: State = {
  wsConnected: false,
  agents: [],
  runs: [],
  activeRunId: null,
  messages: [],
  events: [],
  tasks: [],
  approvals: [],
  usage: [],
  streams: {},
};

function upsertBy<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const next = [...list];
  next[idx] = item;
  return next;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ws':
      return { ...state, wsConnected: action.connected };
    case 'hydrate':
      // 显式取字段，避免把 action.type 泄进 state（inspector P3）
      return {
        ...state,
        runs: action.runs,
        agents: action.agents,
        tasks: action.tasks,
        approvals: action.approvals,
        usage: action.usage,
      };
    case 'agents':
      return { ...state, agents: action.agents };
    case 'setActiveRun':
      return { ...state, activeRunId: action.runId, messages: [], events: [], streams: {} };
    case 'runDetail':
      // hydrate 回补后重置流式段落（span 终态以 runDetail 为准；增量丢失可容忍，§8.1）
      return { ...state, messages: action.messages, events: action.events, streams: {} };
    case 'serverEvent': {
      const e = action.event;
      switch (e.type) {
        case 'message':
          return e.message.runId === state.activeRunId
            ? { ...state, messages: [...state.messages, e.message] }
            : state;
        case 'llm.delta':
          // 流式增量只累积当前活动 run（其他 run 的 span 明细本就不维护）
          return e.runId === state.activeRunId
            ? {
                ...state,
                streams: { ...state.streams, [e.spanId]: (state.streams[e.spanId] ?? '') + e.text },
              }
            : state;
        case 'run.event': {
          if (e.event.runId !== state.activeRunId) return state;
          // span 结束（endedAt 非空）→ 流式段落折叠（正式消息/终态 output 随后到达）
          const streams =
            e.event.endedAt !== null && state.streams[e.event.id] !== undefined
              ? Object.fromEntries(Object.entries(state.streams).filter(([id]) => id !== e.event.id))
              : state.streams;
          return { ...state, events: [...state.events, e.event], streams };
        }
        case 'task.updated':
          return { ...state, tasks: upsertBy(state.tasks, e.task) };
        case 'run.updated':
          return { ...state, runs: upsertBy(state.runs, e.run) };
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

async function loadRunDetail(runId: string, dispatch: (a: Action) => void): Promise<void> {
  const detail = await api.getRun(runId);
  dispatch({ type: 'runDetail', runId, messages: detail.messages, events: detail.events });
}

const StoreContext = createContext<{ state: State; setActiveRun: (id: string | null) => void }>({
  state: initialState,
  setActiveRun: () => {},
});

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const activeRunRef = useRef(state.activeRunId);
  activeRunRef.current = state.activeRunId;

  /** 全量刷新列表；断线重连后也调用，回补断连期间丢失的增量（inspector P2） */
  const hydrateAll = useCallback(async () => {
    const [agents, runs, tasks, approvals, usage] = await Promise.all([
      api.getAgents(),
      api.getRuns(),
      api.getTasks(),
      api.getApprovals(),
      api.getUsage(),
    ]);
    dispatch({ type: 'hydrate', runs, agents, tasks, approvals, usage });

    const current = activeRunRef.current;
    if (current) {
      // 有活动 run：回补其消息/事件明细
      await loadRunDetail(current, dispatch);
    } else {
      const latest = runs.at(-1);
      if (latest) {
        dispatch({ type: 'setActiveRun', runId: latest.id });
        await loadRunDetail(latest.id, dispatch);
      }
    }
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
    });
    return () => {
      offStatus();
      offEvents();
    };
  }, [hydrateAll]);

  const setActiveRun = useCallback(
    (id: string | null) => {
      dispatch({ type: 'setActiveRun', runId: id });
      if (id) void loadRunDetail(id, dispatch);
    },
    [],
  );

  return <StoreContext.Provider value={{ state, setActiveRun }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  return useContext(StoreContext);
}
