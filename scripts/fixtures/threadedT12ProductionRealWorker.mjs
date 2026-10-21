import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createT12TransportDiagnostics } from './threadedT12TransportDiagnostics.mjs';

// Trusted acceptance-only HTTP composition. Secret material arrives over IPC,
// remains in memory, and is never part of argv, environment, files or reports.
if (process.env.AGENT_GAND_ISOLATED_WORKER !== '1') throw new Error('Isolated worker required');
const initial = await new Promise(resolve => process.once('message', resolve));
if (initial.operation !== 'initialize' || !path.isAbsolute(initial.root ?? '') || typeof initial.apiKey !== 'string') {
  throw new Error('Explicit trusted acceptance initialization required');
}
const { root, account, version, apiKey, packFile, ledgerFile, tokenLimit, port, restore, forbiddenByAgent } = initial;
const { config } = await import('../../apps/server/src/config.ts'); config.sandboxDir = path.join(root, 'sandbox');
const { rememberSecret, redactSecrets } = await import('../../apps/server/src/accounts/secrets.ts'); rememberSecret(apiKey);
const { applyOrchestrationSchemaMigrations } = await import('../../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../../apps/server/src/threaded/authority.ts');
const { createThreadedMessaging } = await import('../../apps/server/src/threaded/messaging.ts');
const { createThreadedProduction } = await import('../../apps/server/src/threaded/production.ts');
const { loadThreadedProductionSettings } = await import('../../apps/server/src/threaded/productionSettings.ts');
const { createExecutionResourceCoordinator } = await import('../../apps/server/src/execution/resources/coordinator.ts');
const { assertResourceSessionCurrent } = await import('../../apps/server/src/execution/resources/sessions.ts');
const { verifyThreadedBackendResourceEvidence } = await import('../../apps/server/src/threaded/backends/evidence.ts');
const { threadedProcessGroupStopped } = await import('../../apps/server/src/threaded/backends/sdkProcess.ts');
const { createThreadedAccess } = await import('../../apps/server/src/threaded/access.ts');
const { createThreadedView } = await import('../../apps/server/src/threaded/view.ts');
const { registerThreadedAccessBridge, registerThreadedRoutes } = await import('../../apps/server/src/api/threadedRoutes.ts');
const management = await import('../../apps/server/src/accounts/access.ts');
const { default: Fastify } = await import('../../apps/server/node_modules/fastify/fastify.js');
const { default: websocket } = await import('../../apps/server/node_modules/@fastify/websocket/index.js');
const file = path.join(root, 'production-real.sqlite'), db = new Database(file, { timeout: 10_000 });
db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
if (!restore) {
  db.exec(readFileSync(new URL('../../apps/server/src/db/schema.sql', import.meta.url), 'utf8'));
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');
}
applyOrchestrationSchemaMigrations(db);
const instructions = 'Synthetic acceptance only. Use only the platform application tools requested by the current user message. Never use files, shell, other tools, background work, web access, or member mentions. Do not infer business approval from a self-reported SOP check. After all requested tools succeed, follow the exact short final-answer instruction. For a later memory-only request, call no tools and answer from the existing session.';
const tools = ['knowledge_publish', 'knowledge_read', 'knowledge_search', 'update_sop', 'read_sop'];
if (!restore) {
  for (const [table, row] of [['accounts', account], ['account_versions', version]]) {
    const keys = Object.keys(row); db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  const stamp = new Date().toISOString();
  // Metadata presence is real; this fixture's credential resolver is the
  // in-memory closure below. This synthetic row is never decrypted or sent.
  db.prepare('INSERT INTO account_credentials(account_id,version,key_id,ciphertext,nonce,tag,suffix,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(account.id, account.credential_version, 't12-in-memory-resolver', Buffer.from('synthetic placeholder').toString('base64'),
      Buffer.alloc(12).toString('base64'), Buffer.alloc(16).toString('base64'), 'NONE', stamp);
  for (const id of ['t12-real-api', 't12-real-sdk']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1, enabled: true,
    model: JSON.parse(version.connection).defaultModel, systemPrompt: instructions, tools, permissionMode: 'readonly',
    accountRef: account.id, requiresAccount: true }), stamp, stamp);
}
const connection = JSON.parse(version.connection), destination = new URL(connection.baseUrl);
const guard = new Database(ledgerFile, { fileMustExist: true, timeout: 10_000 });
const reserve = guard.transaction((id, description) => {
  const amount = description.inputBytes + description.maxOutputTokens + 8192;
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('T12_OPERATOR_RESERVATION_INVALID');
  const prior = guard.prepare('SELECT reserved FROM request_tokens WHERE id=?').get(id);
  if (prior) { if (prior.reserved !== amount) throw new Error('T12_OPERATOR_RESERVATION_CONFLICT'); return; }
  const used = guard.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM request_tokens').get().n;
  if (used + amount > tokenLimit) throw new Error('T12_OPERATOR_TOKEN_LIMIT');
  guard.prepare("INSERT INTO request_tokens VALUES(?,?,NULL,'reserved')").run(id, amount);
});
function settle(id, usage) {
  if (Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)) {
    guard.prepare("UPDATE request_tokens SET actual=?,state='known' WHERE id=? AND actual IS NULL")
      .run(usage.inputTokens + usage.outputTokens, id);
  }
}
let resources, requestsThisProcess = 0, foreignDestinationAttempts = 0, forbiddenInputMatches = 0;
let expectedAgent = null;
resources = createExecutionResourceCoordinator(db, { ownerNonce: `t12-production-real:${process.pid}`, leaseMs: 30_000,
  validateRequest: request => assertResourceSessionCurrent(db, request), verifyEvidence: (_request, claim, evidence) => {
    const saved = resources.getClaim(claim.claimId); return !!saved && verifyThreadedBackendResourceEvidence(db, saved, evidence);
  } });
