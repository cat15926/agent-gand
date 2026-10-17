import {isMessageVisibleTo,type AutonomousInputV1,type ScopedSourceRef} from '@agent-gand/shared';
import {all,get,run} from '../db/database.ts';
import {autonomousDigest as digest,autonomousFail as fail} from './autonomousPolicy.ts';
import {compileScopedSource,inspectScopedSource,readScopedSourceForOwner,assertScopedOutput,inputLedgerRevision,type ScopedAttemptBinding} from './scopedCollaboration.ts';
import {validateEvidenceBundle} from './evidence.ts';

export interface AutonomousExposure {
  attemptId:string;scopeId:string;scopeSha256:string;manifestSha256:string;ledgerSha256:string;ledgerLength:number;inputs:ScopedSourceRef[];
}
export interface AutonomousResult {
  version:1;workId:string;runId:string;grantId:string;attemptId:string;candidateId:string;message:ScopedSourceRef;artifacts:ScopedSourceRef[];exposure:AutonomousExposure;
}
export function freezeAutonomousExposure(scope:ScopedAttemptBinding):AutonomousExposure {
  assertScopedOutput({...scope,ledgerRevision:inputLedgerRevision(scope.attemptId),outputAccess:{visibility:'private',audience:['user',scope.agentId].sort()}});
  const s=get<{record:string;manifest_id:string}>('SELECT record,manifest_id FROM runtime_execution_scopes WHERE id=? AND run_id=?',scope.scopeId,scope.runId)!;
  const m=get<{record:string}>('SELECT record FROM runtime_context_manifests WHERE id=?',s.manifest_id)!;
  const ledger=all<{record:string}>('SELECT record FROM runtime_input_provenance WHERE attempt_id=? ORDER BY sequence',scope.attemptId).map(r=>JSON.parse(r.record));
  return {attemptId:scope.attemptId,scopeId:scope.scopeId,scopeSha256:digest(JSON.parse(s.record)),manifestSha256:digest(JSON.parse(m.record)),ledgerSha256:digest(ledger),ledgerLength:ledger.length,inputs:ledger.map(e=>e.source)};
}
export function validateAutonomousExposure(runId:string,exposure:AutonomousExposure,options:{exact?:boolean}={}):void {
  const s=get<{record:string;manifest_id:string}>('SELECT record,manifest_id FROM runtime_execution_scopes WHERE id=? AND run_id=?',exposure.scopeId,runId);
  const m=s&&get<{record:string}>('SELECT record FROM runtime_context_manifests WHERE id=?',s.manifest_id);
  const records=all<{record:string}>('SELECT record FROM runtime_input_provenance WHERE attempt_id=? ORDER BY sequence',exposure.attemptId).map(r=>JSON.parse(r.record));
  if(!Number.isSafeInteger(exposure.ledgerLength)||exposure.ledgerLength<1||records.length<exposure.ledgerLength||options.exact&&records.length!==exposure.ledgerLength)return fail('AUTONOMOUS_POLICY_DRIFT');
  const ledger=records.slice(0,exposure.ledgerLength);
  if(!s||!m||digest(JSON.parse(s.record))!==exposure.scopeSha256||digest(JSON.parse(m.record))!==exposure.manifestSha256||digest(ledger)!==exposure.ledgerSha256||digest(ledger.map(e=>e.source))!==digest(exposure.inputs))return fail('AUTONOMOUS_POLICY_DRIFT');
  for(const ref of exposure.inputs)if(digest(inspectScopedSource(runId,ref.kind,ref.id).ref)!==digest(ref))return fail('AUTONOMOUS_POLICY_DRIFT');
}
export function assertAutonomousResultAuthority(grantId:string,runId:string):void {
  if(get('SELECT 1 FROM autonomous_task_revocations WHERE run_id=? AND grant_id IS NULL',runId))return fail('AUTONOMOUS_GRANT_REVOKED');
  let id:string|null=grantId;const seen=new Set<string>();
  while(id){
    if(seen.has(id))return fail('AUTONOMOUS_POLICY_DRIFT');seen.add(id);
    const g:{parent_grant_id:string|null}|undefined=get('SELECT parent_grant_id FROM autonomous_task_grants WHERE id=? AND run_id=?',id,runId);
    if(!g)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    if(get('SELECT 1 FROM autonomous_task_revocations WHERE run_id=? AND grant_id=?',runId,id))return fail('AUTONOMOUS_GRANT_REVOKED');id=g.parent_grant_id;
  }
}
/** Called inside the accepted completion transaction. No new read/disclosure authority is issued. */
export function sealAutonomousResult(input:{runId:string;workId:string;grantId:string;attemptId:string;candidateId:string;messageId:string;exposure:AutonomousExposure}):void {
  const result:AutonomousResult={version:1,runId:input.runId,workId:input.workId,grantId:input.grantId,attemptId:input.attemptId,candidateId:input.candidateId,
    message:compileScopedSource(input.runId,'message',input.messageId),artifacts:all<{id:string}>("SELECT id FROM managed_artifact_versions WHERE run_id=? AND json_extract(record,'$.attemptId')=?",input.runId,input.attemptId).map(r=>compileScopedSource(input.runId,'artifact',r.id)),exposure:input.exposure};
  run('INSERT INTO autonomous_results VALUES(?,?,?,?,?,?,?)',input.workId,input.runId,input.attemptId,input.candidateId,JSON.stringify(result),digest(result),new Date().toISOString());
}
export function loadAutonomousResult(workId:string,visited=new Set<string>()):AutonomousResult {
  if(visited.has(workId)||visited.size>64)return fail('AUTONOMOUS_POLICY_DRIFT');visited.add(workId);
  const row=get<{record:string;sha256:string;run_id:string;attempt_id:string;candidate_id:string}>('SELECT * FROM autonomous_results WHERE work_id=?',workId);
  if(!row)return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
  const result=JSON.parse(row.record) as AutonomousResult;
  if(digest(result)!==row.sha256||result.version!==1||result.workId!==workId||result.runId!==row.run_id||result.attemptId!==row.attempt_id||result.candidateId!==row.candidate_id)return fail('AUTONOMOUS_POLICY_DRIFT');
  assertAutonomousResultAuthority(result.grantId,result.runId);validateAutonomousExposure(result.runId,result.exposure,{exact:true});
  const candidate=get<{summary:string;evidence_bundle_id:string}>('SELECT summary,evidence_bundle_id FROM runtime_completion_candidates WHERE id=? AND attempt_id=? AND status=\'accepted\'',result.candidateId,result.attemptId);
  const output=get<{body:string}>('SELECT body FROM messages WHERE id=? AND run_id=?',result.message.id,result.runId);
  if(!candidate||!output||candidate.summary!==output.body||!validateEvidenceBundle(candidate.evidence_bundle_id,result.runId).valid)return fail('AUTONOMOUS_POLICY_DRIFT');
  for(const ref of [result.message,...result.artifacts])if(digest(inspectScopedSource(result.runId,ref.kind,ref.id).ref)!==digest(ref))return fail('AUTONOMOUS_POLICY_DRIFT');
  for(const ref of result.exposure.inputs)validateAutonomousDerivedSource(result.runId,ref,visited,workId);
  visited.delete(workId);return result;
}
/** Validate transitive result authority on every use, including after model awaits. */
export function validateAutonomousDerivedSource(runId:string,ref:ScopedSourceRef,visited=new Set<string>(),ownWorkId?:string):boolean {
  const copy=get<{record:string;sha256:string;decision_id:string;result_work_id:string}>('SELECT * FROM autonomous_intake_copies WHERE run_id=? AND source_id=?',runId,ref.id);
  if(copy){
    const value=JSON.parse(copy.record),approval=get<{outcome:string;record:string;sha256:string}>('SELECT outcome,record,sha256 FROM autonomous_decision_resolutions WHERE decision_id=?',copy.decision_id);
    if(digest(value)!==copy.sha256||digest(value.ref)!==digest(ref)||!approval||approval.outcome!=='approved'||digest(JSON.parse(approval.record))!==approval.sha256)return fail('AUTONOMOUS_POLICY_DRIFT');
    const proposal=get<{kind:string;record:string;sha256:string}>('SELECT kind,record,sha256 FROM autonomous_decision_proposals WHERE id=?',copy.decision_id);
    const result=loadAutonomousResult(copy.result_work_id,visited);
    if(!proposal||proposal.kind!=='intake'||digest(JSON.parse(proposal.record))!==proposal.sha256||JSON.parse(approval.record).fingerprint!==proposal.sha256||digest(JSON.parse(proposal.record).access)!==digest(value.access)
      ||![result.message,...result.artifacts].some(original=>digest(original)===digest(value.original))||!readScopedSourceForOwner(runId,ref).equals(readScopedSourceForOwner(runId,value.original)))return fail('AUTONOMOUS_POLICY_DRIFT');
    if(digest(inspectScopedSource(runId,ref.kind,ref.id).ref)!==digest(ref))return fail('AUTONOMOUS_POLICY_DRIFT');return true;
  }
  const source=get<{work_id:string}>(`SELECT work_id FROM autonomous_results WHERE run_id=? AND
    (json_extract(record,'$.message.id')=? OR EXISTS(SELECT 1 FROM json_each(json_extract(record,'$.artifacts')) a WHERE json_extract(a.value,'$.id')=?))`,runId,ref.id,ref.id);
  if(!source||source.work_id===ownWorkId)return !!source;
  const result=loadAutonomousResult(source.work_id,visited);
  if(![result.message,...result.artifacts].some(r=>digest(r)===digest(ref)))return fail('AUTONOMOUS_POLICY_DRIFT');return true;
}
export function autonomousDerivedInputs(runId:string,refs:ScopedSourceRef[],participants:string[]):AutonomousInputV1[]{
  return refs.map(source=>{
    if(!validateAutonomousDerivedSource(runId,source))return fail('AUTONOMOUS_AUTHORITY_INVALID');
    const current=inspectScopedSource(runId,source.kind,source.id);if(digest(current.ref)!==digest(source))return fail('AUTONOMOUS_POLICY_DRIFT');
    return {source,readers:participants.filter(id=>isMessageVisibleTo(current.access,id))};
  });
}
