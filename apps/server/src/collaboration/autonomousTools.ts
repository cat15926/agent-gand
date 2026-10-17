import type {AutonomousDelegateIntentV1,AutonomousAggregateIntentV1,AutonomousEmitIntentV1,AutonomousQuestionIntentV1,MessageAccess} from '@agent-gand/shared';
import type {LlmToolCall,LlmToolSchema} from '../llm/provider.ts';
import {autonomousFail as fail,autonomousObject as object,autonomousStrings as strings} from '../runtime/autonomousPolicy.ts';
import {isAcknowledgementOutput} from '../runtime/exitGuard.ts';

const key=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>120)return fail('AUTONOMOUS_CONTRACT_INVALID');return value;};
const list=(value:unknown):string[]=>{if(!strings(value))return fail('AUTONOMOUS_CONTRACT_INVALID');return [...value];};
export type AutonomousControlCall={type:'delegate';intent:AutonomousDelegateIntentV1}|{type:'complete';summary:string}
  |{type:'aggregate';intent:AutonomousAggregateIntentV1}|{type:'emit';intent:AutonomousEmitIntentV1}|{type:'request_user';intent:AutonomousQuestionIntentV1};
const body=(value:unknown,max=24000):string=>{if(typeof value!=='string'||!value.trim()||value.length>max)return fail('AUTONOMOUS_CONTRACT_INVALID');return value.trim();};
const outputAccess=(value:unknown):MessageAccess=>{
  const v=object(value??{visibility:'private',audience:['user']},['visibility','audience']);
  if(!['public','private'].includes(String(v.visibility)))return fail('AUTONOMOUS_CONTRACT_INVALID');
  const audience=list(v.audience);if(v.visibility==='public'&&audience.length)return fail('AUTONOMOUS_CONTRACT_INVALID');
  return {visibility:v.visibility as 'public'|'private',audience:v.visibility==='public'?[]:[...new Set(['user',...audience])].sort()};
};
/** No Run/Scope/Attempt/Grant or budget fields are accepted from the model. */
export function parseAutonomousControlCall(call:LlmToolCall):AutonomousControlCall {
  if(call.input.length>96_000)return fail('AUTONOMOUS_CONTRACT_INVALID');
  let raw:unknown;try{raw=JSON.parse(call.input);}catch{return fail('AUTONOMOUS_CONTRACT_INVALID');}
  if(call.name==='agent.aggregate'){
    const v=object(raw,['commandKey','key','agentId','objective','resultKeys','allowedTools']);
    const resultKeys=list(v.resultKeys);if(!resultKeys.length||resultKeys.length>16)return fail('AUTONOMOUS_CONTRACT_INVALID');
    return {type:'aggregate',intent:{commandKey:key(v.commandKey),key:key(v.key),agentId:key(v.agentId),objective:body(v.objective,16000),resultKeys,allowedTools:list(v.allowedTools??[])}};
  }
  if(call.name==='agent.emit'){
    const v=object(raw,['commandKey','kind','format','text','resultKeys','access']);
    if(!['update','final'].includes(String(v.kind))||!['text','result_bundle','task_status_v1'].includes(String(v.format)))return fail('AUTONOMOUS_CONTRACT_INVALID');
    const text=v.format==='text'?body(v.text):undefined,resultKeys=v.format==='result_bundle'?list(v.resultKeys):undefined;
    if(v.format!=='text'&&v.text!==undefined||v.format!=='result_bundle'&&v.resultKeys!==undefined||resultKeys&&!resultKeys.length)return fail('AUTONOMOUS_CONTRACT_INVALID');
    return {type:'emit',intent:{commandKey:key(v.commandKey),kind:v.kind as 'update'|'final',format:v.format as AutonomousEmitIntentV1['format'],text,resultKeys,access:outputAccess(v.access)}};
  }
  if(call.name==='agent.request_user'){
    const v=object(raw,['commandKey','questions']);if(!Array.isArray(v.questions)||!v.questions.length||v.questions.length>6)return fail('AUTONOMOUS_CONTRACT_INVALID');
    const questions=v.questions.map(raw=>{const q=object(raw,['key','question','requiredFor']);const question=body(q.question,1200),requiredFor=body(q.requiredFor,1200);if(/是否继续|继续吗|要继续吗|批准内部|shall I continue|should I continue/i.test(question))return fail('AUTONOMOUS_CONTRACT_INVALID');return {key:key(q.key),question,requiredFor};});
    if(new Set(questions.map(q=>q.key)).size!==questions.length)return fail('AUTONOMOUS_CONTRACT_INVALID');
    return {type:'request_user',intent:{commandKey:key(v.commandKey),questions}};
  }
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
      participantIds:list(i.participantIds??[agentId]),allowedTools:list(i.allowedTools??[]),delegableTools:list(i.delegableTools??[]),...(i.outputAudience!==undefined?{outputAudience:list(i.outputAudience)}:{})};
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

const fields=(required:string[],properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required,properties});
export const AUTONOMOUS_DELIVERY_TOOLS:LlmToolSchema[]=[
  {name:'agent.aggregate',description:'选择本责任已经完成的 resultKeys，交给有权成员在新内容 Scope 中汇总；可选择自己。输入只由服务端解析，仍用同一根预算；确需新增读者时只提出一次确切授权。',parameters:fields(['commandKey','key','agentId','objective','resultKeys'],{commandKey:{type:'string'},key:{type:'string'},agentId:{type:'string'},objective:{type:'string'},resultKeys:stringList,allowedTools:stringList})},
  {name:'agent.emit',description:'提交阶段更新或最终交付候选。text 受实际已读来源约束；result_bundle 由平台按确切结果组装，不把正文回传给无权的组织者；task_status_v1 只计算固定计数。合法范围自动执行，越界只生成具体决策。final 在任务完成验收后交付。',parameters:fields(['commandKey','kind','format'],{commandKey:{type:'string'},kind:{type:'string',enum:['update','final']},format:{type:'string',enum:['text','result_bundle','task_status_v1']},text:{type:'string'},resultKeys:stringList,access:fields(['visibility','audience'],{visibility:{type:'string',enum:['public','private']},audience:stringList})})},
  {name:'agent.request_user',description:'一次合并真正缺失的业务信息：逐项给出问题和阻塞的工作。不能询问是否继续或代替确切权限批准。回答后恢复同一责任和根预算。',parameters:fields(['commandKey','questions'],{commandKey:{type:'string'},questions:{type:'array',minItems:1,maxItems:6,items:fields(['key','question','requiredFor'],{key:{type:'string'},question:{type:'string'},requiredFor:{type:'string'}})}})},
];
