import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {copyFile,mkdir,lstat,writeFile,chmod,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import {ownerClient} from './helpers/platform-real-scenarios.mjs';
import {createGame,actors,material,parseAction,resolve,seats,rules} from './helpers/scoped-werewolf-game.mjs';
import {enlargedLimits,prepareContinuation,installCampaignLimits,historicalSnapshot,snapshotDigest} from './helpers/scoped-werewolf-continuation.mjs';

const args=process.argv.slice(2),options={};let execute=false,resume=false,continueGame=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--execute'&&!execute){execute=true;continue;}
  if(args[i]==='--resume'&&!resume){resume=true;continue;}
  if(args[i]==='--continue-game'&&!continueGame){continueGame=true;continue;}
  if(!['--account','--source-db','--output-dir'].includes(args[i])||options[args[i]]||!args[i+1]||args[i+1].startsWith('--'))throw new Error('INVALID_ARGUMENT');
  options[args[i]]=args[++i];
}
if(!/^[0-9a-f-]{36}$/.test(options['--account']??''))throw new Error('EXPLICIT_MANAGED_API_ACCOUNT_REQUIRED');
const require=createRequire(new URL('../apps/server/package.json',import.meta.url)),Database=require('better-sqlite3');
const sourcePath=path.resolve(options['--source-db']??'apps/server/data/agent-gand.sqlite');
const root=path.resolve(options['--output-dir']??`apps/server/data/scoped-werewolf-real/${new Date().toISOString().replaceAll(':','-')}`);
if(sourcePath===path.join(root,'acceptance.sqlite')||sourcePath.startsWith(root+path.sep))throw new Error('SOURCE_ISOLATION_REQUIRED');
if(resume&&continueGame)throw new Error('CHOOSE_ONE_RECOVERY_MODE');
if((resume||continueGame)&&(!execute||!options['--output-dir']))throw new Error('RESUME_REQUIRES_EXPLICIT_EXECUTION_DIRECTORY');
const previous=resume||continueGame?JSON.parse(await readFile(path.join(root,'result.json'),'utf8')):null;
const previousGame=resume||continueGame?JSON.parse(await readFile(path.join(root,'private-game.json'),'utf8')):null;
if(previous&&previous.accountId!==options['--account'])throw new Error('RECOVERY_ACCOUNT_CHANGED');
if(resume&&(previous.status!=='failed'||previous.errorCode!=='GAME_ACTION_INVALID'||previous.phases?.length!==1||previous.phases[0].phase!=='night-1'||previous.phases[0].releaseRunId||previousGame.events.length))throw new Error('RESUME_REQUIRES_UNPUBLISHED_INITIAL_ACTION_FAILURE');
const source=new Database(sourcePath,{readonly:true,fileMustExist:true});
const selected=source.prepare('SELECT * FROM accounts WHERE id=?').get(options['--account']);
if(!selected?.enabled||selected.archived||selected.auth_type!=='api_key'||source.prepare('SELECT 1 FROM account_revocations WHERE account_id=?').get(selected.id))throw new Error('SELECTED_API_ACCOUNT_UNAVAILABLE');
const version=source.prepare('SELECT * FROM account_versions WHERE account_id=? AND version=?').get(selected.id,selected.config_version),connection=JSON.parse(version.connection);
const model=connection.defaultModel??connection.models?.[0],target=new URL(connection.baseUrl);
if(!connection.protocols.includes('anthropic-messages')||!model||/^(mock|fail|fixture)/i.test(model)||target.protocol!=='https:'||['localhost','127.0.0.1','::1'].includes(target.hostname))throw new Error('REAL_ANTHROPIC_ACCOUNT_REQUIRED');
const originalLimits={maxStarts:36,maxOutputTokens:48000,maxDurationMs:600000,requestTimeoutMs:60000,perRequestMaxTokens:4096};
const limits=continueGame?enlargedLimits(previous.limits):originalLimits;
const description={accountId:selected.id,accountName:selected.display_name,model:'anthropic:'+model,target:target.origin+target.pathname,limits,rules,mode:'structured-actions-and-explicit-exact-publication'};
if(previous&&(previous.model!==description.model||previous.target!==description.target||(!continueGame&&JSON.stringify(previous.limits)!==JSON.stringify(limits))))throw new Error('RESUME_CONFIGURATION_CHANGED');
if(!execute){console.log(JSON.stringify({...description,executed:false},null,2));source.close();process.exit(0);}
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);await writeFile(path.join(root,'.gitignore'),'*\n',{mode:0o600});
await mkdir(path.join(root,'private'),{recursive:true,mode:0o700});
const key=path.join(path.dirname(sourcePath),'private','account-master-key.json'),keyStat=await lstat(key);
if(!keyStat.isFile()||keyStat.isSymbolicLink()||keyStat.nlink!==1||(keyStat.mode&0o077))throw new Error('SOURCE_MASTER_KEY_UNSAFE');
if(!previous){await copyFile(key,path.join(root,'private','account-master-key.json'));await chmod(path.join(root,'private','account-master-key.json'),0o600);}
const credential=source.prepare('SELECT * FROM account_credentials WHERE account_id=? AND version=?').get(selected.id,selected.credential_version);
if(!credential)throw new Error('SELECTED_CREDENTIAL_MISSING');
source.close();
const portProbe=net.createServer();await new Promise((resolve,reject)=>{portProbe.once('error',reject);portProbe.listen(0,'127.0.0.1',resolve);});
const port=portProbe.address().port;await new Promise((resolve,reject)=>portProbe.close(error=>error?reject(error):resolve()));
for(const name of Object.keys(process.env))if(/^(LLM_|ANTHROPIC_|OPENAI_|EXTERNAL_|CODEX_|CLAUDE_|ACCOUNT_|COORDINATION_|ORCHESTRATION_|COLLAB_)/.test(name))delete process.env[name];
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'production',DB_PATH:path.join(root,'acceptance.sqlite'),AGENT_GAND_PRIVATE_DIR:path.join(root,'private'),AGENTS_DIR:path.join(root,'roles'),LOG_LEVEL:'silent',HOST:'127.0.0.1',PORT:String(port),MCP_SERVER_CMD:'',ACCOUNT_MASTER_KEY:'',ACCOUNT_ADMIN_TOKEN:'',SCOPED_COLLABORATION_MODE:'execute',ORCHESTRATION_ENTRY_MODE:'execute',ORCHESTRATION_LEGACY_ENTRY_ENABLED:'false',ORCHESTRATION_ENABLED_DRIVERS:'builtin-llm',COLLAB_MAX_ATTEMPTS:'1',COLLAB_RUN_TIMEOUT_MS:String(limits.maxDurationMs),COLLAB_BATCH_TIMEOUT_MS:String(limits.requestTimeoutMs*2),COLLAB_ATTEMPT_LEASE_MS:String(limits.requestTimeoutMs+60000),COLLAB_SCOPED_MAX_TOKENS_PER_CALL:String(limits.perRequestMaxTokens),COLLAB_MAX_TOKENS:String(Math.max(100000,limits.maxOutputTokens)),LLM_TIMEOUT_MS:String(limits.requestTimeoutMs),EXTERNAL_CLAUDE_COMMAND:path.join(root,'disabled-native'),EXTERNAL_CODEX_COMMAND:path.join(root,'disabled-native')});
const {config}=await import('../apps/server/src/config.ts');config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');
const db=await import('../apps/server/src/db/database.ts');
if(!previous&&db.get('SELECT COUNT(*) n FROM accounts').n)throw new Error('OUTPUT_DIRECTORY_ALREADY_USED');
const continuation=continueGame?prepareContinuation(db,previous,previousGame):null;
if(continuation){
  await db.db.backup(path.join(root,'before-continuation-1.sqlite'));
  await chmod(path.join(root,'before-continuation-1.sqlite'),0o600);
  await writeFile(path.join(root,'result-before-continuation-1.json'),JSON.stringify(previous,null,2)+'\n',{mode:0o600});
  await writeFile(path.join(root,'private-game-before-continuation-1.json'),JSON.stringify(previousGame,null,2)+'\n',{mode:0o600});
}
const copy=(table,row)=>{const keys=Object.keys(row);db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,...Object.values(row));};
if(!previous){copy('accounts',selected);copy('account_versions',version);copy('account_credentials',credential);}
const {updateAccount,getAccount}=await import('../apps/server/src/accounts/store.ts');
if(!previous||continuation)updateAccount(selected.id,{expectedVersion:getAccount(selected.id).version,timeoutMs:limits.requestTimeoutMs});
if(!getAccount(selected.id).hasCredential)throw new Error('SELECTED_CREDENTIAL_UNREADABLE');
if(resume){
  assert.equal(db.get('SELECT COUNT(*) n FROM campaign_network_requests').n,previous.realSupplierRequests);
  assert.equal(db.get('SELECT COUNT(*) n FROM orchestration_model_calls WHERE started_at IS NOT NULL').n,previous.starts);
  assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE status='unknown'").n,0);
  assert.equal(db.get('SELECT status FROM runs WHERE id=?',previous.phases[0].runId)?.status,'completed');
}
const registry=await import('../apps/server/src/agents/registry.ts');
const host='ww-host',publisher='ww-publisher',team=[host,...seats,publisher];
if(!previous)for(const id of team)registry.createAgent({id,name:id===host?'狼人杀主持（模型 API）':id===publisher?'受控公告编辑（模型 API）':'玩家 '+id.slice(-1).toUpperCase()+'（模型 API）',description:'真实 API 狼人杀隔离验收',model:'anthropic:'+model,accountRef:selected.id,requiresAccount:true,execution:{kind:'builtin-llm'},permissionMode:'readonly',tools:[],disallowedTools:[],capabilities:['execute'],systemPrompt:'遵守本次独立上下文和唯一控制工具。若是玩家，仅按当前身份、当前公开历史和合法目标真实决策；角色可以按游戏策略伪装。不得泄露 privateBoundaryGuard。必须以唯一控制工具结束，不输出替代其他参与者的行动；不要补充工具之外的回复。控制计划的 items/join/returnProfile 必须原样提交。结果要具体有效，不能只回复收到。',color:'#7c5cff',avatar:'🎲'});
const {mockProvider}=await import('../apps/server/src/llm/provider.ts');mockProvider.chat=async()=>{throw new Error('MOCK_FORBIDDEN_IN_REAL_ACCEPTANCE');};
const began=previous&&!continuation?Date.parse(previous.startedAt):Date.now(),deadline=began+limits.maxDurationMs;
installCampaignLimits(db,limits,deadline,continuation);
const {Dispatcher,getGlobalDispatcher,setGlobalDispatcher}=require('undici'),ordinary=getGlobalDispatcher();
setGlobalDispatcher(new class extends Dispatcher{
  dispatch(options,handler){
    const origin=new URL(String(options.origin));
    if(['127.0.0.1','localhost','[::1]'].includes(origin.hostname))return ordinary.dispatch(options,handler);
    if(origin.origin!==target.origin||!String(options.path).startsWith(target.pathname.replace(/\/$/,''))||!String(options.path).split('?')[0].endsWith('/messages'))throw new Error('REAL_GAME_UNEXPECTED_UPSTREAM');
    if(Date.now()>deadline||db.get('SELECT COUNT(*) n FROM campaign_network_requests').n>=limits.maxStarts)throw new Error('REAL_GAME_REQUEST_LIMIT');
    db.run('INSERT INTO campaign_network_requests(created_at) VALUES (?)',new Date().toISOString());const id=db.get('SELECT last_insert_rowid() n').n;
    return ordinary.dispatch(options,new Proxy(handler,{get(object,key){const value=object[key];if(typeof value!=='function')return value;return(...args)=>{
      if(key==='onHeaders'||key==='onResponseStart')db.run('UPDATE campaign_network_requests SET http_status=? WHERE id=?',key==='onHeaders'?args[0]:args[1],id);
      return value.apply(object,args);
    };}}));
  }
  close(...args){return ordinary.close(...args);}destroy(...args){return ordinary.destroy(...args);}
});
const {default:Fastify}=await import('../apps/server/node_modules/fastify/fastify.js');
const {registerRoutes}=await import('../apps/server/src/api/routes.ts'),{registerAccountRoutes}=await import('../apps/server/src/api/accountRoutes.ts');
const app=Fastify();await registerRoutes(app);await registerAccountRoutes(app);await app.listen({host:'127.0.0.1',port});
const base=`http://127.0.0.1:${app.server.address().port}`;config.accounts.trustedOrigins.push(base);
const owner=ownerClient(base),request=async(endpoint,body,method=body===undefined?'GET':'POST')=>{
  const response=await fetch(base+endpoint,{method,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
  const data=await response.json();if(!response.ok)throw new Error('GAME_HTTP_'+response.status);return data;
};
const game=previousGame??createGame(),report=previous??{version:1,...description,status:'running',startedAt:new Date(began).toISOString(),phases:[],checks:[],realSupplierRequests:0};
report.status='running';if(previous){report.resumptions=[...(report.resumptions??[]),{at:new Date().toISOString(),reason:previous.errorCode,reusedRunId:continuation?.sourceRunId??previous.phases[0].runId}];delete report.errorCode;delete report.failurePhase;delete report.finishedAt;}
let activeRun;const allRuns=previous?previous.phases.flatMap(p=>[p.runId,p.releaseRunId].filter(Boolean)):[];
if(continuation){
  report.continuations=[continuation];report.limits=limits;report.continuationStartedAt=new Date(began).toISOString();
  report.phases[1]={phase:'discussion',sourceRunId:continuation.sourceRunId,reusedResults:continuation.reusedResults,status:'running'};
}
const save=async()=>{report.realSupplierRequests=db.get('SELECT COUNT(*) n FROM campaign_network_requests').n;report.starts=db.get('SELECT COUNT(*) n FROM orchestration_model_calls WHERE started_at IS NOT NULL').n;
  report.tokens=db.get("SELECT COALESCE(SUM(used),0) outputTokens,COALESCE(SUM(status='unknown'),0) unknownCalls,COALESCE(SUM(CASE WHEN status='unknown' THEN reserved ELSE 0 END),0) unknownReservedTokens FROM orchestration_token_reservations");
  report.modelCallStatuses=db.all('SELECT status,COUNT(*) count FROM orchestration_model_calls GROUP BY status');
  report.httpStatuses=db.all('SELECT http_status status,COUNT(*) count FROM campaign_network_requests GROUP BY http_status');
  await writeFile(path.join(root,'result.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await writeFile(path.join(root,'private-game.json'),JSON.stringify(game,null,2)+'\n',{mode:0o600});};
async function waitRun(id,status){
  for(;;){if(Date.now()>deadline)throw new Error('REAL_GAME_DEADLINE');const state=await owner(`/api/accounts/scoped-delivery/runs/${id}`);
    if(state.status===status)return state;if(['failed','cancelled','completed'].includes(state.status))throw new Error('REAL_GAME_RUN_'+state.status.toUpperCase());await new Promise(r=>setTimeout(r,500));}
}
function auditPhase(runId,ids){
  for(const id of ids){
    const attempts=db.all('SELECT id,input_context FROM collaboration_attempts WHERE run_id=? AND agent_id=?',runId,id);
    assert.equal(attempts.length,1);
    for(const other of seats.filter(other=>other!==id))assert.ok(!attempts[0].input_context.includes(game.privateTags[other]));
  }
  const parent=db.all('SELECT input_context FROM collaboration_attempts WHERE run_id=? AND agent_id=?',runId,host);
  assert.ok(parent.every(a=>seats.every(id=>!a.input_context.includes(game.privateTags[id]))));
  assert.equal(db.get('SELECT COUNT(*) n FROM runtime_scope_attempts WHERE attempt_id IN (SELECT id FROM collaboration_attempts WHERE run_id=?)',runId).n,db.get('SELECT COUNT(*) n FROM collaboration_attempts WHERE run_id=?',runId).n);
}
try{
  const support=await owner('/api/accounts/scoped-delivery/capabilities');assert.equal(support.admissionMode,'execute');
  const room=previous?{id:previous.roomId}:(await request('/api/conversations/empty',{title:'真实 API · 五人结构化狼人杀',agentIds:team,workspace:null,preferences:{strategy:'serial',workflow:'routine',constraints:{readonly:true,deadlineMs:limits.maxDurationMs,firstResponseTimeoutMs:60000,idleTimeoutMs:45000,costPolicy:{version:1,currency:'USD',mode:'estimate',maxCost:1,unknownAction:'reserve',unknownReserve:0.01,prices:[]}}}})).conversation;
  if(continuation){
    const {getConversation}=await import('../apps/server/src/conversations/service.ts');const current=getConversation(room.id);
    await request(`/api/conversations/${room.id}/preferences`,{expectedMembersVersion:current.membersVersion,preferences:{...current.preferences,constraints:{...current.preferences.constraints,deadlineMs:limits.maxDurationMs,firstResponseTimeoutMs:limits.requestTimeoutMs,idleTimeoutMs:limits.requestTimeoutMs}}},'PATCH');
  }
  report.roomId=room.id;report.serverBaseUrl=base;await save();
  for(const phase of ['night-1','discussion','vote','night-2']){
    if(game.winner)break;const existing=report.phases.find(p=>p.phase===phase);if(existing?.status==='completed')continue;
    const ids=actors(game,phase),reused=existing?.reusedResults??[],requestedIds=ids.filter(id=>!reused.some(r=>r.target===id));
    const draft={conversationId:room.id,coordinatorId:host,goal:`狼人杀 ${phase}：按冻结批次向指定玩家分发本轮材料，仅核对完成状态，不处理玩家私密正文。`,join:'all',returnProfile:'status-only-v1',maxTokens:continuation?48000:16000,
      items:requestedIds.map((id,index)=>({key:phase+'-'+id,target:id,batch:Math.floor(index/3)+1,expectation:'result',material:material(game,id,phase)}))};
    let runId=existing?.runId;
    if(!runId){const p=await owner('/api/accounts/scoped-delivery/preview',draft);({runId}=await owner('/api/accounts/scoped-delivery/confirm',{previewId:p.id,fingerprint:p.fingerprint,clientKey:randomUUID()}));allRuns.push(runId);}activeRun=runId;
    const phaseRecord=existing??{phase,status:'running'};phaseRecord.runId=runId;if(!existing)report.phases.push(phaseRecord);await save();console.log(JSON.stringify({phase,status:'running',runId,requests:report.realSupplierRequests,reused:reused.map(r=>r.target)}));
    const result=await waitRun(runId,'completed');auditPhase(runId,requestedIds);
    const actions=Object.fromEntries(ids.map(id=>[id,parseAction(game,id,phase,reused.find(r=>r.target===id)?.output??result.items.find(i=>i.target===id).output)]));
    const announcement=resolve(game,phase,actions);
    const selectedKeys=result.items.filter(i=>phase.startsWith('night')?game.roles[i.target]==='wolf':true).map(i=>i.key);
    const preview=await owner('/api/accounts/information-releases/aggregate/preview',{sourceRunId:runId,itemKeys:selectedKeys,aggregatorId:publisher,instruction:'根据所选结构化行动整理一份私密公告草稿。最终公开文字由 Owner 按固定游戏规则审核。'+(reused.length?'其中部分声明由 Owner 从旧任务已完成结果中原样复用，本任务仅补缺项。':'')+'仅需要下列公告，不增加身份推断或额外文字：\n'+announcement,maxTokens:continuation?30000:10000});
    const {runId:releaseRun}=await owner('/api/accounts/information-releases/aggregate/confirm',{previewId:preview.id,fingerprint:preview.fingerprint,clientKey:randomUUID()});activeRun=releaseRun;allRuns.push(releaseRun);phaseRecord.releaseRunId=releaseRun;await save();
    await waitRun(releaseRun,'waiting_for_user');let state=await owner(`/api/accounts/information-releases/runs/${releaseRun}`);
    if(state.draft.body!==announcement)state=await owner(`/api/accounts/information-releases/runs/${releaseRun}/draft`,{expectedRevision:state.draft.revision,body:announcement},'PATCH');
    const releasePreview=await owner(`/api/accounts/information-releases/runs/${releaseRun}/preview`,{expectedRevision:state.draft.revision,mode:'exact_content',access:{visibility:'public',audience:[]}});
    assert.equal(releasePreview.body,announcement);assert.ok(seats.every(id=>!announcement.includes(game.privateTags[id])));
    const grant=await owner('/api/accounts/information-releases/confirm',{previewId:releasePreview.id,fingerprint:releasePreview.fingerprint,clientKey:randomUUID()});
    const published=await owner(`/api/accounts/information-releases/grants/${grant.grantId}/publish`,{});
    assert.deepEqual(await owner(`/api/accounts/information-releases/grants/${grant.grantId}/publish`,{}),published);
    await waitRun(releaseRun,'completed');
    phaseRecord.status='completed';phaseRecord.publicationMessageId=published.messageId;phaseRecord.actions=actions;phaseRecord.announcement=announcement;activeRun=null;
    await save();console.log(JSON.stringify({phase,status:'completed',requests:report.realSupplierRequests,winner:game.winner}));
  }
  if(!game.winner)throw new Error('GAME_DID_NOT_REACH_A_VERDICT');
  const inbox=await import('../apps/server/src/messaging/inbox.ts');
  for(const id of seats){const view=JSON.stringify(inbox.listByConversation(report.roomId,id));for(const other of seats.filter(other=>other!==id))assert.ok(!view.includes(game.privateTags[other]));}
  assert.equal(db.get('SELECT COUNT(*) n FROM information_release_records').n,report.phases.length);
  assert.equal(db.get('SELECT COUNT(*) n FROM external_agent_executions').n,0);assert.equal(db.get("SELECT COUNT(*) n FROM orchestration_token_reservations WHERE status='unknown'").n,continuation?.acknowledgedUnknownCallIds.length??0);
  if(continuation)assert.equal(snapshotDigest(historicalSnapshot(db,continuation.historicalRunIds)),continuation.historicalDigest);
  report.status='passed';report.winner=game.winner;report.finalRoles=game.roles;report.checks=['真实供应商 HTTP 响应与实际调用账本','模型独立决定夜间行动/公开声明/投票；已完成行动复用原始记录','每个行动独立 Scope；玩家 Context 与可见消息不含其他玩家私密标记','组织者只见固定状态，公开文字经专用单次批准，重复发布幂等','身份查验仅在预言家自己的后续材料中传递','所有必需阶段完成，按宣布的规则得到真实胜负',continuation?'旧 Run/Attempt/Scope 输入/用量记录未改写；已确认的旧未知占额保留，无新增未知调用':'未运行原生 Agent/业务工具，无未知 Token 占额'];
}catch(error){report.status='failed';report.errorCode=/^[A-Z0-9_]+$/.test(error.message??'')?error.message:error.code??'REAL_GAME_ACCEPTANCE_FAILED';report.failurePhase=report.phases.at(-1)?.phase??'admission';if(report.phases.at(-1)?.status==='running')report.phases.at(-1).status='failed';process.exitCode=1;}
finally{
  for(const id of allRuns){try{const row=db.get('SELECT status FROM runs WHERE id=?',id);if(row&&!['completed','failed','cancelled'].includes(row.status))await request(`/api/collaboration/runs/${id}/stop`,{});}catch{}}
  for(let i=0;i<100&&db.get("SELECT COUNT(*) n FROM orchestration_model_calls WHERE status='started'").n;i++)await new Promise(r=>setTimeout(r,50));
  try{
  const attempts=db.all('SELECT agent_id,input_context FROM collaboration_attempts');
  const inbox=await import('../apps/server/src/messaging/inbox.ts');
  report.boundaryAudit={
    attemptCount:attempts.length,
    scopeBindingCount:db.get('SELECT COUNT(*) n FROM runtime_scope_attempts').n,
    playerContextViolations:attempts.filter(a=>seats.includes(a.agent_id)&&seats.some(id=>id!==a.agent_id&&a.input_context?.includes(game.privateTags[id]))).length,
    hostContextViolations:attempts.filter(a=>a.agent_id===host&&seats.some(id=>a.input_context?.includes(game.privateTags[id]))).length,
    playerVisibleMessageViolations:seats.filter(viewer=>{const view=JSON.stringify(inbox.listByConversation(report.roomId??'',viewer));return seats.some(id=>id!==viewer&&view.includes(game.privateTags[id]));}).length,
    publicMessageViolations:db.all("SELECT body FROM messages WHERE visibility='public'").filter(m=>seats.some(id=>m.body.includes(game.privateTags[id]))).length,
    releaseCount:db.get('SELECT COUNT(*) n FROM information_release_records').n,
    nativeExecutionCount:db.get('SELECT COUNT(*) n FROM external_agent_executions').n,
    activeRunCount:db.get("SELECT COUNT(*) n FROM runs WHERE status NOT IN ('completed','failed','cancelled')").n,
    activeModelCallCount:db.get("SELECT COUNT(*) n FROM orchestration_model_calls WHERE status='started'").n,
  };
  }catch{report.auditError='REAL_GAME_BOUNDARY_AUDIT_FAILED';report.status='failed';process.exitCode=1;}
  if(continuation)report.historicalRecordsUnchanged=snapshotDigest(historicalSnapshot(db,continuation.historicalRunIds))===continuation.historicalDigest;
  report.finishedAt=new Date().toISOString();report.elapsedMs=Date.now()-Date.parse(report.startedAt);if(continuation)report.continuationElapsedMs=Date.now()-began;report.billableCostKnown=false;await save();
  await writeFile(path.join(root,'transcript.md'),'# 真实 API 狼人杀记录\n\n'+rules+'\n\n'+game.events.join('\n\n---\n\n')+'\n',{mode:0o600});
  await app.close();setGlobalDispatcher(ordinary);db.closeDatabase();console.log(JSON.stringify({status:report.status,winner:report.winner,errorCode:report.errorCode,realSupplierRequests:report.realSupplierRequests,outputTokens:report.tokens?.outputTokens,evidence:root}));
}
