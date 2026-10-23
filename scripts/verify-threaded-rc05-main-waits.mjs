/** Actual index PIDs, disposable production settings, controlled timer clock, injected model only. */
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'agent-gand-rc05-index-waits-')));
const loader=new URL('../apps/server/node_modules/tsx/dist/loader.mjs',import.meta.url).pathname;
const preload=new URL('./fixtures/threadedRc05MainGuard.mjs',import.meta.url).pathname;
const entry=new URL('../apps/server/src/index.ts',import.meta.url).pathname;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const output=path.resolve(process.env.THREADED_RC05_MAIN_WAITS_OUTPUT??'docs/reports/evidence/threaded-rc05/main-waits.json');
const timestamp=new Date().toISOString(),apiKey='RC05_MAIN_WAITS_SYNTHETIC';
const account={id:'rc05-waits-account',display_name:'RC05 waits injected',provider:'anthropic',auth_type:'api_key',
  source:'managed',enabled:1,archived:0,version:1,config_version:1,credential_version:1,identity_generation:null,created_at:timestamp,updated_at:timestamp};
const version={account_id:account.id,version:1,connection:JSON.stringify({baseUrl:'https://rc05.invalid',
  protocols:['anthropic-messages'],defaultModel:'fixture-model',timeoutMs:120000}),created_at:timestamp};
const members=[{agentId:'rc05-waiter',backend:'api',backendVersion:'threaded-http-v1',model:'fixture-model',
  roleVersion:1,permissionVersion:1,accountId:account.id,accountConfigVersion:1,accountCredentialVersion:1,accountIdentityGeneration:null}];
const applicationTools=['hold_ball'];
const children=[],processes=[],cases=[],checks=[],failures=[],keys=new Map();
let latest;
async function port(){const server=net.createServer();await new Promise((y,n)=>{server.once('error',n);server.listen(0,'127.0.0.1',y);});
  const value=server.address().port;await new Promise(y=>server.close(y));return value;}
