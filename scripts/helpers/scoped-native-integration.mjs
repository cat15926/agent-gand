import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

/** Normal preview/confirm paths only: no frozen-role or account-binding replacement. */
export async function verifyNativeDeliveryIntegration({sdkId,apiId,deadline=Date.now()+90000,maxTokens=12000}) {
  const rooms=await import('../../apps/server/src/conversations/service.ts'),delivery=await import('../../apps/server/src/collaboration/scopedDelivery.ts');
  const releases=await import('../../apps/server/src/collaboration/informationRelease.ts'),scheduler=await import('../../apps/server/src/collaboration/scheduler.ts');
  const trace=await import('../../apps/server/src/runs/trace.ts'),db=await import('../../apps/server/src/db/database.ts');
  const room=rooms.createConversation({title:'G5 normal SDK admission',mode:'collaboration',agentIds:[sdkId,apiId],workspace:null});
  async function wait(id,status) {
    for(;;){const run=trace.getRun(id);if(run.status===status)return;
      if(['completed','failed','cancelled'].includes(run.status))throw new Error('INTEGRATION_RUN_'+run.status+':'+JSON.stringify(db.all('SELECT error FROM collaboration_attempts WHERE run_id=?',id)));
      if(Date.now()>=deadline)throw new Error('INTEGRATION_DEADLINE');await new Promise(resolve=>setTimeout(resolve,50));}
  }
  const preview=delivery.previewScopedDelivery({conversationId:room.id,coordinatorId:sdkId,goal:'独立核对算术，组织者只收固定状态',join:'all',returnProfile:'status-only-v1',maxTokens,
    items:[{key:'arithmetic',target:apiId,batch:1,expectation:'result',material:'SCOPE_TEXT_CONTROL: Compute 7*6, give the result, evidence and one limitation. Keep the report private.'}]},'integration-owner');
  const sourceRunId=delivery.confirmScopedDelivery({previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()},'integration-owner');
  scheduler.kickCollaboration(room.id);await wait(sourceRunId,'completed');
  assert.ok(delivery.scopedDeliveryStatus(sourceRunId).items.every(item=>item.status==='completed'));
  const aggregatePreview=releases.previewPrivateAggregate({sourceRunId,itemKeys:['arithmetic'],aggregatorId:sdkId,instruction:'核对算术报告的事实、依据和局限，使用 agent.request_release 提交含结果 42 的完整私密草稿，等待 Owner 专用批准。',maxTokens},'integration-owner');
  const aggregate=releases.confirmPrivateAggregate({previewId:aggregatePreview.id,fingerprint:aggregatePreview.fingerprint,clientKey:randomUUID()},'integration-owner');
  scheduler.kickCollaboration(room.id);await wait(aggregate.runId,'waiting_for_user');
  const releasePreview=releases.previewInformationRelease(aggregate.runId,{expectedRevision:1,mode:'exact_content',access:{visibility:'public',audience:[]}},'integration-owner');
  const grant=releases.confirmInformationRelease({previewId:releasePreview.id,fingerprint:releasePreview.fingerprint,clientKey:randomUUID()},'integration-owner');
  const publication=releases.publishInformationRelease(grant.grantId);assert.deepEqual(releases.publishInformationRelease(grant.grantId),publication);
  (await import('../../apps/server/src/runs/recovery.ts')).recoverDurableHolds(aggregate.runId);scheduler.kickCollaboration(room.id);await wait(aggregate.runId,'completed');
  assert.equal(releases.releaseState(aggregate.runId).records.length,1);
  assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id IN (?,?) AND status!='settled'",sourceRunId,aggregate.runId).n,0);
  assert.ok(db.all("SELECT visibility FROM messages WHERE run_id=? AND kind='agent'",sourceRunId).every(row=>row.visibility==='private'));
  return {runIds:[sourceRunId,aggregate.runId],normalAdmission:true,ownerApprovedPublication:true};
}

