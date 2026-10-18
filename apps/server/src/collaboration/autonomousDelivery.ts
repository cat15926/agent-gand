import {flowFinal} from '../runtime/autonomousFlowFacts.ts';
import {instructionRevision,autonomousEntryEnabled} from '../runtime/autonomousInstructions.ts';
import {randomUUID} from 'node:crypto';
import {intersectMessageAccess,isMessageVisibleTo,isMessageWithinScope,type AutonomousAggregateIntentV1,type AutonomousEmitIntentV1,type AutonomousQuestionIntentV1,type AutonomousGrantBinding,type AutonomousDecisionPreview,type MessageAccess,type ScopedSourceRef} from '@agent-gand/shared';
import {all,get,run,tx} from '../db/database.ts';
import {post} from '../messaging/inbox.ts';
import {setRunStatus} from '../runs/trace.ts';
import {createManagedArtifact,getManagedArtifact} from '../artifacts/store.ts';
import {loadRuntimeContract} from '../runtime/runPolicy.ts';
import {autonomousDigest as digest,autonomousFail as fail,autonomousObject as object,loadAutonomousTaskPolicy} from '../runtime/autonomousPolicy.ts';
import {assertAutonomousGrant,assertAutonomousGrantReady,loadAutonomousTaskGrant} from '../runtime/autonomousTasks.ts';
import {freezeAutonomousExposure,validateAutonomousExposure,assertAutonomousResultAuthority,loadAutonomousResult,autonomousDerivedInputs,validateAutonomousDerivedSource,type AutonomousExposure} from '../runtime/autonomousResults.ts';
import {assertScopedOutput,compileScopedSource,inspectScopedSource,inputLedgerRevision,readScopedSourceForOwner,type ScopedAttemptBinding} from '../runtime/scopedCollaboration.ts';
import {commitEmitActionCommand,commitHoldActionCommand,commitWakeActionCommand} from '../runtime/actionCommands.ts';
import {observeAutonomousWaiting,observeWakeLink} from '../runtime/shadow.ts';
import {createDecision,createDispatch,finishAttempt,resolveDecision} from './store.ts';
import {autonomousWork,childWorks,commitAutonomousDelegation,getScopeAccess,assertPlanCapacity,assertAutonomousDispatchLimit,workForDispatch,type AutonomousWork} from './autonomousGraph.ts';

