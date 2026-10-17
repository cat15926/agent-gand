import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {createDemoEnvironment} from './helpers/orchestration-demo-environment.mjs';

const env=await createDemoEnvironment(),db=env.database,checks=[],qa=path.resolve('apps/server/data/autonomous-ac2-qa');
await mkdir(qa,{recursive:true,mode:0o700});const oldModule=path.join(qa,'v18-worker-'+randomUUID()+'.ts');
const {config}=await import('../apps/server/src/config.ts');
const rooms=await import('../apps/server/src/conversations/service.ts'),trace=await import('../apps/server/src/runs/trace.ts'),{post}=await import('../apps/server/src/messaging/inbox.ts');
const tasks=await import('../apps/server/src/runtime/autonomousTasks.ts'),graph=await import('../apps/server/src/collaboration/autonomousGraph.ts');
const runner=await import('../apps/server/src/collaboration/autonomousRunner.ts'),scheduler=await import('../apps/server/src/collaboration/scheduler.ts'),store=await import('../apps/server/src/collaboration/store.ts');
const {mockProvider}=await import('../apps/server/src/llm/provider.ts'),{parseAutonomousControlCall}=await import('../apps/server/src/collaboration/autonomousTools.ts');
const {auditShadowRun}=await import('../apps/server/src/runtime/shadow.ts');
const {commitRunTerminal}=await import('../apps/server/src/runtime/terminal.ts');
const latestSchema=(await import('../apps/server/src/db/orchestrationMigrations.ts')).ORCHESTRATION_MIGRATIONS.at(-1).version;
const members=['planner','aa','bb','summary'];let modelCalls=0,freshProcessCalls=0,releaseA=()=>{};
function seed(marker,ids=members){
  const room=rooms.createConversation({title:marker,mode:'collaboration',agentIds:ids,workspace:null});
  const run=trace.createRun(marker+'：请自主组织独立检查，按需追加核对，只交付可验证的工作。','collaboration',ids,null,null,room.id);
  trace.setRunStatus(run.id,'running');post({runId:run.id,from:'user',to:'planner',kind:'user',body:run.goal});
  return {run,room,draft:{coordinatorId:'planner',participantIds:ids,budget:{maxOutputTokens:2000,maxTokensPerCall:256,maxDispatches:20,maxDepth:3}}};
}
const cleanup=f=>commitRunTerminal({runId:f.run.id,status:'cancelled',disposition:'cancelled',source:'isolated_fixture_cleanup',closeExecution:()=>store.cancelCollaborationRun(f.run.id)});
const call=(name,input)=>({name,input:JSON.stringify(input)}),complete=summary=>call('agent.complete',{summary});
const response=tool=>({content:'',toolCalls:[tool],stopReason:'tool_use',truncated:false,usage:{tokensIn:5,tokensOut:8,costUsd:0,inputKnown:true,outputKnown:true,costKnown:true,costSource:'reported'}});
async function until(condition,label,timeout=15000){const start=Date.now();while(!condition()){if(Date.now()-start>timeout)throw new Error('Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,15));}}
function privateInput(f,target,body){return post({runId:f.run.id,from:'user',to:target,kind:'system',body,visibility:'private',audience:['user',target]});}
async function manual(f){const work=graph.admitAutonomousGraph(f.run.id,f.draft),claimed=store.claimNextDispatch(f.room.id,'ac2-fixture');assert.ok(claimed);return {work,claimed};}
try{
  // A genuine AC1-only root survives v18 -> v19; no AC2 facts are present in the v18 fixture.
  const historical=seed('AC2_HISTORY');tasks.freezeAutonomousTask(historical.run.id,historical.draft);
  db.run("INSERT INTO orchestration_token_reservations(id,run_id,reserved,used,status,created_at) VALUES(?,?,123,123,'unknown',?)",randomUUID(),historical.run.id,new Date().toISOString());
  const migrationFile=path.join(env.root,'v18.sqlite');await db.db.backup(migrationFile);const v18=new Database(migrationFile);
  v18.exec('PRAGMA foreign_keys=OFF;DROP TABLE autonomous_tool_receipts;DROP TABLE autonomous_intake_copies;DROP TABLE autonomous_decision_resolutions;DROP TABLE autonomous_decision_proposals;DROP TABLE autonomous_emission_records;DROP TABLE autonomous_emission_plans;DROP TABLE autonomous_aggregate_sources;DROP TABLE autonomous_results;DROP TABLE autonomous_delegation_rounds;DROP TABLE autonomous_dispatch_work;DROP TABLE autonomous_work_dependencies;DROP TABLE autonomous_work_items;DELETE FROM orchestration_schema_migrations WHERE version>=19;PRAGMA foreign_keys=ON');
  const tables=v18.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('orchestration_schema_migrations','sqlite_sequence') ORDER BY name").all().map(r=>r.name);
  const digest=database=>createHash('sha256').update(JSON.stringify(tables.map(t=>database.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()))).digest('hex');
  const before=digest(v18);await writeFile(oldModule,execFileSync('git',['show','ec5eb88:apps/server/src/db/orchestrationMigrations.ts'],{encoding:'utf8'}),{mode:0o600});
  const oldWorker=await import(pathToFileURL(oldModule).href);oldWorker.assertOrchestrationSchemaCompatible(v18);v18.close();
  for(let n=0;n<2;n++)execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',`const d=await import('./apps/server/src/db/database.ts');if(d.get('SELECT MAX(version) n FROM orchestration_schema_migrations').n!==${latestSchema})throw new Error('schema');d.closeDatabase();`],{env:{...process.env,DB_PATH:migrationFile},stdio:'pipe'});
  const v19=new Database(migrationFile,{readonly:true});assert.equal(digest(v19),before);assert.deepEqual(v19.pragma('foreign_key_check'),[]);assert.throws(()=>oldWorker.assertOrchestrationSchemaCompatible(v19),/版本|migration|schema/i);v19.close();
  config.autonomousCollaborationMode='execute';
  assert.throws(()=>graph.admitAutonomousGraph(historical.run.id,historical.draft),/AUTONOMOUS_AUTHORITY_INVALID/);
  checks.push('actual v18 worker accepts AC1 fixture then rejects v19; two migrations preserve every historical table row and unknown reservation; AC1 root never upgrades');

  const f=seed('AC2_MAIN'),secretA=privateInput(f,'aa','PRIVATE_A_ONLY_7e8f'),secretB=privateInput(f,'bb','PRIVATE_B_ONLY_3b6a');
  f.draft.inputs=[{kind:'message',id:secretA.id,readers:['aa']},{kind:'message',id:secretB.id,readers:['bb']}];
  privateInput(f,'summary','ROOM_HISTORY_POISON_NOT_SELECTED');
  let coordinatorCalls=0,aStarted=false,bFinished=false,sequenceStarted=false;const prompts=[];
  const barrier=new Promise(resolve=>releaseA=resolve);
  mockProvider.chat=async req=>{
    modelCalls++;const text=req.messages.map(m=>m.content).join('\n');prompts.push({model:req.model,text});
    assert.ok(req.tools.some(t=>t.name==='agent.complete'));
    if(req.model==='mock:planner'){
      coordinatorCalls++;assert.doesNotMatch(text,/PRIVATE_A_ONLY|PRIVATE_B_ONLY|ROOM_HISTORY_POISON/);
      if(coordinatorCalls===1)return response(call('agent.delegate',{commandKey:'assess',items:[
        {key:'implementation',agentId:'aa',objective:'AC2_MAIN_A：独立检查实现风险并给出依据。',inputIds:[secretA.id]},
        {key:'tests',agentId:'bb',objective:'AC2_MAIN_B：独立检查测试风险并给出依据。',inputIds:[secretB.id]},
        {key:'sequence',agentId:'summary',objective:'AC2_MAIN_SEQUENCE：在实现评估执行后核对通用验收条目，不读取私密评估正文。',dependsOn:['implementation']},
      ]}));
      if(coordinatorCalls===2){assert.match(text,/"key":"sequence","state":"completed"/);return response(call('agent.delegate',{commandKey:'adjust',items:[{key:'followup',agentId:'aa',objective:'AC2_MAIN_FOLLOWUP：追加核对公开边界条件，不读取前一责任的私密材料。',dependsOn:['sequence']}]}));}
      return response(complete('四项独立工作均已完成，依赖执行顺序和固定状态均已核对；私密结果未进入主 Agent 上下文。'));
    }
    if(text.includes('AC2_MAIN_A：')){aStarted=true;assert.match(text,/PRIVATE_A_ONLY_7e8f/);assert.doesNotMatch(text,/PRIVATE_B_ONLY|ROOM_HISTORY_POISON/);await barrier;return response(complete('实现评估完成：PRIVATE_A_ONLY_7e8f。已检查独立材料中的风险并给出完整依据。'));}
    if(text.includes('AC2_MAIN_B：')){assert.match(text,/PRIVATE_B_ONLY_3b6a/);assert.doesNotMatch(text,/PRIVATE_A_ONLY|ROOM_HISTORY_POISON/);bFinished=true;return response(complete('测试评估完成：PRIVATE_B_ONLY_3b6a。已检查覆盖范围、异常条件和回归用例。'));}
    if(text.includes('AC2_MAIN_SEQUENCE：')){sequenceStarted=true;assert.doesNotMatch(text,/PRIVATE_A_ONLY|PRIVATE_B_ONLY|ROOM_HISTORY_POISON/);return response(complete('后续通用条目已核对，收到的目标与边界明确，未读取其他成员的私密正文。'));}
    assert.match(text,/AC2_MAIN_FOLLOWUP/);assert.doesNotMatch(text,/PRIVATE_A_ONLY|PRIVATE_B_ONLY|ROOM_HISTORY_POISON/);
    return response(complete('追加核对已经完成，本责任未沿用前一责任的私密上下文，检查了公开边界条件。'));
  };
  scheduler.admitAutonomousCollaboration(f.run.id,f.draft);
  await until(()=>aStarted&&bFinished,'parallel independent members');
  const root=db.get('SELECT * FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NULL',f.run.id),children=graph.childWorks(root.id);
  const sequence=children.find(w=>w.work_key==='sequence');assert.ok(sequence);assert.equal(sequenceStarted,false);
  assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_dispatch_work WHERE work_id=?',sequence.id).n,0);
  assert.equal(db.get("SELECT COUNT(*) n FROM collaboration_attempts WHERE run_id=? AND agent_id='planner'",f.run.id).n,1,'parent waits without repeated model polling');
  for(let n=0;n<3;n++)graph.reconcileAutonomousGraph(f.run.id);
  releaseA();await until(()=>['completed','failed'].includes(trace.getRun(f.run.id).status),'dynamic task closure');
  assert.equal(trace.getRun(f.run.id).status,'completed',JSON.stringify(store.listDispatches(f.run.id).map(d=>({kind:d.kind,status:d.status,error:d.error}))));
  assert.equal(coordinatorCalls,3);assert.equal(modelCalls,7);assert.equal(graph.childWorks(root.id).length,4);
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",f.run.id).n,2);
  for(let n=0;n<3;n++)scheduler.recoverCollaborationRuns();
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",f.run.id).n,2);
  assert.equal(db.get('SELECT COUNT(DISTINCT run_id) n FROM orchestration_model_calls WHERE run_id=?',f.run.id).n,1);
  assert.equal(db.get('SELECT SUM(used) n FROM orchestration_token_reservations WHERE run_id=?',f.run.id).n,56);
  assert.deepEqual(auditShadowRun(f.run.id),[]);
  checks.push('seven actual mock Provider calls through production scheduler: independent A/B, dependency-ready C, one wake, Agent-authored additional round and one final wake; no preset batch or model polling');
  checks.push('coordinator and siblings never receive private input/result bytes; cold followup for the same member retains no prior responsibility history; selected inputs have actual Scope/provenance');
  checks.push('repeated reconciliation/startup creates no duplicate work/wake; all branches and continuations share one root token/money ledger and replayable custody events');

  for(const [label,items,code] of [
    ['cycle',[{key:'a',agentId:'aa',objective:'检查 A 的独立内容',dependsOn:['b']},{key:'b',agentId:'bb',objective:'检查 B 的独立内容',dependsOn:['a']}],'AUTONOMOUS_GRAPH_INVALID'],
    ['self',[{key:'self',agentId:'planner',objective:'不允许向自己委派当前责任'}],'AUTONOMOUS_ACCESS_DENIED'],
    ['unknown-dependency',[{key:'a',agentId:'aa',objective:'不能等待不存在的工作',dependsOn:['absent']}],'AUTONOMOUS_GRAPH_INVALID'],
    ['forged-budget',[{key:'a',agentId:'aa',objective:'不能抬高根预算',maxOutputTokens:999999}],'AUTONOMOUS_CONTRACT_INVALID'],
  ]){
    const guard=seed('AC2_GUARD_'+label),{claimed}=await manual(guard);
    mockProvider.chat=async()=>{modelCalls++;return response(call('agent.delegate',{commandKey:label,items}));};
    await runner.executeAutonomousDispatch(claimed.dispatch,claimed.attempt.id,trace.listRunAgentSnapshots(guard.run.id).find(a=>a.id==='planner'));
    assert.equal(store.getDispatch(claimed.dispatch.id).error,code);
    assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NOT NULL',guard.run.id).n,0);
    assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_delegation_rounds WHERE run_id=?',guard.run.id).n,0);
    runner.settleAutonomousRun(guard.run.id);
  }
  checks.push('model-authored cycles, self delegation, missing dependencies and authority/budget fields reject atomically without child work or command effects');

  const isolated=seed('AC2_PRIVATE_PARENT'),secret=privateInput(isolated,'aa','MUST_NOT_FORWARD_TO_B');
  isolated.draft.inputs=[{kind:'message',id:secret.id,readers:['aa']}];
  const {claimed:parent}=await manual(isolated);
  mockProvider.chat=async()=>{modelCalls++;return response(call('agent.delegate',{commandKey:'private-child',items:[{key:'private',agentId:'aa',objective:'处理独立私密材料',inputIds:[secret.id],participantIds:['aa','bb'],outputAudience:['user','aa']}]}));};
  await runner.executeAutonomousDispatch(parent.dispatch,parent.attempt.id,trace.listRunAgentSnapshots(isolated.run.id).find(a=>a.id==='planner'));
  const child=store.claimNextDispatch(isolated.room.id,'ac2-private-fixture');assert.ok(child);
  mockProvider.chat=async()=>{modelCalls++;return response(call('agent.delegate',{commandKey:'leak',items:[{key:'leak',agentId:'bb',objective:'MUST_NOT_FORWARD_TO_B：尝试通过新目标泄漏私密正文'}]}));};
  await runner.executeAutonomousDispatch(child.dispatch,child.attempt.id,trace.listRunAgentSnapshots(isolated.run.id).find(a=>a.id==='aa'));
  assert.equal(store.getDispatch(child.dispatch.id).error,'PRIVATE_OUTPUT_REQUIRES_RELEASE');
  assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_work_items WHERE run_id=?',isolated.run.id).n,2);
  runner.settleAutonomousRun(isolated.run.id);
  mockProvider.chat=async()=>{modelCalls++;return response(complete('不能将仍未满足的必需子工作伪装成完成，提交完整检查结论用于验证平台门禁。'));};
  const returned=store.claimNextDispatch(isolated.room.id,'ac2-private-return');assert.ok(returned);
  await runner.executeAutonomousDispatch(returned.dispatch,returned.attempt.id,trace.listRunAgentSnapshots(isolated.run.id).find(a=>a.id==='planner'));
  runner.settleAutonomousRun(isolated.run.id);assert.equal(trace.getRun(isolated.run.id).status,'failed');
  checks.push('a member that actually read private material cannot leak it through a fresh delegated objective even with a wider participant authority ceiling');

  const {createAgent}=await import('../apps/server/src/agents/registry.ts');
  createAgent({id:'ac2-writer',name:'AC2 writer',description:'isolated controlled files',systemPrompt:'使用当前 Scope 的受控文件工具。',model:'mock:ac2-writer',capabilities:['execute'],permissionMode:'auto',tools:['fs.write','fs.read'],disallowedTools:[],color:'#4477aa',avatar:''});
  const files=seed('AC2_FILES',[...members,'ac2-writer']);let writingRound=0;
  const fileBody='AC2_MANAGED_PRIVATE_CONTENT '.repeat(4);
  mockProvider.chat=async req=>{
    modelCalls++;const text=req.messages.map(m=>m.content).join('\n');
    if(req.model==='mock:planner'){
      assert.doesNotMatch(text,/AC2_MANAGED_PRIVATE_CONTENT/);
      return response(text.includes('"key":"file","state":"completed"')?complete('受控文件工作已实际完成，工具回执和固定状态均已核验，主 Agent 未读取私密文件正文。')
        :call('agent.delegate',{commandKey:'write-file',items:[{key:'file',agentId:'ac2-writer',objective:'写入并读取 ac2.txt，核验受控产物版本。',allowedTools:['fs.write','fs.read']}]}));
    }
    writingRound++;
    return response(writingRound===1?call('fs.write',{path:'ac2.txt',content:fileBody}):writingRound===2?call('fs.read',{path:'ac2.txt'}):complete('受控文件 ac2.txt 已写入并读取当前版本，内容核验一致，实际工具回执齐全。'));
  };
  scheduler.admitAutonomousCollaboration(files.run.id,files.draft);await until(()=>['completed','failed'].includes(trace.getRun(files.run.id).status),'controlled file closure');
  assert.equal(trace.getRun(files.run.id).status,'completed',JSON.stringify(store.listDispatches(files.run.id).map(d=>d.error)));
  assert.equal(db.get("SELECT COUNT(*) n FROM tool_executions WHERE run_id=? AND status='completed'",files.run.id).n,2);
  assert.equal(db.get('SELECT COUNT(*) n FROM managed_artifact_versions WHERE run_id=?',files.run.id).n,1);
  assert.ok(db.get("SELECT COUNT(*) n FROM runtime_input_provenance p JOIN collaboration_attempts a ON a.id=p.attempt_id WHERE a.run_id=? AND json_extract(p.record,'$.channel')='tool_result'",files.run.id).n>=2);
  checks.push('API members perform real controlled fs.write/fs.read with immutable artifact, tool receipts and input provenance; readonly coordinator assigns writer without gaining write permission or private bytes');

  const nested=seed('AC2_NESTED');
  mockProvider.chat=async req=>{
    modelCalls++;const text=req.messages.map(m=>m.content).join('\n');
    if(req.model==='mock:planner')return response(text.includes('"key":"nested","state":"completed"')
      ?complete('二级委派链已经按根授权完成，根责任核对了固定状态和依赖，未读取子工作正文。')
      :call('agent.delegate',{commandKey:'nested',items:[{key:'nested',agentId:'aa',objective:'请自主安排 B 完成独立核验，再核对固定状态。',participantIds:['aa','bb'],outputAudience:['user','aa','bb']}]}));
    if(req.model==='mock:aa')return response(text.includes('"key":"deep","state":"completed"')
      ?complete('当前子责任已核对下一层的实际完成状态，提交本层独立工作结果和边界说明。')
      :call('agent.delegate',{commandKey:'deep',items:[{key:'deep',agentId:'bb',objective:'完成根任务授权内的第二层独立核验，返回实质结果。'}]}));
    return response(complete('第二层独立核验已经完成，执行内容、证据和限制已明确，供上层核对固定状态。'));
  };
  scheduler.admitAutonomousCollaboration(nested.run.id,nested.draft);await until(()=>['completed','failed'].includes(trace.getRun(nested.run.id).status),'nested delegation');
  assert.equal(trace.getRun(nested.run.id).status,'completed',JSON.stringify(store.listDispatches(nested.run.id).map(d=>d.error)));
  assert.equal(db.get('SELECT MAX(depth) n FROM autonomous_task_grants WHERE run_id=?',nested.run.id).n,2);assert.deepEqual(auditShadowRun(nested.run.id),[]);
  checks.push('a delegated member itself delegates to a second member under attenuated authority; both parent levels persist waits and resume through the same root ledger');

  const duplicate=seed('AC2_DUPLICATE');let duplicateRound=0;
  mockProvider.chat=async req=>{modelCalls++;if(req.model==='mock:planner')return response(call('agent.delegate',{commandKey:'attempt-'+(++duplicateRound),items:[{key:'same',agentId:'aa',objective:'同一父责任的已提交工作 key 不能重复创建。'}]}));return response(complete('首个独立工作已完成，后续重复提交不能再次创建同一个领域工作。'));};
  scheduler.admitAutonomousCollaboration(duplicate.run.id,duplicate.draft);await until(()=>trace.getRun(duplicate.run.id).status==='failed','duplicate intent blocks');
  assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_work_items WHERE run_id=?',duplicate.run.id).n,2);
  assert.ok(store.listDispatches(duplicate.run.id).some(d=>d.error==='AUTONOMOUS_GRAPH_INVALID'));
  const capacity=seed('AC2_CAPACITY');capacity.draft.budget.maxDispatches=2;
  const {claimed:capacityClaim}=await manual(capacity);
  mockProvider.chat=async()=>{modelCalls++;return response(call('agent.delegate',{commandKey:'too-small',items:[{key:'work',agentId:'aa',objective:'必须为子派发和父唤醒同时预留执行位置。'}]}));};
  await runner.executeAutonomousDispatch(capacityClaim.dispatch,capacityClaim.attempt.id,trace.listRunAgentSnapshots(capacity.run.id).find(a=>a.id==='planner'));
  assert.equal(store.getDispatch(capacityClaim.dispatch.id).error,'AUTONOMOUS_LIMIT_EXCEEDED');assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_work_items WHERE run_id=?',capacity.run.id).n,1);runner.settleAutonomousRun(capacity.run.id);
  checks.push('reusing a submitted work key is blocked across rounds; plan admission accounts for dependency-blocked children and future parent wakes before exhausting the root Dispatch ceiling');

  const recover=seed('AC2_RECOVER'),{claimed:first}=await manual(recover);
  mockProvider.chat=async req=>{modelCalls++;return response(req.model==='mock:planner'?call('agent.delegate',{commandKey:'recover',items:[{key:'child',agentId:'aa',objective:'完成独立核验，供新进程恢复父责任使用。'}]}):complete('独立核验已完成，结果和执行依据明确，可以由持久化事实唤醒父责任。'));};
  await runner.executeAutonomousDispatch(first.dispatch,first.attempt.id,trace.listRunAgentSnapshots(recover.run.id).find(a=>a.id==='planner'));
  const completedChild=store.claimNextDispatch(recover.room.id,'ac2-recovery-child');assert.ok(completedChild);
  await runner.executeAutonomousDispatch(completedChild.dispatch,completedChild.attempt.id,trace.listRunAgentSnapshots(recover.run.id).find(a=>a.id==='aa'));
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",recover.run.id).n,0);
  const recoveryDb=path.join(env.root,'recover.sqlite');await db.db.backup(recoveryDb);
  const childCode=`
    import assert from 'node:assert/strict';
    const {config}=await import('./apps/server/src/config.ts');config.autonomousCollaborationMode='execute';
    const d=await import('./apps/server/src/db/database.ts'),{mockProvider}=await import('./apps/server/src/llm/provider.ts');
    let calls=0;mockProvider.chat=async()=>{calls++;return ${JSON.stringify(response(complete('新进程已从持久化子义务恢复父责任，核对固定状态并提交完整的内部工作结果。')))};};
    const s=await import('./apps/server/src/collaboration/scheduler.ts');s.recoverCollaborationRuns();s.recoverCollaborationRuns();
    const started=Date.now();while(d.get('SELECT status FROM runs WHERE id=?',process.env.AC2_RECOVER_ID).status==='running'){if(Date.now()-started>10000)throw new Error('recovery timeout');await new Promise(r=>setTimeout(r,20));}
    assert.equal(d.get('SELECT status FROM runs WHERE id=?',process.env.AC2_RECOVER_ID).status,'completed');
    const wakes=d.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",process.env.AC2_RECOVER_ID).n;
    assert.equal(wakes,1);assert.equal(calls,1);console.log(JSON.stringify({passed:true,calls,wakes}));d.closeDatabase();`;
  const recovered=JSON.parse(execFileSync(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',childCode],{env:{...process.env,DB_PATH:recoveryDb,AC2_RECOVER_ID:recover.run.id},encoding:'utf8',stdio:'pipe'}).trim().split('\n').at(-1));
  assert.equal(recovered.passed,true);freshProcessCalls+=recovered.calls;cleanup(recover);
  checks.push('a fresh Node worker recovers a snapshot taken after children completed but before wake; duplicate startup reconciliation yields one wake and one real mock parent call, without replaying children');

  const drift=seed('AC2_DRIFT'),driftInput=privateInput(drift,'aa','ACL_DRIFT_PRIVATE');drift.draft.inputs=[{kind:'message',id:driftInput.id,readers:['aa']}];
  const {claimed:driftParent}=await manual(drift);
  mockProvider.chat=async()=>{modelCalls++;return response(call('agent.delegate',{commandKey:'drift',items:[{key:'drift',agentId:'aa',objective:'仅在原来源仍有效时处理私密输入。',inputIds:[driftInput.id]}]}));};
  await runner.executeAutonomousDispatch(driftParent.dispatch,driftParent.attempt.id,trace.listRunAgentSnapshots(drift.run.id).find(a=>a.id==='planner'));
  db.run("UPDATE messages SET audience='[\"user\"]' WHERE id=?",driftInput.id);
  assert.equal(store.claimNextDispatch(drift.room.id,'ac2-drift-child'),null);
  runner.settleAutonomousRun(drift.run.id);
  const driftWork=db.get('SELECT * FROM autonomous_work_items WHERE run_id=? AND parent_work_id IS NOT NULL',drift.run.id);
  assert.equal(graph.workState(driftWork),'failed');assert.equal(db.get("SELECT COUNT(*) n FROM runtime_action_commands WHERE run_id=? AND kind='wake'",drift.run.id).n,1);cleanup(drift);
  checks.push('ACL drift before claim blocks child before model I/O and resolves its persisted wait as failed instead of leaving the parent waiting forever');

  const crash=seed('AC2_UNKNOWN'),{claimed:crashClaim}=await manual(crash);let releaseUnknown,startedUnknown=false;
  const unknownBarrier=new Promise(resolve=>releaseUnknown=resolve);
  mockProvider.chat=async()=>{modelCalls++;startedUnknown=true;await unknownBarrier;return response(complete('这是已中断请求的迟到结果，不能完成旧责任或重新派发后继任务。'));};
  const active=runner.executeAutonomousDispatch(crashClaim.dispatch,crashClaim.attempt.id,trace.listRunAgentSnapshots(crash.run.id).find(a=>a.id==='planner'));
  await until(()=>startedUnknown,'issued model call');db.run('UPDATE collaboration_attempts SET lease_expires_at=? WHERE id=?',new Date(Date.now()-1).toISOString(),crashClaim.attempt.id);
  store.interruptExpiredAttempts({onlyExpired:true});runner.settleAutonomousRun(crash.run.id);releaseUnknown();await active;
  assert.equal(trace.getRun(crash.run.id).status,'failed');assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_model_calls WHERE run_id=? AND status='unknown'",crash.run.id).n,1);
  assert.equal(db.get("SELECT reserved FROM orchestration_token_reservations WHERE run_id=? AND status='unknown'",crash.run.id).reserved,256);
  assert.equal(db.get('SELECT COUNT(*) n FROM autonomous_work_items WHERE run_id=?',crash.run.id).n,1);
  assert.equal(store.claimNextDispatch(crash.room.id,'no-replay'),null);
  checks.push('issued request interrupted by lease expiry retains unknown token/money reservations; late completion cannot close a Subject, spawn children, free allowance or replay the request');

  const stopped=seed('AC2_STOP'),{claimed:stopParent}=await manual(stopped);
  mockProvider.chat=async()=>{modelCalls++;return response(call('agent.delegate',{commandKey:'stop',items:[{key:'first',agentId:'aa',objective:'这是可以领取的子工作。'},{key:'blocked',agentId:'bb',objective:'这是尚无 Dispatch 的依赖阻塞工作。',dependsOn:['first']}]}));};
  await runner.executeAutonomousDispatch(stopParent.dispatch,stopParent.attempt.id,trace.listRunAgentSnapshots(stopped.run.id).find(a=>a.id==='planner'));
  cleanup(stopped);graph.reconcileAutonomousGraph(stopped.run.id);
  assert.equal(db.get("SELECT COUNT(*) n FROM runtime_subjects WHERE run_id=? AND status!='cancelled'",stopped.run.id).n,0);
  assert.equal(store.claimNextDispatch(stopped.room.id,'stopped'),null);assert.deepEqual(auditShadowRun(stopped.run.id),[]);
  checks.push('user stop closes waiting parents, queued children and dependency-blocked nodes that have no Dispatch, preserving custody replay and preventing later wake');

  assert.throws(()=>parseAutonomousControlCall(call('agent.complete',{summary:'收到'})),/AUTONOMOUS_EXPLICIT_ACTION_REQUIRED/);
  assert.throws(()=>parseAutonomousControlCall(call('agent.delegate',{commandKey:'x',runId:'forged',items:[]})),/AUTONOMOUS_CONTRACT_INVALID/);
  for(const table of ['autonomous_work_items','autonomous_work_dependencies','autonomous_dispatch_work','autonomous_delegation_rounds'])assert.throws(()=>db.run(`DELETE FROM ${table}`),/immutable/);
  assert.deepEqual(db.db.pragma('foreign_key_check'),[]);assert.equal(env.externalRequests,0);
  const report={passed:true,checks,schema:latestSchema,fixtureModelCalls:modelCalls+freshProcessCalls,freshProcessCalls,realSupplierRequests:0,realNativeInvocations:0,defaultUiAvailable:false};
  await writeFile(path.join(qa,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report,null,2));
}finally{releaseA();await rm(oldModule,{force:true});await env.close();}
