import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

let networkAttempts = 0;
export const runtimeFixtureNetworkAttempts = () => networkAttempts;
// Call before importing any application module, including this module's dynamic
// factory dependencies. A worker gets only the explicit temporary database.
export function isolateRuntimeFixture(root) {
  Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test',
    DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents'), LOG_LEVEL: 'silent' });
  globalThis.fetch = async () => { networkAttempts++; throw new Error('Network forbidden in threaded runtime fixture'); };
}

export async function openRuntimeFixture(databasePath, options = {}) {
  const root = path.dirname(databasePath);
  const { config } = await import('../../apps/server/src/config.ts');
  config.sandboxDir = path.join(root, 'sandbox');
  const { createExecutionResourceCoordinator } = await import('../../apps/server/src/execution/resources/coordinator.ts');
  const { assertResourceSessionCurrent, prepareThreadedSession } = await import('../../apps/server/src/execution/resources/sessions.ts');
  const { createThreadedRuntime } = await import('../../apps/server/src/threaded/runtime.ts');
  const db = new Database(databasePath, { timeout: 10_000, readonly: options.readonly ?? false });
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
  // Message availability uses the wall clock; place the controllable scheduler
  // clock ahead so a later same-turn message never needs a timing sleep.
  let clock = options.now ?? Date.now() + 60_000;
  const ownerNonce = options.ownerNonce ?? `runtime-fixture:${randomUUID()}`;
  const resources = options.resources ?? createExecutionResourceCoordinator(db, { ownerNonce, now: () => clock, leaseMs: 1000,
    validateRequest: request => assertResourceSessionCurrent(db, request),
    // This is the only fake authority: no real process exists. The coordinator
    // still issues and verifies its normal durable, identity-bound proof.
    verifyEvidence: (_request, claim, evidence) => evidence.reference === `fixture-exited:${claim.claimId}`,
  });
  const proof = (binding, values = {}) => resources.recordQuiescence(runtime.authority.claim(binding),
    { reason: 'process_exited', sideEffects: 'reconciled', reference: `fixture-exited:${binding.claimId}`, ...values });
  const prepareResources = ({ queue }) => {
    const workspace = path.join(root, 'workspaces', queue.threadId, queue.agentId);
    mkdirSync(workspace, { recursive: true });
    const definition = JSON.parse(db.prepare('SELECT definition FROM agents WHERE id=?').get(queue.agentId).definition);
    return {
      session: prepareThreadedSession(db, { ownerId: queue.ownerId, threadId: queue.threadId, agentId: queue.agentId,
        backend: 'api', backendVersion: 'fixture-only', model: 'mock:fixture', workspace, informationBoundary: 'thread-members-v1' }),
      workspaces: [{ path: workspace, access: 'write' }], providerKey: 'mock',
      ...(definition.accountRef ? { accountId: definition.accountRef } : {}),
      quote: { maxOutputTokens: 100, estimatedCostMicrousd: 1000, pricingReference: 'fixture-v1' },
    };
  };
  let executionCalls = 0;
  const executor = { async execute(input) {
    executionCalls++;
    input.assertAuthorized();
    db.prepare('INSERT INTO fixture_external_calls(attempt_id,invocation_id,created_at) VALUES(?,?,?)')
      .run(input.binding.attemptId, input.binding.invocationId, clock);
    if (options.execute) return options.execute(input, { db, resources, proof, now: () => clock });
    return { kind: 'completed', content: `fixture response ${input.binding.attemptId}`, budgetState: 'settled',
      budgetUsage: { outputTokens: 7, costMicrousd: 11, evidenceReference: `fixture-usage:${input.binding.attemptId}` },
      quiescence: proof(input.binding) };
  } };
  const runtime = createThreadedRuntime(db, { resources, executor, prepareResources, now: () => clock,
    verifyUsage: (binding, _authorization, usage) => usage.evidenceReference === `fixture-usage:${binding.attemptId}`
      && !!db.prepare('SELECT 1 FROM fixture_external_calls WHERE attempt_id=? AND invocation_id=?').get(binding.attemptId, binding.invocationId),
    autoStart: false, dispatchEnabled: options.dispatchEnabled ?? false, repairIntervalMs: 0 });
  return { db, runtime, resources, proof, setClock(value) { clock = value; },
    get executionCalls() { return executionCalls; }, close() { runtime.close(); if (db.open) db.close(); } };
}
