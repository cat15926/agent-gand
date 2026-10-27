import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

// Actual index preload: data/credentials and bounded transport barriers only.
assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER,'1');
const root=process.env.RC10_MAIN_ROOT;
assert.ok(path.isAbsolute(root??''));
const initial=await new Promise(resolve=>process.once('message',resolve));
assert.equal(initial.operation,'initialize');assert.equal(initial.root,root);
const wallNow=Date.now;let clockOffset=initial.clockOffset??0;Date.now=()=>wallNow()+clockOffset;
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
    systemPrompt:`You are ${member.agentId}. This is synthetic RC10 collaboration acceptance, not a real code change. Use only application tools and facts from the current invocation's source; no native tools/shell/files/web. Preserve home/work IDs from RC10_START/RC10_TO_WORK messages. Be brief, no unnecessary reasoning. Follow this finite protocol:
1. rc10-a with RC10_START: post_message once to rc10-b, body "RC10_TO_WORK home=<home> work=<work>"; final HANDOFF.
2. rc10-b with RC10_TO_WORK in home: cross_post_message to work targeting rc10-b, body "RC10_CONSULT home=<home> work=<work>"; final MOVED.
3. rc10-b with RC10_CONSULT: multi_mention once targets rc10-c/rc10-d, callbackTo rc10-b, timeoutMinutes 3, overrideReason "Synthetic acceptance", question "Give your member ID and an independent opinion on preserving original evidence after restart. No tools or mentions."; final REGISTERED.
4. Consultation responder rc10-c or rc10-d: independent brief answer, no tools or mentions. A consultation settlement invoking rc10-b: transfer_action subject {kind:github_pr,repository:rc10-fixture/review,number:16}, predicate review_delivered, family review, successorSlot review, targets [rc10-a]; final REVIEW_ASSIGNED.
5. rc10-a with action_assignment: call review_context(actionId). Use returned exact context fields. Generation1: submit_review changes_requested, findings ["Keep the original consultation evidence after restart"], resolvedFindingIds [], body "RC10_CHANGES actionId=<id>". Generation2: submit_review approved, findings [], resolvedFindingIds all returned finding IDs, body "RC10_APPROVED actionId=<id>". Then complete_action using submitted evidenceId, then check_review_gate with returned version. Final REVIEW_RECORDED. This verifies synthetic workflow state only; never claim actual source-code or remote approval.
6. rc10-b with RC10_CHANGES: read_review_workflow then start_review_revision using its generation/version, targets [rc10-a], one response for every finding, disposition addressed and body "Synthetic new HEAD preserves the original consultation evidence". Final REVISION_REQUESTED.
7. rc10-b with RC10_APPROVED: read_review_workflow and check_review_gate using its version; only if approved cross_post_message to home targeting rc10-a, body "RC10_RETURN: synthetic workflow complete; current local gate approved, no external approval." Final RETURNED.
8. rc10-a with RC10_RETURN: reply RC10_DONE with no tools. Unrelated system/action completion notifications: reply ACK without tools. Never repeat a successful tool in this invocation. A reviewer must take exactly ONE branch based on review_context.generation, not workflowVersion. After submit_review immediately complete_action, check_review_gate, and stop; never submit another verdict in the same invocation even when changes_requested has open findings. All mutation calls need a distinct stable idempotencyKey. For post_message and cross_post_message OMIT optional visibility, audience and sourceRefs; the server derives the public scope and provenance. Pass only the required fields plus targets. Never invent privacy controls. Do not @mention in final responses.`};
    db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'db',?,?)").run(def.id,def.name,JSON.stringify(def),stamp,stamp);}
}
const ledger=initial.real?new Database(initial.ledgerFile,{fileMustExist:true,timeout:10000}):null;
const reserve=ledger?.transaction((id,n)=>{
  assert.ok(Number.isSafeInteger(n)&&n>0);const old=ledger.prepare('SELECT reserved FROM request_tokens WHERE id=?').get(id);
  if(old){assert.equal(old.reserved,n);return;}
  const used=ledger.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) n FROM request_tokens').get().n;
  assert.ok(used+n<=initial.tokenLimit,'RC10_OPERATOR_TOKEN_LIMIT');ledger.prepare("INSERT INTO request_tokens VALUES(?,?,NULL,'reserved')").run(id,n);
});
const nativeFetch=globalThis.fetch,destination=new URL(JSON.parse(initial.version.connection).baseUrl);
const seen=new Set(),effects=[],gates=new Map(),observers=new Set();let gateNew=false,holdBodies=false,deniedEgress=0,head='a'.repeat(40);const githubEffects=[];
const emit=(event,extra)=>process.send?.({event,pid:process.pid,...extra});
const sha=value=>createHash('sha256').update(value).digest('hex');
function settleKnown(){if(!ledger)return;
  for(const r of db.prepare("SELECT authorization_id,input_tokens,output_tokens FROM threaded_backend_requests WHERE state='complete'").all())
    if(Number.isSafeInteger(r.input_tokens)&&Number.isSafeInteger(r.output_tokens))ledger.prepare("UPDATE request_tokens SET actual=?,state='known' WHERE id=? AND actual IS NULL").run(r.input_tokens+r.output_tokens,r.authorization_id);
}
async function gate(key,signal,stage,fact){
  await new Promise((resolve,reject)=>{
    const entry={key,stage,fact,resolve(){gates.delete(key);resolve();}};gates.set(key,entry);
    const abort=()=>{gates.delete(key);reject(new Error('RC10_GATE_ABORTED'));};
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    emit(stage==='send'?'request-ready':'headers-held',fact);
  });
}
function sse(model,content,stop){
 if(content.type==='tool_use')stop='tool_use';
 const frames=[{type:'message_start',message:{id:'rc10-message',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}},
 {type:'content_block_start',index:0,content_block:content.type==='tool_use'?{type:'tool_use',id:content.id,name:content.name,input:{}}:{type:'text',text:''}},
 {type:'content_block_delta',index:0,delta:content.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(content.input)}:{type:'text_delta',text:content.text}},
 {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:7}},{type:'message_stop'}];
 return new Response(frames.map(f=>`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
globalThis.fetch=async(url,init)=>{
  const target=new URL(url),prefix=destination.pathname.replace(/\/$/,'');
  if(target.origin==='https://api.github.com'){
    assert.equal(init?.method,'GET');assert.equal(init.redirect,'error');assert.equal(db.inTransaction,false);
    assert.ok(['/user','/repos/rc10-fixture/review/pulls/16'].includes(target.pathname));assert.equal(target.search,'');
    githubEffects.push({pathname:target.pathname,head,at:Date.now(),injected:true});
    const fact=target.pathname==='/user'?{id:1010,login:'rc10-review-principal'}:{number:16,base:{repo:{full_name:'rc10-fixture/review'}},head:{sha:head},user:{login:'outside-author'},updated_at:'2026-10-27T00:00:00Z',state:'open',merged:false,merge_commit_sha:null};
    return new Response(JSON.stringify(fact),{headers:{'content-type':'application/json'}});
  }
  if(target.protocol!=='https:'||target.origin!==destination.origin||target.search||target.hash
    ||![prefix+'/v1/messages',prefix+'/v1/messages/count_tokens'].includes(target.pathname)
    ||init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string'||init.body.includes(initial.apiKey)){
    deniedEgress++;throw new Error('RC10_EGRESS_FORBIDDEN');}
  if(toolErrors.length)throw new Error('RC10_STOP_AFTER_TOOL_ERROR');
  // Exact durable request-body hash, never "latest sending row": other bindings
  // may already be in flight when this transport is called.
  const rows=db.prepare("SELECT * FROM threaded_backend_requests WHERE state='sending' AND request_hash=?").all(sha(init.body)).filter(r=>!seen.has(r.id));
  assert.equal(rows.length,1,'RC10_EXACT_TRANSPORT_RECEIPT_REQUIRED');assert.equal(db.inTransaction,false);
  const row=rows[0];seen.add(row.id);const q=db.prepare('SELECT source_message_id FROM threaded_wake_queue WHERE invocation_id=?').get(row.invocation_id);
  const binding=db.prepare('SELECT agent_id FROM threaded_execution_bindings WHERE id=?').get(row.binding_id);
  const source=db.prepare('SELECT * FROM threaded_messages WHERE id=?').get(q.source_message_id);
  const localFault=false;
  const body=JSON.parse(init.body),generation=target.pathname.endsWith('/v1/messages');
  settleKnown();
  let wireMessages=[];try{const raw=body.messages?.find(m=>m.role==='user')?.content;const parsed=typeof raw==='string'?JSON.parse(raw):null;if(Array.isArray(parsed?.messages))wireMessages=parsed.messages.map(m=>({id:m.id,seq:m.seq,bodyHash:sha(m.body),sourceRefs:m.sourceRefs,attachments:m.attachments?.map(a=>({id:a.id,contentHash:a.contentHash}))}));}catch{}
  const fact={requestId:row.id,authorizationId:row.authorization_id,threadId:row.thread_id,agentId:binding.agent_id,
    invocationId:row.invocation_id,attemptId:row.attempt_id,sourceMessageId:q.source_message_id,backend:row.backend,
    pathname:target.pathname,generation,localFault,realSupplier:initial.real&&!localFault,inputBytes:Buffer.byteLength(init.body),bodyHash:sha(init.body),wireMessages,privateSentinelIncluded:init.body.includes('RC10_PRIVATE_SENTINEL'),draftSentinelIncluded:init.body.includes('RC10_DRAFT_SENTINEL'),preparedAt:Date.now(),networkStartedAt:null,headersAt:null,networkEndedAt:null};effects.push(fact);
  const stepRequests=effects.filter(e=>e.invocationId===row.invocation_id&&e.generation).length;
  if(generation&&binding.agent_id==='rc10-b'&&stepRequests===1&&/^RC10_(CHANGES|APPROVED)/.test(source.body))await gate(row.id+':review',init.signal,source.body.startsWith('RC10_CHANGES')?'revision':'return',fact);
  if(generation&&gateNew)await gate(row.id+':send',init.signal,'send',fact);
  // A local test barrier is not a supplier request. Reserve only when all
  // barriers have opened, still atomically before the external call.
  if(!localFault)reserve?.immediate(row.authorization_id,Buffer.byteLength(init.body)+Number(body.max_tokens??1)+8192);
  fact.networkStartedAt=Date.now();emit('provider-request',fact);
  let response;
  try{
    if(localFault)response=new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'RC10_INJECTED_TARGET_FAILURE'}}),{status:400,headers:{'content-type':'application/json'}});
    else if(initial.real)response=await nativeFetch(url,init);
    else {
      await new Promise(resolve=>setTimeout(resolve,50));
      response=sse(body.model,scriptedContent(binding.agent_id,row,source), 'end_turn');
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
  }catch(error){fact.transportFailedAt=Date.now();const safe=v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(v)?v:null;fact.transportFailure={name:safe(error?.name),code:safe(error?.code),causeCode:safe(error?.cause?.code),signalAborted:init.signal?.aborted??null,signalReasonName:safe(init.signal?.reason?.name),signalReasonCode:safe(init.signal?.reason?.code)};throw error;}
};
const {threadedRuntime:runtime}=await import('../../apps/server/src/threaded/service.ts');
const toolReplay=[],toolErrors=[];const originalTool=runtime.collaboration.tools.execute;
runtime.collaboration.tools.execute=async(...args)=>{const result=await originalTool(...args);const parsed=JSON.parse(result);if(!parsed.ok)toolErrors.push({name:args[1],code:parsed.code,input:args[2],bindingId:args[0].id});return result;};
function scriptedContent(agent,row,source){
 const receipts=db.prepare('SELECT name,record FROM threaded_tool_receipts WHERE binding_id=? ORDER BY rowid').all(row.binding_id).map(r=>({name:r.name,result:JSON.parse(r.record).result}));
 const has=name=>receipts.some(r=>r.name===name),last=name=>receipts.findLast(r=>r.name===name)?.result;
 const call=(name,input)=>({type:'tool_use',id:'rc10-'+row.id,name,input:{...(['review_context','read_review_workflow','check_review_gate'].includes(name)?{}:{idempotencyKey:name+':'+source.id}),...input}});
 const text=value=>({type:'text',text:value});
 const route=db.prepare("SELECT body FROM threaded_messages WHERE body LIKE 'RC10_START home=%' ORDER BY seq LIMIT 1").get()?.body;
 const home=route?.match(/home=([^ ]+)/)?.[1],work=route?.match(/work=([^ .]+)/)?.[1];
 if(agent==='rc10-c'||agent==='rc10-d')return text(agent+' RC10_INDEPENDENT_ORIGINAL: preserve evidence and dissent across restart.');
 if(source.body.startsWith('RC10_START'))return has('post_message')?text('HANDOFF'):call('post_message',{body:`RC10_TO_WORK home=${home} work=${work}`,targets:['rc10-b']});
 if(source.body.startsWith('RC10_TO_WORK'))return has('cross_post_message')?text('MOVED'):call('cross_post_message',{threadId:work,body:`RC10_CONSULT home=${home} work=${work}`,targets:['rc10-b']});
 if(source.body.startsWith('RC10_CONSULT'))return has('multi_mention')?text('REGISTERED'):call('multi_mention',{targets:['rc10-c','rc10-d'],question:'Give your member ID and independent opinion on preserving original evidence. No tools.',callbackTo:'rc10-b',timeoutMinutes:3,overrideReason:'Synthetic acceptance'});
 let parsed;try{parsed=JSON.parse(source.body);}catch{}
 if(source.origin==='system'&&db.prepare('SELECT 1 FROM threaded_collaboration_callbacks WHERE message_id=? AND kind=?').get(source.id,'consultation'))return has('transfer_action')?text('REVIEW_ASSIGNED'):call('transfer_action',{subject:{kind:'github_pr',repository:'rc10-fixture/review',number:16},predicate:'review_delivered',family:'review',successorSlot:'review',targets:['rc10-a']});
 if(parsed?.type==='action_assignment'&&agent==='rc10-a'){
  const id=parsed.actionId;if(!has('review_context'))return call('review_context',{actionId:id});const ctx=last('review_context'),second=ctx.generation===2;
  if(!has('submit_review'))return call('submit_review',{actionId:id,expectedGeneration:ctx.generation,expectedVersion:ctx.workflowVersion,authorAgentId:ctx.authorAgentId,acceptedSourceMessageId:ctx.acceptedSourceMessageId,acceptedRevision:ctx.acceptedRevision,reviewedHeadSha:ctx.headSha,verdict:second?'approved':'changes_requested',findings:second?[]:['Keep the original consultation evidence after restart'],resolvedFindingIds:second?ctx.findings.map(f=>f.id):[],body:`RC10_${second?'APPROVED':'CHANGES'} actionId=${id}`});
  if(!has('complete_action'))return call('complete_action',{actionId:id,expectedGeneration:ctx.generation,evidenceId:last('submit_review').evidenceId});
  if(!has('check_review_gate'))return call('check_review_gate',{actionId:id,expectedVersion:last('submit_review').version});return text('REVIEW_RECORDED');
 }
 if(/^RC10_(CHANGES|APPROVED)/.test(source.body)){
  const id=source.body.match(/actionId=([^ ]+)/)[1];if(!has('read_review_workflow'))return call('read_review_workflow',{actionId:id});const w=last('read_review_workflow');
  if(source.body.startsWith('RC10_CHANGES'))return has('start_review_revision')?text('REVISION_REQUESTED'):call('start_review_revision',{actionId:id,expectedGeneration:w.generation,expectedVersion:w.version,targets:['rc10-a'],responses:w.findings.map(f=>({findingId:f.id,body:'Synthetic new HEAD preserves original consultation evidence',disposition:'addressed'}))});
  if(!has('check_review_gate'))return call('check_review_gate',{actionId:id,expectedVersion:w.version});assert.equal(last('check_review_gate').status,'approved');
  return has('cross_post_message')?text('RETURNED'):call('cross_post_message',{threadId:home,body:'RC10_RETURN: synthetic workflow complete; local gate only.',targets:['rc10-a']});
 }
 return text(source.body.startsWith('RC10_RETURN')?'RC10_DONE':'ACK');
}
const notifications=[];runtime.resources.onAvailable(e=>notifications.push({at:Date.now(),...e}));
function facts(){settleKnown();
  return{pid:process.pid,clockOffset,toolReplay,toolErrors,githubEffects,ownerId:db.prepare('SELECT instance_owner_id id FROM threaded_instances').get().id,
    actions:db.prepare('SELECT * FROM threaded_actions').all(),actionGenerations:db.prepare('SELECT * FROM threaded_action_generations').all(),
    workflows:db.prepare('SELECT record FROM threaded_review_workflows').all().map(r=>JSON.parse(r.record)),reviewReports:db.prepare('SELECT * FROM threaded_review_reports').all(),reviewGates:db.prepare('SELECT * FROM threaded_review_gate_checks').all(),budgetRoots:db.prepare('SELECT * FROM threaded_budget_roots').all(),budgetVersions:db.prepare('SELECT * FROM threaded_budget_versions').all(),groups:db.prepare('SELECT * FROM threaded_consultations ORDER BY rowid').all(),targets:db.prepare('SELECT * FROM threaded_consultation_targets ORDER BY rowid').all(),settlements:db.prepare('SELECT * FROM threaded_consultation_settlements ORDER BY rowid').all(),callbacks:db.prepare('SELECT * FROM threaded_collaboration_callbacks ORDER BY rowid').all(),wakes:db.prepare('SELECT * FROM threaded_wakes ORDER BY rowid').all(),outbox:db.prepare('SELECT * FROM threaded_outbox ORDER BY rowid').all(),toolReceipts:db.prepare('SELECT * FROM threaded_tool_receipts ORDER BY rowid').all(),actualMainIndex:true,isolatedExecutionBypass:false,deniedEgress,effects,
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
  else if(message.operation==='head'){assert.ok(/^[a-f0-9]{40}$/.test(message.head));head=message.head;result=true;}
  else if(message.operation==='advance-deadline'){
    assert.equal(db.prepare("SELECT COUNT(*) n FROM threaded_attempts WHERE status='running'").get().n,0,'RC10_CLOCK_REQUIRES_QUIESCENCE');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM threaded_backend_requests WHERE state='sending'").get().n,0,'RC10_CLOCK_REQUIRES_NO_SENDING_REQUEST');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM threaded_backend_processes WHERE state<>'verified_stopped'").get().n,0,'RC10_CLOCK_REQUIRES_STOPPED_NATIVE_PROCESSES');
    const group=db.prepare('SELECT deadline FROM threaded_consultations WHERE id=?').get(message.groupId);assert.ok(group);clockOffset=Math.max(clockOffset,group.deadline+1-wallNow());runtime.collaboration.recover();runtime.wakeup();result=clockOffset;
  }else if(message.operation==='recover-cooperation'){runtime.collaboration.recover();runtime.messaging.recover();runtime.queue.scanPending();runtime.wakeup();result=true;
  }else if(message.operation==='arm'){gateNew=message.send;holdBodies=message.body;result=true;}
  else if(message.operation==='release'){
    const chosen=[...gates.values()].filter(g=>(!message.stage||g.stage===message.stage)&&(!message.messageIds||message.messageIds.includes(g.fact.sourceMessageId)));
    for(const g of chosen)g.resolve();result=chosen.length;
  }else if(message.operation==='seed-history'){
    assert.equal(runtime.diagnostics().draining,false);const ownerId=db.prepare('SELECT instance_owner_id id FROM threaded_instances').get().id;
    result=runtime.messages.acceptUserMessage({ownerId,threadId:message.threadId,clientRequestId:message.requestId,body:message.body,targets:[],visibility:message.visibility??'public',audience:message.audience??[],state:message.state??'published'}).message;
  }else if(message.operation==='cursor-fault'){
    if(message.enabled)db.exec("CREATE TRIGGER rc10_cursor_failure BEFORE INSERT ON threaded_context_cursors BEGIN SELECT RAISE(ABORT,'RC10_CURSOR_WRITE_FAILURE'); END");
    else db.exec('DROP TRIGGER rc10_cursor_failure');result=true;
  }else if(message.operation==='recover-facts'){result=(await import('../../apps/server/src/threaded/backendRecovery.ts')).recoverThreadedBackendFacts(db,runtime.authority);
  }else if(message.operation==='policy')result=runtime.resources.configurePolicy(db.prepare('SELECT instance_owner_id id FROM threaded_instances').get().id,message.patch,runtime.resources.getPolicy().version);
  else if(message.operation==='budget'){
    const r=runtime.budget.ensureRootForMessage(message.messageId);result=runtime.reviseRoot({ownerId:r.ownerId,rootId:r.id,expectedVersion:r.version,
      requestId:'rc10-budget:'+message.messageId,reason:'Authorized isolated RC10 context acceptance; other quotas retained',
      patch:{activityAllowanceMs:10000,unknownCost:'reserve',unknownCostReserveMicrousd:1000000,maxCostMicrousd:100000000,maxInvocations:30,maxA2ADepth:25}});
  }else throw new Error('RC10_OPERATION_FORBIDDEN');
  process.send?.({id:message.id,result});
}catch(error){const raw=error.code??error.message??'';process.send?.({id:message.id,error:/^(THREADED|RESOURCE|RC10|SQLITE)_[A-Z0-9_]+$/.test(raw)?raw:'RC10_OPERATION_FAILED'});}});
