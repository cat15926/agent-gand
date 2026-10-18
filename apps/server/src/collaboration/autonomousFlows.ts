import {commitEmitActionCommand} from '../runtime/actionCommands.ts';
import {assertAutonomousUsageKnown} from '../runtime/autonomousExecution.ts';
import {randomUUID} from 'node:crypto';
import type {AutonomousGrantBinding,AutonomousFlowIntent,AutonomousInputV1} from '@agent-gand/shared';
import {all,get,run,tx} from '../db/database.ts';
import {assertAutonomousGrant} from '../runtime/autonomousTasks.ts';
import {autonomousDigest as digest,autonomousFail as fail} from '../runtime/autonomousPolicy.ts';
import {loadRuntimeContract} from '../runtime/runPolicy.ts';
import {assertScopedOutput,inputLedgerRevision,type ScopedAttemptBinding} from '../runtime/scopedCollaboration.ts';
import {flowForRun,validateFlow,flowJob,flowRecord,actionForJob,saveFlowStep,saveFlowSource,flowInputs,type FlowRecord,type FlowJob,type FlowStep} from '../runtime/autonomousFlowFacts.ts';
import {instructionRevision} from '../runtime/autonomousInstructions.ts';
import {childWorks,workForDispatch,workState,commitAutonomousDelegation} from './autonomousGraph.ts';
import {flowDefinition,reduceFlow,type FlowAction} from './protocols/definitions.ts';

