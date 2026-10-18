import type {ScopedSourceRef,MessageAccess,AutonomousInputV1} from '@agent-gand/shared';
import {all,get,run} from '../db/database.ts';
import {post} from '../messaging/inbox.ts';
import {compileScopedSource,inspectScopedSource} from './scopedCollaboration.ts';
import {autonomousDigest as digest,autonomousFail as fail,loadAutonomousTaskPolicy} from './autonomousPolicy.ts';
import {loadAutonomousResult} from './autonomousResults.ts';
import {flowCatalog,flowDefinition,reduceFlow,type FlowState,type FlowAction} from '../collaboration/protocols/definitions.ts';

export interface FlowRecord {id:string;runId:string;rootWorkId:string;protocol:string;protocolSha256:string;players:string[];initial:FlowState;instructionRevision:number;}
export interface FlowStep {flowId:string;step:number;state:FlowState;previousSha256:string|null;actionWorkIds:string[];}
export interface FlowJob {work_id:string;flow_id:string;step:number;actor:string;}
const checked=<T>(row:{record:string;sha256:string}|undefined):T=>{if(!row)return fail('AUTONOMOUS_FLOW_INVALID');const value=JSON.parse(row.record);if(digest(value)!==row.sha256)return fail('AUTONOMOUS_POLICY_DRIFT');return value;};
export const flowForRun=(id:string)=>get<{id:string}>('SELECT id FROM autonomous_flows WHERE run_id=?',id)?.id;
export const flowJob=(workId:string)=>get<FlowJob>('SELECT * FROM autonomous_flow_jobs WHERE work_id=?',workId);
export function flowRecord(id:string):FlowRecord {
 const row=get<{record:string;sha256:string;run_id:string;root_work_id:string}>('SELECT * FROM autonomous_flows WHERE id=?',id),f=checked<FlowRecord>(row),p=loadAutonomousTaskPolicy(f.runId)!;
 if(f.id!==id||f.runId!==row!.run_id||f.rootWorkId!==row!.root_work_id||!p?.protocols?.some(d=>d.id===f.protocol&&d.sha256===f.protocolSha256)||!flowCatalog().some(d=>d.id===f.protocol&&d.sha256===f.protocolSha256))return fail('AUTONOMOUS_POLICY_DRIFT');return f;
}
export function flowSteps(id:string):FlowStep[]{return all<{record:string;sha256:string}>('SELECT record,sha256 FROM autonomous_flow_steps WHERE flow_id=? ORDER BY step',id).map(checked<FlowStep>);}
export function saveFlowStep(f:FlowRecord,step:FlowStep):void{run('INSERT INTO autonomous_flow_steps VALUES(?,?,?,?,?)',f.id,step.step,JSON.stringify(step),digest(step),new Date().toISOString());}
export function actionForJob(job:FlowJob):FlowAction{
 const row=get<{record:string;sha256:string;attempt_id:string}>('SELECT * FROM autonomous_flow_actions WHERE work_id=?',job.work_id),a=checked<{flowId:string;step:number;actor:string;action:FlowAction;attemptId:string}>(row);
 if(a.flowId!==job.flow_id||a.step!==job.step||a.actor!==job.actor||a.attemptId!==row!.attempt_id)return fail('AUTONOMOUS_POLICY_DRIFT');
 const result=loadAutonomousResult(job.work_id);if(result.attemptId!==a.attemptId||get<{body:string}>('SELECT body FROM messages WHERE id=?',result.message.id)?.body!==JSON.stringify(a.action))return fail('AUTONOMOUS_POLICY_DRIFT');return a.action;
}
// Reentry only breaks the same flow's provenance DAG walk. The outer walk checks every step and result.
const validating=new Set<string>();
export function validateFlow(id:string):{flow:FlowRecord;steps:FlowStep[];latest:FlowStep}{
 const flow=flowRecord(id),steps=flowSteps(id),d=flowDefinition(flow.protocol);if(!steps.length||steps.length>d.maxSteps+1)return fail('AUTONOMOUS_FLOW_INVALID');
 if(!validating.has(id)){validating.add(id);try{
  for(let n=0;n<steps.length;n++){const step=steps[n]!;if(step.flowId!==id||step.step!==n||step.previousSha256!==(n?digest(steps[n-1]):null))return fail('AUTONOMOUS_POLICY_DRIFT');
   if(!n){if(step.actionWorkIds.length||digest(step.state)!==digest(flow.initial))return fail('AUTONOMOUS_POLICY_DRIFT');continue;}
   const previous=steps[n-1]!,actors=d.actors(previous.state),actions:Record<string,FlowAction>={};
   if(step.actionWorkIds.length!==actors.length||new Set(step.actionWorkIds).size!==actors.length)return fail('AUTONOMOUS_POLICY_DRIFT');
   for(const workId of step.actionWorkIds){const job=flowJob(workId);if(!job||job.flow_id!==id||job.step!==n-1||!actors.includes(job.actor)||actions[job.actor])return fail('AUTONOMOUS_POLICY_DRIFT');actions[job.actor]=actionForJob(job);}
   if(digest(reduceFlow(flow.protocol,previous.state,actions,flow.players))!==digest(step.state))return fail('AUTONOMOUS_POLICY_DRIFT');
  }
 }finally{validating.delete(id);}}
 return {flow,steps,latest:steps.at(-1)!};
}
export function flowSource(f:FlowRecord,step:FlowStep,kind:'material'|'notice',actor?:string):{body:string;access:MessageAccess}{
 const d=flowDefinition(f.protocol),p=loadAutonomousTaskPolicy(f.runId)!;
 if(kind==='material'){if(!actor||!d.actors(step.state).includes(actor))return fail('AUTONOMOUS_FLOW_INVALID');return {body:JSON.stringify({flowId:f.id,step:step.step,protocol:f.protocol,rules:d.rules,...d.material(step.state,actor),instruction:'仅为自己作出 requiredAction，调用 agent.flow_action。平台校验并裁决；禁止补充自由文字、其他玩家行动或额外字段。'}),access:{visibility:'private',audience:['user',actor].sort()}};}
 const body=step.step===0?`流程开始 · ${f.protocol}\n座次：${f.players.join('、')}\n${d.rules}`:step.state.history.at(-1)!;
 return {body,access:p.rootAccess};
}
export function saveFlowSource(f:FlowRecord,step:FlowStep,kind:'material'|'notice',actor?:string):ScopedSourceRef{
 const value=flowSource(f,step,kind,actor),m=post({runId:f.runId,from:'system',to:kind==='material'?actor!:value.access.visibility==='public'?'all':value.access.audience.join(','),kind:'system',body:value.body,...value.access,messageType:'informational',meta:kind==='material'?{autonomousInternal:true,autonomousFlowId:f.id}:{autonomousFlowId:f.id,autonomousFlowStep:step.step,authorizedBy:'frozen_protocol'},clientMessageId:`flow:${f.id}:${step.step}:${kind}:${actor??'all'}`});
 const source=compileScopedSource(f.runId,'message',m.id),record={source,kind,actor:actor??null};
 const prior=get('SELECT 1 FROM autonomous_flow_sources WHERE source_id=?',m.id);if(!prior)run('INSERT INTO autonomous_flow_sources VALUES(?,?,?,?,?,?)',m.id,f.id,step.step,JSON.stringify(record),digest(record),new Date().toISOString());return source;
}
export function validateFlowSource(runId:string,ref:ScopedSourceRef):boolean{
 const row=get<{record:string;sha256:string;flow_id:string;step:number}>('SELECT * FROM autonomous_flow_sources WHERE source_id=?',ref.id);if(!row)return false;
 const record=checked<{source:ScopedSourceRef;kind:'material'|'notice';actor:string|null}>(row),{flow,steps}=validateFlow(row.flow_id),step=steps[row.step];
 if(flow.runId!==runId||!step||digest(record.source)!==digest(ref)||digest(inspectScopedSource(runId,ref.kind,ref.id).ref)!==digest(ref))return fail('AUTONOMOUS_POLICY_DRIFT');
 const expected=flowSource(flow,step,record.kind,record.actor??undefined),m=get<{body:string}>('SELECT body FROM messages WHERE id=?',ref.id)!;
 if(m.body!==expected.body||digest(inspectScopedSource(runId,ref.kind,ref.id).access)!==digest(expected.access))return fail('AUTONOMOUS_POLICY_DRIFT');return true;
}
export function flowInputs(f:FlowRecord,step:FlowStep,actor:string):AutonomousInputV1[]{return [{source:saveFlowSource(f,step,'material',actor),readers:[actor]}];}
export function flowFinal(runId:string):{body:string;ref:ScopedSourceRef;access:MessageAccess}|null{
 const id=flowForRun(runId);if(!id)return null;const {flow,steps,latest}=validateFlow(id);if(!latest.state.winner)return fail('AUTONOMOUS_DEPENDENCIES_UNSATISFIED');
 const row=get<{source_id:string}>("SELECT source_id FROM autonomous_flow_sources WHERE flow_id=? AND step=? AND json_extract(record,'$.kind')='notice'",id,latest.step);if(!row)return fail('AUTONOMOUS_FLOW_INVALID');const ref=compileScopedSource(runId,'message',row.source_id);validateFlowSource(runId,ref);return {...flowSource(flow,latest,'notice'),body:`流程结束 · ${flow.protocol}\n\n规则：${flowDefinition(flow.protocol).rules}\n\n完整回放：\n${latest.state.history.map((event,i)=>`${i+1}. ${event}`).join('\n\n')}\n\n已接受的独立行动：\n${steps.slice(1).map(step=>`阶段 ${step.step}：`+step.actionWorkIds.map(workId=>{const job=flowJob(workId)!;return `${job.actor} ${JSON.stringify(actionForJob(job))}`;}).join('；')).join('\n')}`,ref};
}
