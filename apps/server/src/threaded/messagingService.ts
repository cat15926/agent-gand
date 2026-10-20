import { db } from '../db/database.ts';
import { executionResources } from '../execution/resources/service.ts';
import { createThreadedAuthority } from './authority.ts';
import { createThreadedMessaging } from './messaging.ts';

let service: ReturnType<typeof createThreadedMessaging> | undefined;
/** Lazy construction after database bootstrap. Historical reads do not admit or execute work. */
export function threadedMessaging() {
  return service ??= createThreadedMessaging(db, { authority: createThreadedAuthority(db, executionResources) });
}
export function closeThreadedMessaging(): void { service?.close(); service = undefined; }
