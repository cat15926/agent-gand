import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { MessageAccess, RecoveryInspection, RecoveryReviewInput, RecoveryReview } from '@agent-gand/shared';
import { isMessageWithinScope } from '@agent-gand/shared';
import { all, get, run, tx } from '../db/database.ts';
import { getRun } from '../runs/trace.ts';
import { getRunCoordinationPlan } from '../coordination/store.ts';
import { getBusinessState } from './business.ts';
import { businessProcessesQuiescent } from './businessGates.ts';
import { readBusinessCheckpoint } from './businessCheckpointStore.ts';
import { getRunOrchestrationSnapshot } from './store.ts';
import { listByRun } from '../messaging/inbox.ts';
import { attemptAccess, runSourceAccess } from '../messaging/access.ts';
import { listExecutions } from '../execution/store.ts';
import { listToolExecutions } from '../tools/executions.ts';
import { listManagedArtifacts } from '../artifacts/store.ts';
import { buildArtifactSnapshot, readArtifactSnapshot, saveArtifactSnapshot, type SnapshotPackage } from '../artifacts/snapshots.ts';
import { captureSnapshotGit } from '../artifacts/snapshotGit.ts';
import { readSnapshotFile, snapshotHash, snapshotPath, SNAPSHOT_LIMITS } from '../artifacts/snapshotFiles.ts';
import { workspaceRootDir } from '../tools/builtin/index.ts';
import { openManagedContent, sealManagedContent } from '../accounts/credentials.ts';
import { objectInput, OrchestrationError, stableDigest } from './normalize.ts';
import { costRows, costBudgetState } from './costBudget.ts';

