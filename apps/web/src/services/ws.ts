/**
 * WS 客户端：连接 /ws，自动重连，把 ServerEvent 分发给订阅者（P0-6）
 */
import type { ServerEvent } from '@agent-gand/shared';

export type Unsubscribe = () => void;

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(event: ServerEvent) => void>();
const statusListeners = new Set<(connected: boolean) => void>();

function dispatch(event: ServerEvent): void {
  for (const fn of listeners) fn(event);
}

function setStatus(connected: boolean): void {
  for (const fn of statusListeners) fn(connected);
}

function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.onopen = () => setStatus(true);
  socket.onmessage = (raw) => {
    try {
      dispatch(JSON.parse(String(raw.data)) as ServerEvent);
    } catch {
      // 非 JSON 帧忽略（scaffold 容错）
    }
  };
  socket.onclose = () => {
    setStatus(false);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 1500); // 断线 1.5s 自动重连
  };
  socket.onerror = () => socket?.close();
}

/** 订阅服务端事件；返回退订函数 */
export function onServerEvent(fn: (event: ServerEvent) => void): Unsubscribe {
  listeners.add(fn);
  connect();
  return () => listeners.delete(fn);
}

/** 订阅连接状态；返回退订函数 */
export function onWsStatus(fn: (connected: boolean) => void): Unsubscribe {
  statusListeners.add(fn);
  connect();
  fn(socket?.readyState === WebSocket.OPEN);
  return () => statusListeners.delete(fn);
}
