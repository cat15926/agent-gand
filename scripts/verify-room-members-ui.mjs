// O5 retains the member-selection/layout acceptance under the unified entry contract.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const result = spawnSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','scripts/verify-orchestration-o5.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:process.env,stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
