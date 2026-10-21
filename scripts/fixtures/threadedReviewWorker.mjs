import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import path from 'node:path';
const [file,clock,prJson]=process.argv.slice(2),pr=JSON.parse(prJson);
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(path.dirname(file),`unused-review-worker-${process.pid}.sqlite`),AGENTS_DIR:path.join(path.dirname(file),'agents')});
const db=new Database(file,{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
const {createExecutionResourceCoordinator}=await import('../../apps/server/src/execution/resources/coordinator.ts');
const {createThreadedBackendRuntime}=await import('../../apps/server/src/threaded/backendRuntime.ts');
const {THREADED_APPLICATION_TOOL_NAMES}=await import('../../apps/server/src/threaded/tools.ts');
const resources=createExecutionResourceCoordinator(db,{ownerNonce:`t11-review-worker:${process.pid}`,now:()=>Number(clock)});
const runtime=createThreadedBackendRuntime(db,{resources,resolveAgent(){throw new Error('No backend starts in CAS workers');},
  fetch:async()=>{throw new Error('No external/model requests');},now:()=>Number(clock),dispatchEnabled:false,autoStart:false,repairIntervalMs:0,
  actions:{pr:{authorize:(scope,repository)=>repository==='test/repo'&&!pr.denied.includes(scope.agentId)?{fingerprint:`pr-role:${pr.authVersions[scope.agentId]??1}:${scope.agentId}`,
    githubLogin:scope.agentId,mayAssign:scope.agentId==='api-member'}:null,
    current:async(_scope,s)=>({repository:s.repository,number:s.number,headSha:pr.head,authorLogin:pr.authorLogin,updatedAt:'2026-10-21'})}}});
process.send?.({type:'ready'});
process.once('message',async message=>{try{const answer=JSON.parse(await runtime.collaboration.tools.execute(message.binding,message.name,message.input,message.key,THREADED_APPLICATION_TOOL_NAMES));process.send?.({type:'result',answer});}
  catch(error){process.send?.({type:'result',error:{code:error.code,message:error.message}});}finally{runtime.close();db.close();process.disconnect();}});
