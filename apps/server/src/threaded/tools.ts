import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { BackendTool } from './backends/types.ts';
import type { createThreadedRouting } from './routing.ts';
import type { createThreadedCooperation } from './cooperation.ts';
import type { createThreadedContext } from './context.ts';
import type {createThreadedActions} from './actions.ts';
import {THREADED_REVIEW_TOOLS,REVIEW_READ_TOOLS,type createThreadedReviews} from './reviews.ts';
import {THREADED_SOP_TOOLS,type createThreadedSop} from './sop.ts';
import {THREADED_KNOWLEDGE_TOOLS,type createThreadedKnowledge} from './knowledge.ts';
import type {createActionCommands} from './actionCommands.ts';
import {ThreadedContextError} from './contextTypes.ts';
import {ThreadedMessageError} from './messageContracts.ts';
import {ThreadedMessageAclError} from './acl.ts';
import { digest, object, text, strings, integer, reject, ThreadedCollaborationError, type CollaborationOptions } from './collaborationTypes.ts';

const s={type:'string'}, list={type:'array',items:s,maxItems:100}, num={type:'integer'};
const descriptor=(name:string,description:string,properties:Record<string,unknown>,required:string[]):BackendTool=>({name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}});
export const THREADED_TOOLS:BackendTool[]=[
  descriptor('post_message','Publish an independently addressed message. Final output remains a separate response.',{idempotencyKey:s,body:s,targets:list,visibility:{enum:['public','private']},audience:list,sourceRefs:list},['idempotencyKey','body']),
  descriptor('cross_post_message','Post explicit authorized content to another Thread in which you are a member.',{idempotencyKey:s,threadId:s,body:s,targets:list,visibility:{enum:['public','private']},audience:list,sourceRefs:list},['idempotencyKey','threadId','body','targets']),
  descriptor('read_message','Read one exact authorized message within the frozen input boundary.',{messageId:s},['messageId']),
  descriptor('search_messages','Search authorized messages, preserving source IDs. This is literal search, not semantic memory.',{query:s,afterSeq:num,limit:num},['query']),
  descriptor('read_attachment','Read an explicit byte range of an authorized attachment with its full hash.',{attachmentId:s,offset:num,length:num},['attachmentId']),
  descriptor('message_sources','Expand exact authorized provenance of a visible message.',{messageId:s},['messageId']),
  descriptor('mark_seen','Record explicit reading independently of transport delivery.',{idempotencyKey:s,messageIds:list},['idempotencyKey','messageIds']),
  descriptor('acknowledge_mentions','Acknowledge mention messages without completing a business Action.',{idempotencyKey:s,messageIds:list},['idempotencyKey','messageIds']),
  descriptor('multi_mention','Collect independent responses from 1–3 members. Returns immediately; no cascade, no winner cancellation.',{idempotencyKey:s,targets:{...list,maxItems:3,minItems:1},question:s,context:s,callbackTo:s,timeoutMinutes:num,searchEvidenceRefs:list,overrideReason:s},['idempotencyKey','targets','question','callbackTo']),
  descriptor('multi_mention_status','Read your durable consultation target states.',{groupId:s},['groupId']),
  descriptor('hold_ball','Register a 5–3600 second timer and return immediately. Timer expiry is not proof of a business condition.',{idempotencyKey:s,jobKey:s,seconds:num,waitSourceRef:s,replaceWaitId:s,expectedVersion:num},['idempotencyKey','jobKey','seconds','waitSourceRef']),
  descriptor('track_event','Wait for a new event after an authenticated live baseline; historical events do not trigger.',{idempotencyKey:s,jobKey:s,source:s,subject:s,match:{type:'object',additionalProperties:true},replaceWaitId:s,expectedVersion:num},['idempotencyKey','jobKey','source','subject','match']),
  descriptor('conversation_decision','Create an ordinary interactive once decision without blocking this Invocation.',{idempotencyKey:s,jobKey:s,question:s,once:{type:'boolean'},block:{enum:['interactive']},replaceWaitId:s,expectedVersion:num},['idempotencyKey','jobKey','question','once','block']),
  descriptor('settle_decision','Settle only the exact current user origin trigger answering this decision revision; no business approval is granted.',{idempotencyKey:s,waitId:s,operationId:s,expectedVersion:num,responseMessageId:s},['idempotencyKey','waitId','operationId','expectedVersion','responseMessageId']),
  descriptor('withdraw_decision','Withdraw your own unanswered decision at the expected revision.',{idempotencyKey:s,waitId:s,operationId:s,expectedVersion:num},['idempotencyKey','waitId','operationId','expectedVersion']),
  descriptor('create_task','Create a platform task with frozen acceptance criteria in this Thread.',{idempotencyKey:s,title:s,body:s,acceptanceCriteria:list},['idempotencyKey','title','acceptanceCriteria']),
  descriptor('read_action','Read the authorized business responsibility, current generation and platform task state version.',{actionId:s},['actionId']),
  descriptor('transfer_action','Transfer one canonical business responsibility; parallel review requires explicit intent. Return targets exactly the frozen predecessor. Never use multi_mention for reviews.',{
    idempotencyKey:s,subject:{type:'object',additionalProperties:true},predicate:{enum:['task_done','review_delivered']},family:{enum:['work','review']},successorSlot:s,
    targets:list,parallelIntent:s,operation:{enum:['transfer','replace','return','revision']},expectedGeneration:num},['idempotencyKey','subject','predicate','family','successorSlot','targets']),
  descriptor('complete_task','Commit a legitimate platform task transition for the current Action holder and exact task version; supply one published acceptance message per frozen criterion. Does not complete the Action.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,expectedTaskVersion:num,result:s,acceptanceMessageIds:list},['idempotencyKey','actionId','expectedGeneration','expectedTaskVersion','result','acceptanceMessageIds']),
  descriptor('publish_action_review','Compatibility delivery only for frozen pre-v33 review Actions. New responsibilities require submit_review with exact accepted source and author route. Does not post to GitHub or approve a gate.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,reviewedHeadSha:s,verdict:{enum:['approved','changes_requested','commented']},findings:list,body:s},
    ['idempotencyKey','actionId','expectedGeneration','reviewedHeadSha','verdict','findings','body']),
  descriptor('complete_action','Submit a completion candidate using server-issued domain evidence. The resolver rechecks current domain truth.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,evidenceId:s},['idempotencyKey','actionId','expectedGeneration','evidenceId']),
  descriptor('action_outcome','Report failure, cancellation, unavailable or rejected ownership; does not satisfy a completion predicate.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,outcome:{enum:['failed','cancelled','unavailable','rejected_ownership']},reason:s},['idempotencyKey','actionId','expectedGeneration','outcome','reason']),
  descriptor('run_command','Start only a server-registered command for this exact Action generation. An unknown result is never automatically restarted.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,command:s,args:{type:'object',additionalProperties:true}},['idempotencyKey','actionId','expectedGeneration','command','args']),
  descriptor('wait_command','Register a nonblocking command wait for the current Action generation.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,commandId:s},['idempotencyKey','actionId','expectedGeneration','commandId']),
  descriptor('cancel_command','Request cancellation of the exact registered command. Unconfirmed termination remains unknown; replacing a wait does not cancel a command.',{
    idempotencyKey:s,actionId:s,expectedGeneration:num,commandId:s},['idempotencyKey','actionId','expectedGeneration','commandId']),
];
THREADED_TOOLS.push(...THREADED_REVIEW_TOOLS,...THREADED_SOP_TOOLS,...THREADED_KNOWLEDGE_TOOLS);
const reviewNames=new Set(THREADED_REVIEW_TOOLS.map(t=>t.name)),sopNames=new Set(THREADED_SOP_TOOLS.map(t=>t.name)),knowledgeNames=new Set(THREADED_KNOWLEDGE_TOOLS.map(t=>t.name));
const refreshedReads=new Set([...REVIEW_READ_TOOLS,'read_sop','knowledge_read','knowledge_search','knowledge_recent','knowledge_anchor','knowledge_sources']);
export const THREADED_APPLICATION_TOOL_NAMES=THREADED_TOOLS.map(t=>t.name);
const nonSubstantive=new Set(['post_message','cross_post_message','multi_mention','multi_mention_status','hold_ball','track_event','conversation_decision','settle_decision','withdraw_decision','mark_seen','acknowledge_mentions']);
export function createThreadedTools(db:Database.Database,options:CollaborationOptions&{
  routing:ReturnType<typeof createThreadedRouting>;cooperation:ReturnType<typeof createThreadedCooperation>;
  context?:Pick<ReturnType<typeof createThreadedContext>,'markSeen'|'acknowledgeMentions'>;
  actions:ReturnType<typeof createThreadedActions>;
  commands:ReturnType<typeof createActionCommands>;
  reviews:ReturnType<typeof createThreadedReviews>;sop:ReturnType<typeof createThreadedSop>;knowledge:ReturnType<typeof createThreadedKnowledge>;
  prepareTracking?:(binding:ThreadedBinding,source:string,subject:string)=>Promise<{authorization:string}>;
}) {
  const {cooperation,routing}=options,now=options.now??Date.now;
  function allowed(binding:ThreadedBinding,selected:string[]) {
    const definition=db.prepare('SELECT definition FROM agents WHERE id=?').get(binding.agentId) as {definition:string};
    const names=(JSON.parse(definition.definition) as {tools:string[]}).tools;
    return THREADED_TOOLS.filter(t=>selected.includes(t.name)&&names.includes(t.name));
  }
  async function execute(binding:ThreadedBinding,name:string,value:unknown,requestKey:string,selected:string[]):Promise<string> {
    try {
      cooperation.running(binding,true);
      if(name==='request_user_input')reject('THREADED_REQUEST_USER_INPUT_RETIRED',410);
      const tool=allowed(binding,selected).find(t=>t.name===name);if(!tool)reject('THREADED_TOOL_NOT_ALLOWED',403);
      const input=object(value),props=object(tool.parameters.properties);
      if(Object.keys(input).some(k=>!Object.hasOwn(props,k))||(tool.parameters.required as string[]).some(k=>input[k]===undefined))reject('THREADED_TOOL_INPUT_INVALID',400);
      const key=text(input.idempotencyKey??requestKey), fingerprint=digest({name,input});
      if(['run_command','wait_command','cancel_command'].includes(name))return JSON.stringify({ok:true,result:await options.commands.execute(binding,name,input)});
      const existingReceipt=db.prepare('SELECT 1 FROM threaded_tool_receipts WHERE binding_id=? AND request_key=?').get(binding.id,key);
      const refresh=refreshedReads.has(name);
      const actionPrepared=existingReceipt||reviewNames.has(name)||sopNames.has(name)||knowledgeNames.has(name)?undefined:await options.actions.prepare(binding,name,input);
      const reviewPrepared=reviewNames.has(name)&&(!existingReceipt||refresh)?await options.reviews.prepare(binding,name,input):undefined;
      const tracking=name==='track_event'?await options.prepareTracking?.(binding,text(input.source),text(input.subject)):undefined;
      if(name==='track_event'&&!tracking)reject('THREADED_TRACKING_SOURCE_NOT_AUTHORIZED',403);
      const scope={ownerId:binding.ownerId,threadId:binding.threadId,viewer:{kind:'agent' as const,agentId:binding.agentId}};
      const cutoff=(db.prepare('SELECT input_max_seq FROM threaded_invocation_wakes WHERE invocation_id=?').get(binding.invocationId) as {input_max_seq:number}).input_max_seq;
      const readIds=new Set<string>();
      const read=(id:string)=>{const m=options.messages.getMessage(scope,id);if(!m||m.seq>cutoff)reject('THREADED_TOOL_SOURCE_FORBIDDEN',403);readIds.add(id);return m;};
      const expose=(ids:string[])=>{for(const id of ids)readIds.add(id);if(!readIds.size)return;
        const manifest=db.prepare('SELECT session_id,session_version FROM threaded_context_manifests WHERE binding_id=? ORDER BY rowid DESC LIMIT 1').get(binding.id) as {session_id:string;session_version:number}|undefined;
        if(!manifest)reject('THREADED_TOOL_CONTEXT_REQUIRED');
        for(const id of readIds)db.prepare('INSERT OR IGNORE INTO threaded_tool_context_exposures VALUES(?,?,?,?,?,?)').run(binding.id,key,id,manifest.session_id,manifest.session_version,now());};
      const privacy=(result:unknown)=>reviewNames.has(name)?options.reviews.privacySources(binding,name,input,result):sopNames.has(name)?options.sop.privacySources(binding,name,input,result):knowledgeNames.has(name)?options.knowledge.privacySources(binding,name,input,result):options.actions.privacySources(binding,name,input,result);
      const result=cooperation.transaction(()=>{
        cooperation.running(binding,true);
        const prior=db.prepare('SELECT name,request_hash,record FROM threaded_tool_receipts WHERE binding_id=? AND request_key=?').get(binding.id,key) as {name:string;request_hash:string;record:string}|undefined;
        if(prior){if(prior.request_hash!==fingerprint||prior.name!==name)reject('THREADED_TOOL_IDEMPOTENCY_CONFLICT');
          const result=JSON.parse(prior.record) as {result:unknown;readSourceIds:string[];privacySourceIds?:string[]};for(const id of result.readSourceIds)read(id);
          for(const id of result.privacySourceIds??[])options.actions.assertReadable(binding,id);
          if(!refresh){const replay=sopNames.has(name)?options.sop.refreshResult(binding,name,input,result.result):result.result;expose(privacy(replay));return replay;}}
        if(name!=='read_action'&&!refreshedReads.has(name))options.actions.assertBinding(binding);
        let result:unknown;
        if(name==='read_message')result=read(text(input.messageId));
        else if(name==='search_messages'){
          const rows=options.messages.searchMessages(scope,{query:text(input.query,1000),afterSeq:input.afterSeq===undefined?0:integer(input.afterSeq,0,cutoff),limit:input.limit===undefined?50:integer(input.limit,1,200)}).filter(m=>m.seq<=cutoff);
          for(const row of rows)readIds.add(row.id);result=rows;
        }else if(name==='message_sources'){
          const m=read(text(input.messageId)),sources=options.messages.getSources(scope,m.id);if(!sources)reject('THREADED_TOOL_SOURCE_FORBIDDEN',403);
          // Cross-Thread provenance requires a separate current-Thread authorized anchor; do not expose its body here.
          result=sources.map(m=>m.threadId===binding.threadId?read(m.id):{id:m.id,threadId:m.threadId,bodyExpanded:false});
        }else if(name==='read_attachment'){
          const found=options.messages.getAttachment(scope,text(input.attachmentId));if(!found)reject('THREADED_TOOL_SOURCE_FORBIDDEN',403);
          const row=db.prepare('SELECT message_id FROM threaded_message_attachments WHERE id=?').get(input.attachmentId) as {message_id:string};read(row.message_id);
          const offset=input.offset===undefined?0:integer(input.offset,0,found.content.length),length=input.length===undefined?Math.min(65536,found.content.length-offset):integer(input.length,0,65536);
          if(offset+length>found.content.length)reject('THREADED_TOOL_INPUT_INVALID',400);
          result={attachment:found.attachment,offset,length,contentBase64:found.content.subarray(offset,offset+length).toString('base64')};
        }else if(name==='post_message'||name==='cross_post_message'){
          const body=text(input.body,1_048_576),sourceRefs=input.sourceRefs===undefined?[]:strings(input.sourceRefs);for(const id of sourceRefs)read(id);
          const boundary=cooperation.boundary(binding,sourceRefs),payload={body,...boundary,
            ...(input.targets===undefined?{}:{targets:strings(input.targets)})};
          if(input.visibility!==undefined&&input.visibility!==boundary.visibility)reject('THREADED_TOOL_VISIBILITY_CONFLICT',403);
          if(input.audience!==undefined&&digest(strings(input.audience).sort())!==digest([...boundary.audience].sort()))reject('THREADED_TOOL_VISIBILITY_CONFLICT',403);
          if(name==='cross_post_message'){
            const threadId=text(input.threadId),targets=strings(input.targets);if(threadId===binding.threadId||!targets.length)reject('THREADED_CROSS_POST_TARGET_REQUIRED');
            result=options.messages.postAgentMessageWithinTransaction({...payload,targets,binding,toolCallId:`tool:${key}`,threadId});
          }else result=routing.postWithin(binding,`tool:${key}`,payload);
          options.actions.bindMessage((result as import('@agent-gand/shared').ThreadedMessageReceipt).message.id,options.actions.capture(binding));
        }else if(name==='multi_mention')result=cooperation.consultWithin(binding,key,{
          targets:strings(input.targets,3),question:text(input.question,5000),callbackTo:text(input.callbackTo),
          ...(input.timeoutMinutes===undefined?{}:{timeoutMinutes:integer(input.timeoutMinutes,3,20)}),
          ...(input.context===undefined?{}:{context:text(input.context,5000)}),
          ...(input.searchEvidenceRefs===undefined?{}:{searchEvidenceRefs:strings(input.searchEvidenceRefs)}),
          ...(input.overrideReason===undefined?{}:{overrideReason:text(input.overrideReason,500)})});
        else if(name==='multi_mention_status')result=cooperation.consultationStatus(binding,text(input.groupId));
        else if(name==='mark_seen'||name==='acknowledge_mentions'){
          const ids=strings(input.messageIds);for(const id of ids)read(id);
          if(!options.context)reject('THREADED_CONTEXT_PORT_REQUIRED');
          if(name==='mark_seen')options.context!.markSeen(binding,ids,key);else options.context!.acknowledgeMentions(binding,ids,key);
          result={recorded:true};
        }else if(name==='hold_ball'||name==='track_event'||name==='conversation_decision'){
          if(name==='hold_ball')text(input.waitSourceRef,500);
          result=cooperation.registerWaitWithin(binding,{jobKey:text(input.jobKey),kind:name==='hold_ball'?'timer':name==='track_event'?'tracking':'decision',
            ...(name==='hold_ball'?{seconds:integer(input.seconds,5,3600),waitSourceRef:text(input.waitSourceRef,500)}:{}),
            ...(name==='track_event'?{source:text(input.source),subject:text(input.subject),match:object(input.match),trackingAuthorization:tracking!.authorization}:{}),
            ...(name==='conversation_decision'?{question:text(input.question,5000),once:input.once===true,block:text(input.block)}:{}),
            ...(input.replaceWaitId===undefined?{}:{replaceWaitId:text(input.replaceWaitId),expectedVersion:integer(input.expectedVersion,1,1_000_000)})});
        }else if(name==='settle_decision'||name==='withdraw_decision')result=cooperation.decisionOperationWithin(binding,{
          waitId:text(input.waitId),operationId:text(input.operationId),expectedVersion:integer(input.expectedVersion,1,1_000_000),
          operation:name==='settle_decision'?'settle':'withdraw',...(name==='settle_decision'?{responseMessageId:text(input.responseMessageId)}:{})});
        else if(reviewNames.has(name))result=options.reviews.executeWithin(binding,name,input,reviewPrepared);
        else if(sopNames.has(name))result=options.sop.executeWithin(binding,name,input);
        else if(knowledgeNames.has(name))result=options.knowledge.executeWithin(binding,name,input);
        else result=options.actions.executeWithin(binding,name,input,actionPrepared);
        const privacySourceIds=privacy(result);
        if(!prior)db.prepare('INSERT INTO threaded_tool_receipts VALUES(?,?,?,?,?,?,?)').run(binding.id,key,name,fingerprint,
          JSON.stringify({result,readSourceIds:[...readIds],privacySourceIds}),nonSubstantive.has(name)?0:1,now());
        expose(privacySourceIds);
        return result;
      });
      return JSON.stringify({ok:true,result});
    }catch(error){if(error instanceof ThreadedCollaborationError||error instanceof ThreadedMessageError||error instanceof ThreadedMessageAclError||error instanceof ThreadedContextError)
      return JSON.stringify({ok:false,code:error.code,status:error.status,committed:false});throw error;}
  }
  return {allowed,execute};
}