interface SourceSelection {workId:string;refs:ScopedSourceRef[];}
interface Plan {
  id:string;runId:string;workId:string;grantId:string;attemptId:string;kind:'update'|'final';format:AutonomousEmitIntentV1['format'];
  body:string;access:MessageAccess;exposure:AutonomousExposure;refs:ScopedSourceRef[];intentSha256:string;decisionId?:string;instructionRevision?:number;
}
interface Proposal {
  id:string;runId:string;workId:string;grantId:string;kind:'question'|'intake'|'release';fingerprint:string;
  exposure:AutonomousExposure;body:string;access:MessageAccess;membersVersion:number;intent:unknown;planId?:string;sources?:SourceSelection[];
}
interface ProposalRow {id:string;run_id:string;work_id:string;source_attempt_id:string;source_dispatch_id:string;collaboration_decision_id:string;generation:number;record:string;sha256:string;kind:Proposal['kind'];}
const now=()=>new Date().toISOString();
export const autonomousDeliveryEnabled=(runId:string)=>loadRuntimeContract(runId)?.features?.autonomousCollaboration?.deliveryVersion===1;
function context(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,action:'aggregate'|'emit'|'request_user'){
  if(!autonomousDeliveryEnabled(binding.runId)||scope.runId!==binding.runId||scope.attemptId!==binding.attemptId)return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
  const value=assertAutonomousGrant(binding,action),attempt=get<{dispatch_id:string}>('SELECT dispatch_id FROM collaboration_attempts WHERE id=?',binding.attemptId)!;
  const work=workForDispatch(attempt.dispatch_id);if(!work||work.grant_id!==binding.grantId||scope.agentId!==value.grant.agentId)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  return {...value,work,dispatchId:attempt.dispatch_id};
}
function selected(work:AutonomousWork,keys:string[]):SourceSelection[]{
  const children=childWorks(work.id);
  return keys.map(key=>{const child=children.find(w=>w.work_key===key);if(!child)return fail('AUTONOMOUS_ACCESS_DENIED');const result=loadAutonomousResult(child.id);return {workId:child.id,refs:[result.message,...result.artifacts]};});
}
function validateRefs(runId:string,refs:ScopedSourceRef[]):void {
  for(const ref of refs){if(digest(inspectScopedSource(runId,ref.kind,ref.id).ref)!==digest(ref))return fail('AUTONOMOUS_POLICY_DRIFT');validateAutonomousDerivedSource(runId,ref);}
}
function artifactLinks(refs:ScopedSourceRef[]):string {
  return refs.map(ref=>{const a=getManagedArtifact(ref.id,'user');return `\n\n产物：${a.path} · v${a.version} · ${a.sha256}\n[下载受控文件](/api/accounts/artifacts/${encodeURIComponent(a.id)}/content)`;}).join('');
}
function bundle(runId:string,sources:SourceSelection[]):string {
  return sources.map(s=>{const work=autonomousWork(s.workId)!;const result=loadAutonomousResult(s.workId);
    return `### ${work.work_key}\n\n${readScopedSourceForOwner(runId,result.message).toString('utf8')}`+artifactLinks(result.artifacts);
  }).join('\n\n');
}
function room(runId:string){
  const value=get<{id:string;agent_ids:string;members_version:number;archived_at:string|null}>('SELECT c.* FROM conversations c JOIN runs r ON r.conversation_id=c.id WHERE r.id=?',runId);
  if(!value||value.archived_at)return fail('AUTONOMOUS_AUTHORITY_INVALID');return value;
}
function targetAccess(runId:string,access:MessageAccess):void {
  const members=JSON.parse(room(runId).agent_ids) as string[];
  if(access.audience.some(id=>id!=='user'&&!members.includes(id)))return fail('AUTONOMOUS_ACCESS_DENIED');
}
function receipt(scope:ScopedAttemptBinding,key:string,payload:Record<string,unknown>){
  const commandKey=`delivery:receipt:${digest([scope.attemptId,key])}`;
  const prior=get<{message_id:string}>('SELECT message_id FROM autonomous_tool_receipts WHERE command_key=?',commandKey);
  if(prior)return {...payload,receiptId:prior.message_id};
  const message=post({runId:scope.runId,from:'system',to:scope.agentId,kind:'system',body:JSON.stringify(payload),...getScopeAccess(scope.scopeId),meta:{autonomousInternal:true},clientMessageId:commandKey});
  const ref=compileScopedSource(scope.runId,'message',message.id);
  run('INSERT INTO autonomous_tool_receipts VALUES(?,?,?,?,?,?,?)',message.id,scope.attemptId,scope.scopeId,commandKey,JSON.stringify(ref),digest(ref),now());
  return {...payload,receiptId:message.id};
}
function rowProposal(id:string):{row:ProposalRow;p:Proposal}{
  const row=get<ProposalRow>('SELECT * FROM autonomous_decision_proposals WHERE id=?',id);if(!row)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  const p=JSON.parse(row.record) as Proposal;if(digest(p)!==row.sha256||p.id!==row.id||p.runId!==row.run_id||p.workId!==row.work_id||p.kind!==row.kind)return fail('AUTONOMOUS_POLICY_DRIFT');return {row,p};
}
function decisionOutcome(id:string){const r=get<{outcome:string;record:string;sha256:string}>('SELECT * FROM autonomous_decision_resolutions WHERE decision_id=?',id);if(r&&digest(JSON.parse(r.record))!==r.sha256)return fail('AUTONOMOUS_POLICY_DRIFT');return r;}
function validateProposal(id:string){
  const {row,p}=rowProposal(id);assertAutonomousGrantReady(p.grantId,{allowWaitingForUser:true});validateAutonomousExposure(p.runId,p.exposure,{exact:true});
  for(const ref of p.exposure.inputs)validateAutonomousDerivedSource(p.runId,ref);
  if(room(p.runId).members_version!==p.membersVersion)return fail('AUTONOMOUS_POLICY_DRIFT');
  validateRefs(p.runId,(p.sources??[]).flatMap(s=>s.refs));
  const c=get<{state:string;generation:number}>('SELECT state,generation FROM runtime_custody WHERE subject_id=?',loadAutonomousTaskGrant(p.grantId).subjectId);
  if(c?.state!=='waiting'||c.generation!==row.generation)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  return {row,p};
}
function propose(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,kind:Proposal['kind'],intent:unknown,body:string,access:MessageAccess,sources?:SourceSelection[],planId?:string){
  const {work,grant,dispatchId}=context(binding,scope,kind==='intake'?'aggregate':kind==='release'?'emit':'request_user');
  const fingerprint=digest({workId:work.id,kind,intent,body,access,sources});
  const prior=get<{id:string}>('SELECT id FROM autonomous_decision_proposals WHERE work_id=? AND json_extract(record,\'$.fingerprint\')=?',work.id,fingerprint);
  if(prior){const outcome=decisionOutcome(prior.id);return {waiting:!outcome,decisionId:prior.id,status:outcome?.outcome??'pending'};}
  assertPlanCapacity(binding.runId,0);
  if((get<{n:number}>('SELECT COUNT(*) n FROM autonomous_decision_proposals WHERE run_id=?',binding.runId)?.n??0)>=6)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
  const id=randomUUID(),exposure=freezeAutonomousExposure(scope),p:Proposal={id,runId:binding.runId,workId:work.id,grantId:grant.id,kind,fingerprint,exposure,body,access,membersVersion:room(binding.runId).members_version,intent,planId,sources};
  const committed=commitHoldActionCommand({runId:binding.runId,commandKey:`delivery:decision:${fingerprint}`,attemptId:binding.attemptId,dispatchId,scope:{...scope,ledgerRevision:inputLedgerRevision(scope.attemptId),outputAccess:{visibility:'private',audience:['user',grant.agentId].sort()}},intentFingerprint:fingerprint,execute:()=>{
    const prompt=post({runId:binding.runId,from:grant.agentId,to:'user',kind:'agent',messageType:'collaboration_wait_user',...(kind==='question'?access:{visibility:'private' as const,audience:['user',grant.agentId].sort()}),
      body:kind==='question'?body:kind==='intake'?'汇总需要新增结果读取者，请查看这一条确切授权。':'发布范围超出当前来源权限，请查看这一条确切授权。',meta:{autonomousDecisionId:id},clientMessageId:`delivery:decision-prompt:${id}`});
    const decision=createDecision({runId:binding.runId,conversationId:room(binding.runId).id,dispatchId,idempotencyKey:`delivery:decision:${id}`,kind:kind==='question'?'agent_question':'autonomous_authorization',promptMessageId:prompt.id,payload:{agentId:grant.agentId,autonomousDecisionId:id,decisionKind:kind}});
    const generation=observeAutonomousWaiting(dispatchId,binding.attemptId,grant.agentId,id);
    run('INSERT INTO autonomous_decision_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',id,binding.runId,work.id,scope.scopeId,binding.attemptId,dispatchId,decision.id,kind,generation,JSON.stringify(p),digest(p),now());
    finishAttempt({attemptId:binding.attemptId,dispatchId,status:'completed',output:'等待已登记的具体用户决策。'});
    return {decisionId:id,status:'pending'};
  }});
  return {waiting:true,...committed.result};
}
export function aggregateAutonomousResults(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,intent:AutonomousAggregateIntentV1){
  return tx(()=>{
    const {work,grant,policy}=context(binding,scope,'aggregate');
    if(!grant.participantIds.includes(intent.agentId)||policy.members.find(m=>m.agentId===intent.agentId)?.driver!=='builtin-llm')return fail('AUTONOMOUS_ACCESS_DENIED');
    let sources=selected(work,intent.resultKeys);
    const logical={...intent,commandKey:undefined},fingerprint=digest({workId:work.id,kind:'intake',intent:logical,body:bundle(binding.runId,sources),access:{visibility:'private',audience:['user',intent.agentId].sort()},sources});
    const prior=get<{id:string}>('SELECT id FROM autonomous_decision_proposals WHERE work_id=? AND json_extract(record,\'$.fingerprint\')=?',work.id,fingerprint);
    if(prior&&decisionOutcome(prior.id)?.outcome==='approved'){
      validateAutonomousExposure(binding.runId,rowProposal(prior.id).p.exposure);
      sources=sources.map(s=>({workId:s.workId,refs:all<{record:string}>('SELECT record FROM autonomous_intake_copies WHERE decision_id=? AND result_work_id=?',prior.id,s.workId).map(r=>JSON.parse(r.record).ref)}));
    }
    const readable=sources.every(s=>s.refs.every(ref=>isMessageVisibleTo(inspectScopedSource(binding.runId,ref.kind,ref.id).access,intent.agentId)));
    if(!readable){
      const access:MessageAccess={visibility:'private',audience:['user',intent.agentId].sort()};
      const result=propose(binding,scope,'intake',logical,bundle(binding.runId,sources),access,sources);
      return result.waiting?result:{...result,...receipt(scope,`intake:${result.decisionId}`,{status:result.status,decisionId:result.decisionId})};
    }
    const refs=sources.flatMap(s=>s.refs),derived=autonomousDerivedInputs(binding.runId,refs,grant.participantIds);
    const committed=commitAutonomousDelegation(binding,scope,{commandKey:intent.commandKey,items:[{key:intent.key,agentId:intent.agentId,objective:intent.objective,inputIds:refs.map(r=>r.id),dependsOn:[],participantIds:[intent.agentId],allowedTools:intent.allowedTools,delegableTools:[]}]},{aggregateInputs:derived,sources});
    return {waiting:true,aggregated:true,...committed.result};
  });
}
function loadPlan(id:string):Plan{
  const row=get<{record:string;sha256:string}>('SELECT record,sha256 FROM autonomous_emission_plans WHERE id=?',id);if(!row)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  const p=JSON.parse(row.record) as Plan;if(digest(p)!==row.sha256||p.id!==id)return fail('AUTONOMOUS_POLICY_DRIFT');assertAutonomousResultAuthority(p.grantId,p.runId);validateAutonomousExposure(p.runId,p.exposure);validateRefs(p.runId,[...p.refs,...p.exposure.inputs]);return p;
}
function savePlan(plan:Plan,key:string):void {if(autonomousEntryEnabled(plan.runId))plan.instructionRevision=instructionRevision(plan.runId);run('INSERT INTO autonomous_emission_plans VALUES(?,?,?,?,?,?,?,?,?)',plan.id,plan.runId,plan.workId,plan.attemptId,key,plan.kind,JSON.stringify(plan),digest(plan),now());}
function publishPlan(plan:Plan,approved=false){
  const prior=get<{message_id:string}>('SELECT message_id FROM autonomous_emission_records WHERE plan_id=?',plan.id);if(prior)return prior.message_id;
  loadPlan(plan.id);targetAccess(plan.runId,plan.access);
  if(plan.decisionId&&!approved&&decisionOutcome(plan.decisionId)?.outcome!=='approved')return fail('AUTONOMOUS_ACCESS_DENIED');
  const message=post({runId:plan.runId,from:loadAutonomousTaskGrant(plan.grantId).agentId,to:plan.access.visibility==='public'?'all':plan.access.audience.filter(id=>id!=='user').join(',')||'user',kind:'agent',body:plan.body,...plan.access,
    messageType:plan.kind==='final'?'collaboration_result':'informational',meta:{autonomousEmissionId:plan.id,authorizedBy:plan.decisionId?'owner_exact':'task_sources'},clientMessageId:`delivery:published:${plan.id}`});
  if(message.body!==plan.body||digest({visibility:message.visibility,audience:message.audience})!==digest(plan.access))return fail('AUTONOMOUS_POLICY_DRIFT');
  const record={planId:plan.id,body:plan.body,access:plan.access,sourceRefs:plan.refs,decisionId:plan.decisionId??null};
  run('INSERT INTO autonomous_emission_records VALUES(?,?,?,?,?,?,?)',randomUUID(),plan.id,plan.runId,message.id,JSON.stringify(record),digest(record),now());return message.id;
}
export function emitAutonomousResult(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,intent:AutonomousEmitIntentV1){
  return tx(()=>{
    const {work,grant,policy,dispatchId}=context(binding,scope,'emit');targetAccess(binding.runId,intent.access);
    if(intent.kind==='final'&&work.parent_work_id)return fail('AUTONOMOUS_ACCESS_DENIED');
    const key=`delivery:emit:${work.id}:${intent.commandKey}`,existing=get<{id:string}>('SELECT id FROM autonomous_emission_plans WHERE command_key=?',key);
    if(existing){const plan=loadPlan(existing.id);if(plan.intentSha256!==digest(intent))return fail('AUTONOMOUS_AUTHORITY_INVALID');return {waiting:false,...receipt(scope,key,{planId:plan.id,status:plan.decisionId?decisionOutcome(plan.decisionId)?.outcome??'pending':'authorized'})};}
    const exposure=freezeAutonomousExposure(scope),sources=intent.format==='result_bundle'?selected(work,intent.resultKeys!):[],refs=sources.flatMap(s=>s.refs);
    const counts=childWorks(work.id).reduce<Record<string,number>>((n,w)=>{const state=get<{status:string}>('SELECT status FROM runtime_subjects WHERE id=?',loadAutonomousTaskGrant(w.grant_id).subjectId)!.status;n.total=(n.total??0)+1;n[state]=(n[state]??0)+1;return n;},{total:0});
    const body=intent.format==='text'?intent.text!:intent.format==='result_bundle'?bundle(binding.runId,sources):JSON.stringify({version:1,profile:'task-status-v1',counts});
    let allowed=isMessageWithinScope(policy.rootAccess,intent.access);
    if(intent.format==='text'){
      try{assertScopedOutput({...scope,ledgerRevision:inputLedgerRevision(scope.attemptId),outputAccess:intent.access});}catch{allowed=false;}
    }else if(intent.format==='result_bundle')allowed=allowed&&refs.every(ref=>isMessageWithinScope(inspectScopedSource(binding.runId,ref.kind,ref.id).access,intent.access));
    // Fixed counts contain no keys, objectives, result text, error strings or model-authored fields.
    const id=randomUUID();let decisionId:string|undefined;
    if(!allowed){
      const proposed=propose(binding,scope,'release',{...intent,commandKey:undefined},body,intent.access,sources,id);decisionId=proposed.decisionId;
      const existingPlan=rowProposal(decisionId).p.planId;
      if(existingPlan!==id){const old=loadPlan(existingPlan!);return proposed.waiting?{...proposed,planId:old.id}:{...proposed,...receipt(scope,key,{status:proposed.status,decisionId,planId:old.id})};}
      const plan:Plan={id,runId:binding.runId,workId:work.id,grantId:grant.id,attemptId:binding.attemptId,kind:intent.kind,format:intent.format,body,access:intent.access,exposure,refs,intentSha256:digest(intent),decisionId};
      if(!get('SELECT 1 FROM autonomous_emission_plans WHERE id=?',id))savePlan(plan,key);
      return proposed.waiting?{...proposed,planId:id}:{...proposed,...receipt(scope,key,{status:proposed.status,decisionId,planId:id})};
    }
    return {waiting:false,...commitEmitActionCommand({runId:binding.runId,commandKey:key,attemptId:binding.attemptId,dispatchId,scope:{...scope,ledgerRevision:inputLedgerRevision(scope.attemptId),outputAccess:{visibility:'private',audience:['user',grant.agentId].sort()}},intentFingerprint:digest(intent),execute:()=>{
      const plan:Plan={id,runId:binding.runId,workId:work.id,grantId:grant.id,attemptId:binding.attemptId,kind:intent.kind,format:intent.format,body,access:intent.access,exposure,refs,intentSha256:digest(intent)};
      savePlan(plan,key);const messageId=intent.kind==='update'?publishPlan(plan):undefined;
      return receipt(scope,key,{planId:id,status:'authorized',...(messageId?{messageId}:{})});
    }}).result};
  });
}
export function requestAutonomousUser(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,intent:AutonomousQuestionIntentV1){
  return tx(()=>{const {work}=context(binding,scope,'request_user');const logical={questions:intent.questions};
    const body=intent.questions.map(q=>`${q.question}\n用于：${q.requiredFor}`).join('\n\n');
    const result=propose(binding,scope,'question',logical,body,getScopeAccess(scope.scopeId));
    return result.waiting?result:{...result,...receipt(scope,`question:${work.id}:${digest(logical)}`,{decisionId:result.decisionId,status:result.status})};
  });
}

