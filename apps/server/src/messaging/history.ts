import type { ConversationHistoryPage, ConversationMessageSearch, MessageReference, MessageSearchMatch } from '@agent-gand/shared';
import { all, get } from '../db/database.ts';
import { historyRowsToMessages } from './inbox.ts';

export class HistoryInputError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
function integer(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new HistoryInputError('历史游标与数量必须是正整数');
  return Number(value);
}
export function historyRunIds(raw?: string): Set<string> | null {
  if (raw === undefined) return null;
  const ids = raw.split(',');
  if (!ids.length || ids.length > 200 || ids.some(id => !/^[a-zA-Z0-9-]{1,80}$/.test(id))) throw new HistoryInputError('任务筛选参数无效');
  return new Set(ids);
}
export function conversationHistoryPage(id: string, query: { limit?: string; before?: string; after?: string; around?: string } = {}): ConversationHistoryPage {
  const limit = integer(query.limit,80)!;
  if (limit > 100) throw new HistoryInputError('每次最多读取 100 条消息');
  const before = integer(query.before), after = integer(query.after);
  if ([before,after,query.around].filter(value => value !== undefined).length > 1) throw new HistoryInputError('一次只能使用一个历史定位游标');
  const read = (condition: string, cursor: number | undefined, count: number, direction: 'ASC' | 'DESC') => historyRowsToMessages(
    all(`SELECT * FROM messages WHERE conversation_id=? ${condition} ORDER BY seq ${direction} LIMIT ?`,id,...(cursor === undefined ? [] : [cursor]),count));
  let messages;
  if (query.around !== undefined) {
    if (!query.around || query.around.length > 80) throw new HistoryInputError('消息定位参数无效');
    const anchor = get<{seq:number}>('SELECT seq FROM messages WHERE conversation_id=? AND id=?',id,query.around);
    if (!anchor) throw new HistoryInputError('原消息不存在或不属于当前房间',404);
    const older = read('AND seq<=?',anchor.seq,Math.ceil(limit/2),'DESC').reverse();
    const newer = read('AND seq>?',anchor.seq,limit-older.length,'ASC');
    // 靠近结尾时补足前面的历史。
    messages = newer.length + older.length < limit ? read('AND seq<=?',newer.at(-1)?.seq ?? anchor.seq,limit,'DESC').reverse() : [...older,...newer];
  } else if (after !== undefined) messages = read('AND seq>?',after,limit,'ASC');
  else messages = read(before === undefined ? '' : 'AND seq<?',before,limit,'DESC').reverse();
  const oldestSeq = messages[0]?.seq ?? null, newestSeq = messages.at(-1)?.seq ?? null;
  const stats = get<{total:number;headSeq:number}>('SELECT COUNT(*) total,COALESCE(MAX(seq),0) headSeq FROM messages WHERE conversation_id=?',id)!;
  const replyIds = [...new Set(messages.map(m => m.replyTo).filter((value):value is string => Boolean(value) && !messages.some(m => m.id === value)))];
  const references = replyIds.length ? all<MessageReference>(`SELECT id,run_id runId,seq,from_agent AS "from",substr(body,1,160) body FROM messages WHERE conversation_id=? AND id IN (${replyIds.map(() => '?').join(',')})`,id,...replyIds) : [];
  return { messages,references,oldestSeq,newestSeq,...stats,
    hasOlder: oldestSeq !== null && Boolean(get('SELECT id FROM messages WHERE conversation_id=? AND seq<? LIMIT 1',id,oldestSeq)),
    hasNewer: newestSeq !== null && Boolean(get('SELECT id FROM messages WHERE conversation_id=? AND seq>? LIMIT 1',id,newestSeq)) };
}
export function searchConversationMessages(id: string, query: { q?: string; after?: string; limit?: string; scope?: string }): ConversationMessageSearch {
  const q = query.q?.trim() ?? '', limit = integer(query.limit,30)!, after = integer(query.after,0)!;
  if (limit > 100 || q.length > 200 || (query.scope !== undefined && query.scope !== 'results') || (!q && query.scope !== 'results')) throw new HistoryInputError('请提供有效的搜索词或成果筛选，每次最多 100 条');
  const condition = `${query.scope === 'results' ? " AND kind='agent' AND message_type IN ('result','collaboration_result','review_result')" : ''}${q ? ' AND instr(lower(body),?)>0' : ''}`;
  const params = [id,...(q ? [q.toLowerCase()] : [])];
  const total = get<{n:number}>(`SELECT COUNT(*) n FROM messages WHERE conversation_id=?${condition}`,...params)!.n;
  const rows = all<MessageSearchMatch>(`SELECT id,run_id runId,seq,from_agent AS "from",message_type messageType,created_at createdAt,
    substr(body,${q ? 'MAX(1,instr(lower(body),?)-40)' : '1'},200) body FROM messages WHERE conversation_id=?${condition} AND seq>? ORDER BY seq ASC LIMIT ?`,...(q ? [q.toLowerCase()] : []),...params,after,limit+1);
  const matches = rows.slice(0,limit);
  return { matches,total,nextAfter: rows.length > limit ? matches.at(-1)!.seq : null };
}
