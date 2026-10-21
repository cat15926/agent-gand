import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding, ThreadedMessageRecord } from '@agent-gand/shared';
import type { BackendTool } from './backends/types.ts';
import type { createThreadedCooperation } from './cooperation.ts';
import type { ThreadedMessageViewer } from './acl.ts';
import { createThreadedMessageAcl } from './acl.ts';
import { digest, integer, object, reject, text, type CollaborationOptions } from './collaborationTypes.ts';

const s={type:'string'},num={type:'integer'},collection={enum:['home']};
const descriptor=(name:string,description:string,properties:Record<string,unknown>,required:string[]):BackendTool=>({name,description,
  parameters:{type:'object',properties:{...properties,collection},required,additionalProperties:false}});
const anchorSchema={type:'object',properties:{kind:{enum:['message','invocation']},id:s},required:['kind','id'],additionalProperties:false};
export const THREADED_KNOWLEDGE_TOOLS:BackendTool[]=[
  descriptor('knowledge_publish','Publish an immutable knowledge version in the server-selected home Thread collection. Sources restrict all derived content; this grants no business completion.',
    {idempotencyKey:s,title:s,body:s,anchors:{type:'array',items:anchorSchema,minItems:1,maxItems:20},knowledgeId:s,expectedVersion:num,expiresAt:num},['idempotencyKey','title','body','anchors']),
  descriptor('knowledge_read','Read an exact immutable knowledge version, its authoritative source IDs and current expiry/replacement metadata.',{knowledgeId:s,version:num},['knowledgeId']),
  descriptor('knowledge_search','Literal substring search over authorized home Thread knowledge. This is not semantic retrieval.',{query:s,limit:num},['query']),
  descriptor('knowledge_recent','Read recent authorized published home Thread events with exact anchors. Cursor is server-issued and actor/authority bound.',{limit:num,cursor:s},[]),
  descriptor('knowledge_anchor','Expand one exact published message or the authorized published messages of one Invocation. Native transcripts are never read.',{kind:{enum:['message','invocation']},id:s},['kind','id']),
  descriptor('knowledge_sources','Expand every authorized authoritative message source of an immutable knowledge version.',{knowledgeId:s,version:num},['knowledgeId']),
  descriptor('knowledge_mark','Append an immutable expired or superseded version using expectedVersion CAS; retain history and all source restrictions.',
    {idempotencyKey:s,knowledgeId:s,expectedVersion:num,status:{enum:['expired','superseded']},replacementId:s,reason:s},['idempotencyKey','knowledgeId','expectedVersion','status','reason']),
];
type Anchor={kind:'message'|'invocation';id:string};
type Item={id:string;owner_id:string;thread_id:string;version:number;created_at:number;updated_at:number};
type Version={knowledgeId:string;version:number;title:string;body:string;anchors:Anchor[];sourceMessageIds:string[];
  status:'active'|'expired'|'superseded';replacementId:string|null;reason:string|null;expiresAt:number|null;
  createdBy:string;createdAt:number;bindingId:string};
type Reader={ownerId:string;threadId:string;viewer:ThreadedMessageViewer};

/** Owner UI projection is read-only and does not construct an execution authority or cooperation service. */
export function threadedKnowledgeOwnerSnapshot(db:Database.Database,ownerId:string,threadId:string,clock:()=>number=Date.now) {
  const authorized=db.prepare(`SELECT 1 FROM threaded_threads t JOIN threaded_instances i ON i.instance_owner_id=t.owner_id AND i.singleton=1
    WHERE t.owner_id=? AND t.id=? AND t.mode='threaded'`).get(ownerId,threadId);
  if(!authorized)reject('THREADED_KNOWLEDGE_NOT_FOUND',404);
  const acl=createThreadedMessageAcl(db);
  const items=(db.prepare('SELECT * FROM threaded_knowledge WHERE owner_id=? AND thread_id=? ORDER BY updated_at DESC,id')
    .all(ownerId,threadId) as Item[]).flatMap(item=>{
      const v=JSON.parse((db.prepare('SELECT record FROM threaded_knowledge_versions WHERE knowledge_id=? AND version=?').get(item.id,item.version) as {record:string}).record) as Version;
      const allowed=v.sourceMessageIds.length>0&&v.sourceMessageIds.every(id=>{
        const stored=db.prepare('SELECT record FROM threaded_messages WHERE id=? AND owner_id=?').get(id,ownerId) as {record:string}|undefined;
        if(!stored)return false;const message=JSON.parse(stored.record) as ThreadedMessageRecord;
        return message.state==='published'&&acl.canRead({ownerId,threadId:message.threadId,viewer:{kind:'owner'}},message);
      });
      if(!allowed)return [];
      const status=v.status==='active'&&v.expiresAt!==null&&v.expiresAt<=clock()?'expired' as const:v.status;
      return [{...v,collection:'home' as const,latestVersion:item.version,isCurrent:true,privacySourceIds:v.sourceMessageIds,
        status,currentStatus:status,currentReplacementId:v.replacementId}];
    });
  return {collection:'home' as const,retrieval:'literal_substring' as const,items};
}

