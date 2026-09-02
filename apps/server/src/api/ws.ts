/**
 * WebSocket 推送（规格 §4.2 api/ws.ts）
 * 连接即发 hello；订阅 bus 全量转发 ServerEvent
 * TODO: 心跳保活、鉴权、按 runId 过滤订阅
 */
import type { FastifyInstance } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';
import * as registry from '../agents/registry.ts';
import { subscribe } from '../messaging/bus.ts';
import { listRuns } from '../runs/trace.ts';

export async function registerWs(app: FastifyInstance): Promise<void> {
  const handler: WebsocketHandler = (socket) => {
    socket.send(
      JSON.stringify({ type: 'hello', agents: registry.list(), runs: listRuns().length }),
    );
    const unsubscribe = subscribe((event) => {
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
