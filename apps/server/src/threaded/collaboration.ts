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
import {createThreadedActions} from './actions.ts';
import type {ActionOptions} from './actionTypes.ts';
import {createThreadedReviews} from './reviews.ts';
import {createThreadedSop} from './sop.ts';
import {createThreadedKnowledge} from './knowledge.ts';
import {createActionCommands} from './actionCommands.ts';

/** Persistent cooperation state. Timers are only hints; recover reads original durable deadlines. */
export function createThreadedCollaboration(db:Database.Database,options:CollaborationOptions&{
  context?:Pick<ReturnType<typeof createThreadedContext>,'markSeen'|'acknowledgeMentions'>;
  trackingSources?:Record<string,ThreadedTrackingSource>;
  actions?:ActionOptions;
}) {
  let timer:ReturnType<typeof setTimeout>|undefined,closed=false,scheduled=false,lastError:string|null=null;
  const now=options.now??Date.now;
  function arm(floor=10) {
    if(timer)clearTimeout(timer);if(closed||!db.open)return;
    const row=db.prepare(`SELECT MIN(deadline) deadline FROM (
      SELECT deadline FROM threaded_consultations WHERE state='collecting'
      UNION ALL SELECT deadline FROM threaded_waits WHERE state='awaiting' AND kind='timer')`).get() as {deadline:number|null};
    const hasTracking=!!db.prepare("SELECT 1 FROM threaded_waits WHERE state='awaiting' AND kind='tracking'").get();
    const hasCommands=!!db.prepare("SELECT 1 FROM threaded_commands WHERE state IN ('running','unknown')").get();
    const hasReviews=!!options.actions?.pr&&!!db.prepare("SELECT 1 FROM threaded_actions WHERE family='review'").get();
    const hasTaskProjection=!!db.prepare(`SELECT 1 FROM threaded_action_evidence e JOIN threaded_actions a ON a.id=e.action_id
      AND a.generation=e.generation WHERE a.state='active' AND e.kind='task_transition' AND NOT EXISTS(SELECT 1 FROM threaded_action_candidates c WHERE c.evidence_id=e.id)`).get();
    const deadline=hasTracking||hasCommands||hasReviews||hasTaskProjection?Math.min(row.deadline??Infinity,now()+5000):row.deadline;
    if(deadline!==null){timer=setTimeout(()=>{if(closed)return;
      void (async()=>{try{cooperation.recover();cooperation.transaction(()=>actions.recoverWithin());if(hasTracking)await tracking.refresh();if(hasCommands)await commands.recover();if(hasReviews)await actions.refreshFreshness();lastError=null;arm();}
        catch{lastError='THREADED_COLLABORATION_REPAIR_FAILED';arm(1000);}})();
    },Math.max(floor,Math.min(2_147_483_647,deadline-now())));timer.unref();}
  }
  function notifyCommitted() {
    options.onCommitted?.();
    if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;if(!closed&&db.open&&!db.inTransaction)arm();});}
  }
  let actions:ReturnType<typeof createThreadedActions>;
  const cooperation=createThreadedCooperation(db,{...options,onCommitted:notifyCommitted,actionScope:{
    capture:b=>actions?.capture(b)??null,valid:(f,a)=>actions.valid(f,a),
    assertBinding:b=>actions?.assertBinding(b),bindMessage:(id,f)=>actions.bindMessage(id,f)}});
  const routing=createThreadedRouting(db,{...options,onCommitted:notifyCommitted,identity:cooperation.identity});
  actions=createThreadedActions(db,{...options,...options.actions,cooperation,routing});
  const commands=createActionCommands(db,{...options,actions,cooperation,ports:options.actions?.commands});
  const tracking=createThreadedTracking(db,cooperation,{thread_messages:threadedMessageTrackingSource(db,options.messages),...options.trackingSources});
  const reviews=createThreadedReviews(db,{...options,...options.actions,cooperation,routing,actions});
  const sop=createThreadedSop(db,{...options,cooperation});
  const knowledge=createThreadedKnowledge(db,{...options,cooperation});
  const tools=createThreadedTools(db,{...options,onCommitted:notifyCommitted,cooperation,routing,actions,commands,reviews,sop,knowledge,prepareTracking:tracking.prepare});
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
    actions.onTerminalWithin(input);
  }
  return {routing,cooperation,tools,tracking,actions,commands,reviews,sop,knowledge,terminalWithin,notifyCommitted,
    responseWithin(binding:ThreadedBinding,key:string,proof:QuiescenceProof,input:ThreadedMessagePayload) {
      const boundary=cooperation.boundary(binding,input.sourceRefs??[]);
      if(input.visibility==='private'){
        const audience=input.audience??boundary.audience;
        if(boundary.visibility==='private'&&audience.some(id=>!boundary.audience.includes(id)))reject('THREADED_TOOL_VISIBILITY_CONFLICT',403);
        const receipt=routing.responseWithin(binding,key,proof,{...input,...boundary,visibility:'private',audience});
        actions.bindMessage(receipt.message.id,actions.capture(binding));return receipt;
      }
      const receipt=routing.responseWithin(binding,key,proof,{...input,...boundary});
      actions.bindMessage(receipt.message.id,actions.capture(binding));return receipt;
    },
    recover(){const result=cooperation.recover();cooperation.transaction(()=>{actions.recoverWithin();cooperation.recoverWithin();});arm();return result;},
    diagnostics:()=>({lastError,closed}),
    close(){closed=true;if(timer)clearTimeout(timer);},
  };
}
