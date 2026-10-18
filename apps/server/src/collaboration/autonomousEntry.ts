import {randomUUID} from 'node:crypto';
import {isMessageWithinScope,type AutonomousEntryOptions,type AutonomousTaskView,type MessageAccess,type OrchestrationPreviewInput} from '@agent-gand/shared';
import {all,get,run,tx} from '../db/database.ts';
import {config} from '../config.ts';
import {getAnyAgent} from '../agents/registry.ts';
import {getConversation,createConversation,nextTurnNo,touchConversation} from '../conversations/service.ts';
import {createRun,getRun} from '../runs/trace.ts';
import {post,listByRun} from '../messaging/inbox.ts';
import {messageAccess} from '../messaging/access.ts';
import {createManagedArtifact} from '../artifacts/store.ts';
import {normalizeOrchestrationRequest,objectInput,stringIds,OrchestrationError} from '../orchestration/normalize.ts';
import {orchestrationCapabilities} from '../orchestration/capabilities.ts';
import {admitAutonomousGraph,childWorks,workState,type AutonomousWork} from './autonomousGraph.ts';
import {loadAutonomousTaskPolicy,autonomousDigest as digest,AutonomousTaskError} from '../runtime/autonomousPolicy.ts';
import {loadAutonomousTaskGrant} from '../runtime/autonomousTasks.ts';
import {instructionRevision} from '../runtime/autonomousInstructions.ts';

