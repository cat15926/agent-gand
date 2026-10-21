import { db } from '../db/database.ts';
import { executionResources } from '../execution/resources/service.ts';
import { createThreadedAuthority } from './authority.ts';
import {threadedAdmissionMode} from './policy.ts';
import { createThreadedMessaging } from './messaging.ts';

let service: ReturnType<typeof createThreadedMessaging> | undefined;
/** Lazy construction after database bootstrap. Historical reads do not admit or execute work. */
export function threadedMessaging() {
  return service ??= createThreadedMessaging(db, { authority: createThreadedAuthority(db, executionResources),...(threadedAdmissionMode()==='observe'?{repairIntervalMs:0}:{}) });
}
export function closeThreadedMessaging(): void { service?.close(); service = undefined; }
