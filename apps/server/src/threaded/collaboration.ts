import type Database from 'better-sqlite3';
import type { ThreadedBinding } from '@agent-gand/shared';
import type { ThreadedMessagePayload } from './messageContracts.ts';
import type { QuiescenceProof } from './contracts.ts';
import type { createThreadedContext } from './context.ts';
import { createThreadedRouting } from './routing.ts';
import { createThreadedCooperation } from './cooperation.ts';
import { createThreadedTools } from './tools.ts';
import {reject,type CollaborationOptions,type CollaborationTerminal,type RoutingDecision} from './collaborationTypes.ts';
import { createThreadedTracking, threadedMessageTrackingSource, type ThreadedTrackingSource } from './tracking.ts';

/** Persistent cooperation state. Timers are only hints; recover reads original durable deadlines. */
export function createThreadedCollaboration(db:Database.Database,options:CollaborationOptions&{
  context?:Pick<ReturnType<typeof createThreadedContext>,'markSeen'|'acknowledgeMentions'>;
  trackingSources?:Record<string,ThreadedTrackingSource>;
}) {
  let timer:ReturnType<typeof setTimeout>|undefined,closed=false,scheduled=false,lastError:string|null=null;
  const now=options.now??Date.now;
  function arm(floor=10) {
    if(timer)clearTimeout(timer);if(closed||!db.open)return;
    const row=db.prepare(`SELECT MIN(deadline) deadline FROM (
      SELECT deadline FROM threaded_consultations WHERE state='collecting'
      UNION ALL SELECT deadline FROM threaded_waits WHERE state='awaiting' AND kind='timer')`).get() as {deadline:number|null};
    const hasTracking=!!db.prepare("SELECT 1 FROM threaded_waits WHERE state='awaiting' AND kind='tracking'").get();
    const deadline=hasTracking?Math.min(row.deadline??Infinity,now()+5000):row.deadline;
    if(deadline!==null){timer=setTimeout(()=>{if(closed)return;
      void (async()=>{try{cooperation.recover();if(hasTracking)await tracking.refresh();lastError=null;arm();}
        catch{lastError='THREADED_COLLABORATION_REPAIR_FAILED';arm(1000);}})();
    },Math.max(floor,Math.min(2_147_483_647,deadline-now())));timer.unref();}
  }
  function notifyCommitted() {
    options.onCommitted?.();
    if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;if(!closed&&db.open&&!db.inTransaction)arm();});}
  }
  const cooperation=createThreadedCooperation(db,{...options,onCommitted:notifyCommitted});
  const routing=createThreadedRouting(db,{...options,onCommitted:notifyCommitted,identity:cooperation.identity});
  const tracking=createThreadedTracking(db,cooperation,{thread_messages:threadedMessageTrackingSource(db,options.messages),...options.trackingSources});
  const tools=createThreadedTools(db,{...options,onCommitted:notifyCommitted,cooperation,routing,prepareTracking:tracking.prepare});
  function terminalWithin(input:CollaborationTerminal) {
    const route=routing.sourceRoute(input.binding);
    const source=cooperation.source(input.binding);
    db.prepare('INSERT OR IGNORE INTO threaded_route_completions VALUES(?,?,?,?)').run(source.id,input.binding.agentId,input.binding.invocationId,input.status);
    if(route?.strategy==='serial'&&['user','serial_continuation'].includes(route.kind)){
      const record=JSON.parse(route.record) as RoutingDecision&{originalBody:string;targetIdentities:Record<string,string>};
      const remaining=record.targets.slice(1),target=remaining[0];
      if(target){
        const frozen=cooperation.frozen(input.binding);
        frozen.identity=record.targetIdentities[target]??null;
        cooperation.callback('serial',`${source.id}:${target}`,input.binding,target,
          JSON.stringify({type:'serial_continuation',request:record.originalBody,previousStatus:input.status,
            responseMessageId:input.response?.message.id??null}),cooperation.boundary(input.binding,input.response?[input.response.message.id]:[]),
          {frozen,route:{targets:remaining,record:{...record,targets:remaining}}});
      }
    }
    cooperation.onTerminalWithin(input);
  }
  return {routing,cooperation,tools,tracking,terminalWithin,notifyCommitted,
    responseWithin(binding:ThreadedBinding,key:string,proof:QuiescenceProof,input:ThreadedMessagePayload) {
      const boundary=cooperation.boundary(binding,input.sourceRefs??[]);
      if(input.visibility==='private'){
        const audience=input.audience??boundary.audience;
        if(boundary.visibility==='private'&&audience.some(id=>!boundary.audience.includes(id)))reject('THREADED_TOOL_VISIBILITY_CONFLICT',403);
        return routing.responseWithin(binding,key,proof,{...input,...boundary,visibility:'private',audience});
      }
      return routing.responseWithin(binding,key,proof,{...input,...boundary});
    },
    recover(){const result=cooperation.recover();arm();return result;},
    diagnostics:()=>({lastError,closed}),
    close(){closed=true;if(timer)clearTimeout(timer);},
  };
}
