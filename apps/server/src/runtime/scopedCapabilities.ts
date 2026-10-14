import type { ScopedCollaborationCapability } from '@agent-gand/shared';

/** A foundation is not an executable capability package. G2/G3 must enable the complete package. */
export function scopedCollaborationCapabilities(backend: string): ScopedCollaborationCapability[] {
  return (['scoped-control-v1', 'scoped-release-v1'] as const).map(name => ({
    package: name, boundaryVersion: 2, toolApiVersion: 3,
    foundationImplemented: backend === 'builtin-llm', implementationSupported: false,
    configuredAvailable: false, connectionVerified: false, verifiedAt: null,
    reason: backend === 'builtin-llm' ? 'G1 foundation only; delivery/resume package is not implemented' : 'Scoped backend integration is not implemented',
  }));
}
