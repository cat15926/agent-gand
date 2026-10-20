import { db } from '../db/database.ts';
import { createThreadedRuntime } from './runtime.ts';
import { executionResources } from '../execution/resources/service.ts';
import { threadedMessaging } from './messagingService.ts';
import { ThreadedAuthorityError } from './contracts.ts';

/** Persistent resource fences are shared with legacy execution. Real admission remains closed. */
export const threadedRuntime = createThreadedRuntime(db, {
  resources: executionResources,
  messaging: threadedMessaging(),
  prepareResources: () => { throw new ThreadedAuthorityError('THREADED_BACKEND_NOT_IMPLEMENTED'); },
  dispatchEnabled: false,
  autoStart: false,
});
export const threadedLifecycle = threadedRuntime.lifecycle;
