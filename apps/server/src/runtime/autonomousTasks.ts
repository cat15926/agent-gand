import {randomUUID} from 'node:crypto';
import {isMessageVisibleTo,isMessageWithinScope,DEFAULT_RESPONSE_TIMEOUT_MS,DEFAULT_SCOPED_RUN_TOKENS,
  type AutonomousTaskPolicyV1,type AutonomousTaskGrantV1,type AutonomousGrantBinding,type AutonomousActionName,type MessageAccess,type AutonomousInputV1} from '@agent-gand/shared';
import {get,run,tx} from '../db/database.ts';
import {config} from '../config.ts';
import {listRunAgentSnapshots} from '../runs/trace.ts';
import {checkPermission} from '../tools/types.ts';
import {SCOPED_FILE_TOOLS} from './scopedFileTools.ts';
import {inspectScopedSource} from './scopedCollaboration.ts';
import {executionPolicyForProfile,loadRuntimeContract,resolveRunPolicy} from './runPolicy.ts';
import {planCollaborationAdmission} from './subjectContract.ts';
import {freezeRuntimeContract} from './controlAction.ts';
import {captureExecutionBinding,assertBindingAuthorized} from '../execution/authority.ts';
import {scopedNativeAgentSupported} from './scopedCapabilities.ts';
import {normalizeCostPolicy} from '../orchestration/costPolicy.ts';
import {autonomousDigest as digest,autonomousFail as fail,autonomousObject as object,autonomousStrings as strings,loadAutonomousTaskPolicy} from './autonomousPolicy.ts';
import {validateAutonomousDerivedSource} from './autonomousResults.ts';

