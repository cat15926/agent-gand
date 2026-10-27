import path from 'node:path';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

// Isolated, fresh-PID recovery and broker worker. Never loads account material
// or executes a provider/native backend. Production facts are read from the
// parent's temporary SQLite database, with a controlled acceptance clock.
if (!process.send || !process.env.RC08_COOPERATION_ROOT) throw new Error('RC08_COOPERATION_ISOLATION_REQUIRED');
Object.assign(process.env, { AGENT_GAND_ISOLATED_WORKER:'1', NODE_ENV:'test', LOG_LEVEL:'silent',
  DB_PATH:path.join(process.env.RC08_COOPERATION_ROOT,'unused-worker.sqlite'),
  AGENTS_DIR:path.join(process.env.RC08_COOPERATION_ROOT,'agents') });
let networkCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw new Error('RC08_COOPERATION_NETWORK_FORBIDDEN');};
const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
const {verifyThreadedBackendResourceEvidence}=await import('../../apps/server/src/threaded/backends/evidence.ts');
const {createThreadedBackendRuntime}=await import('../../apps/server/src/threaded/backendRuntime.ts');
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../../apps/server/src/threaded/tools.ts');
const tables=['threaded_consultations','threaded_consultation_targets','threaded_consultation_settlements',
  'threaded_collaboration_callbacks','threaded_outbox','threaded_outbox_receipts','threaded_wake_queue'];
const send=value=>new Promise(resolve=>process.send({...value,pid:process.pid,networkCalls},resolve));
let db,runtime;
process.once('message',async input=>{
  try{
    db=new Database(input.file,{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
    let resources;resources=createExecutionResourceCoordinator(db,{ownerNonce:`rc08-worker:${process.pid}`,now:()=>input.clock,
      verifyEvidence:(_request,claim,evidence)=>{const saved=resources.getClaim(claim.claimId);return !!saved&&verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
    runtime=createThreadedBackendRuntime(db,{resources,now:()=>input.clock,dispatchEnabled:false,autoStart:false,repairIntervalMs:0,
      resolveAgent(){throw new Error('RC08_WORKER_BACKEND_FORBIDDEN');},fetch:globalThis.fetch});
    await send({type:'ready'});
    await new Promise(resolve=>process.once('message',resolve));
    let result;
    if(input.operation==='terminal')result=runtime.lifecycle.recordOutcome(input.binding,input.outcome);
    else if(input.operation==='tool')result=JSON.parse(await runtime.collaboration.tools.execute(input.binding,input.name,input.input,input.requestKey,THREADED_APPLICATION_TOOL_NAMES));
    else if(input.operation==='resume-auto'||input.operation==='resume-auto-fault'){
      const before=db.prepare('SELECT state FROM threaded_collaboration_callbacks WHERE source_id=?').get(input.groupId);
      if(input.operation==='resume-auto-fault')db.exec("CREATE TRIGGER rc08_auto_repair_fault BEFORE INSERT ON threaded_messages WHEN NEW.origin='system' BEGIN SELECT RAISE(ABORT,'rc08_auto_repair_fault'); END;");
      const control=runtime.lifecycle.requestControl({ownerId:input.ownerId,scope:{kind:'member',threadId:input.threadId,agentId:input.agentId},action:'resume',requestId:'rc08-worker-resume'});
      const until=Date.now()+7000;let state,repairFailureObserved=false;
      do{state=db.prepare('SELECT state FROM threaded_collaboration_callbacks WHERE source_id=?').get(input.groupId)?.state;
        if(input.operation==='resume-auto-fault'&&!repairFailureObserved&&runtime.collaboration.diagnostics().lastError){
          repairFailureObserved=true;db.exec('DROP TRIGGER rc08_auto_repair_fault');
        }
        if(state==='delivered')break;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<until);
      result={before:before.state,control,state,repairFailureObserved,finalDiagnostics:runtime.collaboration.diagnostics(),explicitRecoveryCalls:0};
    }
    else if(input.operation==='notify-crash'||input.operation==='notify'){
      const observations=[];
      for(let i=0;i<200;i++){
        const next=runtime.messaging.outbox.dispatchOne(`rc08-${process.pid}`,'rc08-notification-consumer',hint=>{
          if(hint.eventId!==input.eventId)return;
          observations.push(hint);
          // This synchronous production notifier has delivered the hint to IPC,
          // but cannot reach ACK before the process is killed.
          if(input.operation==='notify-crash'){
            process.send({type:'notice-before-ack',pid:process.pid,networkCalls,hint});
            process.kill(process.pid,'SIGKILL');
          }
        });
        if(next.status==='empty'||observations.length)break;
      }
      result={observations};
    }else if(input.operation==='scan'){
      runtime.queue.scanPending();runtime.queue.scanPending();result={scanned:true};
    }else{
      result=runtime.collaboration.cooperation.recover();
      runtime.collaboration.cooperation.recover();
    }
    const snapshot=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    await send({type:'result',result,snapshot,foreignKeys:db.pragma('foreign_key_check')});
    if(input.operation==='recover-crash')process.kill(process.pid,'SIGKILL');
    runtime.close();db.close();process.disconnect();
  }catch(error){
    await send({type:'error',error:error.code??error.message,message:error.message});
    runtime?.close();if(db?.open)db.close();process.disconnect();process.exitCode=1;
  }
});
