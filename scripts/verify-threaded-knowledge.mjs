import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

if(process.argv[2]==='--worker') {
  const [file,clock]=process.argv.slice(3);
  Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(path.dirname(file),`unused-knowledge-${process.pid}.sqlite`),AGENTS_DIR:path.join(path.dirname(file),'agents')});
  const db=new Database(file,{fileMustExist:true,timeout:10000});db.pragma('foreign_keys=ON');
  const {createExecutionResourceCoordinator}=await import('../apps/server/src/execution/resources/coordinator.ts');
  const {createThreadedBackendRuntime}=await import('../apps/server/src/threaded/backendRuntime.ts');
  const {createThreadedKnowledge}=await import('../apps/server/src/threaded/knowledge.ts');
  const resources=createExecutionResourceCoordinator(db,{ownerNonce:`knowledge-worker:${process.pid}`,now:()=>Number(clock)});
  const runtime=createThreadedBackendRuntime(db,{resources,resolveAgent(){throw new Error('No model in CAS worker');},fetch:async()=>{throw new Error('No model');},
    now:()=>Number(clock),dispatchEnabled:false,autoStart:false,repairIntervalMs:0});
  const knowledge=createThreadedKnowledge(db,{authority:runtime.authority,messages:runtime.messages,cooperation:runtime.collaboration.cooperation,now:()=>Number(clock)});
  process.send?.({type:'ready'});
  process.once('message',async value=>{
    try {const result=runtime.collaboration.cooperation.transaction(()=>knowledge.executeWithin(value.binding,value.name,value.input));
      process.send?.({type:value.crash?'committed':'result',result});
      if(value.crash)await new Promise(()=>{process.once('message',()=>{});});
    } catch(error) {process.send?.({type:'result',error:{code:error.code,message:error.message}});}
    finally {runtime.close();db.close();process.disconnect();}
  });
} else {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-knowledge-')));
  Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
  const {THREADED_APPLICATION_TOOL_NAMES}=await import('../apps/server/src/threaded/tools.ts');
  const {THREADED_KNOWLEDGE_TOOLS,createThreadedKnowledge}=await import('../apps/server/src/threaded/knowledge.ts');
  const {applyThreadedKnowledgeSchema}=await import('../apps/server/src/db/threadedKnowledgeSchema.ts');
  const {createThreadedStore}=await import('../apps/server/src/threaded/store.ts');
  const fixtures=[],checks=[],faults=[];let injectedModelCalls=0;
  const applicationTools=[...new Set([...THREADED_APPLICATION_TOOL_NAMES,...THREADED_KNOWLEDGE_TOOLS.map(t=>t.name)])];
  function service(f){return createThreadedKnowledge(f.db,{authority:f.runtime.authority,messages:f.runtime.messages,cooperation:f.runtime.collaboration.cooperation,now:f.clock});}
  async function fixture(name){let f,clock=Date.now();f=await openBackendRuntimeFixture(root,name,{now:()=>clock,applicationTools,
    fetch:async()=>{injectedModelCalls++;try {const body=await(f.handler?.(f.claim)??'done');return new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:3}}),{headers:{'content-type':'application/json'}});}catch(error){f.handlerError=error;throw error;}}});
    f.clock=()=>clock;f.advance=ms=>clock+=ms;for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
    // Independent module tests work both before and after aggregate v33 wiring.
    f.db.transaction(()=>applyThreadedKnowledgeSchema(f.db)).immediate();fixtures.push(f);return f;}
  async function run(f,receipt,handler,expectedStatus='completed'){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
    const claim=f.runtime.queue.claimNext('knowledge-test');assert.ok(claim);f.claim=claim;f.handler=handler;
    const result=await f.runtime.executeClaim(claim);f.handler=undefined;if(f.handlerError)throw f.handlerError;
    assert.equal(result.status,expectedStatus,JSON.stringify({result,attempt:f.db.prepare('SELECT execution_reason FROM threaded_attempts WHERE id=?').get(claim.binding.attemptId)}));return claim;}
  const call=(f,c,name,input)=>f.runtime.collaboration.cooperation.transaction(()=>service(f).executeWithin(c.binding,name,input));
  const tool=async(f,c,name,input,key=randomUUID())=>JSON.parse(await f.runtime.collaboration.tools.execute(c.binding,name,input,key,applicationTools));
  const publish=(messageId,extra={})=>({idempotencyKey:randomUUID(),title:'Knowledge title',body:'Literal knowledge summary',anchors:[{kind:'message',id:messageId}],...extra});
  async function race(f,binding,operations){const workers=operations.map(()=>{
    const child=fork(new URL(import.meta.url),['--worker',f.file,String(f.clock())],{execArgv:['--import',new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname],stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);const exited=new Promise(resolve=>child.once('exit',resolve));
    const ready=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    const result=new Promise((resolve,reject)=>{child.on('message',m=>{if(m.type==='committed'){child.kill('SIGKILL');resolve(m);}else if(m.type==='result')resolve(m);});child.once('error',reject);child.once('exit',code=>{if(code)reject(new Error(stderr));});});
    return {child,ready,result,exited};});
    await Promise.all(workers.map(w=>w.ready));workers.forEach((w,i)=>w.child.send({binding,...operations[i]}));
    const answers=await Promise.all(workers.map(w=>w.result));await Promise.all(workers.map(w=>w.exited));return answers;}
  try {
    {
      const f=await fixture('immutable-anchor');assert.throws(()=>applyThreadedKnowledgeSchema(f.db),/THREADED_MIGRATION_REQUIRES_TRANSACTION/);let version;
      const receipt=f.user('Authoritative source alpha');
      await run(f,receipt,async c=>{
        const sources=call(f,c,'knowledge_anchor',{kind:'message',id:receipt.message.id});assert.equal(sources.messages[0].body,'Authoritative source alpha');
        version=call(f,c,'knowledge_publish',publish(receipt.message.id));assert.equal(version.version,1);assert.ok(version.sourceMessageIds.includes(receipt.message.id));
        const search=call(f,c,'knowledge_search',{query:'literal KNOWLEDGE'});assert.equal(search.items.length,1);assert.equal(search.retrieval,'literal_substring');
        assert.equal(call(f,c,'knowledge_sources',{knowledgeId:version.knowledgeId}).sources[0].id,receipt.message.id);
        assert.throws(()=>f.db.prepare("UPDATE threaded_knowledge_versions SET record='{}'").run(),/THREADED_KNOWLEDGE_FACT_IMMUTABLE/);
        assert.throws(()=>f.db.prepare('DELETE FROM threaded_knowledge').run(),/THREADED_KNOWLEDGE_FACT_RETAINED/);
        assert.throws(()=>service(f).executeWithin(c.binding,'knowledge_read',{knowledgeId:version.knowledgeId}),/THREADED_KNOWLEDGE_TRANSACTION_REQUIRED/);
        return 'Published platform response';});
      f.reopen();
      await run(f,f.user('Expand prior Invocation'),async c=>{
        const expanded=call(f,c,'knowledge_anchor',{kind:'invocation',id:f.db.prepare('SELECT source_invocation_id id FROM threaded_messages WHERE origin=? ORDER BY seq LIMIT 1').get('agent_response').id});
        assert.equal(expanded.messages.length,1);assert.equal(expanded.messages[0].body,'Published platform response');
        for(const forbidden of ['sessionId','nativeId','transcript','cursor','backendEvents'])assert.equal(Object.hasOwn(expanded,forbidden),false);
        assert.equal(call(f,c,'knowledge_read',{knowledgeId:version.knowledgeId,version:1}).body,'Literal knowledge summary');
        return 'Restored';});
      checks.push('MEM01 basics: exact message/Invocation anchors expand only authorized published platform messages, immutable versions and provenance survive SQLite/runtime rebuild; retrieval explicitly reports literal_substring, not semantics');
    }
    {
      const f=await fixture('scope-and-private');let item,cursor;
      const privateSource=f.user('PRIVATE_SOURCE_KNOWLEDGE',['api-member'],{visibility:'private',audience:['api-member']});
      await run(f,privateSource,async c=>{item=call(f,c,'knowledge_publish',publish(privateSource.message.id,{body:'PRIVATE_SUMMARY_KNOWLEDGE'}));
        assert.ok(service(f).privacySources(c.binding,'knowledge_publish',{},item).includes(privateSource.message.id));
        for(const bad of [{collection:'private:other'},{ownerId:'other'},{threadId:'other'},{actorId:'other'},{cursor:'other'}])
          assert.throws(()=>call(f,c,'knowledge_search',{query:'summary',...bad}),/THREADED_KNOWLEDGE_SCOPE_FORBIDDEN/);
        const more=f.user('second message');assert.throws(()=>call(f,c,'knowledge_anchor',{kind:'message',id:more.message.id}),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        return 'Private result';});
      await run(f,undefined,async c=>{cursor=call(f,c,'knowledge_recent',{limit:1}).nextCursor;assert.ok(cursor);return 'page';});
      await run(f,f.user('Other reader',['other-member']),async c=>{
        assert.equal(call(f,c,'knowledge_search',{query:'PRIVATE'}).items.length,0);
        assert.throws(()=>call(f,c,'knowledge_read',{knowledgeId:item.knowledgeId}),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        assert.throws(()=>call(f,c,'knowledge_sources',{knowledgeId:item.knowledgeId}),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        assert.throws(()=>call(f,c,'knowledge_recent',{cursor}),/THREADED_KNOWLEDGE_CURSOR_FORBIDDEN/);
        assert.throws(()=>call(f,c,'knowledge_anchor',{kind:'message',id:privateSource.message.id}),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        return 'No private knowledge';});
      checks.push('MEM02/K09: fixed server-owned home collection, arbitrary collection/owner/thread/actor fields and future messages rejected; private knowledge, source bodies and another actor cursor cannot self-authorize');
    }
    {
      const f=await fixture('source-revocation'),store=createThreadedStore(f.db);let item;
      const other=store.createThread({title:'source Thread',members:['api-member','sdk-member','other-member'].map(agentId=>({agentId,handle:agentId,roleVersion:1,permissionVersion:1}))});
      f.db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(other.id);
      const source=f.runtime.messages.acceptUserMessage({ownerId:other.ownerId,threadId:other.id,clientRequestId:randomUUID(),body:'Cross Thread authoritative public source',targets:[]});
      const receipt=f.user('Home derived source',['api-member'],{sourceRefs:[source.message.id]});
      await run(f,receipt,async c=>{
        item=call(f,c,'knowledge_publish',publish(receipt.message.id,{body:'DERIVED_REVOKABLE_KNOWLEDGE'}));
        assert.ok(item.sourceMessageIds.includes(source.message.id));assert.ok(item.sourceMessageIds.includes(receipt.message.id));
        const readInput={knowledgeId:item.knowledgeId},before=await tool(f,c,'knowledge_read',readInput,'reusable-read');assert.equal(before.ok,true);
        const saved=JSON.parse(f.db.prepare("SELECT record FROM threaded_tool_receipts WHERE binding_id=? AND request_key='reusable-read'").get(c.binding.id).record);
        assert.ok(saved.privacySourceIds.includes(source.message.id));
        f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(other.id);
        // The running home Binding remains legitimate; only provenance authority changed.
        f.runtime.authority.assertAuthorized(c.binding);
        assert.throws(()=>call(f,c,'knowledge_read',{knowledgeId:item.knowledgeId}),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        assert.throws(()=>call(f,c,'knowledge_sources',{knowledgeId:item.knowledgeId}),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        assert.throws(()=>call(f,c,'knowledge_publish',publish(receipt.message.id,{idempotencyKey:'fresh-after-revoke'})),/THREADED_COLLABORATION_SOURCE_FORBIDDEN|THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        assert.equal(call(f,c,'knowledge_search',{query:'DERIVED_REVOKABLE'}).items.length,0);
        assert.throws(()=>service(f).privacySources(c.binding,'knowledge_read',{},item),/THREADED_KNOWLEDGE_SOURCE_FORBIDDEN/);
        const cached=await tool(f,c,'knowledge_read',readInput,'reusable-read');assert.equal(cached.ok,false);assert.equal(cached.status,403);
        return 'Source permission drift does not reveal a summary';},'failed');
      checks.push('MEM02/CTX02: recursive cross-Thread source membership revocation hides derived read/search/expansion with the current home Binding still authorized, and privacySources rejects cached result reuse');
    }
    {
      const f=await fixture('versions-expiry');let original,replacement;
      const receipt=f.user('Versioned knowledge');
      await run(f,receipt,async c=>{
        const input=publish(receipt.message.id,{idempotencyKey:'first',expiresAt:f.clock()+1000});original=call(f,c,'knowledge_publish',input);
        assert.deepEqual(call(f,c,'knowledge_publish',input),original);
        assert.throws(()=>call(f,c,'knowledge_publish',{...input,body:'conflict'}),/THREADED_KNOWLEDGE_IDEMPOTENCY_CONFLICT/);
        return 'First version';});
      f.advance(1001);
      await run(f,f.user('Expired version and replacement'),async c=>{
        assert.equal(call(f,c,'knowledge_read',{knowledgeId:original.knowledgeId}).status,'expired');
        const v2=call(f,c,'knowledge_publish',publish(receipt.message.id,{knowledgeId:original.knowledgeId,expectedVersion:1,body:'New immutable content'}));assert.equal(v2.version,2);
        replacement=call(f,c,'knowledge_publish',publish(receipt.message.id,{body:'Replacement content'}));
        const v3=call(f,c,'knowledge_mark',{idempotencyKey:'supersede',knowledgeId:original.knowledgeId,expectedVersion:2,status:'superseded',replacementId:replacement.knowledgeId,reason:'New authority reference'});
        assert.equal(v3.version,3);assert.equal(v3.replacementId,replacement.knowledgeId);
        const history=call(f,c,'knowledge_read',{knowledgeId:original.knowledgeId,version:1});assert.equal(history.body,'Literal knowledge summary');assert.equal(history.currentStatus,'superseded');assert.equal(history.currentReplacementId,replacement.knowledgeId);
        assert.throws(()=>call(f,c,'knowledge_mark',{idempotencyKey:'stale',knowledgeId:original.knowledgeId,expectedVersion:2,status:'expired',reason:'old version'}),/THREADED_KNOWLEDGE_VERSION_CONFLICT/);
        assert.throws(()=>call(f,c,'knowledge_mark',{idempotencyKey:'cycle',knowledgeId:replacement.knowledgeId,expectedVersion:1,status:'superseded',replacementId:original.knowledgeId,reason:'cycle'}),/THREADED_KNOWLEDGE_REPLACEMENT_INVALID/);
        return 'Version history retained';});
      checks.push('MEM01 basics: natural expiry, explicit supersession, current replacement metadata and immutable historical content remain distinct; mutation idempotency, expectedVersion CAS and replacement validity enforced');
    }
    {
      const f=await fixture('cursor-drift');let cursor;
      for(let i=0;i<4;i++)f.user(`Source ${i}`,[]);
      await run(f,f.user('Recent query'),async c=>{
        const first=call(f,c,'knowledge_recent',{limit:2});cursor=first.nextCursor;assert.ok(cursor);const second=call(f,c,'knowledge_recent',{limit:2,cursor});
        assert.ok(first.events.every(x=>!second.events.some(y=>y.message.id===x.message.id)));assert.ok(first.sourceMessageIds.length);
        return 'cursor page';});
      f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
      await run(f,f.user('Fresh Binding with changed permissions'),async c=>{assert.throws(()=>call(f,c,'knowledge_recent',{cursor}),/THREADED_KNOWLEDGE_CURSOR_FORBIDDEN/);return 'Cursor authority drift rejected';});
      checks.push('MEM02: server-issued cursor pages are frozen, disjoint and bound to owner, home Thread, actor, authority fingerprint and expiry; a fresh legitimate Binding cannot reuse a cursor from before permission drift');
    }
    {
      const f=await fixture('cas-and-recovery');let item;
      const receipt=f.user('CAS authoritative source');
      await run(f,receipt,async c=>{
        item=call(f,c,'knowledge_publish',publish(receipt.message.id));
        const operations=[0,1].map(n=>({name:'knowledge_publish',input:publish(receipt.message.id,{knowledgeId:item.knowledgeId,expectedVersion:1,body:`Contender ${n}`})}));
        const results=await race(f,c.binding,operations);assert.equal(results.filter(r=>r.result).length,1);assert.equal(results.filter(r=>r.error?.code==='THREADED_KNOWLEDGE_VERSION_CONFLICT').length,1);
        assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_knowledge_versions').get().n,2);
        const crashInput=publish(receipt.message.id,{idempotencyKey:'committed-before-crash',knowledgeId:item.knowledgeId,expectedVersion:2,body:'Committed before SIGKILL'});
        const [crashed]=await race(f,c.binding,[{name:'knowledge_publish',input:crashInput,crash:true}]);assert.equal(crashed.result.version,3);
        assert.equal(call(f,c,'knowledge_publish',crashInput).version,3);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_knowledge_versions').get().n,3);
        return 'One CAS winner, no duplicate after producer death';});
      f.reopen();
      await run(f,f.user('Recover knowledge'),async c=>{assert.equal(call(f,c,'knowledge_read',{knowledgeId:item.knowledgeId}).body,'Committed before SIGKILL');return 'Recovered';});
      checks.push('DB01/REC01: two real IPC worker processes with independent SQLite connections compete at one barrier, exactly one expectedVersion update wins; producer SIGKILL after commit and a retry preserve one immutable version; runtime/SQLite rebuild reads durable result');
    }
    {
      const f=await fixture('rollback'),receipt=f.user('Atomic knowledge');
      await run(f,receipt,async c=>{
        const snapshot=()=>['threaded_knowledge','threaded_knowledge_versions','threaded_knowledge_events','threaded_knowledge_operations'].map(t=>[t,f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]);
        for(const table of ['threaded_knowledge_versions','threaded_knowledge_events','threaded_knowledge_operations']) {
          const before=snapshot();f.db.exec(`CREATE TRIGGER knowledge_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'knowledge_fault'); END;`);
          assert.throws(()=>call(f,c,'knowledge_publish',publish(receipt.message.id)),/knowledge_fault/);assert.deepEqual(snapshot(),before);f.db.exec('DROP TRIGGER knowledge_fault');faults.push({table,rolledBack:true});}
        const result=call(f,c,'knowledge_publish',publish(receipt.message.id));assert.equal(result.version,1);return 'Atomic versions';});
      checks.push('DB01: injected faults at version/event/idempotency writes roll back the whole item/version/event receipt transaction; a successful retry commits one complete version');
    }
    {
      const f=await fixture('tool-provenance'),receipt=f.user('Private knowledge context',['api-member'],{visibility:'private',audience:['api-member']});
      await run(f,receipt,async c=>{
        const created=await tool(f,c,'knowledge_publish',publish(receipt.message.id,{idempotencyKey:'tool-publish',body:'PRIVATE_TOOL_DERIVED_KNOWLEDGE'}));assert.equal(created.ok,true);
        const id=created.result.knowledgeId;
        for(const [name,input] of [['knowledge_read',{knowledgeId:id}],['knowledge_search',{query:'PRIVATE_TOOL'}],['knowledge_sources',{knowledgeId:id}],['knowledge_anchor',{kind:'message',id:receipt.message.id}],['knowledge_recent',{limit:3}],['knowledge_mark',{idempotencyKey:'knowledge_mark',knowledgeId:id,expectedVersion:1,status:'expired',reason:'Author reported obsolete knowledge'}]]) {
          const answer=await tool(f,c,name,input,name);assert.equal(answer.ok,true,JSON.stringify(answer));
          const saved=JSON.parse(f.db.prepare('SELECT record FROM threaded_tool_receipts WHERE binding_id=? AND request_key=?').get(c.binding.id,name).record);
          assert.ok(saved.privacySourceIds.includes(receipt.message.id),name);
          assert.ok(f.db.prepare('SELECT 1 FROM threaded_tool_context_exposures WHERE binding_id=? AND request_key=? AND message_id=?').get(c.binding.id,name,receipt.message.id),name);
        }
        const widened=await tool(f,c,'post_message',{idempotencyKey:'widen',body:'Cannot widen private-derived knowledge',visibility:'public'});assert.equal(widened.code,'THREADED_TOOL_VISIBILITY_CONFLICT');
        const posted=await tool(f,c,'post_message',{idempotencyKey:'preserved',body:'Derived source privacy preserved'});assert.equal(posted.ok,true);assert.equal(posted.result.message.visibility,'private');assert.deepEqual(posted.result.message.audience,['api-member']);
        const exposure=f.db.prepare('SELECT session_id,session_version FROM threaded_tool_context_exposures WHERE binding_id=? LIMIT 1').get(c.binding.id);
        assert.ok(exposure.session_id);assert.ok(exposure.session_version>=1);return 'Private final remains private';});
      const reply=f.db.prepare("SELECT record FROM threaded_messages WHERE origin='agent_response' ORDER BY seq DESC LIMIT 1").get();assert.equal(JSON.parse(reply.record).visibility,'private');
      checks.push('K09/CTX02 tool composition: all seven tools use the actual application allowlist and authenticated runtime; publish/read/literal search/source expansion/recent/anchor results persist complete privacySourceIds and session-version input exposures; downstream post/final cannot widen private source audience');
    }
    const report={ok:true,groups:checks.length,checks,faults,injectedModelCalls,realModelCalls:0,externalNetworkCalls:0,
      scope:'isolated actual SQLite, runtime, authority, messages and knowledge domain; model transport injected; MEM01 semantic retrieval remains unimplemented; production entry closed'};
    console.log(JSON.stringify(report,null,2));
  } finally {for(const f of fixtures)f.close();await rm(root,{recursive:true,force:true});}
}
