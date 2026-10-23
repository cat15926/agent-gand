import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Database from '../apps/server/node_modules/better-sqlite3/lib/index.js';
import {openRc05Storage} from './fixtures/threadedRc05Storage.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc05-storage-'))),fixtures=[],checks=[],evidence=[];
const originalFetch=globalThis.fetch;let forbiddenNetworkCalls=0;
globalThis.fetch=async()=>{forbiddenNetworkCalls++;throw new Error('RC05 storage direct network forbidden');};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check=(id,description)=>checks.push({id,description,passed:true});
const fixture=async name=>{const f=await openRc05Storage(root,name);fixtures.push(f);return f;};
function snapshot(f,label){const value=f.snapshot();assert.deepEqual(value.foreignKeys,[]);evidence.push({label,...value,digest:hash(value)});return value;}
function noPublishedCompletion(value){
  assert.equal(value.counts.threaded_outputs,0);assert.equal(value.counts.threaded_invocation_terminals,0);
  assert.equal(value.messages.filter(m=>m.origin==='agent_response').length,0);
  assert.equal(value.runs.filter(r=>r.finished_at!==null||r.status==='completed').length,0);
  assert.equal(value.wakes.length,1,'Only the original user Wake may exist');
}
async function recoverUnknownWithoutReplay(f,claim,label){
  const sends=f.transportCalls;await f.reopen();f.recover();f.recover();
  const after=snapshot(f,label);assert.equal(f.transportCalls,sends);assert.equal(f.claim(),null);
  assert.equal(after.invocations.find(i=>i.id===claim.binding.invocationId).status,'unknown');
  assert.equal(after.attempts.length,1);noPublishedCompletion(after);return after;
}
const trigger=(f,event,table,when='')=>f.db.exec(`CREATE TRIGGER rc05_storage_abort BEFORE ${event} ON ${table} ${when} BEGIN SELECT RAISE(ABORT,'rc05-storage-abort'); END;`);
const drop=f=>f.db.exec('DROP TRIGGER rc05_storage_abort');
const bounded=(promise,label)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`RC05 timeout: ${label}`)),10000);})]).finally(()=>clearTimeout(timer));};
const authorityDenied=e=>/^(THREADED|RESOURCE)_[A-Z0-9_]+$/.test(e.code??e.message??'');
try{
  {
    const f=await fixture('readonly-ingress'),before=snapshot(f,'Before SQLite query_only denial');
    f.db.pragma('query_only=ON');assert.throws(()=>f.user('Must not report success','readonly-request'),e=>e.code==='SQLITE_READONLY');
    f.db.pragma('query_only=OFF');const after=snapshot(f,'Readonly storage denies ingress with no durable message/root/wake/outbox');
    assert.deepEqual(after.counts,before.counts);assert.equal(f.claim(),null);assert.equal(f.transportCalls,0);await f.reopen();f.recover();assert.deepEqual(f.snapshot().counts,before.counts);
    check('ST01','Real SQLite query_only rejects production routing ingress; no receipt, message/root/Wake/outbox/Attempt or phantom completion survives factory rebuild.');
  }
  {
    const f=await fixture('locked-ingress'),other=new Database(f.file,{timeout:0});
    try{other.exec('BEGIN IMMEDIATE');const before=snapshot(f,'Before an independent SQLite writer holds the actual write lock');
      assert.throws(()=>f.user('Locked ingress','busy-request'),e=>e.code==='SQLITE_BUSY');const after=snapshot(f,'Actual SQLITE_BUSY creates no partial ingress');assert.deepEqual(after.counts,before.counts);
      other.exec('ROLLBACK');const accepted=f.user('Locked ingress','busy-request');const replay=f.user('Locked ingress','busy-request');assert.equal(accepted.message.id,replay.message.id);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_release_roots').get().n,1);assert.equal(f.transportCalls,0);
      check('ST02','Independent real SQLite writer causes SQLITE_BUSY with no false success; after lock release an exact idempotent ingress retry creates one root/message.');
    }finally{if(other.inTransaction)other.exec('ROLLBACK');other.close();}
  }
  {
    const points=[['output','INSERT','threaded_outputs',''],['response','INSERT','threaded_messages',"WHEN NEW.origin='agent_response'"],
      ['successor','INSERT','threaded_wakes',"WHEN NEW.target_agent_id LIKE '%-peer'"],['terminal','INSERT','threaded_invocation_terminals',''],
      ['run','UPDATE','runs',"WHEN NEW.finished_at IS NOT NULL"],['budget','INSERT','threaded_budget_outcomes',"WHEN NEW.kind='completed'"]];
    for(const [name,event,table,when] of points){
      const f=await fixture(`atomic-${name}`),receipt=f.user(`Atomic ${name}`),claim=f.claim();trigger(f,event,table,when);
      await assert.rejects(()=>f.execute(claim,{body:`@${f.peer} Unique successor must roll back at ${name}`}),e=>e.code==='SQLITE_CONSTRAINT_TRIGGER');
      const failed=snapshot(f,`SQLite transaction abort at ${name}: response/output/successor/terminal/Run/budget-outcome all absent`);
      assert.equal(f.transportCalls,1);noPublishedCompletion(failed);assert.equal(failed.counts.threaded_budget_outcomes,0);
      assert.equal(failed.budgets.length,1);assert.equal(failed.budgets[0].known_output,7);assert.equal(failed.budgets[0].known_cost,27);
      assert.equal(failed.budgets[0].outcome_hash,null,'No false terminal budget outcome');assert.equal(failed.budgets[0].execution_state,'quiescent','Request-level receipt/usage may settle before the Invocation publication transaction');
      assert.equal(failed.backend[0].state,'complete','Actual receipt/known usage remains separate from the rolled-back Invocation publication');
      assert.equal(failed.attempts[0].outcome_record,null);assert.equal(failed.claims[0].state,'quiescent','Verified physical quiescence is retained even if the later publication transaction aborts');
      assert.equal(failed.budgets[0].root_id,receipt.message.id);drop(f);
      const after=await recoverUnknownWithoutReplay(f,claim,`Factory rebuild after ${name} abort retains unknown, usage and resource fence; zero transport replay`);
      assert.equal(after.budgets[0].known_output,7);assert.equal(after.budgets[0].known_cost,27);assert.equal(after.budgets[0].usage_state,'settled');
      assert.equal(after.claims[0].state,'quiescent');
    }
    check('ST03','Six actual SQLite ABORT triggers at output/response/successor/terminal/Run/budget-outcome prove terminal publication rollback; verified supplier usage stays known, recovery remains unknown and never blindly replays.');
  }
  {
    const f=await fixture('release-fault'),receipt=f.user('Commit before resource release'),claim=f.claim();
    const saved=f.resources.release;f.resources.release=()=>{throw Object.assign(new Error('Injected coordinator release failure'),{code:'RC05_INJECTED_RELEASE_FAILURE'});};
    const result=await f.execute(claim,{body:`@${f.peer} Exactly one successor after committed result`});assert.equal(result.status,'completed');assert.equal(result.resourceReleasePending,true);f.resources.release=saved;
    const before=snapshot(f,'Terminal and one successor committed atomically before resource release failure');
    assert.equal(before.counts.threaded_invocation_terminals,1);assert.equal(before.counts.threaded_outputs,1);assert.equal(before.messages.filter(m=>m.origin==='agent_response').length,1);
    assert.equal(before.wakes.length,2);assert.equal(before.runs[0].status,'completed');assert.ok(before.runs[0].finished_at);assert.equal(before.budgets[0].execution_state,'quiescent');
    assert.equal(before.budgets[0].known_output,7);assert.equal(before.budgets[0].known_cost,27);assert.equal(before.attempts[0].resource_release_state,'pending');
    await f.reopen();f.recover();f.recover();const repaired=snapshot(f,'Factory rebuild repairs release only; terminal/output/response/successor and usage IDs unchanged');
    assert.equal(repaired.attempts[0].resource_release_state,'released');assert.equal(f.transportCalls,1);
    for(const field of ['messages','wakes','terminals','outputs','runs','budgets','budgetOutcomes'])assert.deepEqual(repaired[field],before[field],`No ${field} replacement/duplication during release repair`);
    const successor=f.claim();assert.ok(successor);assert.equal(successor.binding.agentId,f.peer);assert.equal(successor.queue.causalRootId,receipt.message.id);
    assert.equal((await f.execute(successor)).status,'completed');f.recover();assert.equal(f.claim(),null);
    const after=snapshot(f,'Original successor executes once under original cumulative root');assert.equal(after.counts.threaded_budget_roots,1);assert.equal(after.counts.threaded_invocation_terminals,2);
    assert.equal(after.budgets.reduce((sum,r)=>sum+r.known_output,0),14);assert.equal(after.budgets.reduce((sum,r)=>sum+r.known_cost,0),54);assert.equal(f.transportCalls,2);
    check('ST04','Post-commit coordinator release failure preserves response/successor/terminal/Run/known cost atomically; rebuild repairs only the exact release and the original-root successor runs once.');
  }
  {
    const f=await fixture('reservation-fault');f.user('Storage fault before request barrier');const claim=f.claim();trigger(f,'INSERT','threaded_backend_requests');
    const result=await f.execute(claim);drop(f);const after=snapshot(f,'Request-evidence reservation transaction aborts before transport');
    assert.equal(f.transportCalls,0);assert.notEqual(result.status,'completed');assert.equal(after.backend.length,0);assert.equal(after.messages.filter(m=>m.origin==='agent_response').length,0);
    assert.ok(after.budgets.every(r=>r.known_output===0&&r.known_cost===0&&r.execution_state==='not_started'));
    const sends=f.transportCalls;await f.reopen();f.recover();assert.equal(f.transportCalls,sends);assert.equal(f.claim(),null);
    check('ST05','Actual request-evidence INSERT abort rolls back the send barrier and sends zero requests; it cannot publish a response or charge nonexistent output/cost.');
  }
  {
    const f=await fixture('receipt-fault');f.user('Response arrived but receipt cannot persist');const claim=f.claim();
    trigger(f,'UPDATE','threaded_backend_requests',"WHEN NEW.state='complete'");const result=await f.execute(claim);drop(f);
    const failed=snapshot(f,'Injected SQLite complete-receipt failure keeps response unknown and supplier limits reserved');
    assert.notEqual(result.status,'completed');assert.equal(f.transportCalls,1);assert.equal(failed.backend[0].state,'unknown');
    assert.equal(failed.budgets[0].known_output,null);assert.equal(failed.budgets[0].known_cost,null);assert.equal(failed.budgets[0].usage_state,'unknown');noPublishedCompletion(failed);
    await recoverUnknownWithoutReplay(f,claim,'Receipt persistence failure is not zero usage/no-send; repeated recovery sends nothing');
    check('ST06','Model bytes received with failed receipt persistence never imply success/zero cost/no-send; durable unknown usage keeps its reserve and recovery issues no replacement request.');
  }
  {
    const f=await fixture('approval-storage');f.user('Approval decision storage fault');const claim=f.claim();let release,ready;
    const gate=new Promise(resolve=>{release=resolve;}),pending=new Promise(resolve=>{ready=resolve;});
    const running=f.execute(claim,{beforeResponse:async()=>{const approval=f.production.lifecycle.registerApproval(claim.binding,{requestKey:'rc05-approval'});ready(approval);await gate;}});
    const approval=await bounded(pending,'approval pending');f.db.pragma('query_only=ON');
    const decision={ownerId:f.ownerId,threadId:f.thread.id,approvalId:approval.id,decision:'approve',requestId:'rc05-approval-decision'};
    assert.throws(()=>f.production.lifecycle.decideApproval(decision),e=>e.code==='SQLITE_READONLY');f.db.pragma('query_only=OFF');
    const denied=snapshot(f,'Readonly approval decision cannot report approved or resume driver');assert.equal(denied.approvals[0].status,'pending');assert.equal(denied.runs[0].status,'awaiting_approval');
    const approved=f.production.lifecycle.decideApproval(decision);assert.equal(approved.status,'approved');assert.deepEqual(f.production.lifecycle.decideApproval(decision),approved);
    f.production.lifecycle.resumeAfterApproval(approval.id);release();assert.equal((await bounded(running,'approved original driver')).status,'completed');assert.equal(f.transportCalls,1);
    const after=snapshot(f,'Storage repaired: one idempotent approve resumes only its still-live original driver');assert.equal(after.counts.threaded_invocation_terminals,1);assert.equal(after.counts.threaded_approvals,1);
    check('ST07','Real readonly approval decision preserves pending/awaiting_approval; repaired exact Owner decision is idempotent and resumes the same live driver without another provider request.');
  }
  {
    for(const kind of ['permission','member-left','account']){
      const f=await fixture(`approval-revoke-${kind}`);f.user('Authority changes while approval is pending');const claim=f.claim();let release,ready;
      const gate=new Promise(resolve=>{release=resolve;}),pending=new Promise(resolve=>{ready=resolve;});
      const running=f.execute(claim,{beforeResponse:async()=>{const approval=f.production.lifecycle.registerApproval(claim.binding,{requestKey:'rc05-revoked-approval'});ready(approval);await gate;}});
      const approval=await bounded(pending,`${kind} approval pending`);f.restrict(kind);
      assert.throws(()=>f.production.lifecycle.decideApproval({ownerId:f.ownerId,threadId:f.thread.id,approvalId:approval.id,decision:'approve',requestId:randomUUID()}),authorityDenied);
      release();const result=await bounded(running,`${kind} old driver finish`);assert.notEqual(result.status,'completed');assert.equal(f.transportCalls,1);
      const before=snapshot(f,`${kind}: old approval cannot confer authority or publish stale response`);assert.equal(before.messages.filter(m=>m.origin==='agent_response').length,0);assert.equal(before.outputs.length,0);
      await f.reopen();f.recover();f.recover();assert.equal(f.claim(),null);assert.equal(f.transportCalls,1);assert.equal(f.snapshot().messages.filter(m=>m.origin==='agent_response').length,0);
      assert.throws(()=>f.production.lifecycle.resumeAfterApproval(approval.id),authorityDenied);
      snapshot(f,`${kind}: rebuilt production composition does not approve/replay/resurrect old driver`);
    }
    check('ST08','Pending approval under permission/member/account revocation cannot approve or publish the old response; rebuilt production authority grants no blind replay or old-driver resurrection.');
  }
  {
    const f=await fixture('capacity-full'),before=snapshot(f,'Before SQLite database page capacity exhaustion');
    const originalLimit=f.db.pragma('max_page_count',{simple:true}),pages=f.db.pragma('page_count',{simple:true});
    f.db.pragma(`max_page_count=${pages}`);
    assert.throws(()=>f.user('x'.repeat(262144),'full-request'),e=>e.code==='SQLITE_FULL');
    const full=snapshot(f,'Actual SQLITE_FULL under a disposable per-database page cap: no successful receipt or partial ingress');assert.deepEqual(full.counts,before.counts);assert.equal(f.transportCalls,0);
    f.db.pragma(`max_page_count=${originalLimit}`);await f.reopen();f.recover();assert.deepEqual(f.snapshot().counts,before.counts);
    const accepted=f.user('Capacity restored','repaired-capacity');assert.ok(accepted.message.id);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM threaded_release_roots').get().n,1);
    check('ST09','Actual SQLITE_FULL from a disposable max_page_count capacity cap rejects production ingress atomically; restoring capacity/reopening finds no phantom receipt and permits one fresh root.');
  }
  {
    const f=await fixture('midflight-readonly');f.user('Storage becomes readonly after the request crossed its send barrier');const claim=f.claim();
    await assert.rejects(()=>f.execute(claim,{beforeResponse:()=>{f.db.pragma('query_only=ON');}}),e=>e.code==='SQLITE_READONLY');
    f.db.pragma('query_only=OFF');const failed=snapshot(f,'After-send actual readonly failure prevents both receipt and lifecycle outcome persistence; no false completion');
    assert.equal(f.transportCalls,1);noPublishedCompletion(failed);assert.equal(failed.backend[0].state,'sending');assert.equal(failed.budgets[0].known_output,null);assert.equal(failed.budgets[0].known_cost,null);
    const after=await recoverUnknownWithoutReplay(f,claim,'Storage write capability restored: factory rebuild records unknown and preserves request reservation without replay');
    assert.equal(after.backend[0].state,'unknown');assert.equal(after.budgets[0].usage_state,'unknown');assert.equal(after.claims[0].state,'unknown');
    check('ST10','Actual SQLite readonly fault after send prevents receipt and unknown-outcome writes; execution rejects instead of reporting saved/completed, and repaired storage recovers unknown with its reserve/fence and zero blind resend.');
  }
  assert.equal(forbiddenNetworkCalls,0);
  const result={ok:true,groups:checks.length,checks,composition:'createThreadedProduction + durable release grants + production authority + real better-sqlite3',
    mainIndexProcess:false,actualChildProcesses:0,databaseReconnects:true,modelTransport:'injected deterministic Anthropic Messages response',
    realModelCalls:0,realSupplierTokens:0,remoteWrites:0,forbiddenNetworkCalls,fixtureActivityAllowanceMs:10000,productionDefaultActivityAllowanceMs:1000,
    storageFaults:{readonly:'Actual PRAGMA query_only rejects SQLite writes at ingress, approval decision and after-send receipt/outcome persistence',contention:'Independent real SQLite BEGIN IMMEDIATE writer causes SQLITE_BUSY',
      capacity:'Actual SQLITE_FULL caused by max_page_count at the disposable database current page count; the host disk is not filled',
      transactionAbort:'Real SQLite triggers execute RAISE(ABORT) at six terminal publication boundaries and backend request/receipt boundaries',
      resourceRelease:'Injected coordinator release exception after durable terminal commit'},
    limitations:['This is a rebuilt production factory with actual SQLite connection closes/reopens; it does not run apps/server/src/index.ts or terminate a PID.',
      'SQLite readonly/contention are real database errors. Trigger ABORT validates transaction rollback, not arbitrary disk-full, fsync, file-permission or physical media failure.',
      'Supplier transport and responses are deterministic injections; no real API/SDK/network or substantive model behavior is claimed.',
      'Only the disposable root receives a normal Owner budget CAS to a ten-second renewable activity slice; default one-second long-preparation behavior is not accepted by this suite.'],evidence};
  const output=path.resolve('docs/reports/evidence/threaded-rc05/storage.json');await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({...result,evidence:undefined,output},null,2));
}finally{for(const f of fixtures)await f.close();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
