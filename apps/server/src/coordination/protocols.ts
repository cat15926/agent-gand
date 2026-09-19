import type { CoordinationProtocolDefinition, CoordinationProtocolId } from '@agent-gand/shared';

const noParameters: CoordinationProtocolDefinition['parameterSchema'] = {};

const definitions: CoordinationProtocolDefinition[] = [
  {
    id: 'single_agent', version: 1, displayName: '单个 Agent 直接处理', description: '由一位最匹配的 Agent 完成任务。',
    requiredCapabilities: ['execute'], roleSlots: [{ id: 'worker', capability: 'execute', minimum: 1, maximum: 1 }],
    parameterSchema: noParameters, completionCondition: '一个结果通过基本校验', minimumAgents: 1, maximumAgents: 1,
    composable: false, runtimeMode: 'collaboration', risk: 'low',
  },
  {
    id: 'sequential_pipeline', version: 1, displayName: '按顺序接力完成', description: '多位 Agent 按固定顺序加工前序产物。',
    requiredCapabilities: ['execute'], roleSlots: [{ id: 'stages', capability: 'execute', minimum: 2, maximum: null }],
    parameterSchema: noParameters, completionCondition: '所有顺序步骤完成', minimumAgents: 2, maximumAgents: null,
    composable: true, runtimeMode: 'pipeline', risk: 'low',
  },
  {
    id: 'parallel_fanout', version: 1, displayName: '多人分别分析后汇总', description: '多位 Agent 独立处理子问题，再合并结果。',
    requiredCapabilities: ['execute'], roleSlots: [{ id: 'workers', capability: 'execute', minimum: 2, maximum: null }],
    parameterSchema: noParameters, completionCondition: '所有必需分支完成并形成聚合结果', minimumAgents: 2, maximumAgents: null,
    composable: true, runtimeMode: 'pipeline', risk: 'low',
  },
  {
    id: 'supervisor_aggregation', version: 1, displayName: '由主管汇总结果', description: '协调者读取多个分支产物并形成统一交付物。',
    requiredCapabilities: ['coordinate'], roleSlots: [{ id: 'aggregator', capability: 'coordinate', minimum: 1, maximum: 1 }],
    parameterSchema: noParameters, completionCondition: '输入分支齐备且形成统一产物', minimumAgents: 2, maximumAgents: null,
    composable: true, runtimeMode: 'pipeline', risk: 'low',
  },
  {
    id: 'supervisor_dag', version: 1, displayName: '主管拆解并委派', description: '由主管建立依赖任务、分配执行者并完成验收。',
    requiredCapabilities: ['coordinate', 'execute'], roleSlots: [
      { id: 'supervisor', capability: 'coordinate', minimum: 1, maximum: 1 },
      { id: 'workers', capability: 'execute', minimum: 1, maximum: null },
    ], parameterSchema: noParameters, completionCondition: 'DAG 终态且汇总完成', minimumAgents: 2, maximumAgents: null,
    composable: true, runtimeMode: 'supervisor', risk: 'medium',
  },
  {
    id: 'review_revision', version: 1, displayName: '实现后独立检查', description: '执行者提交结果，Reviewer 检查并推动返工直至通过。',
    requiredCapabilities: ['execute', 'review'], roleSlots: [
      { id: 'implementer', capability: 'execute', minimum: 1, maximum: 1, independentFrom: ['reviewer'] },
      { id: 'reviewer', capability: 'review', minimum: 1, maximum: 1, independentFrom: ['implementer'] },
    ], parameterSchema: { maximumRevisions: { type: 'integer', required: false, minimum: 1, maximum: 5 } },
    completionCondition: 'Reviewer 通过或达到终止策略', minimumAgents: 2, maximumAgents: null,
    composable: true, runtimeMode: 'pipeline', risk: 'medium',
  },
  {
    id: 'debate', version: 1, displayName: '固定轮次观点交锋', description: '固定立场的参与者逐轮发言，最终由独立评审裁决。',
    requiredCapabilities: ['execute', 'review'], roleSlots: [
      { id: 'pro', capability: 'execute', minimum: 1, maximum: 1, independentFrom: ['con', 'judge'] },
      { id: 'con', capability: 'execute', minimum: 1, maximum: 1, independentFrom: ['pro', 'judge'] },
      { id: 'judge', capability: 'review', minimum: 1, maximum: 1, independentFrom: ['pro', 'con'] },
    ], parameterSchema: { rounds: { type: 'integer', required: true, minimum: 1, maximum: 10 } },
    completionCondition: '双方逐轮完成且独立裁判给出裁决', minimumAgents: 3, maximumAgents: null,
    composable: true, runtimeMode: 'pipeline', risk: 'low',
  },
  {
    id: 'consensus', version: 1, displayName: '讨论并形成共识', description: '多方交流并收敛共同结论，保留无法消除的分歧。',
    requiredCapabilities: ['execute'], roleSlots: [{ id: 'participants', capability: 'execute', minimum: 2, maximum: null }],
    parameterSchema: noParameters, completionCondition: '达到共识阈值或输出分歧', minimumAgents: 2, maximumAgents: null,
    composable: true, runtimeMode: null, risk: 'low',
  },
  {
    id: 'vote', version: 1, displayName: '独立评分和投票', description: '多位参与者独立评估候选项并按规则产生结果。',
    requiredCapabilities: ['execute'], roleSlots: [{ id: 'voters', capability: 'execute', minimum: 3, maximum: null }],
    parameterSchema: noParameters, completionCondition: '合法选票达到法定数量', minimumAgents: 3, maximumAgents: null,
    composable: true, runtimeMode: null, risk: 'low',
  },
  {
    id: 'dynamic_collaboration', version: 1, displayName: '开放式自由协作', description: 'Agent 根据对话内容自由回复、转交和并行征询。',
    requiredCapabilities: ['execute'], roleSlots: [{ id: 'participants', capability: 'execute', minimum: 1, maximum: null }],
    parameterSchema: noParameters, completionCondition: '动态目标满足完成门槛', minimumAgents: 1, maximumAgents: null,
    composable: false, runtimeMode: 'collaboration', risk: 'medium',
  },
];

function clone(definition: CoordinationProtocolDefinition): CoordinationProtocolDefinition {
  return {
    ...definition,
    requiredCapabilities: [...definition.requiredCapabilities],
    roleSlots: definition.roleSlots.map((slot) => ({ ...slot, independentFrom: slot.independentFrom ? [...slot.independentFrom] : undefined })),
    parameterSchema: Object.fromEntries(Object.entries(definition.parameterSchema).map(([key, value]) => [key, { ...value }])),
  };
}

export function listProtocols(): CoordinationProtocolDefinition[] {
  return definitions.map(clone);
}

export function getProtocol(id: CoordinationProtocolId): CoordinationProtocolDefinition | undefined {
  const definition = definitions.find((item) => item.id === id);
  return definition ? clone(definition) : undefined;
}

export function isProtocolId(value: unknown): value is CoordinationProtocolId {
  return typeof value === 'string' && definitions.some((item) => item.id === value);
}
