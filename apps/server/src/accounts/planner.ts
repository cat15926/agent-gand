import type { AgentDefinition } from '@agent-gand/shared';
import { config } from '../config.ts';

// This ID cannot collide with user role IDs, which only accept lowercase letters, numbers and hyphens.
export const configuredPlannerId = 'system:coordination-planner';
export type PlannerConnection = Pick<AgentDefinition, 'id' | 'model' | 'accountRef' | 'requiresAccount'>;
export function configuredPlanner(): PlannerConnection | null {
  return config.coordinationPlanner.model ? { id: configuredPlannerId, model: config.coordinationPlanner.model,
    ...(config.coordinationPlanner.accountRef ? { accountRef: config.coordinationPlanner.accountRef } : {}) } : null;
}
