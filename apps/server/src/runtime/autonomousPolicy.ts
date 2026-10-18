import {flowCatalog} from '../collaboration/protocols/definitions.ts';
import {createHash} from 'node:crypto';
import {isMessageWithinScope,readCostPolicy,type AutonomousTaskPolicyV1,type AutonomousTaskErrorCode} from '@agent-gand/shared';
import {get} from '../db/database.ts';

export class AutonomousTaskError extends Error {
  readonly retryable=false;
  constructor(readonly code:AutonomousTaskErrorCode){super(code);}
}
export const autonomousFail=(code:AutonomousTaskErrorCode):never=>{throw new AutonomousTaskError(code);};
export const autonomousDigest=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)).digest('hex');
export function autonomousObject(value:unknown,keys:string[]):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  return value as Record<string,unknown>;
}
export const autonomousStrings=(value:unknown):value is string[]=>Array.isArray(value)&&value.every(s=>typeof s==='string'&&!!s&&s.length<=240)&&new Set(value).size===value.length;
const validAccess=(value:unknown):boolean=>{
  if(!value||typeof value!=='object')return false;
  const a=value as {visibility?:string;audience?:unknown};
  return ['public','private'].includes(a.visibility??'')&&autonomousStrings(a.audience)&&(a.visibility==='public'?a.audience.length===0:a.audience.includes('user'));
};

/** Read-only immutable policy inspection, also used by the common Contract reader.
 * No live/source checks here: terminal audit data must remain readable. */
export function loadAutonomousTaskPolicy(runId:string):AutonomousTaskPolicyV1|null {
  const row=get<{id:string;record:string;sha256:string}>('SELECT id,record,sha256 FROM autonomous_task_policies WHERE run_id=?',runId);
  if(!row)return null;
  let p:AutonomousTaskPolicyV1;
  try{p=JSON.parse(row.record);}catch{return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');}
  if(autonomousDigest(p)!==row.sha256)return autonomousFail('AUTONOMOUS_POLICY_DRIFT');
  if(!p||p.version!==1||p.revision!==1||p.id!==row.id||p.runId!==runId||!/^[a-f0-9]{64}$/.test(p.admissionSha256)||!autonomousStrings(p.participantIds)||!p.participantIds.length||!p.participantIds.includes(p.coordinatorId)
    ||!validAccess(p.rootAccess)||!validAccess(p.outputAccess)||!isMessageWithinScope(p.rootAccess,p.outputAccess)||p.disclosure!=='within_source_access'
    ||!p.budget||(['maxOutputTokens','maxTokensPerCall','maxConcurrency','maxDispatches','maxDepth','firstResponseTimeoutMs','idleTimeoutMs'] as const).some(key=>!Number.isSafeInteger(p.budget[key])||p.budget[key]<=0)
    ||!Number.isFinite(Date.parse(p.budget.deadlineAt))||p.budget.maxTokensPerCall>p.budget.maxOutputTokens
    ||!readCostPolicy(p.costPolicy)||p.costPolicy.mode!=='estimate'||!Array.isArray(p.inputs)||!Array.isArray(p.members))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  if(p.executionDrivers!==undefined&&(!autonomousStrings(p.executionDrivers)||!p.executionDrivers.includes('builtin-llm')||p.executionDrivers.some(d=>!['builtin-llm','claude-sdk'].includes(d))))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  if(p.protocols!==undefined&&autonomousDigest(p.protocols)!==autonomousDigest(flowCatalog()))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  if(p.members.length!==p.participantIds.length||new Set(p.members.map(m=>m.agentId)).size!==p.members.length||p.members.some(m=>!p.participantIds.includes(m.agentId)||!Number.isSafeInteger(m.roleVersion)||m.roleVersion<1||typeof m.model!=='string'||!m.model||!['builtin-llm','claude-sdk','codex-app-server'].includes(m.driver)||!autonomousStrings(m.allowedTools)))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  if(p.inputs.some(i=>!i.source||!['message','artifact','tool_execution'].includes(i.source.kind)||!Number.isSafeInteger(i.source.version)||i.source.version<1||!/^[a-f0-9]{64}$/.test(i.source.sha256)||!autonomousStrings(i.readers)||i.readers.some(id=>!p.participantIds.includes(id))))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  if(!p.rootSource||!p.inputs.some(i=>autonomousDigest(i.source)===autonomousDigest(p.rootSource)))return autonomousFail('AUTONOMOUS_CONTRACT_INVALID');
  return p;
}
