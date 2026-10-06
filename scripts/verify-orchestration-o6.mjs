import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
const root=await mkdtemp(path.join(tmpdir(),'gand-o6-')), checks=[], children=[], sandboxes=[];
Object.assign(process.env,{NODE_ENV:'test',AGENT_GAND_ISOLATED_WORKER:'1',AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),DB_PATH:path.join(root,'old.sqlite'),AGENTS_DIR:path.join(root,'roles'),LOG_LEVEL:'silent',MCP_SERVER_CMD:'',COORDINATION_RUNTIME_KERNEL:'execute',APPROVAL_TIMEOUT_MS:'0',LLM_OPENAI_API_KEY:'',LLM_ANTHROPIC_API_KEY:'',ANTHROPIC_API_KEY:'',ORCHESTRATION_ENTRY_MODE:'execute',ORCHESTRATION_LEGACY_ENTRY_ENABLED:'true',O6_LOG:path.join(root,'calls.jsonl')});
delete process.env.ORCHESTRATION_ENABLED_DRIVERS;delete process.env.ORCHESTRATION_ENABLED_WORKFLOWS;
globalThis.fetch=async()=>{throw new Error('O6 forbids real provider traffic');};
await writeFile(process.env.O6_LOG,'');
const schema=await readFile(new URL('../apps/server/src/db/schema.sql',import.meta.url),'utf8');
const oldSchema=schema.replace('  preferences_version INTEGER, preferences_origin TEXT,\n','');
const previous=new Database(process.env.DB_PATH);previous.exec(oldSchema);
const oldRoom=(id,mode,team,supervisor=null,reviewer=null)=>previous.prepare(`INSERT INTO conversations(id,title,mode,agent_ids,supervisor_id,default_reviewer_id,members_version,workspace,preferences,created_at,updated_at) VALUES (?,?,?,?,?,?,7,?,NULL,?,?)`).run(id,id,mode,JSON.stringify(team),supervisor,reviewer,'legacy-workspace','2025-01-01','2025-01-01');
oldRoom('old-pipeline','pipeline',['aa','bb']);oldRoom('old-collaboration','collaboration',['aa']);oldRoom('old-supervisor','supervisor',['planner','aa','reviewer'],'planner','reviewer');oldRoom('missing-supervisor','supervisor',['aa']);
previous.prepare(`INSERT INTO runs(id,goal,mode,status,agent_ids,conversation_id,turn_no,created_at,finished_at) VALUES ('old-terminal','旧终态结果','pipeline','completed','["aa"]','old-pipeline',1,'2025-01-01','2025-01-02')`).run();
previous.prepare(`INSERT INTO runs(id,goal,mode,status,agent_ids,conversation_id,turn_no,created_at) VALUES ('old-active','旧活跃目标','pipeline','running','["aa"]','old-collaboration',1,'2025-01-01')`).run();
previous.close();
const maintenance=await import('./orchestration-maintenance.mjs');
const beforeAudit=maintenance.auditOrchestration();assert.equal(beforeAudit.pendingMigrations.length,2);assert.equal(beforeAudit.pendingRoomIds.length,4);
const beforeBytes=await readFile(process.env.DB_PATH);maintenance.auditOrchestration();assert.deepEqual(await readFile(process.env.DB_PATH),beforeBytes);
const db=await import('../apps/server/src/db/database.ts');
const migration=await import('../apps/server/src/db/orchestrationMigrations.ts');
const conversations=await import('../apps/server/src/conversations/service.ts');
const registry=await import('../apps/server/src/agents/registry.ts');const trace=await import('../apps/server/src/runs/trace.ts');
const entry=await import('../apps/server/src/orchestration/entry.ts');const legacy=await import('../apps/server/src/orchestration/service.ts');
const store=await import('../apps/server/src/coordination/store.ts');const actions=await import('../apps/server/src/orchestration/actions.ts');
const checkpoints=await import('../apps/server/src/runs/checkpoints.ts');const admission=await import('../apps/server/src/execution/memberAdmission.ts');
const role=(id,extra={})=>({id,name:id,description:'isolated O6 role',systemPrompt:'Provide complete deliverables',model:'mock:'+id,capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#7c5cff',avatar:'',...extra});
for(const id of ['aa','bb'])await registry.createAgent(role(id));
await registry.createAgent(role('planner',{capabilities:['coordinate','execute']}));await registry.createAgent(role('reviewer',{capabilities:['review']}));
await registry.createAgent(role('writer',{permissionMode:'confirm'}));
await registry.createAgent(role('sdk',{model:'fixture',execution:{kind:'external',driver:'claude-sdk'}}));
await registry.createAgent(role('cli',{model:'fixture',execution:{kind:'external',driver:'claude-cli'}}));
trace.backfillRunAgentSnapshots();
const waitFor=async(fn,label,ms=20000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,25));}throw new Error('Timeout '+label);};
const fork=(mode,env={})=>{const child=spawn(process.execPath,['--import','./apps/server/node_modules/tsx/dist/loader.mjs','scripts/fixtures/orchestration-o6-worker.mjs'],{env:{...process.env,O6_WORKER_MODE:mode,...env},stdio:['ignore','pipe','pipe','ipc']});children.push(child);let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);child.finished=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,stdout,stderr})));return child;};
const closed={ORCHESTRATION_ENTRY_MODE:'closed',ORCHESTRATION_LEGACY_ENTRY_ENABLED:'false',ORCHESTRATION_ENABLED_DRIVERS:'',ORCHESTRATION_ENABLED_WORKFLOWS:''};
const childApi=async(url,payload,env={})=>{const result=await fork('api',{O6_API_REQUEST:JSON.stringify({method:payload?'POST':'GET',url,...(payload?{payload}: {})}),...env}).finished;assert.equal(result.code,0,result.stderr);return JSON.parse(result.stdout.trim());};
const logs=async()=> (await readFile(process.env.O6_LOG,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const calls=async(id)=> (await logs()).filter(r=>r.event==='call'&&r.runId===id);
const pending=async(goal,extra={})=>{const body={goal:'O6:'+goal,agentIds:['aa','bb'],recipientIds:['aa','bb'],strategy:'serial',workflow:'routine',constraints:{readonly:true},...extra};const preview=await entry.previewExecutionOrchestration(body);const input={...body,entryVersion:1,clientRequestId:crypto.randomUUID(),previewId:preview.previewId,orchestrationFingerprint:preview.fingerprint};const result=entry.submitExecutionOrchestration(input);sandboxes.push(result.run.workspace);return {result,input};};
const cancel=async(item)=>actions.applyRunAction(item.result.run.id,'cancel');
try{
  const frozenBefore=db.all('SELECT * FROM runs ORDER BY id');const snapshotsBefore=db.all('SELECT * FROM run_agent_snapshots ORDER BY run_id,agent_id');
  const mapped=migration.migrateRoomPreferences(db.db);assert.deepEqual(mapped,{mapped:4,adopted:0,skipped:[]});
  assert.equal(conversations.getConversation('old-pipeline').preferences.strategy,'serial');assert.equal(conversations.getConversation('old-collaboration').preferences.strategy,'auto');
  assert.equal(conversations.getConversation('old-supervisor').preferences.workflow,'supervisor_decomposition');assert.equal(conversations.getConversation('old-supervisor').preferences.defaultReviewerId,'reviewer');
  assert.equal(conversations.getConversation('missing-supervisor').preferences.supervisorId,null);
  assert.deepEqual(db.all('SELECT * FROM runs ORDER BY id'),frozenBefore);assert.deepEqual(db.all('SELECT * FROM run_agent_snapshots ORDER BY run_id,agent_id'),snapshotsBefore);
  assert.equal(conversations.getConversation('old-pipeline').membersVersion,8);assert.equal(conversations.getConversation('old-pipeline').updatedAt,'2025-01-01');
  const repeated=await fork('boot').finished;assert.equal(repeated.code,0,repeated.stderr);assert.equal(JSON.parse(repeated.stdout).migration.mapped,0);assert.equal(db.get('SELECT COUNT(*) n FROM room_preferences_migration_audits').n,4);
  assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_schema_migrations').n,2);
  db.run(`INSERT INTO runs(id,goal,mode,status,agent_ids,supervisor_id,default_reviewer_id,created_at,finished_at)
    VALUES ('unroomed-terminal','旧主管终态','supervisor','completed','["planner","aa","reviewer"]','planner','reviewer','2025-01-01','2025-01-02')`);
  conversations.backfillConversations();migration.migrateRoomPreferences(db.db);trace.backfillRunAgentSnapshots();
  const recoveredRoom=conversations.getConversation(trace.getRun('unroomed-terminal').conversationId);
  assert.equal(recoveredRoom.preferences.supervisorId,'planner');assert.equal(recoveredRoom.preferences.defaultReviewerId,'reviewer');assert.equal(trace.getRun('unroomed-terminal').status,'completed');
  checks.push('旧库增量升级及 mode 映射可重复执行；Run、角色快照、工作区、排序时间和原始 mode 不变');

  const atomic=new Database(':memory:');atomic.exec(oldSchema);migration.applyOrchestrationSchemaMigrations(atomic);
  atomic.exec(`INSERT INTO conversations(id,title,mode,agent_ids,created_at,updated_at) VALUES ('first','first','pipeline','["aa"]','x','x'),('second','second','pipeline','["bb"]','x','x'); CREATE TRIGGER fail_mapping BEFORE UPDATE OF preferences ON conversations WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'injected crash'); END`);
  assert.throws(()=>migration.migrateRoomPreferences(atomic),/injected crash/);assert.equal(atomic.prepare('SELECT COUNT(*) n FROM conversations WHERE preferences IS NOT NULL').get().n,0);assert.equal(atomic.prepare('SELECT COUNT(*) n FROM room_preferences_migration_audits').get().n,0);atomic.close();
  const explicit=conversations.createConversation({title:'O5 explicit',mode:'pipeline',agentIds:['aa'],supervisorId:null,workspace:null,preferences:{strategy:'parallel',workflow:'routine',constraints:{readonly:true},supervisorId:null,defaultReviewerId:null,aggregatorId:null}});
  db.run('UPDATE conversations SET preferences_version=NULL,preferences_origin=NULL WHERE id=?',explicit.id);const rawPrefs=db.get('SELECT preferences FROM conversations WHERE id=?',explicit.id).preferences;
  assert.equal(migration.migrateRoomPreferences(db.db).adopted,1);assert.equal(db.get('SELECT preferences FROM conversations WHERE id=?',explicit.id).preferences,rawPrefs);
  checks.push('迁移事务故障整体回滚；O5 显式默认偏好原样收编，不覆盖用户选择');

  const preview=await entry.previewExecutionOrchestration({goal:'只读分析',conversationId:'old-pipeline'});assert.equal(preview.request.strategy,'serial');
  const blocked=await entry.previewExecutionOrchestration({goal:'只读分析',conversationId:'missing-supervisor'});assert.ok(blocked.decision.issues.some(i=>i.severity==='error'));
  const {default:Fastify}=await import('../apps/server/node_modules/fastify/fastify.js');const {registerRoutes}=await import('../apps/server/src/api/routes.ts');const app=Fastify();await registerRoutes(app);
  const teamUpdate=await app.inject({method:'PATCH',url:'/api/conversations/old-supervisor',payload:{agentIds:['aa','sdk'],expectedMembersVersion:8}});assert.equal(teamUpdate.statusCode,200,teamUpdate.body);assert.equal(teamUpdate.json().preferences.workflow,'supervisor_decomposition');assert.equal(teamUpdate.json().preferences.supervisorId,null);
  db.run("UPDATE conversations SET preferences='{bad' WHERE id=?",explicit.id);assert.equal((await app.inject({method:'GET',url:'/api/conversations/'+explicit.id})).statusCode,200);
  assert.throws(()=>entry.submitExecutionOrchestration({goal:'继续分析',conversationId:explicit.id,recipientIds:['aa'],clientRequestId:'invalid-prefs-id'}),error=>error.code==='ROOM_PREFERENCES_INVALID');
  conversations.updateRoomPreferences(explicit.id,{strategy:'auto',workflow:'routine',constraints:{},supervisorId:null,defaultReviewerId:null,aggregatorId:null},conversations.getConversation(explicit.id).membersVersion);
  await app.close();checks.push('旧房间默认在新预览中生效；主管缺失显式阻塞，候选团队不受旧 mode 限制；损坏默认不阻断历史读取');

  const routeBody={goal:'旧 API 最小分析',mode:'pipeline',agentIds:['aa'],clientRequestId:'legacy-route-key'};
  const legacyRoute=await childApi('/api/runs',routeBody);assert.equal(legacyRoute.status,201);assert.equal(legacyRoute.headers.deprecation,'true');
  const legacyRun=legacyRoute.data.run??legacyRoute.data;await actions.applyRunAction(legacyRun.id,'cancel');
  const unified=await pending('gate-survivor');const copy=db.get('SELECT snapshot FROM orchestration_requests WHERE run_id=?',unified.result.run.id).snapshot;
  const replay=await childApi('/api/conversations',unified.input,closed);assert.equal(replay.status,200);assert.equal(replay.data.run.id,unified.result.run.id);
  const conflict=await childApi('/api/conversations',{...unified.input,goal:'different'},closed);assert.equal(conflict.status,409);assert.equal(conflict.data.code,'IDEMPOTENCY_CONFLICT');
  const rejected=await childApi('/api/conversations',{...unified.input,clientRequestId:'different-new-id'},closed);assert.equal(rejected.status,503);assert.equal(rejected.data.code,'ORCHESTRATION_ENTRY_DISABLED');
  const oldReplay=await childApi('/api/runs',routeBody,closed);assert.equal(oldReplay.status,200);
  const oldNew=await childApi('/api/runs',{...routeBody,clientRequestId:'new-legacy-block'},closed);assert.equal(oldNew.status,503);assert.equal(oldNew.data.code,'LEGACY_ENTRY_DISABLED');
  const options=await childApi('/api/orchestration/options',null,closed);assert.equal(options.data.admission.existingRunsContinue,true);
  checks.push('旧 API 包装保留响应并发弃用提示；关闭新旧入口仍能幂等查回原任务，同键不同载荷 409，新键不产生 Run');

  const previewOnly=await childApi('/api/orchestration/preview',{goal:'分析接口',agentIds:['aa']},{ORCHESTRATION_ENTRY_MODE:'preview'});assert.equal(previewOnly.status,200);assert.ok(previewOnly.data.decision.issues.some(i=>i.code==='ORCHESTRATION_ENTRY_DISABLED'));
  const workflowOff=await childApi('/api/orchestration/preview',{goal:'独立分析并汇总',agentIds:['aa','bb'],recipientIds:['aa'],workflow:'analysis_summary',aggregatorId:'bb'},{ORCHESTRATION_ENABLED_WORKFLOWS:'routine'});assert.ok(workflowOff.data.decision.issues.some(i=>i.code==='WORKFLOW_NOT_ENABLED'));
  const sdkOff=await childApi('/api/orchestration/preview',{goal:'只读分析',agentIds:['aa','sdk'],recipientIds:['sdk']},{ORCHESTRATION_ENABLED_DRIVERS:'builtin-llm'});assert.ok(sdkOff.data.decision.issues.some(i=>i.code==='DRIVER_NOT_ENABLED'));
  const candidateOnly=await childApi('/api/orchestration/preview',{goal:'只读分析',agentIds:['aa','sdk'],recipientIds:['aa']},{ORCHESTRATION_ENABLED_DRIVERS:'builtin-llm'});assert.equal(candidateOnly.data.decision.issues.some(i=>i.code==='DRIVER_NOT_ENABLED'),false);
  const cli=await childApi('/api/orchestration/preview',{goal:'只读分析',agentIds:['cli'],recipientIds:['cli'],strategy:'serial',constraints:{readonly:true}},{ORCHESTRATION_ENABLED_DRIVERS:'builtin-llm,claude-sdk,codex-app-server'});assert.ok(cli.data.decision.issues.some(i=>i.code==='DRIVER_NOT_ENABLED'));
  const detailed=await childApi('/api/orchestration/preview',{goal:'主管拆解分析',agentIds:['planner','aa'],recipientIds:['aa'],supervisorId:'planner',workflow:'supervisor_decomposition',planning:'detailed'},closed);assert.equal(detailed.status,503);
  const invalidConfig=await fork('boot',{ORCHESTRATION_ENABLED_DRIVERS:'typo-driver'}).finished;assert.notEqual(invalidConfig.code,0);
  checks.push('预览比较→API→SDK→app-server→CLI 支持白名单；只检查实际执行成员，关闭入口不会调用详细 planner，未知开关值拒绝启动');

  const surviving=await fork('recover',{...closed,O6_RUN_ID:unified.result.run.id}).finished;assert.equal(surviving.code,0,surviving.stderr);assert.equal(trace.getRun(unified.result.run.id).status,'completed');
  assert.equal(db.get('SELECT snapshot FROM orchestration_requests WHERE run_id=?',unified.result.run.id).snapshot,copy);assert.equal((await calls(unified.result.run.id)).length,2);
  assert.equal(trace.getRun('old-active').status,'waiting_for_user');assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_requests WHERE run_id=?','old-active').n,0);
  const secondBoot=await fork('recover',{...closed,O6_RUN_ID:unified.result.run.id}).finished;assert.equal(secondBoot.code,0,secondBoot.stderr);assert.equal((await calls(unified.result.run.id)).length,2);assert.equal(db.get('SELECT COUNT(*) n FROM runtime_run_terminals WHERE run_id=?',unified.result.run.id).n,1);
  checks.push('关闭所有新任务开关，兼容 worker 仍完成原冻结步骤图；第二次恢复零重复调用、终态只有一条；契约缺失的旧活跃任务不重新规划');

  const paused=await pending('paused-revision');await actions.applyRunAction(paused.result.run.id,'pause');
  const revisedPreview=await childApi('/api/orchestration/preview',{goal:'O6:paused-revision 改为解释接口风险',conversationId:paused.result.conversation.id,recipientIds:['aa','bb'],strategy:'serial',workflow:'routine',constraints:{readonly:true},revisionRunId:paused.result.run.id},closed);
  assert.equal(revisedPreview.status,200);assert.equal(revisedPreview.data.decision.issues.some(i=>i.code==='ORCHESTRATION_ENTRY_DISABLED'||i.code==='WORKFLOW_NOT_ENABLED'),false);
  const changedWorkflow=await childApi('/api/orchestration/preview',{goal:'O6 新主管计划',conversationId:paused.result.conversation.id,workflow:'supervisor_decomposition',planning:'detailed',revisionRunId:paused.result.run.id},closed);
  assert.equal(changedWorkflow.status,409);assert.equal(changedWorkflow.data.code,'REVISION_POLICY_CONFLICT');
  const revised=await childApi(`/api/runs/${paused.result.run.id}/orchestration/revisions`,{previewId:revisedPreview.data.previewId,orchestrationFingerprint:revisedPreview.data.fingerprint,instruction:'解释接口风险'},closed);assert.equal(revised.status,201,JSON.stringify(revised.data));assert.equal(trace.getRun(paused.result.run.id).status,'waiting_for_user');
  const resumed=await fork('resume',{...closed,O6_RUN_ID:paused.result.run.id}).finished;assert.equal(resumed.code,0,resumed.stderr);assert.equal(trace.getRun(paused.result.run.id).status,'completed');
  checks.push('回退期间保留已准入步骤图的安全修订与明确恢复，仍沿原任务收尾');

  const confirmedOutput=await pending('persisted-output');const resultCrash=await fork('run',{O6_RUN_ID:confirmedOutput.result.run.id,O6_KILL_AFTER_RESULT:'1'}).finished;
  assert.equal(resultCrash.signal,'SIGKILL');assert.equal((await calls(confirmedOutput.result.run.id)).length,1);
  assert.ok(db.get("SELECT id FROM run_checkpoints WHERE run_id=? AND kind='agent_turn' AND phase='completed'",confirmedOutput.result.run.id));
  const closeResult=await fork('recover',{...closed,O6_RUN_ID:confirmedOutput.result.run.id}).finished;assert.equal(closeResult.code,0,closeResult.stderr);
  assert.equal((await calls(confirmedOutput.result.run.id)).length,2);assert.equal(trace.getRun(confirmedOutput.result.run.id).status,'completed');
  checks.push('实际子进程在模型结果事务提交后、步骤完成前崩溃；恢复复用已确认结果，仅调用未执行成员');

  const unknown=await pending('unknown-after-start');const crash=fork('run',{O6_RUN_ID:unknown.result.run.id,O6_HANG_CALL:'1',O6_HOLD_PROCESS:'1'});
  await waitFor(async()=> (await calls(unknown.result.run.id)).length===1,'started call');crash.kill('SIGKILL');await crash.finished;
  const unknownRecover=await fork('recover',{...closed,O6_RUN_ID:unknown.result.run.id,O6_EXPECT_STATUS:'waiting_for_user'}).finished;assert.equal(unknownRecover.code,0,unknownRecover.stderr);
  assert.equal((await calls(unknown.result.run.id)).length,1);assert.equal(db.get('SELECT recovery_attention FROM orchestration_run_controls WHERE run_id=?',unknown.result.run.id).recovery_attention,1);
  const unsafeResume=await childApi(`/api/runs/${unknown.result.run.id}/actions`,{action:'resume'},closed);assert.equal(unsafeResume.status,409);await cancel(unknown);
  checks.push('实际子进程在调用发出后崩溃：结果未知被隔离，恢复不重放，直接继续被拒绝');

  const approval=await pending('approval',{agentIds:['writer'],recipientIds:['writer'],strategy:'serial',constraints:{readonly:false}});
  const waiting=fork('run',{O6_RUN_ID:approval.result.run.id,O6_APPROVAL:'1',O6_HOLD_PROCESS:'1'});
  await waitFor(()=>db.get("SELECT id FROM approvals WHERE run_id=? AND status='pending'",approval.result.run.id),'pending approval');waiting.kill('SIGKILL');await waiting.finished;
  const card=db.get('SELECT id FROM approvals WHERE run_id=?',approval.result.run.id).id;
  const approvalRecover=fork('recover',{...closed,O6_RUN_ID:approval.result.run.id,O6_APPROVAL:'1',O6_HOLD_PROCESS:'1'});
  await waitFor(()=>db.get("SELECT seq FROM execution_member_tickets WHERE run_id=? AND status='active' AND pid=?",approval.result.run.id,approvalRecover.pid),'approval boundary reclaimed');
  assert.equal(db.get('SELECT COUNT(*) n FROM approvals WHERE run_id=?',approval.result.run.id).n,1);assert.equal((await calls(approval.result.run.id)).length,1);
  approvalRecover.send({action:'approve',id:card});
  try { await waitFor(()=>trace.getRun(approval.result.run.id).status==='completed','approved run complete'); }
  catch(error) { console.error(JSON.stringify({run:trace.getRun(approval.result.run.id),plan:store.getRunCoordinationPlan(approval.result.run.id),controls:db.all('SELECT * FROM orchestration_run_controls WHERE run_id=?',approval.result.run.id),attempts:db.all('SELECT * FROM coordination_step_attempts WHERE run_id=?',approval.result.run.id),tools:db.all('SELECT * FROM tool_executions WHERE run_id=?',approval.result.run.id),checkpoints:db.all('SELECT kind,phase,status,state FROM run_checkpoints WHERE run_id=?',approval.result.run.id),calls:await calls(approval.result.run.id)},null,2));throw error; }
  approvalRecover.kill('SIGTERM');await approvalRecover.finished;
  assert.equal(db.get('SELECT COUNT(*) n FROM tool_executions WHERE run_id=? AND status=\'completed\'',approval.result.run.id).n,1);assert.equal(db.get('SELECT COUNT(*) n FROM approvals WHERE run_id=?',approval.result.run.id).n,1);
  checks.push('实际审批等待进程崩溃后复用原审批卡与已存工具请求，批准后写入只执行一次，回退开关不影响恢复');

  const uncertainWrite=await pending('uncertain-write',{agentIds:['writer','bb'],recipientIds:['writer','bb'],constraints:{readonly:false}});
  const writeCrash=fork('run',{O6_RUN_ID:uncertainWrite.result.run.id,O6_APPROVAL:'1',O6_HANG_WRITE:'1',O6_HOLD_PROCESS:'1'});
  const writeCard=await waitFor(()=>db.get("SELECT id FROM approvals WHERE run_id=? AND status='pending'",uncertainWrite.result.run.id),'write approval');writeCrash.send({action:'approve',id:writeCard.id});
  await waitFor(async()=> (await logs()).some(r=>r.runId===uncertainWrite.result.run.id&&r.event==='write'),'write happened');writeCrash.kill('SIGKILL');await writeCrash.finished;
  const writtenPath=path.join('apps/server/data/sandbox/workspaces',uncertainWrite.result.run.workspace,'o6-approval.txt');const written=await readFile(writtenPath,'utf8');
  const writeRecover=await fork('recover',{...closed,O6_RUN_ID:uncertainWrite.result.run.id,O6_EXPECT_STATUS:'waiting_for_user'}).finished;assert.equal(writeRecover.code,0,writeRecover.stderr);
  assert.equal(await readFile(writtenPath,'utf8'),written);assert.equal((await calls(uncertainWrite.result.run.id)).length,1);
  assert.equal((await childApi(`/api/runs/${uncertainWrite.result.run.id}/actions`,{action:'resume'},closed)).status,409);await cancel(uncertainWrite);
  checks.push('写文件后、工具账本提交前杀死真实测试进程；保留实际文件和未知账本，不重放写入或后续步骤，必须检查后新建任务');

  const audit=maintenance.auditOrchestration();assert.equal(audit.ok,true,JSON.stringify(audit.issues));assert.equal(audit.providerRequests,0);assert.ok(audit.entryStatistics.some(r=>r.input_format==='legacy'&&r.calls>0));
  assert.equal(maintenance.rollbackCheck('o6-compatible').canRollback,true);assert.equal(maintenance.rollbackCheck('pre-o6').canRollback,false);
  const unknownSchema=new Database(path.join(root,'future.sqlite'));unknownSchema.exec(schema);migration.applyOrchestrationSchemaMigrations(unknownSchema);unknownSchema.exec("INSERT INTO orchestration_schema_migrations VALUES (999,'future','unknown','x')");unknownSchema.close();
  const futureBefore=await readFile(path.join(root,'future.sqlite'));const unsupported=await fork('boot',{DB_PATH:path.join(root,'future.sqlite')}).finished;assert.notEqual(unsupported.code,0);assert.match(unsupported.stderr,/不受此 worker 支持/);assert.deepEqual(await readFile(path.join(root,'future.sqlite')),futureBefore);
  const corrupt=await pending('unsupported-contract');const stored=db.get('SELECT snapshot FROM orchestration_requests WHERE run_id=?',corrupt.result.run.id).snapshot;
  db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',JSON.stringify({...JSON.parse(stored),schemaVersion:99}),corrupt.result.run.id);const futureContract=await fork('boot').finished;assert.notEqual(futureContract.code,0);assert.match(futureContract.stderr,/禁止降级或重新规划/);db.run('UPDATE orchestration_requests SET snapshot=? WHERE run_id=?',stored,corrupt.result.run.id);await cancel(corrupt);
  checks.push('只读审计及活跃契约清单不含目标/密钥；只允许支持契约的 worker 回退，未来 schema/活跃契约在写库与恢复前拒绝');

  const liveHost=fork('run',{O6_RUN_ID:unified.result.run.id,O6_HOLD_PROCESS:'1'});await waitFor(()=>db.get('SELECT * FROM external_runtime_host WHERE pid=?',liveHost.pid),'live host');
  assert.throws(()=>maintenance.migrateOrchestration(),/服务仍在运行/);liveHost.kill('SIGTERM');await liveHost.finished;
  assert.equal(maintenance.migrateOrchestration().mapped,0);checks.push('离线迁移工具拒绝活进程并发修改，重复执行不新增任务或覆盖偏好');
  const output=path.resolve('apps/server/data/orchestration-o6-qa');await mkdir(output,{recursive:true});
  const result={ok:true,checks,realProviderRequests:0};await writeFile(path.join(output,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await Promise.all(children.map(c=>c.finished));
  db.closeDatabase();for(const name of sandboxes)if(name?.startsWith('room-'))await rm(path.join('apps/server/data/sandbox/workspaces',name),{recursive:true,force:true});
  await rm(root,{recursive:true,force:true});
}
