import type { BusinessRevisionInput } from '@agent-gand/shared';
import { get, run, tx } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { cancelCoordinationRun } from '../coordination/runtime.ts';
import { normalizeBusinessContract } from './businessContract.ts';
import { buildBusinessCheckpoint } from './businessCheckpoint.ts';
import { checkpointDigest, checkpointSummary, saveBusinessCheckpoint } from './businessCheckpointStore.ts';
import { businessCheckpointInput, carryTokenCharges } from './continuation.ts';
import { previewExecutionOrchestration, submitExecutionOrchestration } from './entry.ts';
import { objectInput, OrchestrationError, stableDigest } from './normalize.ts';

function parse(value:unknown,owner:boolean,confirmation=false):BusinessRevisionInput {
  if(!owner)throw new OrchestrationError(403,'OWNER_REQUIRED','契约修订须由所有者预览和确认');
  const b=objectInput(value);
  if(Object.keys(b).some(k=>!['expectedVersion','contract','instruction',...(confirmation?['previewId','orchestrationFingerprint']:[])].includes(k))||!Number.isSafeInteger(b.expectedVersion)||(b.expectedVersion as number)<0||typeof b.instruction!=='string'||!b.instruction.trim()||b.instruction.length>2000)throw new OrchestrationError(400,'INVALID_CONTRACT_REVISION','请指定当前账本版本、新契约和修订说明。');
  const contract=normalizeBusinessContract(b.contract);
  if(!contract||contract.executionMode!=='stage_gated')throw new OrchestrationError(400,'INVALID_CONTRACT_REVISION','仅冻结的逐阶段契约可以修订。');
  return {expectedVersion:b.expectedVersion as number,contract,instruction:b.instruction.trim()};
}
export async function previewBusinessRevision(runId:string,value:unknown,owner=false) {
  const input=parse(value,owner),checkpoint=buildBusinessCheckpoint(runId,undefined,input);
  const request={...businessCheckpointInput(runId,`business-revision:${runId}`),businessContract:checkpoint.contract};
  const preview=await previewExecutionOrchestration(request,'unified_preview',checkpoint);
  return {input,preview,checkpoint:{...checkpointSummary(checkpoint),carriedRunTokens:checkpoint.runTokens,carriedStageTokens:checkpoint.stageTokens},closesWaitingSource:getRun(runId)!.status==='waiting_for_user'};
}
export function submitBusinessRevision(runId:string,value:unknown,owner=false) {
  const input=parse(value,owner,true),body=objectInput(value);
  if(typeof body.previewId!=='string'||!body.previewId||typeof body.orchestrationFingerprint!=='string'||!body.orchestrationFingerprint)throw new OrchestrationError(400,'REVISION_CONFIRMATION_REQUIRED','请提交修订预览及 fingerprint');
  const confirmation=stableDigest({...input,previewId:body.previewId,orchestrationFingerprint:body.orchestrationFingerprint});
  return tx(()=>{
    const existing=get<{target_run_id:string;manifest:string}>('SELECT target_run_id,manifest FROM orchestration_run_continuations WHERE source_run_id=?',runId);
    if(existing) {
      const m=JSON.parse(existing.manifest);
      if(m.kind!=='business_contract_revision'||m.confirmation!==confirmation)throw new OrchestrationError(409,'IDEMPOTENCY_CONFLICT','原任务已确认另一份后继，请查看既有任务。');
      return {run:getRun(existing.target_run_id)!,deduplicated:true};
    }
    const checkpoint=buildBusinessCheckpoint(runId,undefined,input);
    const request={...businessCheckpointInput(runId,`business-revision:${runId}`),businessContract:checkpoint.contract};
    const result=submitExecutionOrchestration({...request,entryVersion:1,previewId:body.previewId,orchestrationFingerprint:body.orchestrationFingerprint},request.conversationId!,'conversation_message',checkpoint);
    saveBusinessCheckpoint(result.run.id,checkpoint);carryTokenCharges(result.run.id,checkpoint);
    const manifest={version:2,kind:'business_contract_revision',confirmation,checkpointDigest:checkpointDigest(checkpoint),outputs:checkpoint.outputs.map(o=>({agentId:o.agentId,objective:o.objective,actionKind:'answer'}))};
    run('INSERT INTO orchestration_run_continuations(source_run_id,target_run_id,source_dispatch_id,manifest,created_at) VALUES (?,?,?,?,?)',runId,result.run.id,'business-contract-revision',JSON.stringify(manifest),new Date().toISOString());
    if(getRun(runId)!.status==='waiting_for_user'&&cancelCoordinationRun(runId,'business_stage_rework')?.status!=='cancelled')throw new OrchestrationError(409,'REVISION_SOURCE_NOT_CLOSED','原执行未关闭，本次修订已回滚。');
    return {run:result.run,deduplicated:result.deduplicated};
  });
}
