import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import path from 'node:path';
const [file,clock,mode]=process.argv.slice(2);
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(path.dirname(file),'unused-worker.sqlite'),AGENTS_DIR:path.join(path.dirname(file),'agents')});
const db=new Database(file,{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../../apps/server/src/threaded/backends/evidence.ts');
const {createThreadedBackendRuntime}=await import('../../apps/server/src/threaded/backendRuntime.ts');
let resources;resources=createExecutionResourceCoordinator(db,{ownerNonce:`t08-worker:${process.pid}`,now:()=>Number(clock),verifyEvidence:(_request,claim,evidence)=>{
  const saved=resources.getClaim(claim.claimId);return !!saved&&verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
const runtime=createThreadedBackendRuntime(db,{resources,resolveAgent(){throw new Error('A recovery worker cannot start a backend');},
  fetch:async()=>{throw new Error('No model/network replay');},now:()=>Number(clock),dispatchEnabled:false,autoStart:false,repairIntervalMs:0});
process.send?.({type:'ready'});
await new Promise(resolve=>process.once('message',resolve));
if(mode==='terminal'){
  const row=db.prepare(`SELECT b.*,q.proof FROM threaded_attempts a JOIN threaded_execution_bindings b ON b.attempt_id=a.id
    JOIN execution_resource_quiescence q ON q.claim_id=b.claim_id WHERE a.status='running' ORDER BY a.rowid DESC LIMIT 1`).get();
  const binding={schemaVersion:1,origin:'threaded_invocation_attempt',id:row.id,ownerId:row.owner_id,threadId:row.thread_id,agentId:row.agent_id,
    invocationId:row.invocation_id,runId:row.run_id,attemptId:row.attempt_id,authorityEpoch:row.authority_epoch,
    claimId:row.claim_id,generation:row.generation,fencingToken:row.fencing_token};
  runtime.lifecycle.recordOutcome(binding,{kind:'completed',content:'competing last response',budgetState:'unknown',quiescence:JSON.parse(row.proof)});
}else runtime.collaboration.cooperation.recover();
process.send?.({type:'committed',settlements:db.prepare('SELECT COUNT(*) n FROM threaded_consultation_settlements').get().n,
  callbacks:db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks').get().n});
// Exit before outbox dispatch/ACK. The parent checks the real crash boundary.
process.exit(32);