const store = createThreadedStore(db), messaging = createThreadedMessaging(db,
  { authority: createThreadedAuthority(db, resources), repairIntervalMs: 1000 });
const settings = loadThreadedProductionSettings(db, { file: packFile, workspaceRoot: path.join(root, 'workspaces'),
  privateRoot: path.join(root, 'sdk-private'), readCredential(id, credentialVersion) {
    if (id !== account.id || credentialVersion !== account.credential_version) throw new Error('T12_ACCOUNT_SCOPE'); return apiKey;
  } });
const nativeFetch = globalThis.fetch;
const transport = createT12TransportDiagnostics({ fetch: nativeFetch, redact: redactSecrets });
// Direct egress outside the backend's guarded request adapter is forbidden.
globalThis.fetch = async () => { foreignDestinationAttempts++; throw new Error('T12_UNREGISTERED_FETCH'); };
const runtime = createThreadedProduction(db, { resources, messaging, settings, mode: () => 'execute',
  onRequestReserved: (id, description) => reserve.immediate(id, description), onRequestSettled: settle,
  fetch: async (url, init) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.origin !== destination.origin
      || !target.pathname.startsWith(destination.pathname.replace(/\/$/, '') + '/')) {
      foreignDestinationAttempts++; throw new Error('T12_DESTINATION_SCOPE');
    }
    if (typeof init.body !== 'string' || init.body.includes(apiKey)) throw new Error('T12_CREDENTIAL_IN_INPUT');
    const forbidden = forbiddenByAgent[expectedAgent];
    if (forbidden && init.body.includes(forbidden)) { forbiddenInputMatches++; throw new Error('T12_PRIVATE_SOURCE_IN_INPUT'); }
    requestsThisProcess++; process.send?.({ event: 'provider-request', sequence: requestsThisProcess, agent: expectedAgent });
    return transport.fetch(url, init);
  } });
const recoveryBefore = db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests').get().n;
const recovery = runtime.recover(); runtime.startDispatch();
const recoveryAfter = db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests').get().n;
const access = createThreadedAccess(() => store.getInstanceOwnerId());
const context = { store, access, messages: runtime.messages, lifecycle: runtime.lifecycle,
  collaboration: runtime.collaboration, operations: runtime, onMessageNotification: messaging.onNotification,
  messageAdmission: runtime.messageAdmission, view: createThreadedView(db, { store, messages: runtime.messages, capabilities: runtime.capabilities }) };
