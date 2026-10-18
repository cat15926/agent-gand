import {autonomousExecutionAvailable,autonomousDriverAllowed} from '../runtime/autonomousCapabilities.ts';
import {randomUUID} from 'node:crypto';
import {isMessageVisibleTo,type AutonomousInputV1,type AutonomousDelegateIntentV1,type AutonomousGrantBinding,type MessageAccess,type ScopedSourceRef,type CostPolicy} from '@agent-gand/shared';
import {all,get,run,tx} from '../db/database.ts';
import {config} from '../config.ts';
import {post} from '../messaging/inbox.ts';
import {setRunStatus} from '../runs/trace.ts';
import {assertAutonomousGrant,assertAutonomousGrantReady,deriveAutonomousGrant,freezeAutonomousTask,loadAutonomousTaskGrant} from '../runtime/autonomousTasks.ts';
import {loadAutonomousTaskPolicy,autonomousDigest as digest,autonomousFail as fail} from '../runtime/autonomousPolicy.ts';
import {assertExecutableCollaborationPolicy,loadRuntimeContract} from '../runtime/runPolicy.ts';
import {assertScopedOutput,inspectScopedSource,inputLedgerRevision,type ScopedAttemptBinding} from '../runtime/scopedCollaboration.ts';
import {commitConsultAllActionCommand,commitWakeActionCommand} from '../runtime/actionCommands.ts';
import {observeAutonomousWaiting,observeAutonomousDependencyFailure,observeWakeLink} from '../runtime/shadow.ts';
import {openSuccessorObligation} from '../runtime/obligations.ts';
import {createDispatch,finishAttempt,listDispatches} from './store.ts';

export interface AutonomousWork {
  id:string;run_id:string;grant_id:string;parent_work_id:string|null;work_key:string;objective_message_id:string;source_attempt_id:string|null;
}
export const autonomousWork=(id:string)=>get<AutonomousWork>('SELECT * FROM autonomous_work_items WHERE id=?',id);
export const workForDispatch=(id:string)=>get<AutonomousWork>('SELECT w.* FROM autonomous_work_items w JOIN autonomous_dispatch_work d ON d.work_id=w.id WHERE d.dispatch_id=?',id);
export function childWorks(workId:string):AutonomousWork[]{return all<AutonomousWork>('SELECT * FROM autonomous_work_items WHERE parent_work_id=? ORDER BY created_at,rowid',workId);}
export function workState(work:AutonomousWork):string{return get<{status:string}>('SELECT status FROM runtime_subjects WHERE id=?',loadAutonomousTaskGrant(work.grant_id).subjectId)?.status??'failed';}
export function assertAutonomousDispatchLimit(runId:string):void {
  const p=loadAutonomousTaskPolicy(runId);
  if(!p||listDispatches(runId).length>=p.budget.maxDispatches)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
}
export function assertPlanCapacity(runId:string,newItems:number):void {
  const policy=loadAutonomousTaskPolicy(runId)!;
  const pending=get<{n:number}>(`SELECT COUNT(*) n FROM autonomous_work_items w JOIN autonomous_task_grants g ON g.id=w.grant_id
    JOIN runtime_subjects s ON s.id=g.subject_id WHERE w.run_id=? AND s.status='active'
      AND NOT EXISTS(SELECT 1 FROM autonomous_dispatch_work d WHERE d.work_id=w.id)`,runId)!.n;
  const wakes=get<{n:number}>(`SELECT COUNT(*) n FROM autonomous_delegation_rounds r JOIN autonomous_work_items w ON w.id=r.parent_work_id
    JOIN autonomous_task_grants g ON g.id=w.grant_id JOIN runtime_custody c ON c.subject_id=g.subject_id
    WHERE r.run_id=? AND c.state='waiting' AND c.generation=r.generation
      AND NOT EXISTS(SELECT 1 FROM runtime_action_commands command WHERE command.command_key='autonomous:wake:' || r.id)`,runId)!.n;
  const decisions=get<{n:number}>(`SELECT COUNT(*) n FROM autonomous_decision_proposals p JOIN autonomous_work_items w ON w.id=p.work_id
    JOIN autonomous_task_grants g ON g.id=w.grant_id JOIN runtime_custody c ON c.subject_id=g.subject_id
    WHERE p.run_id=? AND c.state='waiting' AND c.generation=p.generation
      AND NOT EXISTS(SELECT 1 FROM runtime_action_commands command WHERE command.command_key='delivery:decision-wake:' || p.id)`,runId)!.n;
  const pauses=get<{n:number}>(`SELECT COUNT(*) n FROM autonomous_pause_points p JOIN autonomous_work_items w ON w.id=p.work_id JOIN autonomous_task_grants g ON g.id=w.grant_id JOIN runtime_custody c ON c.subject_id=g.subject_id WHERE p.run_id=? AND c.state='waiting' AND c.generation=p.generation AND NOT EXISTS(SELECT 1 FROM runtime_action_commands a WHERE a.command_key='autonomous:pause-wake:' || p.id)`,runId)!.n;
  // Reserve the future parent wake and every dependency-blocked child before admitting a plan.
  if(listDispatches(runId).length+pending+wakes+decisions+pauses+newItems+1>policy.budget.maxDispatches)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
}
function dispatchWork(work:AutonomousWork,parentDispatchId?:string){
  const {grant,policy}=assertAutonomousGrantReady(work.grant_id);assertAutonomousDispatchLimit(work.run_id);
  const dispatch=createDispatch({runId:work.run_id,conversationId:policy.conversationId,sourceMessageId:work.objective_message_id,
    parentDispatchId,kind:work.parent_work_id?'fanout':'initial',from:work.parent_work_id?'system':'user',targetAgentId:grant.agentId,
    depth:grant.depth,idempotencyKey:`autonomous:start:${work.id}`});
  run('INSERT INTO runtime_dispatch_subjects VALUES(?,?,NULL)',dispatch.id,grant.subjectId);
  run('INSERT INTO autonomous_dispatch_work VALUES(?,?,?)',dispatch.id,work.id,new Date().toISOString());
  return dispatch;
}

