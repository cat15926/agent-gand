import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'agent-gand-rc06-concurrency-')));
Object.assign(process.env, { NODE_ENV: 'test', LOG_LEVEL: 'silent', AGENT_GAND_ISOLATED_WORKER: '1',
  DB_PATH: path.join(root, 'unused-singleton.sqlite'), AGENTS_DIR: path.join(root, 'agents') });
const originalFetch = globalThis.fetch; let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('RC06_RESOURCE_NETWORK_FORBIDDEN'); };
const { applyOrchestrationSchemaMigrations } = await import('../apps/server/src/db/orchestrationMigrations.ts');
const { createThreadedStore } = await import('../apps/server/src/threaded/store.ts');
const { createThreadedAuthority } = await import('../apps/server/src/threaded/authority.ts');
const { createThreadedLifecycle } = await import('../apps/server/src/threaded/lifecycle.ts');
const { createExecutionResourceCoordinator } = await import('../apps/server/src/execution/resources/coordinator.ts');
const schema = await readFile(new URL('../apps/server/src/db/schema.sql', import.meta.url), 'utf8');
const workers = [], databases = [], checks = [], stamp = new Date().toISOString();
const outputIndex = process.argv.indexOf('--report');
const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'docs/reports/evidence/threaded-rc06/concurrency.json');
const digest = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
let failed = null;
async function worker(index) {
  const child = fork(fileURLToPath(new URL('./fixtures/threadedRc06ResourceWorker.mjs', import.meta.url)), [], {
    execArgv: ['--import', fileURLToPath(new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url))],
    env: { PATH: process.env.PATH, NODE_ENV: 'test', LOG_LEVEL: 'silent', AGENT_GAND_ISOLATED_WORKER: '1',
      DB_PATH: path.join(root, `unused-worker-${index}.sqlite`), AGENTS_DIR: path.join(root, 'agents') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let seq = 0, stderr = '', resolveReady, rejectReady;
  const pending = new Map(), diagnostics = { index, pid: child.pid, calls: 0, databasesOpened: 0 };
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.on('message', m => {
    if (m.ready) { resolveReady(); return; }
    const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })); else p.resolve(m.result);
  });
  const crash = e => { rejectReady(e); for (const p of pending.values()) p.reject(e); pending.clear(); };
  child.on('error', crash);
  child.on('exit', (code, signal) => { if (code !== 0 || signal) crash(new Error(`RC06_WORKER_EXIT_${code}_${signal}: ${stderr}`)); });
  const w = { child, diagnostics, exit,
    call(operation, ...args) {
      diagnostics.calls++; if (operation === 'open') diagnostics.databasesOpened++;
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RC06_WORKER_TIMEOUT_${operation}`)); }, 30_000);
        pending.set(id, { resolve(v) { clearTimeout(timer); resolve(v); }, reject(e) { clearTimeout(timer); reject(e); } });
        child.send({ id, operation, args });
      });
    },
  };
  workers.push(w); await ready; return w;
}
async function fixture(name, policy) {
  await Promise.all(workers.map(w => w.call('closeDatabase')));
  const file = path.join(root, `${name}.sqlite`), db = new Database(file, { timeout: 10_000 }); databases.push(db);
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.exec(schema);
  db.exec('ALTER TABLE accounts ADD COLUMN identity_generation INTEGER'); applyOrchestrationSchemaMigrations(db);
  for (const id of ['a','b','c','d','e','f','g','h']) db.prepare(`INSERT INTO agents(id,name,definition,source,created_at,updated_at)
    VALUES(?,?,?,'fixture',?,?)`).run(id, id, JSON.stringify({ id, name:id, version:1, enabled:true,
      model:'mock:fixture', tools:[], permissionMode:'readonly', systemPrompt:'RC06 coordinator fixture' }), stamp, stamp);
  db.prepare(`INSERT INTO accounts(id,display_name,provider,auth_type,source,version,config_version,credential_version,created_at,updated_at)
    VALUES('account','Synthetic','mock','api_key','managed',1,1,1,?,?)`).run(stamp, stamp);
  const store = createThreadedStore(db), ownerId = store.getInstanceOwnerId();
  const resources = createExecutionResourceCoordinator(db, { ownerNonce: `rc06-parent:${name}` });
  const lifecycle = createThreadedLifecycle(db, createThreadedAuthority(db, resources), { resources });
  if (policy) resources.configurePolicy(ownerId, policy, 1);
  const threads = new Map();
  function thread(alias) {
    if (!threads.has(alias)) {
      const t = store.createThread({ title:`RC06 ${name} ${alias}`, members:['a','b','c','d','e','f','g','h'].map(agentId =>
        ({agentId,handle:agentId,roleVersion:1,permissionVersion:1})) });
      db.prepare("UPDATE threaded_threads SET state='open' WHERE id=?").run(t.id); threads.set(alias,t);
    }
    return threads.get(alias);
  }
  function request(values = {}) {
    const { alias = 'A', agentId = 'a', mode = 'threaded', ...rest } = values;
    let runId, invocationId, threadId;
    if (mode === 'legacy') {
      runId = randomUUID(); db.prepare("INSERT INTO runs(id,goal,mode,status,agent_ids,created_at) VALUES(?,'RC06','collaboration','running',?,?)")
        .run(runId,JSON.stringify([agentId]),stamp);
    } else {
      const t=thread(alias), inv=lifecycle.createInvocation({ownerId,threadId:t.id,agentId,causalRootId:randomUUID(),goal:name});
      runId=inv.runId; invocationId=inv.id; threadId=t.id;
    }
    return { requestKey:randomUUID(), operationId:randomUUID(),mode,ownerId,agentId,runId,attemptId:randomUUID(),
      ...(threadId?{threadId,invocationId}:{}), accountId:'account',capacity:true,...rest };
  }
  const snapshot = () => ({ tickets:db.prepare('SELECT id,seq,request_key,operation_id,status,request_hash FROM execution_resource_tickets ORDER BY seq').all(),
    claims:db.prepare('SELECT id,ticket_id,owner_nonce,generation,state FROM execution_resource_claims ORDER BY generation').all(),
    items:db.prepare('SELECT claim_id,resource_key,kind,access,generation FROM execution_resource_claim_items ORDER BY claim_id,resource_key').all(),
    fairness:db.prepare('SELECT lane,last_served FROM execution_resource_fairness ORDER BY lane').all(),
    availability:db.prepare('SELECT seq,reason,agent_id FROM execution_resource_availability ORDER BY seq').all() });
  await Promise.all(workers.map(w=>w.call('open',file)));
  const bindings=new Map();
  function command(holder,workspaces){
    if(!bindings.has(holder.claimId))bindings.set(holder.claimId,lifecycle.prepareAttempt({ownerId,invocationId:holder.invocationId,claim:holder}));
    const binding=bindings.get(holder.claimId),id=randomUUID(),actionId=randomUUID(),registrationId=`command-${id}`,now=Date.now();
    db.prepare(`INSERT INTO threaded_actions(id,owner_id,thread_id,subject_key,family,slot,generation,version,state,root_id,created_at,updated_at)
      VALUES(?,?,?,?,'work','primary',1,1,'active',?,?,?)`).run(actionId,ownerId,binding.threadId,`fixture:${id}`,`fixture-root:${id}`,now,now);
    db.prepare('INSERT INTO threaded_action_generations(action_id,generation,record,created_at) VALUES(?,1,?,?)').run(actionId,'{}',now);
    db.prepare('INSERT INTO threaded_action_holders(action_id,generation,agent_id) VALUES(?,1,?)').run(actionId,binding.agentId);
    db.prepare(`INSERT INTO threaded_commands(id,owner_id,thread_id,agent_id,action_id,generation,binding_id,port,authorization,args,source_record,state,version,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?,?,'{}','{}','running',1,?,?)`).run(id,ownerId,binding.threadId,binding.agentId,actionId,binding.id,registrationId,'synthetic-registration',now,now);
    const sorted=[...workspaces].sort((a,b)=>a.path.localeCompare(b.path));
    db.prepare(`INSERT INTO threaded_os_commands(command_id,registration_id,authorization,owner_id,thread_id,agent_id,binding_id,registration_hash,state,record,created_at,updated_at)
      VALUES(?,?,'synthetic-registration',?,?,?,?,?,'running',?,?,?)`).run(id,registrationId,ownerId,binding.threadId,binding.agentId,binding.id,digest(sorted),
        JSON.stringify({cwd:sorted.find(w=>w.access==='write')?.path??sorted[0].path,workspaceClaims:sorted}),now,now);
    return {requestKey:randomUUID(),operationId:randomUUID(),mode:'threaded',ownerId,threadId:binding.threadId,
      agentId:binding.agentId,invocationId:binding.invocationId,runId:binding.runId,attemptId:binding.attemptId,
      capacity:false,threadedCommand:{commandId:id,registrationId},workspaces:sorted};
  }
  return {name,file,db,ownerId,resources,request,command,snapshot,held:()=>resources.listClaims(),
    ticket:r=>resources.enqueue(r), checked() {assert.deepEqual(db.pragma('foreign_key_check'),[]);} };
}
async function race(operation, values, selected = workers.slice(0,values.length)) {
  await Promise.all(selected.map((w,i)=>w.call('arm',operation,values[i])));
  const notBefore=Date.now()+100;
  return Promise.all(selected.map(w=>w.call('runArmed',notBefore)));
}
async function group(id, fn) {
  const began=Date.now();
  try {const evidence=await fn();checks.push({id,passed:true,elapsedMs:Date.now()-began,...evidence});}
  catch(e){failed={id,code:e.code??null,message:e.message};throw e;}
}
try {
  await Promise.all(Array.from({length:8},(_,i)=>worker(i)));
  assert.equal(new Set(workers.map(w=>w.diagnostics.pid)).size,8);
  await group('RC06-C01-eight-process-same-key',async()=>{
    const f=await fixture('same-key'), r=f.request();
    const tickets=await race('enqueue',workers.map(()=>[r]));
    assert.equal(new Set(tickets.map(t=>t.id)).size,1); assert.equal(f.snapshot().tickets.length,1);
    const claims=await race('tryAcquire',workers.map(()=>[tickets[0].id]));
    assert.equal(claims.filter(Boolean).length,1); const winner=claims.findIndex(Boolean),claim=claims[winner];
    const again=await workers[winner].call('tryAcquire',tickets[0].id);assert.deepEqual(again,claim);
    assert.equal(f.held().length,1);assert.equal(f.snapshot().items.filter(i=>i.resource_key==='capacity:global').length,1);
    await workers[winner].call('releaseNotStarted',claim);f.checked();
    return {processes:8,oneTicket:true,oneClaim:true,capacityChargedOnce:true,winnerPid:workers[winner].diagnostics.pid,state:f.snapshot()};
  });
  await group('RC06-C02-eight-process-conflicting-retry',async()=>{
    const f=await fixture('conflict'),r=f.request(), ticket=f.ticket(r);
    await Promise.all(workers.map((w,i)=>w.call('arm','enqueue',[i%2?{...r,operationId:randomUUID()}:r])));
    const notBefore=Date.now()+100;
    const results=await Promise.allSettled(workers.map(w=>w.call('runArmed',notBefore)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,4);
    for(const result of results.filter(r=>r.status==='fulfilled'))assert.equal(result.value.id,ticket.id);
    for(const result of results.filter(r=>r.status==='rejected'))assert.equal(result.reason.code,'RESOURCE_IDEMPOTENCY_CONFLICT');
    assert.equal(f.snapshot().tickets.length,1);assert.equal(f.held().length,0);f.checked();
    return {processes:8,exactReplays:4,conflicts:4,noPartialClaims:true,state:f.snapshot()};
  });
  await group('RC06-C03-same-slot-fifo-and-old-finally',async()=>{
    const f=await fixture('same-slot'),tickets=workers.map(()=>f.ticket(f.request()));
    const results=await race('tryAcquire',tickets.map(t=>[t.id]));
    assert.ok(results[0]);assert.equal(results.filter(Boolean).length,1);assert.equal(f.held().length,1);
    const first=results[0],proof=await workers[0].call('releaseNotStarted',first);
    const next=await workers[1].call('tryAcquire',tickets[1].id);assert.ok(next);assert.ok(next.generation>first.generation);
    await workers[0].call('releaseAgain',first,proof);await workers[1].call('assertCurrent',next);
    assert.equal(f.held().length,1);await workers[1].call('releaseNotStarted',next);f.checked();
    return {processes:8,earliestTicketWins:true,lateFinallyCannotReleaseSuccessor:true,state:f.snapshot()};
  });
  await group('RC06-C04-cross-thread-same-agent-capacity',async()=>{
    const f=await fixture('cross-thread'),tickets=workers.map((_,i)=>f.ticket(f.request({alias:`T${i}`})));
    const claims=await race('tryAcquire',tickets.map(t=>[t.id]));
    // A worker may check before an earlier fairness turn commits. Retry only
    // empty tickets in frozen FIFO order; no active holder is released here.
    for(let i=0;i<claims.length;i++)if(!claims[i])claims[i]=await workers[i].call('tryAcquire',tickets[i].id);
    assert.equal(claims.filter(Boolean).length,3);assert.equal(f.held().length,3);
    assert.equal(new Set(f.held().map(c=>c.request.threadId)).size,3);
    assert.ok(f.held().every(c=>c.request.agentId==='a'));
    const active=claims.findIndex(Boolean),released=claims[active];await workers[active].call('releaseNotStarted',released);
    const waiting=claims.findIndex(c=>!c),next=await workers[waiting].call('tryAcquire',tickets[waiting].id);assert.ok(next);
    assert.equal(f.held().length,3);f.checked();
    return {processes:8,sameAgent:true,parallelThreadSlots:3,globalAndAccountLimit:3,releasedCapacityReused:true,state:f.snapshot()};
  });
  await group('RC06-C05-legacy-exclusive-barrier',async()=>{
    const f=await fixture('exclusive'),activeTicket=f.ticket(f.request({alias:'active'}));
    const active=await workers[0].call('tryAcquire',activeTicket.id);assert.ok(active);
    const exclusive=f.ticket(f.request({mode:'legacy'})),incoming=workers.slice(1).map((_,i)=>f.ticket(f.request({alias:`new-${i}`})));
    assert.equal(await workers[1].call('tryAcquire',exclusive.id),null);
    assert.ok((await race('tryAcquire',incoming.map(t=>[t.id]),workers.slice(1))).every(v=>v===null));
    await workers[0].call('releaseNotStarted',active);
    assert.ok((await race('tryAcquire',incoming.map(t=>[t.id]),workers.slice(1))).every(v=>v===null));
    const old=await workers[0].call('tryAcquire',exclusive.id);assert.ok(old);
    assert.ok((await race('tryAcquire',incoming.map(t=>[t.id]),workers.slice(1))).every(v=>v===null));
    await workers[0].call('releaseNotStarted',old);assert.ok(await workers[1].call('tryAcquire',incoming[0].id));f.checked();
    return {processes:8,olderExclusiveCannotStarve:true,newThreadCannotOvertake:true,state:f.snapshot()};
  });
  await group('RC06-C06-durable-thread-fairness',async()=>{
    const f=await fixture('fairness',{globalLimit:1});
    const a1=f.ticket(f.request({alias:'hot'})),a2=f.ticket(f.request({alias:'hot'})),a3=f.ticket(f.request({alias:'hot'}));
    const b=f.ticket(f.request({alias:'B',agentId:'b'})),c=f.ticket(f.request({alias:'C',agentId:'c'}));
    const first=await workers[0].call('tryAcquire',a1.id);assert.ok(first);await workers[0].call('releaseNotStarted',first);
    await workers[7].call('closeDatabase');await workers[7].call('open',f.file);
    assert.equal(await workers[1].call('tryAcquire',a2.id),null);
    const second=await workers[7].call('tryAcquire',b.id);assert.ok(second);await workers[7].call('releaseNotStarted',second);
    assert.equal(await workers[1].call('tryAcquire',a2.id),null);
    const third=await workers[2].call('tryAcquire',c.id);assert.ok(third);await workers[2].call('releaseNotStarted',third);
    const fourth=await workers[1].call('tryAcquire',a2.id);assert.ok(fourth);assert.equal(await workers[3].call('tryAcquire',a3.id),null);f.checked();
    return {serviceOrder:['hot-1','B','C','hot-2'],coordinatorConnectionRebuilt:true,starvationBound:'finite five-ticket fixture only',state:f.snapshot()};
  });
  await group('RC06-C07-same-native-resource-different-policy',async()=>{
    const f=await fixture('same-native'),nativeId=randomUUID(),resourceKey=`claude-sdk:fixture-account:g1:fixture-host:${nativeId}`;
    const sessions=['policy-one','policy-two'].map(id=>({id,version:1,nativeId,resourceKey}));
    for(const session of sessions)f.db.prepare(`INSERT INTO execution_resource_sessions(id,owner_id,binding_key,version,native_id,resource_key,state,record,updated_at)
      VALUES(?,?,?,1,?,?,'ready','{}',?)`).run(session.id,f.ownerId,session.id,nativeId,resourceKey,Date.now());
    const tickets=sessions.map((session,i)=>f.ticket(f.request({alias:`T${i}`,agentId:i?'b':'a',session})));
    const results=await race('tryAcquire',tickets.map(t=>[t.id]),workers.slice(0,2));assert.ok(results[0]);assert.equal(results[1],null);
    assert.equal(f.held().length,1);const proof=await workers[0].call('releaseNotStarted',results[0]);
    const next=await workers[1].call('tryAcquire',tickets[1].id);assert.ok(next);await workers[0].call('releaseAgain',results[0],proof);
    await workers[1].call('assertCurrent',next);assert.equal(f.held().length,1);f.checked();
    return {differentPolicyIdsSameResourceKey:true,oneNativeResourceOwner:true,lateFinallySafe:true,
      scope:'Actual coordinator Session metadata/fence; synthetic native ID, no SDK process or actual resume',state:f.snapshot()};
  });
  await group('RC06-C08-cancel-waiter-A-preserves-B',async()=>{
    const f=await fixture('cancel-A',{globalLimit:1}),b=f.ticket(f.request({alias:'B',agentId:'b'}));
    const holder=await workers[1].call('tryAcquire',b.id);assert.ok(holder);
    const a=f.ticket(f.request({alias:'A'})),c=f.ticket(f.request({alias:'C',agentId:'c'}));
    await workers[0].call('cancelTicket',a.id);assert.equal(f.resources.getTicket(a.id).status,'cancelled');
    await workers[1].call('assertExecutable',holder);assert.equal(f.held().length,1);
    await assert.rejects(workers[0].call('cancelTicket',b.id),e=>e.code==='RESOURCE_ACTIVE_CANCELLATION_REQUIRES_QUIESCENCE');
    assert.equal(await workers[0].call('tryAcquire',a.id),null);assert.equal(await workers[2].call('tryAcquire',c.id),null);
    await workers[1].call('releaseNotStarted',holder);assert.ok(await workers[2].call('tryAcquire',c.id));f.checked();
    return {onlyWaitingTicketACancelled:true,BUnchangedAndExecutable:true,activeCancellationCannotFakeQuiescence:true,
      scope:'Resource queue cancellation; API/SDK active Invocation cancellation covered separately',state:f.snapshot()};
  });
  await group('RC06-C09-preparation-capacity-requeue',async()=>{
    const f=await fixture('preparation',{globalLimit:1}),prepRequest=f.request({mode:'legacy',capacity:false});
    const prepTicket=f.ticket(prepRequest),prep=await workers[0].call('tryAcquire',prepTicket.id);assert.ok(prep);
    const childRequest=f.request({mode:'legacy',runId:prep.runId,attemptId:prep.attemptId,parentClaim:prep});
    const child=f.ticket(childRequest),call=await workers[1].call('tryAcquire',child.id);assert.ok(call);
    assert.equal(f.held().filter(c=>c.request.capacity!==false).length,1);
    await assert.rejects(workers[0].call('releaseNotStarted',prep),e=>e.code==='RESOURCE_CHILDREN_NOT_RELEASED');
    await workers[1].call('releaseNotStarted',call);const proof=await workers[0].call('releaseNotStarted',prep);
    const reopened=await workers[2].call('requeuePreparation',prepTicket.id);assert.equal(reopened.seq,prepTicket.seq);
    const successor=await workers[2].call('tryAcquire',prepTicket.id);assert.ok(successor);assert.ok(successor.generation>prep.generation);
    await workers[0].call('releaseAgain',prep,proof);await workers[2].call('assertCurrent',successor);
    assert.equal(f.held().filter(c=>c.request.capacity!==false).length,0);f.checked();
    return {preparationNotCharged:true,actualCallChargedOnce:true,parentWaitsForChild:true,requeueKeepsAge:true,oldFinallySafe:true,state:f.snapshot()};
  });
  await group('RC06-C10-release-reentrant-enqueue-and-missed-cursor',async()=>{
    const f=await fixture('notifications',{globalLimit:1}),a=f.ticket(f.request({alias:'A'}));
    const active=await workers[0].call('tryAcquire',a.id);assert.ok(active);
    const b=f.ticket(f.request({alias:'B',agentId:'b'})),cRequest=f.request({alias:'C',agentId:'c'});
    const before=await workers[7].call('scanPending',0);
    await workers[0].call('watchRelease',b.id,cRequest);await workers[0].call('releaseNotStarted',active);
    const first=await workers[0].call('notifications');assert.deepEqual(first.failures,[]);assert.ok(first.injectedTicket);
    assert.ok(first.acquired[b.id]);assert.equal(first.acquired[first.injectedTicket.id],undefined);
    await workers[0].call('releaseNotStarted',first.acquired[b.id]);
    const second=await workers[0].call('notifications');assert.deepEqual(second.failures,[]);assert.ok(second.acquired[first.injectedTicket.id]);
    assert.ok(second.events.some(e=>e.reason==='enqueued'&&e.agentId==='c'));assert.equal(second.timerScannerCalls,0);
    const recovered=await workers[7].call('scanPending',before.cursor);
    assert.ok(recovered.events.some(e=>e.reason==='enqueued'&&e.agentId==='c'));assert.ok(recovered.events.filter(e=>e.reason==='released').length>=2);
    assert.equal(new Set(recovered.events.map(e=>e.seq)).size,recovered.events.length);f.checked();
    return {releaseListenerReentered:true,beforeC:'B',CEventuallyAcquired:true,noTimerScanner:true,
      crossConnectionMissedEventsRecovered:true,notifications:second,recovered,state:f.snapshot()};
  });
  async function commandPaths(name){
    const base=path.join(root,name),source=path.join(base,'project'),child=path.join(source,'child'),outA=path.join(base,'output-a'),outB=path.join(base,'output-b');
    for(const p of[child,outA,outB])await mkdir(p,{recursive:true});return {source,child,outA,outB};
  }
  await group('RC06-C11-command-unrelated-model-does-not-take-second-turn',async()=>{
    const f=await fixture('command-model'),p=await commandPaths('command-model');
    const a=f.ticket(f.request({alias:'A',workspaces:[{path:p.source,access:'read'}]}));
    const b=f.ticket(f.request({alias:'B',agentId:'b',workspaces:[{path:p.source,access:'read'}]}));
    const holder=await workers[0].call('tryAcquire',a.id);assert.ok(holder);
    const request=f.command(holder,[{path:p.source,access:'read'},{path:p.outA,access:'write'}]),command=f.ticket(request);
    const fairnessBefore=f.snapshot().fairness,modelCapacityBefore=f.held().filter(c=>c.request.capacity!==false).length;
    const claimed=await workers[1].call('tryAcquire',command.id);assert.ok(claimed,'An unrelated model candidate cannot block independently prepared command resources');
    assert.deepEqual(f.snapshot().fairness,fairnessBefore);assert.equal(f.held().filter(c=>c.request.capacity!==false).length,modelCapacityBefore);
    assert.equal(f.snapshot().items.filter(i=>i.claim_id===claimed.claimId&&i.kind==='capacity').length,0);
    assert.ok(await workers[2].call('tryAcquire',b.id));f.checked();
    return {unrelatedEarlierModelTicket:b.id,commandAcquired:true,noExtraModelCapacity:true,noExtraFairnessTurn:true,
      scope:'Synthetic registered command intent and actual persisted execution Binding; no native launch',state:f.snapshot()};
  });
  for(const direction of['ancestor','descendant'])await group(`RC06-C${direction==='ancestor'?'12':'13'}-command-respects-older-${direction}-writer`,async()=>{
    const f=await fixture(`command-${direction}`),p=await commandPaths(`command-${direction}`);
    const commandRead=direction==='ancestor'?p.child:p.source,writerPath=direction==='ancestor'?p.source:p.child;
    const a=f.ticket(f.request({alias:'A',workspaces:[{path:commandRead,access:'read'}]}));
    const holder=await workers[0].call('tryAcquire',a.id);assert.ok(holder);
    const writer=f.ticket(f.request({alias:'writer',agentId:'b',workspaces:[{path:writerPath,access:'write'}]}));
    const command=f.ticket(f.command(holder,[{path:commandRead,access:'read'},{path:p.outA,access:'write'}]));
    assert.equal(await workers[1].call('tryAcquire',writer.id),null,'Original reader blocks the older writer');
    assert.equal(await workers[2].call('tryAcquire',command.id),null,'A younger command may not overtake an older conflicting writer even while it is blocked');
    await workers[0].call('releaseNotStarted',holder);
    const writerClaim=await workers[1].call('tryAcquire',writer.id);assert.ok(writerClaim);
    assert.equal(await workers[2].call('tryAcquire',command.id),null,'An active parent/child writer remains mutually exclusive');
    await workers[1].call('releaseNotStarted',writerClaim);const claimed=await workers[2].call('tryAcquire',command.id);assert.ok(claimed);f.checked();
    return {olderWriterPath:writerPath,commandReadPath:commandRead,blockedBeforeAndDuringWriter:true,commandAcquiredAfterWriterRelease:true,state:f.snapshot()};
  });
  await group('RC06-C14-command-same-key-pending-cannot-overtake',async()=>{
    const f=await fixture('command-same-key'),p=await commandPaths('command-same-key');
    const a=f.ticket(f.request()),holder=await workers[0].call('tryAcquire',a.id);assert.ok(holder);
    const request=f.command(holder,[{path:p.source,access:'read'},{path:p.outA,access:'write'}]);
    const older=f.ticket(request),younger=f.ticket({...request,requestKey:randomUUID(),operationId:randomUUID()});
    assert.equal(await workers[2].call('tryAcquire',younger.id),null);
    const first=await workers[1].call('tryAcquire',older.id);assert.ok(first);
    assert.equal(await workers[2].call('tryAcquire',younger.id),null);
    const proof=await workers[1].call('releaseNotStarted',first),next=await workers[2].call('tryAcquire',younger.id);assert.ok(next);
    await workers[1].call('releaseAgain',first,proof);await workers[2].call('assertCurrent',next);f.checked();
    return {sameCommandResourceKey:true,olderTicketServedFirst:true,activeSameCommandExcluded:true,oldFinallySafe:true,state:f.snapshot()};
  });
  await group('RC06-C15-command-does-not-cross-legacy-exclusive',async()=>{
    const f=await fixture('command-legacy'),p=await commandPaths('command-legacy');
    const a=f.ticket(f.request()),holder=await workers[0].call('tryAcquire',a.id);assert.ok(holder);
    const legacy=f.ticket(f.request({mode:'legacy'}));
    const command=f.ticket(f.command(holder,[{path:p.source,access:'read'},{path:p.outA,access:'write'}]));
    assert.equal(await workers[2].call('tryAcquire',command.id),null);
    await workers[0].call('releaseNotStarted',holder);assert.equal(await workers[2].call('tryAcquire',command.id),null);
    const old=await workers[1].call('tryAcquire',legacy.id);assert.ok(old);
    assert.equal(await workers[2].call('tryAcquire',command.id),null);await workers[1].call('releaseNotStarted',old);
    assert.ok(await workers[2].call('tryAcquire',command.id));f.checked();
    return {olderSameAgentLegacyBarrierRetained:true,commandAcquiredOnlyAfterLegacyRelease:true,state:f.snapshot()};
  });
  await group('RC06-C16-command-read-read-can-prepare-in-parallel',async()=>{
    const f=await fixture('command-read-read'),p=await commandPaths('command-read-read');
    const a=f.ticket(f.request({workspaces:[{path:p.source,access:'read'}]})),holder=await workers[0].call('tryAcquire',a.id);assert.ok(holder);
    const older=f.ticket(f.command(holder,[{path:p.child,access:'read'},{path:p.outA,access:'write'}]));
    const younger=f.ticket(f.command(holder,[{path:p.source,access:'read'},{path:p.outB,access:'write'}]));
    const fairnessBefore=f.snapshot().fairness;
    const second=await workers[2].call('tryAcquire',younger.id);assert.ok(second,'Parent/child read/read and disjoint outputs do not create a writer barrier');
    const first=await workers[1].call('tryAcquire',older.id);assert.ok(first);assert.deepEqual(f.snapshot().fairness,fairnessBefore);
    assert.equal(f.held().filter(c=>c.request.capacity!==false).length,1);assert.equal(f.held().length,3);f.checked();
    return {parentChildReadReadShared:true,disjointOutputWritersParallel:true,noExtraCapacity:true,noExtraFairnessTurn:true,state:f.snapshot()};
  });
  assert.equal(networkCalls,0);
} catch(error) { failed??={id:'initialization',code:error.code??null,message:error.message}; }
finally {
  const exits=await Promise.allSettled(workers.map(async w=>{
    if(w.child.connected){const result=await w.call('close');w.diagnostics.networkCalls=result.networkCalls;}
    let timer;
    try{return await Promise.race([w.exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('RC06_WORKER_CLOSE_TIMEOUT')),5000);})]);}
    finally{clearTimeout(timer);}
  }));
  for(let i=0;i<exits.length;i++){
    const result=exits[i];
    if(result.status==='fulfilled')workers[i].diagnostics.exit=result.value;
    if(result.status==='rejected'||result.value.code!==0||result.value.signal||workers[i].diagnostics.networkCalls!==0)
      failed??={id:'cleanup',code:'RC06_WORKER_NOT_CLEAN',message:result.status==='rejected'?result.reason.message:'Worker exit or network count differs from expected'};
  }
  for(const w of workers)if(w.child.connected)w.child.kill('SIGKILL');
  for(const db of databases)if(db.open)db.close();globalThis.fetch=originalFetch;
  const report={ok:!failed,groups:checks.length,checks,failed,startedAt:stamp,completedAt:new Date().toISOString(),
    actualWorkerProcesses:new Set(workers.map(w=>w.diagnostics.pid)).size,workers:workers.map(w=>w.diagnostics),
    networkCalls:networkCalls+workers.reduce((n,w)=>n+(w.diagnostics.networkCalls??0),0),
    realModelCalls:0,realModelTokens:0,remoteWrites:0,dailyDatabaseRead:false,dailyConfigurationChanged:false,
    scope:'Eight actual independent Node PIDs/SQLite connections exercise the production durable coordinator with synthetic server-owned metadata; no business HTTP main process, SDK/native resume, supplier or engineering writer',
    limits:['finite bounded race/fairness fixtures, not a starvation proof for unbounded workloads',
      'not_started proof only: no SDK process-stop or remote request evidence is fabricated',
      'same-native test verifies resource locking with a synthetic native ID; actual SDK double resume requires separate acceptance'],
    checksSha256:digest(checks)};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');
  await rm(root,{recursive:true,force:true});console.log(JSON.stringify({ok:report.ok,groups:report.groups,actualWorkerProcesses:report.actualWorkerProcesses,
    checks:checks.map(({id,passed})=>({id,passed})),failed,report:output},null,2));
  if(failed)process.exitCode=1;
}
