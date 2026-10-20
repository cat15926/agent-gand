import { db } from '../db/database.ts';
import { createThreadedRuntime } from './runtime.ts';
import { executionResources } from '../execution/resources/service.ts';
import { threadedMessaging } from './messagingService.ts';
import { ThreadedAuthorityError } from './contracts.ts';
import { createThreadedAuthority } from './authority.ts';
import { recoverThreadedBackendFacts } from './backendRecovery.ts';

/** Persistent resource fences are shared with legacy execution. Real admission remains closed. */
const runtime = createThreadedRuntime(db, {
  resources: executionResources,
  messaging: threadedMessaging(),
  prepareResources: () => { throw new ThreadedAuthorityError('THREADED_PRODUCTION_ADMISSION_CLOSED'); },
  dispatchEnabled: false,
  autoStart: false,
  collaborationEnabled: true,
});
export const threadedRuntime = { ...runtime, recover() {
  const result = runtime.recover();
  return { ...result, ...recoverThreadedBackendFacts(db, createThreadedAuthority(db, executionResources)) };
} };
export const threadedLifecycle = threadedRuntime.lifecycle;
