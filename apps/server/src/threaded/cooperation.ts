import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ThreadedBinding, ThreadedMessageRecord, ThreadedMessageReceipt } from '@agent-gand/shared';
import { createThreadedMessages } from './messages.ts';
import { digest, reject, text, strings, integer, type CollaborationOptions, type CollaborationTerminal } from './collaborationTypes.ts';
import type {ActionFence} from './actionTypes.ts';
import {classifyThreadedTimerRecovery,parseThreadedWaitSource,type ThreadedWaitSourceRef,type ThreadedWaitSourceAuthority} from './waitContracts.ts';

type Group = {id:string;owner_id:string;thread_id:string;binding_id:string;caller_id:string;parent_invocation_id:string;
  root_id:string;request_hash:string;callback_to:string;deadline:number;state:string;version:number;record:string;created_at:number};
type Wait = {id:string;owner_id:string;thread_id:string;agent_id:string;binding_id:string;parent_invocation_id:string;root_id:string;
  job_key:string;kind:'timer'|'tracking'|'decision';request_hash:string;state:string;version:number;deadline:number|null;record:string;
  outcome:string|null;created_at:number;updated_at:number};
type Scope = {ownerId:string;threadId:string;agentId:string};
export function createThreadedCooperation(db:Database.Database,options:CollaborationOptions&{actionScope?:{
  capture:(binding:ThreadedBinding)=>ActionFence|null;valid:(fence:ActionFence,agent:string)=>boolean;
  bindMessage:(messageId:string,fence:ActionFence|null)=>void;assertBinding:(binding:ThreadedBinding)=>void;
};trackingAuthorization?:(scope:Scope,source:string,subject:string)=>string|null;
  commandAuthorization?:(scope:Scope,sourceId:string)=>boolean}) {
  const now=options.now??Date.now;
  // Capture only timers already missed when this factory starts. Ordinary online recovery,
  // terminal notifications, and timers restored before their deadline retain one-shot semantics.
  const startupAt=now(),missedTimerIds=new Set((db.prepare("SELECT id FROM threaded_waits WHERE kind='timer' AND state='awaiting' AND deadline<=?")
    .all(startupAt) as Array<{id:string}>).map(row=>row.id));
  const messages=createThreadedMessages(db,{authority:options.authority,now,authorizeSystem:v=>v.systemKey==='threaded-collaboration-v1'});
  const notify=()=>{try{options.onCommitted?.();}catch{/* durable outbox owns recovery */}};
  function transaction<T>(action:()=>T):T {if(db.inTransaction)reject('THREADED_COLLABORATION_OUTERMOST_REQUIRED');
    const before=(db.prepare('SELECT total_changes() n').get() as {n:number}).n;
    const value=db.transaction(action).immediate();if((db.prepare('SELECT total_changes() n').get() as {n:number}).n!==before)notify();return value;}
  function source(binding:ThreadedBinding) {
    const row=db.prepare(`SELECT m.record FROM threaded_invocation_wakes q JOIN threaded_messages m ON m.id=q.source_message_id
      WHERE q.invocation_id=? AND m.owner_id=?`).get(binding.invocationId,binding.ownerId) as {record:string}|undefined;
    return row?JSON.parse(row.record) as ThreadedMessageRecord:reject('THREADED_COLLABORATION_SOURCE_REQUIRED');
  }
  function running(binding:ThreadedBinding,allowStale=false) {
    options.authority.assertAuthorized(binding);
    if(!allowStale)options.actionScope?.assertBinding(binding);
    if(!db.prepare("SELECT 1 FROM threaded_attempts WHERE id=? AND execution_stage='started' AND status='running'").get(binding.attemptId))reject('THREADED_COLLABORATION_ATTEMPT_REQUIRED');
    return source(binding);
  }
  function identity(scope:Scope):string|null {
    const m=db.prepare(`SELECT m.version,m.permission_version,m.role_version,m.account_version,m.status,a.version agent_version,a.enabled,a.definition
      FROM threaded_members m JOIN agents a ON a.id=m.agent_id JOIN threaded_threads t ON t.id=m.thread_id AND t.owner_id=m.owner_id
      JOIN threaded_instances i ON i.instance_owner_id=t.owner_id AND i.singleton=1
      WHERE m.owner_id=? AND m.thread_id=? AND m.agent_id=?`).get(scope.ownerId,scope.threadId,scope.agentId) as
      {status:string;enabled:number;role_version:number;agent_version:number;definition:string}|undefined;
    if(!m||m.status!=='joined'||m.enabled!==1||m.role_version!==m.agent_version)return null;
    const definition=JSON.parse(m.definition) as {accountRef?:string};
    const account=definition.accountRef?db.prepare(`SELECT id,enabled,archived,config_version,credential_version,identity_generation FROM accounts
      WHERE id=? AND enabled=1 AND archived=0 AND NOT EXISTS(SELECT 1 FROM account_revocations WHERE account_id=accounts.id)`).get(definition.accountRef):null;
    if(definition.accountRef&&!account)return null;
    return digest({m,account});
  }
  function frozen(binding:ThreadedBinding) {
    return {identity:identity(binding), sourceId:source(binding).id,
      actionFence:options.actionScope?.capture(binding)??null,
      controlSeq:(db.prepare('SELECT COALESCE(MAX(rowid),0) seq FROM threaded_control_requests WHERE owner_id=? AND thread_id=?').get(binding.ownerId,binding.threadId) as {seq:number}).seq};
  }
  function boundary(binding:ThreadedBinding,extra:string[]=[]):{visibility:'public'|'private';audience:string[];sourceRefs:string[]} {
    const original=source(binding), ids=new Set<string>([original.id,...extra]);
    const manifests=db.prepare(`SELECT id FROM threaded_context_manifests WHERE binding_id=?`).all(binding.id) as Array<{id:string}>;
    for(const m of manifests)for(const row of db.prepare(`SELECT message_id FROM threaded_context_manifest_items
      WHERE manifest_id=? AND decision='included'`).all(m.id) as Array<{message_id:string}>) {
      const message=options.messages.getMessage({ownerId:binding.ownerId,threadId:binding.threadId,viewer:{kind:'agent',agentId:binding.agentId}},row.message_id);
      if(message?.visibility==='private')ids.add(message.id);
    }
    for(const row of db.prepare(`SELECT a.record FROM threaded_session_anchors a JOIN threaded_session_input_intents i
      ON i.session_id=a.session_id AND i.session_version=a.session_version WHERE i.binding_id=?`).all(binding.id) as Array<{record:string}>) {
      const anchor=JSON.parse(row.record) as {sourceMessageIds:string[]};
      for(const id of anchor.sourceMessageIds){const m=options.messages.getMessage({ownerId:binding.ownerId,threadId:binding.threadId,viewer:{kind:'agent',agentId:binding.agentId}},id);if(m?.visibility==='private')ids.add(id);}
    }
    for(const row of db.prepare('SELECT record FROM threaded_tool_receipts WHERE binding_id=?').all(binding.id) as Array<{record:string}>) {
      const value=JSON.parse(row.record) as {readSourceIds?:string[];privacySourceIds?:string[]};for(const id of [...(value.readSourceIds??[]),...(value.privacySourceIds??[])])ids.add(id);
    }
    for(const row of db.prepare('SELECT message_id FROM threaded_tool_context_exposures WHERE binding_id=?').all(binding.id) as Array<{message_id:string}>)ids.add(row.message_id);
    let audience:string[]|undefined;
    for(const id of ids){const row=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=?').get(id) as {thread_id:string}|undefined;
      const m=row&&options.messages.getMessage({ownerId:binding.ownerId,threadId:row.thread_id,viewer:{kind:'agent',agentId:binding.agentId}},id);
      if(!m)reject('THREADED_COLLABORATION_SOURCE_FORBIDDEN',403);
      if(m.visibility==='private')audience=audience?audience.filter(id=>m.audience.includes(id)):[...m.audience];}
    return {visibility:audience?'private':'public',audience:audience??[],sourceRefs:[...ids]};
  }
  function groundWaitSource(scope:Scope,ref:ThreadedWaitSourceRef,cutoff?:number):ThreadedWaitSourceAuthority|null {
    const readable=(id:string)=>{const row=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,scope.ownerId) as {thread_id:string}|undefined;
      const m=row?options.messages.getMessage({ownerId:scope.ownerId,threadId:row.thread_id,viewer:{kind:'agent',agentId:scope.agentId}},id):null;
      return !!m&&(cutoff===undefined||m.seq<=cutoff&&m.threadId===scope.threadId);};
    let authorization:string,sourceMessageIds:string[];
    if(ref.kind==='thread_message'){
      if(!readable(ref.value))return null;
      const row=db.prepare('SELECT owner_id,thread_id,record FROM threaded_messages WHERE id=?').get(ref.value);
      authorization=digest({kind:ref.kind,row});sourceMessageIds=[ref.value];
    }else if(ref.kind==='task'){
      const task=db.prepare('SELECT task_id,owner_id,thread_id,creator_id,criteria_hash,source_record FROM threaded_task_ownership WHERE task_id=? AND owner_id=? AND thread_id=?')
        .get(ref.value,scope.ownerId,scope.threadId) as {source_record:string}|undefined;
      if(!task)return null;
      const sources=JSON.parse(task.source_record) as {sourceRefs:string[]};sourceMessageIds=sources.sourceRefs;
      authorization=digest({kind:ref.kind,task});
    }else if(ref.kind==='managed_command'){
      const command=db.prepare('SELECT id,owner_id,thread_id,agent_id,action_id,generation,port,authorization,source_record FROM threaded_commands WHERE id=? AND owner_id=? AND thread_id=? AND agent_id=?')
        .get(ref.value,scope.ownerId,scope.threadId,scope.agentId) as {action_id:string;generation:number;source_record:string}|undefined;
      if(!command||!options.commandAuthorization?.(scope,`command:${ref.value}`)||
        !options.actionScope?.valid({actionId:command.action_id,generation:command.generation},scope.agentId))return null;
      sourceMessageIds=(JSON.parse(command.source_record) as {sourceRefs:string[]}).sourceRefs;
      authorization=digest({kind:ref.kind,command});
    }else{
      // A URL or reporter handle supplied by a model is not source authority. An installed
      // server adapter must ground it, pin its identity and return its private message anchors.
      const trusted=options.waitSourceAuthorization?.(scope,ref);if(!trusted)return null;
      authorization=text(trusted.authorization,1000);sourceMessageIds=trusted.sourceMessageIds??[];
      if(ref.kind==='reporter_handle'&&(!ref.anchorRef||!sourceMessageIds.includes(ref.anchorRef)))return null;
    }
    if(!Array.isArray(sourceMessageIds)||sourceMessageIds.some(id=>typeof id!=='string'||!readable(id)))return null;
    return {authorization,sourceMessageIds:[...new Set(sourceMessageIds)].sort()};
  }
  function timerSourceAuthorized(wait:Wait) {
    try{const record=JSON.parse(wait.record) as {waitSourceRef:ThreadedWaitSourceRef;waitSourceAuthority?:ThreadedWaitSourceAuthority};
      const scope={ownerId:wait.owner_id,threadId:wait.thread_id,agentId:wait.agent_id};
      const current=groundWaitSource(scope,parseThreadedWaitSource(record.waitSourceRef));
      return !!record.waitSourceAuthority&&!!current&&digest(current)===digest(record.waitSourceAuthority);
    }catch{return false;}
  }
  function admitHoldWithin(binding:ThreadedBinding,input:{key:string;kind:'timer'|'command'}) {
    if(!db.inTransaction)reject('THREADED_HOLD_TRANSACTION_REQUIRED');
    running(binding);const key=text(input.key,500),prefix=input.kind==='timer'?'wait:':'command:';
    if(!key.startsWith(prefix)||key.length===prefix.length)reject('THREADED_HOLD_ADMISSION_INVALID',400);
    const prior=db.prepare('SELECT kind,source_id FROM threaded_hold_admissions WHERE owner_id=? AND thread_id=? AND agent_id=? AND admission_key=?')
      .get(binding.ownerId,binding.threadId,binding.agentId,key) as {kind:string;source_id:string}|undefined;
    if(prior){if(prior.kind!==input.kind||prior.source_id!==key.slice(prefix.length))reject('THREADED_HOLD_ADMISSION_CONFLICT');return;}
    const created=now(),quota=(db.prepare('SELECT COUNT(*) n FROM threaded_hold_admissions WHERE owner_id=? AND thread_id=? AND agent_id=? AND created_at>? AND created_at<=?')
      .get(binding.ownerId,binding.threadId,binding.agentId,created-3_600_000,created) as {n:number}).n;
    if(quota>=3)reject('THREADED_HOLD_QUOTA_EXCEEDED',429);
    db.prepare('INSERT INTO threaded_hold_admissions(owner_id,thread_id,agent_id,admission_key,kind,source_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(binding.ownerId,binding.threadId,binding.agentId,key,input.kind,key.slice(prefix.length),created);
  }
  function callback(kind:string,id:string,binding:ThreadedBinding,target:string,body:string,scope=boundary(binding),
    extra:{frozen?:ReturnType<typeof frozen>;route?:{targets:string[];record:Record<string,unknown>}}={}) {
    db.prepare(`INSERT OR IGNORE INTO threaded_collaboration_callbacks VALUES(?,?,?,?,?,?,?,'pending',NULL,?,NULL,?)`)
      .run(randomUUID(),kind,id,binding.ownerId,binding.threadId,target,binding.invocationId,
        JSON.stringify({body,...scope,frozen:extra.frozen??frozen(binding),...(extra.route?{route:extra.route}:{})}),now());
  }
  function callbackFromWait(wait:Wait,outcome:Record<string,unknown>) {
    const record=JSON.parse(wait.record) as {scope:ReturnType<typeof boundary>;frozen:ReturnType<typeof frozen>};
    const event=outcome.event as {messageId?:string}|undefined;
    const scope=wait.kind==='tracking'?{...record.scope,visibility:'private' as const,audience:[wait.agent_id],
      sourceRefs:[...new Set([...record.scope.sourceRefs,...(event?.messageId?[event.messageId]:[])])]}:record.scope;
    db.prepare(`INSERT OR IGNORE INTO threaded_collaboration_callbacks VALUES(?,?,?,?,?,?,?,'pending',NULL,?,NULL,?)`)
      .run(randomUUID(),'wait',wait.id,wait.owner_id,wait.thread_id,wait.agent_id,wait.parent_invocation_id,
        JSON.stringify({body:JSON.stringify({waitId:wait.id,kind:wait.kind,outcome}),...scope,frozen:record.frozen}),now());
  }
  function dispatchCallbacks() {
    for(const row of db.prepare("SELECT * FROM threaded_collaboration_callbacks WHERE state IN ('pending','waiting') ORDER BY created_at,id").all() as Array<{
      id:string;kind:string;source_id:string;owner_id:string;thread_id:string;agent_id:string;parent_invocation_id:string;record:string}>) {
      const scope={ownerId:row.owner_id,threadId:row.thread_id,agentId:row.agent_id};
      const input=JSON.parse(row.record) as ReturnType<typeof boundary>&{body:string;frozen:ReturnType<typeof frozen>;route?:{targets:string[];record:Record<string,unknown>}};
      const thread=db.prepare('SELECT state FROM threaded_threads WHERE owner_id=? AND id=?').get(row.owner_id,row.thread_id) as {state:string}|undefined;
      const controls=db.prepare(`SELECT action FROM threaded_control_requests WHERE owner_id=? AND thread_id=?
        AND (scope='thread' OR (scope='member' AND agent_id=?)) AND rowid>? AND status<>'rejected' ORDER BY rowid DESC`)
        .all(row.owner_id,row.thread_id,row.agent_id,input.frozen.controlSeq) as Array<{action:string}>;
      const control=controls[0];
      let state='pending',reason:string|null=null;
      const wait=row.kind==='wait'?db.prepare('SELECT * FROM threaded_waits WHERE id=? AND owner_id=? AND thread_id=? AND agent_id=?')
        .get(row.source_id,row.owner_id,row.thread_id,row.agent_id) as Wait|undefined:undefined;
      const timerRecord=wait?.kind==='timer'?JSON.parse(wait.record) as {waitSourceRef?:ThreadedWaitSourceRef}:undefined;
      const timerOutcome=wait?.kind==='timer'&&wait.outcome?JSON.parse(wait.outcome) as {recoveredMissedTimer?:boolean}:undefined;
      if(row.kind==='command'&&!options.commandAuthorization?.(scope,row.source_id)){state='rejected';reason='THREADED_COMMAND_AUTHORITY_CHANGED';}
      else if(row.kind==='wait'&&(!wait||wait.kind==='tracking'&&!trackingAuthorized(wait))){state='rejected';reason='THREADED_TRACKING_AUTHORITY_CHANGED';}
      else if(wait?.kind==='timer'&&!timerSourceAuthorized(wait)){state='rejected';reason='THREADED_WAIT_SOURCE_AUTHORITY_CHANGED';}
      else if(timerOutcome?.recoveredMissedTimer&&now()>=(timerRecord?.waitSourceRef?.slaUntilMs??0)){state='rejected';reason='THREADED_TIMER_RECOVERY_EXPIRED';}
      else if(input.frozen.actionFence&&!options.actionScope?.valid(input.frozen.actionFence,row.agent_id)){state='rejected';reason='THREADED_ACTION_STALE_GENERATION';}
      else if(!thread||['closed','archived'].includes(thread.state)||controls.some(c=>c.action==='cancel')){state='cancelled';reason='THREADED_CALLBACK_CLOSED';}
      else if(identity(scope)!==input.frozen.identity||!options.messages.getMessage({ownerId:row.owner_id,threadId:row.thread_id,viewer:{kind:'agent',agentId:row.agent_id}},input.frozen.sourceId)){state='rejected';reason='THREADED_CALLBACK_AUTHORITY_CHANGED';}
      else if(thread.state==='paused'||control?.action==='pause'){state='waiting';reason='THREADED_CALLBACK_PAUSED';}
      if(state==='pending')for(const id of input.sourceRefs){const source=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=?').get(id) as {thread_id:string}|undefined;
        if(!source||!options.messages.getMessage({ownerId:row.owner_id,threadId:source.thread_id,viewer:{kind:'agent',agentId:row.agent_id}},id)){
          state='rejected';reason='THREADED_CALLBACK_SOURCE_FORBIDDEN';break;}}
      if(state!=='pending'){db.prepare('UPDATE threaded_collaboration_callbacks SET state=?,reason=? WHERE id=? AND (state<>? OR reason IS NOT ?)').run(state,reason,row.id,state,reason);continue;}
      const receipt=messages.postSystemMessageWithinTransaction({ownerId:row.owner_id,threadId:row.thread_id,
        systemKey:'threaded-collaboration-v1',requestId:`callback:${row.id}`,causalParentInvocationId:row.parent_invocation_id,
        body:input.body,targets:[row.agent_id],visibility:input.visibility,audience:input.audience,sourceRefs:input.sourceRefs});
      options.actionScope?.bindMessage(receipt.message.id,input.frozen.actionFence??null);
      db.prepare("UPDATE threaded_collaboration_callbacks SET state='delivered',reason=NULL,message_id=? WHERE id=?").run(receipt.message.id,row.id);
      const previous=db.prepare(`SELECT r.* FROM threaded_relay_events r JOIN threaded_messages m ON m.id=r.message_id
        WHERE m.source_invocation_id=? AND m.origin='agent_response' ORDER BY m.seq DESC LIMIT 1`).get(row.parent_invocation_id) as
        {pair:string|null;streak:number;reset_seq:number;warning:number;blocked:number;record:string}|undefined
        ?? db.prepare(`SELECT r.* FROM threaded_relay_events r JOIN threaded_invocation_wakes q ON q.source_message_id=r.message_id
          WHERE q.invocation_id=?`).get(row.parent_invocation_id) as {pair:string|null;streak:number;reset_seq:number;warning:number;blocked:number;record:string}|undefined;
      const reset=(db.prepare("SELECT COALESCE(MAX(seq),0) seq FROM threaded_messages WHERE thread_id=? AND origin='user'").get(row.thread_id) as {seq:number}).seq;
      if(previous?.pair&&previous.reset_seq===reset&&(JSON.parse(previous.pair) as string[]).includes(row.agent_id))
        db.prepare('INSERT INTO threaded_relay_events VALUES(?,?,?,?,?,?,?,?,?)').run(receipt.message.id,receipt.message.causalRootId,row.thread_id,
          previous.reset_seq,previous.pair,previous.streak,previous.warning,0,previous.record);
      if(input.route)db.prepare("INSERT INTO threaded_message_routes VALUES(?,?,?,'serial_continuation','serial',?,?)")
        .run(receipt.message.id,row.owner_id,row.thread_id,JSON.stringify(input.route.targets),JSON.stringify(input.route.record));
    }
  }
  function settleGroup(group:Group,expired=false) {
    if(group.state!=='collecting')return;
    const targets=db.prepare('SELECT * FROM threaded_consultation_targets WHERE group_id=? ORDER BY agent_id').all(group.id) as Array<{
      agent_id:string;status:string;response_message_id:string|null}>;
    if(!expired&&targets.some(t=>t.status==='pending'))return;
    if(expired)db.prepare("UPDATE threaded_consultation_targets SET status='timeout' WHERE group_id=? AND status='pending'").run(group.id);
    const responses=targets.map(t=>({agentId:t.agent_id,status:t.status==='pending'?'timeout':t.status,
      responseMessageId:t.response_message_id,body:t.response_message_id?(db.prepare('SELECT body FROM threaded_messages WHERE id=?').get(t.response_message_id) as {body:string}).body:null}));
    const kind=responses.every(r=>r.status==='responded')?'complete':responses.some(r=>r.status==='responded')?'partial'
      :responses.some(r=>r.status==='failed'||r.status==='cancelled')?'failed':'timeout';
    const result={groupId:group.id,kind,responses};
    db.prepare('INSERT INTO threaded_consultation_settlements VALUES(?,?,?,?)').run(group.id,kind,JSON.stringify(result),now());
    db.prepare("UPDATE threaded_consultations SET state='settled',version=version+1 WHERE id=? AND state='collecting'").run(group.id);
    const config=JSON.parse(group.record) as {scope:ReturnType<typeof boundary>;frozen:ReturnType<typeof frozen>};
    let audience=config.scope.visibility==='private'?[...config.scope.audience]:undefined;
    for(const response of responses)if(response.responseMessageId){const m=JSON.parse((db.prepare('SELECT record FROM threaded_messages WHERE id=?').get(response.responseMessageId) as {record:string}).record) as ThreadedMessageRecord;
      if(m.visibility==='private')audience=audience?audience.filter(id=>m.audience.includes(id)):[...m.audience];}
    const callbackScope={...config.scope,...(audience?{visibility:'private' as const,audience}:{})};
    db.prepare(`INSERT INTO threaded_collaboration_callbacks VALUES(?,?,?,?,?,?,?,'pending',NULL,?,NULL,?)`)
      .run(randomUUID(),'consultation',group.id,group.owner_id,group.thread_id,group.callback_to,group.parent_invocation_id,
        JSON.stringify({body:JSON.stringify(result),...callbackScope,sourceRefs:[...new Set([...config.scope.sourceRefs,...responses.flatMap(r=>r.responseMessageId?[r.responseMessageId]:[])])],frozen:config.frozen}),now());
  }
  function consultWithin(binding:ThreadedBinding,key:string,input:{targets:string[];question:string;context?:string;callbackTo:string;timeoutMinutes?:number;searchEvidenceRefs?:string[];overrideReason?:string;action?:unknown},entry:'tool'|'http'='tool') {
    running(binding);text(key);text(input.question,5000);const targets=strings(input.targets,3);
    if(!targets.length||targets.includes(binding.agentId)||input.callbackTo!==binding.agentId)reject('THREADED_CONSULTATION_TARGET_INVALID');
    if(input.action!==undefined)reject('THREADED_ACTION_NOT_ENABLED');
    if(entry==='tool'&&!input.overrideReason?.trim()&&!input.searchEvidenceRefs?.length)reject('THREADED_CONSULTATION_SEARCH_REQUIRED');
    if(input.overrideReason)text(input.overrideReason,500);if(input.context)text(input.context,5000);
    const parent=source(binding);
    if(parent.origin!=='user'){
      const pending=[parent.id],seen=new Set<string>();
      while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);
        if(seen.size>1000)reject('THREADED_CONSULTATION_CASCADE_DENIED');
        if(db.prepare(`SELECT 1 FROM threaded_consultation_targets t JOIN threaded_consultations g ON g.id=t.group_id
          WHERE t.question_message_id=? AND g.caller_id<>?`).get(id,binding.agentId))reject('THREADED_CONSULTATION_CASCADE_DENIED');
        const m=db.prepare('SELECT source_refs FROM threaded_messages WHERE id=? AND owner_id=?').get(id,binding.ownerId) as {source_refs:string}|undefined;
        if(m)pending.push(...JSON.parse(m.source_refs) as string[]);
      }
    }
    const fingerprint=digest(input),prior=db.prepare('SELECT * FROM threaded_consultations WHERE binding_id=? AND request_key=?').get(binding.id,key) as Group|undefined;
    if(prior){if(prior.request_hash!==fingerprint)reject('THREADED_CONSULTATION_IDEMPOTENCY_CONFLICT');return {groupId:prior.id,deadline:prior.deadline};}
    const scope=boundary(binding,input.searchEvidenceRefs??[]),id=randomUUID(),deadline=now()+integer(input.timeoutMinutes??8,3,20)*60_000;
    db.prepare(`INSERT INTO threaded_consultations VALUES(?,?,?,?,?,?,?,?,?,?,?,'collecting',1,?,?)`).run(id,binding.ownerId,binding.threadId,
      binding.id,binding.agentId,binding.invocationId,parent.causalRootId,key,fingerprint,input.callbackTo,deadline,JSON.stringify({scope,frozen:frozen(binding)}),now());
    for(const target of targets){const receipt=options.messages.postAgentMessageWithinTransaction({binding,toolCallId:`consult:${id}:${target}`,
      body:JSON.stringify({groupId:id,question:input.question,context:input.context??'',deadline}),targets:[target],...scope});
      db.prepare("INSERT INTO threaded_consultation_targets VALUES(?,?,?,NULL,'pending')").run(id,target,receipt.message.id);
      db.prepare("INSERT INTO threaded_message_routes VALUES(?,?,?,'consultation_target',?,?,?)").run(receipt.message.id,binding.ownerId,binding.threadId,
        targets.length>1?'parallel':'serial',JSON.stringify([target]),JSON.stringify({groupId:id}));}
    return {groupId:id,deadline};
  }
  function registerWaitWithin(binding:ThreadedBinding,input:{jobKey:string;kind:'timer'|'tracking'|'decision';seconds?:number;question?:string;
    once?:boolean;block?:string;source?:string;subject?:string;match?:Record<string,unknown>;replaceWaitId?:string;expectedVersion?:number;trackingAuthorization?:string;waitSourceRef?:ThreadedWaitSourceRef}) {
    running(binding);text(input.jobKey);
    const prior=db.prepare('SELECT * FROM threaded_waits WHERE owner_id=? AND thread_id=? AND agent_id=? AND job_key=?')
      .get(binding.ownerId,binding.threadId,binding.agentId,input.jobKey) as Wait|undefined;
    const fingerprint=digest(input);
    if(prior){if(prior.request_hash!==fingerprint||prior.root_id!==source(binding).causalRootId)reject('THREADED_WAIT_IDEMPOTENCY_CONFLICT');return {waitId:prior.id,version:prior.version,deadline:prior.deadline};}
    if(input.kind==='decision'){
      if(input.once!==true||input.block!=='interactive')reject('THREADED_DECISION_INTERACTIVE_ONCE_REQUIRED');
      text(input.question,5000);
      const parent=source(binding);if(parent.origin==='system'||db.prepare('SELECT 1 FROM threaded_consultation_targets WHERE question_message_id=?').get(parent.id))reject('THREADED_DECISION_ORDINARY_REQUIRED');
      const existing=db.prepare("SELECT id FROM threaded_waits WHERE owner_id=? AND thread_id=? AND agent_id=? AND kind='decision' AND state='awaiting'")
        .get(binding.ownerId,binding.threadId,binding.agentId) as {id:string}|undefined;
      if(existing&&existing.id!==input.replaceWaitId)reject('THREADED_DECISION_ALREADY_PENDING');
    }
    const id=randomUUID(),created=now();let deadline:number|null=null,baseline:number|null=null,waitSourceAuthority:ThreadedWaitSourceAuthority|undefined;
    let holdDomain:'ordinary'|'gatekeeping'|undefined;
    if(input.kind==='timer'){
      const ref=parseThreadedWaitSource(input.waitSourceRef);
      deadline=created+integer(input.seconds,5,3600)*1000;
      if(ref.slaUntilMs<=created)reject('THREADED_HOLD_SLA_INVALID',400);
      const cutoff=(db.prepare('SELECT input_max_seq FROM threaded_invocation_wakes WHERE invocation_id=?').get(binding.invocationId) as {input_max_seq:number}).input_max_seq;
      waitSourceAuthority=groundWaitSource(binding,ref,cutoff)??reject('THREADED_WAIT_SOURCE_NOT_AUTHORIZED',403);
      holdDomain=options.holdPolicy?.(binding)??'ordinary';
      if(!['ordinary','gatekeeping'].includes(holdDomain))reject('THREADED_HOLD_DOMAIN_INVALID',403);
      if(holdDomain==='gatekeeping'){
        if(input.seconds!>600)reject('THREADED_HOLD_GATEKEEPING_TOO_LONG',403);
        const eventCallback=db.prepare(`SELECT 1 FROM threaded_waits WHERE owner_id=? AND thread_id=? AND agent_id=? AND kind='tracking' AND state='awaiting'
          UNION ALL SELECT 1 FROM threaded_command_waits w JOIN threaded_commands c ON c.id=w.command_id WHERE c.owner_id=? AND c.thread_id=? AND c.agent_id=? AND w.state='awaiting' LIMIT 1`)
          .get(binding.ownerId,binding.threadId,binding.agentId,binding.ownerId,binding.threadId,binding.agentId);
        if(eventCallback)reject('THREADED_HOLD_GATEKEEPING_EVENT_CALLBACK_EXISTS',403);
      }
    }
    if(input.kind==='tracking'){
      text(input.source);text(input.subject);
      if(!input.trackingAuthorization||!input.match||!Object.keys(input.match).length||Object.keys(input.match).length>10||Object.keys(input.match).some(k=>k.startsWith('__')))reject('THREADED_TRACKING_MATCH_REQUIRED');
      if(options.trackingAuthorization?.(binding,input.source!,input.subject!)!==input.trackingAuthorization)reject('THREADED_TRACKING_AUTHORITY_CHANGED',403);
      baseline=(db.prepare(`SELECT MAX(seq) seq FROM threaded_tracking_events WHERE owner_id=? AND source=? AND subject=?
        AND json_extract(record,'$.__authorization')=?`).get(binding.ownerId,input.source,input.subject,input.trackingAuthorization) as {seq:number|null}).seq;
      if(baseline===null)reject('THREADED_TRACKING_LIVE_BASELINE_REQUIRED');
    }
    if(input.replaceWaitId){const old=db.prepare('SELECT * FROM threaded_waits WHERE id=? AND owner_id=? AND thread_id=? AND agent_id=?')
      .get(input.replaceWaitId,binding.ownerId,binding.threadId,binding.agentId) as Wait|undefined;
      if(!old||old.state!=='awaiting'||old.version!==input.expectedVersion||old.root_id!==source(binding).causalRootId)reject('THREADED_WAIT_VERSION_CONFLICT');
      db.prepare("UPDATE threaded_waits SET state='superseded',version=version+1,updated_at=? WHERE id=?").run(created,old.id);}
    const record={...input,baseline,...(waitSourceAuthority?{waitSourceAuthority,holdDomain}:{}),scope:boundary(binding,waitSourceAuthority?.sourceMessageIds??[]),frozen:frozen(binding)};
    db.prepare("INSERT INTO threaded_waits VALUES(?,?,?,?,?,?,?,?,?,?,'awaiting',1,?,?,NULL,?,?)")
      .run(id,binding.ownerId,binding.threadId,binding.agentId,binding.id,binding.invocationId,source(binding).causalRootId,input.jobKey,input.kind,fingerprint,deadline,JSON.stringify(record),created,created);
    if(input.kind==='timer'){admitHoldWithin(binding,{key:`wait:${id}`,kind:'timer'});
      db.prepare('INSERT INTO threaded_hold_quota VALUES(?,?,?,?,?)').run(id,binding.ownerId,binding.threadId,binding.agentId,created);}
    return {waitId:id,version:1,deadline};
  }
  function settleWait(wait:Wait,outcome:Record<string,unknown>) {
    if(wait.state!=='awaiting')return;
    db.prepare("UPDATE threaded_waits SET state='settled',version=version+1,outcome=?,updated_at=? WHERE id=? AND state='awaiting'").run(JSON.stringify(outcome),now(),wait.id);
    callbackFromWait(wait,outcome);
  }
  function trackingAuthorized(wait:Wait){
    const config=JSON.parse(wait.record) as {source:string;subject:string;trackingAuthorization:string};
    try{return !!config.trackingAuthorization&&options.trackingAuthorization?.({ownerId:wait.owner_id,threadId:wait.thread_id,agentId:wait.agent_id},config.source,config.subject)===config.trackingAuthorization;}
    catch{return false;}
  }
  function recoverWithin() {
    for(const group of db.prepare("SELECT * FROM threaded_consultations WHERE state='collecting' AND deadline<=?").all(now()) as Group[])settleGroup(group,true);
    for(const wait of db.prepare("SELECT * FROM threaded_waits WHERE state='awaiting' AND kind<>'decision'").all() as Wait[]){
      if(wait.kind==='timer'&&wait.deadline!==null&&wait.deadline<=now()){
        if(missedTimerIds.has(wait.id)){
          const record=JSON.parse(wait.record) as {waitSourceRef:unknown;frozen:ReturnType<typeof frozen>;scope:ReturnType<typeof boundary>};
          const scope={ownerId:wait.owner_id,threadId:wait.thread_id,agentId:wait.agent_id};
          const currentIdentity=identity(scope),fence=record.frozen?.actionFence;
          const thread=db.prepare('SELECT state FROM threaded_threads WHERE id=? AND owner_id=?').get(wait.thread_id,wait.owner_id) as {state:string}|undefined;
          const cancelled=db.prepare(`SELECT 1 FROM threaded_control_requests WHERE owner_id=? AND thread_id=? AND rowid>?
            AND (scope='thread' OR (scope='member' AND agent_id=?)) AND action='cancel' AND status<>'rejected' LIMIT 1`)
            .get(wait.owner_id,wait.thread_id,record.frozen?.controlSeq??0,wait.agent_id);
          const sourcesValid=Array.isArray(record.scope?.sourceRefs)&&record.scope.sourceRefs.every(id=>{
            const row=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,wait.owner_id) as {thread_id:string}|undefined;
            return !!row&&!!options.messages.getMessage({ownerId:wait.owner_id,threadId:row.thread_id,viewer:{kind:'agent',agentId:wait.agent_id}},id);});
          const classification=classifyThreadedTimerRecovery({deadline:wait.deadline,createdAt:wait.created_at,now:now(),source:record.waitSourceRef,
            identityValid:!!thread&&!['closed','archived'].includes(thread.state)&&!cancelled&&!!currentIdentity&&currentIdentity===record.frozen?.identity&&
              (!fence||!!options.actionScope?.valid(fence,wait.agent_id)),sourceValid:sourcesValid&&timerSourceAuthorized(wait)});
          // The source classifier permits the SLA boundary, while dispatch requires a nonempty retry window.
          if(classification.kind==='invalid'||classification.kind==='expired'||now()>=classification.slaUntilMs){
            const disposition=classification.kind==='invalid'?'retired_invalid':'retired_expired';
            db.prepare("UPDATE threaded_waits SET state='withdrawn',version=version+1,outcome=?,updated_at=? WHERE id=? AND state='awaiting'")
              .run(JSON.stringify({type:'timer_recovery_retired',disposition,classification:classification.kind,businessConditionVerified:false}),now(),wait.id);
          }else settleWait(wait,{type:'timer_elapsed',recoveredMissedTimer:true,retryUntil:classification.slaUntilMs,businessConditionVerified:false});
        }else if(!timerSourceAuthorized(wait)){
          db.prepare("UPDATE threaded_waits SET state='withdrawn',version=version+1,outcome=?,updated_at=? WHERE id=? AND state='awaiting'")
            .run(JSON.stringify({type:'timer_source_retired',disposition:'retired_invalid',businessConditionVerified:false}),now(),wait.id);
        }else settleWait(wait,{type:'timer_elapsed',businessConditionVerified:false});
      }
      if(wait.kind==='tracking'){
        if(!trackingAuthorized(wait)){
          db.prepare("UPDATE threaded_waits SET state='withdrawn',version=version+1,outcome=?,updated_at=? WHERE id=? AND state='awaiting'")
            .run(JSON.stringify({type:'tracking_authority_changed',businessConditionVerified:false}),now(),wait.id);continue;
        }
        const config=JSON.parse(wait.record) as {source:string;subject:string;baseline:number;match:Record<string,unknown>;trackingAuthorization:string};
        const events=db.prepare('SELECT seq,record FROM threaded_tracking_events WHERE owner_id=? AND source=? AND subject=? AND seq>? ORDER BY seq')
          .all(wait.owner_id,config.source,config.subject,config.baseline) as Array<{seq:number;record:string}>;
        const event=events.find(e=>{const record=JSON.parse(e.record) as Record<string,unknown>;return !record.__baseline&&record.__authorization===config.trackingAuthorization&&Object.entries(config.match).every(([k,v])=>digest(record[k])===digest(v));});
        if(event)settleWait(wait,{type:'tracking_event',eventSeq:event.seq,event:Object.fromEntries(Object.entries(JSON.parse(event.record) as Record<string,unknown>).filter(([k])=>!k.startsWith('__')))});
      }
    }
    dispatchCallbacks();
  }
  function onTerminalWithin(input:CollaborationTerminal) {
    const target=db.prepare(`SELECT t.*,g.state,g.deadline FROM threaded_consultation_targets t JOIN threaded_consultations g ON g.id=t.group_id
      JOIN threaded_invocation_wakes q ON q.source_message_id=t.question_message_id AND q.agent_id=t.agent_id
      WHERE q.invocation_id=?`).get(input.binding.invocationId) as {group_id:string;agent_id:string;status:string;state:string;deadline:number}|undefined;
    if(target&&target.state==='collecting'&&target.status==='pending'){
      const group=db.prepare('SELECT * FROM threaded_consultations WHERE id=?').get(target.group_id) as Group;
      if(now()>=group.deadline)settleGroup(group,true);
      else {
        const readable=input.response&&options.messages.getMessage({ownerId:group.owner_id,threadId:group.thread_id,viewer:{kind:'agent',agentId:group.callback_to}},input.response.message.id);
        db.prepare('UPDATE threaded_consultation_targets SET response_message_id=?,status=? WHERE group_id=? AND agent_id=? AND status=\'pending\'')
          .run(readable?input.response!.message.id:null,readable?'responded':input.status==='cancelled'?'cancelled':'failed',group.id,target.agent_id);
        settleGroup(group);
      }
    }
    recoverWithin();
  }
  function decisionOperationWithin(binding:ThreadedBinding,input:{waitId:string;operationId:string;expectedVersion:number;operation:'settle'|'withdraw';responseMessageId?:string}) {
    running(binding);text(input.operationId);const wait=db.prepare('SELECT * FROM threaded_waits WHERE id=? AND owner_id=? AND thread_id=? AND agent_id=? AND kind=\'decision\'')
      .get(input.waitId,binding.ownerId,binding.threadId,binding.agentId) as Wait|undefined;
    if(!wait)reject('THREADED_WAIT_NOT_FOUND',404);
    const fingerprint=digest(input),prior=db.prepare('SELECT request_hash,record FROM threaded_wait_operations WHERE wait_id=? AND operation_id=?').get(wait.id,input.operationId) as {request_hash:string;record:string}|undefined;
    if(prior){if(prior.request_hash!==fingerprint)reject('THREADED_WAIT_IDEMPOTENCY_CONFLICT');return JSON.parse(prior.record) as {waitId:string;version:number};}
    if(wait.version!==input.expectedVersion||wait.state!=='awaiting')reject('THREADED_WAIT_VERSION_CONFLICT');
    if(input.operation==='settle'){
      const parent=source(binding),response=db.prepare('SELECT revision FROM threaded_decision_responses WHERE message_id=? AND wait_id=?').get(parent.id,wait.id) as {revision:number}|undefined;
      if(parent.id!==input.responseMessageId||parent.origin!=='user'||parent.createdAt<new Date(wait.created_at).toISOString()||!response||response.revision!==wait.version)reject('THREADED_DECISION_RESPONSE_ORIGIN_INVALID');
      // Canonical human responses retain the waiting Invocation's original causal budget.
      db.prepare("UPDATE threaded_waits SET state='settled',version=version+1,outcome=?,updated_at=? WHERE id=?")
        .run(JSON.stringify({type:'human_response',responseMessageId:parent.id,businessApproval:false}),now(),wait.id);
    }else db.prepare("UPDATE threaded_waits SET state='withdrawn',version=version+1,updated_at=? WHERE id=?").run(now(),wait.id);
    const result={waitId:wait.id,version:wait.version+1};db.prepare('INSERT INTO threaded_wait_operations VALUES(?,?,?,?)').run(wait.id,input.operationId,fingerprint,JSON.stringify(result));return result;
  }
  return {running,source,boundary,frozen,identity,transaction,notify,consultWithin,registerWaitWithin,admitHoldWithin,decisionOperationWithin,onTerminalWithin,
    recoverWithin,recover:()=>transaction(recoverWithin),callback,
    answerDecision(input:{ownerId:string;threadId:string;waitId:string;expectedVersion:number;clientRequestId:string;body:string}) {
      return transaction(()=>{
        const wait=db.prepare("SELECT * FROM threaded_waits WHERE id=? AND owner_id=? AND thread_id=? AND kind='decision'").get(input.waitId,input.ownerId,input.threadId) as Wait|undefined;
        const prior=db.prepare(`SELECT m.receipt,m.body,r.wait_id,r.revision FROM threaded_messages m JOIN threaded_decision_responses r ON r.message_id=m.id
          WHERE m.owner_id=? AND m.thread_id=? AND m.origin='user' AND m.request_scope=? AND m.request_key=?`)
          .get(input.ownerId,input.threadId,input.threadId,input.clientRequestId) as {receipt:string;body:string;wait_id:string;revision:number}|undefined;
        if(prior){if(prior.wait_id!==input.waitId||prior.revision!==input.expectedVersion||prior.body!==input.body)reject('THREADED_WAIT_IDEMPOTENCY_CONFLICT');return JSON.parse(prior.receipt) as ThreadedMessageReceipt;}
        if(!wait||wait.state!=='awaiting'||wait.version!==input.expectedVersion)reject('THREADED_WAIT_VERSION_CONFLICT');
        const record=JSON.parse(wait.record) as {frozen:ReturnType<typeof frozen>;scope:ReturnType<typeof boundary>},frozenState=record.frozen;
        if(identity({ownerId:wait.owner_id,threadId:wait.thread_id,agentId:wait.agent_id})!==frozenState.identity)reject('THREADED_CALLBACK_AUTHORITY_CHANGED');
        if(db.prepare(`SELECT 1 FROM threaded_control_requests WHERE owner_id=? AND thread_id=? AND rowid>?
          AND (scope='thread' OR (scope='member' AND agent_id=?)) AND action='cancel' AND status<>'rejected'`)
          .get(wait.owner_id,wait.thread_id,frozenState.controlSeq,wait.agent_id))reject('THREADED_DECISION_RETIRED');
        const receipt=options.messages.acceptUserMessageWithinTransaction({ownerId:input.ownerId,threadId:input.threadId,
          clientRequestId:input.clientRequestId,body:text(input.body,20_000),targets:[wait.agent_id],...record.scope},
          {causalParentInvocationId:wait.parent_invocation_id});
        const previous=db.prepare('SELECT wait_id,revision FROM threaded_decision_responses WHERE message_id=?').get(receipt.message.id) as {wait_id:string;revision:number}|undefined;
        if(previous&&(previous.wait_id!==wait.id||previous.revision!==wait.version))reject('THREADED_WAIT_IDEMPOTENCY_CONFLICT');
        db.prepare('INSERT OR IGNORE INTO threaded_decision_responses VALUES(?,?,?)').run(receipt.message.id,wait.id,wait.version);return receipt;
      });
    },
    list(scope:Scope) {return db.prepare('SELECT id,kind,state,version,deadline,record,outcome FROM threaded_waits WHERE owner_id=? AND thread_id=? AND agent_id=? ORDER BY created_at').all(scope.ownerId,scope.threadId,scope.agentId);},
    consultationStatus(binding:ThreadedBinding,id:string){running(binding);const group=db.prepare('SELECT * FROM threaded_consultations WHERE id=? AND owner_id=? AND thread_id=? AND caller_id=?').get(id,binding.ownerId,binding.threadId,binding.agentId) as Group|undefined;
      if(!group)reject('THREADED_CONSULTATION_NOT_FOUND',404);
      const targets=db.prepare('SELECT agent_id,status,response_message_id FROM threaded_consultation_targets WHERE group_id=?').all(id) as Array<{agent_id:string;status:string;response_message_id:string|null}>;
      return {groupId:id,state:group.state,deadline:group.deadline,targets:targets.map(target=>target.response_message_id&&!options.messages.getMessage({ownerId:binding.ownerId,threadId:binding.threadId,
        viewer:{kind:'agent',agentId:binding.agentId}},target.response_message_id)?{...target,status:'unavailable',response_message_id:null}:target)};},
    /** Called only by an authenticated server producer after observing its live source. Never a model tool. */
    recordTrackingEvent(input:{ownerId:string;source:string;subject:string;eventKey:string;event:Record<string,unknown>}) {
      return transaction(()=>{
        for(const value of [input.source,input.subject,input.eventKey])text(value);
        const fingerprint=digest(input),prior=db.prepare('SELECT seq,request_hash FROM threaded_tracking_events WHERE owner_id=? AND source=? AND subject=? AND event_key=?')
          .get(input.ownerId,input.source,input.subject,input.eventKey) as {seq:number;request_hash:string}|undefined;
        if(prior){if(prior.request_hash!==fingerprint)reject('THREADED_TRACKING_EVENT_CONFLICT');return prior.seq;}
        const result=db.prepare('INSERT INTO threaded_tracking_events(owner_id,source,subject,event_key,request_hash,record,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(input.ownerId,input.source,input.subject,input.eventKey,fingerprint,JSON.stringify(input.event),now());recoverWithin();return Number(result.lastInsertRowid);
      });
    },
  };
}
