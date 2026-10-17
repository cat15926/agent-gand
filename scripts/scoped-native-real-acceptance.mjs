import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile,access,lstat,chmod} from 'node:fs/promises';
import path from 'node:path';
import {nativeScopeFixture} from './helpers/scoped-native-fixture.mjs';
import {syncNativeRefresh,authDigest} from './helpers/platform-native-refresh.mjs';
import {assertFrozenSourceRoles} from './helpers/scoped-native-source-roles.mjs';

const options={};let execute=false,resume=false,skipCodex=false,integrationOnly=false;
for(let i=2;i<process.argv.length;i++){
  if(process.argv[i]==='--integration-only'){if(integrationOnly)throw new Error('INVALID_ARGUMENT');integrationOnly=true;continue;}
  if(process.argv[i]==='--skip-codex'){if(skipCodex)throw new Error('INVALID_ARGUMENT');skipCodex=true;continue;}
  const key=process.argv[i];if(key==='--resume'){resume=true;continue;}if(key==='--execute'){execute=true;continue;}
  if(!['--claude-agent','--api-agent','--codex-agent','--codex-account','--source-db','--output-dir'].includes(key)||options[key]||!process.argv[i+1])throw new Error('INVALID_ARGUMENT');
  options[key]=process.argv[++i];
}
if(skipCodex&&(options['--codex-agent']||options['--codex-account']))throw new Error('CONFLICTING_CODEX_SELECTION');
if(integrationOnly&&(!skipCodex||resume))throw new Error('INTEGRATION_REQUIRES_NEW_SDK_ONLY_CAMPAIGN');
const root=path.resolve(options['--output-dir']??`apps/server/data/scoped-native-real/${new Date().toISOString().replaceAll(':','-')}`),sourceDb=path.resolve(options['--source-db']??'apps/server/data/agent-gand.sqlite');
if(options['--codex-agent']){
  const Database=createRequire(new URL('../apps/server/package.json',import.meta.url))('better-sqlite3'),source=new Database(sourceDb,{readonly:true,fileMustExist:true});
  try{
    const row=source.prepare('SELECT definition FROM agents WHERE id=? AND enabled=1').get(options['--codex-agent']),selected=row&&JSON.parse(row.definition);
    if(selected?.execution?.driver!=='codex-app-server'||!selected.accountRef||options['--codex-account']&&options['--codex-account']!==selected.accountRef)throw new Error('SELECTED_CODEX_ROLE_REQUIRED');
    options['--codex-account']=selected.accountRef;
  }finally{source.close();}
}
if(!options['--claude-agent']||!options['--api-agent']||!skipCodex&&!/^[0-9a-f-]{36}$/.test(options['--codex-account']??''))throw new Error('EXPLICIT_EXISTING_ACCOUNTS_REQUIRED');
if(sourceDb.startsWith(root+path.sep))throw new Error('ISOLATED_DIRECTORY_REQUIRED');
const limits={maxStarts:20,maxOutputTokens:48000,timeoutMs:600000,totalTimeoutMs:1800000};
if(!execute){console.log(JSON.stringify({executed:false,limits,skipCodex,integrationOnly,claudeAgent:options['--claude-agent'],apiAgent:options['--api-agent'],codexAgent:options['--codex-agent'],codexAccount:options['--codex-account'],root},null,2));process.exit(0);}
if(resume&&!options['--output-dir'])throw new Error('RESUME_REQUIRES_DIRECTORY');
const previous=resume?JSON.parse(await readFile(path.join(root,'result.json'),'utf8')):null;
if(previous&&JSON.stringify(previous.limits)!==JSON.stringify(limits))throw new Error('RESUME_LIMITS_CHANGED');
if(previous&&!!previous.skipCodex!==skipCodex)throw new Error('RESUME_SCOPE_CHANGED');
await mkdir(root,{recursive:true,mode:0o700});if(!resume)await writeFile(path.join(root,'.gitignore'),'*\n',{flag:'wx',mode:0o600});
else await writeFile(path.join(root,'result-before-resume-'+Date.now()+'.json'),JSON.stringify(previous,null,2)+'\n',{flag:'wx',mode:0o600});
for(const key of Object.keys(process.env))if(/^(LLM_|ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|ACCOUNT_|COLLAB_|COORDINATION_|ORCHESTRATION_|EXTERNAL_|MCP_)/.test(key))delete process.env[key];
const deadline=(previous?Date.parse(previous.startedAt):Date.now())+limits.totalTimeoutMs;
if(Date.now()>=deadline)throw new Error('ACCEPTANCE_WINDOW_EXPIRED_REQUIRES_NEW_CAMPAIGN');
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'production',LOG_LEVEL:'silent',R8_ROOT:root,R8_MAX_STARTS:String(limits.maxStarts),R8_DEADLINE:String(deadline),R8_CAMPAIGN:'g5',DB_PATH:path.join(root,'acceptance.sqlite'),AGENTS_DIR:path.join(root,'roles'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),EXTERNAL_CODEX_HOME:path.join(root,'native-codex'),EXTERNAL_CLAUDE_HOME:path.join(root,'native-claude'),EXTERNAL_WORKSPACE_DIR:path.join(root,'workspaces'),EXTERNAL_AGENT_TIMEOUT_MS:String(limits.timeoutMs),LLM_TIMEOUT_MS:String(limits.timeoutMs),COLLAB_SCOPED_MAX_TOKENS_PER_CALL:'12288',COLLAB_ATTEMPT_LEASE_MS:'660000',COLLAB_RUN_TIMEOUT_MS:String(limits.totalTimeoutMs),COLLAB_MAX_ATTEMPTS:'1',MCP_SERVER_CMD:'',ACCOUNT_ADMIN_TOKEN:'',SCOPED_COLLABORATION_MODE:'execute',ORCHESTRATION_ENTRY_MODE:'execute',ORCHESTRATION_ENABLED_DRIVERS:skipCodex?'builtin-llm,claude-sdk':'builtin-llm,claude-sdk,codex-app-server'});
const prepared=resume?await(async()=>{
  const Database=createRequire(new URL('../apps/server/package.json',import.meta.url))('better-sqlite3');
  const source=new Database(sourceDb,{readonly:true,fileMustExist:true}),target=new Database(path.join(root,'acceptance.sqlite'),{readonly:true,fileMustExist:true});
  try{
    if(previous.sourceRoles||options['--codex-agent'])assertFrozenSourceRoles(source,previous.sourceRoles,[options['--claude-agent'],...(options['--codex-agent']?[options['--codex-agent']]:[]),options['--api-agent']]);
    for(const saved of target.prepare('SELECT * FROM accounts').all()){
      const current=source.prepare('SELECT * FROM accounts WHERE id=?').get(saved.id);
      assert.ok(current?.enabled&&!current.archived&&!source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(saved.id));
      for(const field of ['config_version','credential_version','identity_generation'])assert.equal(current[field],saved[field],'frozen account changed');
    }
    for(const [selectedId,isolatedId] of [[options['--claude-agent'],'r8-sdk'],[options['--api-agent'],'r8-api']]){
      const original=source.prepare('SELECT definition FROM agents WHERE id=? AND enabled=1').get(selectedId),copy=target.prepare('SELECT definition FROM agents WHERE id=?').get(isolatedId);
      assert.ok(original&&copy);const a=JSON.parse(original.definition),b=JSON.parse(copy.definition);assert.equal(a.accountRef,b.accountRef);assert.equal(a.model,b.model);
    }
    assert.equal(target.prepare("SELECT COUNT(*) n FROM external_agent_executions WHERE json_extract(record,'$.status')='running'").get().n,0);
    if(skipCodex){
      assert.equal(target.prepare("SELECT COUNT(*) n FROM accounts WHERE auth_type='native_login'").get().n,0);
      assert.equal(target.prepare("SELECT COUNT(*) n FROM agents WHERE id='r8-codex'").get().n,0);
      return {nativeRefresh:[]};
    }
    assert.equal(JSON.parse(target.prepare("SELECT definition FROM agents WHERE id='r8-codex'").get().definition).accountRef,options['--codex-account']);
    const original=source.prepare('SELECT * FROM account_native_identities WHERE account_id=? AND generation=(SELECT identity_generation FROM accounts WHERE id=?)').get(options['--codex-account'],options['--codex-account']);
    const saved=target.prepare('SELECT * FROM account_native_identities WHERE account_id=? AND generation=?').get(original.account_id,original.generation);
    assert.equal(original.identity_hash,saved.identity_hash);
    const sourcePath=path.join(original.directory,'config/auth.json'),copyPath=path.join(saved.directory,'config/auth.json');
    const stat=await lstat(sourcePath);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&!(stat.mode&0o077));
    const bytes=await readFile(sourcePath);await writeFile(copyPath,bytes,{mode:0o600});await chmod(copyPath,0o600);
    return {nativeRefresh:[{sourceDb,accountId:original.account_id,generation:original.generation,sourcePath,copyPath,initialDigest:authDigest(bytes)}]};
  }finally{source.close();target.close();}
})():await new Promise((resolve,reject)=>{
  const worker=fork('scripts/helpers/platform-real-worker.mjs',['prepare',sourceDb,options['--claude-agent'],options['--codex-account']??'',options['--api-agent'],options['--codex-agent']??'',...(skipCodex?['skip-codex']:[])],{env:process.env,execArgv:['--import',path.resolve('apps/server/node_modules/tsx/dist/loader.mjs')],stdio:['ignore','ignore','ignore','ipc']});
  let result;const timer=setTimeout(()=>{worker.kill('SIGKILL');reject(new Error('PREPARATION_TIMEOUT'));},30000);
  worker.on('message',m=>{result=m;});worker.on('error',reject);worker.on('exit',code=>{clearTimeout(timer);code===0&&result?.type==='prepared'?resolve(result):reject(new Error(result?.code??'PREPARATION_FAILED'));});
});
const {config}=await import('../apps/server/src/config.ts');config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');
if(integrationOnly)config.collaboration.maxTokens=12000;
const db=await import('../apps/server/src/db/database.ts'),registry=await import('../apps/server/src/agents/registry.ts');
const scopes=await import('../apps/server/src/runtime/scopedCollaboration.ts'),policy=await import('../apps/server/src/runtime/runPolicy.ts');
const {freezeRuntimeContract}=await import('../apps/server/src/runtime/controlAction.ts'),{post}=await import('../apps/server/src/messaging/inbox.ts');
const trace=await import('../apps/server/src/runs/trace.ts'),store=await import('../apps/server/src/collaboration/store.ts');
const {freezeRunAccounts}=await import('../apps/server/src/accounts/resolver.ts');
const {runScopedNativeTurn}=await import('../apps/server/src/collaboration/scopedNativeTurn.ts');
const {parseScopedControlCall,scopedControlTool}=await import('../apps/server/src/collaboration/scopedRunner.ts');
const delivery=await import('../apps/server/src/collaboration/scopedDelivery.ts'),releases=await import('../apps/server/src/collaboration/informationRelease.ts');
const scheduler=await import('../apps/server/src/collaboration/scheduler.ts'),rooms=await import('../apps/server/src/conversations/service.ts');
const {mockProvider}=await import('../apps/server/src/llm/provider.ts');
const report=previous??{startedAt:new Date().toISOString(),limits,status:'running',businessDataCopied:false,admissionChanged:false,supplierInternalRequests:'unknown',cases:[]};report.status='running';delete report.finishedAt;report.skipCodex=skipCodex;report.integrationOnly=integrationOnly;report.scope=skipCodex?'Managed Claude SDK + model API; Codex skipped by user':'Managed Claude SDK + native-login Codex; API mixture covered by local matrix';
if(skipCodex&&!report.cases.some(c=>c.id==='codex-app-server:cold-boundaries-and-v3'))report.cases.push({id:'codex-app-server:cold-boundaries-and-v3',status:'skipped',reason:'user_requested'});
report.sourceRoles??=prepared.sourceRoles;
db.db.exec(`CREATE TRIGGER IF NOT EXISTS g5_total_tokens BEFORE INSERT ON orchestration_token_reservations WHEN
 (SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) FROM orchestration_token_reservations)+NEW.reserved>${limits.maxOutputTokens}
 BEGIN SELECT RAISE(ABORT,'G5_GLOBAL_TOKEN_LIMIT'); END;`);
