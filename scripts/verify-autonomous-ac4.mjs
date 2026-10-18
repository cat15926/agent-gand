import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';
const env=await createDemoEnvironment(),db=env.database,qa=path.resolve('apps/server/data/autonomous-ac4-qa'),checks=[];await mkdir(qa,{recursive:true,mode:0o700});
const {config}=await import('../apps/server/src/config.ts');config.autonomousCollaborationMode='execute';
const trace=await import('../apps/server/src/runs/trace.ts'),scheduler=await import('../apps/server/src/collaboration/scheduler.ts'),rooms=await import('../apps/server/src/conversations/service.ts'),{post}=await import('../apps/server/src/messaging/inbox.ts');
const {mockProvider}=await import('../apps/server/src/llm/provider.ts'),{createAgent}=await import('../apps/server/src/agents/registry.ts');
const {loadRuntimeContract}=await import('../apps/server/src/runtime/runPolicy.ts'),{auditShadowRun}=await import('../apps/server/src/runtime/shadow.ts');
const {freezeAutonomousTask}=await import('../apps/server/src/runtime/autonomousTasks.ts');
let behavior,calls=0,freshProcessCalls=0;mockProvider.chat=async req=>{calls++;return behavior(req,req.messages.map(m=>m.content).join('\n'));};
const call=(name,input)=>({name,input:JSON.stringify(input)}),complete=(summary='所有独立工作与实际来源已完成核对，按用户的最新要求交付完整结论和可验证结果。')=>call('agent.complete',{summary});
const response=tool=>({content:'',toolCalls:[tool],usage:{tokensIn:5,tokensOut:8,costUsd:0,inputKnown:true,outputKnown:true,costKnown:true,costSource:'reported'},truncated:false,stopReason:'tool_use'});
const until=async(condition,label)=>{const start=Date.now();while(!condition()){if(Date.now()-start>15000)throw new Error('timeout: '+label);await new Promise(r=>setTimeout(r,15));}};
const send=body=>env.app.inject({method:'POST',url:body.conversationId?`/api/conversations/${body.conversationId}/requests`:'/api/conversations',payload:body});
const seed=(goal,extra={})=>({entryVersion:2,goal,agentIds:['planner','aa','bb','summary'],clientRequestId:randomUUID(),...extra});
const final=id=>db.get('SELECT m.* FROM messages m JOIN autonomous_emission_records e ON e.message_id=m.id WHERE e.run_id=?',id);
const done=async id=>{await until(()=>['completed','failed','cancelled'].includes(trace.getRun(id).status),'task terminal');assert.equal(trace.getRun(id).status,'completed',JSON.stringify(db.all('SELECT status,error FROM collaboration_dispatches WHERE run_id=?',id)));assert.deepEqual(auditShadowRun(id),[]);};
const oldModule=path.join(qa,'v20-'+randomUUID()+'.ts');
try{
 // Genuine AC3 contract in a schema20 fixture, accepted by an actual v20 module.
 const oldRoom=rooms.createConversation({title:'AC4 historical',mode:'collaboration',agentIds:['planner'],supervisorId:null,workspace:null});const oldRun=trace.createRun('完整历史任务用于迁移保留。','collaboration',['planner'],null,null,oldRoom.id);post({runId:oldRun.id,from:'user',to:'planner',kind:'user',body:oldRun.goal});
 freezeAutonomousTask(oldRun.id,{coordinatorId:'planner',participantIds:['planner']},{delegationVersion:1,deliveryVersion:1});
 assert.throws(()=>freezeAutonomousTask(oldRun.id,{coordinatorId:'planner',participantIds:['planner']},{delegationVersion:1,deliveryVersion:1,entryVersion:1}),/AUTONOMOUS_AUTHORITY_INVALID/);
 const migrationDb=path.join(env.root,'v20.sqlite');await db.db.backup(migrationDb);const historical=new Database(migrationDb);historical.exec('PRAGMA foreign_keys=OFF;DROP TABLE autonomous_pause_points;DROP TABLE autonomous_user_instructions;DROP TABLE autonomous_submissions;DELETE FROM orchestration_schema_migrations WHERE version>=21;PRAGMA foreign_keys=ON');
 // The backup is created before any AC4 root; the v20 fixture contains only an actual AC3 contract.
 const tables=historical.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('orchestration_schema_migrations','sqlite_sequence') ORDER BY name").all().map(r=>r.name);const sha=d=>createHash('sha256').update(JSON.stringify(tables.map(t=>d.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex');const before=sha(historical);
 await writeFile(oldModule,execFileSync('git',['show','4b583be:apps/server/src/db/orchestrationMigrations.ts'],{encoding:'utf8'}),{mode:0o600});const old=await import(pathToFileURL(oldModule).href);old.assertOrchestrationSchemaCompatible(historical);historical.close();
 for(let n=0;n<2;n++)execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',"const d=await import('./apps/server/src/db/database.ts');if(d.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n!==21)throw new Error('schema');d.closeDatabase();"],{env:{...process.env,DB_PATH:migrationDb},stdio:'pipe'});
 const upgraded=new Database(migrationDb,{readonly:true});assert.equal(sha(upgraded),before);assert.throws(()=>old.assertOrchestrationSchemaCompatible(upgraded),/版本|migration|schema/i);assert.deepEqual(upgraded.pragma('foreign_key_check'),[]);upgraded.close();
 checks.push('schema20 to21 preserves all historical rows twice, actual v20 worker refuses new schema, frozen AC3 root cannot upgrade');
 const initialRuns=db.get('SELECT COUNT(*) n FROM runs').n;
 let rootCalls=0;
 behavior=(req,body)=>{
  if(req.model==='mock:planner'){
   if(body.includes('AC4_SYNTHESIS_OBJECTIVE')){assert.match(body,/REVIEW_AA/);assert.match(body,/REVIEW_BB/);return response(complete('AC4_SYNTHESIS_DONE：实现和测试意见已完成事实对照，报告结论已更新并保留依据。'));}
   rootCalls++;assert.match(body,/AC4_ATTACHMENT_FACT/);
   if(rootCalls===1){assert.doesNotMatch(body,/ROOM_HISTORY_POISON/);const file=db.get("SELECT id FROM managed_artifact_versions WHERE path='attachments/plan.txt'");return response(call('agent.delegate',{commandKey:'review',items:['aa','bb'].map(id=>({key:id,agentId:id,objective:`独立检查 ${id} 的实现或测试风险，提供完整事实与建议。`,inputIds:[file.id]}))}));}
   if(rootCalls===2)return response(call('agent.aggregate',{commandKey:'merge',key:'summary',agentId:'planner',objective:'AC4_SYNTHESIS_OBJECTIVE：读取审查并合并意见。',resultKeys:['aa','bb']}));
   assert.match(body,/AC4_SYNTHESIS_DONE/);return response(complete());
  }
  assert.match(body,/AC4_ATTACHMENT_FACT/);return response(complete(`REVIEW_${req.model.slice(5).toUpperCase()}：已经独立核验材料中的具体实现和测试事实，提出完整修订意见。`));
 };
 const input=seed('AC4_ORDINARY：评审设计并合并实现和测试意见。',{attachments:[{path:'attachments/plan.txt',contentBase64:Buffer.from('AC4_ATTACHMENT_FACT：这是一份明确选择的方案材料。').toString('base64')}]});
 const result=await send(input);assert.equal(result.statusCode,201,result.body);const f=result.json();await done(f.run.id);assert.equal(rootCalls,3);assert.match(final(f.run.id).body,/AC4_SYNTHESIS_DONE/);assert.equal(db.get('SELECT COUNT(*) n FROM runs').n,initialRuns+1);
 const repeated=await send(input);assert.equal(repeated.statusCode,200,repeated.body);assert.equal(repeated.json().run.id,f.run.id);assert.equal((await send({...input,goal:'changed'})).statusCode,409);assert.equal((await send({entryVersion:1,goal:input.goal,agentIds:input.agentIds,clientRequestId:input.clientRequestId,strategy:'auto',workflow:'routine'})).statusCode,409);assert.equal(db.get('SELECT COUNT(*) n FROM runs').n,initialRuns+1);
 assert.equal(loadRuntimeContract(f.run.id).features.autonomousCollaboration.entryVersion,1);assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_requests WHERE run_id=?',f.run.id).n,0);
 const progress=await env.app.inject({method:'GET',url:`/api/conversations/${f.conversation.id}/task-state`});assert.equal(progress.statusCode,200,progress.body);assert.equal(progress.json().tasks[0].autonomous.works.length,4);
 checks.push('ordinary HTTP send with attachment executes real delegation, content aggregation and one final delivery under one Run; exact retries return original task, changed retries fail, no preview/manual plan/legacy history');

 let release,started=false,round=0;const barrier=new Promise(r=>release=r);
 behavior=async(req,body)=>{round++;if(round===1){started=true;await barrier;return response(complete('STALE_ACTION_MUST_NOT_COMMIT：这个结果在用户补充到达前形成，不可作为最新完成。'));}assert.match(body,/SUPPLEMENT_MOBILE_PRIORITY/);return response(complete('MOBILE_PRIORITY_ACCEPTED：根据补充优先检查移动端，已完成最新要求的完整结论。'));};
 const supplemented=await send(seed('AC4_SUPPLEMENT：请检查交互方案。'));assert.equal(supplemented.statusCode,201,supplemented.body);const sf=supplemented.json();await until(()=>started,'initial request issued');
 const instruction={text:'SUPPLEMENT_MOBILE_PRIORITY：重点检查移动端。',clientRequestId:randomUUID(),expectedRevision:0};
 const supplement=()=>env.app.inject({method:'POST',url:`/api/runs/${sf.run.id}/instructions`,payload:instruction});assert.equal((await supplement()).statusCode,200);assert.equal((await supplement()).json().deduplicated,true);
 assert.equal((await env.app.inject({method:'POST',url:`/api/runs/${sf.run.id}/instructions`,payload:{...instruction,clientRequestId:randomUUID(),text:'stale expected revision'}})).statusCode,409);
 release();await done(sf.run.id);assert.equal(round,2);assert.doesNotMatch(final(sf.run.id).body,/STALE_ACTION/);assert.match(final(sf.run.id).body,/MOBILE_PRIORITY_ACCEPTED/);assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_user_instructions WHERE run_id=?',sf.run.id).n,1);assert.equal(db.get('SELECT COUNT(*) n FROM runtime_completion_candidates WHERE run_id=?',sf.run.id).n,1);
 assert.equal(db.get('SELECT SUM(used) n FROM orchestration_token_reservations WHERE run_id=?',sf.run.id).n,16);
 checks.push('in-flight user supplement is versioned/idempotent in the same task, enters actual provenance before the next model call, fences stale completion without erasing charged usage or creating a second Run');

 createAgent({id:'ac4-writer',name:'AC4 writer',description:'controlled writer',systemPrompt:'完成受控文件并核对回执。',model:'mock:ac4-writer',capabilities:['execute','coordinate'],permissionMode:'auto',tools:['fs.write','fs.read'],disallowedTools:[],color:'#4477aa',avatar:''});
 let pauseRelease,pauseStarted=false,pauseRound=0;const pauseBarrier=new Promise(r=>pauseRelease=r);
 behavior=async(req,body)=>{pauseRound++;if(pauseRound===1)return response(call('fs.write',{path:'report.txt',content:'AC4_ONE_WRITE'}));if(pauseRound===2){pauseStarted=true;await pauseBarrier;return response(complete());}assert.match(body,/AC4_PAUSED_SUPPLEMENT/);assert.match(body,/report.txt/);return response(complete('PAUSE_RESUMED_RESULT：沿用已写文件版本与工具回执，根据暂停期间补充完成最终核验。'));};
 const paused=await send(seed('AC4_PAUSE：写报告后检查交付。',{agentIds:['ac4-writer'],coordinatorId:'ac4-writer'}));assert.equal(paused.statusCode,201,paused.body);const pf=paused.json();await until(()=>pauseStarted,'second model request');
 const action=value=>env.app.inject({method:'POST',url:`/api/runs/${pf.run.id}/actions`,payload:{action:value}});
 const requested=await action('pause');assert.equal(requested.statusCode,200,requested.body);pauseRelease();await until(()=>trace.getRun(pf.run.id).status==='waiting_for_user','safe pause');assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_pause_points WHERE run_id=?',pf.run.id).n,1);assert.equal(db.get('SELECT COUNT(*) n FROM runtime_completion_candidates WHERE run_id=?',pf.run.id).n,0);
 const supplementPaused=await env.app.inject({method:'POST',url:`/api/runs/${pf.run.id}/instructions`,payload:{text:'AC4_PAUSED_SUPPLEMENT：保留文件并补充验证说明。',clientRequestId:randomUUID(),expectedRevision:0}});assert.equal(supplementPaused.statusCode,200,supplementPaused.body);
 const pauseSnapshot=path.join(env.root,'paused-recovery.sqlite');await db.db.backup(pauseSnapshot);
 const recoverCode=`import assert from 'node:assert/strict';const d=await import('./apps/server/src/db/database.ts');const {config}=await import('./apps/server/src/config.ts');config.autonomousCollaborationMode='execute';let calls=0;const {mockProvider}=await import('./apps/server/src/llm/provider.ts');mockProvider.chat=async req=>{calls++;assert.match(req.messages.map(m=>m.content).join('\\n'),/AC4_PAUSED_SUPPLEMENT/);return ${JSON.stringify(response(complete()))}};const {applyRunAction}=await import('./apps/server/src/orchestration/actions.ts');const s=await import('./apps/server/src/collaboration/scheduler.ts');const id=process.env.AC4_RECOVERY_ID;await applyRunAction(id,'resume');s.recoverCollaborationRuns();s.recoverCollaborationRuns();const start=Date.now();while(!['completed','failed'].includes(d.get('SELECT status FROM runs WHERE id=?',id).status)){if(Date.now()-start>10000)throw new Error('timeout');await new Promise(r=>setTimeout(r,20));}assert.equal(d.get('SELECT status FROM runs WHERE id=?',id).status,'completed');assert.equal(calls,1);assert.equal(d.get(\"SELECT COUNT(*) n FROM tool_executions WHERE run_id=? AND tool_name='fs.write'\",id).n,1);assert.equal(d.get('SELECT COUNT(*) n FROM autonomous_emission_records WHERE run_id=?',id).n,1);console.log(JSON.stringify({calls}));d.closeDatabase();`;
 const recovered=JSON.parse(execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',recoverCode],{env:{...process.env,DB_PATH:pauseSnapshot,AC4_RECOVERY_ID:pf.run.id},encoding:'utf8',stdio:'pipe'}).trim().split('\n').at(-1));freshProcessCalls+=recovered.calls;
 checks.push('fresh Node worker resumes a paused responsibility after user instructions, preserving the one completed write; repeated startup produces one continuation call and one final delivery');
 const resumed=await action('resume');assert.equal(resumed.statusCode,200,resumed.body);await done(pf.run.id);assert.equal(pauseRound,3);assert.equal(db.get('SELECT COUNT(*) n FROM managed_artifact_versions WHERE run_id=?',pf.run.id).n,1);assert.equal(db.get("SELECT COUNT(*) n FROM tool_executions WHERE run_id=? AND tool_name='fs.write'",pf.run.id).n,1);assert.match(final(pf.run.id).body,/report.txt/);
 checks.push('pause during actual model I/O waits for a safe boundary and saves the same responsibility; resume carries file receipts, instructions and budget, writes once and publishes once');

 behavior=req=>{assert.equal(req.tools.some(t=>t.name==='fs.write'),false);return response(complete());};const readonly=await send(seed('AC4_READONLY：只读分析。',{agentIds:['ac4-writer'],coordinatorId:'ac4-writer',constraints:{readonly:true}}));assert.equal(readonly.statusCode,201,readonly.body);await done(readonly.json().run.id);
 checks.push('ordinary readonly constraint is frozen into role/grant/tool policy rather than only shown in the UI');
 let finalRelease,finalStarted=false,finalRound=0;const finalBarrier=new Promise(r=>finalRelease=r);
 behavior=async(req,body)=>{finalRound++;if(finalRound===1)return response(call('agent.emit',{commandKey:'old-final',kind:'final',format:'text',text:'OLD_FINAL_BEFORE_INSTRUCTION：这份候选还没有处理后来的移动端要求。'}));if(finalRound===2){finalStarted=true;await finalBarrier;return response(complete());}assert.match(body,/FINAL_INSTRUCTION_CHANGED/);return response(complete('NEW_FINAL_AFTER_INSTRUCTION：已按补充要求重新核验移动端交付，形成完整有效的新结论。'));};
 const staged=await send(seed('AC4_FINAL_REVISION：形成最终报告。'));const stagedRun=staged.json().run;await until(()=>finalStarted,'old final candidate');assert.equal(final(stagedRun.id),undefined);
 const changed=await env.app.inject({method:'POST',url:`/api/runs/${stagedRun.id}/instructions`,payload:{text:'FINAL_INSTRUCTION_CHANGED：最终报告需要覆盖移动端。',clientRequestId:randomUUID(),expectedRevision:0}});assert.equal(changed.statusCode,200,changed.body);finalRelease();await done(stagedRun.id);assert.equal(finalRound,3);assert.match(final(stagedRun.id).body,/NEW_FINAL_AFTER_INSTRUCTION/);assert.doesNotMatch(final(stagedRun.id).body,/OLD_FINAL_BEFORE/);
 checks.push('new user instructions invalidate an older unposted final candidate; accepted latest work is delivered instead, without changing an already published update');

 let quoteRelease,quoteStarted=false;const quoteBarrier=new Promise(r=>quoteRelease=r);const source=final(f.run.id);
 const illegalQuote=await send({entryVersion:2,conversationId:f.conversation.id,goal:'引用私密报告但试图公开给全部成员。',clientRequestId:randomUUID(),replyTo:source.id});assert.equal(illegalQuote.statusCode,400,illegalQuote.body);
 behavior=async(req,body)=>{assert.match(body,/AC4_SYNTHESIS_DONE/);quoteStarted=true;await quoteBarrier;return response(complete());};
 const quoted=await send({entryVersion:2,conversationId:f.conversation.id,goal:'明确引用这份报告进行后续核对。',clientRequestId:randomUUID(),replyTo:source.id,visibility:'private',audience:['planner'],participantIds:['planner']});assert.equal(quoted.statusCode,202,quoted.body);await until(()=>quoteStarted,'quoted model request');db.run('UPDATE messages SET body=? WHERE id=?','changed source report',source.id);quoteRelease();await until(()=>['completed','failed'].includes(trace.getRun(quoted.json().run.id).status),'quoted drift fenced');assert.equal(trace.getRun(quoted.json().run.id).status,'failed');assert.equal(final(quoted.json().run.id),undefined);
 checks.push('explicit quote copies only an authorized same-room version, rejects private-to-public expansion and fences source drift after model I/O; unrelated room history never enters context');

 const beforeRuns=db.get('SELECT COUNT(*) n FROM runs').n,beforeCalls=calls;
 for(const body of [seed('invalid',{agentIds:['sdk'],coordinatorId:'sdk'}),seed('@Codex（模拟） 请检查',{agentIds:['planner','codex']}),seed('bad',{participantIds:['not-in-room']}),seed('bad',{constraints:{maxTokens:config.collaboration.maxTokens+1}}),seed('bad',{constraints:{costPolicy:{version:1,currency:'USD',mode:'strict',maxCost:1,unknownAction:'stop',prices:[]}}}),seed('bad',{grantId:'fake'}),seed('bad',{replyTo:'not-existing'}),seed('x'.repeat(12001)),seed('binary',{attachments:[{path:'binary.dat',contentBase64:Buffer.from([0,1,2]).toString('base64')}]})]){
  const failure=await send(body);assert.ok(failure.statusCode>=400,failure.body);
 }
 assert.equal(db.get('SELECT COUNT(*) n FROM runs').n,beforeRuns);assert.equal(calls,beforeCalls);
 config.autonomousCollaborationMode='closed';const closed=await send(seed('closed'));assert.equal(closed.statusCode,409);assert.equal(db.get('SELECT COUNT(*) n FROM runs').n,beforeRuns);assert.equal((await send(input)).json().run.id,f.run.id);config.autonomousCollaborationMode='execute';
 checks.push('unsupported native member/mention, outside team, excess budget, strict pricing, fake authority, missing reply and closed rollout reject before model I/O with atomic admission rollback; known retry remains readable while closed');

 let stopRelease,stopStarted=false;const stopBarrier=new Promise(r=>stopRelease=r);behavior=async()=>{stopStarted=true;await stopBarrier;return response(complete());};const stopped=await send(seed('AC4_STOP：等待模型期间停止。'));const stop=stopped.json();await until(()=>stopStarted,'stop request');const cancelled=await env.app.inject({method:'POST',url:`/api/runs/${stop.run.id}/actions`,payload:{action:'cancel'}});assert.equal(cancelled.statusCode,200,cancelled.body);stopRelease();await new Promise(r=>setTimeout(r,50));assert.equal(trace.getRun(stop.run.id).status,'cancelled');assert.equal(final(stop.run.id),undefined);assert.equal((await env.app.inject({method:'POST',url:`/api/runs/${stop.run.id}/instructions`,payload:{text:'停止后不能继续',clientRequestId:randomUUID(),expectedRevision:0}})).statusCode,409);
 checks.push('user stop fences late model output, keeps terminal history and rejects additional instructions');

 for(const table of ['autonomous_submissions','autonomous_user_instructions','autonomous_pause_points'])assert.throws(()=>db.run(`DELETE FROM ${table}`),/immutable/);
 assert.deepEqual(db.db.pragma('foreign_key_check'),[]);assert.equal(env.externalRequests,0);assert.equal((await env.nativeCalls()).length,0);
 const report={passed:true,checks,schema:21,fixtureModelCalls:calls+freshProcessCalls,freshProcessCalls,realSupplierRequests:0,realNativeInvocations:0,rolloutDefault:'closed'};await writeFile(path.join(qa,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{await rm(oldModule,{force:true});await env.close();}
