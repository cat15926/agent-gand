import { intersectMessageAccess, isMessageVisibleTo, isMessageWithinScope, type BusinessAssignment, type BusinessStage, type MessageAccess, type OrchestrationRequest } from '@agent-gand/shared';

export function stageTasks(stage:BusinessStage):BusinessAssignment[] {
  const tasks=stage.execution!.assignments,join=stage.execution!.join;
  return join?[...tasks,{...join,dependsOn:tasks.map(t=>t.agentId)}]:tasks;
}
export function assignmentAccess(task:BusinessAssignment,parent:MessageAccess):MessageAccess {
  return intersectMessageAccess([parent,{visibility:task.visibility??'public',audience:task.visibility==='private'?['user',...(task.audience??[])]:[]}]);
}
export function assignmentScopeMetadata(task:BusinessAssignment,parent:MessageAccess) {
  const scope=assignmentAccess(task,parent);return {scopeVisibility:scope.visibility,scopeAudience:scope.audience};
}
export function schedulingAccessIssues(request:OrchestrationRequest,readonly:boolean):Array<{code:string;severity:'error';message:string;agentId?:string}> {
  if(request.businessContract?.version!==3)return [];
  const issues:Array<{code:string;severity:'error';message:string;agentId?:string}>=[];
  const parent:MessageAccess={visibility:request.visibility??'public',audience:request.audience??[]};
  const reject=(message:string,agentId?:string)=>issues.push({code:'STAGE_SCOPE_INCOMPATIBLE',severity:'error',message,agentId});
  for(const stage of request.businessContract.stages) {
    const tasks=stageTasks(stage),scopes=new Map(tasks.map(t=>[t.agentId,assignmentAccess(t,parent)]));
    for(const [at,task] of tasks.entries()) {
      const scope=scopes.get(task.agentId)!;
      if(!isMessageVisibleTo(scope,task.agentId)||task.audience?.some(id=>!request.agentIds.includes(id)&&id!=='user'))reject('任务授权须包含执行成员，并且只能使用冻结团队中的成员。',task.agentId);
      if(task.visibility==='private'&&parent.visibility==='private'&&task.audience?.some(id=>!parent.audience.includes(id)&&id!=='user'))reject('成员任务不能扩大本轮私密授权。',task.agentId);
      const join=stage.execution!.join,inputs=join?.agentId===task.agentId?join.sourceAgentIds:task.dependsOn??(at?[tasks[at-1]!.agentId]:[]);
      for(const source of inputs)if(!isMessageVisibleTo(scopes.get(source)!,task.agentId)||!isMessageWithinScope(scopes.get(source)!,scope))reject('依赖或汇合结果的授权不足：请明确授权读取成员，并限制接收任务的输出范围。',task.agentId);
    }
    if(!readonly&&(stage.execution!.concurrency??1)>1)reject('写入阶段保持顺序执行，不能并发共享工作区。');
  }
  return issues;
}
/** Context selection is stricter than actor visibility: outputs cannot be published to a wider audience. */
export function canUseResult(source:MessageAccess,target:MessageAccess,viewer:string):boolean {
  return isMessageVisibleTo(source,viewer)&&isMessageWithinScope(source,target);
}
