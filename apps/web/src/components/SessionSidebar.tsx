import { useMemo, useState } from 'react';
import type { Conversation } from '@agent-gand/shared';
import * as api from '../services/api';
import { useStore } from '../store';

const DOT: Record<string, string> = {
  pending: 'bg-amber-400', running: 'bg-sky-400 animate-pulse', awaiting_approval: 'bg-amber-400 animate-pulse',
  waiting_for_user: 'bg-violet-400 animate-pulse',
  completed: 'bg-emerald-400', failed: 'bg-red-500',
};

function relative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function SessionSidebar(props: {
  collapsed: boolean; onToggleCollapse: () => void; activeConversationId: string | null;
  onSelect: (id: string) => void; onNewSession: () => void;
}) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [title, setTitle] = useState('');
  const rooms = useMemo(() => state.conversations.filter((room) =>
    `${room.title} ${room.latestMessage ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [state.conversations, query]);

  async function saveTitle() {
    if (!renaming || !title.trim()) return setRenaming(null);
    await api.renameConversation(renaming.id, title.trim());
    setRenaming(null);
  }

  if (props.collapsed) return (
    <aside className="flex w-12 shrink-0 flex-col items-center gap-2 border-r border-zinc-800 bg-zinc-900/70 py-3">
      <button onClick={props.onToggleCollapse} className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-zinc-800" title="展开聊天室">»</button>
      <button onClick={props.onNewSession} className="rounded-lg px-2 py-1 text-violet-300 hover:bg-violet-500/15" title="新聊天室">＋</button>
    </aside>
  );

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/70">
      <div className="flex gap-2 border-b border-zinc-800 p-3">
        <button onClick={props.onNewSession} className="flex-1 rounded-lg bg-violet-500/20 px-3 py-2 text-xs text-violet-200 hover:bg-violet-500/30">＋ 新聊天室</button>
        <button onClick={props.onToggleCollapse} className="rounded-lg px-2 text-zinc-500 hover:bg-zinc-800">«</button>
      </div>
      <div className="border-b border-zinc-800 p-3">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索聊天室…"
          className="w-full rounded-lg bg-zinc-800 px-3 py-2 text-xs outline-none ring-1 ring-zinc-700 placeholder:text-zinc-600 focus:ring-violet-500" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {rooms.map((room) => {
          const active = room.id === props.activeConversationId;
          return <button key={room.id} onClick={() => props.onSelect(room.id)} onDoubleClick={() => { setRenaming(room); setTitle(room.title); }}
            className={`mb-1 w-full rounded-xl p-3 text-left ${active ? 'bg-violet-500/15 ring-1 ring-violet-500/40' : 'hover:bg-zinc-800/70'}`}>
            {renaming?.id === room.id ? <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)}
              onClick={(event) => event.stopPropagation()} onBlur={() => void saveTitle()} onKeyDown={(event) => event.key === 'Enter' && void saveTitle()}
              className="w-full rounded bg-zinc-900 px-2 py-1 text-xs outline-none ring-1 ring-violet-500" /> : <>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[room.latestRunStatus ?? ''] ?? 'bg-zinc-600'}`} />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{room.title}</span>
                <span className="text-[10px] text-zinc-600">{relative(room.updatedAt)}</span>
              </div>
              <p className="mt-1 truncate pl-4 text-[11px] text-zinc-500">{room.latestMessage ?? `${room.runCount} 轮执行`}</p>
              <div className="mt-1.5 flex gap-1.5 pl-4 text-[10px] text-zinc-600">
                <span>{room.mode === 'supervisor' ? '主管委派' : room.mode === 'collaboration' ? '自由协作' : '顺序流水线'}</span><span>·</span><span>{room.agentIds.length} 位成员</span>
              </div>
            </>}
          </button>;
        })}
        {rooms.length === 0 && <p className="pt-10 text-center text-xs text-zinc-600">暂无匹配聊天室</p>}
      </div>
    </aside>
  );
}
