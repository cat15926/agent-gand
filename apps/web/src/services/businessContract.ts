import type { BusinessContract } from '@agent-gand/shared';

/** Preserve editable (including incomplete) drafts without trusting stored object shapes. */
export function readBusinessContractDraft(value: unknown): BusinessContract | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as BusinessContract;
  if (raw.version !== 1 || !Array.isArray(raw.stages) || !raw.stages.length || raw.stages.length > 8) return null;
  if (raw.stages.some(s => !s || typeof s.id !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.criteria) || !s.criteria.length || s.criteria.length > 12 || s.criteria.some(c => typeof c !== 'string')
    || !Array.isArray(s.deliverables) || !s.deliverables.length || s.deliverables.length > 12 || s.deliverables.some(d => !d || typeof d.id !== 'string' || typeof d.title !== 'string' || !['text', 'file'].includes(d.kind)))) return null;
  return structuredClone(raw);
}
