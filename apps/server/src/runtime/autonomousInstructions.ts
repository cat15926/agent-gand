import {randomUUID} from 'node:crypto';
import type {ScopedSourceRef} from '@agent-gand/shared';
import {all,get,run,tx} from '../db/database.ts';
import {getRun} from '../runs/trace.ts';
import {post} from '../messaging/inbox.ts';
import {messageAccess} from '../messaging/access.ts';
import {loadRuntimeContract} from './runPolicy.ts';
import {autonomousDigest as digest,autonomousFail as fail,autonomousObject as object,loadAutonomousTaskPolicy} from './autonomousPolicy.ts';
import {compileScopedSource,inputLedgerRevision,type ScopedAttemptBinding} from './scopedCollaboration.ts';
import {assertAutonomousGrant,assertAutonomousGrantReady,loadAutonomousTaskGrant} from './autonomousTasks.ts';
import {workForDispatch,autonomousWork,getScopeAccess,assertPlanCapacity,assertAutonomousDispatchLimit} from '../collaboration/autonomousGraph.ts';
import {commitHoldActionCommand,commitWakeActionCommand} from './actionCommands.ts';
import {observeAutonomousWaiting,observeWakeLink} from './shadow.ts';
import {createDispatch,finishAttempt} from '../collaboration/store.ts';
import type {AutonomousGrantBinding} from '@agent-gand/shared';

