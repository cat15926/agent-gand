import path from 'node:path';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

if (!process.send || !process.env.RC10_CHAIN_ROOT) throw new Error('RC10_CHAIN_ISOLATION_REQUIRED');
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',
  DB_PATH:path.join(process.env.RC10_CHAIN_ROOT,'unused-worker.sqlite'),AGENTS_DIR:path.join(process.env.RC10_CHAIN_ROOT,'agents')});
let networkCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw new Error('RC10_CHAIN_NETWORK_FORBIDDEN');};
const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../../apps/server/src/threaded/backends/evidence.ts');
const {createThreadedBackendRuntime}=await import('../../apps/server/src/threaded/backendRuntime.ts');
const send=value=>new Promise(resolve=>process.send({...value,pid:process.pid,networkCalls},resolve));
process.once('message',async input=>{
  let db,runtime;
  try{
    db=new Database(input.file,{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
    let resources;resources=createExecutionResourceCoordinator(db,{ownerNonce:`rc10-chain:${process.pid}`,now:()=>input.clock,
      verifyEvidence:(_request,claim,evidence)=>{const saved=resources.getClaim(claim.claimId);return !!saved&&verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
    runtime=createThreadedBackendRuntime(db,{resources,now:()=>input.clock,dispatchEnabled:false,autoStart:false,repairIntervalMs:0,
      resolveAgent(){throw new Error('RC10_CHAIN_BACKEND_FORBIDDEN');},fetch:globalThis.fetch});
    await send({type:'ready'});
    await new Promise(resolve=>process.once('message',resolve));
    const result=runtime.collaboration.cooperation.recover();
    runtime.collaboration.cooperation.recover();runtime.queue.scanPending();
    await send({type:'result',result,settlements:db.prepare('SELECT * FROM threaded_consultation_settlements').all(),
      callbacks:db.prepare('SELECT id,kind,source_id,state,message_id,reason FROM threaded_collaboration_callbacks').all(),foreignKeys:db.pragma('foreign_key_check')});
    if(input.crashAfterCommit)process.kill(process.pid,'SIGKILL');
    runtime.close();db.close();process.disconnect();
  }catch(error){await send({type:'error',error:error.code??error.message,message:error.message});runtime?.close();if(db?.open)db.close();process.disconnect();process.exitCode=1;}
});
