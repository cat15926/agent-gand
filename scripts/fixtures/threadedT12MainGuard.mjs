import path from 'node:path';
// Preloaded by the real index.ts process. It does not replace the server entry,
// its factories, routes or recovery ordering; only test paths and egress differ.
if (process.env.AGENT_GAND_ISOLATED_WORKER !== '1' || !path.isAbsolute(process.env.T12_MAIN_ROOT ?? '')) {
  throw new Error('T12 main smoke requires an explicit isolated root');
}
let forbiddenFetchAttempts = 0;
globalThis.fetch = async () => { forbiddenFetchAttempts++; throw new Error('T12 main smoke external fetch forbidden'); };
const { config } = await import('../../apps/server/src/config.ts');
config.sandboxDir = path.join(process.env.T12_MAIN_ROOT, 'sandbox');
config.dataDir = process.env.T12_MAIN_ROOT;
process.on('message', async message => {
  if (message.operation !== 't12-diagnostics') return;
  try {
    const { db } = await import('../../apps/server/src/db/database.ts');
    const { threadedRuntime } = await import('../../apps/server/src/threaded/service.ts');
    const names = ['threaded_invocations', 'threaded_attempts', 'threaded_backend_requests',
      'threaded_backend_processes', 'orchestration_model_calls', 'external_agent_executions'];
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    process.send?.({ id: message.id, result: { pid: process.pid, entry: 'apps/server/src/index.ts',
      diagnostics: threadedRuntime.diagnostics(), forbiddenFetchAttempts,
      counts: Object.fromEntries(names.map(name => [name, tables.has(name) ? db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n : 0])) } });
  } catch (error) { process.send?.({ id: message.id, error: error.message }); }
});
