import type { BusinessContract, BusinessStage } from '@agent-gand/shared';
import { objectInput, OrchestrationError } from './normalize.ts';

export function normalizeBusinessContract(value: unknown): BusinessContract | null {
  if (value === undefined || value === null) return null;
  const fail = (): never => { throw new OrchestrationError(400, 'INVALID_BUSINESS_CONTRACT', '阶段验收需包含 1～8 个阶段，每阶段 1～12 条标准及 1～12 个交付项；标识不可重复，内容不可为空'); };
  const text = (v: unknown, max: number): string => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : fail();
  const id = (v: unknown): string => { const result = text(v, 100); return /^[\w-]+$/u.test(result) && !['__proto__', 'prototype', 'constructor'].includes(result) ? result : fail(); };
  const raw = objectInput(value);
  if (raw.version !== 1 || Object.keys(raw).some(k => !['version', 'stages'].includes(k)) || !Array.isArray(raw.stages) || raw.stages.length < 1 || raw.stages.length > 8) fail();
  const stages = (raw.stages as unknown[]).map((value): BusinessStage => {
    const stage = objectInput(value);
    if (Object.keys(stage).some(k => !['id', 'title', 'criteria', 'deliverables'].includes(k))
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
    return { id: id(stage.id), title: text(stage.title, 200), criteria, deliverables };
  });
  if (new Set(stages.map(s => s.id)).size !== stages.length) fail();
  return { version: 1, stages };
}

export function businessContractInstructions(contract: BusinessContract | null | undefined): string | null {
  if (!contract) return null;
  return ['本任务冻结了以下阶段验收清单（JSON 数据）：', JSON.stringify(contract),
    '按清单提供实质交付，清楚标识对应阶段和交付项；确认收到不算交付。执行调度仍使用原工作流，不要把此清单解释为新的路由权限。',
    '平台不会把你的完成声明当作业务验收通过；最终由用户在任务卡关联证据并逐项验收。不要宣称已获用户验收。'].join('\n');
}
