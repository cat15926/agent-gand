import type { BusinessContract } from '@agent-gand/shared';

/** Preserve editable (including incomplete) drafts without trusting stored object shapes. */
export function readBusinessContractDraft(value: unknown): BusinessContract | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as BusinessContract;
  if (![1,2].includes(raw.version) || raw.version===2&&(!Number.isSafeInteger(raw.revision)||raw.revision!<1) || !Array.isArray(raw.stages) || !raw.stages.length || raw.stages.length > 8) return null;
  if (raw.executionMode !== undefined && raw.executionMode !== 'stage_gated') return null;
  if (raw.executionMode === undefined && raw.stages.some(s => s?.execution !== undefined)) return null;
  if (raw.stages.some(s => !s || typeof s.id !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.criteria) || !s.criteria.length || s.criteria.length > 12 || s.criteria.some(c => typeof c !== 'string')
    || !Array.isArray(s.deliverables) || !s.deliverables.length || s.deliverables.length > 12 || s.deliverables.some(d => !d || typeof d.id !== 'string' || typeof d.title !== 'string' || !['text', 'file'].includes(d.kind)))) return null;
  if (raw.executionMode === 'stage_gated' && raw.stages.some(s => !s.execution || !Array.isArray(s.execution.assignments) || !s.execution.assignments.length || s.execution.assignments.length > 12
    || s.execution.assignments.some(a => !a || typeof a.agentId !== 'string' || typeof a.objective !== 'string'||a.dependsOn!==undefined&&(!Array.isArray(a.dependsOn)||a.dependsOn.length>12||a.dependsOn.some(d=>typeof d!=='string')))
    || ['timeoutMs', 'maxTokens', 'maxCost'].some(key => { const v = s.execution![key as 'timeoutMs' | 'maxTokens' | 'maxCost']; return v !== undefined && (!Number.isFinite(v) || v <= 0); }))) return null;
  return structuredClone(raw);
}
