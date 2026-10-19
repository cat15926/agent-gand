import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import { createExecutionResourceCoordinator } from '../../apps/server/src/execution/resources/coordinator.ts';

// A real second SQLite connection/process, with no application singleton or provider imports.
const [databasePath, ownerNonce] = process.argv.slice(2);
if (!databasePath || !ownerNonce || !process.send) throw new Error('Resource worker requires a fixture database and IPC');
globalThis.fetch = async () => { throw new Error('Resource fixture must never call a network service'); };
const db = new Database(databasePath, { timeout: 10_000 });
db.pragma('foreign_keys = ON');
let clock = Date.parse('2026-10-20T00:00:00.000Z');
const resources = createExecutionResourceCoordinator(db, {
  ownerNonce, now: () => clock, leaseMs: 1_000,
  validateRequest() {},
  verifyEvidence: (_request, _claim, evidence) => evidence.reference === 'fixture-confirmed-process-exit',
});
const methods = new Set(['tryAcquire', 'getTicket', 'getClaim', 'listClaims', 'renew', 'markStarted', 'markUnknown',
  'recordQuiescence', 'verifyQuiescence', 'release', 'recoverExpired']);
process.on('message', async message => {
  try {
    if (message.operation === 'close') {
      db.close();
      process.send({ id: message.id, result: true }, () => process.disconnect());
      return;
    }
    let result;
    if (message.operation === 'setClock') { clock = message.value; result = clock; }
    else {
      if (!methods.has(message.operation)) throw new Error('Unknown resource fixture operation');
      result = await resources[message.operation](...(message.args ?? []));
    }
    process.send({ id: message.id, result: result ?? null });
  } catch (error) {
    process.send({ id: message.id, error: { code: error?.code, message: String(error?.message ?? error) } });
  }
});
process.on('disconnect', () => { if (db.open) db.close(); });
process.send({ ready: true });
