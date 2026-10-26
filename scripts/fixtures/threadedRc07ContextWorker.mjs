import path from 'node:path';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

// New process / connection acceptance only. No singleton, credential, provider,
// actual model or native Session is loaded; transport evidence was injected by
// the parent through the production evidence writer in its temporary database.
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('RC07_CONTEXT_NETWORK_FORBIDDEN'); };
if (!process.send || !process.env.RC07_CONTEXT_ROOT) throw new Error('RC07_CONTEXT_ISOLATION_REQUIRED');
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(process.env.RC07_CONTEXT_ROOT, 'unused-worker-singleton.sqlite'),
  AGENTS_DIR: path.join(process.env.RC07_CONTEXT_ROOT, 'unused-agents') });
const { createThreadedAuthority } = await import('../../apps/server/src/threaded/authority.ts');
const { createThreadedContext } = await import('../../apps/server/src/threaded/context.ts');
const { verifyThreadedBackendDelivery } = await import('../../apps/server/src/threaded/backends/evidence.ts');
const { recoverThreadedBackendFacts } = await import('../../apps/server/src/threaded/backendRecovery.ts');
process.once('message', message => {
  let db;
  try {
    db = new Database(message.file, { timeout: 10_000 }); db.pragma('foreign_keys=ON');
    const authority = createThreadedAuthority(db);
    const context = createThreadedContext(db, { authority,
      verifyDeliveryEvidence: (binding, manifest, _intent, outcome) => verifyThreadedBackendDelivery(db, binding, manifest, outcome) });
    let result;
    try {
      result = message.operation === 'repair' ? recoverThreadedBackendFacts(db, authority)
        : context.recordDeliveryOutcome(message.binding, message.outcome);
    } catch (error) { result = { error: error.code ?? error.message, message: error.message }; }
    const snapshot = Object.fromEntries(['threaded_context_send_intents', 'threaded_context_send_receipts',
      'threaded_context_deliveries', 'threaded_context_cursor_facts', 'threaded_context_cursors', 'threaded_backend_requests']
      .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const foreignKeys = db.pragma('foreign_key_check');
    db.close(); db = null;
    process.send({ pid: process.pid, networkCalls, result, snapshot, foreignKeys }, () => process.disconnect());
  } catch (error) {
    if (db?.open) db.close();
    process.send({ pid: process.pid, error: error.code ?? error.message, networkCalls }, () => process.disconnect());
  }
});
