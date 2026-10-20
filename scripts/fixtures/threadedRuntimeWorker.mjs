import path from 'node:path';
import { isolateRuntimeFixture, openRuntimeFixture } from './threadedRuntimeFixture.mjs';

const [databasePath, workerId] = process.argv.slice(2);
if (!databasePath || !workerId || !path.isAbsolute(databasePath)) throw new Error('Explicit isolated database required');
isolateRuntimeFixture(path.dirname(databasePath));
const f = await openRuntimeFixture(databasePath, { ownerNonce: workerId });
process.on('message', async message => {
  const { id, operation, args = [] } = message;
  try {
    let result;
    if (operation === 'enqueueWake') result = f.runtime.queue.enqueueWake(...args);
    else if (operation === 'claimNext') result = f.runtime.queue.claimNext(workerId);
    else if (operation === 'recover') result = f.runtime.recover();
    else if (operation === 'setClock') result = f.setClock(args[0]);
    else if (operation === 'executeClaim') result = await f.runtime.executeClaim(args[0]);
    else if (operation === 'executeThenExitBeforeRelease') {
      f.resources.release = () => { f.db.close(); process.exit(25); };
      result = await f.runtime.executeClaim(args[0]);
      throw new Error('Expected process exit at post-commit release boundary');
    }
    else if (operation === 'startAndExit') {
      f.runtime.lifecycle.startAttempt(args[0].binding);
      f.db.prepare('INSERT INTO fixture_external_calls(attempt_id,invocation_id,created_at) VALUES(?,?,?)')
        .run(args[0].binding.attemptId, args[0].binding.invocationId, Date.now());
      f.close(); process.exit(23);
    } else if (operation === 'exitPrepared') {
      f.close(); process.exit(24);
    } else if (operation === 'close') {
      f.close(); process.send?.({ id, result: null }); process.disconnect(); return;
    } else throw new Error(`Unknown runtime fixture operation: ${operation}`);
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({ id, error: { code: error.code, message: error.message } });
  }
});
process.send?.({ ready: true });
