import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc03-waits-')));
Object.assign(process.env,{AGENT_GAND_ISOLATED_WORKER:'1',NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused.sqlite'),AGENTS_DIR:path.join(root,'agents')});
const {THREADED_APPLICATION_TOOL_NAMES,THREADED_TOOLS}=await import('../apps/server/src/threaded/tools.ts');
const {parseThreadedWaitSource,classifyThreadedTimerRecovery}=await import('../apps/server/src/threaded/waitContracts.ts');
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('RC03 waits forbid external network');};
const fixtures=[],checks=[];let injectedRequests=0;
const response=body=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text:body}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:7}}),{headers:{'content-type':'application/json'}});
async function fixture(name,extra={}){let f,clock=Date.now();
  f=await openBackendRuntimeFixture(root,name,{now:()=>clock,applicationTools:THREADED_APPLICATION_TOOL_NAMES,...extra,fetch:async()=>{
    injectedRequests++;try{return response(await(f.handler?.(f.activeClaim)??'ordinary final'));}catch(error){f.handlerError=error;throw error;}}});
  f.clock=()=>clock;f.advance=ms=>clock+=ms;
  for(const cfg of f.configurations.values()){cfg.kind='api';cfg.backendVersion='threaded-http-v1';}
  fixtures.push(f);return f;
}
async function run(f,receipt,handler){if(receipt)for(const w of receipt.wakes)f.runtime.queue.enqueueWake(w.id);
  const claim=f.runtime.queue.claimNext('rc03-wait-contract');assert.ok(claim,'claim expected');f.activeClaim=claim;f.handler=handler;
  const result=await f.runtime.executeClaim(claim);f.handler=undefined;if(f.handlerError)throw f.handlerError;assert.equal(result.status,'completed',JSON.stringify(result));return claim;}
const tool=async(f,claim,name,input)=>JSON.parse(await f.runtime.collaboration.tools.execute(claim.binding,name,input,randomUUID(),THREADED_APPLICATION_TOOL_NAMES));
const ok=value=>{assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
const source=(f,claim,extra={})=>({kind:'thread_message',value:f.runtime.collaboration.cooperation.source(claim.binding).id,expectedSignal:'business_check_completed',slaUntilMs:f.clock()+60_000,...extra});
const hold=(f,claim,key='timer',extra={})=>({idempotencyKey:key,jobKey:key,seconds:5,waitSourceRef:source(f,claim),...extra});
const row=(f,id)=>f.db.prepare('SELECT * FROM threaded_waits WHERE id=?').get(id);
const outcome=(f,id)=>JSON.parse(row(f,id).outcome);
const callback=(f,id)=>f.db.prepare('SELECT * FROM threaded_collaboration_callbacks WHERE source_id=?').get(id);
const count=(f,table)=>f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const pause=f=>f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action:'pause',requestId:randomUUID()});