/** Every entry point uses durable Binding identity; models cannot choose owners, private collections or viewers. */
export function createThreadedKnowledge(db:Database.Database,options:CollaborationOptions&{cooperation:ReturnType<typeof createThreadedCooperation>}) {
  const {cooperation:c}=options,now=options.now??Date.now;
  const row=(id:string)=>db.prepare('SELECT * FROM threaded_knowledge WHERE id=?').get(id) as Item|undefined;
  const reader=(b:ThreadedBinding):Reader=>({ownerId:b.ownerId,threadId:b.threadId,viewer:{kind:'agent',agentId:b.agentId}});
  function cutoff(b:ThreadedBinding) {
    const v=db.prepare('SELECT input_max_seq FROM threaded_invocation_wakes WHERE invocation_id=? AND owner_id=? AND thread_id=? AND agent_id=?')
      .get(b.invocationId,b.ownerId,b.threadId,b.agentId) as {input_max_seq:number}|undefined;
    return v?.input_max_seq??reject('THREADED_KNOWLEDGE_BINDING_REQUIRED',403);
  }
  function source(scope:Reader,id:string):ThreadedMessageRecord|null {
    const r=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,scope.ownerId) as {thread_id:string}|undefined;
    const m=r&&options.messages.getMessage({...scope,threadId:r.thread_id},id);
    return m?.state==='published'?m:null;
  }
  function available(b:ThreadedBinding,id:string):ThreadedMessageRecord|null {
    const m=source(reader(b),id);
    // Current Invocation publications are exact new sources; arbitrary later messages are outside frozen input.
    return m&&(m.threadId!==b.threadId||m.seq<=cutoff(b)||m.sourceAttemptId===b.attemptId)?m:null;
  }
  function expandSources(b:ThreadedBinding,ids:string[]):ThreadedMessageRecord[] {
    const found=new Map<string,ThreadedMessageRecord>();
    const visit=(id:string,depth:number)=>{if(found.has(id))return;if(depth>32||found.size>=1000)reject('THREADED_KNOWLEDGE_SOURCE_LIMIT',400);
      const m=available(b,id);if(!m)reject('THREADED_KNOWLEDGE_SOURCE_FORBIDDEN',403);found.set(id,m);
      for(const ref of m.sourceRefs)visit(ref,depth+1);};
    ids.forEach(id=>visit(id,0));return [...found.values()];
  }
  function anchor(b:ThreadedBinding,value:unknown) {
    const a=object(value);if(Object.keys(a).some(k=>!['kind','id'].includes(k)))reject('THREADED_TOOL_INPUT_INVALID',400);
    const id=text(a.id);let messages:ThreadedMessageRecord[],invocation:Record<string,unknown>|undefined;
    if(a.kind==='message') {const m=available(b,id);if(!m||m.threadId!==b.threadId)reject('THREADED_KNOWLEDGE_SOURCE_FORBIDDEN',403);messages=[m];}
    else if(a.kind==='invocation') {
      const inv=db.prepare('SELECT id,agent_id,status,created_at,updated_at FROM threaded_invocations WHERE id=? AND owner_id=? AND thread_id=?')
        .get(id,b.ownerId,b.threadId) as {id:string;agent_id:string;status:string;created_at:string;updated_at:string}|undefined;
      if(!inv)reject('THREADED_KNOWLEDGE_SOURCE_FORBIDDEN',403);
      // Only platform-published messages are conversation expansion. No backend events, session IDs, or transcript cursors.
      messages=(db.prepare("SELECT id FROM threaded_messages WHERE source_invocation_id=? AND owner_id=? AND thread_id=? AND state='published' ORDER BY seq")
        .all(id,b.ownerId,b.threadId) as Array<{id:string}>).flatMap(v=>{const m=available(b,v.id);return m?[m]:[];});
      if(!messages.length)reject('THREADED_KNOWLEDGE_SOURCE_FORBIDDEN',403);
      invocation={id:inv.id,agentId:inv.agent_id,status:inv.status,createdAt:inv.created_at,updatedAt:inv.updated_at};
    } else return reject('THREADED_TOOL_INPUT_INVALID',400);
    const sources=expandSources(b,messages.map(m=>m.id));
    return {anchor:{kind:a.kind as Anchor['kind'],id},...(invocation?{invocation}:{}),messages,sourceMessageIds:sources.map(m=>m.id)};
  }
  function stored(item:Item,version=item.version):Version {
    const v=db.prepare('SELECT record FROM threaded_knowledge_versions WHERE knowledge_id=? AND version=?').get(item.id,version) as {record:string}|undefined;
    return v?JSON.parse(v.record) as Version:reject('THREADED_KNOWLEDGE_NOT_FOUND',404);
  }
  function readable(scope:Reader,v:Version):boolean {return v.sourceMessageIds.length>0&&v.sourceMessageIds.every(id=>!!source(scope,id));}
  function scoped(b:ThreadedBinding,id:string,version?:number) {
    const item=row(id);if(!item||item.owner_id!==b.ownerId||item.thread_id!==b.threadId)reject('THREADED_KNOWLEDGE_NOT_FOUND',404);
    const value=stored(item,version),current=stored(item);
    // Current replacement/expiry metadata is derived too. Historical reads must not reveal a later private replacement.
    if(!readable(reader(b),value)||!readable(reader(b),current)||![...value.sourceMessageIds,...current.sourceMessageIds].every(id=>available(b,id)))reject('THREADED_KNOWLEDGE_SOURCE_FORBIDDEN',403);
    return {item,value};
  }
  function projection(item:Item,v:Version) {
    const current=stored(item),expired=v.expiresAt!==null&&v.expiresAt<=now();
    return {...v,collection:'home' as const,latestVersion:item.version,isCurrent:v.version===item.version,
      privacySourceIds:[...new Set([...v.sourceMessageIds,...current.sourceMessageIds])],
      status:v.status==='active'&&expired?'expired' as const:v.status,
      currentStatus:current.status==='active'&&current.expiresAt!==null&&current.expiresAt<=now()?'expired':current.status,
      currentReplacementId:current.replacementId};
  }
  function append(b:ThreadedBinding,item:Item|undefined,v:Version,kind:string) {
    if(!item)db.prepare('INSERT INTO threaded_knowledge VALUES(?,?,?,?,?,?)').run(v.knowledgeId,b.ownerId,b.threadId,1,v.createdAt,v.createdAt);
    else {const changed=db.prepare('UPDATE threaded_knowledge SET version=version+1,updated_at=? WHERE id=? AND version=?').run(v.createdAt,item.id,item.version);
      if(changed.changes!==1)reject('THREADED_KNOWLEDGE_VERSION_CONFLICT');}
    db.prepare('INSERT INTO threaded_knowledge_versions VALUES(?,?,?,?)').run(v.knowledgeId,v.version,JSON.stringify(v),v.createdAt);
    db.prepare('INSERT INTO threaded_knowledge_events(knowledge_id,version,binding_id,kind,created_at) VALUES(?,?,?,?,?)')
      .run(v.knowledgeId,v.version,b.id,kind,v.createdAt);
    return projection(row(v.knowledgeId)!,v);
  }
  function mutate(b:ThreadedBinding,name:string,input:Record<string,unknown>) {
    if(!db.inTransaction)reject('THREADED_KNOWLEDGE_TRANSACTION_REQUIRED');
    const key=text(input.idempotencyKey),fingerprint=digest({name,input});
    const previous=db.prepare('SELECT request_hash,record FROM threaded_knowledge_operations WHERE binding_id=? AND request_key=?').get(b.id,key) as {request_hash:string;record:string}|undefined;
    if(previous){if(previous.request_hash!==fingerprint)reject('THREADED_KNOWLEDGE_IDEMPOTENCY_CONFLICT');
      const result=JSON.parse(previous.record) as Version;scoped(b,result.knowledgeId,result.version);return result;}
    let result:ReturnType<typeof projection>;
    if(name==='knowledge_publish') {
      const title=text(input.title,500),body=text(input.body,32_000);
      if(!Array.isArray(input.anchors)||input.anchors.length<1||input.anchors.length>20)reject('THREADED_TOOL_INPUT_INVALID',400);
      const expanded=input.anchors.map(v=>anchor(b,v));let item:Item|undefined,prior:Version|undefined;
      if(input.knowledgeId!==undefined){const found=scoped(b,text(input.knowledgeId));item=found.item;prior=found.value;
        if(item.version!==integer(input.expectedVersion,1,1e9))reject('THREADED_KNOWLEDGE_VERSION_CONFLICT');}
      else if(input.expectedVersion!==undefined)reject('THREADED_TOOL_INPUT_INVALID',400);
      const expiresAt=input.expiresAt===undefined?null:integer(input.expiresAt,now()+1,Number.MAX_SAFE_INTEGER);
      const scope=c.boundary(b,[...expanded.flatMap(v=>v.sourceMessageIds),...(prior?.sourceMessageIds??[])]);
      const sourceMessageIds=expandSources(b,scope.sourceRefs).map(m=>m.id);
      result=append(b,item,{knowledgeId:item?.id??randomUUID(),version:(item?.version??0)+1,title,body,
        anchors:expanded.map(v=>v.anchor),sourceMessageIds,status:'active',replacementId:null,reason:null,expiresAt,
        createdBy:b.agentId,createdAt:now(),bindingId:b.id},'published');
    } else {
      const found=scoped(b,text(input.knowledgeId)),{item,value}=found;
      if(item.version!==integer(input.expectedVersion,1,1e9))reject('THREADED_KNOWLEDGE_VERSION_CONFLICT');
      if(input.status!=='expired'&&input.status!=='superseded')reject('THREADED_TOOL_INPUT_INVALID',400);
      const reason=text(input.reason,2000);let replacementId:string|null=null,extra:string[]=[];
      if(input.status==='superseded') {replacementId=text(input.replacementId);if(replacementId===item.id)reject('THREADED_KNOWLEDGE_REPLACEMENT_INVALID',400);
        const replacement=scoped(b,replacementId);if(projection(replacement.item,replacement.value).status!=='active')reject('THREADED_KNOWLEDGE_REPLACEMENT_INVALID');
        extra=replacement.value.sourceMessageIds;}
      else if(input.replacementId!==undefined)reject('THREADED_TOOL_INPUT_INVALID',400);
      const scope=c.boundary(b,[...value.sourceMessageIds,...extra]);
      result=append(b,item,{...value,version:item.version+1,status:input.status,replacementId,reason,
        sourceMessageIds:expandSources(b,scope.sourceRefs).map(m=>m.id),createdBy:b.agentId,createdAt:now(),bindingId:b.id},input.status);
    }
    db.prepare('INSERT INTO threaded_knowledge_operations VALUES(?,?,?,?)').run(b.id,key,fingerprint,JSON.stringify(result));return result;
  }
  function recent(b:ThreadedBinding,input:Record<string,unknown>) {
    const limit=input.limit===undefined?20:integer(input.limit,1,100);let last=0,max=cutoff(b);
    if(input.cursor!==undefined) {
      const v=db.prepare('SELECT * FROM threaded_knowledge_cursors WHERE id=?').get(text(input.cursor)) as
        {owner_id:string;thread_id:string;agent_id:string;authority_identity:string;cutoff:number;last_seq:number;expires_at:number}|undefined;
      if(!v||v.owner_id!==b.ownerId||v.thread_id!==b.threadId||v.agent_id!==b.agentId||v.authority_identity!==c.identity(b)||v.expires_at<=now()||v.cutoff>max)
        reject('THREADED_KNOWLEDGE_CURSOR_FORBIDDEN',403);
      last=v.last_seq;max=v.cutoff;
    }
    const visible:ThreadedMessageRecord[]=[];
    for(const r of db.prepare("SELECT id FROM threaded_messages WHERE owner_id=? AND thread_id=? AND seq>? AND seq<=? AND state='published' ORDER BY seq DESC")
      .iterate(b.ownerId,b.threadId,last,max) as Iterable<{id:string}>) {const m=available(b,r.id);if(m)visible.push(m);if(visible.length>limit)break;}
    const page=visible.slice(0,limit);let nextCursor:string|null=null;
    // Descending bounded windows avoid exposing hidden-row offsets or reordering after concurrent publication.
    if(visible.length>limit&&page.length) {nextCursor=randomUUID();db.prepare('INSERT INTO threaded_knowledge_cursors VALUES(?,?,?,?,?,?,?,?)')
      .run(nextCursor,b.ownerId,b.threadId,b.agentId,c.identity(b),page.at(-1)!.seq-1,0,now()+900_000);}
    return {collection:'home',events:page.map(m=>({anchor:{kind:'message',id:m.id},message:m,
      sourceMessageIds:expandSources(b,[m.id]).map(s=>s.id)})),nextCursor,sourceMessageIds:[...new Set(page.flatMap(m=>expandSources(b,[m.id]).map(s=>s.id)))]};
  }
  function executeWithin(binding:ThreadedBinding,name:string,value:unknown):unknown {
    c.running(binding,name!=='knowledge_publish'&&name!=='knowledge_mark');if(!db.inTransaction)reject('THREADED_KNOWLEDGE_TRANSACTION_REQUIRED');
    const input=object(value),tool=THREADED_KNOWLEDGE_TOOLS.find(t=>t.name===name);if(!tool)reject('THREADED_TOOL_NOT_ALLOWED',403);
    const props=object(tool.parameters.properties);if(Object.keys(input).some(k=>!Object.hasOwn(props,k))||
      (tool.parameters.required as string[]).some(k=>input[k]===undefined)||input.collection!==undefined&&input.collection!=='home')reject('THREADED_KNOWLEDGE_SCOPE_FORBIDDEN',403);
    if(name==='knowledge_publish'||name==='knowledge_mark')return mutate(binding,name,input);
    if(name==='knowledge_anchor')return anchor(binding,{kind:input.kind,id:input.id});
    if(name==='knowledge_recent')return recent(binding,input);
    if(name==='knowledge_search') {
      const query=text(input.query,1000).toLocaleLowerCase(),limit=input.limit===undefined?20:integer(input.limit,1,100),items:ReturnType<typeof projection>[]=[];
      for(const item of db.prepare('SELECT * FROM threaded_knowledge WHERE owner_id=? AND thread_id=? ORDER BY updated_at DESC,id').iterate(binding.ownerId,binding.threadId) as Iterable<Item>) {
        const v=stored(item);if(!readable(reader(binding),v)||!v.sourceMessageIds.every(id=>available(binding,id)))continue;
        if(`${v.title}\n${v.body}`.toLocaleLowerCase().includes(query))items.push(projection(item,v));if(items.length===limit)break;
      }
      return {collection:'home',retrieval:'literal_substring',items,sourceMessageIds:[...new Set(items.flatMap(v=>v.sourceMessageIds))]};
    }
    const {item,value:v}=scoped(binding,text(input.knowledgeId),input.version===undefined?undefined:integer(input.version,1,1e9));
    if(name==='knowledge_sources')return {knowledgeId:item.id,version:v.version,anchors:v.anchors,
      sources:expandSources(binding,v.sourceMessageIds),sourceMessageIds:v.sourceMessageIds};
    return projection(item,v);
  }
  function privacySources(binding:ThreadedBinding,name:string,_input:unknown,result:unknown):string[] {
    if(!THREADED_KNOWLEDGE_TOOLS.some(t=>t.name===name))return [];
    const value=object(result),ids=value.sourceMessageIds;
    if(!Array.isArray(ids)||!ids.every(v=>typeof v==='string'))reject('THREADED_KNOWLEDGE_SOURCE_REQUIRED',403);
    const inherited=Array.isArray(value.privacySourceIds)?value.privacySourceIds as string[]:[];
    return expandSources(binding,[...ids as string[],...inherited]).map(m=>m.id);
  }
  function snapshot(ownerId:string,threadId:string) {
    return threadedKnowledgeOwnerSnapshot(db,ownerId,threadId,now);
  }
  return {executeWithin,privacySources,snapshot};
}
