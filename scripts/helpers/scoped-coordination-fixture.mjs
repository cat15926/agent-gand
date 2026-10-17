import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Uses the normal entry, real graph and Owner gate; only the provider is supplied by the caller. */
export async function completeScopedCoordination(room) {
  const rooms=await import('../../apps/server/src/conversations/service.ts');
  const entry=await import('../../apps/server/src/orchestration/entry.ts');
  const coordination=await import('../../apps/server/src/coordination/runtime.ts');
  const business=await import('../../apps/server/src/orchestration/business.ts');
  const trace=await import('../../apps/server/src/runs/trace.ts');
  room??=rooms.createConversation({title:'G6 阶段结果验收',mode:'collaboration',agentIds:['planner','aa','bb','summary','sdk'],workspace:null});
  const input={conversationId:room.id,agentIds:room.agentIds,goal:'独立审查 A/B 并保留结果私密',workflow:'routine',strategy:'serial',constraints:{readonly:true},clientRequestId:randomUUID(),
    businessContract:{version:3,revision:1,executionMode:'stage_gated',stages:[{id:'review',title:'独立审查',criteria:['提交事实、依据与限制'],deliverables:[{id:'report',title:'审查报告',kind:'text'}],execution:{concurrency:2,
      assignments:['aa','bb'].map(agentId=>({agentId,objective:`只审查 ${agentId} 的独立材料，提交完整报告。`,dependsOn:[],visibility:'private',audience:[agentId]}))}}]}};
  const p=await entry.previewExecutionOrchestration(input);
  assert.deepEqual(p.decision.issues.filter(i=>i.severity==='error'),[]);
  const result=entry.submitExecutionOrchestration({...input,entryVersion:1,previewId:p.previewId,orchestrationFingerprint:p.fingerprint},room.id);
  await coordination.runCoordinationPlan(result.run,result.run.goal);
  assert.equal(trace.getRun(result.run.id).status,'waiting_for_user');
  assert.equal(business.getBusinessState(result.run.id).stages[0].execution.canAccept,true);
  const command=c=>business.applyBusinessCommand(result.run.id,{...c,expectedVersion:business.getBusinessState(result.run.id).version,clientRequestId:randomUUID()});
  const evidence=business.listBusinessEvidence(result.run.id);
  const reported=command({action:'report',stageId:'review',kind:'delivery',note:'已核对独立审查交付',evidence:[{deliverableId:'report',ref:evidence.at(-1).ref}]});
  command({action:'decide',stageId:'review',reportId:reported.stages[0].report.id,verdict:'accept',checkedCriteria:[0],reason:'事实、依据与限制完整'});
  await coordination.resumeCoordinationRun(result.run.id);
  assert.equal(trace.getRun(result.run.id).status,'completed');
  return {...result,input};
}
