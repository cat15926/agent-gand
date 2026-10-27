import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { openBackendRuntimeFixture } from './fixtures/threadedBackendRuntimeFixture.mjs';

// Actual SDK 0.3.288 / CLI / guardian / MCP, synthetic supplier transport only.
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc08-sdk-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',
  DB_PATH:path.join(root,'unused-singleton.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const originalFetch=globalThis.fetch;let deniedNetwork=0;
globalThis.fetch=async()=>{deniedNetwork++;throw new Error('RC08_REAL_NETWORK_FORBIDDEN');};
const {invokeThreadedSdkProcess}=await import('../apps/server/src/threaded/backends/sdkProcess.ts');
const {ThreadedAuthorityError}=await import('../apps/server/src/threaded/contracts.ts');
const {ThreadedBudgetError}=await import('../apps/server/src/threaded/budget.ts');
const fixtures=[],checks=[],evidence=[],failures=[],cleanup=[];
const reportArg=process.argv.find(v=>v.startsWith('--report='));
const report=path.resolve(reportArg?.slice(9)??'docs/reports/evidence/threaded-rc08/sdk.json');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,code,timeout=12000){const end=Date.now()+timeout;
  do{if(predicate())return;await delay(25);}while(Date.now()<end);throw new Error(code);}
const hash=value=>createHash('sha256').update(value).digest('hex');
const groupAlive=pid=>execFileSync('ps',['-axo','pgid=,stat='],{encoding:'utf8',timeout:1000})
  .split('\n').some(line=>{const[g,s]=line.trim().split(/\s+/);return Number(g)===pid&&s&&!s.startsWith('Z');});