const fail=(code:string,message:string):never=>{throw new OrchestrationError(409,code,message);};
const aad=(id:string,digest:string)=>`recovery-review-v1:${id}:${digest}`;
function readReview(row:{id:string;run_id:string;fingerprint:string;digest:string;record:string}):RecoveryReview {
  const bytes=openManagedContent(row.record,aad(row.id,row.digest));
  if(snapshotHash(bytes)!==row.digest) fail('RECOVERY_REVIEW_CORRUPT','核对记录校验失败');
  const item=JSON.parse(bytes.toString()) as RecoveryReview;
  if(item.id!==row.id||item.runId!==row.run_id||item.fingerprint!==row.fingerprint) fail('RECOVERY_REVIEW_CORRUPT','核对记录来源无效');
  return item;
}
export function listBusinessRecoveryReviews(runId:string):RecoveryReview[] {
  if(!getRun(runId))throw new OrchestrationError(404,'RUN_NOT_FOUND','任务不存在');
  return all<Parameters<typeof readReview>[0]>('SELECT * FROM business_recovery_reviews WHERE run_id=? ORDER BY rowid DESC LIMIT 10',runId).map(readReview);
}
/** Inspect every ordinary change, never infer effects from a truncated diff or a model claim. */
function changedPaths(root:string):string[] {
  if(!existsSync(root)) return [];
  const canonical=realpathSync(root),baseline=captureSnapshotGit(canonical).git;
  const paths=new Set<string>();let scanned=0;
  const walk=(dir:string,prefix='')=>{for(const name of readdirSync(dir).sort()) {
    if(name==='.git')continue;
    if(++scanned>SNAPSHOT_LIMITS.maxFiles) fail('RECOVERY_SCAN_LIMIT','工作树超过核对扫描限制，请先人工整理');
    const rel=prefix+name;
    try{snapshotPath(rel);}catch{continue;} // Exclusions are disclosed by the snapshot preview.
    const stat=lstatSync(path.join(dir,name));
    if(stat.isDirectory()&&!stat.isSymbolicLink()) walk(path.join(dir,name),rel+'/');
    else {const file=readSnapshotFile(canonical,rel),base=baseline?.files.find(f=>f.path===rel);
      if(!base||!file||snapshotHash(file.bytes)!==base.sha256||file.mode!==base.mode)paths.add(rel);}
  }};walk(canonical);
  for(const base of baseline?.files??[])if(!readSnapshotFile(canonical,base.path))paths.add(base.path);
  return [...paths].sort();
}
export function inspectBusinessRecovery(runId:string):RecoveryInspection {
  const source=getRun(runId),plan=getRunCoordinationPlan(runId),frozen=getRunOrchestrationSnapshot(runId),state=getBusinessState(runId);
  if(!source||!plan||state.contract?.executionMode!=='stage_gated'||!['failed','waiting_for_user'].includes(source.status)
    ||source.status==='waiting_for_user'&&plan.status!=='paused') fail('BUSINESS_CHECKPOINT_UNSUPPORTED','核对入口需要失败或验收边界的逐阶段任务');
  if(!businessProcessesQuiescent(runId)) fail('RESULT_UNKNOWN','执行进程或工具仍未收敛，请先等待或核实进程');
  const scope=runSourceAccess(runId),files=listManagedArtifacts(source!.conversationId).filter(f=>f.runId===runId);
  if(listByRun(runId).some(m=>!isMessageWithinScope(m,scope))||files.some(f=>!isMessageWithinScope(f,scope)))
    fail('PRIVATE_CHECKPOINT_UNSUPPORTED','来源含比本轮更窄的私密授权，无法自动汇入原任务范围；请核对后建立经授权的新任务');
  const tools=listToolExecutions(runId),native=listExecutions(runId);
  const attempts=all<{id:string;step_id:string;status:string;output:string|null;created_at:string}>('SELECT * FROM coordination_step_attempts WHERE run_id=? AND plan_id=? AND revision=? ORDER BY created_at,rowid',runId,plan!.id,plan!.revision);
  const steps:RecoveryInspection['steps']=plan!.steps.filter(s=>s.agentId).map(step=>{
    const attempt=attempts.filter(a=>a.step_id===step.id).at(-1);
    if(attempt&&!isMessageWithinScope(attemptAccess(attempt.id),scope)) fail('PRIVATE_CHECKPOINT_UNSUPPORTED','成员确认输出的权限不能合法迁移');
    const effects=tools.filter(t=>t.attemptId===attempt?.id&&t.replayPolicy!=='safe');
    const executions=native.filter(e=>e.attemptId===attempt?.id);
    const observed=effects.some(t=>t.status==='completed')||files.some(f=>f.attemptId===attempt?.id)
      ||executions.some(e=>e.evidence?.truncated||e.evidence&&e.evidence.beforeDiff!==e.evidence.afterDiff||e.evidence?.commands.some(c=>/Write|Edit|Bash|fileChange|commandExecution/i.test(c.name)));
    const unknown=Boolean(attempt&&!(attempt.status==='completed'&&attempt.output?.trim())&&(effects.length||executions.some(e=>e.permissionMode!=='readonly'&&e.progress?.nativeInvokedAt)));
    return {stepId:step.id,stageId:String(step.metadata.businessStageId),agentId:step.agentId!,attemptId:attempt?.id??'',
      state:attempt?.status==='completed'&&attempt.output?.trim()?'completed':unknown?'unknown':'not_executed',
      reason:attempt?.status==='completed'?'可信成员输出已落库':unknown?'调用中断，副作用或完成结果需所有者核实':'未派发或没有需重放的写入副作用',canConfirmNotExecuted:!observed};
  });
  const unknownUsage=['orchestration_token_reservations','business_stage_token_reservations'].reduce((n,table)=>n+(get<{n:number}>(`SELECT COUNT(*) n FROM ${table} WHERE run_id=? AND status IN ('pending','unknown')`,runId)?.n??0),0);
  const readonly=frozen?.execution?.readonly===true;
  const fees=costRows(runId),costBudget=costBudgetState(runId);
  const requiresReview=!readonly||steps.some(s=>s.state==='unknown')||tools.some(t=>t.status==='needs_attention'||t.replayPolicy!=='safe'&&t.status!=='completed')||unknownUsage>0||fees.some(f=>['pending','unknown'].includes(f.status))||Boolean(get("SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND recovery_attention=1",runId));
  const root=workspaceRootDir({runId,workspace:source!.workspace,workspaceScope:plan!.id.slice(0,8)});
  const paths=scope.visibility==='public'?changedPaths(root):[];
  const item=buildArtifactSnapshot(runId,{stageIds:[],paths,recovery:true});
  const inherited=readBusinessCheckpoint(runId);
  const acceptedArchiveIds=[...new Set([
    ...all<{id:string}>("SELECT s.id FROM artifact_snapshots s JOIN artifact_snapshot_refs r ON r.snapshot_id=s.id WHERE s.run_id=? AND r.owner_type='acceptance'",runId).map(r=>r.id),
    ...(inherited?.acceptedArchives??[]).map(a=>a.id),
    ...(inherited?.archive?.manifest.declarations.some(d=>inherited.accepted.some(a=>a.stageId===d.stageId))?[inherited.archive.id]:[])
  ].filter(id=>readArtifactSnapshot(id).manifest.declarations.some(d=>state.stages.some(s=>s.status==='accepted'&&s.stage.id===d.stageId))))];
  for(const accepted of state.stages.filter(s=>s.status==='accepted')) {
    if(!acceptedArchiveIds.some(id=>readArtifactSnapshot(id).manifest.declarations.some(d=>d.stageId===accepted.stage.id))&&!state.checkpoint?.acceptedStageIds.includes(accepted.stage.id))
      fail('CHECKPOINT_EVIDENCE_INVALID','已验收阶段缺少原始可验证归档');
  }
  const record={runId,scope,readonly,requiresReview,steps,tools:tools.map(t=>({id:t.id,name:t.toolName,status:t.status,replayPolicy:t.replayPolicy})),unknownUsage,snapshot:item.manifest,acceptedArchiveIds,...(costBudget?{costBudget}:{})};
  const fingerprint=stableDigest({record,sourceVersion:state.version,plan:plan,attempts,tools,native,
    fees,rootScope:scope,room:get('SELECT agent_ids,members_version FROM conversations WHERE id=?',source!.conversationId),controls:get('SELECT * FROM orchestration_run_controls WHERE run_id=?',runId)});
  const row=get<{id:string;run_id:string;fingerprint:string;digest:string;record:string}>('SELECT * FROM business_recovery_reviews WHERE run_id=? AND fingerprint=? ORDER BY rowid DESC LIMIT 1',runId,fingerprint);
  const reviewId=row?readReview(row).id:null;
  return {...record,fingerprint,reviewId};
}
export function verifiedBusinessRecovery(runId:string):{inspection:RecoveryInspection;review:RecoveryReview|null} {
  const inspection=inspectBusinessRecovery(runId);
  if(inspection.requiresReview&&!inspection.reviewId) fail('WRITE_RECONCILIATION_REQUIRED','请先由所有者核对已确认改动、未知调用和外部副作用，再预览续跑或返工');
  const row=inspection.reviewId?get<Parameters<typeof readReview>[0]>('SELECT * FROM business_recovery_reviews WHERE id=?',inspection.reviewId):null;
  return {inspection,review:row?readReview(row):null};
}
export function confirmBusinessRecovery(runId:string,value:unknown,owner=false):RecoveryInspection {
  if(!owner)throw new OrchestrationError(403,'OWNER_REQUIRED','副作用核对需所有者管理会话');
  const raw=objectInput(value),input=raw as unknown as RecoveryReviewInput;
  if(Object.keys(raw).some(k=>!['fingerprint','clientRequestId','reason','externalEffectsChecked','steps'].includes(k))
    ||typeof input.fingerprint!=='string'||typeof input.clientRequestId!=='string'||!/^[-a-zA-Z0-9_]{8,100}$/.test(input.clientRequestId)
    ||typeof input.reason!=='string'||input.reason.trim().length<10||input.reason.length>2000||input.externalEffectsChecked!==true||!Array.isArray(input.steps)||input.steps.some(s=>!s||typeof s!=='object'||Array.isArray(s)))
    fail('RECOVERY_REVIEW_INVALID','请填写至少 10 字的核对依据，确认外部副作用并逐项核对未知步骤');
  return tx(()=>{
    const existing=get<Parameters<typeof readReview>[0]>('SELECT * FROM business_recovery_reviews WHERE run_id=? AND client_request_id=?',runId,input.clientRequestId);
    if(existing) {if(stableDigest(readReview(existing).input)!==stableDigest(input))fail('IDEMPOTENCY_CONFLICT','同一核对请求不能更换结论');return inspectBusinessRecovery(runId);}
    const inspection=inspectBusinessRecovery(runId);
    if(inspection.fingerprint!==input.fingerprint)fail('RECOVERY_REVIEW_STALE','文件、账本、授权或阶段状态已变化，请重新核对');
    const unknown=inspection.steps.filter(s=>s.state==='unknown');
    if(input.steps.length!==unknown.length||new Set(input.steps.map(s=>s.stepId)).size!==unknown.length)fail('RECOVERY_REVIEW_INVALID','未知步骤必须逐项核对');
    for(const choice of input.steps) {
      const step=unknown.find(s=>s.stepId===choice.stepId);
      if(!step||Object.keys(choice).some(k=>!['stepId','verdict','reason','output'].includes(k))||!['completed','not_executed'].includes(choice.verdict)
        ||choice.output!==undefined&&typeof choice.output!=='string'||typeof choice.reason!=='string'||choice.reason.trim().length<10||choice.reason.length>2000)fail('RECOVERY_REVIEW_INVALID','步骤核对结论或依据无效');
      if(choice.verdict==='not_executed'&&!step!.canConfirmNotExecuted)fail('RECOVERY_EFFECT_OBSERVED','该步骤已存在文件或工具副作用，不能标为未执行后重放；请人工收尾后确认完成或保持阻断');
      if(choice.verdict==='completed'&&(typeof choice.output!=='string'||choice.output.trim().length<30||Buffer.byteLength(choice.output)>1024*1024))fail('RECOVERY_REVIEW_INVALID','确认完成需提供至少 30 字的实质交付及核对结果');
    }
    const item:RecoveryReview={id:randomUUID(),runId,fingerprint:inspection.fingerprint,input,createdAt:new Date().toISOString()},bytes=Buffer.from(JSON.stringify(item)),digest=snapshotHash(bytes);
    saveArtifactSnapshot(buildArtifactSnapshot(runId,{stageIds:[],paths:inspection.snapshot.files.filter(f=>f.storage==='workspace').map(f=>f.path),recovery:true}),'checkpoint','review:'+item.id);
    run('INSERT INTO business_recovery_reviews(id,run_id,client_request_id,fingerprint,digest,record,created_at) VALUES(?,?,?,?,?,?,?)',item.id,runId,input.clientRequestId,item.fingerprint,digest,sealManagedContent(bytes,aad(item.id,digest)),item.createdAt);
    return {...inspection,reviewId:item.id};
  });
}
export function recoverySnapshot(runId:string,inspection:RecoveryInspection,completedAttemptIds:string[]):SnapshotPackage {
  const state=getBusinessState(runId),source=getRun(runId)!;
  const declared=state.stages.filter(s=>s.status==='accepted').flatMap(s=>s.report?.evidence.flatMap(e=>e.resolution.ref.kind==='workspace_file'&&e.resolution.ref.artifactId?[e.resolution.ref.artifactId]:[])??[]);
  const ids=[...new Set([...declared,...listManagedArtifacts(source.conversationId).filter(f=>f.runId===runId&&(f.createdBy==='user'&&!f.attemptId&&!f.stageId||f.attemptId&&completedAttemptIds.includes(f.attemptId))).map(f=>f.id)])];
  return buildArtifactSnapshot(runId,{stageIds:[],paths:inspection.snapshot.files.filter(f=>f.storage==='workspace').map(f=>f.path),recovery:true,managedIds:ids});
}
