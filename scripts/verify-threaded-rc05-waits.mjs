import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, realpath, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openBackendRuntimeFixture} from './fixtures/threadedBackendRuntimeFixture.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc05-waits-')));
Object.assign(process.env, {AGENT_GAND_ISOLATED_WORKER:'1', NODE_ENV:'test', LOG_LEVEL:'silent',
  DB_PATH:path.join(root, 'unused.sqlite'), AGENTS_DIR:path.join(root, 'agents')});
const {THREADED_APPLICATION_TOOL_NAMES} = await import('../apps/server/src/threaded/tools.ts');
const {classifyThreadedTimerRecovery} = await import('../apps/server/src/threaded/waitContracts.ts');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {throw new Error('RC05 wait fixture forbids external network');};
const fixtures = [], checks = [], cases = [];
let scriptedRequests = 0;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const row = (f, id) => f.db.prepare('SELECT * FROM threaded_waits WHERE id=?').get(id);
const callback = (f, id) => f.db.prepare("SELECT * FROM threaded_collaboration_callbacks WHERE kind='wait' AND source_id=?").get(id);
const count = (f, table) => f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const ids = (f, table) => f.db.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(v => v.id);
const checked = value => {assert.equal(value.ok, true, JSON.stringify(value)); return value.result;};
const tool = async (f, claim, name, input) => JSON.parse(await f.runtime.collaboration.tools.execute(
  claim.binding, name, input, randomUUID(), THREADED_APPLICATION_TOOL_NAMES));

