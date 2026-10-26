/** Real local files and independent SQLite processes; no production engineering-write tool is implied. */
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {applyOrchestrationSchemaMigrations} from '../apps/server/src/db/orchestrationMigrations.ts';
import {createThreadedStore} from '../apps/server/src/threaded/store.ts';
import {createThreadedAuthority} from '../apps/server/src/threaded/authority.ts';
import {createThreadedLifecycle} from '../apps/server/src/threaded/lifecycle.ts';
import {createExecutionResourceCoordinator} from '../apps/server/src/execution/resources/coordinator.ts';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'threaded-rc06-workspace-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-singleton.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const originalFetch=globalThis.fetch;let forbiddenNetwork=0;
globalThis.fetch=async()=>{forbiddenNetwork++;throw new Error('RC06_WORKSPACE_NETWORK_FORBIDDEN');};
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
const databases=[],workers=[],checks=[],events=[],claims=[],pids=new Set();
const sha=body=>createHash('sha256').update(body).digest('hex');
const relative=filename=>path.relative(root,filename);

async function fixture(name){
  const directory=path.join(root,name);await mkdir(directory);
  const project=path.join(directory,'project'),sourceDir=path.join(project,'src'),artifacts=path.join(directory,'artifacts');
  await mkdir(sourceDir,{recursive:true});await mkdir(artifacts);await writeFile(path.join(sourceDir,'source.txt'),'base version 1\n');
  const databasePath=path.join(directory,'resources.sqlite'),db=new Database(databasePath,{timeout:10000});databases.push(db);
  db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');db.exec(schema);db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');applyOrchestrationSchemaMigrations(db);
  const stamp=new Date().toISOString();
  for(const agentId of ['author-a','author-b','merge-owner','reader-c'])db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(agentId,agentId,JSON.stringify({id:agentId,name:agentId,model:'mock:fixture',tools:[],permissionMode:'readonly',enabled:true}),'rc06-workspace',stamp,stamp);
  const store=createThreadedStore(db),ownerId=store.getInstanceOwnerId();
  const receipts=new Map();
  let resources;resources=createExecutionResourceCoordinator(db,{ownerNonce:`rc06-host:${randomUUID()}`,leaseMs:60000,validateRequest(){},
    verifyEvidence:(_request,identity,evidence)=>receipts.get(identity.claimId)?.reference===evidence.reference&&receipts.get(identity.claimId)?.stopped===true});
  const lifecycle=createThreadedLifecycle(db,createThreadedAuthority(db,resources),{resources});
  const thread=store.createThread({title:name,members:['author-a','author-b','merge-owner','reader-c'].map(agentId=>({agentId,handle:agentId,roleVersion:1,permissionVersion:1}))});
  db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(thread.id);
  function ticket(agentId,workspaces){
    const invocation=lifecycle.createInvocation({ownerId,threadId:thread.id,agentId,causalRootId:`root:${name}`,goal:name,requestId:randomUUID()});
    const operationId=randomUUID();
    return resources.enqueue({requestKey:operationId,operationId,mode:'threaded',ownerId,threadId:thread.id,agentId,runId:invocation.runId,
      invocationId:invocation.id,attemptId:randomUUID(),capacity:true,workspaces});
  }
  async function release(worker,claim,expectedFiles=[]){
    await worker.close();assert.equal(worker.exit.signal,null);assert.equal(worker.exit.code,0);
    const observed=[];
    for(const expected of expectedFiles){const body=await readFile(expected.path);assert.equal(sha(body),expected.sha256);observed.push({path:relative(expected.path),sha256:sha(body),bytes:body.length});}
    const reference=`rc06-independent-host:${randomUUID()}`;
    receipts.set(claim.claimId,{reference,stopped:true,pid:worker.pid,observed});
    const proof=resources.recordQuiescence(claim,{reason:'process_exited',sideEffects:'reconciled',reference});resources.release(claim,proof);
    claims.push({claimId:claim.claimId,generation:claim.generation,pid:worker.pid,state:resources.getClaim(claim.claimId).state,observed});
  }
  return {directory,project,sourceDir,source:path.join(sourceDir,'source.txt'),artifacts,databasePath,db,resources,ticket,release};
}
async function openWorker(f){
  const child=fork(fileURLToPath(new URL('./fixtures/threadedRc06WorkspaceWorker.mjs',import.meta.url)),[f.databasePath,`rc06-worker:${randomUUID()}`,f.directory],{
    execArgv:['--import',fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url))],
    env:{PATH:process.env.PATH,NODE_ENV:'test',LOG_LEVEL:'silent'},stdio:['ignore','ignore','pipe','ipc']});
  let sequence=0,stderr='';const pending=new Map();
  let resolveReady,rejectReady;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  let resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const worker={pid:child.pid,exit:null,
    call(operation,args={}){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.send({id,operation,...args});});},
    async close(){if(child.connected)await worker.call('close');await closed;},
    kill(){if(child.connected)child.kill('SIGKILL');return closed;}};
  child.stderr.on('data',bytes=>{stderr+=bytes.toString();});
  child.on('message',message=>{if(message.ready){assert.equal(message.pid,child.pid);pids.add(child.pid);resolveReady();return;}const waiter=pending.get(message.id);if(!waiter)return;pending.delete(message.id);
    if(message.error)waiter.reject(new Error(message.error.code));else waiter.resolve(message.result);});
  child.on('error',error=>{rejectReady(error);for(const waiter of pending.values())waiter.reject(error);});
  child.on('close',(code,signal)=>{worker.exit={code,signal};if(code!==0){const error=new Error(`RC06 worker exited ${code}/${signal}: ${stderr}`);rejectReady(error);for(const waiter of pending.values())waiter.reject(error);}resolveClosed();});
  workers.push(worker);await ready;return worker;
}
async function acquire(worker,ticket){const claim=await worker.call('acquire',{ticketId:ticket.id});if(claim)events.push({kind:'acquired',pid:worker.pid,claimId:claim.claimId,generation:claim.generation});return claim;}
const held=f=>f.resources.listClaims().filter(c=>c.state!=='released');

