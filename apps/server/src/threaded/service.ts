import { afterCommit, db } from '../db/database.ts';
import { createThreadedAuthority } from './authority.ts';
import { createThreadedLifecycle } from './lifecycle.ts';
import { executionResources } from '../execution/resources/service.ts';
import { abortThreadedExecution } from './executionSignals.ts';

/** Persistent resource fences are shared with legacy execution. Real admission remains closed. */
const authority = createThreadedAuthority(db, executionResources);
export const threadedLifecycle = createThreadedLifecycle(db, authority, {
  resources: executionResources,
  onInvalidate: invocationIds => afterCommit(() => {
    for (const id of invocationIds) abortThreadedExecution(id);
  }),
});
