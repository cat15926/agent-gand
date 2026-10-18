import type {AutonomousDelegateIntentV1,AutonomousAggregateIntentV1,AutonomousEmitIntentV1,AutonomousQuestionIntentV1,AutonomousFlowIntent,MessageAccess} from '@agent-gand/shared';
import type {LlmToolCall,LlmToolSchema} from '../llm/provider.ts';
import {autonomousFail as fail,autonomousObject as object,autonomousStrings as strings} from '../runtime/autonomousPolicy.ts';
import {isAcknowledgementOutput} from '../runtime/exitGuard.ts';

const key=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>120)return fail('AUTONOMOUS_CONTRACT_INVALID');return value;};
const list=(value:unknown):string[]=>{if(!strings(value))return fail('AUTONOMOUS_CONTRACT_INVALID');return [...value];};
export type AutonomousControlCall={type:'flow';intent:AutonomousFlowIntent}|{type:'flow_action';action:unknown}|{type:'delegate';intent:AutonomousDelegateIntentV1}|{type:'complete';summary:string}
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
  if(call.name==='agent.flow_action')return {type:'flow_action',action:raw};
  if(call.name==='agent.flow'){
    const v=object(raw,['commandKey','protocol','players','flowId','expectedStep']);
    if(v.flowId!==undefined){if(typeof v.flowId!=='string'||!Number.isSafeInteger(v.expectedStep)||v.protocol!==undefined||v.players!==undefined)return fail('AUTONOMOUS_FLOW_INVALID');return {type:'flow',intent:{commandKey:key(v.commandKey),flowId:key(v.flowId),expectedStep:Number(v.expectedStep)}};}
    if(v.expectedStep!==undefined)return fail('AUTONOMOUS_FLOW_INVALID');
    return {type:'flow',intent:{commandKey:key(v.commandKey),protocol:key(v.protocol),players:list(v.players)}};
  }
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

/** Per-turn schema hints; Runtime still validates authority. Never mutate shared tool definitions. */
export function bindAutonomousToolSchemas(tools:LlmToolSchema[],agentId:string,memberIds:string[],inputIds:string[],flow?:{id:string;step:number}):LlmToolSchema[]{
  return tools.map(tool=>{
    if(tool.name==='agent.flow')return {...tool,parameters:flow?{
      type:'object',additionalProperties:false,required:['commandKey','flowId','expectedStep'],properties:{
        commandKey:{type:'string',maxLength:120},flowId:{type:'string',enum:[flow.id]},
        expectedStep:{type:'integer',enum:[flow.step],description:'填写当前已观察到的 step，用于并发校验；不是下一阶段编号。'},
      },
    }:{type:'object',additionalProperties:false,required:['commandKey','protocol','players'],properties:{
      commandKey:{type:'string',maxLength:120},protocol:{type:'string',enum:['werewolf-five-v1','review-ballot-v1']},players:{type:'array',items:{type:'string',enum:memberIds},uniqueItems:true},
    }}};
    if(!['agent.delegate','agent.aggregate'].includes(tool.name))return tool;
    const parameters=tool.parameters as {properties:Record<string,unknown>;required:string[]};
    const member={type:'string',enum:memberIds,description:`填写成员精确 ID；当前执行者是 ${JSON.stringify(agentId)}，不是 self。`};
    if(tool.name==='agent.aggregate')return {...tool,parameters:{...parameters,properties:{...parameters.properties,agentId:member}}};
    const items=parameters.properties.items as {items:{properties:Record<string,unknown>;required:string[]}};
    const itemSchema={...items.items,
      required:[...items.items.required,'inputIds','allowedTools'],properties:{...items.items.properties,
        agentId:{...member,enum:memberIds.filter(id=>id!==agentId)},
        inputIds:{type:'array',items:{type:'string',enum:inputIds},description:'选本轮输入句柄 ID。转交附件必须包含对应文件句柄；写在 objective 中的文件名不授予读取权限。不需要材料时填 []。'},
        allowedTools:{...stringList,description:'明确授予本子任务需要且成员已开放的工具，例如读取文件需要 fs.read、修改需要 fs.write；省略或 [] 表示无文件工具。'},
        dependsOn:{...stringList,description:'只保证执行顺序，不转交依赖结果或新文件。要读取成员产物，先等待其完成，再用 agent.aggregate 的 resultKeys 创建复核责任。'},
        outputAudience:{type:'array',items:{type:'string',enum:['user',...memberIds]},description:'可省略，由平台沿用有权读者。显式指定时必须包含执行成员本人。这是任务及产物可见范围，不是交接收件人，不能扩大材料权限。'},
      }};
    return {...tool,parameters:{...parameters,properties:{...parameters.properties,items:{...items,items:itemSchema}}}};
  });
}
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

export const AUTONOMOUS_FLOW_TOOLS:LlmToolSchema[]=[
 {name:'agent.flow',description:'启动受支持的可校验流程：protocol + players（不同启用成员的 ID，按座次）。身份由平台私密分配。阶段子义务结束自动唤醒后，用 flowId + expectedStep 推进。终局回执后调用 agent.complete；不能编造行动、替玩家投票、修改规则或中途扩大披露。',parameters:fields(['commandKey'],{commandKey:{type:'string'},protocol:{type:'string',enum:['werewolf-five-v1','review-ballot-v1']},players:stringList,flowId:{type:'string'},expectedStep:{type:'integer',minimum:0}})},
 {name:'agent.flow_action',description:'只提交当前私密材料 requiredAction 中本人的结构化行动。字段必须完全匹配：夜间 kind/target；声明 kind/target/claim/confidence；投票 kind/target；评审 kind/verdict。平台验证并完成本责任，无自由文字和额外字段。',parameters:{type:'object',properties:{kind:{type:'string',enum:['attack','inspect','statement','vote','review']},target:{type:'string'},claim:{type:'string',enum:['seer','villager','unspecified']},confidence:{type:'string',enum:['low','medium','high']},verdict:{type:'string',enum:['approve','revise','reject']}},required:['kind'],additionalProperties:false}},
];