const app = Fastify({ logger: false }); await app.register(websocket);
await app.register(async accounts => {
  accounts.addHook('onRequest', async request => { management.assertManagementBoundary(request);
    if (request.routeOptions.url !== '/api/accounts/session' || request.method !== 'POST') management.requireManagementSession(request); });
  accounts.post('/api/accounts/session', async (request, reply) => management.createManagementSession(request, reply));
  await registerThreadedAccessBridge(accounts, context);
});
await registerThreadedRoutes(app, context); await app.listen({ host: '127.0.0.1', port });
function facts(messageId) {
  const row = messageId ? db.prepare(`SELECT q.preparation,q.state queue_state,q.reason queue_reason,i.id invocation_id,i.status,i.reserved_run_id run_id FROM threaded_wake_queue q
    LEFT JOIN threaded_invocations i ON i.id=q.invocation_id WHERE q.source_message_id=?`).get(messageId) : undefined;
  const invocation = row ? db.prepare('SELECT * FROM threaded_invocations WHERE id=?').get(row.invocation_id) : undefined;
  const binding = row ? db.prepare('SELECT * FROM threaded_execution_bindings WHERE invocation_id=? ORDER BY rowid DESC LIMIT 1').get(row.invocation_id) : undefined;
  const manifest = binding ? db.prepare('SELECT id,payload FROM threaded_context_manifests WHERE binding_id=? ORDER BY rowid DESC LIMIT 1').get(binding.id) : undefined;
  const attempt = binding ? db.prepare(`SELECT id,attempt_no,status,execution_stage,execution_reason,resource_release_state,
    created_at,updated_at FROM threaded_attempts WHERE id=?`).get(binding.attempt_id) : undefined;
  const backendRequests = db.prepare(`SELECT id,binding_id,authorization_id,backend,request_key,model,state,payload_included,
    delivered,input_tokens,output_tokens,cost_microusd,created_at,settled_at FROM threaded_backend_requests
    ${binding ? 'WHERE binding_id=?' : ''} ORDER BY rowid`).all(...(binding ? [binding.id] : []));
  const receipts = binding ? db.prepare('SELECT name,record FROM threaded_tool_receipts WHERE binding_id=? ORDER BY rowid').all(binding.id)
    .map(r => ({ name: r.name, ...JSON.parse(r.record) })) : [];
  const knowledgePermissions = receipts.filter(r => r.name === 'knowledge_publish').map(r => {
    const sourceIds = r.result.sourceMessageIds, otherAgent = binding.agent_id === 't12-real-api' ? 't12-real-sdk' : 't12-real-api';
    const canRead = agentId => sourceIds.every(id => !!runtime.messages.getMessage({ ownerId: binding.owner_id,
      threadId: binding.thread_id, viewer: { kind: 'agent', agentId } }, id));
    return { knowledgeId: r.result.knowledgeId, sourceMessageIds: sourceIds, authorCanRead: canRead(binding.agent_id), otherAgentCanRead: canRead(otherAgent) };
  });
  return { pid: process.pid, invocationId: row?.invocation_id, status: row?.status, runId: row?.run_id,
    invocationReason: invocation?.recovery_reason, invocationUpdatedAt: invocation?.updated_at,
    queue: row ? { state: row.queue_state, reason: row.queue_reason } : undefined, attempt,
    backendRequests, transport: transport.snapshot(), runtimeDiagnostics: runtime.diagnostics(),
    bindingId: binding?.id, resourceOwner: binding ? resources.getClaim(binding.claim_id).identity.claimOwner : undefined,
    agentId: binding?.agent_id, decision: row?.preparation ? JSON.parse(row.preparation).threadedContext?.decision : undefined,
    answer: binding ? db.prepare("SELECT body FROM threaded_messages WHERE source_attempt_id=? AND origin='agent_response'").get(binding.attempt_id)?.body : undefined,
    manifestId: manifest?.id, manifestPayload: manifest?.payload, receipts, knowledgePermissions,
    anchors: binding ? db.prepare('SELECT id,record FROM threaded_session_anchors WHERE binding_id=? ORDER BY rowid').all(binding.id) : [],
    processes: binding ? db.prepare('SELECT token,host,pid,state,created_at,stopped_at FROM threaded_backend_processes WHERE binding_id=? ORDER BY rowid').all(binding.id)
      .map(p => ({ ...p, groupStoppedAtInspection: row?.status === 'running' && p.state === 'registered' ? null : threadedProcessGroupStopped(p.pid) })) : [],
    requests: db.prepare('SELECT COUNT(*) n FROM threaded_backend_requests').get().n,
    requestsThisProcess, foreignDestinationAttempts, forbiddenInputMatches,
    budget: invocation ? runtime.budget.getUsage(invocation.causal_root_id) : undefined,
    release: runtime.release.snapshot(store.getInstanceOwnerId()), foreignKeys: db.pragma('foreign_key_check') };
}
process.on('message', async message => {
  try {
    let result;
    if (message.operation === 'phase') { expectedAgent = message.agent; result = true; }
    else if (message.operation === 'facts') result = facts(message.messageId);
    else if (message.operation === 'seed-private-history') {
      result = ['t12-real-api', 't12-real-sdk'].map(agentId => runtime.messages.acceptUserMessage({
        ownerId: store.getInstanceOwnerId(), threadId: message.threadId, clientRequestId: randomUUID(),
        body: forbiddenByAgent[agentId === 't12-real-api' ? 't12-real-sdk' : 't12-real-api'],
        targets: [], visibility: 'private', audience: [agentId] }).message.id);
    }
    else if (message.operation === 'budget') {
      const budget = runtime.budget.ensureRootForMessage(message.messageId);
      result = runtime.reviseRoot({ ownerId: budget.ownerId, rootId: budget.id, expectedVersion: budget.version,
        requestId: `t12-authorized-cost:${message.messageId}`, reason: 'Authorized T12 real acceptance; unknown price stays reserved; shared cumulative operator token cap applies',
        patch: { unknownCost: 'reserve', unknownCostReserveMicrousd: 1_000_000, maxCostMicrousd: 10_000_000 } });
    } else if (message.operation === 'close') {
      await app.close(); await runtime.shutdown(5000); access.close(); runtime.close(); guard.close(); db.close();
      process.send?.({ id: message.id, result: true }); process.disconnect(); return;
    } else throw new Error('T12_UNKNOWN_OPERATION');
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: redactSecrets(error.message) }); }
});
process.send?.({ ready: true, pid: process.pid, port, ownerId: store.getInstanceOwnerId(),
  recoveryRequests: recoveryAfter - recoveryBefore, requestsThisProcess, recovery,
  composition: 'production-factory HTTP server', actualMainIndex: false, realBackends: true });
