import type { BusinessContract } from '@agent-gand/shared';

/** Preserve editable (including incomplete) drafts without trusting stored object shapes. */
export function readBusinessContractDraft(value: unknown): BusinessContract | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as BusinessContract;
  if (![1,2,3].includes(raw.version) || raw.version!==1&&(!Number.isSafeInteger(raw.revision)||raw.revision!<1) || !Array.isArray(raw.stages) || !raw.stages.length || raw.stages.length > 8) return null;
  if (raw.executionMode !== undefined && raw.executionMode !== 'stage_gated') return null;
  if (raw.executionMode === undefined && raw.stages.some(s => s?.execution !== undefined)) return null;
  if (raw.stages.some(s => !s || typeof s.id !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.criteria) || !s.criteria.length || s.criteria.length > 12 || s.criteria.some(c => typeof c !== 'string')
    || !Array.isArray(s.deliverables) || !s.deliverables.length || s.deliverables.length > 12 || s.deliverables.some(d => !d || typeof d.id !== 'string' || typeof d.title !== 'string' || !['text', 'file'].includes(d.kind)))) return null;
  if (raw.executionMode === 'stage_gated' && raw.stages.some(s => !s.execution || !Array.isArray(s.execution.assignments) || !s.execution.assignments.length || s.execution.assignments.length > 12
    || s.execution.assignments.some(a => !a || typeof a.agentId !== 'string' || typeof a.objective !== 'string'||a.dependsOn!==undefined&&(!Array.isArray(a.dependsOn)||a.dependsOn.length>12||a.dependsOn.some(d=>typeof d!=='string')))
    || ['timeoutMs', 'maxTokens', 'maxCost'].some(key => { const v = s.execution![key as 'timeoutMs' | 'maxTokens' | 'maxCost']; return v !== undefined && (!Number.isFinite(v) || v <= 0); }))) return null;
  const validTask=(t:unknown)=>{if(!t||typeof t!=='object')return false;const a=t as import('@agent-gand/shared').BusinessAssignment;return typeof a.agentId==='string'&&typeof a.objective==='string'&&(a.visibility===undefined||['public','private'].includes(a.visibility))&&(a.audience===undefined||Array.isArray(a.audience)&&a.audience.length<=12&&a.audience.every(id=>typeof id==='string'));};
  if(raw.version===3&&(raw.executionMode!=='stage_gated'||raw.stages.some(s=>s.execution!.assignments.some(a=>!validTask(a))||s.execution!.concurrency!==undefined&&(!Number.isSafeInteger(s.execution!.concurrency)||s.execution!.concurrency!<1||s.execution!.concurrency!>8)||s.execution!.join&&(!validTask(s.execution!.join)||!Array.isArray(s.execution!.join.sourceAgentIds)||s.execution!.join.sourceAgentIds.length>12||s.execution!.join.sourceAgentIds.some(id=>typeof id!=='string')))))return null;
  return structuredClone(raw);
}
