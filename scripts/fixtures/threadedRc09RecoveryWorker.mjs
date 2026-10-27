import path from 'node:path';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
if (!process.send || !process.env.RC09_RECOVERY_ROOT) throw new Error('RC09_RECOVERY_ISOLATION_REQUIRED');
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER: '1', NODE_ENV: 'test', LOG_LEVEL: 'silent',
  DB_PATH: path.join(process.env.RC09_RECOVERY_ROOT, `unused-worker-${process.pid}.sqlite`),
  AGENTS_DIR: path.join(process.env.RC09_RECOVERY_ROOT, 'unused-agents') });
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('RC09_RECOVERY_NETWORK_FORBIDDEN'); };
const { createThreadedAuthority } = await import('../../apps/server/src/threaded/authority.ts');
const { recoverThreadedBackendFacts } = await import('../../apps/server/src/threaded/backendRecovery.ts');
process.once('message', message => {
  let db;
  try {
    db = new Database(message.file, { timeout: 10_000, fileMustExist: true }); db.pragma('foreign_keys=ON');
    let result;
    try { result = recoverThreadedBackendFacts(db, createThreadedAuthority(db)); }
    catch (error) { result = { error: error.code ?? error.message, message: error.message }; }
    const foreignKeys = db.pragma('foreign_key_check'); db.close(); db = null;
    process.send({ pid: process.pid, networkCalls, result, foreignKeys }, () => process.disconnect());
  } catch (error) {
    if (db?.open) db.close();
    process.send({ pid: process.pid, networkCalls, error: error.code ?? error.message }, () => process.disconnect());
  }
});
