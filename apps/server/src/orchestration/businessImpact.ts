import type { BusinessChangeImpact, BusinessContract, BusinessStage } from '@agent-gand/shared';
import { OrchestrationError, stableDigest } from './normalize.ts';
import { stageTasks } from './businessScheduling.ts';

export function affectedMembers(stage: BusinessStage, selected: string[], independentSafe: boolean): { ids: Set<string>; reasons: string[] } {
  const tasks=stageTasks(stage);
  if(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!tasks.some(t=>t.agentId===id)))throw new OrchestrationError(400,'INVALID_REWORK_MEMBERS','请选择当前阶段中不重复的成员');
  if(!independentSafe||stage.deliverables.some(d=>d.kind==='file')||tasks.some(t=>t.dependsOn===undefined))return {ids:new Set(tasks.map(t=>t.agentId)),reasons:['依赖未完整声明，或包含写入/文件产物，无法证明成员工作独立；重做整阶段。']};
  const ids=new Set(selected);
  for(const task of tasks)if(task.dependsOn!.some(d=>ids.has(d)))ids.add(task.agentId);
  return {ids,reasons:ids.size>selected.length?['选中工作的下游成员必须一起重做，阶段汇合交付须重新验收。']:['已按冻结依赖校验，保留未受影响的独立成员结果。']};
}
export function changeImpact(contract: BusinessContract, stageId: string, redo: Set<string>, reasons: string[], kind: BusinessChangeImpact['kind']='rework', fromRevision=contract.revision??1):BusinessChangeImpact {
  const index=contract.stages.findIndex(s=>s.id===stageId);
  const retained:BusinessChangeImpact['retained']=[],work:BusinessChangeImpact['redo']=[];
  for(const [at,stage] of contract.stages.entries())for(const task of stageTasks(stage)) {
    const item={stageId:stage.id,agentId:task.agentId,objective:task.objective};
    (at>index||at===index&&redo.has(task.agentId)?work:retained).push(item);
  }
  return {kind,fromRevision,toRevision:contract.revision??1,retained,redo:work,reacceptStageIds:contract.stages.slice(index).map(s=>s.id),
    invalidatedDeliverables:contract.stages.slice(index).flatMap(s=>s.deliverables.map(d=>({stageId:s.id,deliverableId:d.id,title:d.title}))),reasons};
}
export function revisionImpact(old:BusinessContract,next:BusinessContract,independentSafe:boolean):BusinessChangeImpact {
  if(![2,3].includes(next.version)||old.version===3&&next.version!==3||next.revision!==(old.revision??1)+1||next.executionMode!==old.executionMode||stableDigest(next.stages.map(s=>s.id))!==stableDigest(old.stages.map(s=>s.id)))throw new OrchestrationError(400,'CONTRACT_REVISION_INCOMPATIBLE','新契约须递增一个版本并保留阶段标识、结构与范围契约；改变阶段结构请明确创建新任务。');
  for(const [i,stage]of next.stages.entries()) {
    const before=old.stages[i]!;
    for(const key of ['maxTokens','maxCost','timeoutMs'] as const)if(stage.execution?.[key]!==before.execution?.[key])throw new OrchestrationError(409,'CONTRACT_BUDGET_CHANGED','修订不能重置原阶段的时限、Token 或费用限制。');
  }
  const index=next.stages.findIndex((s,i)=>stableDigest(s)!==stableDigest(old.stages[i]));
  if(index<0)throw new OrchestrationError(400,'CONTRACT_REVISION_EMPTY','验收清单或分工没有变化。');
  const stage=next.stages[index]!,before=old.stages[index]!;
  const requirementsChanged=stableDigest({title:stage.title,criteria:stage.criteria,deliverables:stage.deliverables,join:stage.execution!.join})!==stableDigest({title:before.title,criteria:before.criteria,deliverables:before.deliverables,join:before.execution!.join});
  const selected=stage.execution!.assignments.filter(t=>stableDigest(t)!==stableDigest(before.execution!.assignments.find(a=>a.agentId===t.agentId))).map(t=>t.agentId);
  const removed=before.execution!.assignments.some(t=>!stage.execution!.assignments.some(a=>a.agentId===t.agentId));
  const closure=requirementsChanged||removed||!selected.length?{ids:new Set(stageTasks(stage).map(t=>t.agentId)),reasons:['验收标准、交付项、汇合或成员集合改变，原阶段交付需要重做和重新验收。']}:affectedMembers(stage,selected,independentSafe);
  return changeImpact(next,stage.id,closure.ids,[...closure.reasons,'后续阶段依赖受影响的汇合结果，原验收决定不继承；来源账本保持原版本。'],'contract_revision',old.revision??1);
}
