import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';

// Isolated actual-index preload. Only synthetic account data and injected HTTP.
assert.equal(process.env.AGENT_GAND_ISOLATED_WORKER,'1');
const root=process.env.RC09_MAIN_ROOT;assert.ok(path.isAbsolute(root??''));
const initial=await new Promise(resolve=>process.once('message',resolve));
assert.equal(initial.operation,'initialize');assert.equal(initial.root,root);
const {config}=await import('../../apps/server/src/config.ts');
config.dataDir=root;config.sandboxDir=path.join(root,'sandbox');config.accounts.masterKey=initial.ephemeralMasterKey;
const {db}=await import('../../apps/server/src/db/database.ts');
delete process.env.AGENT_GAND_ISOLATED_WORKER;
if(!initial.restore){
  for(const [table,row]of [['accounts',initial.account],['account_versions',initial.version]]){
    const keys=Object.keys(row);db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  }
  const {writeCredential}=await import('../../apps/server/src/accounts/credentials.ts');
  writeCredential(initial.account.id,1,'RC09_SYNTHETIC_KEY');
  const stamp=new Date().toISOString();
  for(const member of initial.members){const def={id:member.agentId,name:member.agentId,version:1,enabled:true,
    model:member.model,accountRef:member.accountId,requiresAccount:true,tools:[],permissionMode:'readonly',systemPrompt:'Reply RC09_ACK. No tools.'};
    db.prepare("INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,'db',?,?)").run(def.id,def.name,JSON.stringify(def),stamp,stamp);}
}
const effects=[];let deniedEgress=0;
const sha=s=>createHash('sha256').update(s).digest('hex');
globalThis.fetch=async(url,init)=>{
  const target=new URL(url);
  if(target.origin!=='https://rc09.invalid'||!['/v1/messages','/v1/messages/count_tokens'].includes(target.pathname)
    ||target.search||target.hash||init?.method!=='POST'||init.redirect!=='error'||typeof init.body!=='string'){
    deniedEgress++;throw new Error('RC09_UNEXPECTED_EGRESS');}
  const rows=db.prepare("SELECT * FROM threaded_backend_requests WHERE state='sending' AND request_hash=?").all(sha(init.body));
  assert.equal(rows.length,1);const r=rows[0];effects.push({requestId:r.id,authorizationId:r.authorization_id,bindingId:r.binding_id,attemptId:r.attempt_id,backend:r.backend,pathname:target.pathname,realSupplier:false});
  if(initial.scenario==='unknown-request')throw new Error('RC09_INJECTED_TRANSPORT_UNKNOWN');
  if(target.pathname.endsWith('/count_tokens'))return new Response(JSON.stringify({input_tokens:20}),{headers:{'content-type':'application/json'}});
  const body=JSON.parse(init.body);
  const frames=[{type:'message_start',message:{id:'rc09-injected-response',type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'RC09_ACK'}},
    {type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:7}},{type:'message_stop'}];
  return new Response(frames.map(f=>`event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
};
const {threadedRuntime:runtime}=await import('../../apps/server/src/threaded/service.ts');
function facts(){return{pid:process.pid,actualMainIndex:true,isolatedExecutionBypass:false,deniedEgress,effects,
  invocations:db.prepare('SELECT id,status,current_attempt_id,causal_root_id,recovery_reason FROM threaded_invocations ORDER BY rowid').all(),
  attempts:db.prepare('SELECT id,invocation_id,status,execution_stage,execution_reason,outcome_record,resource_release_state FROM threaded_attempts ORDER BY rowid').all(),
  bindings:db.prepare('SELECT * FROM threaded_execution_bindings ORDER BY rowid').all(),
  requests:db.prepare('SELECT * FROM threaded_backend_requests ORDER BY rowid').all(),
  budget:db.prepare('SELECT * FROM threaded_budget_requests ORDER BY rowid').all(),
  reconciliations:db.prepare('SELECT * FROM threaded_budget_reconciliations ORDER BY rowid').all(),
  outcomes:db.prepare('SELECT * FROM threaded_budget_outcomes ORDER BY rowid').all(),
  activity:db.prepare('SELECT * FROM threaded_budget_activity ORDER BY rowid').all(),
  processes:db.prepare('SELECT * FROM threaded_backend_processes ORDER BY rowid').all(),
  quiescence:db.prepare('SELECT * FROM threaded_backend_quiescence ORDER BY rowid').all(),
  claims:runtime.resources.listClaims(),
  queue:db.prepare('SELECT id,state,reason,invocation_id FROM threaded_wake_queue ORDER BY seq').all(),
  terminals:db.prepare('SELECT * FROM threaded_invocation_terminals ORDER BY rowid').all(),
  outputs:db.prepare('SELECT * FROM threaded_outputs ORDER BY rowid').all(),
  messages:db.prepare('SELECT id,origin,body FROM threaded_messages ORDER BY seq').all(),
  foreignKeys:db.pragma('foreign_key_check')};}
function crash(point){writeFileSync(path.join(root,'fault-window.json'),JSON.stringify({point,snapshot:facts()}));process.send?.({event:'fault-window',point});process.kill(process.pid,'SIGSTOP');}
if(!initial.restore&&initial.scenario!=='unknown-request'){
  if(initial.scenario==='sdk-closed'){
    runtime.backendEvidence.confirmProcessStopped=()=>{crash('after trusted close before stopped confirmation');throw new Error('RC09_FAULT_WINDOW');};
  }else{
    runtime.budget.settleRequest=()=>{crash('after complete receipt before budget settlement');throw new Error('RC09_FAULT_WINDOW');};
  }
}
process.on('message',message=>{if(!message.id)return;try{
  let result;
  if(message.operation==='facts')result=facts();
  else if(message.operation==='recover')result=runtime.recover();
  else if(message.operation==='budget'){
    const r=runtime.budget.ensureRootForMessage(message.messageId);result=runtime.reviseRoot({ownerId:r.ownerId,rootId:r.id,expectedVersion:r.version,requestId:'rc09-budget:'+r.id,
      reason:'Isolated reconciliation acceptance',patch:{activityAllowanceMs:10000,unknownCost:'reserve',unknownCostReserveMicrousd:1000000,maxCostMicrousd:10000000}});
  }else throw new Error('RC09_OPERATION_FORBIDDEN');
  process.send?.({id:message.id,result});
}catch(error){const raw=error.code??error.message??'';process.send?.({id:message.id,error:/^(THREADED|RESOURCE|RC09|SQLITE)_[A-Z0-9_]+$/.test(raw)?raw:'RC09_OPERATION_FAILED'});}});
