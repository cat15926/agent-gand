import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';
const env=await createDemoEnvironment(),db=env.database,checks=[],qa=path.resolve('apps/server/data/autonomous-ac3-qa');
await mkdir(qa,{recursive:true,mode:0o700});
const {config}=await import('../apps/server/src/config.ts');config.autonomousCollaborationMode='execute';
const rooms=await import('../apps/server/src/conversations/service.ts'),trace=await import('../apps/server/src/runs/trace.ts'),{post}=await import('../apps/server/src/messaging/inbox.ts');
const tasks=await import('../apps/server/src/runtime/autonomousTasks.ts'),graph=await import('../apps/server/src/collaboration/autonomousGraph.ts');
const runner=await import('../apps/server/src/collaboration/autonomousRunner.ts'),scheduler=await import('../apps/server/src/collaboration/scheduler.ts'),store=await import('../apps/server/src/collaboration/store.ts');
const delivery=await import('../apps/server/src/collaboration/autonomousDelivery.ts'),results=await import('../apps/server/src/runtime/autonomousResults.ts');
const {mockProvider}=await import('../apps/server/src/llm/provider.ts'),{parseAutonomousControlCall}=await import('../apps/server/src/collaboration/autonomousTools.ts');
const {auditShadowRun}=await import('../apps/server/src/runtime/shadow.ts'),{commitRunTerminal}=await import('../apps/server/src/runtime/terminal.ts');
const {registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');await registerAccountRoutes(env.app);
const latestSchema=(await import('../apps/server/src/db/orchestrationMigrations.ts')).ORCHESTRATION_MIGRATIONS.at(-1).version;
const members=['planner','aa','bb','summary'];let modelCalls=0,freshProcessCalls=0,behavior;
const prompts=[];mockProvider.chat=async req=>{modelCalls++;prompts.push({model:req.model,body:req.messages.map(m=>m.content).join('\n')});return behavior(req,prompts.at(-1).body);};
const call=(name,input)=>({name,input:JSON.stringify(input)}),complete=summary=>call('agent.complete',{summary});
const response=tool=>({content:'',toolCalls:[tool],stopReason:'tool_use',truncated:false,usage:{tokensIn:5,tokensOut:8,costUsd:0,inputKnown:true,outputKnown:true,costKnown:true,costSource:'reported'}});
const emit=(key,extra={})=>call('agent.emit',{commandKey:key,kind:'final',format:'text',text:'经过核对的完整报告，仅在明确许可的范围内交付本次任务结论。',...extra});
function seed(marker,{privateInputs=false,ids=members,deadlineAt}={}){
 const room=rooms.createConversation({title:marker,mode:'collaboration',agentIds:ids,workspace:null});
 const run=trace.createRun(marker+'：自主组织独立审阅，汇总并交付可验证的完整结果。','collaboration',ids,null,null,room.id);
 trace.setRunStatus(run.id,'running');post({runId:run.id,from:'user',to:'planner',kind:'user',body:run.goal});
 const f={run,room,draft:{coordinatorId:'planner',participantIds:ids,budget:{maxOutputTokens:6000,maxTokensPerCall:256,maxDispatches:20,maxDepth:3,...(deadlineAt?{deadlineAt}:{})}}};
 if(privateInputs){f.inputs=['aa','bb'].map(id=>post({runId:run.id,from:'user',to:id,kind:'system',body:`${marker}_SECRET_${id.toUpperCase()}`,visibility:'private',audience:['user',id]}));f.draft.inputs=f.inputs.map((m,i)=>({kind:'message',id:m.id,readers:[['aa','bb'][i]]}));}
 return f;
}
const cleanup=f=>{if(!['completed','failed','cancelled'].includes(trace.getRun(f.run.id).status))commitRunTerminal({runId:f.run.id,status:'cancelled',disposition:'cancelled',source:'isolated_fixture_cleanup',closeExecution:()=>store.cancelCollaborationRun(f.run.id)});};
const admit=f=>graph.admitAutonomousGraph(f.run.id,f.draft,{deliveryVersion:1});
async function step(f,{settle=true}={}){
 const claimed=store.claimNextDispatch(f.room.id,'ac3-fixture');if(!claimed&&store.listDispatches(f.run.id).some(d=>d.status==='running')){await new Promise(r=>setTimeout(r,15));return;}assert.ok(claimed,'no ready dispatch: '+JSON.stringify(store.listDispatches(f.run.id)));
 await runner.executeAutonomousDispatch(claimed.dispatch,claimed.attempt.id,trace.listRunAgentSnapshots(f.run.id).find(a=>a.id===claimed.dispatch.targetAgentId));
 if(settle)runner.settleAutonomousRun(f.run.id);return claimed;
}
async function drain(f){const start=Date.now();while(trace.getRun(f.run.id).status==='running'){if(Date.now()-start>15000)throw new Error('drain timeout');await step(f);}}
function done(f){assert.equal(trace.getRun(f.run.id).status,'completed',JSON.stringify(store.listDispatches(f.run.id).map(d=>({status:d.status,error:d.error}))));assert.deepEqual(auditShadowRun(f.run.id),[]);}
function proposal(f){return db.get('SELECT * FROM autonomous_decision_proposals WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',f.run.id);}
function report(f){return db.get('SELECT m.* FROM messages m JOIN autonomous_emission_records e ON e.message_id=m.id WHERE e.run_id=? ORDER BY e.rowid DESC LIMIT 1',f.run.id);}
const count=(table,f)=>db.get(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`,f.run.id).n;
function delegate(f){return call('agent.delegate',{commandKey:'review',items:['aa','bb'].map(id=>({key:id,agentId:id,objective:`独立审阅 ${id} 的材料并给出完整事实依据。`,...(f.inputs?{inputIds:[f.inputs[['aa','bb'].indexOf(id)].id]}:{})}))});}
const aggregate=(commandKey='merge',agentId='summary')=>call('agent.aggregate',{commandKey,key:'merged',agentId,objective:'将选定审阅结果合并，保留事实依据与限制，提交完整总评。',resultKeys:['aa','bb']});
const rootText='各项独立审阅已结束，全部责任、结果和交付范围均已核对，可以交付本次任务。';
const authHeaders={host:`127.0.0.1:${config.port}`};
const oldModule=path.join(qa,'v19-worker-'+randomUUID()+'.ts');
try{
 const session=await env.app.inject({method:'POST',url:'/api/accounts/session',headers:{...authHeaders,'x-gand-bootstrap':'1'}});assert.equal(session.statusCode,200,session.body);
 const ownerHeaders={...authHeaders,cookie:session.headers['set-cookie'].split(';')[0],'x-gand-csrf':session.json().csrfToken};
 const historical=seed('AC3_HISTORY');graph.admitAutonomousGraph(historical.run.id,historical.draft);cleanup(historical);
 db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,used,status,created_at) VALUES(?,?,123,123,'unknown',?)",randomUUID(),historical.run.id,new Date().toISOString());
 const migrationFile=path.join(env.root,'v19.sqlite');await db.db.backup(migrationFile);const v19=new Database(migrationFile);
 const ac3Tables=['autonomous_tool_receipts','autonomous_intake_copies','autonomous_decision_resolutions','autonomous_decision_proposals','autonomous_emission_records','autonomous_emission_plans','autonomous_aggregate_sources','autonomous_results'];
 v19.exec('PRAGMA foreign_keys=OFF;DROP TABLE autonomous_flow_actions;DROP TABLE autonomous_flow_jobs;DROP TABLE autonomous_flow_sources;DROP TABLE autonomous_flow_steps;DROP TABLE autonomous_flows;DROP TABLE autonomous_pause_points;DROP TABLE autonomous_user_instructions;DROP TABLE autonomous_submissions;'+ac3Tables.map(t=>`DROP TABLE ${t};`).join('')+'DELETE FROM orchestration_schema_migrations WHERE version>=20;PRAGMA foreign_keys=ON');
 const tables=v19.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('orchestration_schema_migrations','sqlite_sequence') ORDER BY name").all().map(r=>r.name);
 const digest=d=>createHash('sha256').update(JSON.stringify(tables.map(t=>d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex');const before=digest(v19);
 await writeFile(oldModule,execFileSync('git',['show','85d76fd:apps/server/src/db/orchestrationMigrations.ts'],{encoding:'utf8'}),{mode:0o600});const old=await import(pathToFileURL(oldModule).href);old.assertOrchestrationSchemaCompatible(v19);v19.close();
 for(let i=0;i<2;i++)execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',`const d=await import('./apps/server/src/db/database.ts');if(d.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n!==${latestSchema})throw new Error('schema');d.closeDatabase();`],{env:{...process.env,DB_PATH:migrationFile},stdio:'pipe'});
 const upgraded=new Database(migrationFile,{readonly:true});assert.equal(digest(upgraded),before);assert.deepEqual(upgraded.pragma('foreign_key_check'),[]);assert.throws(()=>old.assertOrchestrationSchemaCompatible(upgraded),/版本|migration|schema/i);upgraded.close();
 assert.throws(()=>admit(historical),/AUTONOMOUS_AUTHORITY_INVALID/);checks.push('genuine v19 worker accepts AC2 fixture then refuses schema20; repeated migration preserves all historical rows and unknown usage; frozen AC2 root cannot upgrade');

 const ordinary=seed('AC3_ORDINARY');let parent=0;
 behavior=(req,body)=>{
  assert.ok(req.tools.some(t=>t.name==='agent.aggregate'));
  if(req.model==='mock:planner'){
   parent++;if(parent===1)return response(delegate(ordinary));
   if(parent===2){assert.doesNotMatch(body,/REVIEW_TEXT_/);return response(aggregate());}
   assert.match(body,/SYNTHESIS_COMPLETE/);return response(complete(rootText));
  }
  if(req.model==='mock:summary'){assert.match(body,/REVIEW_TEXT_AA/);assert.match(body,/REVIEW_TEXT_BB/);return response(complete('SYNTHESIS_COMPLETE：两个审阅的事实、依据、限制与建议均已核对，并完成统一结论。'));}
  return response(complete(`REVIEW_TEXT_${req.model.slice(5).toUpperCase()}：已核对全部独立材料中的事实、风险和改进建议，提交完整结论。`));
 };
 admit(ordinary);await drain(ordinary);done(ordinary);assert.equal(parent,3);assert.equal(count('autonomous_results',ordinary),4);assert.equal(count('autonomous_emission_records',ordinary),1);assert.equal(count('autonomous_decision_proposals',ordinary),0);
 assert.match(report(ordinary).body,/REVIEW_TEXT_AA/);assert.match(report(ordinary).body,/SYNTHESIS_COMPLETE/);
 const merged=db.get("SELECT * FROM autonomous_work_items WHERE run_id=? AND work_key='merged'",ordinary.run.id);
 const inputIds=tasks.loadAutonomousTaskGrant(merged.grant_id).inputs.map(i=>i.source.id);
 assert.equal(db.get(`SELECT COUNT(DISTINCT json_extract(record,'$.source.id')) n FROM runtime_input_provenance WHERE scope_id IN (SELECT id FROM runtime_execution_scopes WHERE subject_id=?) AND json_extract(record,'$.source.id') IN (?,?)`,tasks.loadAutonomousTaskGrant(merged.grant_id).subjectId,...inputIds).n,2);
 const terminal=db.get('SELECT report_message_id FROM runtime_run_terminals WHERE run_id=?',ordinary.run.id);assert.equal(terminal.report_message_id,report(ordinary).id);
 checks.push('ordinary independent reviews -> actual aggregate Subject/Scope with two recorded reads -> coordinator continuation -> one accepted final delivery, zero Owner decisions, one root budget');

 const privateOwner=seed('AC3_PRIVATE',{privateInputs:true});let ownerParent=0;
 behavior=(req,body)=>{if(req.model==='mock:planner'){ownerParent++;assert.doesNotMatch(body,/AC3_PRIVATE_SECRET_/);return response(ownerParent===1?delegate(privateOwner):complete(rootText));}const id=req.model.slice(5);assert.match(body,new RegExp('AC3_PRIVATE_SECRET_'+id.toUpperCase()));assert.doesNotMatch(body,new RegExp('AC3_PRIVATE_SECRET_'+(id==='aa'?'BB':'AA')));return response(complete(`AC3_PRIVATE_RESULT_${id}：独立私密审阅已经完成，包含受限事实与完整依据。`));};
 admit(privateOwner);await drain(privateOwner);done(privateOwner);assert.equal(count('autonomous_decision_proposals',privateOwner),0);assert.deepEqual(JSON.parse(report(privateOwner).audience),['user']);assert.match(report(privateOwner).body,/AC3_PRIVATE_RESULT_aa/);assert.match(report(privateOwner).body,/AC3_PRIVATE_RESULT_bb/);
 checks.push('mutually private outputs go directly to their legitimate Owner in one final bundle; coordinator sees status only; no per-item confirmation or widened original ACL');

 const intake=seed('AC3_INTAKE',{privateInputs:true});let intakeParent=0;
 behavior=(req,body)=>{
  if(req.model==='mock:planner'){intakeParent++;assert.doesNotMatch(body,/AC3_INTAKE_SECRET_|INTAKE_RESULT_|INTAKE_MERGED/);return response(intakeParent===1?delegate(intake):intakeParent<=3?aggregate('intake-'+intakeParent):complete(rootText));}
  if(req.model==='mock:summary'){assert.match(body,/INTAKE_RESULT_aa/);assert.match(body,/INTAKE_RESULT_bb/);return response(complete('INTAKE_MERGED：新授权的确切结果副本已核对，完整汇总已完成，原始材料未读取。'));}
  return response(complete(`INTAKE_RESULT_${req.model.slice(5)}：依据本人的独立私密材料提交完整事实与审阅建议。`));
 };
 admit(intake);await drain(intake);assert.equal(trace.getRun(intake.run.id).status,'waiting_for_user');const p=proposal(intake);assert.equal(p.kind,'intake');
 const previewUrl=`/api/accounts/autonomous-collaboration/decisions/${p.id}`,resolveUrl=previewUrl+'/resolve';
 assert.equal((await env.app.inject({method:'GET',url:previewUrl,headers:authHeaders})).statusCode,401);
 const preview=await env.app.inject({method:'GET',url:previewUrl,headers:ownerHeaders});assert.equal(preview.statusCode,200,preview.body);assert.match(preview.json().body,/INTAKE_RESULT_aa/);assert.deepEqual(preview.json().access.audience,['summary','user']);
 assert.equal((await env.app.inject({method:'POST',url:resolveUrl,headers:{...authHeaders,cookie:ownerHeaders.cookie},payload:{action:'approve',fingerprint:p.sha256}})).statusCode,403);
 assert.equal((await env.app.inject({method:'POST',url:resolveUrl,headers:ownerHeaders,payload:{action:'approve',fingerprint:'changed'}})).statusCode,409);
 const {resolveCollaborationDecision}=await import('../apps/server/src/collaboration/decisions.ts');assert.throws(()=>resolveCollaborationDecision(p.collaboration_decision_id,{action:'answer',message:'同意，请继续'}),/普通回答/);
 assert.equal(count('autonomous_intake_copies',intake),0);
 delivery.resolveAutonomousAuthorization(p.id,{action:'approve',fingerprint:p.sha256},'local-management-fixture');
 delivery.resolveAutonomousAuthorization(p.id,{action:'approve',fingerprint:p.sha256},'local-management-fixture');assert.equal(count('autonomous_intake_copies',intake),2);
 for(const m of intake.inputs)assert.deepEqual(JSON.parse(db.get('SELECT audience FROM messages WHERE id=?',m.id).audience),['user',m.to].sort());
 await drain(intake);done(intake);assert.equal(count('autonomous_decision_proposals',intake),1);assert.equal(intakeParent,4);assert.match(report(intake).body,/INTAKE_MERGED/);assert.deepEqual(JSON.parse(report(intake).audience),['user']);
 checks.push('one exact intake decision: unauthenticated/CSRF/changed fingerprint/plain answer reject; authenticated approval creates exact copies, preserves source ACL, retries once, resumes real aggregate then Owner delivery without impersonation');

 for(const outcome of ['approve','deny']){
  const f=seed('AC3_RELEASE_'+outcome,{privateInputs:true});let n=0;
  behavior=(req,body)=>{
   if(req.model==='mock:planner'){n++;if(n===1)return response(delegate(f));if(n===2)return response(emit('release',{format:'result_bundle',text:undefined,resultKeys:['aa','bb'],access:{visibility:'public',audience:[]}}));
    if(outcome==='deny'&&n===3)return response(emit('retry-new-key',{format:'result_bundle',text:undefined,resultKeys:['aa','bb'],access:{visibility:'public',audience:[]}}));
    return response(complete(rootText));}
   return response(complete(`RELEASE_PRIVATE_${req.model.slice(5)}：本成员已完成独立审阅，并形成有充分依据的完整结论。`));
  };
  admit(f);await drain(f);assert.equal(trace.getRun(f.run.id).status,'waiting_for_user');const p=proposal(f),preview=delivery.previewAutonomousDecision(p.id);assert.equal(p.kind,'release');assert.equal(count('autonomous_emission_records',f),0);
  delivery.resolveAutonomousAuthorization(p.id,{action:outcome,fingerprint:p.sha256},'local-management-fixture');await drain(f);done(f);assert.equal(count('autonomous_decision_proposals',f),1);assert.equal(count('autonomous_emission_records',f),1);
  if(outcome==='approve'){assert.equal(report(f).body,preview.body);assert.equal(report(f).visibility,'public');}
  else{assert.equal(report(f).visibility,'private');assert.deepEqual(JSON.parse(report(f).audience),['user']);}
 }
 checks.push('exact release approval publishes only the frozen bytes/audience after terminal acceptance; denial with a new command key never repeats authorization and falls back to private Owner delivery');

 const question=seed('AC3_QUESTION');let qRound=0;
 behavior=(req,body)=>{qRound++;if(qRound===1)return response(call('agent.request_user',{commandKey:'missing',questions:[{key:'format',question:'最终报告需要中文还是英文？',requiredFor:'确定交付语言。'},{key:'deadline',question:'本次报告采用哪个统计日期？',requiredFor:'确定事实截止日期。'}]}));assert.match(body,/中文，统计日期为 2026-10-17/);return response(complete(rootText));};
 admit(question);await drain(question);const q=proposal(question);assert.equal(q.kind,'question');assert.equal(count('collaboration_user_decisions',question),1);
 delivery.answerAutonomousQuestion(q.collaboration_decision_id,'中文，统计日期为 2026-10-17');delivery.answerAutonomousQuestion(q.collaboration_decision_id,'重复答案不会另建唤醒');
 for(let i=0;i<3;i++)delivery.reconcileAutonomousDecisions(question.run.id);await drain(question);done(question);assert.equal(qRound,2);assert.equal(db.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",question.run.id).n,1);
 checks.push('merged necessary business questions create one card; answer continues the same Run/Subject/budget; duplicate answer and reconciliation create one wake');

 const concurrent=seed('AC3_SIBLING_QUESTION');let concurrentParent=0,asked=false,siblingFinished=false;
 behavior=(req,body)=>{
  if(req.model==='mock:planner')return response(++concurrentParent===1?delegate(concurrent):complete(rootText));
  if(req.model==='mock:aa'&&!asked){asked=true;return response(call('agent.request_user',{commandKey:'need-date',questions:[{key:'date',question:'独立审查采用哪个截止日期？',requiredFor:'确保审查事实采用同一截止日期。'}]}));}
  if(req.model==='mock:bb'){siblingFinished=true;return response(complete('SIBLING_DONE：本分支没有缺失信息，已独立完成事实核对和完整结果。'));}
  assert.match(body,/截止日期 2026-10-18/);return response(complete('QUESTION_BRANCH_DONE：已按用户补充的截止日期完成独立核对，形成完整结论。'));
 };
 scheduler.admitAutonomousCollaboration(concurrent.run.id,concurrent.draft,{deliveryVersion:1});
 const until=async predicate=>{const start=Date.now();while(!predicate()){if(Date.now()-start>15000)throw new Error('scheduler timeout');await new Promise(r=>setTimeout(r,15));}};
 await until(()=>trace.getRun(concurrent.run.id).status==='waiting_for_user');assert.equal(siblingFinished,true);assert.equal(concurrentParent,1);
 const cp=proposal(concurrent);delivery.answerAutonomousQuestion(cp.collaboration_decision_id,'截止日期 2026-10-18');scheduler.kickCollaboration(concurrent.room.id);await until(()=>['completed','failed'].includes(trace.getRun(concurrent.run.id).status));done(concurrent);assert.equal(concurrentParent,2);assert.equal(count('autonomous_decision_proposals',concurrent),1);
 assert.equal(db.get('SELECT SUM(used) n FROM orchestration_token_reservations WHERE run_id=?',concurrent.run.id).n,40);
 checks.push('production scheduler lets independent sibling finish while another branch awaits business information, then resumes branch and parent once under the same root ledger');

 const updates=seed('AC3_UPDATES');let updateRound=0;
 behavior=()=>{updateRound++;return response(updateRound===1?emit('status',{kind:'update',format:'task_status_v1',text:undefined,access:{visibility:'public',audience:[]}}):updateRound===2?emit('draft',{access:{visibility:'private',audience:['user']}}):complete(rootText));};
 admit(updates);await step(updates,{settle:false});assert.equal(count('autonomous_emission_records',updates),1);const status=JSON.parse(report(updates).body);assert.deepEqual(status,{version:1,profile:'task-status-v1',counts:{total:0}});runner.settleAutonomousRun(updates.run.id);done(updates);assert.equal(count('autonomous_emission_records',updates),2);
 assert.throws(()=>parseAutonomousControlCall(emit('forged',{format:'task_status_v1',text:undefined,counts:{secret:1}})),/AUTONOMOUS_CONTRACT_INVALID/);
 assert.throws(()=>parseAutonomousControlCall(call('agent.request_user',{commandKey:'routine',questions:[{key:'continue',question:'是否继续？',requiredFor:'例行确认'}]})),/AUTONOMOUS_CONTRACT_INVALID/);
 checks.push('authorized update publishes immediately; final waits for accepted completion; fixed task_status_v1 is server counts only and arbitrary fields/routine continue prompts reject');

 const {createAgent}=await import('../apps/server/src/agents/registry.ts');
 createAgent({id:'ac3-writer',name:'AC3 writer',description:'isolated file author',systemPrompt:'完成受控文件读写并核对版本。',model:'mock:ac3-writer',capabilities:['execute'],permissionMode:'auto',tools:['fs.write','fs.read'],disallowedTools:[],color:'#4477aa',avatar:''});
 const files=seed('AC3_FILES',{ids:[...members,'ac3-writer']});let fileParent=0,fileRound=0;
 behavior=(req,body)=>{
  if(req.model==='mock:planner'){
   fileParent++;if(fileParent===1)return response(call('agent.delegate',{commandKey:'write',items:[{key:'file',agentId:'ac3-writer',objective:'将受控文件初稿写入 report.txt 并检查内容。',allowedTools:['fs.write','fs.read']}]}));
   if(fileParent===2)return response(call('agent.aggregate',{commandKey:'rewrite',key:'merged-file',agentId:'ac3-writer',objective:'读取选定初稿版本，补充最终结论并写入 final.txt，再读取核验。',resultKeys:['file'],allowedTools:['fs.write','fs.read']}));
   assert.match(body,/FILE_FINAL_COMPLETED/);return response(complete(rootText));
  }
  fileRound++;
  if(fileRound===1)return response(call('fs.write',{path:'report.txt',content:'FILE_INITIAL_FACT：这是被明确审阅的初稿事实与依据。'}));
  if(fileRound===2)return response(complete('FILE_DRAFT_COMPLETE：初稿受控文件已实际写入，版本与工具回执均已确认。'));
  if(fileRound===3){assert.match(body,/FILE_INITIAL_FACT/);return response(call('fs.write',{path:'final.txt',content:'FILE_FINAL_FACT：补充独立核验后的最终结论与限制。'}));}
  if(fileRound===4)return response(call('fs.read',{path:'final.txt'}));
  assert.match(body,/FILE_FINAL_FACT/);return response(complete('FILE_FINAL_COMPLETED：受控初稿已读取，最终文件已补充并重新读取，完整核验已经完成。'));
 };
 admit(files);await drain(files);done(files);assert.equal(fileRound,5);assert.match(report(files).body,/final.txt/);assert.match(report(files).body,/下载受控文件/);
 const finalArtifact=db.get("SELECT id FROM managed_artifact_versions WHERE run_id=? AND path='final.txt'",files.run.id);assert.ok(finalArtifact);
 assert.equal(db.get("SELECT COUNT(*) n FROM runtime_input_provenance p JOIN collaboration_attempts a ON a.id=p.attempt_id WHERE a.run_id=? AND json_extract(p.record,'$.source.kind')='artifact'",files.run.id).n>0,true);
 checks.push('controlled file author -> automatic aggregate reads sealed artifact version -> writes and reads final artifact -> final delivery includes controlled file reference and recorded source reads');

 const fileIntake=seed('AC3_FILE_INTAKE',{ids:[...members,'ac3-writer']});const secret=post({runId:fileIntake.run.id,from:'user',to:'ac3-writer',kind:'system',body:'INTAKE_FILE_SOURCE_SECRET',visibility:'private',audience:['user','ac3-writer']});fileIntake.draft.inputs=[{kind:'message',id:secret.id,readers:['ac3-writer']}];let fiParent=0,fiWriter=0;
 const fileAggregate=commandKey=>call('agent.aggregate',{commandKey,key:'file-synthesis',agentId:'summary',objective:'根据选定文件版本与审阅结论形成完整总评。',resultKeys:['file']});
 behavior=(req,body)=>{
  if(req.model==='mock:planner'){fiParent++;assert.doesNotMatch(body,/INTAKE_FILE_SOURCE_SECRET|INTAKE_FILE_EXACT_CONTENT/);if(fiParent===1)return response(call('agent.delegate',{commandKey:'private-file',items:[{key:'file',agentId:'ac3-writer',objective:'依据独立私密材料写入可核验的受控报告。',inputIds:[secret.id],allowedTools:['fs.write']}]}));return response(fiParent<=3?fileAggregate('file-merge-'+fiParent):complete(rootText));}
  if(req.model==='mock:ac3-writer')return response(++fiWriter===1?call('fs.write',{path:'private.txt',content:'INTAKE_FILE_EXACT_CONTENT：这是获准读取的报告版本，不包含原始材料全文。'}):complete('INTAKE_FILE_WRITER_DONE：已完成基于独立材料的受控报告，并核对写入的真实版本。'));
  assert.match(body,/INTAKE_FILE_EXACT_CONTENT/);assert.doesNotMatch(body,/INTAKE_FILE_SOURCE_SECRET/);return response(complete('INTAKE_FILE_SYNTHESIS：已实际读取明确授权的报告副本与结论，完成事实和依据的综合审阅。'));
 };
 admit(fileIntake);await drain(fileIntake);const fp=proposal(fileIntake);assert.equal(fp.kind,'intake');const originalFile=db.get("SELECT * FROM managed_artifact_versions WHERE run_id=?",fileIntake.run.id);assert.ok(originalFile);
 delivery.resolveAutonomousAuthorization(fp.id,{action:'approve',fingerprint:fp.sha256},'local-management-fixture');assert.equal(count('autonomous_intake_copies',fileIntake),2);assert.equal(db.get('SELECT record FROM managed_artifact_versions WHERE id=?',originalFile.id).record,originalFile.record);
 await drain(fileIntake);done(fileIntake);assert.match(report(fileIntake).body,/private.txt/);assert.deepEqual(JSON.parse(report(fileIntake).audience),['user']);
 const copy=JSON.parse(db.get("SELECT record FROM autonomous_intake_copies WHERE run_id=? AND json_extract(record,'$.ref.kind')='artifact'",fileIntake.run.id).record);assert.equal(results.validateAutonomousDerivedSource(fileIntake.run.id,copy.ref),true);
 const writerResult=JSON.parse(db.get("SELECT r.record FROM autonomous_results r JOIN autonomous_work_items w ON w.id=r.work_id WHERE w.run_id=? AND w.work_key='file'",fileIntake.run.id).record);db.run('UPDATE messages SET body=? WHERE id=?','changed original sealed result',writerResult.message.id);assert.throws(()=>results.validateAutonomousDerivedSource(fileIntake.run.id,copy.ref),/AUTONOMOUS_/);
 checks.push('exact intake includes immutable artifact versions; approved copies enter real aggregate context without raw input, original file ACL remains unchanged, and copy authority still validates its upstream accepted result');

 const self=seed('AC3_SELF');let selfRoot=0;
 behavior=(req,body)=>{if(req.model==='mock:planner'){
  if(body.includes('自汇总责任：')){assert.match(body,/SELF_REVIEW_aa/);assert.match(body,/SELF_REVIEW_bb/);return response(complete('SELF_SYNTHESIS：新的自汇总责任实际读取两个合法结果，并完成完整的事实对照与总评。'));}
  selfRoot++;if(selfRoot===1)return response(delegate(self));if(selfRoot===2)return response(call('agent.aggregate',{commandKey:'self',key:'self-merge',agentId:'planner',objective:'自汇总责任：比较两个合法审阅结果。',resultKeys:['aa','bb']}));assert.match(body,/SELF_SYNTHESIS/);return response(complete(rootText));
 }return response(complete(`SELF_REVIEW_${req.model.slice(5)}：独立审阅已经完成，事实、依据和建议均已记录。`));};
 admit(self);await drain(self);done(self);assert.equal(selfRoot,3);
 checks.push('coordinator can aggregate in a new content Subject without replaying its control history or widening the original Grant');

 const postAwait=seed('AC3_POST_AWAIT');let paRoot=0;
 behavior=(req,body)=>{
  if(req.model==='mock:planner'){paRoot++;return response(paRoot===1?delegate(postAwait):aggregate());}
  if(req.model==='mock:summary'){
   const original=db.get("SELECT record FROM autonomous_results r JOIN autonomous_work_items w ON w.id=r.work_id WHERE w.run_id=? AND w.work_key='aa'",postAwait.run.id);
   db.run('UPDATE messages SET body=? WHERE id=?','edited result while aggregate model awaited',JSON.parse(original.record).message.id);
   return response(complete('这是一份已经失去有效来源的汇总结果，不能提交到验收或继续交付。'));
  }
  return response(complete(`POST_AWAIT_${req.model.slice(5)}：已形成完整且可核验的独立审阅结果。`));
 };
 admit(postAwait);await drain(postAwait);assert.equal(trace.getRun(postAwait.run.id).status,'failed');assert.equal(count('autonomous_emission_records',postAwait),0);assert.equal(db.get("SELECT COUNT(*) n FROM autonomous_results WHERE run_id=?",postAwait.run.id).n,2);
 checks.push('source drift during an awaited aggregate model request blocks candidate acceptance and final publication after the await');

 const recovery=seed('AC3_RECOVER');let recoveryRound=0;
 behavior=()=>response(++recoveryRound===1?call('agent.request_user',{commandKey:'detail',questions:[{key:'format',question:'报告要使用哪个格式？',requiredFor:'生成可用报告。'}]}):complete(rootText));
 admit(recovery);await drain(recovery);const recoverProposal=proposal(recovery);
 // Snapshot a committed answer before its unique wake, simulating a process ending between transactions.
 const recoverRecord={messageId:post({runId:recovery.run.id,from:'user',to:'planner',kind:'user',body:'采用中文 Markdown 格式。',...JSON.parse(recoverProposal.record).access}).id,fingerprint:recoverProposal.sha256};
 const sha=v=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x)).digest('hex');
 db.run("INSERT INTO autonomous_decision_resolutions VALUES(?,?,'answered','user',?,?,?)",recoverProposal.id,recovery.run.id,JSON.stringify(recoverRecord),sha(recoverRecord),new Date().toISOString());store.resolveDecision(recoverProposal.collaboration_decision_id,'accepted',{messageId:recoverRecord.messageId});trace.setRunStatus(recovery.run.id,'running');
 const recoveryDb=path.join(env.root,'recover.sqlite');await db.db.backup(recoveryDb);
 const recoverCode=`import assert from 'node:assert/strict';const d=await import('./apps/server/src/db/database.ts');const {config}=await import('./apps/server/src/config.ts');config.autonomousCollaborationMode='execute';const p=await import('./apps/server/src/llm/provider.ts');let calls=0;p.mockProvider.chat=async req=>{calls++;assert.match(req.messages.map(m=>m.content).join('\\n'),/采用中文 Markdown 格式/);return ${JSON.stringify(response(complete(rootText)))}};const s=await import('./apps/server/src/collaboration/scheduler.ts');const id=process.env.AC3_RECOVERY_RUN;s.recoverCollaborationRuns();s.recoverCollaborationRuns();const start=Date.now();while(!['completed','failed'].includes(d.get('SELECT status FROM runs WHERE id=?',id).status)){if(Date.now()-start>10000)throw new Error('timeout');await new Promise(r=>setTimeout(r,20));}assert.equal(d.get('SELECT status FROM runs WHERE id=?',id).status,'completed');s.recoverCollaborationRuns();const wakes=d.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",id).n,emissions=d.get('SELECT COUNT(*) n FROM autonomous_emission_records WHERE run_id=?',id).n;assert.equal(wakes,1);assert.equal(emissions,1);assert.equal(calls,1);console.log(JSON.stringify({calls,wakes,emissions}));d.closeDatabase();`;
 const recovered=JSON.parse(execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',recoverCode],{env:{...process.env,DB_PATH:recoveryDb,AC3_RECOVERY_RUN:recovery.run.id},encoding:'utf8',stdio:'pipe'}).trim().split('\n').at(-1));freshProcessCalls+=recovered.calls;cleanup(recovery);
 checks.push('fresh Node worker recovers a committed answer with no wake, resumes exactly once, then publishes one final report; duplicate startup never replays the original model call');

 const terminalRecovery=seed('AC3_TERMINAL_RECOVERY');behavior=()=>response(complete(rootText));admit(terminalRecovery);await step(terminalRecovery,{settle:false});assert.equal(trace.getRun(terminalRecovery.run.id).status,'running');assert.equal(count('autonomous_emission_records',terminalRecovery),0);
 const terminalDb=path.join(env.root,'terminal.sqlite');await db.db.backup(terminalDb);
 const terminalCode=`import assert from 'node:assert/strict';const d=await import('./apps/server/src/db/database.ts');const {config}=await import('./apps/server/src/config.ts');config.autonomousCollaborationMode='execute';const p=await import('./apps/server/src/llm/provider.ts');p.mockProvider.chat=async()=>{throw new Error('must not repeat accepted model call')};const r=await import('./apps/server/src/collaboration/autonomousRunner.ts');const id=process.env.AC3_RECOVERY_RUN;r.settleAutonomousRun(id);r.settleAutonomousRun(id);assert.equal(d.get('SELECT status FROM runs WHERE id=?',id).status,'completed');assert.equal(d.get('SELECT COUNT(*) n FROM autonomous_emission_records WHERE run_id=?',id).n,1);console.log('passed');d.closeDatabase();`;
 assert.match(execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',terminalCode],{env:{...process.env,DB_PATH:terminalDb,AC3_RECOVERY_RUN:terminalRecovery.run.id},encoding:'utf8',stdio:'pipe'}),/passed/);runner.settleAutonomousRun(terminalRecovery.run.id);done(terminalRecovery);
 checks.push('fresh Node worker closes accepted root and creates one final delivery atomically without any extra Provider call');

 const unknown=seed('AC3_UNKNOWN');behavior=()=>response(complete(rootText));admit(unknown);await step(unknown,{settle:false});
 db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,used,status,created_at) VALUES(?,?,123,123,'unknown',?)",randomUUID(),unknown.run.id,new Date().toISOString());
 // Use a real unknown model-call fact as well, preserving the reservation rather than inventing completion evidence.
 const priorCall=db.get('SELECT * FROM orchestration_model_calls WHERE run_id=? LIMIT 1',unknown.run.id);db.run("UPDATE orchestration_model_calls SET status='unknown' WHERE id=?",priorCall.id);runner.settleAutonomousRun(unknown.run.id);
 assert.equal(trace.getRun(unknown.run.id).status,'failed');assert.equal(count('autonomous_emission_records',unknown),0);assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id=? AND status='unknown'",unknown.run.id).n,1);
 checks.push('unknown usage after root acceptance retains allowance and prevents terminal final delivery');

 for(const mutation of ['source','members','revoke','stop','expiry']){
  const f=seed('AC3_DRIFT_'+mutation,{privateInputs:true});let n=0;
  behavior=req=>{if(req.model==='mock:planner'){n++;return response(n===1?delegate(f):aggregate());}return response(complete('DRIFT_PRIVATE_RESULT：对独立材料的检查已完成，当前结果版本包含完整事实与限制。'));};
  admit(f);await drain(f);const p=proposal(f);assert.equal(p.kind,'intake');
  if(mutation==='source')db.run('UPDATE messages SET body=? WHERE id=?','edited private source',f.inputs[0].id);
  if(mutation==='members')db.run('UPDATE conversations SET members_version=members_version+1 WHERE id=?',f.room.id);
  if(mutation==='revoke')tasks.revokeAutonomousAuthority(f.run.id,null,'isolated revocation');
  if(mutation==='stop')cleanup(f);
  const realNow=Date.now;if(mutation==='expiry')Date.now=()=>realNow()+3600000;
  try{assert.throws(()=>delivery.resolveAutonomousAuthorization(p.id,{action:'approve',fingerprint:p.sha256},'local-management-fixture'),/AUTONOMOUS_/);}finally{Date.now=realNow;}
  assert.equal(count('autonomous_intake_copies',f),0);assert.equal(count('autonomous_decision_resolutions',f),0);assert.equal(count('autonomous_emission_records',f),0);cleanup(f);
 }
 checks.push('source edits, membership changes, revocation, stop and deadline expiry invalidate stale approval atomically, producing no copy, resolution or delivery');

 for(const table of ac3Tables)assert.throws(()=>db.run(`DELETE FROM ${table}`),/immutable/);
 assert.deepEqual(db.db.pragma('foreign_key_check'),[]);assert.equal(env.externalRequests,0);assert.equal((await env.nativeCalls()).length,0);
 const result={passed:true,checks,schema:latestSchema,fixtureModelCalls:modelCalls+freshProcessCalls,freshProcessCalls,realSupplierRequests:0,realNativeInvocations:0,defaultUiAvailable:false};await writeFile(path.join(qa,'result.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
}finally{await rm(oldModule,{force:true});await env.close();}