export async function verifyNativeCoordinationIntegration({writerId,readerId,deadline=Date.now()+90000}) {
  const rooms=await import('../../apps/server/src/conversations/service.ts'),entry=await import('../../apps/server/src/orchestration/entry.ts');
  const runtime=await import('../../apps/server/src/coordination/runtime.ts'),business=await import('../../apps/server/src/orchestration/business.ts');
  const trace=await import('../../apps/server/src/runs/trace.ts'),db=await import('../../apps/server/src/db/database.ts');
  const room=rooms.createConversation({title:'G5 normal native file Coordination',mode:'collaboration',agentIds:[writerId,readerId],workspace:null});
  const input={conversationId:room.id,agentIds:room.agentIds,goal:'读取本次上传材料，生成私密报告并等待阶段验收',workflow:'routine',strategy:'serial',constraints:{readonly:false},clientRequestId:randomUUID(),
    attachments:[{path:'input.txt',contentBase64:Buffer.from('SELECTED_INPUT_SECRET: 7 * 6 = 42. This is a synthetic arithmetic fixture.').toString('base64')}],
    businessContract:{version:3,revision:1,executionMode:'stage_gated',stages:[{id:'analysis',title:'受控文件交付',criteria:['报告包含事实、依据和限制'],deliverables:[{id:'file',title:'算术报告',kind:'file'}],execution:{assignments:[
      {agentId:writerId,objective:'SCOPE_FILE_WORK: Use platform fs.read to read input.txt. Use platform fs.write to write result.txt, with at least 100 characters explaining 7*6=42, the input evidence and the synthetic-sample limitation. Then call agent.complete once with a substantive summary. Native filesystem and shell are unavailable.',dependsOn:[],visibility:'private',audience:[writerId,readerId]},
      {agentId:readerId,objective:'必须先调用 fs.read 读取 result.txt，然后提交包含 42、文件依据和局限的完整审阅结果。只访问本 Scope 的受控文件。',dependsOn:[writerId],visibility:'private',audience:[readerId]}
    ]}}]}};
  const preview=await entry.previewExecutionOrchestration(input);assert.deepEqual(preview.decision.issues.filter(issue=>issue.severity==='error'),[]);
  const admitted=entry.submitExecutionOrchestration({...input,entryVersion:1,previewId:preview.previewId,orchestrationFingerprint:preview.fingerprint},room.id);
  assert.equal((await import('../../apps/server/src/runtime/runPolicy.ts')).loadRuntimeContract(admitted.run.id).features.coordinationScopes,2);
  await runtime.runCoordinationPlan(admitted.run,admitted.run.goal);assert.ok(Date.now()<deadline);
  const state=business.getBusinessState(admitted.run.id);assert.equal(state.stages[0].execution.canAccept,true,JSON.stringify(db.all('SELECT step_id,status,error FROM coordination_step_states WHERE run_id=?',admitted.run.id)));
  const file=business.listBusinessEvidence(admitted.run.id).find(choice=>choice.ref.kind==='workspace_file'&&choice.ref.path==='result.txt'&&choice.ref.artifactId);assert.ok(file);
  const report=business.applyBusinessCommand(admitted.run.id,{action:'report',stageId:'analysis',kind:'delivery',note:'已核对实际文件证据',evidence:[{deliverableId:'file',ref:file.ref}],expectedVersion:state.version,clientRequestId:randomUUID()});
  business.applyBusinessCommand(admitted.run.id,{action:'decide',stageId:'analysis',reportId:report.stages[0].report.id,verdict:'accept',checkedCriteria:[0],reason:'证据与限制完整',expectedVersion:report.version,clientRequestId:randomUUID()});
  await runtime.resumeCoordinationRun(admitted.run.id);assert.equal(trace.getRun(admitted.run.id).status,'completed');
  assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id=? AND status!='settled'",admitted.run.id).n,0);
  for(const name of ['fs.read','fs.write'])assert.ok(db.get("SELECT 1 FROM tool_executions WHERE run_id=? AND agent_id=? AND tool_name=? AND status='completed'",admitted.run.id,writerId,name));
  assert.ok(db.get("SELECT 1 FROM tool_executions WHERE run_id=? AND agent_id=? AND tool_name='fs.read' AND status='completed'",admitted.run.id,readerId));
  return {runId:admitted.run.id,artifactId:file.ref.artifactId,normalAdmission:true,ownerAcceptedFile:true};
}