try{
  {
    const ref={kind:'thread_message',value:'message-id',expectedSignal:'build_finished',slaUntilMs:10000};
    assert.deepEqual(parseThreadedWaitSource(ref),ref);
    for(const kind of ['github_issue','github_comment','task','managed_command'])assert.equal(parseThreadedWaitSource({...ref,kind}).kind,kind);
    assert.equal(parseThreadedWaitSource({...ref,kind:'reporter_handle',anchorRef:'anchor'}).anchorRef,'anchor');
    for(const value of ['free prose',{...ref,kind:'pending_input'},{...ref,kind:'reporter_handle'},{...ref,extra:true},{...ref,slaUntilMs:0},{...ref,slaUntilMs:1.1}])assert.throws(()=>parseThreadedWaitSource(value));
    for(const signal of ['pending_input','waiting_for_user_reply','human response','等待用户输入'])assert.throws(()=>parseThreadedWaitSource({...ref,expectedSignal:signal}),/HUMAN_INPUT/);
    const props=THREADED_TOOLS.find(t=>t.name==='hold_ball').parameters.properties;
    assert.equal(props.waitSourceRef.type,'object');assert.equal(props.waitSourceRef.additionalProperties,false);
    const classify=(now,extra={})=>classifyThreadedTimerRecovery({deadline:5000,createdAt:0,now,source:ref,identityValid:true,sourceValid:true,...extra});
    assert.equal(classify(9999).kind,'recover');assert.equal(classify(10000).kind,'recover');assert.equal(classify(10001).kind,'expired');
    for(const extra of [{identityValid:false},{sourceValid:false},{deadline:4999},{deadline:3600001},{source:'legacy prose'},{deadline:null}])assert.equal(classify(10000,extra).kind,'invalid');
    checks.push('WC01: strict six-kind structured contract, mandatory reporter anchor, human-input rejection and separate classifier equality/expired/invalid boundaries');
  }
  {
    const f=await fixture('grounding');const hidden=f.user('hidden private source',[],{visibility:'private',audience:['other-member']});
    const receipt=f.user('grounded timer registration');const future=f.user('future source outside frozen input',[]);
    await run(f,receipt,async claim=>{
      for(const [key,ref] of [['missing',source(f,claim,{value:'made-up'})],['hidden',source(f,claim,{value:hidden.message.id})],['future',source(f,claim,{value:future.message.id})],['github',source(f,claim,{kind:'github_issue',value:'https://github.com/test/repo/issues/1'})],['reporter',source(f,claim,{kind:'reporter_handle',value:'reporter',anchorRef:receipt.message.id})]])
        assert.equal((await tool(f,claim,'hold_ball',hold(f,claim,key,{waitSourceRef:ref}))).code,'THREADED_WAIT_SOURCE_NOT_AUTHORIZED');
      const task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Actual owned task',acceptanceCriteria:['verification']}));
      ok(await tool(f,claim,'hold_ball',hold(f,claim,'task-source',{waitSourceRef:source(f,claim,{kind:'task',value:task.taskId})})));
      const before=count(f,'threaded_hold_admissions');assert.equal(before,1);
      assert.equal((await tool(f,claim,'hold_ball',hold(f,claim,'past-sla',{waitSourceRef:source(f,claim,{slaUntilMs:f.clock()})}))).code,'THREADED_HOLD_SLA_INVALID');
      assert.equal(count(f,'threaded_hold_admissions'),before);return 'grounded';});
    checks.push('WC02: fabricated, private-forbidden, future-cutoff and unregistered external sources fail before admission; actual scoped task grounds successfully; past SLA cannot consume quota');
  }
  {
    const f=await fixture('replacement');let first;
    await run(f,f.user('replacement rollback'),async claim=>{
      const input=hold(f,claim,'original');first=ok(await tool(f,claim,'hold_ball',input));
      assert.deepEqual(ok(await tool(f,claim,'hold_ball',{...input,idempotencyKey:'same-job-new-tool-key'})),first);
      assert.equal(count(f,'threaded_hold_admissions'),1);
      assert.equal((await tool(f,claim,'hold_ball',hold(f,claim,'bad-replacement',{replaceWaitId:first.waitId,expectedVersion:1,waitSourceRef:source(f,claim,{value:'missing'})}))).code,'THREADED_WAIT_SOURCE_NOT_AUTHORIZED');
      assert.equal(row(f,first.waitId).state,'awaiting');assert.equal(count(f,'threaded_hold_admissions'),1);
      f.db.exec("CREATE TRIGGER rc03_wait_fault BEFORE INSERT ON threaded_hold_admissions WHEN NEW.source_id<>'' BEGIN SELECT RAISE(ABORT,'rc03_admission_fault'); END");
      await assert.rejects(()=>tool(f,claim,'hold_ball',hold(f,claim,'fault-replacement',{replaceWaitId:first.waitId,expectedVersion:1})),/rc03_admission_fault/);
      f.db.exec('DROP TRIGGER rc03_wait_fault');assert.equal(row(f,first.waitId).state,'awaiting');assert.equal(count(f,'threaded_waits'),1);return 'atomic';});
    checks.push('WC03: same job is idempotent before admission; rejected source or an admission-write crash rolls back replacement, original wait state and quota together');
  }
  {
    const f=await fixture('online-sla');let timer;
    await run(f,f.user('online timer remains a one-shot'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim,'timer',{seconds:10,waitSourceRef:source(f,claim,{slaUntilMs:f.clock()+100})})));return 'registered';});
    f.advance(15000);f.runtime.collaboration.cooperation.recover();assert.equal(row(f,timer.waitId).state,'settled');assert.equal(callback(f,timer.waitId).state,'delivered');
    assert.equal(outcome(f,timer.waitId).recoveredMissedTimer,undefined);assert.equal(outcome(f,timer.waitId).businessConditionVerified,false);
    checks.push('WC04: online one-shot delivers after its recovery SLA without treating elapsed time as a verified business condition');
  }
  {
    const f=await fixture('restored-before-deadline');let timer;
    await run(f,f.user('restore before timer deadline'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim,'timer',{seconds:10,waitSourceRef:source(f,claim,{slaUntilMs:f.clock()+100})})));return 'registered';});
    f.advance(50);f.reopen();f.advance(15000);f.runtime.collaboration.cooperation.recover();assert.equal(callback(f,timer.waitId).state,'delivered');assert.equal(outcome(f,timer.waitId).recoveredMissedTimer,undefined);
    checks.push('WC05: rebuilding the runtime before the timer fires preserves ordinary online semantics even when later recovery runs past SLA');
  }
  {
    const f=await fixture('missed-within-sla');let timer;
    await run(f,f.user('missed timer recovery'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim)));return 'registered';});
    const before=injectedRequests,original=row(f,timer.waitId).record;f.advance(6000);f.reopen();f.runtime.collaboration.cooperation.recover();
    assert.equal(row(f,timer.waitId).state,'settled');assert.equal(callback(f,timer.waitId).state,'delivered');assert.equal(outcome(f,timer.waitId).recoveredMissedTimer,true);
    const messageId=callback(f,timer.waitId).message_id;f.runtime.collaboration.cooperation.recover();assert.equal(callback(f,timer.waitId).message_id,messageId);
    assert.equal(count(f,'threaded_hold_admissions'),1);assert.equal(row(f,timer.waitId).record,original);assert.equal(injectedRequests,before);
    checks.push('WC06: a missed timer with current frozen identity and grounded source recovers once within SLA, retaining its immutable record/root without another model request or admission charge');
  }
  {
    for(const delta of [10000,10001]){const f=await fixture(`missed-expired-${delta}`);let timer;
      await run(f,f.user('closed retry window'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim,'timer',{waitSourceRef:source(f,claim,{slaUntilMs:f.clock()+10000})})));return 'registered';});
      f.advance(delta);f.reopen();f.runtime.collaboration.cooperation.recover();assert.equal(row(f,timer.waitId).state,'withdrawn');assert.equal(outcome(f,timer.waitId).disposition,'retired_expired');
      assert.equal(outcome(f,timer.waitId).classification,delta===10000?'recover':'expired');assert.equal(callback(f,timer.waitId),undefined);
      f.runtime.collaboration.cooperation.recover();assert.equal(row(f,timer.waitId).version,2);}
    checks.push('WC07: exact SLA is classifier-eligible but has no dispatch retry window; equality and later recovery retire durably without callbacks or repeated transitions');
  }
  {
    const f=await fixture('identity-drift');let timer;
    await run(f,f.user('retained original identity'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim)));return 'registered';});
    f.db.prepare("UPDATE threaded_members SET version=version+1,permission_version=permission_version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
    f.advance(6000);f.reopen();f.runtime.collaboration.cooperation.recover();assert.equal(row(f,timer.waitId).state,'withdrawn');assert.equal(outcome(f,timer.waitId).disposition,'retired_invalid');assert.equal(callback(f,timer.waitId),undefined);
    checks.push('WC08: missed timer identity drift retires invalid instead of borrowing the member’s newer permission generation');
  }
  {
    const f=await fixture('private-provenance');const secret=f.user('private timer source',[],{visibility:'private',audience:['api-member']});let timer;
    await run(f,f.user('public trigger'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim,'timer',{waitSourceRef:source(f,claim,{value:secret.message.id})})));return 'registered';});
    const saved=JSON.parse(row(f,timer.waitId).record);assert.equal(saved.scope.visibility,'private');assert.ok(saved.scope.sourceRefs.includes(secret.message.id));
    f.advance(6000);f.runtime.collaboration.cooperation.recover();const record=JSON.parse(f.db.prepare('SELECT record FROM threaded_messages WHERE id=?').get(callback(f,timer.waitId).message_id).record);
    assert.equal(record.visibility,'private');assert.deepEqual(record.audience,['api-member']);
    checks.push('WC09: an explicit private wait anchor narrows the callback and downstream provenance even when its initiating message was public');
  }
  {
    let version=1;const f=await fixture('external-authority',{waitSourceAuthorization:(_scope,ref)=>({authorization:`trusted:${version}`,sourceMessageIds:ref.anchorRef?[ref.anchorRef]:[]})});let timer;
    await run(f,f.user('trusted reporter adapter'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim,'reporter',{waitSourceRef:source(f,claim,{kind:'reporter_handle',value:'registered-reporter',anchorRef:f.runtime.collaboration.cooperation.source(claim.binding).id})})));return 'registered';});
    pause(f);f.advance(6000);f.runtime.collaboration.cooperation.recover();assert.equal(callback(f,timer.waitId).state,'waiting');
    version++;f.runtime.collaboration.cooperation.recover();assert.equal(callback(f,timer.waitId).state,'rejected');assert.equal(callback(f,timer.waitId).reason,'THREADED_WAIT_SOURCE_AUTHORITY_CHANGED');
    checks.push('WC10: a server-installed reporter adapter must return its real authorized anchor; paused timer callbacks recheck that external source authority rather than trusting the stored handle');
  }
  {
    const f=await fixture('paused-missed-expiry');let timer;
    await run(f,f.user('missed timer awaiting resume'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim,'timer',{waitSourceRef:source(f,claim,{slaUntilMs:f.clock()+10000})})));return 'registered';});
    pause(f);f.advance(6000);f.reopen();f.runtime.collaboration.cooperation.recover();assert.equal(callback(f,timer.waitId).state,'waiting');
    f.advance(4000);f.runtime.collaboration.cooperation.recover();assert.equal(callback(f,timer.waitId).state,'rejected');assert.equal(callback(f,timer.waitId).reason,'THREADED_TIMER_RECOVERY_EXPIRED');
    checks.push('WC11: a paused recovered callback cannot outlive the original recovery SLA; its exact-boundary rejection is retained without model replay');
  }
  {
    for(const domain of ['ordinary','gatekeeping']){const f=await fixture(`hold-domain-${domain}`,{holdPolicy:()=>domain});
      await run(f,f.user('explicit server domain policy'),async claim=>{
        const longest=await tool(f,claim,'hold_ball',hold(f,claim,'long',{seconds:3600}));assert.equal(longest.ok,domain==='ordinary');if(domain==='gatekeeping')assert.equal(longest.code,'THREADED_HOLD_GATEKEEPING_TOO_LONG');
        ok(await tool(f,claim,'hold_ball',hold(f,claim,'short',{seconds:600})));
        if(domain==='gatekeeping'){
          ok(await tool(f,claim,'track_event',{idempotencyKey:'track',jobKey:'track',source:'thread_messages',subject:f.thread.id,match:{type:'message',origin:'user'}}));
          assert.equal((await tool(f,claim,'hold_ball',hold(f,claim,'redundant'))).code,'THREADED_HOLD_GATEKEEPING_EVENT_CALLBACK_EXISTS');
        }return domain;});}
    checks.push('WC12: ordinary timers retain the full 3600-second range; only explicitly selected gatekeeping scope limits to 600 seconds and rejects redundant live event callbacks');
  }
  {
    for(const retired of ['closed','cancelled','legacy','legacy-before-deadline']){const f=await fixture(`retired-original-${retired}`);let timer,retiredId;
      await run(f,f.user('retained timer retirement boundaries'),async claim=>{timer=ok(await tool(f,claim,'hold_ball',hold(f,claim)));return 'registered';});
      retiredId=timer.waitId;
      if(retired==='closed')f.db.prepare("UPDATE threaded_threads SET state='closed' WHERE id=?").run(f.thread.id);
      if(retired==='cancelled')f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,scope:{kind:'member',threadId:f.thread.id,agentId:'api-member'},action:'stop',requestId:randomUUID()});
      if(retired.startsWith('legacy')){
        const saved=row(f,timer.waitId);const legacy={...saved,id:randomUUID(),job_key:'pre-v35-legacy',record:JSON.stringify({...JSON.parse(saved.record),waitSourceRef:'old free-form source'})};
        const keys=Object.keys(legacy);f.db.prepare(`INSERT INTO threaded_waits(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(legacy));retiredId=legacy.id;
      }
      if(retired==='legacy-before-deadline'){f.advance(100);f.reopen();f.advance(5900);}else{f.advance(6000);f.reopen();}
      f.runtime.collaboration.cooperation.recover();assert.equal(row(f,retiredId).state,'withdrawn');assert.equal(outcome(f,retiredId).disposition,'retired_invalid');assert.equal(callback(f,retiredId),undefined);
    }
    checks.push('WC14: closed or stopped original scope and stored legacy free-form sources retire invalid; legacy restored before its deadline also retires invalid on expiry, without inventing source authority or applying an online SLA cutoff');
  }
  {
    const port={authorization:()=> 'trusted-command-v1',validate:args=>assert.deepEqual(args,{}),start:async()=>({state:'running',evidenceRef:'fixed:start'}),observe:async()=>({state:'running',evidenceRef:'fixed:observe'}),cancel:async()=>({state:'unknown',evidenceRef:'fixed:cancel'})};
    const f=await fixture('shared-command-admission',{actions:{commands:{fixed:port}}});let action,command;
    await run(f,f.user('shared timer and command hold admission'),async claim=>{
      const task=ok(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Owned command task',acceptanceCriteria:['fixed result']}));
      action=ok(await tool(f,claim,'transfer_action',{idempotencyKey:'transfer',subject:{kind:'task',taskId:task.taskId},predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));return 'transferred';});
    await run(f,undefined,async claim=>{
      const exact={actionId:action.actionId,expectedGeneration:1};
      command=ok(await tool(f,claim,'run_command',{idempotencyKey:'run',...exact,command:'fixed',args:{}}));assert.equal(count(f,'threaded_hold_admissions'),0);
      ok(await tool(f,claim,'wait_command',{idempotencyKey:'wait-one',...exact,commandId:command.commandId}));
      ok(await tool(f,claim,'wait_command',{idempotencyKey:'wait-two',...exact,commandId:command.commandId}));assert.equal(count(f,'threaded_hold_admissions'),1);
      ok(await tool(f,claim,'hold_ball',hold(f,claim,'managed-source',{waitSourceRef:source(f,claim,{kind:'managed_command',value:command.commandId})})));
      const timerInput=hold(f,claim,'ordinary-timer');const timer=ok(await tool(f,claim,'hold_ball',timerInput));assert.equal(count(f,'threaded_hold_admissions'),3);
      assert.deepEqual(ok(await tool(f,claim,'hold_ball',{...timerInput,idempotencyKey:'new-tool-same-job'})),timer);
      assert.equal((await tool(f,claim,'hold_ball',hold(f,claim,'fourth'))).code,'THREADED_HOLD_QUOTA_EXCEEDED');
      assert.equal(count(f,'threaded_hold_quota'),2);return 'shared quota';});
    f.reopen();assert.equal(count(f,'threaded_hold_admissions'),3);
    checks.push('WC13: command wake and timers share three admissions per member/Thread/hour; starting alone is a separate resource operation, repeated wait/same timer job charges once, and real scoped managed command is a valid source');
  }
  const evidence={schemaVersion:1,task:'RC03 structured waits and shared hold admission',at:new Date().toISOString(),checks,passed:checks.length,injectedRequests,
    realModelRequests:0,externalNetworkRequests:0,scope:{productionDefault:'ordinary',externalIssueCommentReporter:'requires explicitly installed trusted source adapter',sla:'missed timers only; dispatch strictly before recovery SLA'}};
  const output=path.resolve(process.env.THREADED_RC03_WAITS_OUTPUT??'docs/reports/evidence/threaded-rc03/waits.json');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({ok:true,passed:checks.length,injectedRequests,evidence:output}));
}finally{globalThis.fetch=originalFetch;for(const f of fixtures)try{f.close();}catch{}await rm(root,{recursive:true,force:true});}