const ACTIONS:AutonomousActionName[]=['delegate','aggregate','emit','request_user','complete'];
const list=(value:unknown):string[]=>{if(!strings(value))return fail('AUTONOMOUS_CONTRACT_INVALID');return [...value];};
const text=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>240)return fail('AUTONOMOUS_CONTRACT_INVALID');return value;};
const subset=(values:string[],ceiling:string[]):void=>{if(values.some(id=>!ceiling.includes(id)))fail('AUTONOMOUS_ACCESS_DENIED');};
function access(value:unknown):MessageAccess {
  const p=object(value,['visibility','audience']);
  if(!['private','public'].includes(String(p.visibility)))return fail('AUTONOMOUS_CONTRACT_INVALID');
  const audience=list(p.audience);
  if(p.visibility==='public'&&audience.length)return fail('AUTONOMOUS_CONTRACT_INVALID');
  return {visibility:p.visibility as 'public'|'private',audience:p.visibility==='public'?[]:[...new Set(['user',...audience])].sort()};
}
function sourceInput(runId:string,value:unknown,participants:string[]):AutonomousInputV1 {
  const v=object(value,['kind','id','readers']);
  if(!['message','artifact','tool_execution'].includes(String(v.kind)))return fail('AUTONOMOUS_CONTRACT_INVALID');
  const readers=list(v.readers);subset(readers,participants);
  const current=inspectScopedSource(runId,v.kind as AutonomousInputV1['source']['kind'],text(v.id));
  if(readers.some(id=>!isMessageVisibleTo(current.access,id)))return fail('AUTONOMOUS_ACCESS_DENIED');
  return {source:current.ref,readers};
}
function checkInput(runId:string,input:AutonomousInputV1,reader?:string,output?:MessageAccess):void {
  const value=inspectScopedSource(runId,input.source.kind,input.source.id);
  if(digest(value.ref)!==digest(input.source))fail('AUTONOMOUS_POLICY_DRIFT');
  if(get("SELECT 1 FROM runtime_contracts WHERE run_id=? AND json_extract(payload,'$.features.autonomousCollaboration.deliveryVersion')=1",runId))validateAutonomousDerivedSource(runId,input.source);
  if(reader&&(!input.readers.includes(reader)||!isMessageVisibleTo(value.access,reader)))fail('AUTONOMOUS_ACCESS_DENIED');
  if(output&&!isMessageWithinScope(value.access,output))fail('AUTONOMOUS_ACCESS_DENIED');
}
function persistGrant(grant:AutonomousTaskGrantV1,key:string,intent:unknown):void {
  run('INSERT INTO autonomous_task_grants(id,run_id,parent_grant_id,subject_id,agent_id,depth,command_key,intent_sha256,record,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    grant.id,grant.runId,grant.parentGrantId,grant.subjectId,grant.agentId,grant.depth,key,digest(intent),JSON.stringify(grant),digest(grant),grant.createdAt);
}
export function loadAutonomousTaskGrant(id:string):AutonomousTaskGrantV1 {
  const row=get<{id:string;run_id:string;subject_id:string;agent_id:string;parent_grant_id:string|null;depth:number;record:string;sha256:string}>('SELECT * FROM autonomous_task_grants WHERE id=?',id);
  if(!row)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  let grant:AutonomousTaskGrantV1;try{grant=JSON.parse(row.record);}catch{return fail('AUTONOMOUS_CONTRACT_INVALID');}
  if(digest(grant)!==row.sha256||grant.version!==1||grant.id!==row.id||grant.runId!==row.run_id||grant.subjectId!==row.subject_id||grant.agentId!==row.agent_id||grant.parentGrantId!==row.parent_grant_id||grant.depth!==row.depth)return fail('AUTONOMOUS_POLICY_DRIFT');
  return grant;
}

/** Trusted server compiler, not an Agent tool or HTTP admission endpoint.
 * Freezes a fresh root only; creates no Dispatch and cannot start a v4 worker in AC1. */
export function freezeAutonomousTask(runId:string,value:unknown,options:{delegationVersion?:1;deliveryVersion?:1}={}):{policy:AutonomousTaskPolicyV1;rootGrant:AutonomousTaskGrantV1} {
  return tx(()=>{
    const v=object(value,['coordinatorId','participantIds','inputs','outputAccess','budget']);
    const admission=digest(options.deliveryVersion?{draft:v,delegationVersion:1,deliveryVersion:1}:options.delegationVersion?{draft:v,delegationVersion:1}:v);
    const previous=loadAutonomousTaskPolicy(runId);
    if(previous){
      if(previous.admissionSha256!==admission)return fail('AUTONOMOUS_AUTHORITY_INVALID');
      loadRuntimeContract(runId);
      const root=get<{id:string}>('SELECT id FROM autonomous_task_grants WHERE run_id=? AND parent_grant_id IS NULL',runId);
      if(!root)return fail('AUTONOMOUS_CONTRACT_INVALID');
      return {policy:previous,rootGrant:loadAutonomousTaskGrant(root.id)};
    }
    const source=get<{conversation_id:string;agent_ids:string;goal:string;mode:string;status:string}>('SELECT conversation_id,agent_ids,goal,mode,status FROM runs WHERE id=?',runId);
    if(!source||source.mode!=='collaboration'||!['pending','running'].includes(source.status)||get('SELECT 1 FROM runtime_contracts WHERE run_id=?',runId)
      ||get('SELECT 1 FROM orchestration_requests WHERE run_id=?',runId)||get('SELECT 1 FROM collaboration_dispatches WHERE run_id=?',runId))return fail('AUTONOMOUS_CONTRACT_INVALID');
    const room=get<{agent_ids:string;archived_at:string|null;preferences:string|null}>('SELECT agent_ids,archived_at,preferences FROM conversations WHERE id=?',source.conversation_id);
    if(!room||room.archived_at)return fail('AUTONOMOUS_CONTRACT_INVALID');
    const participantIds=list(v.participantIds??JSON.parse(source.agent_ids)),coordinatorId=text(v.coordinatorId);
    if(!participantIds.length||participantIds.length>32||!participantIds.includes(coordinatorId))return fail('AUTONOMOUS_CONTRACT_INVALID');
    subset(participantIds,JSON.parse(source.agent_ids));subset(participantIds,JSON.parse(room.agent_ids));
    const root=get<{id:string}>("SELECT id FROM messages WHERE run_id=? AND kind='user' AND from_agent='user' ORDER BY seq LIMIT 1",runId);
    if(!root)return fail('AUTONOMOUS_CONTRACT_INVALID');
    const initial=inspectScopedSource(runId,'message',root.id),rootAccess=initial.access;
    if(participantIds.some(id=>!isMessageVisibleTo(rootAccess,id)))return fail('AUTONOMOUS_ACCESS_DENIED');
    const snapshots=listRunAgentSnapshots(runId),members=participantIds.map(agentId=>{
      const agent=snapshots.find(a=>a.id===agentId);
      if(!agent||agent.enabled===false||agent.execution?.kind==='external'&&!scopedNativeAgentSupported(agent))return fail('AUTONOMOUS_ACCESS_DENIED');
      return {agentId,roleVersion:agent.version??1,model:agent.model,driver:agent.execution?.kind==='external'?agent.execution.driver:'builtin-llm',
        allowedTools:agent.tools.filter(name=>SCOPED_FILE_TOOLS.includes(name)&&checkPermission(agent,name)==='allow'&&(agent.execution?.kind!=='external'||agent.execution.platformTools?.includes(name)))};
    });
    if(v.inputs!==undefined&&!Array.isArray(v.inputs))return fail('AUTONOMOUS_CONTRACT_INVALID');
    const inputs=[{source:initial.ref,readers:participantIds},...((v.inputs??[]) as unknown[]).map(i=>sourceInput(runId,i,participantIds))];
    if(new Set(inputs.map(i=>i.source.id)).size!==inputs.length)return fail('AUTONOMOUS_CONTRACT_INVALID');
    const outputAccess=access(v.outputAccess??{visibility:'private',audience:['user',coordinatorId]});
    if(!isMessageWithinScope(rootAccess,outputAccess))return fail('AUTONOMOUS_ACCESS_DENIED');
    subset(outputAccess.audience.filter(id=>id!=='user'),participantIds);
    const b=object(v.budget??{},['maxOutputTokens','maxTokensPerCall','maxConcurrency','maxDispatches','maxDepth','deadlineAt','firstResponseTimeoutMs','idleTimeoutMs']);
    const now=new Date().toISOString();
    const maximum={maxOutputTokens:config.collaboration.maxTokens,maxTokensPerCall:config.collaboration.scopedMaxTokensPerCall,maxConcurrency:config.collaboration.maxConcurrency,
      maxDispatches:config.collaboration.maxDispatches,maxDepth:config.collaboration.maxDepth,firstResponseTimeoutMs:DEFAULT_RESPONSE_TIMEOUT_MS,idleTimeoutMs:DEFAULT_RESPONSE_TIMEOUT_MS};
    const defaults={...maximum,maxOutputTokens:Math.min(DEFAULT_SCOPED_RUN_TOKENS,maximum.maxOutputTokens)};
    const numeric=Object.fromEntries(Object.entries(maximum).map(([key,limit])=>{const n=b[key]??defaults[key as keyof typeof defaults];if(!Number.isSafeInteger(n)||Number(n)<1||Number(n)>limit)return fail('AUTONOMOUS_LIMIT_EXCEEDED');return [key,Number(n)];})) as Omit<AutonomousTaskPolicyV1['budget'],'deadlineAt'>;
    numeric.maxTokensPerCall=Math.min(numeric.maxTokensPerCall,numeric.maxOutputTokens);
    const deadlineAt=b.deadlineAt??new Date(Date.parse(now)+config.collaboration.runTimeoutMs).toISOString();
    if(typeof deadlineAt!=='string'||!Number.isFinite(Date.parse(deadlineAt))||Date.parse(deadlineAt)<=Date.parse(now)||Date.parse(deadlineAt)>Date.parse(now)+config.collaboration.runTimeoutMs)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
    const preferences=room.preferences?JSON.parse(room.preferences):{};
    const costPolicy=normalizeCostPolicy(preferences.constraints?.costPolicy??{version:1,currency:'USD',mode:'estimate',maxCost:config.collaboration.maxCostUsd,unknownAction:'reserve',unknownReserve:0.01,prices:[]});
    if(costPolicy.mode!=='estimate')return fail('AUTONOMOUS_LIMIT_EXCEEDED');
    const policy:AutonomousTaskPolicyV1={version:1,id:randomUUID(),revision:1,admissionSha256:admission,runId,conversationId:source.conversation_id,coordinatorId,participantIds,rootSource:initial.ref,rootAccess,outputAccess,inputs,members,
      budget:{...numeric,deadlineAt:new Date(deadlineAt).toISOString()},costPolicy,disclosure:'within_source_access',createdAt:now};
    run('INSERT INTO autonomous_task_policies VALUES(?,?,?,?,?)',runId,policy.id,JSON.stringify(policy),digest(policy),now);
    const planned=planCollaborationAdmission({runId,objective:source.goal,participantIds,targetAgentIds:[coordinatorId],completionEngine:true,messageVisibilityVersion:1,completionCandidateVersion:1,successorObligationVersion:1,evidenceBundleVersion:1,contextContributorVersion:1,durableHoldVersion:2,
      exitGuard:{version:1,maxCorrections:0,correctionMaxTokens:512},executionPolicy:executionPolicyForProfile('execute',{toolApiVersion:4,implicitAnswerPolicy:'explicit_only'})});
    planned.contract.features!.controlActionVersion=4;
    planned.contract.features!.autonomousCollaboration={version:1,capabilityPackage:'autonomous-collaboration-v1',boundaryVersion:2,policyId:policy.id,policyRevision:1,policySha256:digest(policy),rootRunId:runId,budgetRunId:runId};
    if(options.delegationVersion)planned.contract.features!.autonomousCollaboration.delegationVersion=1;
    if(options.deliveryVersion)planned.contract.features!.autonomousCollaboration.deliveryVersion=1;
    freezeRuntimeContract(planned.contract);resolveRunPolicy(runId);
    const subjectId=randomUUID();
    run("INSERT INTO runtime_subjects VALUES(?,?,?,?,?,'active',?,?,?)",subjectId,runId,'root:'+coordinatorId,'root',null,source.goal,now,now);
    run("INSERT INTO runtime_custody VALUES(?,'unassigned',NULL,NULL,0,0,?)",subjectId,now);
    const rootGrant:AutonomousTaskGrantV1={version:1,id:randomUUID(),runId,policyId:policy.id,parentGrantId:null,subjectId,agentId:coordinatorId,participantIds,inputs,
      allowedTools:members.find(m=>m.agentId===coordinatorId)!.allowedTools,delegableTools:[...new Set(members.flatMap(m=>m.allowedTools))].sort(),actions:[...ACTIONS],outputAccess:rootAccess,depth:0,expiresAt:policy.budget.deadlineAt,createdAt:now};
    persistGrant(rootGrant,'autonomous:root:'+runId,policy);
    return {policy,rootGrant};
  });
}

export function assertAutonomousGrantReady(id:string,options:{allowWaitingForUser?:boolean}={}):{policy:AutonomousTaskPolicyV1;grant:AutonomousTaskGrantV1} {
  const grant=loadAutonomousTaskGrant(id),policy=loadAutonomousTaskPolicy(grant.runId);
  const contract=loadRuntimeContract(grant.runId);
  if(!policy||policy.id!==grant.policyId||contract?.features?.autonomousCollaboration?.policyId!==policy.id)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  if(contract.features.autonomousCollaboration.delegationVersion===1&&config.autonomousCollaborationMode!=='execute')return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
  const state=get<{status:string}>('SELECT status FROM runs WHERE id=?',grant.runId)?.status;
  if(state!=='running'&&!(options.allowWaitingForUser&&state==='waiting_for_user'))return fail('AUTONOMOUS_AUTHORITY_INVALID');
  if(Date.now()>=Date.parse(grant.expiresAt)||Date.now()>=Date.parse(policy.budget.deadlineAt))return fail('AUTONOMOUS_TASK_EXPIRED');
  if(get('SELECT 1 FROM autonomous_task_revocations WHERE run_id=? AND grant_id IS NULL',grant.runId))return fail('AUTONOMOUS_GRANT_REVOKED');
  let current:AutonomousTaskGrantV1|null=grant;
  for(let depth=0;current;depth++){
    if(depth>policy.budget.maxDepth||current.runId!==grant.runId||current.policyId!==policy.id)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    if(get('SELECT 1 FROM autonomous_task_revocations WHERE run_id=? AND grant_id=?',grant.runId,current.id))return fail('AUTONOMOUS_GRANT_REVOKED');
    current=current.parentGrantId?loadAutonomousTaskGrant(current.parentGrantId):null;
  }
  checkInput(grant.runId,{source:policy.rootSource,readers:policy.participantIds},grant.agentId);
  for(const input of grant.inputs)if(input.readers.includes(grant.agentId))checkInput(grant.runId,input,grant.agentId,grant.parentGrantId?grant.outputAccess:undefined);
  return {grant,policy};
}

/** Binding is persisted once and is checked again against live custody/lease on every use. */
export function bindAutonomousAttempt(grantId:string,attemptId:string):AutonomousGrantBinding {
  return tx(()=>{
    const {grant}=assertAutonomousGrantReady(grantId),authority=captureExecutionBinding(grant.runId,grant.agentId,attemptId);assertBindingAuthorized(authority);
    if(authority.origin!=='collaboration_attempt'||authority.subjectId!==grant.subjectId)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    const previous=get<{grant_id:string;generation:number}>('SELECT grant_id,generation FROM autonomous_attempt_grants WHERE attempt_id=?',attemptId);
    if(previous&&(previous.grant_id!==grant.id||previous.generation!==authority.generation))return fail('AUTONOMOUS_AUTHORITY_INVALID');
    if(!previous)run('INSERT INTO autonomous_attempt_grants VALUES(?,?,?,?,?)',attemptId,grant.id,grant.runId,authority.generation,new Date().toISOString());
    return {runId:grant.runId,grantId:grant.id,attemptId};
  });
}
export function assertAutonomousGrant(binding:AutonomousGrantBinding,action?:AutonomousActionName):{grant:AutonomousTaskGrantV1;policy:AutonomousTaskPolicyV1} {
  const value=assertAutonomousGrantReady(binding.grantId),{grant}=value;
  if(binding.runId!==grant.runId||action&&!grant.actions.includes(action))return fail('AUTONOMOUS_AUTHORITY_INVALID');
  const row=get<{grant_id:string;generation:number}>('SELECT grant_id,generation FROM autonomous_attempt_grants WHERE attempt_id=? AND run_id=?',binding.attemptId,binding.runId);
  const authority=captureExecutionBinding(binding.runId,grant.agentId,binding.attemptId);assertBindingAuthorized(authority);
  if(!row||row.grant_id!==grant.id||authority.origin!=='collaboration_attempt'||authority.subjectId!==grant.subjectId||authority.generation!==row.generation)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  return value;
}

/** The scheduler supplies childSubjectId. A model cannot create its own authority row. */
export function deriveAutonomousGrant(binding:AutonomousGrantBinding,childSubjectId:string,value:unknown,options:{aggregateInputs?:AutonomousInputV1[]}={}):AutonomousTaskGrantV1 {
  return tx(()=>{
    const aggregate=options.aggregateInputs!==undefined;
    const {grant:parent,policy}=assertAutonomousGrant(binding,aggregate?'aggregate':'delegate');
    if(aggregate&&loadRuntimeContract(binding.runId)?.features?.autonomousCollaboration?.deliveryVersion!==1)return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
    const v=object(value,['agentId','participantIds','inputIds','allowedTools','delegableTools','actions','outputAccess','expiresAt','commandKey']);
    const agentId=text(v.agentId),participantIds=list(v.participantIds??[agentId]);subset(participantIds,parent.participantIds);
    if(agentId===parent.agentId&&!aggregate)return fail('AUTONOMOUS_ACCESS_DENIED');
    if(!participantIds.includes(agentId)||parent.depth>=policy.budget.maxDepth)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
    const subject=get<{parent_subject_id:string;status:string}>('SELECT parent_subject_id,status FROM runtime_subjects WHERE id=? AND run_id=?',childSubjectId,binding.runId);
    if(!subject||subject.status!=='active'||subject.parent_subject_id!==parent.subjectId)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    for(const input of options.aggregateInputs??[])if(!validateAutonomousDerivedSource(binding.runId,input.source))return fail('AUTONOMOUS_AUTHORITY_INVALID');
    const requested=list(v.inputIds??[]),inputs=requested.map(id=>{const i=parent.inputs.find(i=>i.source.id===id)??options.aggregateInputs?.find(i=>i.source.id===id);if(!i||!i.readers.includes(agentId))return fail('AUTONOMOUS_ACCESS_DENIED');return {...i,readers:i.readers.filter(id=>participantIds.includes(id))};});
    const outputAccess=access(v.outputAccess??{visibility:'private',audience:['user',agentId]});
    if(!isMessageVisibleTo(outputAccess,agentId))return fail('AUTONOMOUS_ACCESS_DENIED');
    subset(outputAccess.audience.filter(id=>id!=='user'),parent.participantIds);
    if(!isMessageWithinScope(policy.rootAccess,outputAccess)||!isMessageWithinScope(parent.outputAccess,outputAccess))return fail('AUTONOMOUS_ACCESS_DENIED');
    for(const input of inputs){checkInput(binding.runId,input,agentId,outputAccess);const original=parent.inputs.find(i=>i.source.id===input.source.id)??options.aggregateInputs?.find(i=>i.source.id===input.source.id);if(loadRuntimeContract(binding.runId)?.features?.autonomousCollaboration?.deliveryVersion===1&&!isMessageWithinScope({visibility:'private',audience:['user',...(original?.readers??[])]},outputAccess))return fail('AUTONOMOUS_ACCESS_DENIED');}
    const allowedTools=list(v.allowedTools??[]);subset(allowedTools,parent.delegableTools);subset(allowedTools,policy.members.find(m=>m.agentId===agentId)!.allowedTools);
    const delegableTools=list(v.delegableTools??[]);subset(delegableTools,parent.delegableTools);subset(delegableTools,policy.members.filter(m=>participantIds.includes(m.agentId)).flatMap(m=>m.allowedTools));
    const actions=list(v.actions??['complete','request_user']);subset(actions,parent.actions);subset(actions,ACTIONS);
    const expiresAt=v.expiresAt??parent.expiresAt;
    if(typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)>Date.parse(parent.expiresAt)||Date.parse(expiresAt)<=Date.now())return fail('AUTONOMOUS_LIMIT_EXCEEDED');
    const key=text(v.commandKey),intent={parentGrantId:parent.id,childSubjectId,agentId,participantIds,inputs,allowedTools,delegableTools,actions,outputAccess,expiresAt:new Date(expiresAt).toISOString()};
    const previous=get<{id:string;intent_sha256:string}>('SELECT id,intent_sha256 FROM autonomous_task_grants WHERE command_key=?',key);
    if(previous){if(previous.intent_sha256!==digest(intent))return fail('AUTONOMOUS_AUTHORITY_INVALID');return assertAutonomousGrantReady(previous.id).grant;}
    if((get<{n:number}>('SELECT COUNT(*) n FROM autonomous_task_grants WHERE run_id=?',binding.runId)?.n??0)>=policy.budget.maxDispatches)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
    const grant:AutonomousTaskGrantV1={version:1,id:randomUUID(),runId:binding.runId,policyId:policy.id,parentGrantId:parent.id,subjectId:childSubjectId,agentId,participantIds,inputs,allowedTools,
      delegableTools,actions:actions as AutonomousActionName[],outputAccess,depth:parent.depth+1,expiresAt:new Date(expiresAt).toISOString(),createdAt:new Date().toISOString()};
    persistGrant(grant,key,intent);return grant;
  });
}

/** Server/Owner operation only. It is deliberately absent from the Agent action set. */
export function revokeAutonomousAuthority(runId:string,grantId:string|null,reason:string):void {
  tx(()=>{if(!loadAutonomousTaskPolicy(runId)||!reason.trim()||reason.length>500||grantId&&loadAutonomousTaskGrant(grantId).runId!==runId)return fail('AUTONOMOUS_AUTHORITY_INVALID');
    if(!get('SELECT 1 FROM autonomous_task_revocations WHERE run_id=? AND grant_id IS ?',runId,grantId))run('INSERT INTO autonomous_task_revocations VALUES(?,?,?,?,?)',randomUUID(),runId,grantId,reason,new Date().toISOString());});
}

export function autonomousCollaborationSupport(){
  return {contractVersion:1,toolApiVersion:4,admissionMode:config.autonomousCollaborationMode,foundationImplemented:true,delegationVersion:1,
    deliveryVersion:1,executionAvailable:config.autonomousCollaborationMode==='execute',supportedDrivers:['builtin-llm'],defaultEntryAvailable:false,
    reason:'API delegation and automatic result delivery require explicit versioned roots and execute mode; default chat entry remains AC4'} as const;
}
