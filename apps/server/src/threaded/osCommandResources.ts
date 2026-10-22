import type Database from 'better-sqlite3';
import type {ThreadedBinding} from '@agent-gand/shared';
import type {createExecutionResourceCoordinator} from '../execution/resources/coordinator.ts';
import {createThreadedAuthority} from './authority.ts';
import type {ThreadedClaimIdentity} from './contracts.ts';
import type {ThreadedOsCommandLease} from './osCommands.ts';

/** An OS command owns a separate workspace lease and never claims an Invocation execution slot. */
export function createThreadedOsCommandResources(db:Database.Database,resources:ReturnType<typeof createExecutionResourceCoordinator>):ThreadedOsCommandLease {
  const authority=createThreadedAuthority(db,resources);
  function assertAction(commandId:string,binding:ThreadedBinding){
    if(!db.prepare(`SELECT 1 FROM threaded_commands c JOIN threaded_actions a ON a.id=c.action_id
      JOIN threaded_action_holders h ON h.action_id=a.id AND h.generation=a.generation AND h.agent_id=c.agent_id
      WHERE c.id=? AND c.binding_id=? AND c.owner_id=? AND c.thread_id=? AND c.agent_id=?
        AND a.owner_id=c.owner_id AND a.thread_id=c.thread_id AND a.generation=c.generation
        AND a.state='active' AND h.outcome IS NULL`).get(commandId,binding.id,binding.ownerId,binding.threadId,binding.agentId))
      throw new Error('THREADED_OS_COMMAND_ACTION_GENERATION_CHANGED');
  }
  function sourceBinding(claim:ThreadedClaimIdentity):ThreadedBinding {
    const r=db.prepare(`SELECT b.* FROM threaded_os_commands o JOIN threaded_execution_bindings b ON b.id=o.binding_id
      WHERE json_extract(o.claim_record,'$.claimId')=?`).get(claim.claimId) as {
      id:string;thread_id:string;invocation_id:string;run_id:string;attempt_id:string;owner_id:string;agent_id:string;
      authority_epoch:number;claim_id:string;generation:number;fencing_token:string;
    }|undefined;
    if(!r)throw new Error('THREADED_OS_COMMAND_RESOURCE_BINDING_REQUIRED');
    return {schemaVersion:1,origin:'threaded_invocation_attempt',id:r.id,threadId:r.thread_id,invocationId:r.invocation_id,runId:r.run_id,
      attemptId:r.attempt_id,ownerId:r.owner_id,agentId:r.agent_id,authorityEpoch:r.authority_epoch,claimId:r.claim_id,generation:r.generation,fencingToken:r.fencing_token};
  }
  return {
    reserve({commandId,binding,cwd,workspaces}){
      if(!db.inTransaction)throw new Error('THREADED_OS_COMMAND_RESERVATION_TRANSACTION_REQUIRED');
      authority.assertAuthorized(binding);
      assertAction(commandId,binding);
      const command=db.prepare('SELECT registration_id FROM threaded_os_commands WHERE command_id=? AND binding_id=?').get(commandId,binding.id) as {registration_id:string}|undefined;
      if(!command)throw new Error('THREADED_OS_COMMAND_INTENT_REQUIRED');
      const ticket=resources.enqueue({requestKey:`threaded-os-command:${commandId}`,operationId:`threaded-os-command:${commandId}`,
        mode:'threaded',ownerId:binding.ownerId,threadId:binding.threadId,invocationId:binding.invocationId,runId:binding.runId,
        attemptId:binding.attemptId,agentId:binding.agentId,capacity:false,workspaces:workspaces?.map(w=>({...w}))??[{path:cwd,access:'write'}],
        threadedCommand:{commandId,registrationId:command.registration_id}});
      const claim=resources.tryAcquire(ticket.id);
      if(!claim)throw new Error('THREADED_OS_COMMAND_RESOURCE_UNAVAILABLE');
      return claim;
    },
    assertExecutable(claim){resources.assertExecutable(claim);const binding=sourceBinding(claim);authority.assertAuthorized(binding);
      const command=db.prepare("SELECT command_id FROM threaded_os_commands WHERE json_extract(claim_record,'$.claimId')=?").get(claim.claimId) as {command_id:string}|undefined;
      if(!command)throw new Error('THREADED_OS_COMMAND_RESOURCE_BINDING_REQUIRED');assertAction(command.command_id,binding);},
    markStarted(claim){resources.markStarted(claim);},
    markUnknown(claim){resources.markUnknown(claim);},
    recordQuiescence(claim,evidence){return resources.recordQuiescence(claim,evidence);},
    release(claim,proof){resources.release(claim,proof);},
  };
}
