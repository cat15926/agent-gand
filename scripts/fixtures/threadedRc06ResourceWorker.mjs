import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createExecutionResourceCoordinator } from '../../apps/server/src/execution/resources/coordinator.ts';

// This process only imports the DB-injected coordinator. It has no application
// singleton, provider, credential source, model or native Session implementation.
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('RC06_RESOURCE_NETWORK_FORBIDDEN'); };
if (!process.send) throw new Error('RC06_RESOURCE_IPC_REQUIRED');
let db, resources, armed, unsubscribe, notification;
const methods = new Set(['enqueue', 'tryAcquire', 'getTicket', 'getClaim', 'listClaims',
  'assertCurrent', 'assertExecutable', 'cancelTicket', 'requeuePreparation', 'scanPending', 'setEligible']);
const settle = () => new Promise(resolve => setImmediate(resolve));
function closeDatabase() { unsubscribe?.(); unsubscribe = null; if (db?.open) db.close(); resources = null; }
function releaseNotStarted(claim) {
  const proof = resources.recordQuiescence(claim, { reason: 'not_started', sideEffects: 'none' });
  resources.release(claim, proof); return proof;
}
async function execute(operation, args = []) {
  if (operation === 'open') {
    closeDatabase(); armed = null; notification = null;
    db = new Database(args[0], { timeout: 10_000 }); db.pragma('foreign_keys = ON');
    resources = createExecutionResourceCoordinator(db, { ownerNonce: `rc06:${process.pid}:${randomUUID()}`, leaseMs: 60_000 });
    return { pid: process.pid, networkCalls };
  }
  if (operation === 'closeDatabase') { closeDatabase(); return true; }
  if (operation === 'arm') { assert.ok(methods.has(args[0])); armed = { operation: args[0], args: args[1] }; return true; }
  if (operation === 'runArmed') {
    const saved = armed; armed = null; assert.ok(saved);
    if (args[0] > Date.now()) await delay(args[0] - Date.now());
    return execute(saved.operation, saved.args);
  }
  if (operation === 'releaseNotStarted') { const proof = releaseNotStarted(args[0]); await settle(); return proof; }
  if (operation === 'releaseAgain') { resources.release(args[0], args[1]); await settle(); return true; }
  if (operation === 'watchRelease') {
    unsubscribe?.(); const [waitingId, request] = args;
    notification = { events: [], acquired: {}, injectedTicket: null, failures: [], timerScannerCalls: 0 };
    unsubscribe = resources.onAvailable(event => {
      try {
        notification.events.push(event);
        if (event.reason === 'released' && !notification.injectedTicket) notification.injectedTicket = resources.enqueue(request);
        const known = new Set([waitingId, notification.injectedTicket?.id]);
        for (const ticket of resources.scanPending(event.seq).tickets) if (known.has(ticket.id)) {
          const claim = resources.tryAcquire(ticket.id); if (claim) notification.acquired[ticket.id] = claim;
        }
      } catch (error) { notification.failures.push(error.code ?? error.message); }
    });
    return true;
  }
  if (operation === 'notifications') { await settle(); return notification; }
  if (!methods.has(operation)) throw new Error('RC06_RESOURCE_METHOD_FORBIDDEN');
  const value = resources[operation](...args); await settle(); return value ?? null;
}
process.on('message', async message => {
  try {
    if (message.operation === 'close') {
      closeDatabase(); process.send({ id: message.id, result: { pid: process.pid, networkCalls } }, () => process.disconnect()); return;
    }
    const result = await execute(message.operation, message.args);
    process.send({ id: message.id, result });
  } catch (error) {
    process.send({ id: message.id, error: { code: error?.code, message: String(error?.message ?? error) } });
  }
});
process.on('disconnect', closeDatabase);
process.send({ ready: true, pid: process.pid });
