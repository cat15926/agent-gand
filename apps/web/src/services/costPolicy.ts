import type { CostPolicy } from '@agent-gand/shared';

/** Drafts must retain a fee guard, even when stale browser data cannot be trusted. */
export { readCostPolicy as readCostPolicyDraft } from '@agent-gand/shared';
export const blockedCostPolicyDraft = (): CostPolicy => ({version:1,currency:'USD',mode:'strict',maxCost:1,unknownAction:'stop',prices:[]});
