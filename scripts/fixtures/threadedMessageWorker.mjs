import path from 'node:path';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

// The parent creates every database/fixture. The worker only opens that explicit file.
const [databasePath, workerId] = process.argv.slice(2);
if (!databasePath || !workerId || !process.send) throw new Error('Message worker requires an isolated database and IPC');
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(path.dirname(databasePath), 'unused-message-worker.sqlite'),
  AGENTS_DIR: path.join(path.dirname(databasePath), 'agents'), LOG_LEVEL: 'silent' });
globalThis.fetch = async () => { throw new Error('Network forbidden in message fixture worker'); };
const { config } = await import('../../apps/server/src/config.ts');
config.sandboxDir = path.join(path.dirname(databasePath), 'sandbox');
const { createThreadedMessages } = await import('../../apps/server/src/threaded/messages.ts');
const { createThreadedMessageAcl } = await import('../../apps/server/src/threaded/acl.ts');
const { createThreadedOutbox } = await import('../../apps/server/src/threaded/outbox.ts');
const db = new Database(databasePath, { timeout: 10_000 });
db.pragma('foreign_keys = ON');
let clock = Date.parse('2026-10-20T00:00:00.000Z');
const messages = createThreadedMessages(db, { acl: createThreadedMessageAcl(db),
  authority: { assertAuthorized() { throw new Error('Fixture workers only accept authenticated user messages'); } } });
const outbox = createThreadedOutbox(db, { now: () => clock, leaseMs: 1000 });
const methods = new Set(['claim', 'renew', 'release', 'notification', 'ack']);
process.on('message', async message => {
  try {
    if (message.operation === 'close') {
      db.close();
      process.send({ id: message.id, result: true }, () => process.disconnect());
      return;
    }
    let result;
    if (message.operation === 'acceptUserMessage') result = messages.acceptUserMessage(message.args[0]);
    else if (message.operation === 'commitThenExit') {
      messages.acceptUserMessage(message.args[0]);
      // Simulates loss of the caller receipt and all in-memory notification state.
      db.close(); process.exit(23);
    } else if (message.operation === 'setClock') { clock = message.args[0]; result = clock; }
    else {
      if (!methods.has(message.operation)) throw new Error('Unknown message worker operation');
      result = outbox[message.operation](...(message.operation === 'claim' ? [workerId] : message.args ?? []));
    }
    process.send({ id: message.id, result: result ?? null });
  } catch (error) {
    process.send({ id: message.id, error: { code: error?.code, message: String(error?.message ?? error) } });
  }
});
process.on('disconnect', () => { if (db.open) db.close(); });
process.send({ ready: true });
