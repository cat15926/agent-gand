/** URL 优先，其次恢复本浏览器最后查看的房间。new 表示明确的新房间草稿。 */
export function readChatLocation(): { roomId: string | null; runId: string | null } | null {
  const url = new URL(window.location.href);
  if (url.searchParams.has('room')) return { roomId: url.searchParams.get('room') === 'new' ? null : url.searchParams.get('room'), runId: url.searchParams.get('task') };
  try { const value = JSON.parse(localStorage.getItem('gand:chat-location') ?? 'null'); return value && (value.roomId === null || typeof value.roomId === 'string') && (value.runId === null || typeof value.runId === 'string') ? value : null; } catch { return null; }
}
export function writeChatLocation(roomId: string | null, runId: string | null, push = true): void {
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomId ?? 'new');
  if (roomId && runId) url.searchParams.set('task', runId); else url.searchParams.delete('task');
  if (url.href !== window.location.href) window.history[push ? 'pushState' : 'replaceState'](null, '', url);
  try { localStorage.setItem('gand:chat-location', JSON.stringify({ roomId, runId })); } catch { /* URL works without storage. */ }
}
