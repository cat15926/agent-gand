import { randomUUID } from 'node:crypto';
import { rm, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { privateDirectory } from '../accounts/native.ts';
import { assertScopedOutput, inputLedgerRevision, scopedSessionBoundary, scopedToolPolicy, type ScopedAttemptBinding } from '../runtime/scopedCollaboration.ts';
import { SCOPED_FILE_TOOLS } from '../runtime/scopedFileTools.ts';
import { get } from '../db/database.ts';
import type { ExecutionScopeV1, ExternalAgentExecution } from '@agent-gand/shared';

/** Only after guardian quiescence. Refuse any path outside a generated cold root. */
export async function cleanupRecoveredScopedNative(execution:ExternalAgentExecution):Promise<void> {
  let privateRoot:string;try{privateRoot=await realpath(config.accounts.privateDir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const base=path.join(privateRoot,'scoped-native'),root=path.dirname(execution.cwd);
  if(path.dirname(root)!==base||! /^[0-9a-f-]{36}$/.test(path.basename(root))||execution.cwd!==path.join(root,'workspace')
    ||execution.scopedIsolation&&execution.scopedIsolation.home!==path.join(root,'home'))throw new Error('SCOPED_RECOVERY_DIRECTORY_INVALID');
  for(const dir of [config.accounts.privateDir,base,root]){
    let stat;try{stat=await lstat(dir);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink()||process.getuid&&stat.uid!==process.getuid())throw new Error('SCOPED_RECOVERY_DIRECTORY_INVALID');
  }
  if(path.dirname(await realpath(root))!==await realpath(base))throw new Error('SCOPED_RECOVERY_DIRECTORY_INVALID');
  await rm(root,{recursive:true,force:true});
}

/** Server-owned handle. Never accept paths, session IDs or boundary IDs from a model. */
export interface ScopedNativeEnvironment {
  binding: ScopedAttemptBinding;
  boundary: ReturnType<typeof scopedSessionBoundary>;
  cwd: string;
  home: string;
  tools: readonly string[];
  assertAuthorized(): void;
  close(): Promise<void>;
}

export function assertScopedNativeAuthorized(binding: ScopedAttemptBinding): void {
  const boundary = scopedSessionBoundary(binding);
  const tools=scopedToolPolicy(binding).tools;
  if(tools.some(name=>!SCOPED_FILE_TOOLS.includes(name)))throw new Error('SCOPED_TOOL_REJECTED');
  const row = get<{ record: string }>('SELECT record FROM runtime_execution_scopes WHERE id=?', boundary.scopeId)!;
  const scope = JSON.parse(row.record) as ExecutionScopeV1;
  assertScopedOutput({ ...binding, ledgerRevision: inputLedgerRevision(binding.attemptId), outputAccess: scope.defaultOutputAccess });
}

/** A fresh home AND workspace per launch, even for the same role/audience/Attempt. */
export async function createScopedNativeEnvironment(binding: ScopedAttemptBinding): Promise<ScopedNativeEnvironment> {
  assertScopedNativeAuthorized(binding);
  const boundary = scopedSessionBoundary(binding);
  const tools=Object.freeze(scopedToolPolicy(binding).tools);
  const requestedRoot = path.join(config.accounts.privateDir, 'scoped-native', randomUUID());
  const root = await privateDirectory(requestedRoot);
  try {
    // privateDirectory validates logical paths against the configured root, then
    // returns canonical paths. Keep /tmp → /private/tmp aliases out of that check.
    const home = await privateDirectory(path.join(requestedRoot, 'home'));
    const cwd = await privateDirectory(path.join(requestedRoot, 'workspace'));
    let closed = false;
    return { binding, boundary, home, cwd, tools,
      assertAuthorized() {
        if (closed) throw new Error('SCOPE_BINDING_INVALID');
        assertScopedNativeAuthorized(binding);
        if (JSON.stringify(scopedSessionBoundary(binding)) !== JSON.stringify(boundary)) throw new Error('CONTEXT_MANIFEST_DRIFT');
      },
      // Call only AFTER the native process and owned bridge operations have stopped.
      async close() { closed = true; await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
