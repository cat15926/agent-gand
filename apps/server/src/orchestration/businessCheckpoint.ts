import { all, get } from '../db/database.ts';
import { createHash } from 'node:crypto';
import { getRun } from '../runs/trace.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { attemptAccess } from '../messaging/access.ts';
import { resolveEvidence } from '../runtime/evidence.ts';
import { getBusinessState } from './business.ts';
import { businessQuiescent, canAcceptStage } from './businessGates.ts';
import { listByRun } from '../messaging/inbox.ts';
import { listExecutions } from '../execution/store.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { OrchestrationError, stableDigest } from './normalize.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { attachCheckpointArchive, readBusinessCheckpoint, type BusinessCheckpoint } from './businessCheckpointStore.ts';
import { buildArtifactSnapshot } from '../artifacts/snapshots.ts';
import { runSourceAccess } from '../messaging/access.ts';
import { verifiedBusinessRecovery, recoverySnapshot } from './businessRecovery.ts';
import { readArtifactSnapshot, snapshotDigest } from '../artifacts/snapshots.ts';
import { costCarry, costBudgetState } from './costBudget.ts';
import type { BusinessReworkInput, BusinessRevisionInput } from '@agent-gand/shared';
import { affectedMembers, changeImpact, revisionImpact } from './businessImpact.ts';
import { stageTasks } from './businessScheduling.ts';