/** Management-authenticated preview only. Generic task APIs expose no draft/result bytes. */
export function previewAutonomousDecision(id:string):AutonomousDecisionPreview {
  const {p,row}=validateProposal(id);if(p.kind==='question')return fail('AUTONOMOUS_CONTRACT_INVALID');
  return {id,runId:p.runId,kind:p.kind,fingerprint:row.sha256,status:decisionOutcome(id)?.outcome??'pending',body:p.body,access:p.access,
    reason:p.kind==='intake'?'仅授权指定成员读取这些确切结果版本，原始材料权限不改变。':'仅批准这段确切文字及接收范围，不授予后续自由发布权限。',expiresAt:loadAutonomousTaskPolicy(p.runId)!.budget.deadlineAt};
}
export function resolveAutonomousAuthorization(id:string,value:unknown,owner:string){
  return tx(()=>{
    const v=object(value,['fingerprint','action']);if(!['approve','deny'].includes(String(v.action)))return fail('AUTONOMOUS_CONTRACT_INVALID');
    const saved=rowProposal(id);if(saved.p.kind==='question'||v.fingerprint!==saved.row.sha256)return fail('AUTONOMOUS_POLICY_DRIFT');
    const previous=decisionOutcome(id),outcome=v.action==='approve'?'approved':'denied';
    if(previous){if(previous.outcome!==outcome)return fail('AUTONOMOUS_AUTHORITY_INVALID');return {runId:saved.p.runId,status:outcome};}
    const {p,row}=validateProposal(id),record={fingerprint:row.sha256,action:v.action,owner};
    run('INSERT INTO autonomous_decision_resolutions VALUES(?,?,?,?,?,?,?)',id,p.runId,outcome,owner,JSON.stringify(record),digest(record),now());
    if(outcome==='approved'&&p.kind==='intake'){
      for(const selection of p.sources??[])for(const original of selection.refs){
        const bytes=readScopedSourceForOwner(p.runId,original);let ref:ScopedSourceRef;
        if(original.kind==='artifact'){
          const prior=getManagedArtifact(original.id,'user'),copy=createManagedArtifact({runId:p.runId,path:prior.path,content:bytes,access:p.access,mimeType:prior.mimeType,createdBy:'user'});ref=compileScopedSource(p.runId,'artifact',copy.id);
        }else{
          const copy=post({runId:p.runId,from:'user',to:p.access.audience.filter(id=>id!=='user').join(','),kind:'system',body:bytes.toString('utf8'),...p.access,meta:{autonomousIntakeDecisionId:id},clientMessageId:`delivery:intake:${id}:${original.id}`});ref=compileScopedSource(p.runId,'message',copy.id);
        }
        const value={ref,original,decisionId:id,access:p.access};run('INSERT INTO autonomous_intake_copies VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,p.runId,selection.workId,ref.id,JSON.stringify(value),digest(value),now());
      }
    }
    if(outcome==='approved'&&p.kind==='release'&&p.planId){const plan=loadPlan(p.planId);if(plan.kind==='update')publishPlan(plan,true);}
    resolveDecision(row.collaboration_decision_id,outcome==='approved'?'accepted':'rejected',{autonomousDecisionId:id,outcome});setRunStatus(p.runId,'running');
    reconcileAutonomousDecisions(p.runId);return {runId:p.runId,status:outcome};
  });
}
export function answerAutonomousQuestion(collaborationDecisionId:string,message:string){
  return tx(()=>{
    const ref=get<{id:string}>('SELECT id FROM autonomous_decision_proposals WHERE collaboration_decision_id=?',collaborationDecisionId);if(!ref)return null;
    const saved=rowProposal(ref.id);if(saved.p.kind!=='question')return fail('AUTONOMOUS_ACCESS_DENIED');
    if(typeof message!=='string'||!message.trim()||message.length>16000)return fail('AUTONOMOUS_CONTRACT_INVALID');
    if(decisionOutcome(ref.id))return {runId:saved.p.runId};
    const {p,row}=validateProposal(ref.id),grant=loadAutonomousTaskGrant(p.grantId);
    const answer=post({runId:p.runId,from:'user',to:grant.agentId,kind:'user',body:message.trim(),...p.access,clientMessageId:`delivery:answer:${p.id}`});
    const record={messageId:answer.id,fingerprint:row.sha256};run('INSERT INTO autonomous_decision_resolutions VALUES(?,?,\'answered\',?,?,?,?)',p.id,p.runId,'user',JSON.stringify(record),digest(record),now());
    resolveDecision(row.collaboration_decision_id,'accepted',{autonomousDecisionId:p.id,messageId:answer.id});setRunStatus(p.runId,'running');reconcileAutonomousDecisions(p.runId);return {runId:p.runId};
  });
}
/** Persisted resolutions let startup reconcile a missing unique wake without repeating the answer. */
export function reconcileAutonomousDecisions(runId:string):void {
  if(!autonomousDeliveryEnabled(runId))return;
  for(const row of all<ProposalRow>('SELECT p.* FROM autonomous_decision_proposals p JOIN autonomous_decision_resolutions r ON r.decision_id=p.id WHERE p.run_id=? ORDER BY p.created_at,p.rowid',runId)){
    if(get('SELECT 1 FROM runtime_action_commands WHERE command_key=?',`delivery:decision-wake:${row.id}`))continue;
    const {p}=validateProposal(row.id),resolution=decisionOutcome(p.id)!;assertAutonomousDispatchLimit(runId);
    commitWakeActionCommand({runId,commandKey:`delivery:decision-wake:${p.id}`,autonomousDecisionWake:{decisionId:p.id,generation:row.generation},execute:()=>{
      const work=autonomousWork(p.workId)!,grant=loadAutonomousTaskGrant(work.grant_id);let sourceId:string;
      if(resolution.outcome==='answered')sourceId=JSON.parse(resolution.record).messageId;
      else sourceId=post({runId,from:'system',to:grant.agentId,kind:'system',body:JSON.stringify({version:1,decisionId:p.id,kind:p.kind,status:resolution.outcome}),...getScopeAccess(p.exposure.scopeId),meta:{autonomousInternal:true},clientMessageId:`delivery:decision-return:${p.id}`}).id;
      const resume=createDispatch({runId,conversationId:room(runId).id,sourceMessageId:work.objective_message_id,parentDispatchId:row.source_dispatch_id,kind:'resume',from:'system',targetAgentId:grant.agentId,depth:grant.depth,idempotencyKey:`delivery:decision-resume:${p.id}`});
      observeWakeLink(row.source_dispatch_id,resume.id,p.id,row.generation);run('INSERT INTO autonomous_dispatch_work VALUES(?,?,?)',resume.id,work.id,now());return {dispatchId:resume.id,sourceMessageId:sourceId};
    }});
  }
}
export function aggregateReturnInputs(work:AutonomousWork):ScopedSourceRef[]{
  const actor=loadAutonomousTaskGrant(work.grant_id).agentId;
  return childWorks(work.id).filter(w=>!!get('SELECT 1 FROM autonomous_aggregate_sources WHERE work_id=?',w.id)&&!!get('SELECT 1 FROM autonomous_results WHERE work_id=?',w.id)).flatMap(w=>{
    const result=loadAutonomousResult(w.id);return isMessageVisibleTo(inspectScopedSource(work.run_id,result.message.kind,result.message.id).access,actor)?[result.message,...result.artifacts.filter(ref=>isMessageVisibleTo(inspectScopedSource(work.run_id,ref.kind,ref.id).access,actor))]:[];
  });
}
/** Called only within the accepted terminal transaction; no separate model request or approval round. */
export function prepareAutonomousFinal(runId:string):{messageId:string;body:string;access:MessageAccess}{
  const root=get<AutonomousWork>('SELECT * FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NULL',runId)!;
  const protocol=flowFinal(runId);
  if(protocol){const result=loadAutonomousResult(root.id),policy=loadAutonomousTaskPolicy(runId)!;
    const plan:Plan={id:randomUUID(),runId,workId:root.id,grantId:root.grant_id,attemptId:result.attemptId,kind:'final',format:'text',body:protocol.body,access:policy.outputAccess,exposure:result.exposure,refs:[protocol.ref],intentSha256:digest(['protocol-final',protocol.ref])};
    savePlan(plan,`delivery:flow-final:${root.id}`);return {messageId:publishPlan(plan),body:plan.body,access:plan.access};}
  const latest=get<{id:string}>('SELECT id FROM autonomous_emission_plans WHERE work_id=? AND kind=\'final\' ORDER BY created_at DESC,rowid DESC LIMIT 1',root.id);
  if(latest){const plan=loadPlan(latest.id);if((!autonomousEntryEnabled(runId)||plan.instructionRevision===instructionRevision(runId))&&(!plan.decisionId||decisionOutcome(plan.decisionId)?.outcome==='approved')){return {messageId:publishPlan(plan),body:plan.body,access:plan.access};}}
  const result=loadAutonomousResult(root.id),sources=childWorks(root.id).map(w=>({workId:w.id,refs:[loadAutonomousResult(w.id).message,...loadAutonomousResult(w.id).artifacts]}));
  const refs=[result.message,...result.artifacts,...sources.flatMap(s=>s.refs)],policy=loadAutonomousTaskPolicy(runId)!;
  const intersection=intersectMessageAccess([policy.outputAccess,...refs.map(ref=>inspectScopedSource(runId,ref.kind,ref.id).access)]);
  const access={...intersection,audience:[...intersection.audience].sort()};
  const body=readScopedSourceForOwner(runId,result.message).toString('utf8')+artifactLinks(result.artifacts)+(sources.length?'\n\n'+bundle(runId,sources):'');
  const plan:Plan={id:randomUUID(),runId,workId:root.id,grantId:root.grant_id,attemptId:result.attemptId,kind:'final',format:'result_bundle',body,access,exposure:result.exposure,refs,intentSha256:digest(['automatic-owner-delivery',refs])};
  savePlan(plan,`delivery:auto-final:${root.id}`);return {messageId:publishPlan(plan),body,access};
}
