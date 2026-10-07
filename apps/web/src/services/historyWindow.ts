import type { ConversationHistoryPage, Message, Run } from '@agent-gand/shared';

export const HISTORY_WINDOW_LIMIT = 160;
export type HistoryMetadata = Omit<ConversationHistoryPage, 'messages'>;
export type HistoryDirection = 'replace' | 'older' | 'newer';
export function mergeHistory(messages: Message[], previous: HistoryMetadata | null, page: ConversationHistoryPage, direction: HistoryDirection) {
  const byId = new Map((direction === 'replace' ? [] : messages).map(message => [message.id,message]));
  page.messages.forEach(message => byId.set(message.id,message));
  // REST 快照读取后、详情回填前到达的 WS 消息仍属于最新页。
  if (direction === 'replace' && !page.hasNewer) messages.filter(message => message.seq>page.headSeq).forEach(message => byId.set(message.id,message));
  const merged = [...byId.values()].sort((a,b) => a.seq-b.seq);
  const window = direction === 'older' ? merged.slice(0,HISTORY_WINDOW_LIMIT) : merged.slice(-HISTORY_WINDOW_LIMIT);
  const oldestSeq = window[0]?.seq ?? null, newestSeq = window.at(-1)?.seq ?? null;
  const references = [...new Map([...(previous?.references ?? []),...page.references].map(ref => [ref.id,ref])).values()].filter(ref => window.some(message => message.replyTo === ref.id));
  const headSeq = Math.max(page.headSeq,previous?.headSeq ?? 0,newestSeq ?? 0);
  return { messages: window, history: { references, oldestSeq, newestSeq, headSeq, total: Math.max(page.total+(direction === 'replace' && !page.hasNewer ? messages.filter(message => message.seq>page.headSeq).length : 0),previous?.total ?? 0),
    hasOlder: oldestSeq !== null && (direction === 'replace' ? page.hasOlder : direction === 'older' ? page.hasOlder : Boolean(previous?.hasOlder) || merged.length > window.length),
    hasNewer: newestSeq !== null && newestSeq < headSeq } };
}
export function historyRunScope(runs: Run[], messages: Message[], roomId: string | null, selectedId: string | null): string[] {
  const visible = new Set(messages.map(message => message.runId));
  return runs.filter(run => run.conversationId === roomId && (visible.has(run.id) || run.id === selectedId || !['completed','failed','cancelled'].includes(run.status))).map(run => run.id);
}