const save=async()=>{report.calls=db.all('SELECT backend,status,COUNT(*) count FROM orchestration_model_calls GROUP BY backend,status');report.tokens=db.get("SELECT COALESCE(SUM(CASE WHEN status='settled' THEN used ELSE reserved END),0) charged,COALESCE(SUM(status='unknown'),0) unknownCalls FROM orchestration_token_reservations");await writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});};
const nativeTemplates=(skipCodex?['r8-sdk']:['r8-sdk','r8-codex']).map(id=>registry.getAnyAgent(id));
const fixture=()=>nativeScopeFixture({db,scopes,policy,freezeRuntimeContract,post});
const canaries=[];
async function candidate(template,f,scope,expected){
  const binding=f.binding(scope),context=scopes.assembleScopedContext(binding),agent={...template,id:'a'};
  assert.ok(Date.now()<deadline);db.run("UPDATE collaboration_attempts SET lease_expires_at=? WHERE id=?",new Date(Date.now()+660000).toISOString(),binding.attemptId);
  if(!db.get('SELECT 1 FROM scoped_delivery_plans WHERE run_id=?',f.runId)){
    db.run('INSERT INTO scoped_delivery_plans VALUES(?,?,?,?)',f.runId,'g5-real-fixture',JSON.stringify({deadlineAt:new Date(deadline).toISOString(),maxTokensPerCall:12288}),12000);
    freezeRunAccounts(f.runId,[agent]);
  }
  const result=await runScopedNativeTurn({binding,context,agent,parentSpanId:trace.startSpan(f.runId,{spanKind:'agent',name:'g5-real'}).id,tool:scopedControlTool(expected),parse:call=>parseScopedControlCall(call,expected),signal:AbortSignal.timeout(Math.min(limits.timeoutMs,deadline-Date.now()))});
  assert.equal(result.type,expected.type);
  const execution=JSON.parse(db.get('SELECT record FROM external_agent_executions WHERE run_id=? ORDER BY rowid DESC LIMIT 1',f.runId).record);
  assert.equal(execution.status,'completed');await assert.rejects(()=>access(execution.cwd));
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_sessions WHERE execution_id=?',execution.id).n,0);
  assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id=? AND status='unknown'",f.runId).n,0,'final usage must settle before another request');
  // Synthetic transport fixtures deliberately do not commit model candidates.
  db.run("UPDATE collaboration_attempts SET status='completed' WHERE id=?",binding.attemptId);
  return {result,execution,context};
}
async function scenario(id,fn){const item={id,status:'running'};report.cases.push(item);await save();try{await fn(item);item.status='passed';}catch(e){item.status='failed';item.error=e?.code??e?.message??'ASSERTION_FAILED';
  if(e?.details)item.failureDetails=Object.fromEntries(['phase','timeoutKind','limitMs','initializationStep'].filter(key=>e.details[key]!==undefined).map(key=>[key,e.details[key]]));
}finally{await save();console.log(JSON.stringify({case:id,status:item.status,error:item.error}));}return item.status==='passed';}
const ready=[];
try{
  if(integrationOnly){
    mockProvider.chat=async()=>{throw new Error('REAL_ACCEPTANCE_MOCK_MODEL_FORBIDDEN');};
    const {verifyNativeDeliveryIntegration,verifyNativeCoordinationIntegration}=await import('./helpers/scoped-native-integration.mjs');
    await scenario('normal-sdk-admission-and-controlled-release',async item=>Object.assign(item,await verifyNativeDeliveryIntegration({sdkId:'r8-sdk',apiId:'r8-api',deadline})));
    if(report.cases.at(-1).status==='passed')await scenario('normal-sdk-file-coordination-and-owner-acceptance',async item=>{
      const api=registry.getAnyAgent('r8-api');registry.createAgent({...api,id:'g5-file-reader',name:'G5 scoped API reader',permissionMode:'readonly',tools:['fs.read'],disallowedTools:[]});
      Object.assign(item,await verifyNativeCoordinationIntegration({writerId:'r8-writer',readerId:'g5-file-reader',deadline}));
    });
  }
  for(const template of integrationOnly?[]:nativeTemplates){
    const driver=template.execution.driver;
    if(report.cases.some(c=>c.id===driver+':cold-boundaries-and-v3'&&c.status==='passed')){ready.push(driver);continue;}
    const proof=[...report.cases].reverse().find(c=>c.id===driver+':cold-boundaries-and-v3'&&c.coldScopes===3);
    const ok=await scenario(driver+':cold-boundaries-and-v3',async item=>{
      const f=fixture(),paths=[];
      if(proof){item.coldScopes=3;item.controls=[...proof.controls];}else{
      for(const label of ['FIRST_PRIVATE','SECOND_PRIVATE','PUBLIC']){
        const secret='G5_REAL_'+driver.replaceAll('-','_')+'_'+label;canaries.push(secret);
        const objective=f.message(`${secret}: Compute 7*6. Call agent.complete exactly once with the result 42, one arithmetic explanation and a limitation (at least 30 characters). Do not mention any other task.`,label==='PUBLIC'?{visibility:'public',audience:[]}:undefined);
        const roleInput=f.message(template.systemPrompt,{visibility:'public',audience:[]});
        const scope=f.create(objective,{inputs:[roleInput],...(label==='PUBLIC'?{defaultOutputAccess:{visibility:'public',audience:[]}}:{})});
        const {result,execution,context}=await candidate(template,f,scope,{version:3,type:'complete',summary:''});
        assert.match(result.summary,/42/);for(const other of canaries.filter(c=>c!==secret)){assert.ok(!context.includes(other));assert.ok(!result.summary.includes(other));}
        paths.push(execution.cwd);
      }
      assert.equal(new Set(paths).size,3);item.coldScopes=3;item.controls=['complete'];}
      await save();
      for(const type of ['consult_batch','acknowledge','request_release']){
        if(item.controls.includes(type))continue;
        const current=fixture();
        const expected=type==='consult_batch'?{version:3,type,items:[{key:'one',target:'b',payloadRef:'owner-approved-envelope',expectation:'result'}],join:'all',returnProfile:'status-only-v1'}:type==='acknowledge'?{version:3,type,envelopeId:'owner-approved-envelope'}:{version:3,type,summary:''};
        const instruction=type==='request_release'?'Produce a private draft explaining that 7*6=42, including one reason and one limitation. Submit through agent.request_release.':`Submit exactly this confirmed action through the one available tool: ${JSON.stringify(Object.fromEntries(Object.entries(expected).filter(([key])=>!['version','type'].includes(key))))}. These are tool arguments; do not add version/type. Do not change identifiers, add items or use other tools.`;
        await candidate(template,current,current.create(current.message(instruction),{inputs:[current.message(template.systemPrompt,{visibility:'public',audience:[]})]}),expected);item.controls.push(type);await save();
      }
    });if(ok)ready.push(driver);
  }
  if(!integrationOnly&&ready.length===nativeTemplates.length)await scenario(skipCodex?'real-api-sdk-all-and-native-controlled-release':'real-mixed-all-and-native-controlled-release',async item=>{
    const ids=['g5-owner','g5-sdk','g5-publisher'];
    for(const id of ids)registry.createAgent({id,name:id,description:'G5 isolated admission fixture',systemPrompt:'Use only this scope. Compute the assigned expression, explain the result and a limitation; submit the actual result using the single available control tool.',model:'mock:'+id,capabilities:['execute'],permissionMode:'readonly',tools:[],disallowedTools:[],color:'#4477aa',avatar:''});
    mockProvider.chat=async()=>{throw new Error('REAL_ACCEPTANCE_MOCK_MODEL_FORBIDDEN');};
    const room=rooms.createConversation({title:'G5 real mixed acceptance',mode:'collaboration',agentIds:ids,workspace:null});
    const p=delivery.previewScopedDelivery({conversationId:room.id,coordinatorId:ids[0],goal:'分别完成算术检查，结果私密保留',join:'all',returnProfile:'status-only-v1',maxTokens:12000,items:ids.slice(1,2).map((target,n)=>({key:'real-'+n,target,batch:1,expectation:'result',material:`G5_MIXED_SECRET_${n}: Compute ${n+2}*7. Submit the numeric result and a reason and limitation, at least 30 characters.`}))},'g5-owner');
    const runId=delivery.confirmScopedDelivery({previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()},'g5-owner');
    function replace(runId,templates){
      const snapshots=trace.listRunAgentSnapshots(runId).map(agent=>templates[agent.id]?{...templates[agent.id],id:agent.id}:agent);
      for(const agent of snapshots)db.run('UPDATE run_agent_snapshots SET definition=? WHERE run_id=? AND agent_id=?',JSON.stringify(agent),runId,agent.id);
      db.run('DELETE FROM run_account_bindings WHERE run_id=?',runId);db.run('DELETE FROM run_planner_snapshots WHERE run_id=?',runId);freezeRunAccounts(runId,snapshots);
    }
    replace(runId,{'g5-sdk':nativeTemplates[0],'g5-owner':skipCodex?registry.getAnyAgent('r8-api'):nativeTemplates[1]});
    async function wait(id,status){for(;;){const state=trace.getRun(id);if(state.status===status)return;if(['failed','cancelled','completed'].includes(state.status))throw new Error('RUN_'+state.status);if(Date.now()>deadline)throw new Error('G5_DEADLINE');await new Promise(r=>setTimeout(r,250));}}
    scheduler.kickCollaboration(room.id);await wait(runId,'completed');
    const status=delivery.scopedDeliveryStatus(runId);assert.ok(status.items.every(i=>i.status==='completed'));
    const p2=releases.previewPrivateAggregate({sourceRunId:runId,itemKeys:['real-0'],aggregatorId:'g5-publisher',instruction:'核对算术结果，写出带依据与限制的私密摘要；仅调用 agent.request_release，不自行发布。',maxTokens:12000},'g5-owner');
    const aggregate=releases.confirmPrivateAggregate({previewId:p2.id,fingerprint:p2.fingerprint,clientKey:randomUUID()},'g5-owner');replace(aggregate.runId,{'g5-publisher':nativeTemplates[0]});
    scheduler.kickCollaboration(room.id);await wait(aggregate.runId,'waiting_for_user');
    const preview=releases.previewInformationRelease(aggregate.runId,{expectedRevision:1,mode:'exact_content',access:{visibility:'public',audience:[]}},'g5-owner');
    const grant=releases.confirmInformationRelease({previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()},'g5-owner');
    const publication=releases.publishInformationRelease(grant.grantId);assert.deepEqual(releases.publishInformationRelease(grant.grantId),publication);
    const recovery=await import('../apps/server/src/runs/recovery.ts');recovery.recoverDurableHolds(aggregate.runId);scheduler.kickCollaboration(room.id);await wait(aggregate.runId,'completed');
    assert.equal(releases.releaseState(aggregate.runId).records.length,1);item.runIds=[runId,aggregate.runId];item.ownerApprovedPublication=true;
    item.backends=skipCodex?['builtin-llm','claude-sdk']:['codex-app-server','claude-sdk'];
    for(const id of [runId,aggregate.runId])assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_model_calls WHERE run_id=? AND model LIKE 'mock:%'",id).n,0,'real mixed acceptance must not call mock models');
    assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE run_id IN (?,?) AND status='unknown'",runId,aggregate.runId).n,0);
  });
  const latest=new Map(report.cases.map(c=>[c.id,c]));
  const required=integrationOnly?['normal-sdk-admission-and-controlled-release','normal-sdk-file-coordination-and-owner-acceptance']:skipCodex?['claude-sdk:cold-boundaries-and-v3','real-api-sdk-all-and-native-controlled-release']:['claude-sdk:cold-boundaries-and-v3','codex-app-server:cold-boundaries-and-v3','real-mixed-all-and-native-controlled-release'];
  report.status=required.every(id=>latest.get(id)?.status==='passed')?(skipCodex?'passed_selected_scope':'passed'):'failed';
}finally{
  for(const row of db.all("SELECT id FROM runs WHERE status IN ('running','waiting_for_user','awaiting_approval')")){store.cancelCollaborationRun(row.id);trace.setRunStatus(row.id,'cancelled');}
  const {stopExternalRun}=await import('../apps/server/src/execution/runner.ts');
  for(const row of db.all('SELECT DISTINCT run_id FROM external_agent_executions'))await stopExternalRun(row.run_id);
  await new Promise(r=>setTimeout(r,200));
  report.finishedAt=new Date().toISOString();await save();
  for(const binding of prepared.nativeRefresh??[])await syncNativeRefresh(binding);
  db.closeDatabase();
}
console.log(JSON.stringify({status:report.status,report:path.join(root,'result.json'),calls:report.calls,tokens:report.tokens},null,2));
if(!['passed','passed_selected_scope'].includes(report.status))process.exitCode=1;
