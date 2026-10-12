import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const mode = process.argv[2] ?? 'execute';
const root = await mkdtemp(path.join(tmpdir(),'gand-private-r2-'));
Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(root,'test.sqlite'),AGENTS_DIR:path.join(root,'roles'),SANDBOX_DIR:path.join(root,'sandbox'),
  AGENT_GAND_ISOLATED_WORKER:'1',AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),COORDINATION_RUNTIME_KERNEL:mode,MCP_SERVER_CMD:'',LOG_LEVEL:'silent',
  ANTHROPIC_API_KEY:'fixture-not-a-real-key',EXTERNAL_CODEX_HOME:path.join(root,'codex'),EXTERNAL_CLAUDE_HOME:path.join(root,'claude')});
await mkdir(process.env.EXTERNAL_CODEX_HOME); await writeFile(path.join(process.env.EXTERNAL_CODEX_HOME,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'private-fixture'}}));
globalThis.fetch = () => { throw new Error('No real provider/network calls in private interaction fixture'); };
const { config } = await import('../apps/server/src/config.ts'); config.sandboxDir=path.join(root,'sandbox');
const db = await import('../apps/server/src/db/database.ts');
const registry = await import('../apps/server/src/agents/registry.ts');
const rooms = await import('../apps/server/src/conversations/service.ts');
const entry = await import('../apps/server/src/orchestration/entry.ts');
const trace = await import('../apps/server/src/runs/trace.ts');
const inbox = await import('../apps/server/src/messaging/inbox.ts');
const { getRunCoordinationPlan } = await import('../apps/server/src/coordination/store.ts');
const { assembleCoordinationKernelContext } = await import('../apps/server/src/runtime/coordinationAdapter.ts');
const artifacts = await import('../apps/server/src/artifacts/store.ts');
const tools = await import('../apps/server/src/tools/builtin/index.ts');
const evidence = await import('../apps/server/src/runtime/evidence.ts');
const access = await import('../apps/server/src/messaging/access.ts');
const collaboration = await import('../apps/server/src/collaboration/store.ts');
const { planCollaborationAdmission } = await import('../apps/server/src/runtime/subjectContract.ts');
const { observeAdmission } = await import('../apps/server/src/runtime/shadow.ts');
const { freezeRuntimeContract } = await import('../apps/server/src/runtime/controlAction.ts');
const { runAgentTurn } = await import('../apps/server/src/orchestration/agentStep.ts');
const { assessRunRecovery } = await import('../apps/server/src/runtime/recovery.ts');
const { mockProvider } = await import('../apps/server/src/llm/provider.ts');
const { enqueueConversationRun } = await import('../apps/server/src/conversations/dispatcher.ts');
const { registerRoutes } = await import('../apps/server/src/api/routes.ts');
const { registerAccountRoutes } = await import('../apps/server/src/api/accountRoutes.ts');
const { default: Fastify } = await import('../apps/server/node_modules/fastify/fastify.js');
const { isMessageWithinScope } = await import('../packages/shared/src/message.ts');
const role = (id,more={}) => ({id,name:id,description:'R2 fixture',systemPrompt:'Provide complete results.',model:'mock:'+id,capabilities:['execute'],permissionMode:'auto',tools:['fs.read','fs.write','search.files'],disallowedTools:[],color:'#4477aa',avatar:'',...more});
for (const id of ['alice','bob','observer','aggregate']) registry.createAgent(role(id));
for (const [id,driver] of [['sdk','claude-sdk'],['codex','codex-app-server'],['cli','claude-cli']]) registry.createAgent(role(id,{model:'fixture-model',permissionMode:'readonly',tools:[],execution:{kind:'external',driver,platformTools:driver === 'claude-cli' ? [] : ['fs.read','search.files']}}));
const team = ['alice','bob','observer','aggregate','sdk','codex','cli'];
const room = rooms.createConversation({title:'R2 isolation',mode:'collaboration',agentIds:team,workspace:null});
const base = {conversationId:room.id,agentIds:team,strategy:'auto',workflow:'routine',constraints:{readonly:true}};
const calls = [];
const reply = (content,toolCalls=[]) => ({content,toolCalls,usage:{tokensIn:3,tokensOut:8,costUsd:0},stopReason:'end_turn',truncated:false});
mockProvider.chat = async req => {
  const text = req.messages.map(message=>message.content).join('\n');
  calls.push({model:req.model,text,tools:req.tools?.map(tool=>tool.name) ?? []});
  if (text.includes('PUBLIC_PROBE')) assert.doesNotMatch(text,/TEXT_SECRET_[AB]|FILE_SECRET_[AB]|PRIVATE_WRITTEN/,'private context entered public turn');
  const toolResult = text.includes('【工具结果】fs.read');
  if (text.includes('LEGACY_PRIVATE_TOOL') && !toolResult) return reply('过程 FILE_SECRET_A',[{id:'legacy-read',name:'fs.read',input:JSON.stringify({path:'attachments/alice.txt'})}]);
  if (text.includes('READ_PRIVATE_A') && !toolResult) return reply('',[{id:'read-a',name:'fs.read',input:JSON.stringify({path:'attachments/alice.txt'})}]);
  if (text.includes('READ_PRIVATE_B') && !toolResult) return reply('',[{id:'read-b',name:'fs.read',input:JSON.stringify({path:'attachments/bob.txt'})}]);
  if (text.includes('PUBLIC_PROBE') && !toolResult) return reply('',[{id:'public-probe',name:'fs.read',input:JSON.stringify({path:'attachments/alice.txt'})}]);
  const output = text.includes('READ_PRIVATE_A') ? '交付 FILE_SECRET_A 与 TEXT_SECRET_A，已完成私密文件分析。' : text.includes('READ_PRIVATE_B') ? '交付 FILE_SECRET_B 与 TEXT_SECRET_B，已完成私密文件分析。' : '提供完整结果，所有检查已执行。';
  if (req.tools?.some(tool=>tool.name==='agent.complete')) return reply('',[{id:'complete',name:'agent.complete',input:JSON.stringify({summary:output})}]);
  return reply(output);
};
const preview = body => entry.previewExecutionOrchestration(body);
function submit(body,p) { return entry.submitExecutionOrchestration({...body,clientRequestId:randomUUID(),previewId:p.previewId,orchestrationFingerprint:p.fingerprint},room.id); }
async function complete(runId) { enqueueConversationRun(runId); const end=Date.now()+15000; while(Date.now()<end) { const run=trace.getRun(runId); if(['completed','failed','cancelled'].includes(run.status)) { assert.equal(run.status,'completed',JSON.stringify({run,messages:inbox.listByRun(runId)})); return; } await new Promise(resolve=>setTimeout(resolve,20)); } throw new Error('Run did not settle: '+runId); }
const attachment = (name,content) => ({path:'attachments/'+name,contentBase64:Buffer.from(content).toString('base64'),mimeType:'text/plain'});
const a = {...base,goal:'READ_PRIVATE_A TEXT_SECRET_A 分析附件',recipientIds:['alice'],visibility:'private',audience:['alice'],attachments:[attachment('alice.txt','FILE_SECRET_A')]};
const b = {...base,goal:'READ_PRIVATE_B TEXT_SECRET_B 分析附件',recipientIds:['bob'],visibility:'private',audience:['bob'],attachments:[attachment('bob.txt','FILE_SECRET_B')]};
const app=Fastify(); await registerAccountRoutes(app); await registerRoutes(app);
try {
  const pa=await preview(a); assert.equal(calls.length,0); assert.equal(pa.decision.requiresConfirmation,true); assert.equal(pa.decision.issues.some(i=>i.severity==='error'),false,JSON.stringify(pa.decision.issues));
  assert.deepEqual(pa.decision.execution.participantIds,['alice']);
  const stableA={...a,clientRequestId:randomUUID(),previewId:pa.previewId,orchestrationFingerprint:pa.fingerprint}; const alice=entry.submitExecutionOrchestration(stableA,room.id); await complete(alice.run.id);
  const duplicate=entry.submitExecutionOrchestration(stableA,room.id); assert.equal(duplicate.run.id,alice.run.id); assert.equal(db.get('SELECT COUNT(*) n FROM managed_artifact_versions WHERE run_id=?',alice.run.id).n,1);
  // Different upload content invalidates the approved fingerprint before dispatch.
  assert.throws(()=>entry.submitExecutionOrchestration({...a,attachments:[attachment('alice.txt','CHANGED')],clientRequestId:randomUUID(),previewId:pa.previewId,orchestrationFingerprint:pa.fingerprint},room.id),/变化|失效|不一致/);
  const pb=await preview(b), bob=submit(b,pb); await complete(bob.run.id);
  const [fileA]=artifacts.listManagedArtifacts(room.id).filter(file=>file.path==='attachments/alice.txt');
  const [fileB]=artifacts.listManagedArtifacts(room.id).filter(file=>file.path==='attachments/bob.txt');
  assert.ok(fileA && fileB); assert.equal(fileA.runId,alice.run.id); assert.equal(fileA.version,1);
  assert.equal(existsSync(path.join(tools.workspaceRootDir({runId:alice.run.id}),'attachments/alice.txt')),false,'private bytes materialized in native cwd');
  assert.doesNotMatch(db.get('SELECT content FROM managed_artifact_versions WHERE id=?',fileA.id).content,/FILE_SECRET_A/);
  const ctxA={runId:alice.run.id,agentId:'alice'},ctxB={runId:bob.run.id,agentId:'bob'};
  // An Agent-issued private child inside a historical public Run keeps intermediate/tool messages private.
  const legacyId=randomUUID(), now=new Date().toISOString();
  db.run('INSERT INTO runs(id,goal,mode,conversation_id,status,agent_ids,created_at) VALUES(?,?,?,?,?,?,?)',legacyId,'public root','collaboration',room.id,'running',JSON.stringify(team),now);
  const legacyAdmission=planCollaborationAdmission({runId:legacyId,objective:'public root',participantIds:team,targetAgentIds:['alice'],completionEngine:true,controlActionVersion:2,contextContributorVersion:1,messageVisibilityVersion:1,exitGuard:{version:1,maxCorrections:1,correctionMaxTokens:512},completionCandidateVersion:1,successorObligationVersion:1,evidenceBundleVersion:1,durableHoldVersion:2}); freezeRuntimeContract(legacyAdmission.contract);
  const source=inbox.post({runId:legacyId,from:'user',to:'alice',kind:'user',body:'LEGACY_PRIVATE_TOOL',visibility:'private',audience:['alice']});
  const dispatch=collaboration.createDispatch({runId:legacyId,conversationId:room.id,sourceMessageId:source.id,kind:'initial',from:'user',targetAgentId:'alice',depth:0,idempotencyKey:'legacy-private-file'});
  observeAdmission(legacyAdmission.contract,legacyAdmission.subjects,[dispatch.id]);
  const claim=collaboration.claimNextDispatch(room.id,'r2-legacy-file'); assert.ok(claim,JSON.stringify({dispatch:collaboration.getDispatch(dispatch.id),attempts:db.all("SELECT agent_id,status FROM collaboration_attempts WHERE status='running'")})); assert.equal(claim.dispatch.id,dispatch.id);
  const parent=trace.startSpan(legacyId,{spanKind:'orchestration',name:'private-child',attributes:{'collaboration.attempt.id':claim.attempt.id}});
  const legacyTurn=await runAgentTurn({run:trace.getRun(legacyId),agent:registry.getAgent('alice'),parentSpanId:parent.id,attemptId:claim.attempt.id,executionScopeId:`collaboration:${dispatch.id}`,messages:[{role:'user',content:'LEGACY_PRIVATE_TOOL'}]});
  assert.equal(legacyTurn.emptyResponse,false);
  const emitted=inbox.listByRun(legacyId).filter(message=>message.id!==source.id); assert.ok(emitted.some(message=>message.kind==='tool')); assert.ok(emitted.some(message=>message.body.includes('过程 FILE_SECRET_A')));
  for(const message of emitted) { assert.equal(message.visibility,'private'); assert.deepEqual(message.audience,['alice','user']); }
  assert.doesNotMatch(JSON.stringify(inbox.listByConversation(room.id,'observer')),/FILE_SECRET_A/);
  trace.endSpan(parent,{status:'ok'}); collaboration.finishAttempt({attemptId:claim.attempt.id,dispatchId:dispatch.id,status:'completed',output:legacyTurn.content}); trace.setRunStatus(legacyId,'completed');

  assert.equal(await tools.getTool('fs.read').run({path:fileA.path},ctxA),'FILE_SECRET_A');
  await assert.rejects(tools.getTool('fs.read').run({path:fileA.path},ctxB),/授权范围/);
  await assert.rejects(tools.getTool('fs.read').run({path:fileB.path},ctxA),/授权范围/);
  assert.doesNotMatch(await tools.getTool('search.files').run({pattern:'FILE_SECRET'},ctxB),/SECRET_A|alice.txt/);
  assert.match(await tools.getTool('search.files').run({pattern:'FILE_SECRET'},ctxB),/SECRET_B/);
  assert.equal(artifacts.listManagedArtifacts(room.id,'observer',{visibility:'public',audience:[]}).length,0);
  for (const current of [alice,bob]) for (const message of inbox.listByRun(current.run.id)) assert.equal(message.visibility,'private',JSON.stringify(message));
  assert.doesNotMatch(JSON.stringify(inbox.listByConversation(room.id,'observer')),/SECRET_[AB]/);
  const refA=evidence.createWorkspaceFileEvidence(alice.run.id,fileA.path); assert.equal(refA.artifactId,fileA.id);
  assert.equal(evidence.resolveEvidence(alice.run.id,refA,'bob').trusted,false);
  assert.equal(evidence.resolveEvidence(alice.run.id,refA,'alice',access.runSourceAccess(alice.run.id)).trusted,true);
  assert.equal(evidence.resolveEvidence(alice.run.id,refA,'alice',{visibility:'public',audience:[]}).trusted,false);
  assert.equal(evidence.resolveEvidence(alice.run.id,{...refA,artifactVersion:2}).trusted,false);
  // Same member returning to public cannot reuse a private file or private transcript.
  const publicBody={...base,goal:'PUBLIC_PROBE 公开分析',recipientIds:['alice'],visibility:'public',audience:[]};
  const pp=await preview(publicBody),pub=submit(publicBody,pp); await complete(pub.run.id);
  assert.doesNotMatch(JSON.stringify(inbox.listByRun(pub.run.id)),/FILE_SECRET_[AB]|TEXT_SECRET_[AB]/);
  assert.equal(tools.artifactStat(fileA.path,{runId:pub.run.id}).exists,false,'owner completion barrier imported a private file into a public task');
  const publicCtx={runId:pub.run.id,agentId:'alice'}; await assert.rejects(tools.getTool('fs.read').run({path:fileA.path},publicCtx),/授权范围/);
  const privateOutput=inbox.listByRun(alice.run.id).find(message=>message.kind==='agent');
  const widenReply=await preview({...base,goal:'引用分析',recipientIds:['alice'],replyTo:privateOutput.id,visibility:'public'});
  assert.ok(widenReply.decision.issues.some(issue=>issue.code==='PRIVATE_REPLY_SCOPE'));
  // Step graph summaries run within the common authorized audience; an unapproved aggregator fails before model calls.
  const summary={...base,strategy:'parallel',workflow:'analysis_summary',goal:'私密分析与汇总',recipientIds:['alice','bob'],aggregatorId:'aggregate',visibility:'private',audience:['alice','bob','aggregate']};
  const denied=await preview({...summary,audience:['alice','bob']}); assert.ok(denied.decision.issues.some(issue=>issue.code==='PRIVATE_PARTICIPANT_DENIED'));
  const ps=await preview(summary); assert.equal(ps.decision.execution.engine,'coordination'); assert.equal(ps.decision.issues.some(issue=>issue.severity==='error'),false,JSON.stringify(ps.decision.issues));
  const graph=submit(summary,ps); await complete(graph.run.id);
  for (const attempt of db.all('SELECT id FROM coordination_step_attempts WHERE run_id=?',graph.run.id)) assert.equal(access.attemptAccess(attempt.id).visibility,'private');
  assert.doesNotMatch(calls.filter(call=>call.text.includes('私密分析与汇总')).map(call=>call.text).join('\n'),/SECRET_A|SECRET_B/,'narrow private tasks contaminated a wider private graph');
  for (const message of inbox.listByRun(graph.run.id)) assert.equal(message.visibility,'private');
  // An owner-valid evidence bundle still cannot enter a wider downstream member context.
  const graphPlan=getRunCoordinationPlan(graph.run.id), downstream=graphPlan.steps.find(step=>step.agentId==='aggregate' && step.dependsOn.length);
  const dependency=downstream.dependsOn[0], linkRow=db.get('SELECT subject_id FROM runtime_coordination_subjects WHERE plan_id=? AND revision=? AND step_id=?',graphPlan.id,graphPlan.revision,dependency);
  const narrow=artifacts.createManagedArtifact({runId:graph.run.id,path:'narrow-evidence.txt',content:Buffer.from('NARROW_GRAPH_SECRET'),access:{visibility:'private',audience:['alice']},createdBy:'user'});
  const narrowRef={kind:'workspace_file',path:narrow.path,sha256:narrow.sha256,artifactId:narrow.id,artifactVersion:narrow.version};
  const bundle=evidence.createEvidenceBundle({runId:graph.run.id,ownerType:'coordination_step',ownerId:dependency,refs:[narrowRef],idempotencyKey:'narrow-dependency-bundle'}); assert.equal(bundle.status,'valid');
  db.run('DELETE FROM runtime_coordination_evidence WHERE subject_id=?',linkRow.subject_id);
  db.run('INSERT INTO runtime_coordination_evidence(subject_id,attempt_id,refs,bundle_id,created_at) VALUES(?,?,?,?,?)',linkRow.subject_id,randomUUID(),JSON.stringify([narrowRef]),bundle.id,new Date().toISOString());
  for(const member of ['aggregate','alice']) {
    const step={...downstream,agentId:member}, attemptId=randomUUID(), timestamp=new Date().toISOString();
    db.run('INSERT INTO coordination_step_attempts(id,plan_id,run_id,revision,step_id,attempt_no,status,idempotency_key,created_at,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)',attemptId,graphPlan.id,graph.run.id,graphPlan.revision,step.id,member==='aggregate'?998:999,'completed',attemptId,timestamp,timestamp);
    const context=assembleCoordinationKernelContext({run:trace.getRun(graph.run.id),plan:graphPlan,step,attemptId,baseInput:'current wider task'});
    assert.doesNotMatch(context,/NARROW_GRAPH_SECRET/); assert.match(context,/不可用.*可见范围/);
  }

  for (const id of ['sdk','codex']) { const p=await preview({...base,goal:'只读私密分析',recipientIds:[id],visibility:'private',audience:[id]}); assert.equal(p.decision.issues.some(issue=>issue.severity==='error'),false,JSON.stringify(p.decision.issues)); }
  const cli=await preview({...base,strategy:'serial',goal:'只读私密分析',recipientIds:['cli'],visibility:'private',audience:['cli']}); assert.ok(cli.decision.issues.some(issue=>issue.code==='PRIVATE_ENGINE_UNSUPPORTED'));
  const write=await preview({...base,goal:'实现写入',recipientIds:['sdk'],constraints:{readonly:false},visibility:'private',audience:['sdk']}); assert.ok(write.decision.issues.some(issue=>issue.code==='PRIVATE_NATIVE_WRITE_UNSUPPORTED'));
  // A private file written by platform fs inherits the current source, regardless of model-looking ACL fields.
  await tools.getTool('fs.write').run({path:'private-result.txt',content:'PRIVATE_WRITTEN',visibility:'public',audience:['observer']},ctxA);
  const written=artifacts.findManagedArtifact(ctxA,'private-result.txt'); assert.equal(written.visibility,'private'); assert.deepEqual(written.audience,['alice','user']);
  assert.equal(existsSync(path.join(tools.workspaceRootDir(ctxA),'private-result.txt')),false);
  // Known links cannot cross filesystem scopes, even for legacy unmanaged public files.
  const publicRoot=tools.workspaceRootDir(publicCtx); await mkdir(publicRoot,{recursive:true}); const outside=path.join(root,'outside.txt'); await writeFile(outside,'OUTSIDE_SECRET');
  await symlink(outside,path.join(publicRoot,'escape.txt')); await link(outside,path.join(publicRoot,'hard.txt'));
  await assert.rejects(tools.getTool('fs.read').run({path:'escape.txt'},publicCtx),/链接|越出/);
  await assert.rejects(tools.getTool('fs.read').run({path:'hard.txt'},publicCtx),/硬链接/);
  assert.doesNotMatch(await tools.getTool('search.files').run({pattern:'OUTSIDE_SECRET'},publicCtx),/(escape|hard)\.txt:/);
  // Owner download/publication requires session + CSRF. No Agent can choose a viewer via query parameters.
  const headers={host:`localhost:${config.port}`,origin:'http://localhost:5173'};
  let response=await app.inject({method:'GET',url:'/api/accounts/artifacts/'+fileA.id+'/content',headers}); assert.equal(response.statusCode,401);
  response=await app.inject({method:'POST',url:'/api/accounts/session',headers:{...headers,'x-gand-bootstrap':'1'}}); assert.equal(response.statusCode,200,response.body);
  const cookie=response.headers['set-cookie'].split(';')[0],csrf=response.json().csrfToken;
  response=await app.inject({method:'GET',url:'/api/accounts/artifacts/'+fileA.id+'/content?viewerId=observer',headers:{...headers,cookie}}); assert.equal(response.statusCode,200); assert.equal(Buffer.from(response.json().contentBase64,'base64').toString(),'FILE_SECRET_A'); // Authenticated owner, never a spoofed Agent view.
  const release={expectedVersion:1,visibility:'public',audience:[],reason:'所有者确认此文件可以发布给全队'};
  response=await app.inject({method:'POST',url:'/api/accounts/artifacts/'+fileA.id+'/release',headers:{...headers,cookie},payload:release}); assert.equal(response.statusCode,403);
  response=await app.inject({method:'POST',url:'/api/accounts/artifacts/'+fileA.id+'/release',headers:{...headers,cookie,'x-gand-csrf':csrf},payload:release}); assert.equal(response.statusCode,200,response.body);
  const released=response.json(); assert.equal(released.version,2); assert.equal(db.get('SELECT COUNT(*) n FROM artifact_authorization_audits').n,1);
  assert.equal(await tools.getTool('fs.read').run({path:fileA.path},publicCtx),'FILE_SECRET_A');
  assert.equal(evidence.resolveEvidence(alice.run.id,refA,'observer').trusted,false,'old evidence was declassified');
  assert.equal(artifacts.getManagedArtifact(fileA.id).visibility,'private');
  assert.throws(()=>artifacts.releaseManagedArtifact(fileA.id,release,'owner'),/版本已变化/);
  const record=db.get('SELECT record FROM managed_artifact_versions WHERE id=?',fileB.id).record;
  db.run("UPDATE managed_artifact_versions SET record=json_set(record,'$.visibility','public') WHERE id=?",fileB.id);
  assert.throws(()=>artifacts.readManagedArtifact(fileB.id),/校验失败/); db.run('UPDATE managed_artifact_versions SET record=? WHERE id=?',record,fileB.id);
  const failureBody={...b,goal:'私密文件任务准备失败'}; const pf=await preview(failureBody),failure=submit(failureBody,pf); trace.setRunStatus(failure.run.id,'failed');
  assert.equal(trace.getRun(failure.run.id).status,'failed'); assert.ok(assessRunRecovery(failure.run.id).reasonCodes.includes('PRIVATE_CHECKPOINT_UNSUPPORTED'));
  const uploadBody={...base,goal:'公开文件待恢复',recipientIds:['alice'],visibility:'public',attachments:[attachment('public-pending.txt','PUBLIC_PENDING')]};
  const pu=await preview(uploadBody),upload=submit(uploadBody,pu); trace.setRunStatus(upload.run.id,'failed');
  assert.ok(assessRunRecovery(upload.run.id).reasonCodes.includes('MANAGED_ARTIFACT_CHECKPOINT_UNSUPPORTED'));
  const models=calls.filter(call=>call.model==='mock:observer'); assert.equal(models.length,0);
  assert.equal(db.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n,10);
  console.log(`R2 private interaction (${mode}) verified: owner preview, common-scope graph, alternating public/private context, files/read/search/evidence ACL, ciphertext, links, explicit publication, immutable versions and blocked private continuation.`);
} finally { await app.close(); db.closeDatabase(); await rm(root,{recursive:true,force:true}); }