function invalid(code:string,message:string,status=409):never{throw new OrchestrationError(status,code,message);}
export function autonomousEntryOptions():AutonomousEntryOptions{return {available:config.autonomousCollaborationMode==='execute'&&config.orchestrationRollout.entryMode==='execute'&&config.orchestrationRollout.enabledDrivers.includes('builtin-llm'),mode:config.autonomousCollaborationMode,supportedDrivers:['builtin-llm'],maxOutputTokens:config.collaboration.maxTokens};}
/** Ordinary one-send transaction. No model, shell, preview or Owner capability is invoked here. */
export function submitAutonomousTask(value:unknown,conversationId?:string,source:'room_create'|'conversation_message'|'direct_run'=conversationId?'conversation_message':'room_create'){
 const raw=objectInput(value),allowed=['entryVersion','goal','clientRequestId','conversationId','roomTitle','agentIds','coordinatorId','participantIds','visibility','audience','replyTo','constraints','attachments'];
 if(Object.keys(raw).some(k=>!allowed.includes(k))||raw.entryVersion!==2)invalid('AUTONOMOUS_ENTRY_INVALID','自主任务请求包含不支持的字段',400);
 if(conversationId&&raw.conversationId!==undefined&&raw.conversationId!==conversationId)invalid('ROOM_REFERENCE_CONFLICT','聊天室与请求路径不一致',400);
 conversationId??=typeof raw.conversationId==='string'?raw.conversationId:undefined;
 if(typeof raw.clientRequestId!=='string'||raw.clientRequestId.length<8||raw.clientRequestId.length>100)invalid('INVALID_IDEMPOTENCY_KEY','提交标识长度必须为 8–100',400);
 const scope=conversationId?`conversation:${conversationId}`:`entry:${source}`,key=raw.clientRequestId as string,submissionDigest=digest({...raw,conversationId});
 return tx(()=>{
  const saved=get<{run_id:string;digest:string}>('SELECT * FROM autonomous_submissions WHERE scope=? AND client_key=?',scope,key);
  if(saved){if(saved.digest!==submissionDigest)invalid('IDEMPOTENCY_CONFLICT','同一提交标识不能用于不同内容');const item=getRun(saved.run_id)!;return {run:item,conversation:getConversation(item.conversationId)!,message:listByRun(item.id).find(m=>m.kind==='user')??null,plan:null,deduplicated:true};}
  if(get('SELECT 1 FROM orchestration_requests WHERE idempotency_scope=? AND client_request_id=?',scope,key))invalid('IDEMPOTENCY_CONFLICT','该提交标识已用于手动流程，不能换契约重新执行');
  if(!autonomousEntryOptions().available)invalid('AUTONOMOUS_ENTRY_CLOSED','自主协作入口尚未开放；已有任务保留，可在高级入口使用已开放的手动流程');
  const room=conversationId?getConversation(conversationId):null;if(conversationId&&(!room||room.archivedAt))invalid('ROOM_NOT_FOUND','聊天室不存在或已归档',404);
  if(room?.preferencesIssue)invalid('ROOM_PREFERENCES_INVALID',room.preferencesIssue);
  if(room&&raw.roomTitle!==undefined)invalid('INVALID_ROOM_SETTINGS','已有房间请通过房间菜单修改名称',400);
  if(raw.roomTitle!==undefined&&(typeof raw.roomTitle!=='string'||!raw.roomTitle.trim()||raw.roomTitle.length>80))invalid('INVALID_TITLE','房间名称长度应为 1–80',400);
  const {rounds:_legacyRounds,...roomConstraints}=room?.preferences?.constraints??{};
  const request=normalizeOrchestrationRequest({...raw,agentIds:raw.agentIds??room?.agentIds,strategy:'auto',workflow:'routine',constraints:{...roomConstraints,...objectInput(raw.constraints??{})}} as unknown as OrchestrationPreviewInput,'conversation_message',room?{conversation:room}:{});
  let sourceCharacters=request.goal.length;
  for(const file of (raw.attachments??[]) as NonNullable<OrchestrationPreviewInput['attachments']>){const bytes=Buffer.from(file.contentBase64,'base64');try{if(bytes.includes(0))throw new Error('binary');sourceCharacters+=new TextDecoder('utf-8',{fatal:true}).decode(bytes).length;}catch{invalid('AUTONOMOUS_TEXT_MATERIAL_REQUIRED','当前普通入口读取 UTF-8 文字材料，请先将二进制文件转换为文字。',400);}}
  if(sourceCharacters>12000)invalid('AUTONOMOUS_CONTEXT_TOO_LARGE','当前目标与文字材料合计最多 12000 字符，请缩小本轮范围。',400);
  const capabilities=orchestrationCapabilities(request.agentIds,null),eligible=capabilities.agents.filter(a=>a.enabled!==false&&a.driver==='builtin-llm');
  const access:MessageAccess=request.visibility==='private'?{visibility:'private',audience:request.audience!}:{visibility:'public',audience:[]};
  let reply:{id:string;runId:string;sha256:string}|undefined;
  if(request.replyTo){const m=get<{id:string;run_id:string;conversation_id:string;body:string;seq:number;visibility:string;audience:string}>('SELECT * FROM messages WHERE id=?',request.replyTo);if(!m||m.conversation_id!==room?.id)invalid('INVALID_REPLY','引用必须属于当前聊天室',400);if(!isMessageWithinScope(messageAccess(m.id),access))invalid('PRIVATE_REPLY_SCOPE','引用的私密消息不能扩大范围',400);reply={id:m.id,runId:m.run_id,sha256:digest({body:m.body,seq:m.seq,access:messageAccess(m.id)})};}
  const participants=raw.participantIds===undefined?eligible.filter(a=>access.visibility==='public'||access.audience.includes(a.id)).map(a=>a.id):stringIds(raw.participantIds,'participantIds',true);
  if(!participants.length||participants.some(id=>!eligible.some(a=>a.id===id)||access.visibility==='private'&&!access.audience.includes(id)))invalid('AUTONOMOUS_MEMBER_UNAVAILABLE','参与成员需为本房间已启用且获准的模型 API 角色；SDK/Codex 自主入口尚未开放');
  const mentioned=capabilities.agents.filter(a=>new RegExp(`(?:^|\\s)@(?:${[a.id,a.name].map(v=>v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})(?=$|\\s|[，。,:：!?！？])`).test(request.goal));
  if(mentioned.some(a=>!participants.includes(a.id)))invalid('AUTONOMOUS_MEMBER_UNAVAILABLE','提及的成员不在本轮可参与范围');
  const coordinator=raw.coordinatorId??mentioned[0]?.id??(participants.includes(room?.preferences?.supervisorId??'')?room!.preferences!.supervisorId:null)??eligible.find(a=>participants.includes(a.id)&&a.capabilities.includes('coordinate'))?.id??eligible.find(a=>participants.includes(a.id)&&a.capabilities.includes('execute'))?.id;
  if(typeof coordinator!=='string'||!participants.includes(coordinator)||!getAnyAgent(coordinator)?.capabilities.some(c=>c==='coordinate'||c==='execute'))invalid('AUTONOMOUS_COORDINATOR_UNAVAILABLE','请选择可执行的模型 API 负责人');
  if(sourceCharacters+(getAnyAgent(coordinator)?.systemPrompt.length??0)+participants.length*500+4000>24000)invalid('AUTONOMOUS_CONTEXT_TOO_LARGE','当前角色说明、成员目录与材料超过上下文上限，请精简角色或本轮范围。',400);
  for(const id of participants){const a=eligible.find(a=>a.id===id)!;if(!a.account.compatible||!['configured','unchecked'].includes(a.account.configuration))invalid('AUTONOMOUS_ACCOUNT_UNAVAILABLE',`${a.name} 的账户配置不可用，请先在账户与密钥中核对`);}
  if(request.constraints.rounds!==undefined)invalid('AUTONOMOUS_CONSTRAINT_UNSUPPORTED','固定轮次请使用高级手动流程',400);
  if(request.constraints.costPolicy?.mode==='strict')invalid('AUTONOMOUS_COST_UNSUPPORTED','当前自主任务只开放估算费用控制，请在高级入口选择已支持的费用政策');
  const target=room??createConversation({title:typeof raw.roomTitle==='string'?raw.roomTitle.trim():request.goal.slice(0,80),mode:'collaboration',supervisorId:null,agentIds:request.agentIds,workspace:null,stableWorkspace:true});
  const item=createRun(request.goal,'collaboration',participants,null,null,target.id,nextTurnNo(target.id));
  const root=post({runId:item.id,from:'user',to:coordinator,kind:'user',body:request.goal,...access,replyTo:request.replyTo,clientMessageId:key,deliveryStatus:'queued',meta:{autonomousEntryVersion:1}});
  const inputs:Array<{kind:'message'|'artifact';id:string;readers:string[]}>=[];
  if(reply){const original=get<{body:string}>('SELECT body FROM messages WHERE id=?',reply.id)!;const copy=post({runId:item.id,from:'user',to:coordinator,kind:'system',body:original.body,...access,meta:{autonomousQuotedSource:reply.id}});inputs.push({kind:'message',id:copy.id,readers:participants});}
  for(const f of (raw.attachments??[]) as NonNullable<OrchestrationPreviewInput['attachments']>){const file=createManagedArtifact({runId:item.id,path:f.path,content:Buffer.from(f.contentBase64,'base64'),access,createdBy:'user',mimeType:f.mimeType});inputs.push({kind:'artifact',id:file.id,readers:participants});}
  const c=request.constraints,budget={...(c.maxTokens?{maxOutputTokens:c.maxTokens}:{}),...(c.deadlineMs?{deadlineAt:new Date(Date.now()+c.deadlineMs).toISOString()}:{}),...(c.firstResponseTimeoutMs?{firstResponseTimeoutMs:c.firstResponseTimeoutMs}:{}),...(c.idleTimeoutMs?{idleTimeoutMs:c.idleTimeoutMs}:{})};
  try{admitAutonomousGraph(item.id,{coordinatorId:coordinator,participantIds:participants,inputs,budget},{deliveryVersion:1,entryVersion:1,readonly:c.readonly,costPolicy:c.costPolicy});}catch(error){if(error instanceof AutonomousTaskError)invalid(error.code,'当前任务超出可执行的授权或预算范围，请核对本轮设置');throw error;}
  const record={version:1,coordinatorId:coordinator,participants,reply:reply??null,request:{goal:request.goal,constraints:c,attachments:request.attachments??[]}};
  run('INSERT INTO autonomous_submissions VALUES(?,?,?,?,?,?)',scope,key,item.id,submissionDigest,JSON.stringify(record),new Date().toISOString());touchConversation(target.id);
  return {run:getRun(item.id)!,conversation:getConversation(target.id)!,message:root,plan:null,deduplicated:false};
 });
}
export function autonomousTaskView(runId:string):AutonomousTaskView|null{
 const p=loadAutonomousTaskPolicy(runId);if(!p)return null;
 const works=all<AutonomousWork>('SELECT * FROM autonomous_work_items WHERE run_id=? ORDER BY created_at,rowid',runId);
 return {coordinatorId:p.coordinatorId,participantIds:p.participantIds,instructionRevision:instructionRevision(runId),entry:!!get('SELECT 1 FROM autonomous_submissions WHERE run_id=?',runId),budget:{maxOutputTokens:p.budget.maxOutputTokens,deadlineAt:p.budget.deadlineAt,chargedOutputTokens:get<{n:number}>("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) n FROM orchestration_token_reservations WHERE run_id=?",runId)?.n??0},works:works.map(w=>{
  const g=loadAutonomousTaskGrant(w.grant_id),state=workState(w),custody=get<{state:string}>('SELECT state FROM runtime_custody WHERE subject_id=?',g.subjectId)!,dispatch=get<{status:string}>('SELECT d.status FROM collaboration_dispatches d JOIN autonomous_dispatch_work m ON m.dispatch_id=d.id WHERE m.work_id=? ORDER BY d.rowid DESC LIMIT 1',w.id);
  return {id:w.id,key:w.work_key,agentId:g.agentId,objective:get<{body:string}>('SELECT body FROM messages WHERE id=?',w.objective_message_id)!.body,state:state!=='active'?state:custody.state==='waiting'?'waiting':dispatch?.status??'blocked',dependsOn:all<{dependency_id:string}>('SELECT dependency_id FROM autonomous_work_dependencies WHERE work_id=?',w.id).map(d=>d.dependency_id),resultMessageId:get<{id:string}>("SELECT json_extract(record,'$.message.id') id FROM autonomous_results WHERE work_id=?",w.id)?.id??null};})};
}
