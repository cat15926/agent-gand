import path from 'node:path';
import {db} from '../db/database.ts';
import {config} from '../config.ts';
import {executionResources} from '../execution/resources/service.ts';
import {threadedMessaging} from './messagingService.ts';
import {readCredential} from '../accounts/credentials.ts';
import {loadThreadedProductionSettings} from './productionSettings.ts';
import {createThreadedProduction} from './production.ts';

const settings=loadThreadedProductionSettings(db,{file:process.env.THREADED_RELEASE_MEMBERS_FILE,
  workspaceRoot:path.join(config.sandboxDir,'threaded'),privateRoot:path.join(config.accounts.privateDir,'threaded'),readCredential});
export const threadedRuntime=createThreadedProduction(db,{resources:executionResources,messaging:threadedMessaging(),settings});
export const threadedLifecycle=threadedRuntime.lifecycle;
