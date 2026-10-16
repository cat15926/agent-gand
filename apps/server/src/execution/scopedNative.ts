import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { privateDirectory } from '../accounts/native.ts';
import { assertScopedOutput, inputLedgerRevision, scopedSessionBoundary, type ScopedAttemptBinding } from '../runtime/scopedCollaboration.ts';
import { get } from '../db/database.ts';
import type { ExecutionScopeV1 } from '@agent-gand/shared';

/** Server-owned handle. Never accept paths, session IDs or boundary IDs from a model. */
export interface ScopedNativeEnvironment {
  binding: ScopedAttemptBinding;
  boundary: ReturnType<typeof scopedSessionBoundary>;
  cwd: string;
  home: string;
  assertAuthorized(): void;
  close(): Promise<void>;
}

export function assertScopedNativeAuthorized(binding: ScopedAttemptBinding): void {
  const boundary = scopedSessionBoundary(binding);
  const row = get<{ record: string }>('SELECT record FROM runtime_execution_scopes WHERE id=?', boundary.scopeId)!;
  const scope = JSON.parse(row.record) as ExecutionScopeV1;
  assertScopedOutput({ ...binding, ledgerRevision: inputLedgerRevision(binding.attemptId), outputAccess: scope.defaultOutputAccess });
}

/** A fresh home AND workspace per launch, even for the same role/audience/Attempt. */
export async function createScopedNativeEnvironment(binding: ScopedAttemptBinding): Promise<ScopedNativeEnvironment> {
  assertScopedNativeAuthorized(binding);
  const boundary = scopedSessionBoundary(binding);
  const requestedRoot = path.join(config.accounts.privateDir, 'scoped-native', randomUUID());
  const root = await privateDirectory(requestedRoot);
  try {
    // privateDirectory validates logical paths against the configured root, then
    // returns canonical paths. Keep /tmp → /private/tmp aliases out of that check.
    const home = await privateDirectory(path.join(requestedRoot, 'home'));
    const cwd = await privateDirectory(path.join(requestedRoot, 'workspace'));
    let closed = false;
    return { binding, boundary, home, cwd,
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
