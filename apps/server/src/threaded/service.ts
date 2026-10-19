import { afterCommit, db } from '../db/database.ts';
import { createThreadedAuthority } from './authority.ts';
import { createThreadedLifecycle } from './lifecycle.ts';
import { unavailableThreadedResources } from './contracts.ts';
import { abortThreadedExecution } from './executionSignals.ts';

/** Production may fence, stop and recover records. T04/T06 must provide execution resources. */
const authority = createThreadedAuthority(db, unavailableThreadedResources);
export const threadedLifecycle = createThreadedLifecycle(db, authority, {
  resources: unavailableThreadedResources,
  onInvalidate: invocationIds => afterCommit(() => {
    for (const id of invocationIds) abortThreadedExecution(id);
  }),
});
