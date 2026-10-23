/** Deterministic RC04 protocol acceptance. Every GitHub fact and model reply is injected; this file cannot establish a real new-HEAD observation. */
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openRc04Harness} from './fixtures/threadedRc04Harness.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc04-isolated-'))),output=path.resolve(process.env.THREADED_RC04_OUTPUT??'docs/reports/evidence/threaded-rc04-isolated.json');
const originalFetch=globalThis.fetch;let forbiddenNetwork=0,providerReads=0,credentials=0;
globalThis.fetch=async()=>{forbiddenNetwork++;throw new Error('Real network forbidden in RC04 isolated acceptance');};
delete process.env.AGENT_GAND_ISOLATED_WORKER;
const token='rc04-fixture-only-not-a-real-token',repository='fixture/rc04',number=4,principalLogin='rc04-review-principal',checks=[],fixtures=[];
const sha=value=>value.repeat(40);
async function fixture(name){let currentHead=sha('a'),unavailable=false;
  const options={name,repository,number,principalLogin,readToken:()=>{credentials++;return token;},githubFetch:async(input,init)=>{
    providerReads++;assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.equal(init.headers.Authorization,`Bearer ${token}`);
    const url=new URL(input);assert.equal(url.origin,'https://api.github.com');assert.ok(['/user',`/repos/${repository}/pulls/${number}`].includes(url.pathname));
    return new Response(JSON.stringify(url.pathname==='/user'?{id:404,login:principalLogin}:unavailable?{}:{number,base:{repo:{full_name:repository}},head:{sha:currentHead},user:{login:'independent-pr-author'},
      state:'open',merged:false,merge_commit_sha:null,updated_at:'2026-10-22T00:00:00Z'}),{status:unavailable?503:200,headers:{'content-type':'application/json'}});}};
  let harness=await openRc04Harness(root,options);
  const f={options,get h(){return harness;},head:head=>{currentHead=head;},unavailable:v=>{unavailable=v;},
    async restore(){await harness.close();harness=await openRc04Harness(root,{...options,restore:true});},close:()=>harness.close()};fixtures.push(f);return f;
}
const sameIdentities=(a,b)=>assert.deepEqual(b.durableIdentity,a.durableIdentity);
try{
  const f=await fixture('full-chain');let state=await f.h.initialize();
  assert.equal(state.stage,'await_first_head');assert.equal(state.canonicalActionCount,1);assert.equal(state.counts.reviewReports,1);assert.equal(state.counts.trackingCallbacks,0);
  assert.equal(state.chain.gates[0].status,'approved');assert.equal(state.chain.waits[0].baselineHead,sha('a'));assert.equal(state.chain.waits[0].rootId,state.rootId);
  for(let i=0;i<3;i++)assert.equal((await f.h.poll()).observed,false);
  checks.push('RC04-01: actual production composition without isolated-worker authority bypass establishes one canonical Action, an old-HEAD local approved gate and an exact no-wake tracking baseline; unchanged injected HEAD cannot satisfy live-event acceptance');

  const before=state=f.h.snapshot(),reads=providerReads;await f.h.rebuild();sameIdentities(before,f.h.snapshot());assert.equal(providerReads,reads);
  checks.push('RC04-02: actual SQLite close/reopen and production factory rebuild preserve the original root, canonical Action, review evidence, baseline and callback IDs with zero provider GET or scripted model replay');

  f.head(sha('b'));const first=await f.h.poll();assert.equal(first.observed,true);assert.equal(first.newHead,sha('b'));assert.equal(first.baselineHead,sha('a'));
  assert.deepEqual((await f.h.poll()).messageId,first.messageId);const firstSnapshot=f.h.snapshot();assert.equal(firstSnapshot.counts.trackingCallbacks,1);
  await f.restore();sameIdentities(firstSnapshot,f.h.snapshot());assert.equal((await f.h.poll()).messageId,first.messageId);
  checks.push('RC04-03: one injected new HEAD produces exactly one ordinary tracking wake; repeated refresh and a restored saved stage reuse the same event, callback and message without duplicate delivery');

  state=await f.h.advanceObserved();assert.equal(state.stage,'await_second_head');assert.equal(state.canonicalActionCount,1);assert.equal(state.chain.revisions[0].generation,2);
  assert.deepEqual(state.chain.revisions[0].responses,[]);assert.equal(state.chain.gates.find(g=>g.label==='old-approved-invalidated').status,'stale');
  assert.equal(state.chain.reports[1].verdict,'changes_requested');assert.equal(state.chain.reports[1].findingIds.length,2);
  assert.equal(state.chain.reports[1].responsibilityCompleted,true);assert.equal(state.chain.gates.find(g=>g.label==='delivery-complete-is-not-approval').status,'blocked');
  assert.equal(state.chain.waits[1].baselineHead,sha('b'));assert.ok(state.chain.waits.every(w=>w.rootId===state.rootId));
  checks.push('RC04-04: the original author consumes the first ordinary wake under the original causal root, invalidates old approved HEAD, starts generation 2, receives a different reviewer changes request with two findings, completes delivery without approval and registers a second exact-HEAD baseline');

  assert.equal((await f.h.poll()).observed,false);const partial=f.h.snapshot();await f.h.rebuild();sameIdentities(partial,f.h.snapshot());
  assert.equal(f.h.snapshot().stage,'await_second_head');assert.equal(f.h.snapshot().counts.trackingCallbacks,1);
  checks.push('RC04-05: only the first natural-event stage would be partially_observed; an unchanged second baseline, repeated recover and rebuild cannot approve author attestations or manufacture a second wake');

  f.head(sha('c'));const second=await f.h.poll();assert.equal(second.observed,true);assert.equal(second.newHead,sha('c'));assert.notEqual(second.callbackId,first.callbackId);
  assert.equal((await f.h.poll()).callbackId,second.callbackId);state=await f.h.advanceObserved();assert.equal(state.stage,'passed');assert.equal(state.canonicalActionCount,1);
  assert.equal(state.counts.trackingCallbacks,2);assert.equal(state.counts.reviewReports,3);assert.equal(state.counts.revisionClaims,2);assert.equal(state.foreignKeyViolations,0);
  assert.equal(state.chain.revisions[1].generation,3);assert.deepEqual(state.chain.revisions[1].responses.map(r=>r.findingId),state.chain.reports[1].findingIds);
  assert.equal(state.chain.gates.find(g=>g.label==='author-attestation-is-not-verification').status,'blocked');assert.equal(state.chain.gates.at(-1).status,'approved');
  assert.equal(state.chain.reports[2].reviewerAgentId,state.chain.reports[0].reviewerAgentId);assert.notEqual(state.chain.reports[2].reviewerAgentId,state.chain.reports[2].authorAgentId);
  assert.equal(new Set(state.chain.acceptedSources.map(s=>s.messageId)).size,3);assert.ok(state.chain.acceptedSources.every((s,i,all)=>i===0||s.revision>all[i-1].revision));
  checks.push('RC04-06: the second new HEAD yields one second wake; exact responses attest every stable finding ID under the same root, independent current-HEAD review verifies all findings, typed responsibility completion and a live local gate establish approval only for generation 3 and the new accepted source');

  const passed=f.h.snapshot(),passedReads=providerReads;await f.restore();sameIdentities(passed,f.h.snapshot());assert.equal(providerReads,passedReads);assert.equal(f.h.snapshot().scriptedCalls,passed.scriptedCalls);
  assert.equal((await f.h.poll()).alreadyPassed,true);assert.equal(f.h.snapshot().chain.rebuilds.at(-1).scriptedCalls,0);assert.equal(f.h.snapshot().chain.rebuilds.at(-1).providerReads,0);
  assert.ok(!JSON.stringify(f.h.snapshot()).includes(token));assert.ok(!(await readFile(path.join(root,'full-chain','rc04-state.json'),'utf8')).includes(token));
  checks.push('RC04-07: the passed saved stage restores the original SQLite workflow without model/provider replay or duplicate review/revision, and persisted/public evidence excludes the injected credential bytes');

  const moving=await fixture('head-moved');await moving.h.initialize();moving.head(sha('b'));await moving.h.poll();moving.head(sha('c'));
  await assert.rejects(()=>moving.h.advanceObserved(),error=>error.code==='RC04_HEAD_MOVED_DURING_REVISION');assert.equal(moving.h.snapshot().stage,'failed');
  assert.equal(moving.h.snapshot().failure.code,'RC04_HEAD_MOVED_DURING_REVISION');assert.notEqual(moving.h.snapshot().stage,'passed');
  checks.push('RC04-08: a newer provider HEAD arriving after a tracking wake but before revision is explicitly head_moved/failed; a fresh fact cannot be substituted to claim the observed-event chain passed');

  const unavailable=await fixture('unavailable');await unavailable.h.initialize();unavailable.head(sha('b'));await unavailable.h.poll();unavailable.unavailable(true);
  await assert.rejects(()=>unavailable.h.advanceObserved());assert.equal(unavailable.h.snapshot().stage,'failed');assert.equal(unavailable.h.snapshot().chain.revisions.length,0);
  checks.push('RC04-09: provider unavailability after the first observed event prevents revision/gate success; real GET failures cannot be treated as independent review approval');

  assert.equal(forbiddenNetwork,0);assert.notEqual(process.env.AGENT_GAND_ISOLATED_WORKER,'1');
  const result={ok:true,status:'passed_isolated_protocol_only',checkedAt:new Date().toISOString(),checks:checks.length,coverage:checks,
    evidenceLayer:'All provider HEAD facts and model responses are injected; actual production composition/authority, temporary SQLite and independent local-review protocol are exercised. This is not real engineering review, real GitHub new-event acceptance or production activation.',
    injectedProviderReads:providerReads,inMemoryFixtureCredentialChecks:credentials,realProviderReads:0,forbiddenNetworkRequests:forbiddenNetwork,realModelCalls:0,realModelTokens:0,realExternalWrites:0,productionOpened:false,
    fullChain:f.h.snapshot(),headMoved:moving.h.snapshot().failure,unavailable:unavailable.h.snapshot().failure};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:true,checks:checks.length,status:result.status,injectedProviderReads:providerReads,realProviderReads:0,realModelCalls:0,output},null,2));
}finally{await Promise.allSettled(fixtures.map(f=>f.close()));globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
