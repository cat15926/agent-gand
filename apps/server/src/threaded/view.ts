import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {ThreadedViewSnapshot,ThreadedChangePage,ThreadedCapabilities,ThreadedInvocationView,ThreadedMessageProgress} from '@agent-gand/shared';
import type {createThreadedStore} from './store.ts';
import type {createThreadedMessages} from './messages.ts';
import {ThreadedAccessError} from './access.ts';
import {threadedCapabilities} from './policy.ts';

/** Read-only Owner projection. No native transcript, execution fence, credentials or write ports. */
export function createThreadedView(db:Database.Database,options:{
  store:Pick<ReturnType<typeof createThreadedStore>,'getThread'|'listMembers'>;
  messages:Pick<ReturnType<typeof createThreadedMessages>,'getMessage'>;
  capabilities?:()=>ThreadedCapabilities;
}) {
  const denied=():never=>{throw new ThreadedAccessError(404,'THREADED_THREAD_NOT_FOUND','持续协作空间不存在或无权访问');};
  function assertThread(ownerId:string,threadId:string){const value=options.store.getThread(threadId,ownerId);return value??denied();}
  function readable(ownerId:string,threadId:string,id:string){return options.messages.getMessage({ownerId,threadId,viewer:{kind:'owner'}},id);}
  function sourceReadable(ownerId:string,id:string){const source=db.prepare('SELECT thread_id FROM threaded_messages WHERE id=? AND owner_id=?').get(id,ownerId) as {thread_id:string}|undefined;
    return source&&readable(ownerId,source.thread_id,id);}
  function changes(ownerId:string,threadId:string,afterSeq:number):ThreadedChangePage {
    assertThread(ownerId,threadId);
    const rows=db.prepare(`SELECT seq,id,event_type,source_id FROM threaded_outbox WHERE owner_id=? AND thread_id=? AND seq>? ORDER BY seq LIMIT 101`)
      .all(ownerId,threadId,afterSeq) as Array<{seq:number;id:string;event_type:string;source_id:string}>;
    const page=rows.slice(0,100),events:ThreadedChangePage['events']=[];
    for(const row of page){const id=row.event_type==='message.created'?row.source_id:
      (db.prepare('SELECT source_message_id FROM threaded_wakes WHERE id=? AND owner_id=? AND thread_id=?').get(row.source_id,ownerId,threadId) as {source_message_id:string}|undefined)?.source_message_id;
      if(id&&readable(ownerId,threadId,id))events.push({seq:row.seq,id:row.id,type:row.event_type,messageId:id});}
    return {afterSeq,throughSeq:page.at(-1)?.seq??afterSeq,hasMore:rows.length>100,events};
  }
  function snapshot(ownerId:string,threadId:string,input:{beforeSeq?:number}={}):ThreadedViewSnapshot {
    return db.transaction(()=>{
      const thread=assertThread(ownerId,threadId),members=options.store.listMembers(threadId,ownerId);
      const rows=db.prepare(`SELECT id,seq FROM threaded_messages WHERE owner_id=? AND thread_id=? AND seq<? ORDER BY seq DESC LIMIT 101`)
        .all(ownerId,threadId,input.beforeSeq??Number.MAX_SAFE_INTEGER) as Array<{id:string;seq:number}>;
      const messages=rows.slice(0,100).flatMap(row=>{const m=readable(ownerId,threadId,row.id);return m?[m]:[];}).reverse();
      const raw=db.prepare(`SELECT i.id,i.agent_id,i.status,i.pause_requested,i.cancel_requested,i.recovery_reason,i.created_at,i.updated_at,
        r.run_id,w.source_message_id FROM threaded_invocations i LEFT JOIN threaded_run_bindings r ON r.invocation_id=i.id
        LEFT JOIN threaded_invocation_wakes w ON w.invocation_id=i.id WHERE i.owner_id=? AND i.thread_id=? ORDER BY i.created_at DESC,i.id DESC LIMIT 200`)
        .all(ownerId,threadId) as Array<{id:string;agent_id:string;status:ThreadedInvocationView['status'];pause_requested:number;cancel_requested:number;recovery_reason:string|null;created_at:string;updated_at:string;run_id:string|null;source_message_id:string|null}>;
      const invocations:ThreadedInvocationView[]=raw.filter(i=>!i.source_message_id||readable(ownerId,threadId,i.source_message_id)).map(i=>({
        id:i.id,agentId:i.agent_id,runId:i.run_id,sourceMessageId:i.source_message_id,status:i.status,pauseRequested:!!i.pause_requested,
        cancelRequested:!!i.cancel_requested,reason:i.recovery_reason,createdAt:i.created_at,updatedAt:i.updated_at,
        attempts:(db.prepare('SELECT id,attempt_no,status,execution_stage,execution_reason,updated_at FROM threaded_attempts WHERE invocation_id=? ORDER BY attempt_no').all(i.id) as
          Array<{id:string;attempt_no:number;status:string;execution_stage:string;execution_reason:string|null;updated_at:string}>).map(a=>({id:a.id,number:a.attempt_no,status:a.status,stage:a.execution_stage,reason:a.execution_reason,updatedAt:a.updated_at})),
      }));
      const progress:ThreadedMessageProgress[]=[];
      for(const m of messages){
        const targets=new Set(m.targets);
        const facts=db.prepare('SELECT agent_id,kind FROM threaded_context_cursor_facts WHERE owner_id=? AND thread_id=? AND message_id=?')
          .all(ownerId,threadId,m.id) as Array<{agent_id:string;kind:string}>;
        for(const f of facts)targets.add(f.agent_id);
        for(const agentId of targets){const inv=invocations.filter(i=>i.sourceMessageId===m.id&&i.agentId===agentId);
          const wake=db.prepare(`SELECT w.status,q.state,q.reason FROM threaded_wakes w LEFT JOIN threaded_wake_queue q ON q.wake_id=w.id
            WHERE w.owner_id=? AND w.thread_id=? AND w.source_message_id=? AND w.target_agent_id=?`).get(ownerId,threadId,m.id,agentId) as {status:string;state:string|null;reason:string|null}|undefined;
          const has=(kind:string)=>facts.some(f=>f.agent_id===agentId&&f.kind===kind);
          progress.push({messageId:m.id,agentId,queued:!!wake&&wake.status!=='cancelled'&&(!wake.state||['queued','blocked'].includes(wake.state)),
            executing:inv.some(i=>i.status==='running'),responded:inv.some(i=>i.status==='completed'),
            delivered:has('delivery'),seen:has('seen'),mentionAcknowledged:has('mention_ack'),reason:wake?.reason??null});
        }
      }
      const waits=(db.prepare('SELECT id,agent_id,kind,state,version,deadline,record,outcome FROM threaded_waits WHERE owner_id=? AND thread_id=? ORDER BY created_at DESC LIMIT 100')
        .all(ownerId,threadId) as Array<{id:string;agent_id:string;kind:'timer'|'tracking'|'decision';state:string;version:number;deadline:number|null;record:string;outcome:string|null}>).flatMap(w=>{
        const config=JSON.parse(w.record) as {question?:string;scope:{sourceRefs:string[]}};
        if(config.scope.sourceRefs.some(id=>!sourceReadable(ownerId,id)))return [];
        const responses=db.prepare('SELECT message_id FROM threaded_decision_responses WHERE wait_id=?').all(w.id) as Array<{message_id:string}>;
        return [{id:w.id,agentId:w.agent_id,kind:w.kind,state:w.state,version:w.version,deadline:w.deadline,question:config.question??null,
          responseCount:responses.filter(r=>readable(ownerId,threadId,r.message_id)).length,outcome:w.outcome?JSON.parse(w.outcome) as Record<string,unknown>:null}];});
      const consultations=(db.prepare(`SELECT g.id,g.caller_id,g.deadline,g.state,g.record,s.kind,c.state callback_state,c.reason callback_reason
        FROM threaded_consultations g LEFT JOIN threaded_consultation_settlements s ON s.group_id=g.id
        LEFT JOIN threaded_collaboration_callbacks c ON c.source_id=g.id WHERE g.owner_id=? AND g.thread_id=? ORDER BY g.created_at DESC LIMIT 100`)
        .all(ownerId,threadId) as Array<{id:string;caller_id:string;deadline:number;state:string;record:string;kind:string|null;callback_state:string|null;callback_reason:string|null}>).flatMap(g=>{
        const config=JSON.parse(g.record) as {scope:{sourceRefs:string[]}};
        if(config.scope.sourceRefs.some(id=>!sourceReadable(ownerId,id)))return [];
        const targets=db.prepare('SELECT agent_id,status,response_message_id,question_message_id FROM threaded_consultation_targets WHERE group_id=? ORDER BY agent_id').all(g.id) as
          Array<{agent_id:string;status:string;response_message_id:string|null;question_message_id:string}>;
        if(targets.some(t=>!readable(ownerId,threadId,t.question_message_id)))return [];
        return [{id:g.id,callerId:g.caller_id,deadline:g.deadline,state:g.state,kind:g.kind,targets:targets.map(t=>({agentId:t.agent_id,status:t.status,
          responseMessageId:t.response_message_id&&readable(ownerId,threadId,t.response_message_id)?t.response_message_id:null})),
          callback:g.callback_state?{state:g.callback_state,reason:g.callback_reason}:null}];});
      const controls=db.prepare(`SELECT scope,agent_id,action FROM threaded_control_requests WHERE owner_id=? AND thread_id=? AND status<>'rejected' ORDER BY rowid DESC`)
        .all(ownerId,threadId) as Array<{scope:string;agent_id:string|null;action:string}>;
      const memberControls=members.map(m=>{const c=controls.find(c=>c.scope==='thread'||c.scope==='member'&&c.agent_id===m.agentId);
        return {agentId:m.agentId,state:(c?.action==='cancel'?'stopped':c?.action==='pause'?'paused':'available') as 'available'|'paused'|'stopped'};});
      const queued=db.prepare(`SELECT w.target_agent_id,w.source_message_id FROM threaded_wakes w LEFT JOIN threaded_wake_queue q ON q.wake_id=w.id
        WHERE w.owner_id=? AND w.thread_id=? AND w.status<>'cancelled' AND (q.state IS NULL OR q.state IN ('queued','blocked'))`)
        .all(ownerId,threadId) as Array<{target_agent_id:string;source_message_id:string}>;
      const memberQueues=members.map(m=>({agentId:m.agentId,count:queued.filter(w=>w.target_agent_id===m.agentId&&readable(ownerId,threadId,w.source_message_id)).length}));
      const approvals=(db.prepare("SELECT a.id,a.invocation_id,i.agent_id,a.status FROM threaded_approvals a JOIN threaded_invocations i ON i.id=a.invocation_id WHERE a.owner_id=? AND a.thread_id=? AND a.status='pending'")
        .all(ownerId,threadId) as Array<{id:string;invocation_id:string;agent_id:string;status:string}>).filter(a=>invocations.some(i=>i.id===a.invocation_id))
        .map(a=>({id:a.id,invocationId:a.invocation_id,agentId:a.agent_id,state:a.status}));
      const eventCursor=(db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM threaded_outbox WHERE owner_id=? AND thread_id=?').get(ownerId,threadId) as {seq:number}).seq;
      const routingVersion=(db.prepare('SELECT version FROM threaded_routing_policies WHERE owner_id=? AND thread_id=?').get(ownerId,threadId) as {version:number}|undefined)?.version??0;
      const value={httpVersion:'threaded-http-v1' as const,schemaVersion:1 as const,thread,members,messages,nextBeforeSeq:rows.length>100?rows[99]!.seq:null,
        invocations,progress,waits,consultations,memberControls,memberQueues,approvals,eventCursor,routingVersion,capabilities:(options.capabilities??threadedCapabilities)(),
        business:{available:false as const,label:'业务责任与完成状态待接入'}};
      return {...value,revision:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
    })();
  }
  return {snapshot,changes};
}
