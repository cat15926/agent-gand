import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

// Actual index preload: data/credentials and bounded transport barriers only.
assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER,'1');
const root=process.env.RC07_MAIN_ROOT;
assert.ok(path.isAbsolute(root??''));
const initial=await new Promise(resolve=>process.once('message',resolve));
assert.equal(initial.operation,'initialize');assert.equal(initial.root,root);
const {config}=await import('../../apps/server/src/config.ts');
config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');config.accounts.masterKey=initial.ephemeralMasterKey;
const {db}=await import('../../apps/server/src/db/database.ts');
delete process.env.AGENT_GAND_ISOLATED_WORKER;
const {rememberSecret}=await import('../../apps/server/src/accounts/secrets.ts');
const {writeCredential}=await import('../../apps/server/src/accounts/credentials.ts');
rememberSecret(initial.apiKey);rememberSecret(initial.ephemeralMasterKey);
if(!initial.restore){
  for(const [table,row]of [['accounts',initial.account],['account_versions',initial.version]]){
    const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  }
  writeCredential(initial.account.id,initial.account.credential_version,initial.apiKey);
  const stamp=new Date().toISOString();
  for(const member of initial.members){const def={id:member.agentId,name:member.agentId,version:1,enabled:true,
    model:member.model,accountRef:member.accountId,requiresAccount:true,tools:initial.applicationTools,permissionMode:'readonly',
    systemPrompt:'Synthetic context acceptance. Follow only the current user message final-answer instruction. Do not mention any members, call tools, use files, shell or web. Do not perform background work. Avoid unnecessary reasoning.'};
    db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'db',?,?)").run(def.id,def.name,JSON.stringify(def),stamp,stamp);}
}
const ledger=initial.real?new Database(initial.ledgerFile,{fileMustExist:true,timeout:10000}):null;
const reserve=ledger?.transaction((id,n)=>{
  assert.ok(Number.isSafeInteger(n)&&n>0);const old=ledger.prepare('SELECT reserved FROM request_tokens WHERE id=?').get(id);
  if(old){assert.equal(old.reserved,n);return;}
  const used=ledger.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM request_tokens').get().n;
  assert.ok(used+n<=initial.tokenLimit,'RC07_OPERATOR_TOKEN_LIMIT');ledger.prepare("INSERT INTO request_tokens VALUES(?,?,NULL,'reserved')").run(id,n);
});
const nativeFetch=globalThis.fetch,destination=new URL(JSON.parse(initial.version.connection).baseUrl);
const seen=new Set(),effects=[],gates=new Map(),observers=new Set();let gateNew=false,holdBodies=false,deniedEgress=0;
const emit=(event,extra)=>process.send?.({event,pid:process.pid,...extra});
const sha=value=>createHash('sha256').update(value).digest('hex');
function settleKnown(){if(!ledger)return;
  for(const r of db.prepare("SELECT authorization_id,input_tokens,output_tokens FROM threaded_backend_requests WHERE state='complete'").all())
    if(Number.isSafeInteger(r.input_tokens)&&Number.isSafeInteger(r.output_tokens))ledger.prepare("UPDATE request_tokens SET actual=?,state='known' WHERE id=? AND actual IS NULL").run(r.input_tokens+r.output_tokens,r.authorization_id);
}
async function gate(key,signal,stage,fact){
  await new Promise((resolve,reject)=>{
    const entry={key,stage,fact,resolve(){gates.delete(key);resolve();}};gates.set(key,entry);
    const abort=()=>{gates.delete(key);reject(new Error('RC07_GATE_ABORTED'));};
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    emit(stage==='send'?'request-ready':'headers-held',fact);
  });
}
globalThis.fetch=async(url,init)=>{
  const target=new URL(url),prefix=destination.pathname.replace(/\/$/,'');
  if(target.protocol!=='https:'||target.origin!==destination.origin||target.search||target.hash
    ||![prefix+'/v1/messages',prefix+'/v1/messages/count_tokens'].includes(target.pathname)
    ||init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string'||init.body.includes(initial.apiKey)){
    deniedEgress++;throw new Error('RC07_EGRESS_FORBIDDEN');}
  // Exact durable request-body hash, never "latest sending row": other bindings
  // may already be in flight when this transport is called.
  const rows=db.prepare("SELECT * FROM threaded_backend_requests WHERE state='sending' AND request_hash=?").all(sha(init.body)).filter(r=>!seen.has(r.id));
  assert.equal(rows.length,1,'RC07_EXACT_TRANSPORT_RECEIPT_REQUIRED');assert.equal(db.inTransaction,false);
  const row=rows[0];seen.add(row.id);const q=db.prepare('SELECT source_message_id FROM threaded_wake_queue WHERE invocation_id=?').get(row.invocation_id);
  const binding=db.prepare('SELECT agent_id FROM threaded_execution_bindings WHERE id=?').get(row.binding_id);
  const body=JSON.parse(init.body),generation=target.pathname.endsWith('/v1/messages');
  reserve?.immediate(row.authorization_id,Buffer.byteLength(init.body)+Number(body.max_tokens??1)+8192);
  let wireMessages=[];try{const raw=body.messages?.find(m=>m.role==='user')?.content;const parsed=typeof raw==='string'?JSON.parse(raw):null;if(Array.isArray(parsed?.messages))wireMessages=parsed.messages.map(m=>({id:m.id,seq:m.seq,bodyHash:sha(m.body),sourceRefs:m.sourceRefs,attachments:m.attachments?.map(a=>({id:a.id,contentHash:a.contentHash}))}));}catch{}
  const fact={requestId:row.id,authorizationId:row.authorization_id,threadId:row.thread_id,agentId:binding.agent_id,
    invocationId:row.invocation_id,attemptId:row.attempt_id,sourceMessageId:q.source_message_id,backend:row.backend,
    pathname:target.pathname,generation,inputBytes:Buffer.byteLength(init.body),bodyHash:sha(init.body),wireMessages,privateSentinelIncluded:init.body.includes('RC07_PRIVATE_SENTINEL'),draftSentinelIncluded:init.body.includes('RC07_DRAFT_SENTINEL'),preparedAt:Date.now(),networkStartedAt:null,headersAt:null,networkEndedAt:null};effects.push(fact);
  if(generation&&gateNew)await gate(row.id+':send',init.signal,'send',fact);
  fact.networkStartedAt=Date.now();emit('provider-request',fact);
  let response;
  try{
    if(initial.real)response=await nativeFetch(url,init);
    else {await new Promise(resolve=>setTimeout(resolve,50));response=new Response(JSON.stringify({id:'rc07-'+row.id,type:'message',role:'assistant',model:body.model,
      content:[{type:'text',text:'RC07_ACK'}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:4}}),{headers:{'content-type':'application/json'}});
    }
    fact.headersAt=Date.now();fact.status=response.status;
    const observation=(async()=>{const reader=response.clone().body.getReader();
      try{while(!(await reader.read()).done){}fact.networkEndedAt=Date.now();fact.networkOutcome='eof';}
      catch{fact.networkEndedAt=Date.now();fact.networkOutcome='aborted_or_failed';}
      finally{reader.releaseLock();emit('network-ended',fact);}})();
    observers.add(observation);void observation.finally(()=>observers.delete(observation));
    emit('provider-headers',fact);
    if(generation&&holdBodies)await gate(row.id+':body',init.signal,'body',fact);
    return response;
  }catch(error){fact.transportFailedAt=Date.now();throw error;}
};
const {threadedRuntime:runtime}=await import('../../apps/server/src/threaded/service.ts');
const notifications=[];runtime.resources.onAvailable(e=>notifications.push({at:Date.now(),...e}));
function facts(){settleKnown();
  return{pid:process.pid,actualMainIndex:true,isolatedExecutionBypass:false,deniedEgress,effects,
    gates:[...gates.values()].map(g=>({key:g.key,stage:g.stage,requestId:g.fact.requestId,sourceMessageId:g.fact.sourceMessageId})),
    diagnostics:runtime.diagnostics(),policy:runtime.resources.getPolicy(),notifications,
    manifests:db.prepare('SELECT record FROM threaded_context_manifests ORDER BY rowid').all().map(r=>JSON.parse(r.record)),
    preparations:db.prepare('SELECT id,agent_id,source_message_id,preparation FROM threaded_wake_queue ORDER BY seq').all(),
    inputIntents:db.prepare('SELECT * FROM threaded_session_input_intents ORDER BY seq').all(),
    sendIntents:db.prepare('SELECT * FROM threaded_context_send_intents ORDER BY rowid').all(),
    sendReceipts:db.prepare('SELECT * FROM threaded_context_send_receipts ORDER BY rowid').all(),
    deliveries:db.prepare('SELECT * FROM threaded_context_deliveries ORDER BY rowid').all(),
    cursorFacts:db.prepare('SELECT * FROM threaded_context_cursor_facts ORDER BY rowid').all(),
    cursors:db.prepare('SELECT * FROM threaded_context_cursors ORDER BY rowid').all(),
    queue:db.prepare('SELECT id,agent_id,thread_id,source_message_id,state,reason,invocation_id,causal_root_id FROM threaded_wake_queue ORDER BY seq').all(),
    invocations:db.prepare('SELECT id,agent_id,thread_id,status,reserved_run_id,causal_root_id,recovery_reason,current_attempt_id FROM threaded_invocations ORDER BY rowid').all(),
    attempts:db.prepare('SELECT id,invocation_id,status,execution_stage,resource_release_state FROM threaded_attempts ORDER BY rowid').all(),
    requests:db.prepare('SELECT id,authorization_id,invocation_id,attempt_id,backend,state,input_tokens,output_tokens FROM threaded_backend_requests ORDER BY rowid').all(),
    bindings:db.prepare('SELECT id,invocation_id,attempt_id,claim_id,agent_id,thread_id FROM threaded_execution_bindings ORDER BY rowid').all(),
    processes:db.prepare('SELECT token,binding_id,host,pid,state FROM threaded_backend_processes ORDER BY rowid').all(),
    claims:runtime.resources.listClaims(),messages:db.prepare('SELECT id,thread_id,seq,origin,state,visibility,body,source_attempt_id,sender_agent_id,causal_root_id FROM threaded_messages ORDER BY seq').all(),
    terminals:db.prepare('SELECT invocation_id,attempt_id,run_id,status FROM threaded_invocation_terminals ORDER BY rowid').all(),
    sessions:db.prepare('SELECT id,binding_key,native_id,resource_key,version,state FROM execution_resource_sessions ORDER BY rowid').all(),
    foreignKeys:db.pragma('foreign_key_check')};
}
process.on('message',async message=>{if(!message.id)return;try{
  let result;
  if(message.operation==='facts')result=facts();
  else if(message.operation==='arm'){gateNew=message.send;holdBodies=message.body;result=true;}
  else if(message.operation==='release'){
    const chosen=[...gates.values()].filter(g=>(!message.stage||g.stage===message.stage)&&(!message.messageIds||message.messageIds.includes(g.fact.sourceMessageId)));
    for(const g of chosen)g.resolve();result=chosen.length;
  }else if(message.operation==='seed-history'){
    assert.equal(runtime.diagnostics().draining,false);const ownerId=db.prepare('SELECT instance_owner_id id FROM threaded_instances').get().id;
    result=runtime.messages.acceptUserMessage({ownerId,threadId:message.threadId,clientRequestId:message.requestId,body:message.body,targets:[],visibility:message.visibility??'public',audience:message.audience??[],state:message.state??'published'}).message;
  }else if(message.operation==='cursor-fault'){
    if(message.enabled)db.exec("CREATE TRIGGER rc07_cursor_failure BEFORE INSERT ON threaded_context_cursors BEGIN SELECT RAISE(ABORT,'RC07_CURSOR_WRITE_FAILURE'); END");
    else db.exec('DROP TRIGGER rc07_cursor_failure');result=true;
  }else if(message.operation==='recover-facts'){result=(await import('../../apps/server/src/threaded/backendRecovery.ts')).recoverThreadedBackendFacts(db,runtime.authority);
  }else if(message.operation==='policy')result=runtime.resources.configurePolicy(db.prepare('SELECT instance_owner_id id FROM threaded_instances').get().id,message.patch,runtime.resources.getPolicy().version);
  else if(message.operation==='budget'){
    const r=runtime.budget.ensureRootForMessage(message.messageId);result=runtime.reviseRoot({ownerId:r.ownerId,rootId:r.id,expectedVersion:r.version,
      requestId:'rc07-budget:'+message.messageId,reason:'Authorized isolated RC07 context acceptance; other quotas retained',
      patch:{activityAllowanceMs:10000,unknownCost:'reserve',unknownCostReserveMicrousd:1000000,maxCostMicrousd:10000000}});
  }else throw new Error('RC07_OPERATION_FORBIDDEN');
  process.send?.({id:message.id,result});
}catch(error){const raw=error.code??error.message??'';process.send?.({id:message.id,error:/^(THREADED|RESOURCE|RC07|SQLITE)_[A-Z0-9_]+$/.test(raw)?raw:'RC07_OPERATION_FAILED'});}});
