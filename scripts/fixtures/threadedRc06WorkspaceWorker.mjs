/** Fixed local filesystem probe. This is an acceptance fixture, not a production tool. */
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';
import {createExecutionResourceCoordinator} from '../../apps/server/src/execution/resources/coordinator.ts';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import path from 'node:path';

const [databasePath,ownerNonce,fixtureRoot]=process.argv.slice(2);
if(!databasePath||!ownerNonce||!fixtureRoot||!process.send)throw new Error('RC06_WORKSPACE_FIXED_INPUT_REQUIRED');
const root=realpathSync(fixtureRoot);
const within=(parent,target)=>target===parent||target.startsWith(parent+path.sep);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
globalThis.fetch=async()=>{throw new Error('RC06_WORKSPACE_NETWORK_FORBIDDEN');};
const db=new Database(databasePath,{timeout:10000});db.pragma('foreign_keys=ON');
const resources=createExecutionResourceCoordinator(db,{ownerNonce,leaseMs:60000,validateRequest(){}});
const owned=new Map();
function access(claimId,filename,kind){
  const claim=owned.get(claimId);if(!claim)throw new Error('RC06_WORKSPACE_OWN_CLAIM_REQUIRED');
  resources.assertExecutable(claim);
  const live=resources.getClaim(claimId);
  const canonical=realpathSync(filename);
  if(canonical!==filename||!within(root,canonical))throw new Error('RC06_WORKSPACE_CANONICAL_FIXTURE_PATH_REQUIRED');
  if(!live.request.workspaces?.some(w=>within(w.path,filename)&&(kind==='read'||w.access==='write')))
    throw new Error('RC06_WORKSPACE_DECLARED_ACCESS_REQUIRED');
  return claim;
}
function write(claimId,filename,body){
  // The existing target is canonical and the temporary file remains in its claimed parent.
  access(claimId,filename,'write');
  const temporary=filename+`.rc06-${process.pid}.pending`;
  access(claimId,path.dirname(temporary),'write');
  writeFileSync(temporary,body,{flag:'wx',mode:0o600});renameSync(temporary,filename);
  return {path:filename,sha256:sha(readFileSync(filename)),bytes:Buffer.byteLength(body),pid:process.pid};
}
process.on('message',message=>{
  try{
    let result;
    if(message.operation==='acquire'){
      const claim=resources.tryAcquire(message.ticketId);
      if(claim){owned.set(claim.claimId,claim);resources.markStarted(claim);}
      result=claim;
    }else if(message.operation==='read'){
      access(message.claimId,message.path,'read');const bytes=readFileSync(message.path);
      result={path:message.path,body:bytes.toString('utf8'),sha256:sha(bytes),bytes:bytes.length,pid:process.pid};
    }else if(message.operation==='write')result=write(message.claimId,message.path,message.body);
    else if(message.operation==='candidate'){
      access(message.claimId,message.source,'read');const baseline=readFileSync(message.source);
      const candidate={schemaVersion:1,writer:message.writer,baseVersion:message.baseVersion,baseSha256:sha(baseline),proposedContent:message.proposedContent};
      result={candidate,...write(message.claimId,message.path,JSON.stringify(candidate)+'\n')};
    }else if(message.operation==='merge'){
      access(message.claimId,message.candidatePath,'read');const bytes=readFileSync(message.candidatePath);
      if(sha(bytes)!==message.expectedCandidateSha256)throw new Error('RC06_WORKSPACE_CANDIDATE_CHANGED');
      const candidate=JSON.parse(bytes.toString('utf8'));
      access(message.claimId,message.target,'read');const baseline=readFileSync(message.target);
      if(candidate.baseVersion!==message.baseVersion||candidate.baseSha256!==sha(baseline))throw new Error('RC06_WORKSPACE_BASE_CHANGED');
      result=write(message.claimId,message.target,candidate.proposedContent);
    }else if(message.operation==='close'){
      db.close();process.send({id:message.id,result:true},()=>process.disconnect());return;
    }else throw new Error('RC06_WORKSPACE_OPERATION_FORBIDDEN');
    process.send({id:message.id,result:result??null});
  }catch(error){process.send({id:message.id,error:{code:String(error?.code??error?.message??error)}});}
});
process.on('disconnect',()=>{if(db.open)db.close();});
process.send({ready:true,pid:process.pid});
