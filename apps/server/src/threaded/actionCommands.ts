import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {ThreadedBinding} from '@agent-gand/shared';
import type {createThreadedActions} from './actions.ts';
import type {createThreadedCooperation} from './cooperation.ts';
import type {ActionCommandPort,ActionFence,CommandObservation} from './actionTypes.ts';
import {digest,object,reject,text,type CollaborationOptions} from './collaborationTypes.ts';

type Command={id:string;owner_id:string;thread_id:string;agent_id:string;action_id:string;generation:number;
  binding_id:string;port:string;authorization:string;args:string;source_record:string;state:string;version:number;result:string|null};
/** Only server-registered commands are executable. Rebuilding this service observes durable unknown work, never restarts it. */
export function createActionCommands(db:Database.Database,options:CollaborationOptions&{
  actions:ReturnType<typeof createThreadedActions>;cooperation:ReturnType<typeof createThreadedCooperation>;
  ports?:Record<string,ActionCommandPort>;
}) {
  const {actions,cooperation:c}=options,now=options.now??Date.now;
  const scope=(r:Command)=>({ownerId:r.owner_id,threadId:r.thread_id,agentId:r.agent_id});
  const fence=(r:Command):ActionFence=>({actionId:r.action_id,generation:r.generation});
  const row=(id:string)=>db.prepare('SELECT * FROM threaded_commands WHERE id=?').get(id) as Command|undefined;
  const terminal=(r:Command)=>['completed','failed','cancelled'].includes(r.state);
  function port(r:Command){const p=options.ports?.[r.port];if(!p||p.authorization(scope(r))!==r.authorization)reject('THREADED_COMMAND_AUTHORITY_CHANGED',403);return p;}
  function settleWithin(r:Command,value:CommandObservation){
    if(terminal(r))return;
    if(!['running','unknown','completed','failed','cancelled'].includes(value.state))reject('THREADED_COMMAND_OBSERVATION_INVALID');
    text(value.evidenceRef,1000);
    if(r.state===value.state&&r.result&&digest(JSON.parse(r.result))===digest(value)){deliverWithin(r);return;}
    db.prepare('INSERT INTO threaded_command_events VALUES(?,?,?,?)').run(randomUUID(),r.id,JSON.stringify(value),now());
    db.prepare('UPDATE threaded_commands SET state=?,version=version+1,result=?,updated_at=? WHERE id=? AND version=?')
      .run(value.state,JSON.stringify(value),now(),r.id,r.version);
    deliverWithin(row(r.id)!);
  }
  function deliverWithin(r:Command){
    const wait=db.prepare("SELECT * FROM threaded_command_waits WHERE command_id=? AND state='awaiting'").get(r.id) as {record:string;parent_invocation_id:string}|undefined;
    if(!wait)return;
    const current=actions.valid(fence(r),r.agent_id);
    if(!current){db.prepare("UPDATE threaded_command_waits SET state='stale' WHERE command_id=?").run(r.id);return;}
    if(!terminal(r))return;
    const config=JSON.parse(wait.record) as {binding:ThreadedBinding;scope:ReturnType<typeof c.boundary>;frozen:ReturnType<typeof c.frozen>};
    c.callback('command',`command:${r.id}`,config.binding,r.agent_id,JSON.stringify({type:'command_terminal',commandId:r.id,
      actionId:r.action_id,generation:r.generation,state:r.state,result:r.result?JSON.parse(r.result):null,businessConditionVerified:false}),config.scope,{frozen:config.frozen});
    db.prepare("UPDATE threaded_command_waits SET state='delivered' WHERE command_id=?").run(r.id);c.recoverWithin();
  }
  async function execute(binding:ThreadedBinding,name:string,value:unknown):Promise<unknown>{
    c.running(binding,true);const input=object(value),key=text(input.idempotencyKey),hash=digest({name,input});
    const stored=db.prepare('SELECT request_hash,record FROM threaded_action_operations WHERE binding_id=? AND request_key=?').get(binding.id,key) as {request_hash:string;record:string}|undefined;
    if(stored){if(stored.request_hash!==hash)reject('THREADED_ACTION_IDEMPOTENCY_CONFLICT');return JSON.parse(stored.record);}
    let command:Command,reused=false;
    const result=c.transaction(()=>{
      c.running(binding,true);
      const committed=db.prepare('SELECT request_hash,record FROM threaded_action_operations WHERE binding_id=? AND request_key=?').get(binding.id,key) as {request_hash:string;record:string}|undefined;
      if(committed){if(committed.request_hash!==hash)reject('THREADED_ACTION_IDEMPOTENCY_CONFLICT');reused=true;return JSON.parse(committed.record) as {commandId:string;state:string;actionId:string;generation:number};}
      c.running(binding);actions.assertBinding(binding);
      if(name==='run_command'){
        const a=actions.held(binding,input),name=text(input.command),p=options.ports?.[name],authorization=p?.authorization(binding);
        if(!p||!authorization)reject('THREADED_COMMAND_NOT_AUTHORIZED',403);
        p.validate(input.args);const id=randomUUID();
        db.prepare("INSERT INTO threaded_commands VALUES(?,?,?,?,?,?,?,?,?,?,?,'unknown',1,NULL,?,?)")
          .run(id,binding.ownerId,binding.threadId,binding.agentId,a.id,a.generation,binding.id,name,authorization,JSON.stringify(input.args??null),JSON.stringify(c.boundary(binding)),now(),now());
        command=row(id)!;
      }else{
        command=row(text(input.commandId))??reject('THREADED_COMMAND_NOT_FOUND',404);
        if(command.owner_id!==binding.ownerId||command.thread_id!==binding.threadId||command.agent_id!==binding.agentId)reject('THREADED_COMMAND_NOT_FOUND',404);
        const a=actions.held(binding,input);if(a.id!==command.action_id||a.generation!==command.generation)reject('THREADED_ACTION_STALE_GENERATION');
        port(command);
      }
      if(name==='wait_command'){
        const original=JSON.parse(command.source_record) as {sourceRefs:string[]};
        db.prepare("INSERT OR IGNORE INTO threaded_command_waits VALUES(?,?,?,'awaiting')").run(command.id,binding.invocationId,
          JSON.stringify({binding,scope:c.boundary(binding,original.sourceRefs),frozen:c.frozen(binding)}));deliverWithin(command);
      }
      // Persist the operation before external IO. A crash leaves unknown; the same key never starts again.
      const answer={commandId:command.id,state:command.state,actionId:command.action_id,generation:command.generation,
        ...(name==='wait_command'?{waitRegistered:true}:{})};
      db.prepare('INSERT INTO threaded_action_operations VALUES(?,?,?,?)').run(binding.id,key,hash,JSON.stringify(answer));return answer;
    });
    if(reused||name==='wait_command')return result;
    if(terminal(command!))return result;
    const r=command!,p=port(r);let observation:CommandObservation;
    try{observation=name==='run_command'?await p.start({commandId:r.id,binding,args:JSON.parse(r.args)}):await p.cancel({commandId:r.id,scope:scope(r)});}
    catch{observation={state:'unknown',evidenceRef:'registered-command-transport-unknown'};}
    c.transaction(()=>{const latest=row(r.id)!;
      // A revoked capability never verifies a result. Retain unknown and an audit marker.
      if(p.authorization(scope(r))!==r.authorization)observation={state:'unknown',evidenceRef:'command-authority-changed'};
      settleWithin(latest,observation);});
    return {...result,state:observation.state};
  }
  async function recover(){const results:Array<{commandId:string;state:string}>=[];
    for(const r of db.prepare("SELECT * FROM threaded_commands WHERE state IN ('running','unknown')").all() as Command[]){
      try{const p=port(r),observation=await p.observe({commandId:r.id,scope:scope(r)});
        c.transaction(()=>{const latest=row(r.id)!;if(p.authorization(scope(r))!==r.authorization)reject('THREADED_COMMAND_AUTHORITY_CHANGED',403);settleWithin(latest,observation);});
        results.push({commandId:r.id,state:row(r.id)!.state});
      }catch{results.push({commandId:r.id,state:'unknown'});}
    }
    c.transaction(()=>{for(const r of db.prepare('SELECT c.* FROM threaded_commands c JOIN threaded_command_waits w ON w.command_id=c.id WHERE w.state=\'awaiting\'').all() as Command[])deliverWithin(r);});
    return results;
  }
  return {execute,recover};
}
