/**
 * 启动入口（规格 §4.2 index.ts）
 * config → db（database.ts import 时自初始化）→ registry 同步 → seed → fastify(cors, ws, routes) → listen
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { config } from './config.ts';
import { closeDatabase } from './db/database.ts';
import * as registry from './agents/registry.ts';
import { registerRoutes } from './api/routes.ts';
import { registerWs } from './api/ws.ts';
import { seed } from './seed.ts';

const app = Fastify({ logger: { level: config.logLevel } });
await app.register(cors, { origin: true });
await app.register(websocketPlugin);
await app.register((instance) => registerRoutes(instance));
await app.register((instance) => registerWs(instance));

const agents = registry.syncFromFiles();
seed();

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`agent-gand server 就绪: http://localhost:${config.port}（agents=${agents.length}）`);

// graceful 退出
async function shutdown(signal: string): Promise<void> {
  app.log.info(`收到 ${signal}，正在关闭…`);
  await app.close();
  closeDatabase();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
