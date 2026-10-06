import { randomUUID } from 'node:crypto';
import type { AgentDefinition, CapabilitySnapshot } from '@agent-gand/shared';
import * as registry from '../agents/registry.ts';
import { listTools } from '../tools/builtin/index.ts';
import { READONLY_TOOLS } from '../tools/types.ts';
import { listProtocols } from './protocols.ts';

export function createCapabilitySnapshot(agentIds?: string[], frozenAgents?: AgentDefinition[]): CapabilitySnapshot {
  // 参与者顺序是 TaskBrief 的硬约束；顺序流水线和 Debate 角色绑定都必须沿用用户选择顺序。
  const selectedAgents = agentIds
    ? agentIds.map((id) => frozenAgents ? frozenAgents.find((agent) => agent.id === id) : registry.getAgent(id)).filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
    : frozenAgents ?? registry.list();
  const agents = selectedAgents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    version: agent.version,
    ...(agent.execution ? { execution: structuredClone(agent.execution) } : {}),
    capabilities: [...agent.capabilities],
    tools: [...agent.tools],
    permissionMode: agent.permissionMode,
    model: agent.model,
    ...(agent.accountRef ? { accountRef: agent.accountRef } : {}),
    ...(agent.requiresAccount ? { requiresAccount: true } : {}),
    enabled: agent.enabled,
  }));
  return {
    id: randomUUID(),
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    protocols: listProtocols(),
    agents,
    tools: listTools().map((tool) => {
      const readonly = READONLY_TOOLS.has(tool.name);
      return {
        name: tool.name,
        source: tool.source ?? 'builtin',
        readonly,
        risk: readonly ? 'low' as const : 'medium' as const,
        requiresApproval: !readonly,
      };
    }),
    policy: {
      maximumAgents: 12,
      maximumSteps: 64,
      maximumAttemptsPerStep: 5,
      maximumTokensPerStep: 16_000,
      reviewerIsolationRequired: true,
      externalWritesRequireApproval: true,
    },
  };
}