async function start(name,controlledNow,restore=false){
  const dir=path.join(root,name);await mkdir(path.join(dir,'agents'),{recursive:true});
  const pack=path.join(dir,'release.json');
  if(!restore){await writeFile(pack,JSON.stringify({schemaVersion:1,platform:'darwin',members,applicationTools,
    maxOutputTokens:256,maxInputTokens:32768,maxRequests:2}),{mode:0o600});keys.set(name,randomBytes(32).toString('hex'));}
  const selectedPort=await port(),origin=`http://127.0.0.1:${selectedPort}`;
  const child=fork(entry,[],{cwd:dir,execArgv:['--import',loader,'--import',preload],stdio:['ignore','pipe','pipe','ipc'],
    env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'test',AGENT_GAND_ISOLATED_WORKER:'1',RC05_MAIN_ROOT:dir,
      DB_PATH:path.join(dir,'main.sqlite'),AGENTS_DIR:path.join(dir,'agents'),AGENT_GAND_PRIVATE_DIR:path.join(dir,'private'),
      HOST:'127.0.0.1',PORT:String(selectedPort),LOG_LEVEL:'silent',ACCOUNT_TRUSTED_ORIGINS:origin,
      THREADED_COLLABORATION_MODE:'execute',THREADED_RELEASE_MEMBERS_FILE:pack}});
  children.push(child);processes.push({name,restore,pid:child.pid,host:hostname(),controlledNow,entry:'apps/server/src/index.ts'});
  const pending=new Map(),events=[],waiters=[];let seq=0,auth,log='';
  child.stdout.on('data',d=>{log=(log+d).slice(-4000);});child.stderr.on('data',d=>{log=(log+d).slice(-4000);});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{
    for(const p of pending.values())p.reject(new Error(`RC05_WAIT_INDEX_EXIT_${code}_${signal}`));pending.clear();resolve({code,signal});});});
  child.on('message',m=>{if(m.event){const w=waiters.find(w=>w.kind===m.event);if(w){waiters.splice(waiters.indexOf(w),1);w.resolve(m);}else events.push(m);return;}
    const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.result);}});
  child.send({operation:'initialize',root:dir,account,version,members,apiKey,ephemeralMasterKey:keys.get(name),restore,
    real:false,controlledNow,applicationTools});
  const request=async(url,payload,method='POST',headers=auth)=>{const response=await fetch(origin+url,{method,
    headers:{origin,...(payload===undefined?{}:{'content-type':'application/json'}),...headers},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(15000)});
    return{statusCode:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  let ready=false;const end=Date.now()+30000;
  while(Date.now()<end&&child.exitCode===null&&!child.signalCode){try{ready=(await request('/api/health',undefined,'GET')).statusCode===200;if(ready)break;}catch{}await delay(50);}
  assert.equal(ready,true,log.replaceAll(apiKey,'[REDACTED]'));
  const call=(operation,extra={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RC05_WAIT_TIMEOUT_${operation}`));},15000);
    pending.set(id,{resolve(v){clearTimeout(timer);resolve(v);},reject(e){clearTimeout(timer);reject(e);}});child.send({id,operation,...extra});});
  return{child,request,call,name,
    async login(){const a=await request('/api/accounts/session',undefined,'POST',{'x-gand-bootstrap':'1'});assert.equal(a.statusCode,200,JSON.stringify(a));
      const b=await request('/api/accounts/threaded/access-session',undefined,'POST',{cookie:a.cookie,'x-gand-csrf':a.body.csrfToken});assert.equal(b.statusCode,200,JSON.stringify(b));
      auth={cookie:b.cookie,'x-gand-csrf':b.body.csrfToken};},
    event(kind){const saved=events.find(v=>v.event===kind);if(saved){events.splice(events.indexOf(saved),1);return Promise.resolve(saved);}
      return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`RC05_WAIT_EVENT_TIMEOUT_${kind}`)),15000);
        waiters.push({kind,resolve(v){clearTimeout(timer);resolve(v);}});});},
    async kill(){child.kill('SIGKILL');const result=await exited;assert.equal(result.signal,'SIGKILL');return{pid:child.pid,...result};},
    async close(){child.kill('SIGTERM');const result=await Promise.race([exited,delay(20000).then(()=>{throw new Error('RC05_WAIT_SHUTDOWN_TIMEOUT');})]);
      assert.equal(result.code,0);return result;}};
}
async function controls(w,admissionOpen,dispatchOpen){const a=await w.request('/api/threaded/release',undefined,'GET');assert.equal(a.statusCode,200);
  const b=await w.request('/api/threaded/release/controls',{expectedVersion:a.body.control.version,requestId:randomUUID(),
    admissionOpen,dispatchOpen,reason:'RC05 controlled-clock index timer acceptance'});assert.equal(b.statusCode,200,JSON.stringify(b));}
async function facts(w){const value=await w.call('waitFacts');assert.equal(value.actualIndexEntry,true);assert.equal(value.isolatedExecutionBypass,false);
  assert.equal(value.deniedEgress,0);assert.deepEqual(value.foreignKeys,[]);latest=value;return value;}
const durable=f=>Object.fromEntries(Object.entries(f).filter(([key])=>!['pid','calls','now'].includes(key)));
function invariant(before,after){for(const key of ['admissions','backendRequests','budgetRequests','budgetRoots','invocations','terminals'])assert.deepEqual(after[key],before[key],key);
  const a=before.waits[0],b=after.waits[0];for(const key of ['id','root_id','binding_id','parent_invocation_id','created_at','deadline','record'])assert.deepEqual(b[key],a[key],key);
  assert.equal(after.calls,0,'No model request may occur in a restored index PID');}
async function register(name,clock){
  const w=await start(name,clock);await w.login();await controls(w,true,false);
  const t=await w.request('/api/threaded/threads',{title:`RC05 timer ${name}`,clientRequestId:randomUUID()});assert.equal(t.statusCode,200,JSON.stringify(t));
  const threadId=t.body.thread?.id??t.body.id;
  const receipt=await w.request(`/api/threaded/threads/${threadId}/messages`,{clientRequestId:randomUUID(),
    body:'Reply exactly RC05_TIMER_REGISTERED.',targets:['rc05-waiter']});assert.equal(receipt.statusCode,200,JSON.stringify(receipt));
  const source=(receipt.body.receipt??receipt.body).message;
  await w.call('budget',{messageId:source.id,activityAllowanceMs:10000});
  await w.call('arm',{plan:{boundary:'wait-register'}});
  const dispatch=controls(w,true,true);const ready=await w.event('wait-register-ready');await dispatch;
  const registration=await w.call('registerTimer',{attemptId:ready.attemptId});assert.equal(registration.ok,true,JSON.stringify(registration));
  await controls(w,true,false);await w.call('finishWaitResponse');
  const end=Date.now()+15000;let f;
  while(Date.now()<end){f=await facts(w);if(f.terminals.length===1)break;await delay(30);}
  assert.equal(f.terminals.length,1);assert.equal(f.waits.length,1);assert.equal(f.waits[0].state,'awaiting');assert.equal(f.callbacks.length,0);
  assert.equal(f.calls,1);assert.equal(f.backendRequests.length,1);assert.equal(f.admissions.length,1);assert.equal(f.budgetRoots.length,1);
  assert.equal(f.waits[0].root_id,source.id);assert.equal(f.waits[0].deadline,clock+5000);
  return{w,before:f,registration,sourceId:source.id,hook:ready};
}
try{
  const scenarios=[['before-fireAt',4999,'online'],['equal-fireAt',5000,'recovered'],['after-fireAt',5001,'recovered'],
    ['before-SLA',9999,'recovered'],['equal-SLA',10000,'expired-equality'],['after-SLA',10001,'expired']];
  for(const [name,delta,expected] of scenarios){
    const clock=Date.now(),initial=await register(name,clock),firstStop=await initial.w.kill();
    const restored=await start(name,clock+delta,true);await restored.call('recover');await restored.call('recover');
    const atStartup=await facts(restored);
    if(expected==='online'){
      assert.equal(atStartup.waits[0].state,'awaiting');assert.equal(atStartup.callbacks.length,0);
      await restored.call('clock',{now:clock+15000});await restored.call('recover');await restored.call('recover');
    }
    const after=await facts(restored);invariant(initial.before,after);
    const wait=after.waits[0],outcome=JSON.parse(wait.outcome);
    if(expected.startsWith('expired')){
      assert.equal(wait.state,'withdrawn');assert.equal(outcome.disposition,'retired_expired');
      assert.equal(outcome.classification,expected==='expired-equality'?'recover':'expired');assert.equal(after.callbacks.length,0);
      assert.deepEqual(after.messages,initial.before.messages);assert.deepEqual(after.wakes,initial.before.wakes);
    }else{
      assert.equal(wait.state,'settled');assert.equal(outcome.recoveredMissedTimer,expected==='online'?undefined:true);
      assert.equal(outcome.businessConditionVerified,false);assert.equal(after.callbacks.length,1);
      assert.equal(after.callbacks[0].state,'delivered');assert.equal(after.callbacks[0].source_id,wait.id);
      assert.equal(after.messages.length,initial.before.messages.length+1);assert.equal(after.wakes.length,initial.before.wakes.length+1);
      assert.equal(after.messages.at(-1).causal_root_id,initial.sourceId);
    }
    for(let n=0;n<3;n++)await restored.call('recover');assert.deepEqual(durable(await facts(restored)),durable(after));
    const secondStop=await restored.kill(),again=await start(name,after.now,true);await again.call('recover');await again.call('recover');
    const secondRecovery=await facts(again);assert.deepEqual(durable(secondRecovery),durable(after));assert.equal(secondRecovery.calls,0);
    assert.notEqual(firstStop.pid,after.pid);assert.notEqual(secondStop.pid,secondRecovery.pid);await again.close();
    checks.push({id:name,passed:true,startupOffsetFromFireAtMs:delta-5000,startupOffsetFromSlaMs:delta-10000,expected});
    cases.push({name,originalToolHook:initial.hook,registration:initial.registration,before:initial.before,firstStop,
      atStartup,after,secondStop,secondRecovery});
  }
}catch(error){failures.push({reason:error.code??error.message,facts:latest});process.exitCode=1;}
finally{
  for(const child of children)if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
  const report={ok:failures.length===0,stage:'RC05 actual index timer recovery',at:new Date().toISOString(),groups:checks.length,checks,failures,
    actualMainIndex:true,actualIndexPids:processes.length,processes,cases,realSupplierRequests:0,realSupplierTokens:0,remoteWrites:0,
    actualSigkillRestarts:cases.length*2,productionDefaultActivityAllowanceMs:1000,selectedSyntheticRootActivityAllowanceMs:10000,
    scope:{composition:'actual apps/server/src/index.ts with production singleton, release pack, HTTP ingress, account and authority policy',
      registration:'trusted in-flight test hook invokes real tools.execute(hold_ball) on a current active production binding; not a natural model tool choice',
      clock:'Date.now controlled before service construction and advanced only by trusted test IPC; real index PIDs terminate and reopen the same SQLite file',
      transport:'local deterministic model response only; global fetch guard prevents unregistered external effects',
      dailyDatabase:'never opened',credentials:'fresh synthetic credential only',
      startup:'fixture-only isolated execution bypass is cleared before production singleton import',
      boundaries:'actual stop/restart at fireAt−1/equality/+1 and SLA−1/equality/+1; equality classifier recover but no dispatch retry window',
      limitations:['Controlled clock boundaries are deterministic; this is not wall-clock scheduler punctuality or real provider behavior.',
        'Source ownerAuth, member identity, malformed baseline and Action generation drift are separately covered in waits.json.']}};
  let encoded=JSON.stringify(report,null,2);assert.ok(!encoded.includes(apiKey));for(const key of keys.values())assert.ok(!encoded.includes(key));
  await mkdir(path.dirname(output),{recursive:true});await writeFile(output,encoded+'\n');await rm(root,{recursive:true,force:true});
  console.log(JSON.stringify({ok:report.ok,groups:checks.length,actualIndexPids:processes.length,actualSigkillRestarts:report.actualSigkillRestarts,failures:failures.length,evidence:output}));
}