export function advanceAutonomousFlow(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,intent:AutonomousFlowIntent){return tx(()=>{
 assertAutonomousUsageKnown(binding.runId);
 const {grant,policy}=assertAutonomousGrant(binding,'flow');if(loadRuntimeContract(binding.runId)?.features?.autonomousCollaboration?.flowVersion!==1)return fail('AUTONOMOUS_EXECUTOR_UNAVAILABLE');
 const dispatch=get<{dispatch_id:string}>('SELECT dispatch_id FROM collaboration_attempts WHERE id=?',binding.attemptId)!,work=workForDispatch(dispatch.dispatch_id)!;
 if(work.parent_work_id||grant.agentId!==policy.coordinatorId)return fail('AUTONOMOUS_ACCESS_DENIED');
 // Protocol disclosure is bounded by the clean root request, never by a model's private reasoning.
 assertScopedOutput({...scope,ledgerRevision:inputLedgerRevision(binding.attemptId),outputAccess:policy.rootAccess});
 let id=flowForRun(binding.runId),f:FlowRecord,step:FlowStep;
 if(!id){
  if(intent.flowId||intent.expectedStep!==undefined||!intent.protocol||!intent.players)return fail('AUTONOMOUS_FLOW_INVALID');
  const d=flowDefinition(intent.protocol),players=intent.players;
  if(players.length<d.minActors||players.length>d.maxActors||new Set(players).size!==players.length||players.some(p=>!grant.participantIds.includes(p)||policy.members.find(m=>m.agentId===p)?.driver!=='builtin-llm'))return fail('AUTONOMOUS_FLOW_INVALID');
  if(childWorks(work.id).length)return fail('AUTONOMOUS_FLOW_INVALID');
  id=randomUUID();f={id,runId:binding.runId,rootWorkId:work.id,protocol:d.id,protocolSha256:policy.protocols!.find(p=>p.id===d.id)!.sha256,players,initial:d.initialize(players),instructionRevision:instructionRevision(binding.runId)};
  run('INSERT INTO autonomous_flows VALUES(?,?,?,?,?,?,?)',id,binding.runId,work.id,intent.commandKey,JSON.stringify(f),digest(f),new Date().toISOString());
  step={flowId:id,step:0,state:f.initial,previousSha256:null,actionWorkIds:[]};saveFlowStep(f,step);saveFlowSource(f,step,'notice');
 }else{
  if(intent.protocol||intent.players||intent.flowId!==id)return fail('AUTONOMOUS_FLOW_INVALID');
  const loaded=validateFlow(id);f=loaded.flow;step=loaded.latest;
  if(intent.expectedStep!==step.step||step.state.winner)return fail('AUTONOMOUS_FLOW_INVALID');
  const jobs=all<FlowJob>('SELECT * FROM autonomous_flow_jobs WHERE flow_id=? AND step=? ORDER BY rowid',id,step.step),d=flowDefinition(f.protocol),actors=d.actors(step.state),actions:Record<string,FlowAction>={};
  if(jobs.length!==actors.length||jobs.some(j=>!actors.includes(j.actor)||workState(childWorks(work.id).find(w=>w.id===j.work_id)!)!=='completed'))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
  for(const j of jobs)actions[j.actor]=actionForJob(j);
  if(step.step>=d.maxSteps)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
  const next={flowId:id,step:step.step+1,state:reduceFlow(f.protocol,step.state,actions,f.players),previousSha256:digest(step),actionWorkIds:jobs.map(j=>j.work_id)};
  saveFlowStep(f,next);step=next;const notice=saveFlowSource(f,step,'notice');
  if(step.state.winner){const committed=commitEmitActionCommand({runId:binding.runId,commandKey:`flow:terminal:${id}:${step.step}`,attemptId:binding.attemptId,dispatchId:dispatch.dispatch_id,scope:{...scope,ledgerRevision:inputLedgerRevision(binding.attemptId),outputAccess:policy.rootAccess},intentFingerprint:digest(intent),execute:()=>{run('INSERT INTO autonomous_tool_receipts VALUES(?,?,?,?,?,?,?)',notice.id,binding.attemptId,scope.scopeId,`flow:terminal-receipt:${id}`,JSON.stringify(notice),digest(notice),new Date().toISOString());return {receiptId:notice.id};}});return {waiting:false,...committed.result};}
 }
 const actors=flowDefinition(f.protocol).actors(step.state),inputs:AutonomousInputV1[]=actors.flatMap(actor=>flowInputs(f,step,actor));
 // Shared task material stays within its original ACL; identity/clues enter only the actor's new content Scope.
 const items=actors.map(actor=>({key:`flow-${step.step}-${f.players.indexOf(actor)+1}`,agentId:actor,objective:`执行 ${f.protocol} 第${step.step+1}阶段，只提交当前玩家的结构化行动。`,
  inputIds:[...inputs.filter(i=>i.readers.includes(actor)).map(i=>i.source.id),...grant.inputs.filter(i=>i.readers.includes(actor)).map(i=>i.source.id)],dependsOn:[],participantIds:[actor],allowedTools:[],delegableTools:[],outputAudience:[actor]}));
 const result=commitAutonomousDelegation(binding,scope,{commandKey:`flow:${id}:${step.step}`,items},{aggregateInputs:inputs,flowJobs:true});
 const workIds=result.result.workIds;for(let n=0;n<workIds.length;n++)run('INSERT INTO autonomous_flow_jobs VALUES(?,?,?,?)',workIds[n],id,step.step,actors[n]);
 return {waiting:true,...result.result};
});}
export function commitAutonomousFlowAction(binding:AutonomousGrantBinding,scope:ScopedAttemptBinding,value:unknown,complete:(summary:string)=>unknown){return tx(()=>{
 assertAutonomousGrant(binding,'flow_action');const dispatch=get<{dispatch_id:string}>('SELECT dispatch_id FROM collaboration_attempts WHERE id=?',binding.attemptId)!,work=workForDispatch(dispatch.dispatch_id)!,job=flowJob(work.id);
 if(!job||job.actor!==scope.agentId)return fail('AUTONOMOUS_FLOW_INVALID');const {flow,latest}=validateFlow(job.flow_id);
 if(latest.step!==job.step||latest.state.winner)return fail('AUTONOMOUS_FLOW_INVALID');
 const action=flowDefinition(flow.protocol).action(latest.state,job.actor,value),record={flowId:flow.id,step:job.step,actor:job.actor,action,attemptId:binding.attemptId};
 if(get('SELECT 1 FROM autonomous_flow_actions WHERE work_id=?',work.id))return fail('AUTONOMOUS_FLOW_INVALID');
 run('INSERT INTO autonomous_flow_actions VALUES(?,?,?,?,?)',work.id,binding.attemptId,JSON.stringify(record),digest(record),new Date().toISOString());
 return complete(JSON.stringify(action));
});}
export function assertFlowCompletion(workId:string,runId:string):void{
 const job=flowJob(workId);if(job){if(!get('SELECT 1 FROM autonomous_flow_actions WHERE work_id=?',workId))return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');return;}
 const id=flowForRun(runId);if(id&&flowRecord(id).rootWorkId===workId&&!validateFlow(id).latest.state.winner)return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
}
