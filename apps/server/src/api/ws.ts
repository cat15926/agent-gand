/**
 * WebSocket 推送（规格 §4.2 api/ws.ts）
 * 旧模式连接即发 hello；Threaded 只走独立鉴权通道。
 */
import type { FastifyInstance } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';
import * as registry from '../agents/registry.ts';
import { subscribe } from '../messaging/bus.ts';
import { listRuns } from '../runs/trace.ts';
import { isLegacyEvent, isThreadedRun } from '../threaded/legacyBoundary.ts';

export async function registerWs(app: FastifyInstance): Promise<void> {
  const handler: WebsocketHandler = (socket) => {
    socket.send(
      JSON.stringify({ type: 'hello', agents: registry.list(), runs: listRuns().filter(item => !isThreadedRun(item.id)).length }),
    );
    const unsubscribe = subscribe((event) => {
      if (!isLegacyEvent(event)) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // 连接已断开：由 close 回调统一退订
      }
    });
    socket.on('close', () => unsubscribe());
  };
  app.get('/ws', { websocket: true }, handler);
}