async function fixture(name, extra = {}) {
  let clock = 1_800_000_000_000, f;
  f = await openBackendRuntimeFixture(root, name, {now:() => clock,
    applicationTools:THREADED_APPLICATION_TOOL_NAMES, ...extra,
    fetch:async () => {
      scriptedRequests++; f.modelRequests++;
      let body;
      try {body = await (f.handler?.(f.claim) ?? 'fixture final');}
      catch (error) {f.handlerError = error; throw error;}
      return new Response(JSON.stringify({type:'message', id:randomUUID(),
        content:[{type:'text', text:body}], stop_reason:'end_turn', usage:{input_tokens:20, output_tokens:7}}),
      {headers:{'content-type':'application/json'}});
    }});
  // Explicit polling owns this test's clock. No asynchronous timer advances a case.
  f.runtime.collaboration.close();
  for (const cfg of f.configurations.values()) {cfg.kind='api'; cfg.backendVersion='threaded-http-v1';}
  f.modelRequests = 0;
  f.clock = () => clock;
  f.setClock = value => {assert.ok(value >= clock); clock = value;};
  f.restart = () => {f.reopen(); f.runtime.collaboration.close();};
  fixtures.push(f); return f;
}
async function run(f, receipt, handler) {
  if (receipt) for (const wake of receipt.wakes) f.runtime.queue.enqueueWake(wake.id);
  const claim = f.runtime.queue.claimNext('rc05-wait-contract');
  assert.ok(claim, 'actual queue claim required');
  f.claim = claim; f.handler = handler;
  const result = await f.runtime.executeClaim(claim);
  f.handler = undefined;
  if (f.handlerError) throw f.handlerError;
  assert.equal(result.status, 'completed', JSON.stringify(result));
  return claim;
}
async function register(f, {slaOffset=10_000, source, pause=false, target='api-member'} = {}) {
  let timer;
  await run(f, f.user('RC05 original timer', [target]), async claim => {
    const ref = source?.(claim) ?? {kind:'thread_message', value:f.runtime.collaboration.cooperation.source(claim.binding).id,
      expectedSignal:'business_check_completed', slaUntilMs:f.clock()+slaOffset};
    timer = checked(await tool(f, claim, 'hold_ball', {idempotencyKey:'timer', jobKey:'timer', seconds:5, waitSourceRef:ref}));
    return 'Registered timer; business condition remains unverified.';
  });
  if (pause) f.runtime.lifecycle.requestControl({ownerId:f.thread.ownerId,
    scope:{kind:'member', threadId:f.thread.id, agentId:target}, action:'pause', requestId:randomUUID()});
  return row(f, timer.waitId);
}
function snapshot(f, id) {
  const saved = row(f,id), cb = callback(f,id);
  return {waitId:saved.id, rootId:saved.root_id, bindingId:saved.binding_id, invocationId:saved.parent_invocation_id,
    deadline:saved.deadline, createdAt:saved.created_at, recordHash:hash(saved.record), state:saved.state, version:saved.version,
    outcome:saved.outcome && JSON.parse(saved.outcome), callback:cb && {id:cb.id, state:cb.state, reason:cb.reason, messageId:cb.message_id},
    admissions:f.db.prepare('SELECT * FROM threaded_hold_admissions ORDER BY source_id').all(),
    backendRequestIds:ids(f,'threaded_backend_requests'), budgetRequestIds:ids(f,'threaded_budget_requests'),
    rootIds:ids(f,'threaded_budget_roots'), modelRequests:f.modelRequests,
    messageIds:ids(f,'threaded_messages'), wakeIds:ids(f,'threaded_wakes')};
}
function unchangedExecution(before, after) {
  for (const key of ['waitId','rootId','bindingId','invocationId','deadline','createdAt','recordHash',
    'admissions','backendRequestIds','budgetRequestIds','rootIds','modelRequests']) assert.deepEqual(after[key], before[key], key);
}
function stable(f, initial, expected) {
  const before = snapshot(f, initial.id); unchangedExecution(initial.snapshot, before);
  assert.equal(before.state, expected.state);
  if (expected.disposition) assert.equal(before.outcome.disposition, expected.disposition);
  if (expected.callbackState) assert.equal(before.callback.state, expected.callbackState);
  else assert.equal(before.callback, undefined);
  for (let i=0; i<3; i++) f.runtime.collaboration.cooperation.recover();
  assert.deepEqual(snapshot(f, initial.id), before, 'repeated recovery cannot create replay or extra callback');
  f.restart(); f.runtime.collaboration.cooperation.recover();
  assert.deepEqual(snapshot(f, initial.id), before, 'second factory rebuild cannot replay settled/retired waits');
  cases.push({name:initial.name, before:initial.snapshot, after:before});
  return before;
}
function baseline(f, saved, name) {return {id:saved.id, name, snapshot:snapshot(f,saved.id)};}
function cloneMalformed(f, saved, suffix, patch, recordPatch={}) {
  const value = {...saved, id:randomUUID(), job_key:`malformed-${suffix}`, ...patch,
    record:JSON.stringify({...JSON.parse(saved.record), ...recordPatch})};
  const keys = Object.keys(value);
  f.db.prepare(`INSERT INTO threaded_waits(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(value));
  return value;
}

try {
  {
    const source = {kind:'thread_message', value:'original-source', expectedSignal:'business_check_completed', slaUntilMs:10_000};
    const classify = time => classifyThreadedTimerRecovery({deadline:5_000, createdAt:0, now:time,
      source, identityValid:true, sourceValid:true});
    assert.equal(classify(4_999).kind,'invalid');
    for (const time of [5_000,5_001,9_999,10_000]) assert.equal(classify(time).kind,'recover');
    assert.equal(classify(10_001).kind,'expired');
    checks.push('RW01: classifier distinguishes fireAt−1, fireAt equality, fireAt+1 and SLA−1/equality/+1; classifier equality is separate from dispatch retry eligibility');
  }
  {
    for (const delta of [4_999,5_000,5_001]) {
      const f=await fixture(`startup-fire-${delta}`), saved=await register(f), initial=baseline(f,saved,`startup fireAt ${delta-5000}ms`);
      f.setClock(saved.created_at+delta); f.restart(); f.runtime.collaboration.cooperation.recover();
      if (delta<5_000) {
        assert.equal(row(f,saved.id).state,'awaiting'); assert.equal(callback(f,saved.id),undefined);
        f.setClock(saved.created_at+15_000); f.runtime.collaboration.cooperation.recover();
      }
      const result=stable(f,initial,{state:'settled',callbackState:'delivered'});
      assert.equal(result.outcome.recoveredMissedTimer,delta<5_000?undefined:true);
      assert.equal(result.outcome.businessConditionVerified,false);
      assert.equal(result.messageIds.length,initial.snapshot.messageIds.length+1);
      assert.equal(result.wakeIds.length,initial.snapshot.wakeIds.length+1);
    }
    checks.push('RW02: restore before fireAt retains online one-shot even when later polled after SLA; startup exactly at/after fireAt recovers once under original root, wait, source and admission without a model call');
  }
  {
    for (const delta of [9_999,10_000,10_001]) {
      const f=await fixture(`startup-sla-${delta}`), saved=await register(f), initial=baseline(f,saved,`startup SLA ${delta-10000}ms`);
      f.setClock(saved.created_at+delta); f.restart(); f.runtime.collaboration.cooperation.recover();
      const eligible=delta<10_000;
      const result=stable(f,initial,eligible?{state:'settled',callbackState:'delivered'}:{state:'withdrawn',disposition:'retired_expired'});
      if (!eligible) {
        assert.equal(result.outcome.classification,delta===10_000?'recover':'expired');
        assert.deepEqual(result.messageIds,initial.snapshot.messageIds); assert.deepEqual(result.wakeIds,initial.snapshot.wakeIds);
      }
    }
    checks.push('RW03: missed timer dispatch succeeds strictly before SLA; exact SLA has no retry window and later SLA expires, both durably retire without callback, wake, new admission or replay');
  }
  {
    const f=await fixture('paused-recovered-sla'), saved=await register(f,{pause:true}), initial=baseline(f,saved,'paused recovered expiry');
    f.setClock(saved.created_at+6_000); f.restart(); f.runtime.collaboration.cooperation.recover();
    const waiting=callback(f,saved.id); assert.equal(waiting.state,'waiting'); assert.equal(waiting.message_id,null);
    f.setClock(saved.created_at+10_000); f.runtime.collaboration.cooperation.recover();
    const result=stable(f,initial,{state:'settled',callbackState:'rejected'});
    assert.equal(result.callback.id,waiting.id); assert.equal(result.callback.reason,'THREADED_TIMER_RECOVERY_EXPIRED');
    assert.deepEqual(result.messageIds,initial.snapshot.messageIds); assert.deepEqual(result.wakeIds,initial.snapshot.wakeIds);
    checks.push('RW04: a paused missed-timer callback keeps its ID and cannot dispatch at the original SLA equality, even after a second rebuild');
  }
  {
    const f=await fixture('immutable-baseline'), saved=await register(f);
    for (const [column,value] of [['deadline',saved.deadline+1],['created_at',saved.created_at+1],['root_id','new-root'],
      ['record',JSON.stringify({...JSON.parse(saved.record),seconds:6})]]) {
      assert.throws(()=>f.db.prepare(`UPDATE threaded_waits SET ${column}=?,state='withdrawn',version=version+1 WHERE id=?`).run(value,saved.id),/THREADED_WAIT_IMMUTABLE/);
    }
    assert.throws(()=>f.db.prepare('UPDATE threaded_instances SET instance_owner_id=?').run('different-owner'),/THREADED_INSTANCE_IDENTITY_IMMUTABLE/);
    checks.push('RW05: registered owner identity, root, fireAt, creation time and timer record are immutable at SQLite boundary; ordinary code cannot drift or rebase them');
  }
  {
    const mutations=[['deadline',{deadline:1},{}],['seconds',{}, {seconds:6}],['missing-seconds',{}, {seconds:undefined}],
      ['string-seconds',{}, {seconds:'5'}],['wrong-kind',{}, {kind:'tracking'}]];
    for (const [name,patch,recordPatch] of mutations) {
      const f=await fixture(`malformed-${name}`), saved=await register(f);
      const malformed=cloneMalformed(f,saved,name,name==='deadline'?{deadline:saved.deadline+patch.deadline}:patch,recordPatch);
      const initial=baseline(f,malformed,`inserted malformed baseline ${name}`);
      f.setClock(saved.created_at+7_000); f.restart(); f.runtime.collaboration.cooperation.recover();
      stable(f,initial,{state:'withdrawn',disposition:'retired_invalid'});
    }
    checks.push('RW06: malformed imported timer rows with plausible shifted fireAt, changed/missing/string seconds or wrong stored kind retire invalid; recovery never reconstructs authority from their plausible delay');
  }
  {
    for (const drift of ['permission','role','membership','source-auth','source-auth-unknown','source-anchor']) {
      let authority=1, anchors;
      const f=await fixture(`drift-${drift}`,{waitSourceAuthorization:(_scope,ref)=>authority===null?null:
        {authorization:`owner-auth:${authority}`,sourceMessageIds:anchors??[ref.anchorRef]}});
      const saved=await register(f,{source:claim=>({kind:'reporter_handle',value:'fixed-reporter',
        anchorRef:f.runtime.collaboration.cooperation.source(claim.binding).id,expectedSignal:'job_completed',slaUntilMs:f.clock()+10_000})});
      const initial=baseline(f,saved,`missed original authority drift ${drift}`);
      if (drift==='permission') f.db.prepare("UPDATE threaded_members SET permission_version=permission_version+1,version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
      if (drift==='role') f.db.prepare("UPDATE threaded_members SET role_version=role_version+1,version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
      if (drift==='membership') f.db.prepare("UPDATE threaded_members SET status='left',version=version+1 WHERE thread_id=? AND agent_id='api-member'").run(f.thread.id);
      if (drift==='source-auth') authority++;
      if (drift==='source-auth-unknown') authority=null;
      if (drift==='source-anchor') anchors=[];
      f.setClock(saved.created_at+6_000); f.restart(); f.runtime.collaboration.cooperation.recover();
      const result=stable(f,initial,{state:'withdrawn',disposition:'retired_invalid'});
      assert.deepEqual(result.messageIds,initial.snapshot.messageIds); assert.deepEqual(result.wakeIds,initial.snapshot.wakeIds);
    }
    checks.push('RW07: original member permission/role/membership and changed/unknown trusted source authorization/anchor retire missed timer invalid without borrowing newer authority or dispatching a callback');
  }
  {
    let authority=1;
    const f=await fixture('queued-authority-drift',{waitSourceAuthorization:(_scope,ref)=>({authorization:`owner-auth:${authority}`,sourceMessageIds:[ref.anchorRef]})});
    const saved=await register(f,{pause:true,source:claim=>({kind:'reporter_handle',value:'fixed-reporter',
      anchorRef:f.runtime.collaboration.cooperation.source(claim.binding).id,expectedSignal:'job_completed',slaUntilMs:f.clock()+10_000})});
    const initial=baseline(f,saved,'paused callback source-authority revoked');
    f.setClock(saved.created_at+6_000); f.restart(); f.runtime.collaboration.cooperation.recover();
    const waiting=callback(f,saved.id); assert.equal(waiting.state,'waiting'); authority++;
    f.runtime.collaboration.cooperation.recover();
    const result=stable(f,initial,{state:'settled',callbackState:'rejected'});
    assert.equal(result.callback.id,waiting.id); assert.equal(result.callback.reason,'THREADED_WAIT_SOURCE_AUTHORITY_CHANGED');
    assert.deepEqual(result.messageIds,initial.snapshot.messageIds); assert.deepEqual(result.wakeIds,initial.snapshot.wakeIds);
    checks.push('RW08: trusted source authority is checked again before a paused callback is delivered; revocation rejects the existing callback without rebasing wait or retrying model');
  }
  {
    const f=await fixture('action-generation'); let task, action, saved;
    const subject=()=>({kind:'task',taskId:task.taskId});
    await run(f,f.user('Original responsibility'),async claim=>{
      task=checked(await tool(f,claim,'create_task',{idempotencyKey:'task',title:'Original task',acceptanceCriteria:['verified result']}));
      action=checked(await tool(f,claim,'transfer_action',{idempotencyKey:'transfer',subject:subject(),predicate:'task_done',family:'work',successorSlot:'primary',targets:['other-member']}));
      return 'Responsibility transferred.';
    });
    await run(f,undefined,async claim=>{
      assert.equal(claim.binding.agentId,'other-member');
      const timer=checked(await tool(f,claim,'hold_ball',{idempotencyKey:'timer',jobKey:'timer',seconds:5,waitSourceRef:{kind:'thread_message',
        value:f.runtime.collaboration.cooperation.source(claim.binding).id,expectedSignal:'business_check_completed',slaUntilMs:f.clock()+10_000}}));
      saved=row(f,timer.waitId);
      const returned=checked(await tool(f,claim,'transfer_action',{idempotencyKey:'return',subject:subject(),predicate:'task_done',family:'work',
        successorSlot:'primary',targets:['api-member'],operation:'return',expectedGeneration:action.generation}));
      assert.equal(returned.generation,action.generation+1); return 'Returned original responsibility.';
    });
    const initial=baseline(f,saved,'actual Action generation returned before timer recovery');
    assert.deepEqual(JSON.parse(saved.record).frozen.actionFence,{actionId:action.actionId,generation:action.generation});
    f.setClock(saved.created_at+6_000); f.restart(); f.runtime.collaboration.cooperation.recover();
    const result=stable(f,initial,{state:'withdrawn',disposition:'retired_invalid'});
    assert.deepEqual(result.messageIds,initial.snapshot.messageIds); assert.deepEqual(result.wakeIds,initial.snapshot.wakeIds);
    assert.equal(f.db.prepare('SELECT generation FROM threaded_actions WHERE id=?').get(action.actionId).generation,2);
    checks.push('RW09: a real tool-mediated Action return advances generation; its original holder timer retires invalid rather than waking or satisfying the newer generation');
  }
  const evidence={schemaVersion:1,task:'RC05 isolated timer recovery contracts',at:new Date().toISOString(),passed:checks.length,checks,cases,
    scriptedModelRequests:scriptedRequests,realModelRequests:0,externalNetworkRequests:0,
    scope:{composition:'actual threaded backend factories, disposable SQLite, deterministic injected provider',
      recovery:'SQLite connection and runtime factory reopen; this file does not prove actual PID or index restart',
      ownerAuth:'local immutable instance owner plus frozen member identity and trusted source authorization; no claim of identical upstream fields',
      baseline:'immutable original row + exact registered seconds/creation/fireAt recovery comparison',
      sla:'missed timer only; classifier allows equality, delivery requires now < original SLA',
      credentials:'none read',dailyDatabase:'not opened',migrations:'historical v25–v35 unchanged'}};
  const output=path.resolve(process.env.THREADED_RC05_WAITS_OUTPUT??'docs/reports/evidence/threaded-rc05/waits.json');
  await mkdir(path.dirname(output),{recursive:true}); await writeFile(output,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify({ok:true,passed:checks.length,cases:cases.length,scriptedModelRequests:scriptedRequests,evidence:output}));
} finally {
  globalThis.fetch=originalFetch;
  for(const f of fixtures)try{f.close();}catch{}
  await rm(root,{recursive:true,force:true});
}
