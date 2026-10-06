/**
 * 启动入口（规格 §4.2 index.ts）
 * config → db（database.ts import 时自初始化）→ registry 同步 → seed → fastify(cors, ws, routes) → listen
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocketPlugin from '@fastify/websocket';
import { config } from './config.ts';
import { closeDatabase, db } from './db/database.ts';
import { migrateRoomPreferences } from './db/orchestrationMigrations.ts';
import * as registry from './agents/registry.ts';
import { registerRoutes } from './api/routes.ts';
import { registerAccountRoutes } from './api/accountRoutes.ts';
import { registerWs } from './api/ws.ts';
import { seed } from './seed.ts';
import { recoverInterruptedTasks } from './messaging/tasks.ts';
import { interruptRunningAttempts } from './tasks/attempts.ts';
import { backfillConversations } from './conversations/service.ts';
import { backfillRunAgentSnapshots } from './runs/trace.ts';
import { recoverPendingConversationRuns } from './conversations/dispatcher.ts';
import { closeMcp, refreshMcpTools } from './tools/mcp/client.ts';
import { interruptExpiredAttempts } from './collaboration/store.ts';
import { recoverCollaborationRuns, sweepCollaborationLeases } from './collaboration/scheduler.ts';
import { recoverDurableHolds, recoverDurableRuns } from './runs/recovery.ts';
import { recoverInterruptedCoordinationSteps } from './coordination/store.ts';
import { shutdownExternalAgents } from './execution/runner.ts';
import { recoverExternalExecutions } from './execution/recovery.ts';
import { recoverAccountLogins, shutdownAccountLogins } from './accounts/login.ts';
import { recoverAccountTests, shutdownAccountTests } from './accounts/actions.ts';
import { claimRuntimeHost, releaseRuntimeHost } from './execution/host.ts';
import { recoverMemberAdmissions } from './execution/memberAdmission.ts';
import { reopenInterruptedTaskResponsibilities } from './runtime/taskAdapter.ts';

claimRuntimeHost();

const app = Fastify({ logger: { level: config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] } });
await app.register(cors, { origin: config.accounts.trustedOrigins, credentials: true });
await app.register(websocketPlugin);
await app.register((instance) => registerRoutes(instance));
await registerAccountRoutes(app);
await app.register((instance) => registerWs(instance));

const mcp = await refreshMcpTools();
if (mcp.configured && !mcp.connected) app.log.warn(`MCP 初始化失败，稍后可刷新重试: ${mcp.lastError}`);
const agents = registry.syncFromFiles();
backfillRunAgentSnapshots();
seed();
backfillConversations();
const preferenceMigration = migrateRoomPreferences(db);
app.log.info({ preferenceMigration }, '编排房间默认偏好迁移完成');

// 新进程接管：关闭旧 attempt，重新排队遗留任务，并恢复主管调度。
await recoverAccountLogins();
await recoverAccountTests();
await recoverExternalExecutions();
recoverMemberAdmissions();
interruptRunningAttempts();
reopenInterruptedTaskResponsibilities();
interruptExpiredAttempts({ onlyExpired: true });
recoverInterruptedTasks();
recoverInterruptedCoordinationSteps();
recoverPendingConversationRuns();
recoverDurableHolds();
recoverCollaborationRuns();
recoverDurableRuns();

await app.listen({ port: config.port, host: config.host });
app.log.info(`agent-gand server 就绪: http://localhost:${config.port}（agents=${agents.length}）`);
const collaborationLeaseTimer = setInterval(sweepCollaborationLeases, Math.max(1_000, Math.floor(config.collaboration.attemptLeaseMs / 3)));
collaborationLeaseTimer.unref();
const durableHoldTimer = setInterval(recoverDurableHolds, 1_000);
durableHoldTimer.unref();

// graceful 退出
async function shutdown(signal: string): Promise<void> {
  clearInterval(collaborationLeaseTimer);
  clearInterval(durableHoldTimer);
  app.log.info(`收到 ${signal}，正在关闭…`);
  await Promise.all([shutdownAccountTests(), shutdownAccountLogins(), shutdownExternalAgents()]);
  await app.close();
  await closeMcp();
  releaseRuntimeHost();
  closeDatabase();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
