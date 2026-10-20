import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-t08-backends-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const fixtures=[],checks=[],originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No external network transport');};
const message=(content,reason='end_turn')=>new Response(JSON.stringify({id:'fixture-response',type:'message',role:'assistant',model:'fixture-model',content,stop_reason:reason,usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
async function run(f,member){const receipt=f.user('T08 transport fixture',[member]);f.runtime.queue.enqueueWake(receipt.wakes[0].id);
  const claim=f.runtime.queue.claimNext('transport');assert.ok(claim);return {claim,result:await f.runtime.executeClaim(claim)};}
const sse=(content,stopReason)=>{
  const events=[['message_start',{type:'message_start',message:{id:`msg-${Date.now()}`,type:'message',role:'assistant',model:'claude-sonnet-4-5-20250929',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}}]];
  if(content.type==='tool_use')events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:content.id,name:content.name,input:{}}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(content.input)}}]);
  else events.push(['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:content.text}}]);
  events.push(['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:stopReason,stop_sequence:null},usage:{output_tokens:7}}],['message_stop',{type:'message_stop'}]);
  return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
};
try{
  for(const protocol of ['anthropic-messages','openai-chat-completions']){
    let calls=0;
    const f=await openBackendRuntimeFixture(root,protocol,{applicationTools:['post_message'],fetch:async(_url,init)=>{
      calls++;const body=JSON.parse(init.body);assert.equal(body.tools.length,1);
      if(calls===1){const call={id:'post-transport',name:'post_message',input:{idempotencyKey:'transport-post',body:'@other-member protocol post',targets:['other-member']}};
        return protocol==='anthropic-messages'?message([{type:'tool_use',...call}],'tool_use'):new Response(JSON.stringify({id:'openai-1',choices:[{message:{content:null,tool_calls:[{id:call.id,type:'function',function:{name:call.name,arguments:JSON.stringify(call.input)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:20,completion_tokens:7}}),{headers:{'content-type':'application/json'}});}
      assert.ok(JSON.stringify(body.messages).includes('transport-post')||JSON.stringify(body.messages).includes('agent_post'));
      return protocol==='anthropic-messages'?message([{type:'text',text:'@other-member separate final'}]):new Response(JSON.stringify({id:'openai-2',choices:[{message:{content:'@other-member separate final'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:7}}),{headers:{'content-type':'application/json'}});
    }});fixtures.push(f);f.configurations.get('api-member').apiProtocol=protocol;
    const result=await run(f,'api-member');assert.equal(result.result.status,'completed');assert.equal(calls,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_tool_receipts').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_wakes').get().n,3);
    assert.equal(f.runtime.budget.getUsage(result.claim.queue.causalRootId).actualRequests,2);
    checks.push(`M01/M03 ${protocol}: model HTTP tool_use crosses the actual trusted broker, then tool_result is sent in a separately reserved request; explicit post/final retain two successors`);
  }
  {
    let calls=0;
    const f=await openBackendRuntimeFixture(root,'native-sdk-tools',{applicationTools:['post_message'],model:'claude-sonnet-4-5-20250929',
      instructions:'Use the provided post_message tool, then give the final response. This is an isolated protocol fixture.',
      fetch:async(_url,init)=>{
        calls++;const body=JSON.parse(init.body);
        const returned=body.messages?.some(m=>Array.isArray(m.content)&&m.content.some(c=>c.type==='tool_result'&&c.tool_use_id==='sdk-platform-post'));
        return returned?sse({type:'text',text:'SDK tool bridge finished'},'end_turn'):
          sse({type:'tool_use',id:'sdk-platform-post',name:'mcp__threaded__post_message',input:{idempotencyKey:'sdk-post-once',body:'SDK platform post',targets:['other-member']}},'tool_use');
      }});fixtures.push(f);
    const {claim,result}=await run(f,'sdk-member');
    assert.equal(result.status,'completed',JSON.stringify(result));assert.ok(calls>=2&&calls<=4);
    const receipt=f.db.prepare("SELECT record FROM threaded_tool_receipts WHERE name='post_message'").get();assert.ok(receipt);
    assert.equal(JSON.parse(receipt.record).result.message.body,'SDK platform post');
    const processes=f.db.prepare('SELECT state FROM threaded_backend_processes').all();assert.ok(processes.length>0);
    assert.ok(processes.every(p=>p.state==='verified_stopped'));
    assert.equal(f.resources.getClaim(claim.claimId??claim.binding.claimId).state,'released');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_session_anchors').get().n,1);
    checks.push('SDK 0.3.288 actual worker/CLI + in-process MCP + server RPC broker: injected SSE tool_use creates one platform post, actual owned process groups stop and exact native anchor persists; no external model');
  }
  {
    let calls=0,privateId;
    const f=await openBackendRuntimeFixture(root,'native-tool-exposure',{applicationTools:['read_message'],model:'claude-sonnet-4-5-20250929',
      instructions:'Isolated protocol acceptance. Only use the offered exact message tool when requested.',fetch:async(_url,init)=>{
        calls++;const body=JSON.parse(init.body);
        if(calls===1)return sse({type:'tool_use',id:'read-deferred-private',name:'mcp__threaded__read_message',input:{messageId:privateId}},'tool_use');
        if(calls>=3)assert.ok(!JSON.stringify(body).includes('DEFERRED_PRIVATE_TOOL_BODY'));
        return sse({type:'text',text:'private read completed'},'end_turn');
      }});fixtures.push(f);
    const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
    const other=createThreadedStore(f.db).createThread({title:'source ACL',members:[{agentId:'sdk-member',handle:'sdk-member',roleVersion:1,permissionVersion:1}]});
    f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(other.id);
    const source=f.runtime.messages.acceptUserMessage({ownerId:other.ownerId,threadId:other.id,clientRequestId:'foreign-source',body:'PUBLIC_SOURCE'});
    const secret=f.user('DEFERRED_PRIVATE_TOOL_BODY',['sdk-member'],{visibility:'private',audience:['sdk-member'],sourceRefs:[source.message.id],
      attachments:[{name:'large.bin',mediaType:'application/octet-stream',contentBase64:Buffer.alloc(200000,1).toString('base64')}]});
    privateId=secret.message.id;
    // Fixture retires the oversized authored wake; this test targets a later explicit read, not execution of that source.
    f.db.prepare("UPDATE threaded_wakes SET status='cancelled',version=version+1 WHERE source_message_id=?").run(privateId);
    const first=await run(f,'sdk-member');assert.equal(first.result.status,'completed');
    assert.equal(f.db.prepare('SELECT i.decision FROM threaded_context_manifest_items i JOIN threaded_context_manifests m ON m.id=i.manifest_id WHERE m.binding_id=? AND i.message_id=?').get(first.claim.binding.id,privateId).decision,'deferred_budget');
    const anchor=JSON.parse(f.db.prepare('SELECT record FROM threaded_session_anchors WHERE binding_id=?').get(first.claim.binding.id).record);
    assert.ok(anchor.sourceMessageIds.includes(privateId));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_tool_context_exposures WHERE message_id=?').get(privateId).n,1);
    f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='sdk-member'").run(other.id);
    const second=await run(f,'sdk-member');assert.equal(second.result.status,'completed');
    const prep=JSON.parse(f.db.prepare('SELECT preparation FROM threaded_wake_queue WHERE id=?').get(second.claim.queue.id).preparation);
    assert.equal(prep.threadedContext.decision.mode,'cold');assert.notEqual(prep.threadedContext.decision.session.nativeId,anchor.session.nativeId);
    checks.push('Native tool-read provenance: a private message deferred only because of its large attachment enters the actual SDK through read_message, is recorded in the anchor, and recursive source revocation forces a new cold native identity with no secret replay');
  }
  for(const f of fixtures)assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
  console.log(JSON.stringify({ok:true,groups:checks.length,checks,realModelCalls:0,externalNetworkCalls:0,scope:'Injected provider responses; actual SDK worker/CLI and loopback MCP transport, actual host process-exit proof'},null,2));
}finally{globalThis.fetch=originalFetch;for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
