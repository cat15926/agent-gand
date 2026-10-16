import { config } from '../config.ts';
import type { ScopedCollaborationCapability } from '@agent-gand/shared';

/** Native cold-boundary foundation exists; product admission stays closed until
 * its complete driver/account/control/usage combination has independent evidence. */
export function scopedCollaborationCapabilities(backend: string): ScopedCollaborationCapability[] {
  return (['scoped-control-v1', 'scoped-release-v1'] as const).map(name => ({
    package: name, boundaryVersion: 2, toolApiVersion: 3,
    foundationImplemented: ['builtin-llm','claude-sdk','codex-app-server'].includes(backend), implementationSupported: backend === 'builtin-llm',
    configuredAvailable: backend === 'builtin-llm' && config.orchestrationRollout.entryMode === 'execute' && config.orchestrationRollout.enabledDrivers.includes('builtin-llm'), connectionVerified: false, verifiedAt: null,
    reason: backend === 'builtin-llm' ? name === 'scoped-control-v1' ? 'Owner-confirmed text envelopes, all/readonly-any joins and status-only returns; connection not verified' : 'Explicit private aggregation, exact text or status-receipts-v1, single-use owner grant; connection not verified' : ['claude-sdk','codex-app-server'].includes(backend) ? 'G5 cold Scope foundation implemented; native combination acceptance pending; admission closed' : 'Scoped backend integration is not implemented',
  }));
}
