interface ScrollSurface { scrollTop: number; scrollHeight: number; clientHeight: number; }
export interface ReadPosition { top: number; following: boolean; anchor?: string; offset?: number; }
export interface ReadPositionStore { get(roomId: string): ReadPosition | null; set(roomId: string, position: ReadPosition): void; }
export const browserReadPositions: ReadPositionStore = {
  get: id => { try { return JSON.parse(sessionStorage.getItem(`gand:read:${id}`) ?? 'null'); } catch { return null; } },
  set: (id, value) => { try { sessionStorage.setItem(`gand:read:${id}`, JSON.stringify(value)); } catch { /* Reading remains usable without storage. */ } },
};
/** 房间消息回填后恢复阅读锚点；收到新消息时尊重手动翻阅。 */
export class ChatScrollController {
  private roomId: string | null = null;
  private followLatest = true;
  private pendingRestore: ReadPosition | null = null;
  constructor(private readonly positions?: ReadPositionStore) {}
  get following(): boolean { return this.followLatest; }
  pauseFollowing(): void { this.followLatest = false; this.pendingRestore = null; }
  sync(roomId: string | null, surface: ScrollSurface | null, ready = true): void {
    if (!roomId) { this.roomId = null; this.followLatest = true; return; }
    if (roomId !== this.roomId) { this.roomId = roomId; this.pendingRestore = this.positions?.get(roomId) ?? null; this.followLatest = this.pendingRestore?.following ?? true; }
    if (!surface || !ready) return;
    if (this.pendingRestore && !this.followLatest) {
      const saved = this.pendingRestore;
      const element = typeof HTMLElement !== 'undefined' && surface instanceof HTMLElement ? document.getElementById(saved.anchor ?? '') : null;
      surface.scrollTop = element && surface instanceof HTMLElement ? surface.scrollTop + element.getBoundingClientRect().top - surface.getBoundingClientRect().top - (saved.offset ?? 0) : saved.top;
    } else if (this.followLatest) surface.scrollTop = surface.scrollHeight;
    this.pendingRestore = null;
  }
  onScroll(surface: ScrollSurface, allowFollow = true): void {
    if (this.pendingRestore) return;
    this.followLatest = allowFollow && surface.scrollHeight - surface.scrollTop - surface.clientHeight < 100;
    if (!this.roomId) return;
    let anchor: string | undefined, offset: number | undefined;
    if (typeof HTMLElement !== 'undefined' && surface instanceof HTMLElement) {
      const top = surface.getBoundingClientRect().top;
      const item = Array.from(surface.querySelectorAll<HTMLElement>('[data-read-anchor]')).find(el => el.getBoundingClientRect().bottom > top);
      if (item) { anchor = item.id; offset = item.getBoundingClientRect().top - top; }
    }
    this.positions?.set(this.roomId, { top: surface.scrollTop, following: this.followLatest, anchor, offset });
  }
  jumpToLatest(surface: ScrollSurface): void { this.followLatest = true; surface.scrollTop = surface.scrollHeight; this.onScroll(surface); }
}