/** Explicit trusted admission only. Ordinary chat does not call this until AC4. */
export function admitAutonomousGraph(runId:string,draft:unknown,options:{deliveryVersion?:1;entryVersion?:1;flowVersion?:1;nativeVersion?:1;rolloutVersion?:1;costVersion?:1;executionDrivers?:string[];readonly?:boolean;costPolicy?:CostPolicy}={}){
  if(config.autonomousCollaborationMode!=='execute')return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
  return tx(()=>{
    const frozen=freezeAutonomousTask(runId,draft,{delegationVersion:1,...options});
    if(!autonomousDriverAllowed(frozen.policy,frozen.policy.members.find(m=>m.agentId===frozen.policy.coordinatorId)!.driver))return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
    const existing=get<AutonomousWork>('SELECT * FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NULL',runId);
    if(existing)return existing;
    setRunStatus(runId,'running');
    const work:AutonomousWork={id:randomUUID(),run_id:runId,grant_id:frozen.rootGrant.id,parent_work_id:null,work_key:'root',objective_message_id:frozen.policy.rootSource.id,source_attempt_id:null};
    run('INSERT INTO autonomous_work_items VALUES(?,?,?,?,?,?,?,?)',work.id,runId,work.grant_id,null,work.work_key,work.objective_message_id,null,new Date().toISOString());
    dispatchWork(work);return work;
  });
}

