import { useEffect, useRef, useState } from 'react';
import type { ConversationMessageSearch } from '@agent-gand/shared';
import * as api from '../services/api';
import { useStore } from '../store';
import { Drawer } from './Drawer';
import { RunWorkspaceCard } from './RunExecutionDetails';

export function RoomResults({ roomId, open, onClose, onLocate }: { roomId: string; open: boolean; onClose: () => void; onLocate: (id:string) => Promise<boolean> }) {
  const { state } = useStore();
  const [page, setPage] = useState<ConversationMessageSearch | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const [cursors,setCursors] = useState<number[]>([]);
  useEffect(() => {
    generation.current++;
    if (!open) return;
    const controller = new AbortController(); setBusy(true); setError(''); setPage(null); setCursors([]);
    void api.searchConversationMessages(roomId,{scope:'results'},controller.signal).then(setPage).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { generation.current++; controller.abort(); };
  },[roomId,open,retry]);
  async function more(previous = false) {
    if (!page?.nextAfter && !previous) return;
    const token = generation.current;
    const after = previous ? cursors.at(-2) : page?.nextAfter;
    setBusy(true); setError('');
    try { const next = await api.searchConversationMessages(roomId,{scope:'results',...(after ? {after} : {})}); if (token !== generation.current) return; setPage(next); setCursors(current => previous ? current.slice(0,-1) : [...current,after ?? 0]); }
    catch (reason) { if (token === generation.current) setError(reason instanceof Error ? reason.message : String(reason)); } finally { if (token === generation.current) setBusy(false); }
  }
  const selected = state.runs.find(run => run.id === state.activeRunId && run.conversationId === roomId);
  return <Drawer open={open} title="房间成果" onClose={onClose}><div className="space-y-3 p-4">
    <p className="text-xs text-zinc-400">所有轮次的任务结果与审查结论。点击摘要定位完整消息。</p>
    {selected?.workspace?.startsWith('ext:') && <RunWorkspaceCard runId={selected.id} revision={selected.status} />}
    {error && <div role="alert" className="text-sm text-red-300">{error}<button onClick={() => setRetry(n => n+1)} className="ml-2 underline">重试</button></div>}
    <p className="text-xs text-zinc-400">{page ? `共 ${page.total} 条成果消息` : ''}</p>
    {page?.matches.map(message => <button key={message.id} disabled={busy} onClick={async () => { if (await onLocate(message.id)) onClose(); }} className="block w-full rounded-xl border border-zinc-700 bg-zinc-950/40 p-3 text-left hover:border-violet-400">
      <span className="text-xs text-violet-200">第 {state.runs.find(run => run.id === message.runId)?.turnNo ?? '—'} 轮 · {message.messageType === 'review_result' ? '审查结论' : '任务结果'} · {state.agents.find(agent => agent.id === message.from)?.name ?? message.from}</span>
      <span className="mt-2 block whitespace-pre-wrap break-words text-sm text-zinc-300">{message.body}</span>
    </button>)}
    {busy && <p role="status" className="text-sm text-zinc-400">正在加载成果…</p>}
    {page?.total === 0 && <p className="text-sm text-zinc-400">尚无任务结果或审查结论。</p>}
    {cursors.length > 0 && <button disabled={busy} onClick={() => void more(true)} className="w-full rounded-lg bg-zinc-800 p-3 text-sm disabled:opacity-40">上一页成果</button>}
    {page?.nextAfter && <button disabled={busy} onClick={() => void more()} className="w-full rounded-lg bg-zinc-800 p-3 text-sm disabled:opacity-40">下一页成果</button>}
  </div></Drawer>;
}
