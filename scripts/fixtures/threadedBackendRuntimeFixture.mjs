import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

/** Call only after setting ISOLATED_WORKER/DB_PATH; all persisted execution state is temporary. */
export async function openBackendRuntimeFixture(root, name, options = {}) {
  const { config } = await import('../../apps/server/src/config.ts');
  config.sandboxDir = path.join(root, 'sandbox');
  const { applyOrchestrationSchemaMigrations, assertOrchestrationSchemaCompatible } = await import('../../apps/server/src/db/orchestrationMigrations.ts');
  const { createThreadedStore } = await import('../../apps/server/src/threaded/store.ts');
  const { createExecutionResourceCoordinator } = await import('../../apps/server/src/execution/resources/coordinator.ts');
  const { assertResourceSessionCurrent } = await import('../../apps/server/src/execution/resources/sessions.ts');
  const { verifyThreadedBackendResourceEvidence } = await import('../../apps/server/src/threaded/backends/evidence.ts');
  const { createThreadedBackendRuntime } = await import('../../apps/server/src/threaded/backendRuntime.ts');
  const file = path.join(root, `${name}.sqlite`), db = new Database(file, { timeout: 10_000 });
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
  if(!options.restore){db.exec(readFileSync(new URL('../../apps/server/src/db/schema.sql', import.meta.url), 'utf8'));
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');}
  applyOrchestrationSchemaMigrations(db);
  const stamp = new Date().toISOString();
  if (options.account&&!options.restore) {
    for (const [table, rows] of Object.entries(options.account.rows)) for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    }
  }
  const agentIds = options.agentIds ?? ['api-member', 'sdk-member', 'other-member'];
  if(!options.restore)for (const id of agentIds) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'threaded-t07-isolated',?,?)`).run(id, id, JSON.stringify({ id, name: id, version: 1, enabled: true,
      model: options.model ?? 'fixture-model', systemPrompt: options.instructions ?? 'Reply concisely. Never use tools.', tools: options.applicationTools ?? [], permissionMode: 'readonly',
      ...(options.account ? { accountRef: options.account.id, requiresAccount: true } : {}) }), stamp, stamp);
  const store = createThreadedStore(db);
  const thread = options.restore?store.listThreads(store.getInstanceOwnerId())[0]:store.createThread({ title: name, members: agentIds.map(agentId => ({
    agentId, handle: agentId, roleVersion: 1, permissionVersion: 1,
  })) });
  if(!thread)throw new Error('RESTORE_THREAD_REQUIRED');
  if(!options.restore)db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  const workspace = path.join(root, 'sandbox', name, 'workspace');
  const configDir = path.join(root, name, 'sdk-home');
  mkdirSync(workspace, { recursive: true }); mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configurations = new Map(agentIds.map(id => [id, {
    kind: id === 'sdk-member' ? 'claude-sdk' : 'api', backendVersion: id === 'sdk-member' ? '0.3.288' : 'threaded-http-v1',
    model: options.model ?? 'fixture-model', instructions: options.instructions ?? 'Reply concisely. Never use tools.', workspace, configDir,
    applicationTools:options.applicationTools ?? [],
    informationBoundary: 'threaded-ordinary-v1', contextBudget: { maxInputTokens: 250_000, reservedSystemTokens: 1000 },
    quote: options.quote ?? { maxOutputTokens: 256, estimatedCostMicrousd: 1000, pricingReference: 'fixture-only' },
    apiProtocol: 'anthropic-messages', maxRequests: 4,
    connection: options.connection ?? { baseUrl: 'https://fixture.invalid', headers: {}, timeoutMs: 60_000 },
    price: options.price === null ? undefined : options.price ?? { inputPerMillion: 1, outputPerMillion: 1 },
  }]));
  const attach = connection => {
    let resources;
    resources = createExecutionResourceCoordinator(connection, { ownerNonce: `t07:${randomUUID()}`, leaseMs: 10_000,now:options.now,
      validateRequest: request => assertResourceSessionCurrent(connection, request),
      verifyEvidence: (_request, claim, evidence) => {
        const saved = resources.getClaim(claim.claimId);
        return !!saved && verifyThreadedBackendResourceEvidence(connection, saved, evidence);
      },
    });
    const runtime = createThreadedBackendRuntime(connection, { resources, resolveAgent: scope => configurations.get(scope.agentId),
      fetch: options.fetch, sdkProcess: options.sdkProcess, now:options.now, dispatchEnabled: false, autoStart: false, repairIntervalMs: 0,
      onRequestReserved: options.onRequestReserved, onRequestSettled: options.onRequestSettled,trackingSources:options.trackingSources,actions:options.actions,
      holdPolicy:options.holdPolicy,waitSourceAuthorization:options.waitSourceAuthorization });
    return { db: connection, runtime, resources };
  };
  let current = attach(db);
  const user = (body, targets = ['api-member'], extra = {}) => current.runtime.messages.acceptUserMessage({
    ownerId: thread.ownerId, threadId: thread.id, clientRequestId: randomUUID(), body, targets, ...extra,
  });
  const fixture = { get db() { return current.db; }, get runtime() { return current.runtime; },
    get resources() { return current.resources; }, configurations, thread, user, file,
    close() { current.runtime.close(); if (current.db.open) current.db.close(); },
    /** Rebuild the factories and SQLite connection; credentials/hooks stay in memory. */
    reopen() {
      fixture.close();
      const connection = new Database(file, { timeout: 10_000, fileMustExist: true });
      try {
        connection.pragma('foreign_keys = ON'); connection.pragma('journal_mode = WAL');
        assertOrchestrationSchemaCompatible(connection);
        current = attach(connection);
      } catch (error) {
        connection.close();
        throw error;
      }
      return fixture;
    },
  };
  return fixture;
}