/** Model intent -> immutable DAG, Grants, obligations, wait and command receipt in one transaction. */
export function commitAutonomousDelegation(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,intent:AutonomousDelegateIntentV1,options:{aggregateInputs?:AutonomousInputV1[];sources?:Array<{workId:string;refs:ScopedSourceRef[]}>;flowJobs?:boolean}={}){
  const aggregate=options.aggregateInputs!==undefined;
  const {grant:parent,policy}=assertAutonomousGrant(binding,aggregate?'aggregate':'delegate');
  const dispatch=get<{dispatch_id:string}>('SELECT dispatch_id FROM collaboration_attempts WHERE id=?',binding.attemptId)!;
  const work=workForDispatch(dispatch.dispatch_id);if(!work||work.grant_id!==parent.id)return fail('AUTONOMOUS_AUTHORITY_INVALID');
  const revision=inputLedgerRevision(binding.attemptId),commandKey=`autonomous:${aggregate?'aggregate':'delegate'}:${parent.id}:${intent.commandKey}`;
  // The frozen boundary covers actual exposure, including tool results, for every outgoing objective.
  return commitConsultAllActionCommand({runId:binding.runId,commandKey,attemptId:binding.attemptId,dispatchId:dispatch.dispatch_id,
    scope:{...scope,ledgerRevision:revision,outputAccess:getScopeAccess(scope.scopeId)},intentFingerprint:digest(intent),execute:()=>{
      assertAutonomousGrant(binding,aggregate?'aggregate':'delegate');assertExecutableCollaborationPolicy(binding.runId);
      assertPlanCapacity(binding.runId,intent.items.length);
      const siblings=childWorks(work.id),byKey=new Map(siblings.map(w=>[w.work_key,w.id]));
      for(const item of intent.items){if(byKey.has(item.key))return fail('AUTONOMOUS_GRAPH_INVALID');byKey.set(item.key,randomUUID());}
      const proposed=new Map(intent.items.map(i=>[i.key,i]));
      const visiting=new Set<string>(),visited=new Set<string>();
      const visit=(key:string):void=>{
        if(visiting.has(key)||!byKey.has(key))return fail('AUTONOMOUS_GRAPH_INVALID');if(visited.has(key))return;
        visiting.add(key);for(const dep of proposed.get(key)?.dependsOn??[])visit(dep);visiting.delete(key);visited.add(key);
      };
      for(const item of intent.items)visit(item.key);
      const roundId=randomUUID(),children:AutonomousWork[]=[];
      const ancestors=new Set<string>();let ancestor:AutonomousWork|undefined=work;
      while(ancestor){ancestors.add(loadAutonomousTaskGrant(ancestor.grant_id).agentId);ancestor=ancestor.parent_work_id?autonomousWork(ancestor.parent_work_id):undefined;}
      for(const item of intent.items){
        if(ancestors.has(item.agentId)&&!(aggregate&&item.agentId===parent.agentId))return fail('AUTONOMOUS_ACCESS_DENIED');
        const member=loadAutonomousTaskPolicy(binding.runId)!.members.find(m=>m.agentId===item.agentId);
        if(!member||!autonomousDriverAllowed(policy,member.driver))return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
        const delivery=loadRuntimeContract(binding.runId)?.features?.autonomousCollaboration?.deliveryVersion===1;
        const selected=item.inputIds.map(id=>parent.inputs.find(i=>i.source.id===id)??options.aggregateInputs?.find(i=>i.source.id===id));
        const defaultAudience=delivery?policy.participantIds.filter(id=>parent.participantIds.includes(id)&&isMessageVisibleTo(getScopeAccess(scope.scopeId),id)
          &&selected.every(i=>i&&i.readers.includes(id)&&isMessageVisibleTo(inspectScopedSource(binding.runId,i.source.kind,i.source.id).access,id))):['user',item.agentId];
        const outputAccess:MessageAccess={visibility:'private',audience:[...new Set(['user',...(item.outputAudience??defaultAudience)])].sort()};
        assertScopedOutput({...scope,ledgerRevision:revision,outputAccess});
        const subjectId=randomUUID(),now=new Date().toISOString();
        run("INSERT INTO runtime_subjects VALUES(?,?,?,?,?,'active',?,?,?)",subjectId,binding.runId,'autonomous:'+byKey.get(item.key),'consultation',parent.subjectId,item.objective,now,now);
        run("INSERT INTO runtime_custody VALUES(?,'unassigned',NULL,NULL,0,0,?)",subjectId,now);
        const child=deriveAutonomousGrant(binding,subjectId,{agentId:item.agentId,participantIds:item.participantIds,inputIds:item.inputIds,
          allowedTools:item.allowedTools,delegableTools:item.delegableTools,actions:options.flowJobs?['flow_action','complete']:parent.actions,outputAccess,commandKey:`autonomous:grant:${digest([commandKey,item.key])}`},options);
        const objective=post({runId:binding.runId,from:parent.agentId,to:item.agentId,kind:'system',messageType:'collaboration_routing',body:item.objective,
          ...outputAccess,meta:{autonomousInternal:true},clientMessageId:`autonomous:objective:${child.id}`});
        const next:AutonomousWork={id:byKey.get(item.key)!,run_id:binding.runId,grant_id:child.id,parent_work_id:work.id,work_key:item.key,objective_message_id:objective.id,source_attempt_id:binding.attemptId};
        run('INSERT INTO autonomous_work_items VALUES(?,?,?,?,?,?,?,?)',next.id,next.run_id,next.grant_id,next.parent_work_id,next.work_key,next.objective_message_id,next.source_attempt_id,now);
        for(const source of options.sources??[]){const record={refs:source.refs};run('INSERT INTO autonomous_aggregate_sources VALUES(?,?,?,?,?)',next.id,source.workId,JSON.stringify(record),digest(record),now);}
        openSuccessorObligation({runId:binding.runId,parentSubjectId:parent.subjectId,targetSubjectId:child.subjectId,kind:'consult_result',sourceActionId:commandKey,stableKey:`autonomous:result:${next.id}`,payload:{workId:next.id}});
        children.push(next);
      }
      for(const item of intent.items)for(const key of item.dependsOn)run('INSERT INTO autonomous_work_dependencies VALUES(?,?)',byKey.get(item.key),byKey.get(key));
      const generation=observeAutonomousWaiting(dispatch.dispatch_id,binding.attemptId,parent.agentId,roundId);
      run('INSERT INTO autonomous_delegation_rounds VALUES(?,?,?,?,?,?,?,?,?)',roundId,binding.runId,work.id,dispatch.dispatch_id,binding.attemptId,commandKey,JSON.stringify(children.map(w=>w.id)),generation,new Date().toISOString());
      finishAttempt({attemptId:binding.attemptId,dispatchId:dispatch.dispatch_id,status:'completed',output:'已提交独立工作，等待已登记的子义务。'});
      // Queue only dependency-ready work. A blocked member never occupies a member ticket.
      reconcileAutonomousGraph(binding.runId);
      return {roundId,workIds:children.map(w=>w.id),budgetRunId:binding.runId};
    }});
}
export function getScopeAccess(scopeId:string):MessageAccess {
  const scope=get<{record:string}>('SELECT record FROM runtime_execution_scopes WHERE id=?',scopeId);
  if(!scope)return fail('AUTONOMOUS_AUTHORITY_INVALID');return JSON.parse(scope.record).defaultOutputAccess;
}