function fail(code: string, message: string): never { throw new OrchestrationError(409, code, message); }
const stableDigestText=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Recomputed at preview and confirmation. No filesystem/database mutation or model call. */
export function buildBusinessCheckpoint(runId: string, rework?: BusinessReworkInput, revision?: BusinessRevisionInput): BusinessCheckpoint {
  const source = getRun(runId), snapshot = getRunOrchestrationSnapshot(runId), plan = getRunCoordinationPlan(runId);
  const state = getBusinessState(runId);
  if (!source || !(source.status === 'failed' || (rework||revision) && source.status === 'waiting_for_user' && plan?.status === 'paused')
    || !plan || snapshot?.execution?.engine !== 'coordination' || state.contract?.executionMode !== 'stage_gated')
    fail('BUSINESS_CHECKPOINT_UNSUPPORTED', rework ? '返工需在逐阶段验收边界或已失败任务中明确提出；运行中或已取消任务不可返工' : '阶段续跑只支持已失败的逐阶段任务');
  if ((rework||revision) && get('SELECT 1 FROM orchestration_run_continuations WHERE source_run_id=?', runId)) fail('CONTINUATION_EXISTS', '原任务已创建后续任务，请在后续任务处理返工');
  if (state.resolution || state.outcome === 'achieved') fail('BUSINESS_OUTCOME_FINAL', '业务结果已固定；补充目标请新建任务');
  const scope=runSourceAccess(runId);
  const extended=scope.visibility==='private'||snapshot.execution.readonly!==true||listExecutions(runId).some(e=>e.permissionMode!=='readonly')||listToolExecutions(runId).some(t=>t.replayPolicy!=='safe');
  const recovery=extended?verifiedBusinessRecovery(runId):undefined;
  if (!recovery&&!businessQuiescent(runId, true)) fail('RESULT_UNKNOWN', '仍有未收敛执行或未知调用消耗，不能迁移阶段进度');
  if (!recovery&&(get("SELECT 1 FROM managed_artifact_versions WHERE run_id=? AND json_extract(record,'$.visibility')='private' LIMIT 1", runId)
    || listByRun(runId).some(m => m.visibility === 'private')
    || get("SELECT 1 FROM runtime_context_assemblies WHERE run_id=? AND visibility='private' LIMIT 1", runId))) fail('PRIVATE_CHECKPOINT_UNSUPPORTED', '比本轮更窄的私密状态不能自动汇入后续任务');
  const accepted = state.stages.filter(item => item.status === 'accepted');
  if (accepted.some((item, i) => item.stage.id !== state.stages[i]?.stage.id)) fail('CHECKPOINT_STAGE_ORDER_INVALID', '已验收阶段不是连续前缀，不能续跑');
  if (accepted.length === state.stages.length) fail('ALREADY_COMPLETED', '全部阶段已验收，无剩余任务');
  const inherited = readBusinessCheckpoint(runId);
  if (inherited && stableDigest(inherited.contract) !== stableDigest(state.contract)) fail('CHECKPOINT_CONTRACT_CHANGED', '检查点与冻结阶段契约不一致');
  const rejected = state.stages.find(s => s.status !== 'accepted');
  if(revision&&(state.version!==revision.expectedVersion||source.status==='waiting_for_user'&&!canAcceptStage(runId,rejected!.stage.id)))fail('BUSINESS_STATE_STALE','修订须基于当前账本，在已收敛的阶段边界提交。');
  if (rework) {
    if (state.version !== rework.expectedVersion) fail('BUSINESS_STATE_STALE', '验收记录已改变，请刷新后重新预览返工');
    if (!rejected || rejected.stage.id !== rework.stageId || rejected.report?.id !== rework.reportId
      || rejected.report.kind !== 'delivery' || rejected.decision?.verdict !== 'reject' || !canAcceptStage(runId, rework.stageId))
      fail('STAGE_REWORK_UNAVAILABLE', '仅当前已拒绝的实质交付可以返工，需先确认执行与验收边界');
  }
  const outputs: BusinessCheckpoint['outputs'] = inherited ? structuredClone(inherited.outputs) : [];
  for (const row of all<{ id: string; step_id: string; output: string }>("SELECT id,step_id,output FROM coordination_step_attempts WHERE run_id=? AND plan_id=? AND revision=? AND status='completed' AND output IS NOT NULL ORDER BY created_at,id", runId, plan.id, plan.revision)) {
    const step = plan.steps.find(s => s.id === row.step_id && s.agentId);
    if (!step) continue;
    const stage = state.contract.stages.find(s => s.id === step.metadata.businessStageId);
    if (!stage || !recovery&&attemptAccess(row.id).visibility !== 'public') fail('PRIVATE_CHECKPOINT_UNSUPPORTED', '阶段产物未冻结为可迁移内容');
    const resolved = resolveEvidence(runId, { kind: 'attempt_output', id: row.id });
    if (!resolved.trusted || !resolved.contentSha256 || !row.output.trim()) fail('CHECKPOINT_EVIDENCE_INVALID', '已完成步骤缺少可验证交付');
    outputs.push({ attemptId: row.id, sourceRunId: runId, stageId: stage.id, stepId: step.id, agentId: step.agentId!,
      objective: String(step.metadata.objective), output: row.output, sha256: resolved.contentSha256,...(recovery?{access:attemptAccess(row.id),origin:'member' as const}:{}) });
  }
  for(const choice of recovery?.review?.input.steps.filter(s=>s.verdict==='completed')??[]) {
    const step=plan.steps.find(s=>s.id===choice.stepId)!,item=recovery!.inspection.steps.find(s=>s.stepId===choice.stepId)!;
    outputs.push({attemptId:item.attemptId,sourceRunId:runId,stageId:item.stageId,stepId:item.stepId,agentId:item.agentId,objective:String(step.metadata.objective),output:choice.output!,sha256:stableDigestText(choice.output!),access:attemptAccess(item.attemptId),origin:'owner_reconciled'});
  }
  if (new Set(outputs.map(o => o.stepId)).size !== outputs.length) fail('CHECKPOINT_DUPLICATE_WORKER', '检查点包含重复成员步骤');
  let reworkArchive = inherited?.rework ? structuredClone(inherited.rework) : undefined;
  let impact=inherited?.impact;
  if (rework) {
    const closure=affectedMembers(rejected!.stage,rework.selectedAgentIds??rejected!.stage.execution!.assignments.map(t=>t.agentId),!extended);
    impact=changeImpact(state.contract,rework.stageId,closure.ids,closure.reasons);
    reworkArchive = { sourceRunId: runId, sourceStatus: source.status, stageId: rework.stageId, report: structuredClone(rejected!.report!),
      decision: structuredClone(rejected!.decision!), instruction: rework.instruction,
      rejectedOutputs: outputs.filter(o => o.stageId === rework.stageId&&closure.ids.has(o.agentId)) };
    const retained = outputs.filter(o => accepted.some(a => a.stage.id === o.stageId)||o.stageId===rework.stageId&&!closure.ids.has(o.agentId));
    outputs.splice(0, outputs.length, ...retained);
  } else if (!revision&&state.stages.some(s => s.status === 'rejected')) fail('STAGE_REWORK_REQUIRED', '存在已拒绝交付，需要明确返工任务；不能复用为确认完成');
  if(revision) {
    impact=revisionImpact(state.contract,revision.contract,!extended);
    if(revision.contract.stages.some(s=>s.execution!.assignments.some(t=>!snapshot.request.agentIds.includes(t.agentId))))fail('CONTRACT_MEMBER_CHANGED','修订只能使用原冻结成员，不能扩大授权或改变费用计价集合。');
    const retained=outputs.filter(o=>impact!.retained.some(t=>t.stageId===o.stageId&&t.agentId===o.agentId));
    for(const output of retained) {
      const index=revision.contract.stages.findIndex(s=>s.id===output.stageId),at=stageTasks(revision.contract.stages[index]!).findIndex(t=>t.agentId===output.agentId);
      output.stepId=`stage-${index+1}-work-${at+1}`;
    }
    outputs.splice(0,outputs.length,...retained);
    accepted.splice(0,accepted.length,...accepted.filter(a=>!impact!.reacceptStageIds.includes(a.stage.id)));
    reworkArchive=undefined;
  }
  const archive=recovery?recoverySnapshot(runId,recovery.inspection,outputs.map(o=>o.attemptId)):buildArtifactSnapshot(runId,{stageIds:accepted.map(a=>a.stage.id),checkpoint:true});
  if(!archive.manifest.complete) fail('CHECKPOINT_INCOMPLETE','已验收阶段仍缺少声明交付，不能标为完整检查点');
  const files:BusinessCheckpoint['files']=archive.manifest.files.filter(f=>f.storage==='workspace'&&f.sha256).map(f=>({sourceRunId:f.sourceRunId,path:f.path,sha256:f.sha256!,...(f.workspaceScope?{workspaceScope:f.workspaceScope}:{})}));
  const charge = (table: string, stageId?: string) => all<{ charged: number }>(`SELECT CASE WHEN status='settled' THEN used ELSE reserved END charged FROM ${table} WHERE run_id=?${stageId ? ' AND stage_id=?' : ''}`, runId, ...(stageId ? [stageId] : [])).reduce((sum, item) => sum + item.charged, 0);
  const contract=revision?.contract??state.contract;
  if(impact&&(rework||revision)) {
    impact.retained=impact.retained.filter(t=>outputs.some(o=>o.stageId===t.stageId&&o.agentId===t.agentId));
    impact.redo=contract.stages.filter(s=>!accepted.some(a=>a.stage.id===s.id)).flatMap(s=>stageTasks(s).filter(t=>!outputs.some(o=>o.stageId===s.id&&o.agentId===t.agentId)).map(t=>({stageId:s.id,agentId:t.agentId,objective:t.objective})));
  }
  const pendingStages = contract.stages.filter(s => !accepted.some(a => a.stage.id === s.id)
    && stageTasks(s).some((_, i) => !outputs.some(o => o.stepId === `stage-${contract.stages.indexOf(s) + 1}-work-${i + 1}`)));
  if (pendingStages.length && snapshot.request.constraints.maxTokens && charge('orchestration_token_reservations') >= snapshot.request.constraints.maxTokens) fail('CHECKPOINT_BUDGET_EXHAUSTED', '本轮输出 Token 预算已耗尽，不能通过关联续跑重置额度；请核对后明确新任务预算');
  if (pendingStages.some(s => s.execution!.maxTokens && charge('business_stage_token_reservations', s.id) >= s.execution!.maxTokens)) fail('CHECKPOINT_BUDGET_EXHAUSTED', '待续阶段的输出 Token 预算已耗尽，需明确新任务预算，不能自动重放');
  const costs = costCarry(runId), fees = costBudgetState(runId);
  if (pendingStages.length && fees && fees.run.remaining === 0 || pendingStages.some(s => fees?.stages.find(f => f.stageId === s.id)?.remaining === 0)) fail('COST_BUDGET_EXHAUSTED', '待续工作费用额度已耗尽，不能通过续跑或返工重置额度');
  const unknownCharge=(table:string,stageId?:string)=>all<{n:number}>(`SELECT reserved n FROM ${table} WHERE run_id=? AND status IN ('pending','unknown','carried_unknown')${stageId?' AND stage_id=?':''}`,runId,...(stageId?[stageId]:[])).reduce((n,r)=>n+r.n,0);
  const checkpoint: BusinessCheckpoint = { version: recovery?3:2, sourceRunId: runId, sourceVersion: state.version, contract: structuredClone(contract),
    ...(impact?{impact}:{}),...(revision?{revision:{contract:structuredClone(state.contract),instruction:revision.instruction}}:inherited?.revision?{revision:inherited.revision}:{}),
    ...(recovery?{access:scope,readonly:snapshot.execution.readonly,acceptedArchives:[...new Map([...(inherited?.acceptedArchives??[]),...recovery.inspection.acceptedArchiveIds.map(id=>({id,digest:snapshotDigest(readArtifactSnapshot(id).manifest)}))].map(a=>[a.id,a])).values()],
      recovery:{reviewId:recovery.review?.id??null,fingerprint:recovery.inspection.fingerprint,unknownUsage:recovery.inspection.unknownUsage,runUnknownTokens:unknownCharge('orchestration_token_reservations'),stageUnknownTokens:state.contract.stages.map(s=>({stageId:s.id,tokens:unknownCharge('business_stage_token_reservations',s.id)}))}}:{}),
    accepted: accepted.map(item => ({ stageId: item.stage.id, report: structuredClone(item.report!), decision: structuredClone(item.decision!) })), outputs, files,
    runTokens: charge('orchestration_token_reservations'), stageTokens: state.contract.stages.map(s => ({ stageId: s.id, charged: charge('business_stage_token_reservations', s.id) })),
    ...(fees ? { costs, costBudget: fees } : {}),
    ...(reworkArchive ? { rework: reworkArchive } : {}) };
  attachCheckpointArchive(checkpoint,archive);
  if (Buffer.byteLength(JSON.stringify(checkpoint)) > 1024 * 1024) fail('CHECKPOINT_TOO_LARGE', '产物和返工记录归档超过 1 MiB，请核对后准备范围明确的新任务');
  return checkpoint;
}
