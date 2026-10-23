/** Fixed injected facts exercise actual child-process restart and credential
 * boundaries. This is not proof of a naturally occurring GitHub HEAD change. */
import assert from 'node:assert/strict';
import {mkdtemp,realpath,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openRc04Process} from './fixtures/threadedRc04Process.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc04-process-')));
const output=path.resolve(process.env.THREADED_RC04_PROCESS_OUTPUT??'docs/reports/evidence/threaded-rc04/process.json');
const token='rc04-parent-only-injected-token',repository='fixture/rc04',number=4,principalLogin='rc04-review-principal';
const previousToken=process.env.THREADED_GITHUB_TOKEN_RC04,previousFetch=globalThis.fetch;
let forbiddenNetwork=0,providerReads=0,credentialReads=0,currentHead='a'.repeat(40),harness;
const checks=[];
process.env.THREADED_GITHUB_TOKEN_RC04=token;
globalThis.fetch=async()=>{forbiddenNetwork++;throw new Error('RC04 real network forbidden');};
async function verifyNoSecret(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);
    if(entry.isDirectory())await verifyNoSecret(file);
    else if(entry.isFile())assert.equal((await readFile(file)).includes(Buffer.from(token)),false,`No credential bytes in disposable ${entry.name}`);
  }
}
try{
  harness=await openRc04Process(root,{name:'process-chain',repository,number,principalLogin,
    readToken:name=>{assert.equal(name,'THREADED_GITHUB_TOKEN_RC04');credentialReads++;return token;},
    githubFetch:async(input,init)=>{
      assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
      assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${token}`);providerReads++;
      const endpoint=new URL(input);assert.equal(endpoint.origin,'https://api.github.com');
      assert.ok(['/user',`/repos/${repository}/pulls/${number}`].includes(endpoint.pathname));
      const value=endpoint.pathname==='/user'?{id:404,login:principalLogin}:{number,base:{repo:{full_name:repository}},head:{sha:currentHead},
        user:{login:'independent-pr-author'},updated_at:'2026-10-22T00:00:00Z',state:'open',merged:false,merge_commit_sha:null};
      return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    }});
  let state=await harness.initialize();assert.equal(state.stage,'await_first_head');assert.equal((await harness.poll()).observed,false);
  const initialReads=providerReads,baseline=await harness.rebuild();assert.equal(providerReads,initialReads);
  assert.equal(baseline.chain.waits[0].waitId,state.chain.waits[0].waitId);assert.equal(baseline.counts.trackingCallbacks,0);
  checks.push('RCP01: a real child PID is SIGKILLed after baseline persistence; close is observed before a different PID restores the same Thread, causal root, canonical Action and awaiting Wait with zero GET/model replay');

  currentHead='b'.repeat(40);const first=await harness.poll();assert.equal(first.observed,true);
  const firstReads=providerReads,observed=await harness.rebuild();assert.equal(providerReads,firstReads);
  assert.equal(observed.chain.waits[0].observed.callbackId,first.callbackId);assert.equal(observed.counts.trackingCallbacks,1);
  assert.equal((await harness.poll()).callbackId,first.callbackId);
  checks.push('RCP02: SIGKILL after the first delivered tracking callback preserves its event/callback/message IDs; restored repeated polling cannot create another callback or a new causal root');

  state=await harness.advanceObserved();assert.equal(state.stage,'await_second_head');
  currentHead='c'.repeat(40);assert.equal((await harness.poll()).observed,true);state=await harness.advanceObserved();assert.equal(state.stage,'passed');
  const finalReads=providerReads,final=await harness.rebuild();assert.equal(providerReads,finalReads);
  assert.equal(final.counts.trackingCallbacks,2);assert.equal(final.counts.reviewReports,3);assert.equal(final.counts.revisionClaims,2);
  assert.equal(final.canonicalActionCount,1);assert.equal(final.foreignKeyViolations,0);
  assert.equal(final.processEvidence.restarts.length,3);assert.equal(final.processEvidence.pids.length,4);
  assert.ok(final.processEvidence.restarts.every(row=>row.signal==='SIGKILL'&&row.closeObserved&&row.providerGetsDuringRestore===0&&row.scriptedCallsDuringRestore===0));
  assert.equal((await harness.poll()).alreadyPassed,true);
  checks.push('RCP03: the complete injected three-HEAD review/revision chain survives three actual process replacements and remains one Action, two wakes, three reports and two revision claims; approved final state restores without blind replay');

  assert.equal(final.processEvidence.workerForbiddenNetworkCalls,0);assert.equal(final.processEvidence.rejectedProviderRequests,0);
  assert.ok(final.processEvidence.pids.every(row=>row.argvCount===2&&row.environmentKeys.every(key=>['LOG_LEVEL','NODE_ENV','PATH','__CF_USER_TEXT_ENCODING'].includes(key))
    &&['LOG_LEVEL','NODE_ENV','PATH'].every(key=>row.environmentKeys.includes(key))));
  assert.equal(final.processEvidence.parentProviderGets,providerReads);assert.equal(credentialReads,providerReads);assert.equal(forbiddenNetwork,0);
  assert.equal(JSON.stringify(final).includes(token),false);await verifyNoSecret(root);
  checks.push('RCP04: an intentionally present parent token environment variable never enters any child boot environment or argv, IPC result, SQLite/WAL, metadata or evidence; every authorized GET is parent-owned, no child direct network, real model or external write occurs');
  const result={ok:true,status:'passed_isolated_process_restart',checkedAt:new Date().toISOString(),checks:checks.length,coverage:checks,
    scope:'Injected provider HEADs and local scripted model protocol with actual separate production-composition PIDs and SQLite; not apps/server index.ts, arbitrary mid-commit crash or naturally occurring GitHub event acceptance',
    injectedProviderReads:providerReads,parentMemoryCredentialChecks:credentialReads,realProviderReads:0,realModelCalls:0,realModelTokens:0,
    realExternalWrites:0,forbiddenNetworkRequests:forbiddenNetwork,dailyProductionOpened:false,fullChain:final};
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ok:true,status:result.status,checks:checks.length,actualChildProcesses:final.processEvidence.pids.length,
    sigkillRestarts:final.processEvidence.restarts.length,injectedProviderReads:providerReads,realProviderReads:0,realModelCalls:0,output},null,2));
}finally{
  try{await harness?.close();}finally{globalThis.fetch=previousFetch;if(previousToken===undefined)delete process.env.THREADED_GITHUB_TOKEN_RC04;
    else process.env.THREADED_GITHUB_TOKEN_RC04=previousToken;await rm(root,{recursive:true,force:true});}
}