/** Repeated startup/event reconciliation creates one ready Dispatch and one parent wake only. */
export function reconcileAutonomousGraph(runId:string):void {
  if(!autonomousExecutionAvailable(runId)||loadRuntimeContract(runId)?.features?.autonomousCollaboration?.delegationVersion!==1)return;
  if(get<{status:string}>('SELECT status FROM runs WHERE id=?',runId)?.status!=='running')return;
  if(get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND (pause_requested=1 OR recovery_attention=1)',runId))return;
  tx(()=>{
    const works=all<AutonomousWork>('SELECT * FROM autonomous_work_items WHERE run_id=? ORDER BY created_at,rowid',runId);
    for(const work of works){
      const grant=loadAutonomousTaskGrant(work.grant_id),custody=get<{state:string}>('SELECT state FROM runtime_custody WHERE subject_id=?',grant.subjectId);
      if(custody?.state==='unassigned'&&get(`SELECT 1 FROM autonomous_dispatch_work w JOIN collaboration_dispatches d ON d.id=w.dispatch_id
        WHERE w.work_id=? AND d.status IN ('failed','blocked','cancelled')`,work.id)){
        observeAutonomousDependencyFailure(grant.subjectId,`autonomous:unclaimed:${work.id}`);
        if(!work.parent_work_id)return;
      }
    }
    // A DAG may contain several dependency layers. Drain only persisted state, with no model polling.
    for(let n=0;n<works.length;n++){
      let changed=false;
      for(const work of works){
        if(!work.parent_work_id||get('SELECT 1 FROM autonomous_dispatch_work WHERE work_id=?',work.id)||workState(work)!=='active')continue;
        const deps=all<{dependency_id:string}>('SELECT dependency_id FROM autonomous_work_dependencies WHERE work_id=?',work.id).map(d=>autonomousWork(d.dependency_id)!);
        if(deps.some(d=>['failed','cancelled'].includes(workState(d)))){observeAutonomousDependencyFailure(loadAutonomousTaskGrant(work.grant_id).subjectId,`autonomous:dependency:${work.id}`);changed=true;continue;}
        if(deps.some(d=>workState(d)!=='completed'))continue;
        const parent=autonomousWork(work.parent_work_id)!;
        const prior=get<{dispatch_id:string}>('SELECT dispatch_id FROM collaboration_attempts WHERE id=?',work.source_attempt_id);
        try{assertAutonomousGrantReady(parent.grant_id);dispatchWork(work,prior?.dispatch_id);}catch{
          observeAutonomousDependencyFailure(loadAutonomousTaskGrant(work.grant_id).subjectId,`autonomous:admission:${work.id}`);
        }
        changed=true;
      }
      if(!changed)break;
    }
    for(const round of all<{id:string;parent_work_id:string;work_ids:string;source_dispatch_id:string;generation:number}>('SELECT * FROM autonomous_delegation_rounds WHERE run_id=? ORDER BY created_at,rowid',runId)){
      if(get('SELECT 1 FROM runtime_action_commands WHERE command_key=?',`autonomous:wake:${round.id}`))continue;
      const parent=autonomousWork(round.parent_work_id)!,grant=loadAutonomousTaskGrant(parent.grant_id);
      const custody=get<{state:string;generation:number}>('SELECT state,generation FROM runtime_custody WHERE subject_id=?',grant.subjectId);
      if(custody?.state!=='waiting'||custody.generation!==round.generation)continue;
      const children=(JSON.parse(round.work_ids) as string[]).map(id=>autonomousWork(id)!);
      if(children.some(w=>!['completed','failed','cancelled'].includes(workState(w))))continue;
      assertAutonomousGrantReady(parent.grant_id);assertAutonomousDispatchLimit(runId);
      commitWakeActionCommand({runId,commandKey:`autonomous:wake:${round.id}`,autonomousWake:{roundId:round.id,generation:round.generation},execute:()=>{
        // Keys predate each child's private execution. Never include output, model text or errors.
        const receipts=children.map(w=>({key:w.work_key,state:workState(w)}));
        const previousScope=get<{scope_id:string}>('SELECT scope_id FROM runtime_scope_attempts WHERE attempt_id=(SELECT source_attempt_id FROM autonomous_delegation_rounds WHERE id=?)',round.id);
        if(!previousScope)return fail('AUTONOMOUS_AUTHORITY_INVALID');
        const source=post({runId,from:'system',to:grant.agentId,kind:'system',body:JSON.stringify({version:1,profile:'autonomous-status-only-v1',receipts}),
          ...getScopeAccess(previousScope.scope_id),meta:{autonomousInternal:true},clientMessageId:`autonomous:return:${round.id}`});
        const policy=loadAutonomousTaskPolicy(runId)!;
        const resume=createDispatch({runId,conversationId:policy.conversationId,sourceMessageId:parent.objective_message_id,parentDispatchId:round.source_dispatch_id,kind:'resume',from:'system',targetAgentId:grant.agentId,depth:grant.depth,idempotencyKey:`autonomous:resume:${round.id}`});
        observeWakeLink(round.source_dispatch_id,resume.id,round.id,round.generation);
        run('INSERT INTO autonomous_dispatch_work VALUES(?,?,?)',resume.id,parent.id,new Date().toISOString());
        return {dispatchId:resume.id,sourceMessageId:source.id,receipts};
      }});
    }
  });
}

/** Preserve all actual prior exposure across a cold continuation of the same responsibility. */
export function previousWorkInputs(workId:string):ScopedSourceRef[]{
  return all<{record:string}>(`SELECT p.record FROM runtime_input_provenance p JOIN collaboration_attempts a ON a.id=p.attempt_id
    JOIN autonomous_dispatch_work w ON w.dispatch_id=a.dispatch_id WHERE w.work_id=? ORDER BY a.created_at,p.sequence`,workId)
    .map(row=>JSON.parse(row.record).source as ScopedSourceRef);
}