function reply(body,content,stop='end_turn'){
  const id=`rc08-${randomUUID()}`;
  if(!body.stream)return new Response(JSON.stringify({id,type:'message',role:'assistant',model:body.model,
    content:[content],stop_reason:stop,stop_sequence:null,usage:{input_tokens:20,output_tokens:5}}),{headers:{'content-type':'application/json'}});
  const frames=[{type:'message_start',message:{id,type:'message',role:'assistant',model:body.model,content:[],
    stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}}];
  if(content.type==='tool_use')frames.push({type:'content_block_start',index:0,content_block:{type:'tool_use',id:content.id,name:content.name,input:{}}},
    {type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(content.input)}});
  else frames.push({type:'content_block_start',index:0,content_block:{type:'text',text:''}},
    {type:'content_block_delta',index:0,delta:{type:'text_delta',text:content.text}});
  frames.push({type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:5}},
    {type:'message_stop'});
  return new Response(frames.map(x=>`event: ${x.type}\ndata: ${JSON.stringify(x)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
}
const text=value=>({type:'text',text:value});
function facts(f){return {
  groups:f.db.prepare('SELECT id,deadline,state,record FROM threaded_consultations ORDER BY rowid').all(),
  targets:f.db.prepare('SELECT * FROM threaded_consultation_targets ORDER BY rowid').all(),
  settlements:f.db.prepare('SELECT * FROM threaded_consultation_settlements ORDER BY rowid').all(),
  callbacks:f.db.prepare('SELECT id,source_id,state,message_id,record FROM threaded_collaboration_callbacks ORDER BY rowid').all(),
  invocations:f.db.prepare('SELECT id,agent_id,status,current_attempt_id FROM threaded_invocations ORDER BY rowid').all(),
  attempts:f.db.prepare('SELECT id,invocation_id,status,execution_stage,execution_reason,outcome_record FROM threaded_attempts ORDER BY rowid').all(),
  requests:f.db.prepare('SELECT id,binding_id,authorization_id,backend,state,delivered,created_at,settled_at FROM threaded_backend_requests ORDER BY rowid').all(),
  processes:f.db.prepare('SELECT token,binding_id,pid,host,state FROM threaded_backend_processes ORDER BY rowid').all(),
  outputs:f.db.prepare('SELECT invocation_id,content FROM threaded_outputs ORDER BY rowid').all(),
  receipts:f.db.prepare('SELECT name,binding_id,record FROM threaded_tool_receipts ORDER BY rowid').all(),
  anchors:f.db.prepare('SELECT id,binding_id FROM threaded_session_anchors ORDER BY rowid').all()};}
async function make(name,mode='normal'){
  let f,clockOffset=0;const calls=[],nativeRecords=[];let activeClaim,terminalHeld;
  f=await openBackendRuntimeFixture(root,name,{applicationTools:['multi_mention'],model:'claude-sonnet-4-5-20250929',
    instructions:'Synthetic protocol acceptance. Follow only the provided synthetic tool sequence.',now:()=>Date.now()+clockOffset,
    connection:{baseUrl:'https://rc08-sdk.invalid',headers:{},timeoutMs:60000},
    sdkProcess:async input=>{
      await invokeThreadedSdkProcess({...input,onRecord(record){
        if(record.type==='result'){
          nativeRecords.push({type:record.type,subtype:record.subtype,isError:record.is_error===true,nativeId:record.session_id});
          if(['budget-cancel','safe-failure','budget-failure','opaque-failure','forged-code'].includes(mode)){terminalHeld=record;return;}
        }input.onRecord(record);
      }});
      if(mode==='budget-cancel'){
        assert.ok(terminalHeld);assert.ok(activeClaim);
        f.db.prepare('UPDATE threaded_budget_attempts SET activity_valid_until=? WHERE attempt_id=?').run(Date.now()-1,activeClaim.binding.attemptId);
        await until(()=>input.signal.aborted,'RC08_BUDGET_ABORT_NOT_OBSERVED');
        nativeRecords.push({injectedBoundary:'after actual native result and stopped process, before adapter terminal',
          signalCode:input.signal.reason?.code??null});
        throw new Error('RC08_CONTROLLED_POST_RESULT_ABORT');
      }
      if(mode==='safe-failure')throw new ThreadedAuthorityError('THREADED_SDK_CHECKPOINT_INVALID');
      if(mode==='budget-failure')throw new ThreadedBudgetError('THREADED_BUDGET_EXCEEDED');
      if(mode==='opaque-failure')throw new Error('RC08_SECRET_SENTINEL sdk stderr private opaque diagnostic');
      if(mode==='forged-code')throw Object.assign(new Error('THREADED_SECRET_SENTINEL'),{code:'THREADED_SECRET_SENTINEL'});
    },fetch:async(url,init)=>{
      assert.equal(new URL(url).origin,'https://rc08-sdk.invalid');assert.equal(init.method,'POST');
      const body=JSON.parse(init.body),digest=hash(init.body);
      const rows=f.db.prepare("SELECT r.id,r.binding_id,r.authorization_id,i.agent_id FROM threaded_backend_requests r JOIN threaded_execution_bindings b ON b.id=r.binding_id JOIN threaded_invocations i ON i.id=b.invocation_id WHERE r.state='sending' AND r.request_hash=?").all(digest);
      assert.equal(rows.length,1);const row=rows[0];calls.push({...row,at:new Date().toISOString(),requestHash:digest});
      if(new URL(url).pathname.endsWith('/count_tokens'))return new Response('{"input_tokens":20}',{headers:{'content-type':'application/json'}});
      const returned=id=>body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'&&c.tool_use_id===id));
      const source=f.db.prepare('SELECT m.origin FROM threaded_execution_bindings b JOIN threaded_invocation_wakes w ON w.invocation_id=b.invocation_id JOIN threaded_messages m ON m.id=w.source_message_id WHERE b.id=?').get(row.binding_id);
      if(row.agent_id==='api-member'&&source.origin==='user'&&!returned('rc08-consult'))return reply(body,{type:'tool_use',id:'rc08-consult',name:'multi_mention',input:{
        idempotencyKey:'rc08-group',targets:['sdk-member','other-member'],callbackTo:'api-member',timeoutMinutes:3,
        question:'Give independent synthetic answers',overrideReason:'New isolated question'}},'tool_use');
      if(row.agent_id==='sdk-member'){
        if(mode==='provider-failure')return new Response(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Synthetic rejected request'}}),{status:400,headers:{'content-type':'application/json'}});
        if(mode==='normal'&&!returned('rc08-cascade'))return reply(body,{type:'tool_use',id:'rc08-cascade',name:'mcp__threaded__multi_mention',input:{
          idempotencyKey:'forbidden-cascade',targets:['api-member'],callbackTo:'sdk-member',question:'Forbidden cascade',overrideReason:'Synthetic denial check'}},'tool_use');
        if(mode==='normal')assert.ok(JSON.stringify(body.messages).includes('THREADED_CONSULTATION_CASCADE_DENIED'));
        return reply(body,text('SDK_ORIGINAL_DISSENT'));
      }
      return reply(body,text(row.agent_id==='other-member'?'API_ORIGINAL_DISSENT':source.origin==='system'?'CALLBACK_COMPLETE':'CALLER_REGISTERED'));
    }});fixtures.push(f);for(const cfg of f.configurations.values())cfg.maxRequests=6;
  return Object.assign(f,{calls,nativeRecords,setActive(claim){activeClaim=claim;},advance(ms){clockOffset+=ms;}});
}
async function start(f){const receipt=f.user('Register an independent consultation',['api-member']);
  const budget=f.runtime.budget.ensureRootForMessage(receipt.message.id);
  f.runtime.reviseRoot({ownerId:f.thread.ownerId,rootId:budget.id,expectedVersion:budget.version,requestId:randomUUID(),
    reason:'RC08 actual SDK isolated acceptance; synthetic faults separately declared',patch:{activityAllowanceMs:10000}});
  f.runtime.queue.enqueueWake(receipt.wakes[0].id);const claim=f.runtime.queue.claimNext('rc08-caller');assert.ok(claim);
  assert.equal((await f.runtime.executeClaim(claim)).status,'completed');
  return f.db.prepare('SELECT id,deadline FROM threaded_consultations').get();}
async function next(f,member){const claim=f.runtime.queue.claimNext(`rc08-${member}`);assert.ok(claim);assert.equal(claim.binding.agentId,member);
  f.setActive(claim);const result=await f.runtime.executeClaim(claim);return{claim,result};}
function settled(f,kind){const rows=f.db.prepare('SELECT record FROM threaded_consultation_settlements').all();assert.equal(rows.length,1);
  const value=JSON.parse(rows[0].record);assert.equal(value.kind,kind);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks').get().n,1);
  return value;}
async function callback(f){const x=await next(f,'api-member');assert.equal(x.result.status,'completed');
  assert.equal(f.runtime.queue.claimNext('no-extra-callback'),null);return x;}
function save(f,id,details={}){assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  const all=facts(f);assert.ok(all.processes.length>0);assert.ok(all.processes.every(p=>p.state==='verified_stopped'));
  evidence.push({id,...details,facts:all,calls:f.calls,nativeRecords:f.nativeRecords});}
async function group(id,action){try{await action();checks.push(id);console.log(`${id} passed`);}catch(error){
  failures.push({id,message:String(error.message).slice(0,1800),stack:String(error.stack).split('\n').slice(0,4)});throw error;}}
try{
  await group('SDK01',async()=>{
    const f=await make('rc08-sdk-cascade');await start(f);const peer=await next(f,'sdk-member');assert.equal(peer.result.status,'completed');
    assert.equal((await next(f,'other-member')).result.status,'completed');const s=settled(f,'complete');
    assert.deepEqual(new Set(s.responses.map(r=>r.body)),new Set(['SDK_ORIGINAL_DISSENT','API_ORIGINAL_DISSENT']));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_consultations').get().n,1);await callback(f);
    save(f,'SDK01',{description:'Actual SDK MCP receives cascade denial and returns its original dissent; two original responses, one settlement/callback, same root, no aggregation model.',settlement:s});
  });
  await group('SDK02',async()=>{
    const f=await make('rc08-sdk-provider-failure','provider-failure');await start(f);const peer=await next(f,'sdk-member');assert.equal(peer.result.status,'failed');
    assert.equal((await next(f,'other-member')).result.status,'completed');const s=settled(f,'partial');
    assert.equal(s.responses.find(r=>r.agentId==='sdk-member').status,'failed');assert.equal(s.responses.find(r=>r.agentId==='other-member').body,'API_ORIGINAL_DISSENT');
    await callback(f);save(f,'SDK02',{description:'Actual SDK receives a synthetic terminal HTTP 400; failed member retained alongside independent API answer and one partial callback.',settlement:s});
  });
  await group('SDK03',async()=>{
    const f=await make('rc08-sdk-budget-cancel','budget-cancel');await start(f);const peer=await next(f,'sdk-member');assert.equal(peer.result.status,'cancelled');
    const a=f.db.prepare('SELECT execution_reason FROM threaded_attempts WHERE id=?').get(peer.claim.binding.attemptId);
    assert.equal(a.execution_reason,'THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED');
    assert.equal((await next(f,'other-member')).result.status,'completed');const s=settled(f,'partial');
    assert.equal(s.responses.find(r=>r.agentId==='sdk-member').status,'cancelled');await callback(f);
    save(f,'SDK03',{description:'Explicit post-result allowance expiry causes runner signal cancellation after the actual SDK has stopped; exact code persists with complete request, no fabricated SDK answer.',settlement:s,
      historicalT08CauseProven:false,controlledFault:'Expired persisted activity allowance after actual SDK result; not natural event-loop expiry'});
  });
  await group('SDK04',async()=>{
    for(const mode of ['safe-failure','budget-failure','opaque-failure','forged-code']){
      const f=await make(`rc08-sdk-${mode}`,mode);await start(f);const peer=await next(f,'sdk-member');assert.equal(peer.result.status,'failed');
      const a=f.db.prepare('SELECT execution_reason FROM threaded_attempts WHERE id=?').get(peer.claim.binding.attemptId);
      assert.equal(a.execution_reason,mode==='safe-failure'?'THREADED_SDK_CHECKPOINT_INVALID':mode==='budget-failure'?'THREADED_BUDGET_EXCEEDED':'THREADED_SDK_FAILED');
      assert.equal((await next(f,'other-member')).result.status,'completed');settled(f,'partial');await callback(f);
      save(f,`SDK04-${mode}`,{description:'Actual SDK completes before explicit adapter error injection; safe platform code persists and opaque native exception is reduced to generic failure.'});
    }
    assert.ok(!JSON.stringify(evidence).includes('RC08_SECRET_SENTINEL'));
    assert.ok(!JSON.stringify(evidence).includes('THREADED_SECRET_SENTINEL'));
  });
  await group('SDK05',async()=>{
    const f=await make('rc08-sdk-timeout');const original=await start(f);assert.equal((await next(f,'sdk-member')).result.status,'completed');
    const before=f.calls.length;f.reopen();f.advance(180001);f.runtime.recover();
    assert.equal(f.calls.length,before);const s=settled(f,'partial');assert.equal(s.responses.find(r=>r.agentId==='sdk-member').body,'SDK_ORIGINAL_DISSENT');
    assert.equal(s.responses.find(r=>r.agentId==='other-member').status,'timeout');
    assert.equal(f.db.prepare('SELECT deadline FROM threaded_consultations').get().deadline,original.deadline);
    const frozen=f.db.prepare('SELECT record FROM threaded_consultation_settlements').get().record;
    f.runtime.recover();assert.equal(f.db.prepare('SELECT record FROM threaded_consultation_settlements').get().record,frozen);
    await callback(f);save(f,'SDK05',{description:'Actual SDK original answer survives factory/SQLite rebuild; controlled clock passes original deadline, one partial timeout/callback and no model replay.',settlement:s,
      restartScope:'Runtime factories and SQLite rebuilt in this process; not an index-process crash.'});
  });
  assert.equal(deniedNetwork,0);
}catch{process.exitCode=1;}
finally{
  for(const f of fixtures){try{
    await f.runtime.shutdown(5000);
    for(const p of f.db.prepare('SELECT token,host,pid FROM threaded_backend_processes').all()){
      if(groupAlive(p.pid)){assert.equal(p.host,hostname());const command=execFileSync('ps',['-p',String(p.pid),'-o','command='],{encoding:'utf8'});
        assert.ok(command.includes('/execution/guardian.mjs')&&command.includes(p.token));
        try{process.kill(-p.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
        await delay(600);if(groupAlive(p.pid))process.kill(-p.pid,'SIGKILL');}
      await until(()=>!groupAlive(p.pid),'RC08_SDK_GROUP_STILL_ALIVE',5000);cleanup.push({pid:p.pid,stopped:true});}
    }catch(error){failures.push({id:'cleanup',message:error.message});process.exitCode=1;}f.close();}
  const result={ok:failures.length===0,stage:'RC08',date:new Date().toISOString(),groups:checks.length,checks,evidence,failures,cleanup,
    actualSdkVersion:'0.3.288',actualGuardianAndSdkCli:true,injectedSupplierRequests:fixtures.reduce((sum,f)=>sum+f.calls.length,0),
    realSupplierCalls:0,realModelTokens:0,credentialsRead:false,dailyDatabaseRead:false,actualIndexEntry:false,isolatedWorkerBypass:true,
    targetActivityAllowanceMs:10000,productionDefaultActivityAllowanceMs:1000,deniedRealNetwork:deniedNetwork,
    limitations:['Actual native SDK/guardian/MCP with injected provider responses; no configured credentials or supplier calls.',
      'Allowance expiry and adapter failures are explicit test injections, not proof of the unresolved historical T08 cause.',
      'Timeout uses a controlled clock after factory/SQLite reconstruction; actual index-process recovery is a separate acceptance layer.']};
  await mkdir(path.dirname(report),{recursive:true});await writeFile(report,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({ok:result.ok,groups:checks.length,failures,actualGuardianPids:cleanup.length,report}));
}