export const autonomousEntryEnabled=(runId:string)=>loadRuntimeContract(runId)?.features?.autonomousCollaboration?.entryVersion===1;
export const instructionRevision=(runId:string)=>get<{n:number}>('SELECT COALESCE(MAX(revision),0) n FROM autonomous_user_instructions WHERE run_id=?',runId)?.n??0;
export function validateAutonomousEntrySources(runId:string):void{
 const row=get<{record:string}>('SELECT record FROM autonomous_submissions WHERE run_id=?',runId);if(!row)return;
 const reply=JSON.parse(row.record).reply;if(!reply)return;
 const m=get<{body:string;seq:number}>('SELECT body,seq FROM messages WHERE id=? AND run_id=?',reply.id,reply.runId);
 if(!m||digest({body:m.body,seq:m.seq,access:messageAccess(reply.id)})!==reply.sha256)fail('AUTONOMOUS_POLICY_DRIFT');
}
export function autonomousInstructionRefs(runId:string):ScopedSourceRef[]{
 return all<{record:string;sha256:string}>('SELECT record,sha256 FROM autonomous_user_instructions WHERE run_id=? ORDER BY revision',runId).map(row=>{const r=JSON.parse(row.record);if(digest(r)!==row.sha256)return fail('AUTONOMOUS_POLICY_DRIFT');const ref=compileScopedSource(runId,'message',r.source.id);if(digest(ref)!==digest(r.source))return fail('AUTONOMOUS_POLICY_DRIFT');return ref;});
}
export function appendAutonomousInstruction(runId:string,value:unknown){return tx(()=>{
 if(!autonomousEntryEnabled(runId))return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
 const v=object(value,['text','clientRequestId','expectedRevision']);if(typeof v.text!=='string'||!v.text.trim()||v.text.length>16000||typeof v.clientRequestId!=='string'||v.clientRequestId.length<8||v.clientRequestId.length>100||!Number.isSafeInteger(v.expectedRevision))return fail('AUTONOMOUS_CONTRACT_INVALID');
 const previous=get<{revision:number;record:string}>('SELECT * FROM autonomous_user_instructions WHERE run_id=? AND client_key=?',runId,v.clientRequestId);
 if(previous){if(JSON.parse(previous.record).inputDigest!==digest(v))return fail('AUTONOMOUS_AUTHORITY_INVALID');return {runId,revision:previous.revision,deduplicated:true};}
 const root=get<{grant_id:string}>('SELECT grant_id FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NULL',runId)!;assertAutonomousGrantReady(root.grant_id,{allowWaitingForUser:true});
 if(v.expectedRevision!==instructionRevision(runId))return fail('AUTONOMOUS_POLICY_DRIFT');
 if(get("SELECT 1 FROM collaboration_user_decisions WHERE run_id=? AND status='pending'",runId))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
 if(get("SELECT 1 FROM runtime_subjects WHERE id=? AND status='completed'",loadAutonomousTaskGrant(root.grant_id).subjectId))return fail('AUTONOMOUS_AUTHORITY_INVALID');
 const revision=instructionRevision(runId)+1;if(revision>20)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
 const p=loadAutonomousTaskPolicy(runId)!,message=post({runId,from:'user',to:p.coordinatorId,kind:'user',body:v.text.trim(),...p.rootAccess,clientMessageId:`autonomous:instruction:${runId}:${v.clientRequestId}`,meta:{autonomousInstructionRevision:revision}});
 const record={version:1,source:compileScopedSource(runId,'message',message.id),inputDigest:digest(v)};
 run('INSERT INTO autonomous_user_instructions VALUES(?,?,?,?,?,?,?,?)',randomUUID(),runId,revision,v.clientRequestId,message.id,JSON.stringify(record),digest(record),new Date().toISOString());
 return {runId,revision,deduplicated:false};
});}
/** Suspend between effects; prior exposure/receipts survive in the same work, no call is replayed. */
export function pauseAutonomousAttempt(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding):boolean{
 if(!autonomousEntryEnabled(binding.runId)||!get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND pause_requested=1',binding.runId))return false;
 const {grant}=assertAutonomousGrant(binding),attempt=get<{dispatch_id:string}>('SELECT dispatch_id FROM collaboration_attempts WHERE id=?',binding.attemptId)!,work=workForDispatch(attempt.dispatch_id)!;
 const id=randomUUID();assertPlanCapacity(binding.runId,0);
 commitHoldActionCommand({runId:binding.runId,commandKey:`autonomous:pause:${binding.attemptId}`,attemptId:binding.attemptId,dispatchId:attempt.dispatch_id,scope:{...scope,ledgerRevision:inputLedgerRevision(binding.attemptId),outputAccess:getScopeAccess(scope.scopeId)},execute:()=>{
  const generation=observeAutonomousWaiting(attempt.dispatch_id,binding.attemptId,grant.agentId,id);
  run('INSERT INTO autonomous_pause_points VALUES(?,?,?,?,?,?,?,?)',id,binding.runId,work.id,binding.attemptId,attempt.dispatch_id,scope.scopeId,generation,new Date().toISOString());
  finishAttempt({attemptId:binding.attemptId,dispatchId:attempt.dispatch_id,status:'completed',output:'用户暂停，已保留本轮实际来源及工具回执。'});return {pauseId:id};
 }});return true;
}
export function reconcileAutonomousPauses(runId:string):void{
 if(!autonomousEntryEnabled(runId)||getRun(runId)?.status!=='running'||get('SELECT 1 FROM orchestration_run_controls WHERE run_id=? AND (pause_requested=1 OR recovery_attention=1)',runId))return;
 for(const point of all<{id:string;work_id:string;source_dispatch_id:string;scope_id:string;generation:number}>('SELECT * FROM autonomous_pause_points WHERE run_id=? ORDER BY rowid',runId)){
  if(get('SELECT 1 FROM runtime_action_commands WHERE command_key=?',`autonomous:pause-wake:${point.id}`))continue;
  const work=autonomousWork(point.work_id)!,{grant,policy}=assertAutonomousGrantReady(work.grant_id),custody=get<{state:string;generation:number}>('SELECT state,generation FROM runtime_custody WHERE subject_id=?',grant.subjectId)!;
  if(custody.state!=='waiting'||custody.generation!==point.generation)continue;assertAutonomousDispatchLimit(runId);
  commitWakeActionCommand({runId,commandKey:`autonomous:pause-wake:${point.id}`,autonomousPauseWake:{pointId:point.id,generation:point.generation},execute:()=>{
   const message=post({runId,from:'system',to:grant.agentId,kind:'system',body:'用户已恢复任务。沿用既有实际来源、工具回执与根预算，已完成效果不要重放；按最新补充继续。',...getScopeAccess(point.scope_id),meta:{autonomousInternal:true}});
   const dispatch=createDispatch({runId,conversationId:policy.conversationId,sourceMessageId:work.objective_message_id,parentDispatchId:point.source_dispatch_id,kind:'resume',from:'system',targetAgentId:grant.agentId,depth:grant.depth,idempotencyKey:`autonomous:pause-resume:${point.id}`});
   observeWakeLink(point.source_dispatch_id,dispatch.id,point.id,point.generation);run('INSERT INTO autonomous_dispatch_work VALUES(?,?,?)',dispatch.id,work.id,new Date().toISOString());return {dispatchId:dispatch.id,sourceMessageId:message.id};
  }});
 }
}
