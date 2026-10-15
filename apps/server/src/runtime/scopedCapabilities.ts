import { config } from '../config.ts';
import type { ScopedCollaborationCapability } from '@agent-gand/shared';

/** G3 opens text-only exact release and the registered status projection; native execution remains closed. */
export function scopedCollaborationCapabilities(backend: string): ScopedCollaborationCapability[] {
  return (['scoped-control-v1', 'scoped-release-v1'] as const).map(name => ({
    package: name, boundaryVersion: 2, toolApiVersion: 3,
    foundationImplemented: backend === 'builtin-llm', implementationSupported: backend === 'builtin-llm',
    configuredAvailable: backend === 'builtin-llm' && config.orchestrationRollout.entryMode === 'execute' && config.orchestrationRollout.enabledDrivers.includes('builtin-llm'), connectionVerified: false, verifiedAt: null,
    reason: backend === 'builtin-llm' ? name === 'scoped-control-v1' ? 'G2: owner-confirmed text envelopes, all join and status-only returns; connection not verified' : 'G3: explicit private aggregation, exact text or status-receipts-v1, single-use owner grant; connection not verified' : 'Scoped backend integration is not implemented',
  }));
}
