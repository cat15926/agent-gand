import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, chmod } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root=realpathSync(await mkdtemp(path.join(tmpdir(),'gand-snapshots-r3-')));
Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(root,'db.sqlite'),AGENTS_DIR:path.join(root,'roles'),
  AGENT_GAND_ISOLATED_WORKER:'1',AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),LOG_LEVEL:'silent',MCP_SERVER_CMD:'',
  COORDINATION_RUNTIME_KERNEL:process.argv.includes('--kernel-off')?'off':'execute',HOST:'127.0.0.1',PORT:'43220',ACCOUNT_MASTER_KEY:'',ACCOUNT_ADMIN_TOKEN:''});
globalThis.fetch=()=>{throw new Error('R3 fixture prohibits real network/providers');};
const {config}=await import('../apps/server/src/config.ts');config.sandboxDir=path.join(root,'sandbox');
const db=await import('../apps/server/src/db/database.ts');
const registry=await import('../apps/server/src/agents/registry.ts');
const rooms=await import('../apps/server/src/conversations/service.ts');
const trace=await import('../apps/server/src/runs/trace.ts');
const snapshots=await import('../apps/server/src/artifacts/snapshots.ts');
const artifacts=await import('../apps/server/src/artifacts/store.ts');
const evidence=await import('../apps/server/src/runtime/evidence.ts');
const entry=await import('../apps/server/src/orchestration/entry.ts');
const business=await import('../apps/server/src/orchestration/business.ts');
const coordination=await import('../apps/server/src/coordination/runtime.ts');
const checkpointStore=await import('../apps/server/src/orchestration/businessCheckpointStore.ts');
const continuation=await import('../apps/server/src/orchestration/continuation.ts');
const {mockProvider}=await import('../apps/server/src/llm/provider.ts');
const {default:Fastify}=await import('../apps/server/node_modules/fastify/fastify.js');
const {registerRoutes}=await import('../apps/server/src/api/routes.ts');
const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');
const app=Fastify();await registerRoutes(app);await registerAccountRoutes(app);
for(const id of ['worker','observer'])registry.createAgent({id,name:id,description:'snapshot fixture',systemPrompt:'Deliver substantive results.',model:'mock:'+id,
  capabilities:['execute'],permissionMode:'readonly',tools:['fs.read'],disallowedTools:[],color:'#4477aa',avatar:''});
