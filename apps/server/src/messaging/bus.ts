/**
 * 进程内事件总线（规格 §4.2 messaging/bus.ts）
 * ws.ts 订阅后向浏览器全量转发 ServerEvent
 */
import type { ServerEvent } from '@agent-gand/shared';

export type BusListener = (event: ServerEvent) => void;

const listeners = new Set<BusListener>();

export function subscribe(fn: BusListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function emit(event: ServerEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // 单个监听器异常不影响其他订阅者（ws 断连等）
    }
  }
}
