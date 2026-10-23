/** RC04 exercises one canonical PR Action through two new HEADs. Model replies are local scripted protocol fixtures, never a substantive engineering review. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Database from '../../apps/server/node_modules/better-sqlite3/lib/index.js';

let imports;
async function modules(root){
  if(!imports){
    // Any transitive legacy module is bound to this disposable path before import.
    Object.assign(process.env,{NODE_ENV:'test',LOG_LEVEL:'silent',DB_PATH:path.join(root,'unused-import.sqlite'),AGENTS_DIR:path.join(root,'unused-agents')});
    assert.notEqual(process.env.AGENT_GAND_ISOLATED_WORKER,'1','RC04 must enforce production execution/release authority');
    imports=Promise.all([
      import('../../apps/server/src/db/orchestrationMigrations.ts'),import('../../apps/server/src/threaded/store.ts'),
      import('../../apps/server/src/execution/resources/coordinator.ts'),import('../../apps/server/src/execution/resources/sessions.ts'),
      import('../../apps/server/src/threaded/backends/evidence.ts'),import('../../apps/server/src/threaded/authority.ts'),
      import('../../apps/server/src/threaded/messaging.ts'),import('../../apps/server/src/threaded/productionSettings.ts'),
      import('../../apps/server/src/threaded/production.ts'),import('../../apps/server/src/threaded/tools.ts'),
    ]).then(([migrations,store,resources,sessions,evidence,authority,messaging,settings,production,tools])=>
      ({...migrations,...store,...resources,...sessions,...evidence,...authority,...messaging,...settings,...production,...tools}));
  }
  return imports;
}

/** Only the caller's server-installed transport sees the in-memory token. The harness never reads a credential store or performs an uncontrolled fetch. */
export async function openRc04Harness(root,options){
  const {name,repository,number,principalLogin,readToken,githubFetch}=options;
  assert.match(name,/^[A-Za-z0-9_-]{1,60}$/);assert.match(repository,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
  assert.ok(Number.isSafeInteger(number)&&number>0);assert.match(principalLogin,/^[A-Za-z0-9-]{1,39}$/);
  assert.equal(typeof readToken,'function');assert.equal(typeof githubFetch,'function');
  const m=await modules(root),directory=path.join(root,name);await mkdir(directory,{recursive:true});
  const applicationTools=['transfer_action','review_context','submit_review','complete_action','check_review_gate','start_review_revision','track_event'];
  const file=path.join(directory,'business.sqlite'),releaseFile=path.join(directory,'release.json'),githubFile=path.join(directory,'github.json'),stateFile=path.join(directory,'rc04-state.json');
  let retained;
  if(options.restore){retained=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(retained.schemaVersion,1);
    assert.deepEqual(retained.identity,{name,repository,number,principalLogin});assert.ok(['await_first_head','await_second_head','passed'].includes(retained.stage),'Only saved stage boundaries are restartable');}
  let db=new Database(file,{timeout:10_000,...(retained?{fileMustExist:true}:{})});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');
  const stamp=new Date().toISOString(),accountId=`${name}-account`,author=`${name}-author`,reviewer=`${name}-reviewer`,agentIds=[author,reviewer],model='anthropic:rc04-scripted-fixture';
  if(!retained){
  db.exec(await readFile(new URL('../../apps/server/src/db/schema.sql',import.meta.url),'utf8'));
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER');m.applyOrchestrationSchemaMigrations(db);
  db.prepare('INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at) VALUES(?,?,?,?,?,1,1,1,?,?)')
    .run(accountId,'RC04 isolated scripted account','anthropic','api_key','managed',stamp,stamp);
  // This local scripted response runs several individually bounded official GETs
  // before returning. It must not inherit a two-second fake-model timeout.
  db.prepare('INSERT INTO account_versions VALUES(?,1,?,?)').run(accountId,JSON.stringify({baseUrl:'https://rc04-scripted.invalid',protocols:['anthropic-messages'],models:[model],defaultModel:model,timeoutMs:120000}),stamp);
  db.prepare('INSERT INTO account_credentials VALUES(?,1,?,?,?,?,?,?)').run(accountId,'fixture-key-id','fixture-ciphertext','fixture-nonce','fixture-tag','fake',stamp);
  const members=agentIds.map(agentId=>({agentId,backend:'api',backendVersion:'threaded-http-v1',model,roleVersion:1,permissionVersion:1,accountId,
    accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}));
  for(const id of agentIds)db.prepare('INSERT INTO agents(id,name,definition,source,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id,
    JSON.stringify({id,name:id,model,systemPrompt:'RC04 local scripted protocol acceptance; this is not a substantive code review.',tools:applicationTools,
      permissionMode:'readonly',accountRef:accountId,requiresAccount:true}),'rc04-isolated',stamp,stamp);
  await writeFile(releaseFile,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools,
    maxOutputTokens:128,maxInputTokens:65536,maxRequests:4,prices:Object.fromEntries(agentIds.map(id=>[id,{inputPerMillion:1,outputPerMillion:1}]))}));
  }else m.assertOrchestrationSchemaCompatible(db);
  const ownerId=m.createThreadedStore(db).getInstanceOwnerId(),subject={kind:'github_pr',repository,number};
  let production,messaging,resources,thread=retained?.thread,activeClaim,handler,handlerError,closed=false,stage=retained?.stage??'new',action=retained?.action,rootId=retained?.rootId;
  let scriptedCalls=retained?.scriptedCalls??0,providerReads=retained?.providerReads??0,credentialReads=retained?.credentialReads??0,requestTrace;
  const chain=retained?.chain??{heads:[],waits:[],gates:[],reports:[],revisions:[],rebuilds:[],acceptedSources:[],retries:[]};
  const response=text=>new Response(JSON.stringify({type:'message',id:randomUUID(),content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:20,output_tokens:5}}),{headers:{'content-type':'application/json'}});
  function attach(withGithub){
    const settings=m.loadThreadedProductionSettings(db,{file:releaseFile,workspaceRoot:path.join(directory,'workspace'),privateRoot:path.join(directory,'private'),platform:'darwin',readCredential:()=> 'rc04-local-fixture-key'});
    resources=m.createExecutionResourceCoordinator(db,{ownerNonce:`rc04:${randomUUID()}`,validateRequest:r=>m.assertResourceSessionCurrent(db,r),
      verifyEvidence:(_r,claim,evidence)=>{const saved=resources.getClaim(claim.claimId);return !!saved&&m.verifyThreadedBackendResourceEvidence(db,saved,evidence);}});
    messaging=m.createThreadedMessaging(db,{authority:m.createThreadedAuthority(db,resources),repairIntervalMs:0});
    production=m.createThreadedProduction(db,{resources,messaging,settings,mode:()=> 'execute',
      onRequestReserved(_id,description){requestTrace.reserved=true;requestTrace.inputBytes=description.inputBytes;},
      ...(withGithub?{github:{file:githubFile,readToken:key=>{assert.equal(key,'THREADED_GITHUB_TOKEN_RC04');credentialReads++;return readToken();},fetch:async(input,init)=>{
        assert.equal(db.inTransaction,false);providerReads++;return githubFetch(input,init);}}}:{}),
      fetch:async(input)=>{assert.equal(new URL(input).origin,'https://rc04-scripted.invalid');assert.equal(db.inTransaction,false);scriptedCalls++;requestTrace.scriptedFetch=true;
        try{const text=await handler(activeClaim);requestTrace.handlerCompleted=true;return response(text);}catch(error){handlerError=error;throw error;}}});
    // Every provider refresh is explicit, so timers cannot manufacture hidden polls.
    production.collaboration.close();
  }
  if(!retained){attach(false);
  production.release.change({ownerId,expectedVersion:0,requestId:'rc04-open-local-fixture',admissionOpen:true,dispatchOpen:true,reason:'RC04 disposable acceptance only'});
  thread=production.createThread({ownerId,title:`RC04 ${repository}#${number}`,clientRequestId:'rc04-new-local-thread'});
  await production.shutdown(200);messaging.close();
  await writeFile(githubFile,JSON.stringify({schemaVersion:1,version:1,ownerId,credential:{source:'environment',name:'THREADED_GITHUB_TOKEN_RC04',version:1},
    repositories:[{repository,pullNumbers:[number],threadIds:[thread.id],actors:agentIds.map(agentId=>({agentId,githubLogin:principalLogin,mayAssign:agentId===author}))}]}));
  }
  attach(true);

  const tool=async(claim,name,input)=>JSON.parse(await production.collaboration.tools.execute(claim.binding,name,input,randomUUID(),applicationTools));
  const ok=answer=>{if(answer.ok!==true)throw Object.assign(new Error('RC04_DOMAIN_REJECTED'),{code:'RC04_DOMAIN_REJECTED',domainCode:/^THREADED_[A-Z0-9_]+$/.test(answer.code??'')?answer.code:'UNCLASSIFIED'});return answer.result;};
  const workflow=()=>JSON.parse(db.prepare('SELECT record FROM threaded_review_workflows WHERE action_id=?').get(action.actionId).record);
  const source=claim=>production.collaboration.cooperation.source(claim.binding);
  function assertRoot(claim){assert.equal(source(claim).causalRootId,rootId,'Every revision and wait must retain the original author root');}
  function rows(table,columns='id'){return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all();}
  function durableIdentity(){return {
    callbacks:rows('threaded_collaboration_callbacks','id,source_id,state,message_id'),events:rows('threaded_tracking_events','seq'),messages:rows('threaded_messages'),
    reports:rows('threaded_review_reports','evidence_id'),versions:rows('threaded_review_versions','action_id,version'),claims:rows('threaded_review_revision_claims'),
    generations:rows('threaded_action_generations','action_id,generation'),terminals:rows('threaded_invocation_terminals','invocation_id'),
  };}
  async function runFor(agentId,nextHandler,sourceMessageId,receipt){
    assert.notEqual(process.env.AGENT_GAND_ISOLATED_WORKER,'1');
    if(receipt)for(const wake of receipt.wakes)production.queue.enqueueWake(wake.id);
    production.queue.scanPending();
    for(let i=0;i<20;i++){
      const claim=production.queue.claimNext(`rc04:${name}`);assert.ok(claim,`Expected queued ${agentId} source ${sourceMessageId??'*'}`);
      activeClaim=claim;handlerError=undefined;requestTrace={reserved:false,scriptedFetch:false,handlerCompleted:false};let matched=false;
      handler=async c=>{if(c.binding.agentId===agentId&&(!sourceMessageId||source(c).id===sourceMessageId)){matched=true;return nextHandler(c);}return 'Unrelated durable local notification processed';};
      const result=await production.executeClaim(claim);production.collaboration.close();if(handlerError)throw handlerError;
      if(result.status!=='completed'){
        const attempt=db.prepare('SELECT execution_reason,outcome_record FROM threaded_attempts WHERE id=?').get(claim.binding.attemptId);
        const reason=result.contextBlocked??attempt.execution_reason??(attempt.outcome_record?JSON.parse(attempt.outcome_record).reason:null);
        throw Object.assign(new Error('RC04_LOCAL_EXECUTION_FAILED'),{code:'RC04_LOCAL_EXECUTION_FAILED',domainCode:/^[A-Z][A-Z0-9_]+$/.test(reason??'')?reason:'UNCLASSIFIED',
          requestTrace:{...requestTrace,manifestPayloadBytes:db.prepare('SELECT length(CAST(payload AS BLOB)) n FROM threaded_context_manifests WHERE binding_id=? ORDER BY rowid DESC LIMIT 1').get(claim.binding.id)?.n??null,
            backend:db.prepare('SELECT state,payload_included,delivered,input_tokens,output_tokens FROM threaded_backend_requests WHERE binding_id=?').all(claim.binding.id)}});
      }
      if(matched)return claim;
    }
    assert.fail(`No requested source for ${agentId}`);
  }
  async function gate(claim,label,version,expected){
    const value=ok(await tool(claim,'check_review_gate',{actionId:action.actionId,expectedVersion:version}));
    if(value.status==='unverifiable'&&expected!=='unverifiable')throw Object.assign(new Error('RC04_LIVE_GATE_UNVERIFIABLE'),{code:'RC04_LIVE_GATE_UNVERIFIABLE'});
    assert.equal(value.status,expected,JSON.stringify(value));assert.equal(value.approvalGateSatisfied,expected==='approved');assert.equal(value.externalApprovalGranted,false);
    chain.gates.push({label,...value});return value;
  }
  function reviewInput(ctx,extra){return {idempotencyKey:randomUUID(),actionId:action.actionId,expectedGeneration:ctx.generation,expectedVersion:ctx.workflowVersion,
    authorAgentId:ctx.authorAgentId,acceptedSourceMessageId:ctx.acceptedSourceMessageId,acceptedRevision:ctx.acceptedRevision,reviewedHeadSha:ctx.headSha,
    findings:[],resolvedFindingIds:[],body:'RC04 scripted local protocol report; no substantive code review or GitHub review is performed.',...extra};}
  async function publish(claim,ctx,extra,label){
    const input=reviewInput(ctx,extra),report=ok(await tool(claim,'submit_review',input));
    const retry=ok(await tool(claim,'submit_review',input));assert.equal(retry.evidenceId,report.evidenceId);assert.equal(retry.messageId,report.messageId);
    assert.equal(report.actionCompleted,false);assert.equal(report.approvalGateSatisfied,false);
    chain.retries.push({kind:'review',label,evidenceId:report.evidenceId,duplicateEvidence:false});
    const completion=ok(await tool(claim,'complete_action',{idempotencyKey:randomUUID(),actionId:action.actionId,expectedGeneration:ctx.generation,evidenceId:report.evidenceId}));
    assert.equal(completion.state,'completed');assert.equal(completion.approvalGateSatisfied,false);
    chain.reports.push({label,...report,headSha:ctx.headSha,authorAgentId:ctx.authorAgentId,reviewerAgentId:claim.binding.agentId,acceptedSourceMessageId:ctx.acceptedSourceMessageId,acceptedRevision:ctx.acceptedRevision,
      responsibilityCompleted:true,substantiveCodeReview:false});
    return report;
  }
  function context(claim){return tool(claim,'review_context',{actionId:action.actionId}).then(ok);}
  async function registerWait(report,expectedHead,index){
    await runFor(author,async claim=>{assertRoot(claim);assert.equal(source(claim).id,report.messageId);assert.equal(production.collaboration.actions.capture(claim.binding),null);
      const result=ok(await tool(claim,'track_event',{idempotencyKey:`head-${index}`,jobKey:`head-${index}`,source:'github_pr',subject:`${repository}#${number}`,match:{type:'github_pr',headChanged:true}}));
      const saved=db.prepare('SELECT * FROM threaded_waits WHERE id=?').get(result.waitId),record=JSON.parse(saved.record);
      const baseline=JSON.parse(db.prepare('SELECT record FROM threaded_tracking_events WHERE seq=?').get(record.baseline).record);
      if(baseline.headSha!==expectedHead)throw Object.assign(new Error('RC04_HEAD_MOVED_DURING_BASELINE'),{code:'RC04_HEAD_MOVED_DURING_BASELINE'});
      assert.equal(baseline.headChanged,index!==1);assert.equal(saved.root_id,rootId);assert.equal(saved.state,'awaiting');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE source_id=?').get(saved.id).n,0);
      chain.waits.push({index,waitId:saved.id,baselineHead:baseline.headSha,baselineEventSeq:record.baseline,rootId:saved.root_id,registeredFromMessageId:report.messageId,observed:null});
      return 'Registered a durable exact-HEAD tracking baseline without holding the execution slot';
    },report.messageId);
  }
  const snapshot=()=>({name,repository,number,stage,ownerId,threadId:thread.id,rootId:rootId??null,actionId:action?.actionId??null,canonicalActionCount:db.open?db.prepare('SELECT COUNT(*) n FROM threaded_actions').get().n:null,
    protocolLayer:'Actual production composition/authority and SQLite; local scripted model replies and local independent-review protocol assertions only',
    fixtureConfiguration:{modelReplyTimeoutMs:120000,maxInputTokens:65536,applicationTools,activityAllowanceMs:10000,
      defaultActivityBoundary:{activityAllowanceMs:1000,previousIsolatedFailure:'THREADED_BUDGET_ACTIVITY_ALLOWANCE_EXPIRED',scope:'Synchronous full-contract preparation exceeded the initial activity slice before scripted transport; default production guard remains unchanged'},
      activityPolicy:'Explicit disposable Owner revision through budget.reviseRoot; total activity/token/cost/invocation caps retain defaults'},
    realModelCalls:0,realModelTokens:0,realExternalWrites:0,scriptedCalls,providerReads,credentialReads,productionOpened:false,
    chain:JSON.parse(JSON.stringify(chain)),...(failure?{failure}:{}),...(db.open?{durableIdentity:durableIdentity(),foreignKeyViolations:db.pragma('foreign_key_check').length,counts:{trackingCallbacks:db.prepare("SELECT COUNT(*) n FROM threaded_collaboration_callbacks WHERE kind='wait'").get().n,
      reviewReports:db.prepare('SELECT COUNT(*) n FROM threaded_review_reports').get().n,revisionClaims:db.prepare('SELECT COUNT(*) n FROM threaded_review_revision_claims').get().n}}:{})});
  let failure;
  async function persist(){const temporary=`${stateFile}.tmp`;await writeFile(temporary,JSON.stringify({schemaVersion:1,identity:{name,repository,number,principalLogin},
    stage,thread,action,rootId,scriptedCalls,providerReads,credentialReads,chain})+'\n');await rename(temporary,stateFile);}
  async function guarded(operation){try{const result=await operation();await persist();return result;}catch(error){
    const code=/^RC04_[A-Z0-9_]+$/.test(error?.code??'')?error.code:'RC04_CHAIN_ASSERTION_FAILED';
    const locations=String(error?.stack??'').split('\n').slice(1).map(line=>/threadedRc04Harness\.mjs:(\d+):(\d+)/.exec(line)).filter(Boolean).map(match=>`${match[1]}:${match[2]}`);
    failure={code,atStage:stage,locations,...(/^[A-Z][A-Z0-9_]+$/.test(error?.domainCode??'')?{domainCode:error.domainCode}:{}),...(error.requestTrace?{requestTrace:error.requestTrace}:{})};stage='failed';await persist();throw Object.assign(new Error(code),failure);
  }}
  if(retained){const before=durableIdentity(),calls={scriptedCalls,providerReads,credentialReads};production.recover();production.collaboration.close();production.collaboration.cooperation.recover();
    const savedAction=db.prepare('SELECT root_id,thread_id,generation FROM threaded_actions WHERE id=? AND owner_id=?').get(action.actionId,ownerId);
    assert.equal(savedAction.root_id,rootId);assert.equal(savedAction.thread_id,thread.id);assert.equal(savedAction.generation,stage==='await_first_head'?1:stage==='await_second_head'?2:3);
    assert.equal(workflow().headSha,chain.heads.at(-1));assert.equal(workflow().rootId,rootId);
    for(const wait of chain.waits){const saved=db.prepare('SELECT root_id,state,record,outcome FROM threaded_waits WHERE id=?').get(wait.waitId);assert.equal(saved.root_id,rootId);
      assert.equal(JSON.parse(saved.record).baseline,wait.baselineEventSeq);const callbacks=db.prepare('SELECT id,message_id FROM threaded_collaboration_callbacks WHERE source_id=?').all(wait.waitId);
      if(wait.observed){assert.equal(saved.state,'settled');assert.equal(JSON.parse(saved.outcome).event.headSha,wait.observed.newHead);assert.deepEqual(callbacks,[{id:wait.observed.callbackId,message_id:wait.observed.messageId}]);}
      else{assert.equal(saved.state,'awaiting');assert.equal(callbacks.length,0);}}
    if(stage==='passed'){assert.ok(workflow().findings.every(f=>f.state==='verified'));assert.equal(chain.gates.at(-1).status,'approved');assert.equal(chain.gates.at(-1).headSha,workflow().headSha);}
    assert.deepEqual(durableIdentity(),before);assert.equal(scriptedCalls,calls.scriptedCalls);assert.equal(providerReads,calls.providerReads);
    chain.rebuilds.push({stage,restoredFromSavedStage:true,actualDatabaseReopened:true,productionFactoryRebuilt:true,providerReads:0,memoryCredentialChecks:credentialReads-calls.credentialReads,scriptedCalls:0,duplicateCallbacks:0,duplicateReviews:0});await persist();}
  return {
    snapshot,
    async initialize(){return guarded(async()=>{
      assert.equal(stage,'new');
      const receipt=production.collaboration.routing.acceptUserMessage({ownerId,threadId:thread.id,body:`@${author} RC04 disposable local protocol acceptance; observe natural PR HEADs without remote changes.`,clientRequestId:randomUUID()}).receipt;
      const initialBudget=production.budget.ensureRootForMessage(receipt.message.id);
      production.budget.reviseRoot({ownerId,rootId:initialBudget.id,expectedVersion:initialBudget.version,requestId:'rc04-scripted-activity-lease',
        reason:'Disposable RC04 scripted protocol uses a ten-second renewable activity slice for synchronous full-contract context and authority preparation; total caps remain unchanged',patch:{activityAllowanceMs:10000}});
      await runFor(author,async claim=>{rootId=source(claim).causalRootId;action=ok(await tool(claim,'transfer_action',{idempotencyKey:'initial-review',subject,predicate:'review_delivered',family:'review',successorSlot:'review',targets:[reviewer]}));
        assert.equal(action.generation,1);return 'Assigned the current-head local independent review';},undefined,receipt);
      let report;
      await runFor(reviewer,async claim=>{assertRoot(claim);const ctx=await context(claim);assert.equal(ctx.workflowVersion,0);chain.heads.push(ctx.headSha);
        chain.acceptedSources.push({generation:1,messageId:ctx.acceptedSourceMessageId,revision:ctx.acceptedRevision});report=await publish(claim,ctx,{verdict:'approved'},'initial-approved');
        await gate(claim,'old-head-approved',report.version,'approved');return 'Initial local review delivery and responsibility completion establish the old-head gate';});
      await registerWait(report,chain.heads[0],1);stage='await_first_head';return snapshot();
    });},
    async poll(){return guarded(async()=>{
      if(stage==='passed')return {observed:false,stage,alreadyPassed:true};assert.ok(['await_first_head','await_second_head'].includes(stage));
      const wait=chain.waits.at(-1),refresh=await production.collaboration.tracking.refresh();production.collaboration.close();production.collaboration.cooperation.recover();
      const row=db.prepare('SELECT state,outcome FROM threaded_waits WHERE id=?').get(wait.waitId),callbacks=db.prepare('SELECT id,state,message_id FROM threaded_collaboration_callbacks WHERE source_id=?').all(wait.waitId);
      if(row.state==='awaiting'){assert.equal(callbacks.length,0);return {observed:false,stage,waitId:wait.waitId,baselineHead:wait.baselineHead,refresh};}
      assert.equal(row.state,'settled');const outcome=JSON.parse(row.outcome);assert.equal(outcome.type,'tracking_event');assert.equal(outcome.event.type,'github_pr');assert.equal(outcome.event.headChanged,true);
      assert.notEqual(outcome.event.headSha,wait.baselineHead);assert.equal(callbacks.length,1);assert.equal(callbacks[0].state,'delivered');
      const observed={newHead:outcome.event.headSha,eventSeq:outcome.eventSeq,callbackId:callbacks[0].id,messageId:callbacks[0].message_id};
      if(wait.observed)assert.deepEqual(observed,wait.observed);else wait.observed=observed;
      return {observed:true,stage,waitId:wait.waitId,baselineHead:wait.baselineHead,...observed,refresh};
    });},
    async advanceObserved(){return guarded(async()=>{
      assert.ok(['await_first_head','await_second_head'].includes(stage));const first=stage==='await_first_head',wait=chain.waits.at(-1);assert.ok(wait.observed,'Call poll and observe a genuinely new event first');
      const prior=workflow(),newHead=wait.observed.newHead;assert.notEqual(newHead,prior.headSha);
      let revision;
      await runFor(author,async claim=>{assertRoot(claim);assert.equal(source(claim).id,wait.observed.messageId);assert.equal(production.collaboration.actions.capture(claim.binding),null);
        await gate(claim,first?'old-approved-invalidated':'changes-requested-head-stale',prior.version,'stale');
        const input={idempotencyKey:`revision-${first?1:2}`,actionId:action.actionId,expectedGeneration:prior.generation,expectedVersion:prior.version,targets:[reviewer],
          responses:prior.findings.filter(f=>f.state!=='verified').map(f=>({findingId:f.id,body:'Scripted local author attestation only; fresh independent verification is still required.',disposition:'addressed'}))};
        revision=ok(await tool(claim,'start_review_revision',input));const retry=ok(await tool(claim,'start_review_revision',input));assert.equal(retry.claimId,revision.claimId);
        assert.equal(revision.verification,'attested');assert.equal(revision.approvalGateSatisfied,false);const next=workflow();
        if(next.headSha!==newHead)throw Object.assign(new Error('RC04_HEAD_MOVED_DURING_REVISION'),{code:'RC04_HEAD_MOVED_DURING_REVISION'});
        assert.equal(next.rootId,rootId);assert.equal(next.generation,prior.generation+1);assert.ok(next.findings.every(f=>f.state==='attested'));
        chain.revisions.push({...revision,oldHead:prior.headSha,newHead,responses:input.responses});chain.retries.push({kind:'revision',claimId:revision.claimId,duplicateClaim:false});
        return 'Fresh revision attested under the original root; no author claim verifies a finding';
      },wait.observed.messageId);
      let report;
      await runFor(reviewer,async claim=>{assertRoot(claim);const ctx=await context(claim);assert.equal(ctx.headSha,newHead);assert.equal(ctx.authorAgentId,author);assert.notEqual(claim.binding.agentId,author);
        assert.notEqual(ctx.acceptedSourceMessageId,chain.acceptedSources.at(-1).messageId);assert.equal(ctx.generation,prior.generation+1);
        chain.acceptedSources.push({generation:ctx.generation,messageId:ctx.acceptedSourceMessageId,revision:ctx.acceptedRevision});
        if(first){assert.equal(ctx.findings.length,0);report=await publish(claim,ctx,{verdict:'changes_requested',findings:['RC04 scripted finding 1: retain exact current HEAD provenance.','RC04 scripted finding 2: verify every attested finding independently.']},'changes-requested');
          await gate(claim,'delivery-complete-is-not-approval',report.version,'blocked');}
        else{assert.deepEqual(ctx.findings.map(f=>f.id),prior.findings.map(f=>f.id));assert.ok(ctx.findings.every(f=>f.state==='attested'));
          const attested=await gate(claim,'author-attestation-is-not-verification',ctx.workflowVersion,'blocked');assert.ok(attested.reasons.includes('FINDINGS_NOT_INDEPENDENTLY_VERIFIED'));
          report=await publish(claim,ctx,{verdict:'approved',resolvedFindingIds:ctx.findings.map(f=>f.id)},'independent-re-review');
          assert.ok(workflow().findings.every(f=>f.state==='verified'));await gate(claim,'fresh-head-findings-verified',report.version,'approved');}
        return first?'Changes request delivered while its approval gate remains blocked':'Every finding independently resolved by a different local reviewer';});
      chain.heads.push(newHead);
      if(first){await registerWait(report,newHead,2);stage='await_second_head';}else stage='passed';
      return snapshot();
    });},
    async rebuild(){return guarded(async()=>{
      const before=durableIdentity(),calls={scriptedCalls,providerReads,credentialReads};await production.shutdown(200);messaging.close();db.close();
      db=new Database(file,{fileMustExist:true});db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');m.assertOrchestrationSchemaCompatible(db);attach(true);
      production.recover();production.collaboration.close();production.collaboration.cooperation.recover();production.collaboration.cooperation.recover();
      assert.deepEqual(durableIdentity(),before);assert.equal(scriptedCalls,calls.scriptedCalls);assert.equal(providerReads,calls.providerReads);
      chain.rebuilds.push({stage,actualDatabaseReopened:true,productionFactoryRebuilt:true,providerReads:0,memoryCredentialChecks:credentialReads-calls.credentialReads,scriptedCalls:0,duplicateCallbacks:0,duplicateReviews:0});return snapshot();
    });},
    async close(){if(closed)return;closed=true;await production.shutdown(200);messaging.close();if(db.open)db.close();},
  };
}