try{
  {
    const f=await fixture('shared-read-parent-write'),a=await openWorker(f),b=await openWorker(f),writer=await openWorker(f);
    const first=f.ticket('author-a',[{path:f.project,access:'read'}]),second=f.ticket('author-b',[{path:f.project,access:'read'}]);
    const [ca,cb0]=await Promise.all([acquire(a,first),acquire(b,second)]);const cb=cb0??await acquire(b,second);
    assert.ok(ca&&cb);assert.notEqual(a.pid,b.pid);
    const reads=await Promise.all([a.call('read',{claimId:ca.claimId,path:f.source}),b.call('read',{claimId:cb.claimId,path:f.source})]);
    assert.deepEqual(reads.map(r=>r.body),['base version 1\n','base version 1\n']);
    assert.equal(held(f).length,2);
    checks.push('RC06-W01: two real worker PIDs read the same canonical engineering project root simultaneously under separate complete SQLite read claims; no per-agent workspace substitutes the shared project');
    const pending=f.ticket('merge-owner',[{path:f.sourceDir,access:'write'}]);
    assert.equal(await acquire(writer,pending),null);assert.equal(held(f).length,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM execution_resource_claims WHERE ticket_id=?').get(pending.id).n,0);
    await f.release(a,ca,[{path:f.source,sha256:sha('base version 1\n')}]);assert.equal(await acquire(writer,pending),null);
    await f.release(b,cb,[{path:f.source,sha256:sha('base version 1\n')}]);
    const cw=await acquire(writer,pending);assert.ok(cw);
    const output=await writer.call('write',{claimId:cw.claimId,path:f.source,body:'serialized version 2\n'});
    await f.release(writer,cw,[output]);assert.equal(await readFile(f.source,'utf8'),'serialized version 2\n');
    checks.push('RC06-W02: parent-root readers block a real child-directory writer without partial claims; one reader stopping is insufficient; both independent process exits plus host file receipts permit the original writer ticket and exact serialized content');
  }
  {
    const f=await fixture('child-write-parent-read'),writer=await openWorker(f),reader=await openWorker(f);
    const tw=f.ticket('author-a',[{path:f.sourceDir,access:'write'}]),cw=await acquire(writer,tw);assert.ok(cw);
    const tr=f.ticket('author-b',[{path:f.project,access:'read'}]);assert.equal(await acquire(reader,tr),null);
    const outside=await openWorker(f),artifact=path.join(f.artifacts,'independent.txt');await writeFile(artifact,'before\n');
    const independent=f.ticket('reader-c',[{path:f.artifacts,access:'write'}]),ci=await acquire(outside,independent);assert.ok(ci);
    const artifactReceipt=await outside.call('write',{claimId:ci.claimId,path:artifact,body:'parallel isolated artifact\n'});
    await f.release(outside,ci,[artifactReceipt]);
    const cursor=f.resources.scanPending().cursor;
    const receipt=await writer.call('write',{claimId:cw.claimId,path:f.source,body:'child writer completed\n'});await f.release(writer,cw,[receipt]);
    assert.ok(f.resources.scanPending(cursor).events.some(event=>event.reason==='released'&&event.agentId==='author-a'));
    const cr=await acquire(reader,tr);assert.ok(cr);assert.equal((await reader.call('read',{claimId:cr.claimId,path:f.source})).body,'child writer completed\n');
    await f.release(reader,cr,[receipt]);
    checks.push('RC06-W03: an actual child write claim blocks a parent read while a disjoint artifact path can write in another PID; releasing the child publishes durable availability and re-admits the same original parent ticket with the updated bytes');
  }
  {
    const f=await fixture('isolated-versioned-artifacts'),sourceSha=sha(await readFile(f.source));
    const artifactA=path.join(f.artifacts,'author-a'),artifactB=path.join(f.artifacts,'author-b');await mkdir(artifactA);await mkdir(artifactB);
    const targetA=path.join(artifactA,'candidate.json'),targetB=path.join(artifactB,'candidate.json');await writeFile(targetA,'{}\n');await writeFile(targetB,'{}\n');
    const a=await openWorker(f),b=await openWorker(f);
    const ta=f.ticket('author-a',[{path:f.project,access:'read'},{path:artifactA,access:'write'}]),tb=f.ticket('author-b',[{path:f.project,access:'read'},{path:artifactB,access:'write'}]);
    const [ca,cb0]=await Promise.all([acquire(a,ta),acquire(b,tb)]);const cb=cb0??await acquire(b,tb);assert.ok(ca&&cb);
    const [ra,rb]=await Promise.all([a.call('candidate',{claimId:ca.claimId,source:f.source,path:targetA,writer:'author-a',baseVersion:1,proposedContent:'selected authored result\n'}),
      b.call('candidate',{claimId:cb.claimId,source:f.source,path:targetB,writer:'author-b',baseVersion:1,proposedContent:'alternative authored result\n'})]);
    assert.equal(ra.candidate.baseSha256,sourceSha);assert.equal(rb.candidate.baseSha256,sourceSha);
    await Promise.all([f.release(a,ca,[ra]),f.release(b,cb,[rb])]);
    assert.equal(sha(await readFile(f.source)),sourceSha);
    checks.push('RC06-W04: two real PIDs keep the engineering project read-only and concurrently publish distinct artifacts outside the shared root; both artifacts carry author identity, identical base version/hash and host-verified content hashes');
    // Deliberately a fixture protocol: no product merge endpoint or arbitrary-write grant is introduced.
    const contract={schemaVersion:1,mergeOwner:'merge-owner',target:relative(f.source),version:1,sha256:sourceSha};
    async function merge(actor,receipt){
      assert.equal(actor,contract.mergeOwner,'RC06_MERGE_OWNER_REQUIRED');
      const candidate=JSON.parse(await readFile(receipt.path,'utf8'));
      assert.equal(sha(await readFile(receipt.path)),receipt.sha256,'RC06_CANDIDATE_HASH_REQUIRED');
      assert.equal(candidate.baseVersion,contract.version,'RC06_MERGE_BASE_VERSION_CHANGED');
      assert.equal(candidate.baseSha256,contract.sha256,'RC06_MERGE_BASE_HASH_CHANGED');
      const worker=await openWorker(f),ticket=f.ticket(actor,[{path:f.project,access:'write'},{path:path.dirname(receipt.path),access:'read'}]);
      const claim=await acquire(worker,ticket);assert.ok(claim);
      const result=await worker.call('merge',{claimId:claim.claimId,target:f.source,candidatePath:receipt.path,expectedCandidateSha256:receipt.sha256,baseVersion:contract.version});
      await f.release(worker,claim,[result,receipt]);contract.version++;contract.sha256=result.sha256;
      return result;
    }
    const before=f.db.prepare('SELECT COUNT(*) n FROM execution_resource_tickets').get().n;
    await assert.rejects(()=>merge('author-b',ra),/RC06_MERGE_OWNER_REQUIRED/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM execution_resource_tickets').get().n,before);
    const merged=await merge('merge-owner',ra);assert.equal(contract.version,2);assert.equal(await readFile(f.source,'utf8'),'selected authored result\n');
    const after=f.db.prepare('SELECT COUNT(*) n FROM execution_resource_tickets').get().n;
    await assert.rejects(()=>merge('merge-owner',rb),/RC06_MERGE_BASE_VERSION_CHANGED/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM execution_resource_tickets').get().n,after);
    assert.equal(sha(await readFile(f.source)),merged.sha256);
    events.push({kind:'fixture-merge',owner:contract.mergeOwner,baseVersion:1,version:contract.version,baseSha256:sourceSha,sha256:contract.sha256});
    checks.push('RC06-W05: an explicitly fixture-only unique merge-owner/version protocol rejects a second author before enqueue, serializes the selected artifact under a project write claim, advances version 1→2 and rejects the other stale-base artifact without overwriting the merged result');
  }
  const {verifyRc06ProductionWorkspace}=await import('./fixtures/threadedRc06ProductionWorkspace.mjs');
  const production=await verifyRc06ProductionWorkspace(root);checks.push(...production.checks);
  assert.equal(forbiddenNetwork,0);
  const report={ok:true,groups:checks.length,checks,realWorkerPids:[...pids],realWorkerProcesses:pids.size,claims,events,
    externalNetworkCalls:forbiddenNetwork,realModelCalls:0,realModelTokens:0,dailyDatabaseOpened:false,dailyProjectTouched:false,
    engineeringSharedProjectPath:true,productionProjectBindingVerified:production.productionProjectBindingVerified,production,
    productionEngineeringWriteOrMergeTool:false,mergeProtocol:'explicit acceptance fixture only; unique owner/base version/hash, no crash-safe product merge workflow claimed',
    scope:'Real temporary local project files and independent OS processes using the durable production resource coordinator, plus the actual production factory/registered native profile with injected model transport. No per-agent path is used as evidence of shared engineering project binding.'};
  const output=process.env.THREADED_RC06_WORKSPACE_OUTPUT;
  if(output){await mkdir(path.dirname(path.resolve(output)),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');}
  console.log(JSON.stringify(report,null,2));
}finally{
  for(const worker of workers)if(!worker.exit)await worker.kill();for(const db of databases)if(db.open)db.close();
  globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});
}
