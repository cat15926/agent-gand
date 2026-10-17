import type {AutonomousDelegateIntentV1} from '@agent-gand/shared';
import type {LlmToolCall,LlmToolSchema} from '../llm/provider.ts';
import {autonomousFail as fail,autonomousObject as object,autonomousStrings as strings} from '../runtime/autonomousPolicy.ts';
import {isAcknowledgementOutput} from '../runtime/exitGuard.ts';

const key=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>120)return fail('AUTONOMOUS_CONTRACT_INVALID');return value;};
const list=(value:unknown):string[]=>{if(!strings(value))return fail('AUTONOMOUS_CONTRACT_INVALID');return [...value];};
export type AutonomousControlCall={type:'delegate';intent:AutonomousDelegateIntentV1}|{type:'complete';summary:string};
/** No Run/Scope/Attempt/Grant or budget fields are accepted from the model. */
export function parseAutonomousControlCall(call:LlmToolCall):AutonomousControlCall {
  if(call.input.length>96_000)return fail('AUTONOMOUS_CONTRACT_INVALID');
  let raw:unknown;try{raw=JSON.parse(call.input);}catch{return fail('AUTONOMOUS_CONTRACT_INVALID');}
  if(call.name==='agent.complete'){
    const v=object(raw,['summary']);
    if(typeof v.summary!=='string'||v.summary.trim().length<16||v.summary.length>24_000||isAcknowledgementOutput(v.summary))return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');
    return {type:'complete',summary:v.summary.trim()};
  }
  if(call.name!=='agent.delegate')return fail('AUTONOMOUS_EXPLICIT_ACTION_REQUIRED');
  const v=object(raw,['commandKey','items']);
  if(!Array.isArray(v.items)||!v.items.length||v.items.length>16)return fail('AUTONOMOUS_LIMIT_EXCEEDED');
  const items=v.items.map(raw=>{
    const i=object(raw,['key','agentId','objective','inputIds','dependsOn','participantIds','allowedTools','delegableTools','outputAudience']);
    const agentId=key(i.agentId);
    if(typeof i.objective!=='string'||!i.objective.trim()||i.objective.length>16_000)return fail('AUTONOMOUS_CONTRACT_INVALID');
    return {key:key(i.key),agentId,objective:i.objective.trim(),inputIds:list(i.inputIds??[]),dependsOn:list(i.dependsOn??[]),
      participantIds:list(i.participantIds??[agentId]),allowedTools:list(i.allowedTools??[]),delegableTools:list(i.delegableTools??[]),outputAudience:list(i.outputAudience??['user',agentId])};
  });
  if(new Set(items.map(i=>i.key)).size!==items.length)return fail('AUTONOMOUS_GRAPH_INVALID');
  return {type:'delegate',intent:{commandKey:key(v.commandKey),items}};
}

const stringList={type:'array',items:{type:'string'}};
export const AUTONOMOUS_TOOLS:LlmToolSchema[]=[
  {name:'agent.delegate',description:'按当前目标自主选择成员，创建各自不同的任务和输入；dependsOn 使用本责任内已有或本次新建的任务 key。提交后持久等待全部子任务并由系统唤醒，不轮询。只能追加计划，不能改写已提交的工作。',parameters:{
    type:'object',additionalProperties:false,required:['commandKey','items'],properties:{commandKey:{type:'string',maxLength:120},items:{
      type:'array',minItems:1,maxItems:16,items:{type:'object',additionalProperties:false,required:['key','agentId','objective'],properties:{
        key:{type:'string'},agentId:{type:'string'},objective:{type:'string',maxLength:16000},inputIds:stringList,dependsOn:stringList,
        participantIds:stringList,allowedTools:stringList,delegableTools:stringList,outputAudience:stringList,
      }},
    }},
  }},
  {name:'agent.complete',description:'提交本责任的实质结果；全部必需子任务、证据和用量必须已核验。不会自行扩大私密结果的发布范围。',parameters:{type:'object',additionalProperties:false,required:['summary'],properties:{summary:{type:'string',minLength:16,maxLength:24000}}}},
];
