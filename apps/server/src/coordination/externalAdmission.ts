import type { AgentDefinition, CoordinationPlan, CoordinationProtocolId, CoordinationValidationIssue } from '@agent-gand/shared';
import { config } from '../config.ts';
import { bidirectional } from '../execution/policy.ts';

/** Only protocols with an execute kernel and O2 fixtures may admit external steps. */
export const EXTERNAL_STEP_PROTOCOLS = new Set<CoordinationProtocolId>([
  'single_agent', 'sequential_pipeline', 'parallel_fanout', 'supervisor_aggregation', 'review_revision', 'debate',
]);
export function externalCoordinationIssues(plan: CoordinationPlan, agents: AgentDefinition[]): CoordinationValidationIssue[] {
  const issues: CoordinationValidationIssue[] = [];
  const error = (code: string, message: string, path: string) => issues.push({ code, message, path, severity: 'error' });
  for (const agent of agents.filter(item => item.execution?.kind === 'external')) {
    const execution = agent.execution!;
    if (execution.kind !== 'external') continue;
    if (!bidirectional(execution.driver)) error('READONLY_CLI_COORDINATION_UNSUPPORTED', `${agent.name} 使用只读 CLI，当前仅支持手动流水线；步骤执行请选择 Claude SDK 或 Codex app-server`, `agents.${agent.id}`);
    for (const selected of plan.protocols) if (!EXTERNAL_STEP_PROTOCOLS.has(selected.protocol) || config.coordinationRuntime.kernelMode !== 'execute' || !config.coordinationRuntime.executeProtocols.includes(selected.protocol)) {
      error('EXTERNAL_PROTOCOL_NOT_VERIFIED', `${agent.name} 尚未开放 ${selected.protocol} 的步骤执行；需要已验证的 execute Runtime 协议`, 'protocols');
    }
    for (const step of plan.steps.filter(item => item.agentId === agent.id)) {
      if (step.actorCapability === 'coordinate' || ['supervisor', 'planner'].includes(step.actorRole)) error('EXTERNAL_COORDINATOR_UNSUPPORTED', `${agent.name} 不能承担主管规划；请选择内置协调角色`, `steps.${step.id}`);
      if ((step.expectedArtifacts?.length ?? 0) > 0 && (!execution.platformTools?.includes('fs.write') || !agent.tools.includes('fs.write') || agent.permissionMode === 'readonly' || agent.disallowedTools.includes('fs.write'))) {
        error('EXTERNAL_ARTIFACT_TOOL_REQUIRED', `${agent.name} 的步骤需要冻结产物，请开放平台 fs.write 并配置写入权限`, `steps.${step.id}`);
      }
      if (step.type !== 'review' && agent.permissionMode !== 'readonly' && config.externalAgents.workspaceMode !== 'isolated') error('EXTERNAL_ISOLATED_WORKSPACE_REQUIRED', `${agent.name} 的编码步骤需要隔离 Git 工作区`, `steps.${step.id}`);
    }
  }
  return issues;
}
