// A disposable host using product HTTP/WS routes and startup recovery. All inference is mocked.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const { default: Fastify } = await import('../../apps/server/node_modules/fastify/fastify.js');
const { default: websocketPlugin } = await import('../../apps/server/node_modules/@fastify/websocket/index.js');
const { config } = await import('../../apps/server/src/config.ts');
const db = await import('../../apps/server/src/db/database.ts');
const registry = await import('../../apps/server/src/agents/registry.ts');
const trace = await import('../../apps/server/src/runs/trace.ts');
const { registerRoutes } = await import('../../apps/server/src/api/routes.ts');
const { registerAccountRoutes } = await import('../../apps/server/src/api/accountRoutes.ts');
const { registerWs } = await import('../../apps/server/src/api/ws.ts');
const { mockProvider } = await import('../../apps/server/src/llm/provider.ts');
const { claimRuntimeHost, releaseRuntimeHost } = await import('../../apps/server/src/execution/host.ts');
const { shutdownExternalAgents } = await import('../../apps/server/src/execution/runner.ts');
const { recoverMemberAdmissions } = await import('../../apps/server/src/execution/memberAdmission.ts');
const { interruptExpiredAttempts } = await import('../../apps/server/src/collaboration/store.ts');
const { recoverCollaborationRuns } = await import('../../apps/server/src/collaboration/scheduler.ts');
const { recoverInterruptedCoordinationSteps } = await import('../../apps/server/src/coordination/store.ts');
const { recoverDurableRuns, recoverDurableHolds } = await import('../../apps/server/src/runs/recovery.ts');
const { recoverPendingConversationRuns } = await import('../../apps/server/src/conversations/dispatcher.ts');
const { recoverInterruptedTasks } = await import('../../apps/server/src/messaging/tasks.ts');
const { interruptRunningAttempts } = await import('../../apps/server/src/tasks/attempts.ts');
const { reopenInterruptedTaskResponsibilities } = await import('../../apps/server/src/runtime/taskAdapter.ts');
globalThis.fetch = () => { throw new Error('Network fixture must not request a supplier'); };
config.sandboxDir = path.join(process.env.R1_FIXTURE_ROOT, 'sandbox');
claimRuntimeHost();
for (const id of ['network-a', 'network-b']) if (!registry.getAnyAgent(id)) registry.createAgent({ id, name: id,
  description: 'network fixture', systemPrompt: 'Give an actual readonly analysis.', model: 'mock:network', permissionMode: 'readonly',
  capabilities: ['execute'], tools: [], disallowedTools: [], color: '#4477aa', avatar: '' });
const calls = () => existsSync(process.env.R1_CALL_LOG) ? readFileSync(process.env.R1_CALL_LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
mockProvider.chat = async (request, delta) => {
  const text = request.messages.map(item => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
  const scenario = text.includes('R1_NETWORK_CRASH') ? 'crash' : text.includes('R1_NETWORK_TIMEOUT') ? 'timeout' : 'success';
  appendFileSync(process.env.R1_CALL_LOG, JSON.stringify({ scenario, at: new Date().toISOString() }) + '\n');
  delta?.('已收到模型的可信活动。'); request.onActivity?.('reasoning');
  if (scenario === 'crash') return new Promise(() => {});
  if (scenario === 'timeout') return new Promise(resolve => setTimeout(() => {
    delta?.('R1_LATE_CALLBACK'); request.onActivity?.('text');
    resolve({ content: 'R1_LATE_CALLBACK', toolCalls: [], usage: { tokensIn: 2, tokensOut: 4, costUsd: 0 }, stopReason: 'end_turn', truncated: false });
  }, 700));
  const control = request.tools?.some(tool => tool.name === 'agent.complete');
  return { content: '分析已完成：列出依据、执行边界和可核对的结论。', toolCalls: control ? [{ id: 'fixture-complete', name: 'agent.complete', input: JSON.stringify({ summary: '已完成分析并提供可核对结论。' }) }] : [],
    usage: { tokensIn: 2, tokensOut: 4, costUsd: 0 }, stopReason: control ? 'tool_use' : 'end_turn', truncated: false };
};
// Same recovery sequence as the host entry for relevant builtin work; no external process exists in this fixture.
recoverMemberAdmissions(); interruptRunningAttempts(); reopenInterruptedTaskResponsibilities();
interruptExpiredAttempts({ onlyExpired: true }); recoverInterruptedTasks(); recoverInterruptedCoordinationSteps();
recoverPendingConversationRuns(); recoverDurableHolds(); recoverCollaborationRuns(); recoverDurableRuns();
const app = Fastify(); await app.register(websocketPlugin);
await registerRoutes(app); await registerAccountRoutes(app); await registerWs(app);
app.get('/fixture/state', async () => ({ calls: calls(), runs: trace.listRuns(), controls: db.all('SELECT * FROM orchestration_run_controls'),
  pendingReservations: db.all("SELECT run_id,status,reserved FROM orchestration_token_reservations WHERE status IN ('pending','unknown')") }));
const dist = path.resolve('apps/web/dist');
app.get('/', async (_req, reply) => reply.type('text/html').send(await readFile(path.join(dist, 'index.html'))));
app.get('/assets/:name', async (req, reply) => {
  if (!/^[a-zA-Z0-9._-]+$/.test(req.params.name)) return reply.code(404).send();
  const type = req.params.name.endsWith('.css') ? 'text/css' : 'application/javascript';
  return reply.type(type).send(await readFile(path.join(dist, 'assets', req.params.name)));
});
await app.listen({ port: Number(process.env.R1_FIXTURE_PORT ?? 0), host: '127.0.0.1' });
const port = app.server.address().port; config.port = port;
config.accounts.trustedOrigins = [`http://127.0.0.1:${port}`];
process.send?.({ type: 'ready', port });
async function close() { await shutdownExternalAgents(); await app.close(); releaseRuntimeHost(); db.closeDatabase(); process.exit(0); }
process.once('SIGTERM', () => void close()); process.once('SIGINT', () => void close());
