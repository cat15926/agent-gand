import { config } from '../config.ts';
import type { ScopedCollaborationCapability } from '@agent-gand/shared';

/** G2 opens the complete model-API control package; native execution and release remain closed. */
export function scopedCollaborationCapabilities(backend: string): ScopedCollaborationCapability[] {
  return (['scoped-control-v1', 'scoped-release-v1'] as const).map(name => ({
    package: name, boundaryVersion: 2, toolApiVersion: 3,
    foundationImplemented: backend === 'builtin-llm', implementationSupported: backend === 'builtin-llm' && name === 'scoped-control-v1',
    configuredAvailable: backend === 'builtin-llm' && name === 'scoped-control-v1' && config.orchestrationRollout.entryMode === 'execute' && config.orchestrationRollout.enabledDrivers.includes('builtin-llm'), connectionVerified: false, verifiedAt: null,
    reason: backend === 'builtin-llm' ? name === 'scoped-control-v1' ? 'G2: owner-confirmed text envelopes, all join and status-only returns; connection not verified' : 'Content release requires G3' : 'Scoped backend integration is not implemented',
  }));
}