const room=rooms.createConversation({title:'R3 owner snapshot audit',mode:'collaboration',agentIds:['worker','observer']});
function terminalRun(){const r=trace.createRun('archive declared outputs','collaboration',room.agentIds,null,null,room.id);trace.finishRun(r.id,'completed');return r;}
const source=terminalRun(),sourceRoot=path.join(config.sandboxDir,'runs',source.id);await mkdir(sourceRoot,{recursive:true});
const git=(args,cwd=sourceRoot)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const code=(fn,value)=>assert.throws(fn,e=>e.code===value,e=>String(e));
try {
  git(['init','--template=','--quiet']);git(['config','user.name','R3 fixture']);git(['config','user.email','r3@example.invalid']);
  await writeFile(path.join(sourceRoot,'changed.txt'),'BASE');await writeFile(path.join(sourceRoot,'deleted.txt'),'REMOVE');
  await writeFile(path.join(sourceRoot,'unchanged.txt'),'KEEP');await writeFile(path.join(sourceRoot,'omitted-change.txt'),'BASE OMITTED');
  git(['add','.']);git(['commit','--quiet','-m','baseline']);
  // A parent exists but is deliberately absent from the self-contained snapshot pack.
  await writeFile(path.join(sourceRoot,'unchanged.txt'),'KEEP SECOND');git(['add','.']);git(['commit','--quiet','-m','second baseline']);
  const head=git(['rev-parse','HEAD']);
  await writeFile(path.join(sourceRoot,'changed.txt'),'DECLARED CHANGE');await rm(path.join(sourceRoot,'deleted.txt'));
  const binary=Buffer.from([0,255,7,1,8,200]);await writeFile(path.join(sourceRoot,'image.bin'),binary);
  await writeFile(path.join(sourceRoot,'large.bin'),Buffer.alloc(65536,0x7f));await writeFile(path.join(sourceRoot,'omitted-change.txt'),'NOT DECLARED');
  await writeFile(path.join(sourceRoot,'undeclared-secret.txt'),'UNDECLARED_SECRET_NEVER_ARCHIVE');
  await writeFile(path.join(sourceRoot,'.env'),'TOKEN_NEVER_ARCHIVE');await mkdir(path.join(sourceRoot,'.codex'));await writeFile(path.join(sourceRoot,'.codex','auth.json'),'LOGIN_NEVER_ARCHIVE');
  const publicFile=artifacts.createManagedArtifact({runId:source.id,path:'inputs/public.txt',content:Buffer.from('PUBLIC_MANAGED'),access:{visibility:'public',audience:[]},createdBy:'user'});
  const privateFile=artifacts.createManagedArtifact({runId:source.id,path:'inputs/private.bin',content:Buffer.from('PRIVATE_MANAGED_NEVER_CWD'),access:{visibility:'private',audience:['worker']},createdBy:'user'});
  const input={paths:['changed.txt','deleted.txt','image.bin','large.bin'],stageIds:[]};
  const count=()=>db.get('SELECT COUNT(*) n FROM artifact_snapshots').n;
  const before=count(),preview=snapshots.previewArtifactSnapshot(source.id,input);assert.equal(count(),before,'preview is read only');
  assert.equal(preview.snapshot.git.commit,head);assert.equal(preview.snapshot.complete,true);
  assert.deepEqual(preview.snapshot.files.filter(f=>f.storage==='workspace').map(f=>f.change),['modified','deleted','added','added']);
  assert.ok(preview.snapshot.omissions.some(o=>o.path==='omitted-change.txt'));assert.ok(preview.snapshot.omissions.some(o=>o.path==='.env'));
  await chmod(path.join(sourceRoot,'changed.txt'),0o600);code(()=>snapshots.confirmArtifactSnapshot(source.id,{...input,fingerprint:preview.fingerprint}),'SNAPSHOT_STALE');
  const current=snapshots.previewArtifactSnapshot(source.id,input),snapshot=snapshots.confirmArtifactSnapshot(source.id,{...input,fingerprint:current.fingerprint});
  const stored=db.get('SELECT * FROM artifact_snapshots WHERE id=?',snapshot.id);
  assert.doesNotMatch(stored.payload,/PRIVATE_MANAGED_NEVER_CWD|DECLARED CHANGE|TOKEN_NEVER_ARCHIVE/);
  const raw=snapshots.readArtifactSnapshot(snapshot.id);assert.doesNotMatch(JSON.stringify(raw.payload),/UNDECLARED_SECRET_NEVER_ARCHIVE|TOKEN_NEVER_ARCHIVE|LOGIN_NEVER_ARCHIVE/);
  assert.throws(()=>artifacts.readManagedArtifact(privateFile.id,'observer'),/可见范围|授权范围/);
  const restorePreview=snapshots.previewArtifactRestore(snapshot.id),requestId=randomUUID();
  code(()=>snapshots.confirmArtifactRestore(snapshot.id,{fingerprint:'stale',clientRequestId:requestId}),'SNAPSHOT_STALE');
  await writeFile(path.join(sourceRoot,'changed.txt'),'USER CURRENT WORKTREE');
  const restored=snapshots.confirmArtifactRestore(snapshot.id,{fingerprint:restorePreview.fingerprint,clientRequestId:requestId});
  assert.equal(await readFile(path.join(sourceRoot,'changed.txt'),'utf8'),'USER CURRENT WORKTREE','source checkout untouched');
  assert.equal(git(['rev-parse','HEAD'],restored.path),head);assert.equal(git(['rev-parse','--is-shallow-repository'],restored.path),'true');
  assert.equal(await readFile(path.join(restored.path,'changed.txt'),'utf8'),'DECLARED CHANGE');assert.equal(existsSync(path.join(restored.path,'deleted.txt')),false);
  assert.deepEqual(await readFile(path.join(restored.path,'image.bin')),binary);assert.equal((await readFile(path.join(restored.path,'large.bin'))).length,65536);
  assert.equal(await readFile(path.join(restored.path,'omitted-change.txt'),'utf8'),'BASE OMITTED');
  for(const rel of ['undeclared-secret.txt','.env','.codex','inputs/private.bin','inputs/public.txt'])assert.equal(existsSync(path.join(restored.path,rel)),false);
  assert.equal(snapshots.confirmArtifactRestore(snapshot.id,{fingerprint:restorePreview.fingerprint,clientRequestId:requestId}).path,restored.path,'idempotent restore');
  code(()=>snapshots.deleteArtifactSnapshot(snapshot.id,snapshots.snapshotDigest(snapshot)),'SNAPSHOT_RETAINED');
  await chmod(path.join(restored.path,'changed.txt'),0o644);code(()=>snapshots.confirmArtifactRestore(snapshot.id,{fingerprint:restorePreview.fingerprint,clientRequestId:requestId}),'CHECKPOINT_FILE_CHANGED');
  await chmod(path.join(restored.path,'changed.txt'),0o600);await rm(path.join(restored.path,'image.bin'));await symlink(path.join(root,'outside'),path.join(restored.path,'image.bin'));
  code(()=>snapshots.confirmArtifactRestore(snapshot.id,{fingerprint:restorePreview.fingerprint,clientRequestId:requestId}),'CHECKPOINT_FILE_CHANGED');
  await rm(path.join(restored.path,'image.bin'));code(()=>snapshots.confirmArtifactRestore(snapshot.id,{fingerprint:restorePreview.fingerprint,clientRequestId:requestId}),'CHECKPOINT_FILE_CHANGED');
  // Old workspace and its Git object store are removed before cold-process reconstruction.
  await rm(sourceRoot,{recursive:true});
  const cold=execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',
    "const {config}=await import('./apps/server/src/config.ts');config.sandboxDir=process.env.R3_SANDBOX;const s=await import('./apps/server/src/artifacts/snapshots.ts');const p=s.previewArtifactRestore(process.env.R3_SNAPSHOT);const r=s.confirmArtifactRestore(p.snapshot.id,{fingerprint:p.fingerprint,clientRequestId:'cold-process-restore'});console.log(JSON.stringify(r));(await import('./apps/server/src/db/database.ts')).db.close();"],
    {env:{...process.env,R3_SANDBOX:config.sandboxDir,R3_SNAPSHOT:snapshot.id},encoding:'utf8'});
  const coldRestore=JSON.parse(cold);assert.equal(git(['rev-parse','HEAD'],coldRestore.path),head);assert.deepEqual(await readFile(path.join(coldRestore.path,'image.bin')),binary);
  // Authenticated metadata, payload, missing source versions, and unknown snapshot versions fail closed.
  db.run('UPDATE artifact_snapshots SET payload=? WHERE id=?',stored.payload.slice(0,-8),snapshot.id);assert.throws(()=>snapshots.previewArtifactRestore(snapshot.id));db.run('UPDATE artifact_snapshots SET payload=? WHERE id=?',stored.payload,snapshot.id);
  const forged={...snapshot,files:snapshot.files.map(f=>({...f,path:'../escape'}))};db.run('UPDATE artifact_snapshots SET manifest=?,digest=? WHERE id=?',JSON.stringify(forged),snapshots.snapshotDigest(forged),snapshot.id);assert.throws(()=>snapshots.previewArtifactRestore(snapshot.id));db.run('UPDATE artifact_snapshots SET manifest=?,digest=? WHERE id=?',stored.manifest,stored.digest,snapshot.id);
  const managedRow=db.get('SELECT * FROM managed_artifact_versions WHERE id=?',privateFile.id);db.run('UPDATE managed_artifact_versions SET record=? WHERE id=?',JSON.stringify({...privateFile,visibility:'public',audience:[]}),privateFile.id);assert.throws(()=>snapshots.previewArtifactRestore(snapshot.id));db.run('UPDATE managed_artifact_versions SET record=? WHERE id=?',managedRow.record,privateFile.id);
  db.run('DELETE FROM managed_artifact_versions WHERE id=?',privateFile.id);assert.throws(()=>snapshots.previewArtifactRestore(snapshot.id));db.run('INSERT INTO managed_artifact_versions(id,conversation_id,run_id,path,version,record,content,created_at) VALUES(?,?,?,?,?,?,?,?)',managedRow.id,managedRow.conversation_id,managedRow.run_id,managedRow.path,managedRow.version,managedRow.record,managedRow.content,managedRow.created_at);
  const unsafe=terminalRun(),unsafeRoot=path.join(config.sandboxDir,'runs',unsafe.id);await mkdir(unsafeRoot,{recursive:true});
  await writeFile(path.join(root,'outside'),'outside');await symlink(path.join(root,'outside'),path.join(unsafeRoot,'escape'));await link(path.join(root,'outside'),path.join(unsafeRoot,'hard'));
  for(const rel of ['../escape','.codex/auth.json','.env'])code(()=>snapshots.previewArtifactSnapshot(unsafe.id,{paths:[rel]}),rel==='../escape'||rel.includes('.codex')?'SNAPSHOT_PATH_UNSAFE':'SNAPSHOT_SENSITIVE_PATH');
  for(const rel of ['escape','hard'])code(()=>snapshots.previewArtifactSnapshot(unsafe.id,{paths:[rel]}),'SNAPSHOT_FILE_UNSUPPORTED');
  await symlink(root,path.join(unsafeRoot,'parent'));code(()=>snapshots.previewArtifactSnapshot(unsafe.id,{paths:['parent/outside']}),'SNAPSHOT_PATH_UNSAFE');
  const disposable=snapshots.confirmArtifactSnapshot(unsafe.id,{stageIds:[],paths:[],fingerprint:snapshots.previewArtifactSnapshot(unsafe.id,{stageIds:[],paths:[]}).fingerprint});snapshots.deleteArtifactSnapshot(disposable.id,snapshots.snapshotDigest(disposable));assert.equal(db.get('SELECT id FROM artifact_snapshots WHERE id=?',disposable.id),undefined);

  // Complete declared stage manifest and public managed delivery continuation.
  const contract={version:1,executionMode:'stage_gated',stages:[
    {id:'one',title:'file stage',criteria:['complete file'],deliverables:[{id:'file',title:'managed binary',kind:'file'},{id:'proof',title:'source analysis',kind:'text'}],execution:{assignments:[{agentId:'worker',objective:'STAGE_ONE'}]}},
    {id:'two',title:'remaining stage',criteria:['complete analysis'],deliverables:[{id:'text',title:'analysis',kind:'text'}],execution:{assignments:[{agentId:'observer',objective:'STAGE_TWO'}]}}
  ]};
  const inputStage={conversationId:room.id,goal:'staged managed delivery',agentIds:room.agentIds,strategy:'serial',workflow:'routine',constraints:{readonly:true},businessContract:contract,clientRequestId:randomUUID()};
  const plan=await entry.previewExecutionOrchestration(inputStage);const staged=entry.submitExecutionOrchestration({...inputStage,entryVersion:1,previewId:plan.previewId,orchestrationFingerprint:plan.fingerprint},room.id);
  const fullText='Detailed substantive analysis and delivery FULL_TEXT_ARCHIVE_'+ 'x'.repeat(5000);
  let failSecond=true,calls=0;mockProvider.chat=async req=>{calls++;if(failSecond&&req.messages.some(m=>m.content.includes('STAGE_TWO')))throw new Error('fixture remaining step failed');return {content:fullText,usage:{tokensIn:1,tokensOut:1,costUsd:0},toolCalls:[],stopReason:'end_turn'};};
  await coordination.runCoordinationPlan(staged.run,staged.run.goal);
  const missing=snapshots.previewArtifactSnapshot(staged.run.id,{stageIds:['one']});assert.equal(missing.snapshot.complete,false);code(()=>snapshots.confirmArtifactSnapshot(staged.run.id,{stageIds:['one'],fingerprint:missing.fingerprint}),'SNAPSHOT_INCOMPLETE');
  const delivery=artifacts.createManagedArtifact({runId:staged.run.id,path:'reports/delivery.bin',stageId:'one',content:binary,access:{visibility:'public',audience:[]},createdBy:'worker'});
  const ref=business.businessFileEvidence(staged.run.id,{stageId:'one',path:delivery.path}).ref;assert.equal(ref.artifactVersion,1);assert.match(evidence.resolveEvidence(staged.run.id,ref).excerpt,/二进制/);
  const command=c=>business.applyBusinessCommand(staged.run.id,{...c,expectedVersion:business.getBusinessState(staged.run.id).version,clientRequestId:randomUUID()});
  command({action:'report',stageId:'one',kind:'delivery',note:'',evidence:[{deliverableId:'file',ref},{deliverableId:'proof',ref:business.listBusinessEvidence(staged.run.id).find(e=>e.stageId==='one').ref}]});
  command({action:'decide',stageId:'one',reportId:business.getBusinessState(staged.run.id).stages[0].report.id,verdict:'accept',checkedCriteria:[0],reason:''});
  const accepted=snapshots.listArtifactSnapshots(staged.run.id).find(r=>r.retained);assert.ok(accepted);code(()=>snapshots.deleteArtifactSnapshot(accepted.snapshot.id,accepted.digest),'SNAPSHOT_RETAINED');
  assert.equal(accepted.snapshot.texts[0].size,Buffer.byteLength(fullText));assert.equal(Buffer.from(snapshots.readSnapshotContent(accepted.snapshot.id,'text',0).contentBase64,'base64').toString(),fullText,'full text survives excerpt truncation');
  assert.equal(accepted.snapshot.files.find(f=>f.artifactId===delivery.id).acceptanceVersion,2);
  assert.equal(accepted.snapshot.texts[0].acceptanceVersion,2);assert.equal(accepted.snapshot.texts[0].mimeType,'text/plain');
  await assert.rejects(()=>coordination.resumeCoordinationRun(staged.run.id));const beforeCalls=calls;
  const unaccepted=artifacts.createManagedArtifact({runId:staged.run.id,path:delivery.path,stageId:'two',content:Buffer.from('UNACCEPTED_LATEST_VERSION'),access:{visibility:'public',audience:[]},createdBy:'observer'});
  const afterAcceptance=artifacts.createManagedArtifact({runId:staged.run.id,path:delivery.path,stageId:'one',content:Buffer.from('POST_ACCEPTANCE_UNDECLARED_VERSION'),access:{visibility:'public',audience:[]},createdBy:'worker'});
  const cp=await continuation.previewRunContinuation(staged.run.id,true);assert.equal(calls,beforeCalls);assert.equal(cp.checkpoint.business.archive.manifest.files.some(f=>f.artifactId===delivery.id),true);
  assert.equal(cp.checkpoint.business.archive.manifest.files.some(f=>f.artifactId===unaccepted.id),false,'unaccepted versions are not restored as continuation inputs');
  assert.equal(cp.checkpoint.business.archive.manifest.files.some(f=>f.artifactId===afterAcceptance.id),false,'a stage label alone does not authorize a later undeclared version');
  assert.equal(cp.checkpoint.business.archive.manifest.texts[0].acceptanceVersion,2,'accepted text keeps its decision version in the checkpoint');
  const next=continuation.submitRunContinuation(staged.run.id,{previewId:cp.preview.previewId,orchestrationFingerprint:cp.preview.fingerprint},true);
  const nextFile=artifacts.listManagedArtifacts(room.id).find(f=>f.runId===next.run.id&&f.path===delivery.path);assert.ok(nextFile);assert.deepEqual(artifacts.readManagedArtifact(nextFile.id),binary);assert.equal(nextFile.visibility,'public');assert.equal(nextFile.restoredFrom.artifactId,delivery.id);
  checkpointStore.materializeBusinessCheckpoint(next.run.id);assert.equal(existsSync(path.join(config.sandboxDir,'runs',next.run.id,delivery.path)),false,'managed files never materialized in cwd');
  failSecond=false;await coordination.runCoordinationPlan(next.run,next.run.goal);assert.equal(calls,beforeCalls+1,'accepted stage not replayed');

  // Owner session, CSRF, Host/Origin and strict fields apply to every archive/restore mutation.
  const headers={host:'127.0.0.1:43220'};const url='/api/accounts/artifact-snapshots/runs/'+unsafe.id;
  assert.equal((await app.inject({method:'GET',url,headers})).statusCode,401);
  const session=await app.inject({method:'POST',url:'/api/accounts/session',headers:{...headers,'x-gand-bootstrap':'1'}});
  const auth={...headers,cookie:session.headers['set-cookie'].split(';')[0],'x-gand-csrf':session.json().csrfToken};
  const privateIndex=snapshot.files.findIndex(f=>f.artifactId===privateFile.id),downloadUrl='/api/accounts/artifact-snapshots/'+snapshot.id+'/content/file/'+privateIndex;
  assert.equal((await app.inject({method:'GET',url:downloadUrl,headers})).statusCode,401);
  const ownerDownload=await app.inject({method:'GET',url:downloadUrl,headers:auth});assert.equal(ownerDownload.statusCode,200,ownerDownload.body);assert.equal(Buffer.from(ownerDownload.json().contentBase64,'base64').toString(),'PRIVATE_MANAGED_NEVER_CWD');
  assert.equal((await app.inject({method:'POST',url:url+'/preview',headers:{...auth,'x-gand-csrf':''},payload:{paths:[]}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:url+'/preview',headers:{...auth,origin:'https://untrusted.invalid'},payload:{paths:[]}})).statusCode,403);
  const hp=await app.inject({method:'POST',url:url+'/preview',headers:auth,payload:{paths:[],stageIds:[]}});assert.equal(hp.statusCode,200,hp.body);
  assert.equal((await app.inject({method:'POST',url,headers:auth,payload:{paths:[],stageIds:[],fingerprint:hp.json().fingerprint,viewerId:'worker'}})).statusCode,400);
  const saved=await app.inject({method:'POST',url,headers:auth,payload:{paths:[],stageIds:[],fingerprint:hp.json().fingerprint}});assert.equal(saved.statusCode,200,saved.body);
  const rp=await app.inject({method:'POST',url:'/api/accounts/artifact-snapshots/'+saved.json().id+'/restore-preview',headers:auth,payload:{}});assert.equal(rp.statusCode,200,rp.body);
  const rr=await app.inject({method:'POST',url:'/api/accounts/artifact-snapshots/'+saved.json().id+'/restores',headers:auth,payload:{fingerprint:rp.json().fingerprint,clientRequestId:randomUUID()}});assert.equal(rr.statusCode,200,rr.body);
  assert.equal(db.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n,10);
  const originalVersions=db.all('SELECT * FROM managed_artifact_versions'),keyPath=path.join(config.accounts.privateDir,'account-master-key.json'),originalKey=await readFile(keyPath);
  db.run('DELETE FROM managed_artifact_versions');await rm(keyPath);
  const {sealManagedContent}=await import('../apps/server/src/accounts/credentials.ts');assert.throws(()=>sealManagedContent(Buffer.from('new fixture archive'),'fixture'),/主密钥缺失/);assert.equal(existsSync(keyPath),false,'snapshots alone prevent replacement of a lost master key');
  await writeFile(keyPath,originalKey,{mode:0o600});for(const row of originalVersions)db.run('INSERT INTO managed_artifact_versions(id,conversation_id,run_id,path,version,record,content,created_at) VALUES(?,?,?,?,?,?,?,?)',row.id,row.conversation_id,row.run_id,row.path,row.version,row.record,row.content,row.created_at);
  // A tracked platform database must not be packed just because it is a Git blob.
  git(['init','--template=','--quiet'],root);git(['add','db.sqlite'],root);git(['-c','user.name=R3','-c','user.email=r3@example.invalid','commit','--quiet','-m','sensitive baseline fixture'],root);
  const {captureSnapshotGit}=await import('../apps/server/src/artifacts/snapshotGit.ts');code(()=>captureSnapshotGit(root),'SNAPSHOT_SENSITIVE_PATH');
  console.log(`R3 verified (${process.env.COORDINATION_RUNTIME_KERNEL}): declared completeness, exact shallow Git baseline, add/modify/delete/binary, excluded secrets, source deletion + cold restore, ACL/hash/link/mode drift, retained references, public managed stage continuation, owner/CSRF/Origin/idempotency. Temporary DB/Git repos and mock models only; real supplier requests 0.`);
} finally {await app.close();db.db.close();await rm(root,{recursive:true,force:true});}
