interface ScrollSurface {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 聊天区滚动策略：换房间先等待异步消息回填，同房间尊重用户手动翻阅。 */
export class ChatScrollController {
  private roomId: string | null = null;
  private followLatest = true;

  sync(roomId: string | null, surface: ScrollSurface | null): void {
    if (!roomId) {
      this.roomId = null;
      this.followLatest = true;
      return;
    }
    if (this.roomId !== roomId) {
      this.roomId = roomId;
      this.followLatest = true;
    }
    if (surface && this.followLatest) surface.scrollTop = surface.scrollHeight;
  }

  onScroll(surface: ScrollSurface): void {
    this.followLatest = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 220;
  }
}
