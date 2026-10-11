import type { BusinessContract, BusinessStage } from '@agent-gand/shared';
import { objectInput, OrchestrationError } from './normalize.ts';
import { costAmount } from './costPolicy.ts';

export function normalizeBusinessContract(value: unknown): BusinessContract | null {
  if (value === undefined || value === null) return null;
  const fail = (): never => { throw new OrchestrationError(400, 'INVALID_BUSINESS_CONTRACT', '阶段验收需包含 1～8 个阶段，每阶段 1～12 条标准及交付项；逐阶段执行还需 1～12 个不重复的成员任务和有效预算，总步骤最多 64 个。标识不可重复，内容不可为空'); };
  const text = (v: unknown, max: number): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail();
  const id = (v: unknown): string => { const result = text(v, 100); return /^[\w-]+$/u.test(result) && !['__proto__', 'prototype', 'constructor'].includes(result) ? result : fail(); };
  const raw = objectInput(value);
  if (raw.version !== 1 || Object.keys(raw).some(k => !['version', 'executionMode', 'stages'].includes(k)) || raw.executionMode !== undefined && raw.executionMode !== 'stage_gated' || !Array.isArray(raw.stages) || raw.stages.length < 1 || raw.stages.length > 8) fail();
  const stages = (raw.stages as unknown[]).map((value): BusinessStage => {
    const stage = objectInput(value);
    if (Object.keys(stage).some(k => !['id', 'title', 'criteria', 'deliverables', 'execution'].includes(k))
      || !Array.isArray(stage.criteria) || !stage.criteria.length || stage.criteria.length > 12
      || !Array.isArray(stage.deliverables) || !stage.deliverables.length || stage.deliverables.length > 12) fail();
    const criteria = (stage.criteria as unknown[]).map(v => text(v, 500));
    if (new Set(criteria).size !== criteria.length) fail();
    const deliverables = (stage.deliverables as unknown[]).map(value => {
      const item = objectInput(value);
      if (Object.keys(item).some(k => !['id', 'title', 'kind'].includes(k)) || !['text', 'file'].includes(String(item.kind))) fail();
      return { id: id(item.id), title: text(item.title, 200), kind: item.kind as 'text' | 'file' };
    });
    if (new Set(deliverables.map(d => d.id)).size !== deliverables.length) fail();
    let execution: BusinessStage['execution'];
    if (raw.executionMode === 'stage_gated') {
      if (!stage.execution || typeof stage.execution !== 'object' || Array.isArray(stage.execution)) fail();
      const input = objectInput(stage.execution);
      if (Object.keys(input).some(k => !['assignments', 'timeoutMs', 'maxTokens', 'maxCost'].includes(k)) || !Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 12) fail();
      const assignments = (input.assignments as unknown[]).map(value => {
        const task = objectInput(value);
        if (Object.keys(task).some(k => !['agentId', 'objective'].includes(k))) fail();
        return { agentId: id(task.agentId), objective: text(task.objective, 2000) };
      });
      if (new Set(assignments.map(a => a.agentId)).size !== assignments.length) fail();
      const limits: { timeoutMs?: number; maxTokens?: number; maxCost?: number } = {};
      if (input.maxCost !== undefined) limits.maxCost = costAmount(input.maxCost);
      for (const key of ['timeoutMs', 'maxTokens'] as const) {
        if (input[key] === undefined) continue;
        if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 1 || (input[key] as number) > (key === 'timeoutMs' ? 86400000 : 1000000)) fail();
        limits[key] = input[key] as number;
      }
      execution = { assignments, ...limits };
    } else if (stage.execution !== undefined) fail();
    return { id: id(stage.id), title: text(stage.title, 200), criteria, deliverables, ...(execution ? { execution } : {}) };
  });
  if (new Set(stages.map(s => s.id)).size !== stages.length) fail();
  if (raw.executionMode === 'stage_gated' && stages.reduce((n, s) => n + s.execution!.assignments.length + 1, 1) > 64) fail();
  return { version: 1, ...(raw.executionMode === 'stage_gated' ? { executionMode: 'stage_gated' as const } : {}), stages };
}

export function businessContractInstructions(contract: BusinessContract | null | undefined, stageId?: string): string | null {
  if (!contract) return null;
  if (contract.executionMode === 'stage_gated') {
    const stage = contract.stages.find(s => s.id === stageId);
    if (!stage) throw new Error('逐阶段执行必须绑定冻结阶段，不能从其他入口派发');
    return ['当前冻结阶段验收清单（JSON 数据）：', JSON.stringify(stage),
      '只执行当前派发任务，提供实质交付。后续阶段由平台在用户验收后派发，不能自行跳过门禁。确认收到不算交付；不要宣称已获用户验收。'].join('\n');
  }
  return ['本任务冻结了以下阶段验收清单（JSON 数据）：', JSON.stringify(contract),
    '按清单提供实质交付，清楚标识对应阶段和交付项；确认收到不算交付。执行调度仍使用原工作流，不要把此清单解释为新的路由权限。',
    '平台不会把你的完成声明当作业务验收通过；最终由用户在任务卡关联证据并逐项验收。不要宣称已获用户验收。'].join('\n');
}
