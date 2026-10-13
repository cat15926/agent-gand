import type { CoordinationPlan, OrchestrationRequest, SchedulingPreview, SchedulingState } from '@agent-gand/shared';
import { all, get } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { getRunCoordinationPlan, listCoordinationStepStates } from '../coordination/store.ts';
import { OrchestrationError } from './normalize.ts';
import { runSourceAccess } from '../messaging/access.ts';

export function schedulingPreview(request:OrchestrationRequest,plan:CoordinationPlan):SchedulingPreview|undefined {
  if(request.businessContract?.version!==3)return;
  return {version:1,minimumModelCalls:plan.steps.filter(s=>s.agentId).length,platformTransitions:plan.steps.filter(s=>!s.agentId).length,stages:request.businessContract.stages.map(stage=>{
    const steps=plan.steps.filter(s=>s.agentId&&s.metadata.businessStageId===stage.id),workers=steps.filter(s=>s.metadata.businessStageJoin!==true),remaining=new Set(workers.map(s=>s.id)),done=new Set(plan.steps.filter(s=>!remaining.has(s.id)).map(s=>s.id)),waves:string[][]=[];
    const concurrency=Number(workers[0]?.metadata.concurrencyLimit??1);
    while(remaining.size){const ready=workers.filter(s=>remaining.has(s.id)&&s.dependsOn.every(id=>done.has(id))).slice(0,concurrency);if(!ready.length)break;waves.push(ready.map(s=>s.agentId!));for(const s of ready){remaining.delete(s.id);done.add(s.id);}}
    return {stageId:stage.id,title:stage.title,concurrency,waves,joinAgentId:stage.execution!.join?.agentId??null,joinSourceAgentIds:stage.execution!.join?.sourceAgentIds??[],tasks:steps.map(s=>({agentId:s.agentId!,objective:String(s.metadata.objective),visibility:s.metadata.scopeVisibility==='private'?'private':'public',audience:(s.metadata.scopeAudience as string[])??[]}))};
  })};
}
interface CallRow {id:string;attempt_id:string|null;backend:string;status:string;waiting_reason:string|null;queued_at:string;started_at:string|null;finished_at:string|null}
export function schedulingState(runId:string):SchedulingState {
  const run=getRun(runId);if(!run)throw new OrchestrationError(404,'RUN_NOT_FOUND','任务不存在');
  const plan=getRunCoordinationPlan(runId),states=plan?listCoordinationStepStates(plan.id):[],calls=all<CallRow>('SELECT * FROM orchestration_model_calls WHERE run_id=? ORDER BY queued_at,id',runId);
  const attempts=all<{id:string;step_id:string;status:string}>('SELECT id,step_id,status FROM coordination_step_attempts WHERE run_id=?',runId),scope=runSourceAccess(runId);
  const interrupted=get("SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND recovery_attention=1",runId)||['failed','cancelled','completed'].includes(run.status);
  const issued=calls.filter(c=>c.started_at),unknown=calls.filter(c=>c.status==='unknown'||c.status==='started'&&interrupted);
  const cutoff=get<{applied_at:string}>('SELECT applied_at FROM orchestration_schema_migrations WHERE version=11')!.applied_at;
  return {runId,coverage:run.createdAt>=cutoff?'current':'legacy_partial',apiRequests:issued.filter(c=>c.backend==='builtin-llm').length,nativeInvocations:issued.filter(c=>c.backend!=='builtin-llm').length,unknownCalls:unknown.length,waitingCalls:calls.filter(c=>c.status==='waiting'&&!interrupted).length,blockedCalls:calls.filter(c=>c.status==='admission_blocked').length,
    dispatchReceipts:attempts.filter(a=>plan?.steps.find(s=>s.id===a.step_id)?.agentId).length,platformTransitions:attempts.filter(a=>a.status==='completed'&&plan?.steps.find(s=>s.id===a.step_id)?.agentId===null).length,
    steps:(plan?.steps??[]).filter(s=>s.agentId).map(step=>{const ids=new Set(attempts.filter(a=>a.step_id===step.id).map(a=>a.id)),own=calls.filter(c=>c.attempt_id&&ids.has(c.attempt_id)),waiting=own.find(c=>c.status==='waiting'&&!interrupted);
      return {stepId:step.id,agentId:step.agentId!,stageId:typeof step.metadata.businessStageId==='string'?step.metadata.businessStageId:null,kind:step.metadata.businessStageJoin===true?'join':'work',status:states.find(s=>s.stepId===step.id)?.status??'pending',waitingReason:waiting?.waiting_reason??null,calls:own.filter(c=>c.started_at).length,waitingMs:own.reduce((n,c)=>n+Math.max(0,Date.parse(c.started_at??c.finished_at??new Date().toISOString())-Date.parse(c.queued_at)),0),visibility:step.metadata.scopeVisibility==='private'?'private':scope.visibility,audience:(step.metadata.scopeAudience as string[])??scope.audience};}),
  };
}
